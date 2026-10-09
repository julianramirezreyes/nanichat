import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AccountRef, MessageReadback, PublicReplyResult, SendResult, SocialProvider } from '../core/domain.ts';
import {
  claimsMediaSql, classifyComment, hasEnabledMediaAutomation, hasOwnerReply, isPastPrivateReplyWindow, matchAutomation, renderFollowGatePayload,
  renderReply, storedFollowGateConfig,
} from './automations.ts';
import { storedResourceAttachment } from './resource-attachment.ts';
import { FOLLOW_GATE_RETIRED_CODE, GATE_FIRST_POLL_MS, followGateAvailable, safeIgsid } from './follow-gate-rules.ts';
import {
  PUBLIC_REPLY_MAX_ATTEMPTS, PUBLIC_REPLY_RECENT_WINDOW, PUBLIC_REPLY_SPACING_MS, PUBLIC_REPLY_WINDOW_MS,
  renderPublicReply, selectPublicReplyVariant, storedPublicReplyVariants,
} from './public-reply.ts';

const EXPIRED_REASON = 'private_reply_window_elapsed';
const YIELDED_REASON = 'yielded_to_media_automation';
const EXPIRE_SWEEP_LIMIT = 500;

type QueueProvider = Pick<SocialProvider, 'getComment' | 'sendPrivateReply' | 'readMessage'> & Partial<Pick<SocialProvider, 'replyToComment'>>;
const PUBLIC_SWEEP_LIMIT = 500;
const PUBLIC_RETRY_MAX_DELAY_MS = 15 * 60 * 1000;
const PUBLIC_RETRY_BASE_DELAY_MS = 30_000;

type PublicRow = {
  queue_item_id: string; account_id: string; comment_id: string; automation_id: string; state: string;
  public_reply_text: string | null; public_reply_attempts: number;
  connection_id: string; provider_account_id: string; username: string;
};
type PublicEvent = 'intent_recorded' | 'accepted' | 'definitive_rejection' | 'ambiguous' | 'skipped' | 'expired' | 'manual_retry';
export type LegacyQueueInterlock = {
  /** holdConfigured: the account is a configured legacy hold, so even an absent counter needs an acknowledgement. */
  inspect(username: string): { counterVersion: string; lockPresent: boolean; holdConfigured?: boolean };
  withExclusiveLock<T>(username: string, operation: () => Promise<T>): Promise<T>;
};

type QueueRow = {
  queue_item_id: string;
  account_id: string;
  comment_id: string;
  automation_id: string;
  state: string;
  dry_run: number;
  payload_json: string;
  media_id: string;
  username: string;
  provider_account_id: string;
  connection_id: string;
  automation_status: string;
  automation_scope: 'media' | 'account';
  automation_media_id: string | null;
  real_enabled: number;
  match_mode: 'exact' | 'contains';
  reply_text: string;
  automation_version: number;
  buttons_json: string;
  connection_status: string;
  connection_paused: number;
  account_status: string;
  send_held: number;
  attempt_count: number;
};

const READBACK_MIN_INTERVAL_MS = 30_000;

type SentPayload = { text?: string; buttons?: Array<{ title: string; url: string }> };

export class QueueReadbackError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Safe, typed rejection of an explicit queue action (HTTP status + machine code). */
export class QueueActionError extends QueueReadbackError {}

export class QueueService {
  private readonly processing = new Set<string>();
  private readonly publicProcessing = new Set<string>();
  private readonly lastReadbackAt = new Map<string, number>();

  constructor(
    private readonly database: DatabaseSync,
    private readonly provider: QueueProvider,
    private readonly options: {
      sendSpacingMs?: number;
      clock?: () => number;
      legacyInterlock?: LegacyQueueInterlock;
      /** Minimum spacing between public reply intents (default PUBLIC_REPLY_SPACING_MS), separate from private spacing. */
      publicReplySpacingMs?: number;
      /** Randomness for variant rotation, in [0, 1); injectable for deterministic tests. */
      rng?: () => number;
      /** TEST-ONLY override of FOLLOW_GATE_AVAILABLE (the retired follow gate); production never passes it. */
      followGateAvailable?: boolean;
    } = {},
  ) {}

  async enqueueReviewed(accountId: string, automationId: string, reviewedCommentIds: string[]): Promise<string[]> {
    if (!reviewedCommentIds.length) return [];
    const automation = this.database.prepare(`SELECT media_id, scope, status, real_enabled, match_mode, reply_text, buttons_json, version,
      public_reply_enabled, public_reply_variants_json,
      follow_gate_enabled, follow_gate_message, follow_gate_button_title, resource_attachment_kind, resource_attachment_url
      FROM automations WHERE account_id = ? AND automation_id = ?`).get(accountId, automationId) as {
      media_id: string | null; scope: 'media' | 'account'; status: string; real_enabled: number; match_mode: 'exact' | 'contains';
      reply_text: string; buttons_json: string; version: number; public_reply_enabled: number; public_reply_variants_json: string;
      follow_gate_enabled: number; follow_gate_message: string; follow_gate_button_title: string;
      resource_attachment_kind: string; resource_attachment_url: string;
    } | undefined;
    if (!automation) throw new Error('Automation does not belong to this account');
    if (automation.status !== 'enabled') throw new Error('Automation is not enabled');

    const dryRun = this.readDryRun();
    const simulated = dryRun || !automation.real_enabled;
    const state = simulated ? 'SIMULATED' : 'QUEUED';
    const insert = this.database.prepare(`INSERT OR IGNORE INTO queue_items
      (queue_item_id, account_id, comment_id, automation_id, state, dry_run, payload_json, created_at, updated_at,
       public_reply_text, public_reply_variant, public_reply_selected_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // A media-scoped automation only accepts comments of its own media; a general one any media of the same account.
    const selectComment = this.database.prepare(`SELECT comment_id, media_id, text, username, created_at, parent_id
      FROM comments WHERE account_id = ? AND comment_id = ?`);
    const keywords = this.database.prepare(`SELECT phrase FROM automation_keywords
      WHERE account_id = ? AND automation_id = ? ORDER BY rowid`)
      .all(accountId, automationId) as Array<{ phrase: string }>;
    // Only automations that currently claim the comment's media can make it ambiguous: stale rows of archived,
    // paused or deleted automations, and of a general automation that yields to a media-specific one, never count.
    const eligibleMatches = this.database.prepare(`SELECT c.automation_id FROM comment_classifications c
      JOIN automations a ON a.account_id = c.account_id AND a.automation_id = c.automation_id
      WHERE c.account_id = ? AND c.comment_id = ? AND c.result = 'eligible' AND ${claimsMediaSql('a', '?')}`);

    const inserted: string[] = [];
    for (const commentId of [...new Set(reviewedCommentIds)]) {
      const comment = selectComment.get(accountId, commentId) as {
        comment_id: string; media_id: string; text: string | null; username: string | null; created_at: string | null; parent_id: string | null;
      } | undefined;
      if (!comment || (automation.scope === 'media' && comment.media_id !== automation.media_id)) {
        throw new Error('Reviewed comment does not belong to this account and automation media');
      }
      if (automation.scope === 'account' && hasEnabledMediaAutomation(this.database, accountId, comment.media_id)) {
        throw new Error('General automation yields to the media-specific automation of this publication');
      }
      const account = this.database.prepare(`SELECT username FROM social_accounts WHERE account_id = ?`).get(accountId) as { username: string } | undefined;
      if (!account) throw new Error('Account does not exist');
      const mediaRow = this.database.prepare(`SELECT permalink FROM media WHERE account_id = ? AND media_id = ?`)
        .get(accountId, comment.media_id) as { permalink: string | null } | undefined;
      // {{media}} is the permalink of the comment's publication (or its media ID), bounded to 100 characters.
      const mediaLabel = (mediaRow?.permalink || comment.media_id).slice(0, 100);
      const classification = classifyComment({
        commentId, text: comment.text ?? undefined, username: comment.username ?? undefined,
        createdAt: comment.created_at ?? undefined, parentId: comment.parent_id ?? undefined,
      }, keywords.map(({ phrase }) => phrase), account.username, Date.now(), automation.match_mode,
      hasOwnerReply(this.database, accountId, commentId, account.username));
      if (!classification.eligible || classification.matchedKeywords.length === 0) {
        throw new Error('Comment is not safely eligible for a matching keyword');
      }
      const matchingIds = eligibleMatches.all(accountId, commentId, comment.media_id, comment.media_id) as Array<{ automation_id: string }>;
      if (matchingIds.some((match) => match.automation_id !== automationId)) {
        throw new Error('Comment matches multiple automations and requires review');
      }
      const variables = {
        username: comment.username ?? '', comment: comment.text ?? '', keyword: classification.matchedKeywords[0]!,
        account: account.username, media: mediaLabel,
      };
      const urlButtons = JSON.parse(automation.buttons_json) as Array<{ title: string; url: string }>;
      const followGate = storedFollowGateConfig(automation.follow_gate_enabled, automation.follow_gate_message, automation.follow_gate_button_title);
      // Follow gate: the first message is the gate (one postback button); the resource (reply text + URL buttons, plus the
      // optional attachment) is rendered now and frozen in the payload, so later edits never alter it. Without the gate
      // the payload is the historic one. A legacy interactive_mode (retired experiment) is ignored: no dead button is sent.
      // While the follow gate is retired (FOLLOW_GATE_AVAILABLE), a stored gate/attachment is ignored the same way.
      const payload = followGate.enabled && this.followGateAvailable()
        ? renderFollowGatePayload(followGate, variables, { replyText: automation.reply_text, buttons: urlButtons }, automationId,
          storedResourceAttachment(automation.resource_attachment_kind, automation.resource_attachment_url))
        : renderReply(automation.reply_text, variables, urlButtons);
      const now = new Date().toISOString();
      // Simulated items keep the would-be public reply as an inert preview (WOULD_REPLY_PUBLIC); it is never posted.
      const preview = simulated && automation.public_reply_enabled === 1
        ? this.choosePublicReply(accountId, storedPublicReplyVariants(automation.public_reply_variants_json),
          { username: comment.username ?? '', keyword: classification.matchedKeywords[0]! })
        : null;
      const result = insert.run(randomUUID(), accountId, commentId, automationId, state, simulated ? 1 : 0,
        JSON.stringify({ ...payload, automation_version: automation.version }), now, now,
        preview?.text ?? null, preview?.variant ?? null, preview ? new Date(this.clock()).toISOString() : null);
      if (Number(result.changes) > 0) inserted.push(commentId);
    }
    return inserted;
  }

  setDryRun(enabled: boolean, confirmed = false): void {
    if (!enabled && !confirmed) throw new Error('Explicit confirmation is required to disable Dry Run');
    this.database.prepare(`INSERT INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET state_value=excluded.state_value, updated_at=excluded.updated_at`)
      .run(enabled ? 'true' : 'false', new Date().toISOString());
  }

  async processOne(accountId?: string): Promise<string | null> {
    if (this.readDryRun()) return null;
    const now = this.clock();
    const row = this.nextQueued(accountId, undefined, now);
    if (!row) return null;
    if (this.processing.has(row.queue_item_id)) return null;
    this.processing.add(row.queue_item_id);
    try {
      return await this.processClaimed(row, accountId, now);
    } finally {
      this.processing.delete(row.queue_item_id);
    }
  }

  private async processClaimed(row: QueueRow, accountId: string | undefined, now: number): Promise<string | null> {
    const account: AccountRef = {
      accountId: row.account_id,
      connectionId: row.connection_id,
      providerAccountId: row.provider_account_id,
      username: row.username,
    };

    // Retired experiment: a payload frozen with quick replies, or with postback buttons outside the follow gate, would
    // send buttons that do nothing when tapped. Skip it before any provider call, intent or POST.
    if (retiredInteractivePayload(row.payload_json)) {
      this.database.prepare(`UPDATE queue_items SET state='SKIPPED', state_reason_code='interactive_mode_retired', updated_at=?
        WHERE queue_item_id=? AND state IN ('QUEUED','FAILED_RETRYABLE')`)
        .run(new Date().toISOString(), row.queue_item_id);
      return row.queue_item_id;
    }
    // Retired follow gate: a payload frozen with a gate would send a button whose follow-up Meta then rejects (outside
    // the allowed window), so the person would receive nothing. Skip it before any provider call, intent or POST.
    if (!this.followGateAvailable() && frozenFollowGatePayload(row.payload_json)) {
      this.database.prepare(`UPDATE queue_items SET state='SKIPPED', state_reason_code=?, updated_at=?
        WHERE queue_item_id=? AND state IN ('QUEUED','FAILED_RETRYABLE')`)
        .run(FOLLOW_GATE_RETIRED_CODE, new Date().toISOString(), row.queue_item_id);
      return row.queue_item_id;
    }
    let freshComment;
    try {
      freshComment = await this.provider.getComment(account, row.comment_id);
    } catch {
      const expectedState = row.state === 'QUEUED' ? 'QUEUED' : 'FAILED_RETRYABLE';
      this.markState(row, 'FAILED_RETRYABLE', 'retryable_failure', 'comment_refresh_failed', {}, expectedState);
      return row.queue_item_id;
    }

    const current = this.nextQueued(accountId, row.queue_item_id, now);
    // Too-old comments are never sent: expire before any send intent is recorded.
    if (current && current.connection_id === account.connectionId
      && current.provider_account_id === account.providerAccountId
      && freshComment.commentId === row.comment_id
      && isPastPrivateReplyWindow(freshComment.createdAt, this.clock())) {
      this.expireItem(row.queue_item_id, row.account_id, [current.state as 'QUEUED' | 'FAILED_RETRYABLE']);
      return row.queue_item_id;
    }
    // A general automation yields once the publication has its own enabled automation: skip before intent or POST.
    if (current && current.automation_scope === 'account'
      && hasEnabledMediaAutomation(this.database, row.account_id, current.media_id)) {
      this.database.prepare(`UPDATE queue_items SET state='SKIPPED', state_reason_code=?, updated_at=?
        WHERE queue_item_id=? AND state IN ('QUEUED','FAILED_RETRYABLE')`)
        .run(YIELDED_REASON, new Date().toISOString(), row.queue_item_id);
      return row.queue_item_id;
    }
    // The account already answered this root publicly (stored reply): skip before any send intent or POST.
    if (current && current.connection_id === account.connectionId
      && current.provider_account_id === account.providerAccountId
      && freshComment.commentId === row.comment_id
      && hasOwnerReply(this.database, row.account_id, row.comment_id, row.username)) {
      this.database.prepare(`UPDATE queue_items SET state='SKIPPED', state_reason_code='owner_replied', updated_at=?
        WHERE queue_item_id=? AND state IN ('QUEUED','FAILED_RETRYABLE')`)
        .run(new Date().toISOString(), row.queue_item_id);
      return row.queue_item_id;
    }
    if (!current || current.connection_id !== account.connectionId
      || current.provider_account_id !== account.providerAccountId
      || !this.stillAllowed(current, freshComment)) {
      this.database.prepare(`UPDATE queue_items SET state='SKIPPED', updated_at=? WHERE queue_item_id=? AND state IN ('QUEUED','FAILED_RETRYABLE')`)
        .run(new Date().toISOString(), row.queue_item_id);
      return row.queue_item_id;
    }

    let result: SendResult | null;
    if (this.options.legacyInterlock) {
      if (!this.legacyAcknowledged(current)) return null;
      try {
        result = await this.options.legacyInterlock.withExclusiveLock(row.username, async () => {
          if (!this.legacyAcknowledged(current, true)) return null;
          if (!this.recordIntent(current, this.clock())) return null;
          try {
            return await this.provider.sendPrivateReply(account, row.comment_id, JSON.parse(row.payload_json));
          } catch {
            return { outcome: 'ambiguous', safeErrorCode: 'provider_exception' };
          }
        });
      } catch {
        return null;
      }
    } else {
      if (!this.recordIntent(current, this.clock())) return null;
      try {
        result = await this.provider.sendPrivateReply(account, row.comment_id, JSON.parse(row.payload_json));
      } catch {
        result = { outcome: 'ambiguous', safeErrorCode: 'provider_exception' };
      }
    }
    if (!result) return null;
    if (result.outcome === 'ambiguous') {
      this.markState(row, 'UNKNOWN_OUTCOME', 'ambiguous_outcome', result.safeErrorCode ?? 'ambiguous_provider_result',
        { usageHeaders: result.usageHeaders }, 'SENDING');
      return row.queue_item_id;
    }
    if (result.outcome === 'definitive_rejection') {
      const retryable = result.httpStatus === 429;
      this.markState(row, retryable ? 'FAILED_RETRYABLE' : 'FAILED_PERMANENT',
        retryable ? 'retryable_failure' : 'definitive_rejection', result.safeErrorCode ?? 'provider_rejection',
        { usageHeaders: result.usageHeaders, retryAfter: result.usageHeaders?.retryAfter }, 'SENDING');
      return row.queue_item_id;
    }
    if (!result.messageId?.trim()) {
      this.markState(row, 'UNKNOWN_OUTCOME', 'ambiguous_outcome', 'accepted_without_message_id', {}, 'SENDING');
      return row.queue_item_id;
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.database.prepare(`UPDATE queue_items SET state='SENT', payload_json=?, updated_at=?
        WHERE queue_item_id=? AND state='SENDING'`)
        .run(JSON.stringify({ ...JSON.parse(row.payload_json), accepted_message_id: result.messageId }), new Date().toISOString(), row.queue_item_id);
      if (Number(updated.changes) !== 1) {
        this.database.exec('ROLLBACK');
        return row.queue_item_id;
      }
      const recipientId = safeRecipientId(result.recipientId);
      this.appendEvent(row, 'accepted', result.messageId, undefined,
        { httpStatus: result.httpStatus, usageHeaders: result.usageHeaders, ...(recipientId ? { recipientId } : {}) });
      // Private first, public after: the public step becomes PENDING in the SAME transaction that records the
      // accepted private reply, so a crash can never leave a SENT item without its scheduled public step (or the reverse).
      this.schedulePublicReply(row, freshComment);
      // Follow gate: the session starts in the SAME transaction that records the accepted gate message.
      this.createGateSession(row, recipientId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    await this.recordReadback(row, account, result.messageId, JSON.parse(row.payload_json) as SentPayload);
    return row.queue_item_id;
  }

  /**
   * Read-only re-verification of an already SENT item: reads the accepted message once and appends a 'readback' event.
   * Never sends, never changes queue state, and is limited to one call per item per 30 seconds.
   */
  async verifyReadback(accountId: string, queueItemId: string): Promise<{ observed: boolean; safeErrorCode?: string; matches?: boolean }> {
    const item = this.database.prepare(`SELECT q.queue_item_id, q.account_id, q.state, q.payload_json, s.connection_id,
        s.provider_account_id, s.username
      FROM queue_items q JOIN social_accounts s ON s.account_id=q.account_id
      WHERE q.queue_item_id=? AND q.account_id=?`).get(queueItemId, accountId) as {
        queue_item_id: string; account_id: string; state: string; payload_json: string;
        connection_id: string; provider_account_id: string; username: string;
      } | undefined;
    if (!item) throw new QueueReadbackError(404, 'queue_item_not_found');
    if (item.state !== 'SENT') throw new QueueReadbackError(409, 'queue_item_not_sent');
    const accepted = this.database.prepare(`SELECT message_id FROM send_attempts
      WHERE account_id=? AND queue_item_id=? AND event_type='accepted' AND message_id IS NOT NULL
      ORDER BY event_at DESC, rowid DESC LIMIT 1`).get(accountId, queueItemId) as { message_id: string } | undefined;
    if (!accepted?.message_id) throw new QueueReadbackError(409, 'queue_item_without_message_id');
    const now = this.clock();
    const last = this.lastReadbackAt.get(queueItemId);
    if (last !== undefined && now - last < READBACK_MIN_INTERVAL_MS) throw new QueueReadbackError(429, 'readback_rate_limited');
    this.lastReadbackAt.set(queueItemId, now);
    const account: AccountRef = {
      accountId: item.account_id, connectionId: item.connection_id,
      providerAccountId: item.provider_account_id, username: item.username,
    };
    return this.recordReadback({ queue_item_id: item.queue_item_id, account_id: item.account_id }, account,
      accepted.message_id, JSON.parse(item.payload_json) as SentPayload);
  }

  private async recordReadback(
    row: { queue_item_id: string; account_id: string },
    account: AccountRef,
    messageId: string,
    payload: SentPayload,
  ): Promise<{ observed: boolean; safeErrorCode?: string; matches?: boolean }> {
    try {
      const readback = await this.provider.readMessage(account, messageId);
      const comparison = compareReadback(payload, readback);
      this.appendEvent(row, 'readback', messageId, undefined, {
        observed: true, recipientId: readback.recipientId, observedMatches: comparison.matches, matchReason: comparison.reason,
      });
      return { observed: true, matches: comparison.matches };
    } catch (error) {
      const safeErrorCode = safeReadbackErrorCode(error);
      this.appendEvent(row, 'readback', messageId, safeErrorCode, { observed: false, diagnostics: safeReadbackDiagnostics(error) });
      return { observed: false, safeErrorCode };
    }
  }

  recoverInterrupted(): number {
    const rows = this.database.prepare(`SELECT queue_item_id, account_id, state FROM queue_items
      WHERE state IN ('SEND_INTENT_RECORDED', 'SENDING')`).all() as Array<{
        queue_item_id: string; account_id: string; state: 'SEND_INTENT_RECORDED' | 'SENDING';
      }>;
    for (const row of rows) {
      const queue = { queue_item_id: row.queue_item_id, account_id: row.account_id };
      this.markState(queue, 'UNKNOWN_OUTCOME', 'ambiguous_outcome', 'process_interrupted_after_intent', {}, row.state);
    }
    // Public step: the durable intent is committed together with SENDING, so SENDING is exactly "intent without outcome".
    const publicRows = this.database.prepare(`SELECT queue_item_id, account_id FROM queue_items WHERE public_reply_state='SENDING'`)
      .all() as Array<{ queue_item_id: string; account_id: string }>;
    for (const row of publicRows) {
      this.transitionPublic(row, ['SENDING'], 'UNKNOWN_OUTCOME', 'ambiguous', { code: 'process_interrupted_after_intent' });
    }
    return rows.length + publicRows.length;
  }

  /**
   * Moves unsent items whose comment is past the private-reply window to EXPIRED. Never touches SENT, SENDING,
   * SEND_INTENT_RECORDED, UNKNOWN_OUTCOME or FAILED_PERMANENT. Idempotent, bounded per call, optionally account scoped.
   */
  expireStale(accountId?: string): number {
    const now = this.clock();
    const rows = this.database.prepare(`SELECT q.queue_item_id, q.account_id, q.state, c.created_at
      FROM queue_items q JOIN comments c ON c.account_id=q.account_id AND c.comment_id=q.comment_id
      WHERE q.state IN ('QUEUED','FAILED_RETRYABLE','SIMULATED') ${accountId ? 'AND q.account_id=?' : ''}
      ORDER BY q.created_at, q.rowid`).all(...(accountId ? [accountId] : [])) as Array<{
        queue_item_id: string; account_id: string; state: 'QUEUED' | 'FAILED_RETRYABLE' | 'SIMULATED'; created_at: string | null;
      }>;
    let expired = 0;
    for (const row of rows) {
      if (expired >= EXPIRE_SWEEP_LIMIT) break;
      if (!isPastPrivateReplyWindow(row.created_at, now)) continue;
      if (this.expireItem(row.queue_item_id, row.account_id, [row.state])) expired++;
    }
    return expired;
  }

  private expireItem(queueItemId: string, accountId: string, expectedStates: Array<'QUEUED' | 'FAILED_RETRYABLE' | 'SIMULATED'>): boolean {
    const result = this.database.prepare(`UPDATE queue_items SET state='EXPIRED', next_attempt_at=NULL, state_reason_code=?, updated_at=?
      WHERE queue_item_id=? AND account_id=? AND state IN (${expectedStates.map(() => '?').join(',')})`)
      .run(EXPIRED_REASON, new Date().toISOString(), queueItemId, accountId, ...expectedStates);
    return Number(result.changes) === 1;
  }

  /**
   * Posts at most one pending public reply (oldest first). Never runs in Dry Run, never for an item whose private reply
   * is not SENT, at most one in flight, with its own minimum spacing. A durable intent (SENDING + intent event) is
   * committed before the POST; any ambiguous result becomes UNKNOWN_OUTCOME and is never retried. Returns the queue
   * item ID that changed, or null.
   */
  async processPublicReply(accountId?: string): Promise<string | null> {
    this.expireStalePublicReplies();
    if (this.readDryRun() || !this.provider.replyToComment || this.publicProcessing.size > 0) return null;
    const now = this.clock();
    const row = this.nextPublic(accountId, now);
    if (!row || this.publicProcessing.has(row.queue_item_id)) return null;
    this.publicProcessing.add(row.queue_item_id);
    try {
      return await this.processPublicClaimed(row, now);
    } finally {
      this.publicProcessing.delete(row.queue_item_id);
    }
  }

  /**
   * Explicit operator retry of a FAILED public reply (failures are definitive rejections, so provably unpublished).
   * Only the public step is reset to PENDING; the private item state is never read for change or touched.
   */
  retryPublicReply(accountId: string, queueItemId: string): void {
    const row = this.database.prepare(`SELECT queue_item_id, account_id, state, public_reply_state FROM queue_items
      WHERE queue_item_id=? AND account_id=?`).get(queueItemId, accountId) as {
        queue_item_id: string; account_id: string; state: string; public_reply_state: string | null;
      } | undefined;
    if (!row) throw new QueueActionError(404, 'queue_item_not_found');
    if (row.public_reply_state !== 'FAILED' || row.state !== 'SENT') throw new QueueActionError(409, 'public_reply_not_failed');
    const acceptedAt = this.privateAcceptedAt(row.queue_item_id);
    if (acceptedAt === undefined || this.clock() - acceptedAt >= PUBLIC_REPLY_WINDOW_MS) {
      this.transitionPublic(row, ['FAILED'], 'EXPIRED', 'expired', { code: 'public_reply_window_elapsed' });
      throw new QueueActionError(409, 'public_reply_window_elapsed');
    }
    if (!this.transitionPublic(row, ['FAILED'], 'PENDING', 'manual_retry', { resetAttempts: true })) {
      throw new QueueActionError(409, 'public_reply_not_failed');
    }
  }

  private async processPublicClaimed(row: PublicRow, now: number): Promise<string | null> {
    if (row.state !== 'SENT') {
      this.transitionPublic(row, ['PENDING'], 'SKIPPED', 'skipped', { code: 'private_not_sent' });
      return row.queue_item_id;
    }
    const acceptedAt = this.privateAcceptedAt(row.queue_item_id);
    if (acceptedAt === undefined || now - acceptedAt >= PUBLIC_REPLY_WINDOW_MS) {
      this.transitionPublic(row, ['PENDING'], 'EXPIRED', 'expired', { code: 'public_reply_window_elapsed' });
      return row.queue_item_id;
    }
    // Conservative: a public reply is only posted while its automation still wants it. Turning the public reply off,
    // pausing, archiving or removing real authorization skips it (the private reply already went out; nothing else).
    const automation = this.database.prepare(`SELECT status, real_enabled, name, public_reply_enabled, public_reply_variants_json
      FROM automations WHERE account_id=? AND automation_id=?`).get(row.account_id, row.automation_id) as {
        status: string; real_enabled: number; name: string; public_reply_enabled: number; public_reply_variants_json: string;
      } | undefined;
    if (!automation || automation.status !== 'enabled' || automation.real_enabled !== 1 || automation.name.endsWith(' (archived)')) {
      this.transitionPublic(row, ['PENDING'], 'SKIPPED', 'skipped', { code: 'automation_unavailable' });
      return row.queue_item_id;
    }
    if (automation.public_reply_enabled !== 1 || !storedPublicReplyVariants(automation.public_reply_variants_json).length) {
      this.transitionPublic(row, ['PENDING'], 'SKIPPED', 'skipped', { code: 'public_reply_disabled' });
      return row.queue_item_id;
    }
    const text = row.public_reply_text?.trim();
    if (!text) {
      this.transitionPublic(row, ['PENDING'], 'SKIPPED', 'skipped', { code: 'public_reply_text_missing' });
      return row.queue_item_id;
    }
    const account: AccountRef = {
      accountId: row.account_id, connectionId: row.connection_id, providerAccountId: row.provider_account_id, username: row.username,
    };
    const post = async (): Promise<PublicReplyResult | null> => {
      if (!this.recordPublicIntent(row, this.clock())) return null;
      try {
        return await this.provider.replyToComment!(account, row.comment_id, text);
      } catch {
        return { outcome: 'ambiguous', safeErrorCode: 'provider_exception' };
      }
    };
    let result: PublicReplyResult | null;
    if (this.options.legacyInterlock) {
      const legacyRow = { account_id: row.account_id, username: row.username } as QueueRow;
      if (!this.legacyAcknowledged(legacyRow)) return null;
      try {
        result = await this.options.legacyInterlock.withExclusiveLock(row.username, async () => {
          if (!this.legacyAcknowledged(legacyRow, true)) return null;
          return post();
        });
      } catch {
        return null;
      }
    } else {
      result = await post();
    }
    if (!result) return null;
    this.recordPublicOutcome(row, result, acceptedAt);
    return row.queue_item_id;
  }

  private recordPublicOutcome(row: PublicRow, result: PublicReplyResult, acceptedAt: number): void {
    const details = { httpStatus: result.httpStatus, usageHeaders: result.usageHeaders };
    if (result.outcome === 'accepted' && result.replyId?.trim()) {
      this.transitionPublic(row, ['SENDING'], 'SENT', 'accepted', { replyId: result.replyId.trim(), details });
      return;
    }
    if (result.outcome !== 'definitive_rejection') {
      const code = result.outcome === 'accepted' ? 'accepted_without_reply_id' : result.safeErrorCode ?? 'ambiguous_provider_result';
      this.transitionPublic(row, ['SENDING'], 'UNKNOWN_OUTCOME', 'ambiguous', { code, details });
      return;
    }
    const code = result.safeErrorCode ?? 'provider_rejection';
    const rateLimited = code === 'public_reply_rate_limited' || result.httpStatus === 429;
    const attempts = (this.database.prepare(`SELECT public_reply_attempts FROM queue_items WHERE queue_item_id=?`)
      .get(row.queue_item_id) as { public_reply_attempts: number } | undefined)?.public_reply_attempts ?? PUBLIC_REPLY_MAX_ATTEMPTS;
    if (!rateLimited || attempts >= PUBLIC_REPLY_MAX_ATTEMPTS) {
      this.transitionPublic(row, ['SENDING'], 'FAILED', 'definitive_rejection', { code, details });
      return;
    }
    // Provably unsent throttling: bounded retry, never sooner than the provider's Retry-After.
    const retryAt = this.clock() + publicRetryDelay(result.usageHeaders?.retryAfter, attempts, this.clock());
    if (retryAt - acceptedAt >= PUBLIC_REPLY_WINDOW_MS) {
      this.transitionPublic(row, ['SENDING'], 'EXPIRED', 'definitive_rejection', { code, details: { ...details, expired: true } });
      return;
    }
    this.transitionPublic(row, ['SENDING'], 'PENDING', 'definitive_rejection',
      { code, nextAt: new Date(retryAt).toISOString(), details: { ...details, retryAt: new Date(retryAt).toISOString() } });
  }

  /** Bounded, idempotent sweep: PENDING public replies whose private reply was accepted 24 h ago (or never) expire. */
  private expireStalePublicReplies(): number {
    const now = this.clock();
    const rows = this.database.prepare(`SELECT queue_item_id, account_id FROM queue_items WHERE public_reply_state='PENDING'
      ORDER BY created_at, rowid LIMIT ?`).all(PUBLIC_SWEEP_LIMIT) as Array<{ queue_item_id: string; account_id: string }>;
    let expired = 0;
    for (const row of rows) {
      const acceptedAt = this.privateAcceptedAt(row.queue_item_id);
      if (acceptedAt !== undefined && now - acceptedAt < PUBLIC_REPLY_WINDOW_MS) continue;
      if (this.transitionPublic(row, ['PENDING'], 'EXPIRED', 'expired', { code: 'public_reply_window_elapsed' })) expired++;
    }
    return expired;
  }

  private privateAcceptedAt(queueItemId: string): number | undefined {
    const row = this.database.prepare(`SELECT MIN(event_at) AS event_at FROM send_attempts WHERE queue_item_id=? AND event_type='accepted'`)
      .get(queueItemId) as { event_at: string | null };
    const parsed = row.event_at ? Date.parse(row.event_at) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private nextPublic(accountId: string | undefined, now: number): PublicRow | undefined {
    return this.database.prepare(`SELECT q.queue_item_id, q.account_id, q.comment_id, q.automation_id, q.state, q.public_reply_text,
        q.public_reply_attempts, s.connection_id, s.provider_account_id, s.username
      FROM queue_items q
      JOIN social_accounts s ON s.account_id=q.account_id
      JOIN connections c ON c.id=s.connection_id
      WHERE q.public_reply_state='PENDING' AND (q.public_reply_next_at IS NULL OR q.public_reply_next_at<=?)
        AND s.status='valid' AND s.monitoring_paused=0 AND c.status='valid' AND c.monitoring_paused=0 AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM account_send_holds h WHERE h.account_id=q.account_id)
        ${accountId ? 'AND q.account_id=?' : ''}
      ORDER BY q.created_at, q.rowid LIMIT 1`).get(new Date(now).toISOString(), ...(accountId ? [accountId] : [])) as PublicRow | undefined;
  }

  /** Commits the durable public intent (SENDING + attempt count + intent event) before any POST; false when not allowed now. */
  private recordPublicIntent(row: PublicRow, now: number): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.database.prepare(`SELECT MAX(event_at) AS event_at FROM public_reply_attempts WHERE event_type='intent_recorded'`)
        .get() as { event_at: string | null };
      const spacing = Math.max(0, this.options.publicReplySpacingMs ?? PUBLIC_REPLY_SPACING_MS);
      if (previous.event_at && now - Date.parse(previous.event_at) < spacing) {
        this.database.exec('ROLLBACK');
        return false;
      }
      const nowIso = new Date(now).toISOString();
      const result = this.database.prepare(`UPDATE queue_items SET public_reply_state='SENDING',
          public_reply_attempts=public_reply_attempts+1, public_reply_next_at=NULL, updated_at=?
        WHERE queue_item_id=? AND account_id=? AND state='SENT' AND public_reply_state='PENDING'
          AND (public_reply_next_at IS NULL OR public_reply_next_at<=?)
          AND EXISTS (SELECT 1 FROM app_state WHERE state_key='dry_run' AND state_value='false')
          AND EXISTS (SELECT 1 FROM automations a WHERE a.automation_id=? AND a.account_id=? AND a.status='enabled'
            AND a.real_enabled=1 AND a.public_reply_enabled=1 AND a.name NOT LIKE '% (archived)')
          AND EXISTS (SELECT 1 FROM social_accounts s WHERE s.account_id=? AND s.connection_id=? AND s.provider_account_id=?
            AND s.status='valid' AND s.monitoring_paused=0)
          AND EXISTS (SELECT 1 FROM connections c WHERE c.id=? AND c.status='valid' AND c.monitoring_paused=0 AND c.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM account_send_holds h WHERE h.account_id=?)
          AND NOT EXISTS (SELECT 1 FROM queue_items other WHERE other.public_reply_state='SENDING' AND other.queue_item_id<>?)
          AND NOT EXISTS (SELECT 1 FROM queue_items active WHERE active.account_id=? AND active.state='SENDING')`)
        .run(nowIso, row.queue_item_id, row.account_id, nowIso, row.automation_id, row.account_id, row.account_id,
          row.connection_id, row.provider_account_id, row.connection_id, row.account_id, row.queue_item_id, row.account_id);
      if (Number(result.changes) !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.appendPublicEvent(row, 'intent_recorded', now, {});
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /** Expected-state conditional transition of the public step plus one append-only event, in one transaction. */
  private transitionPublic(
    row: { queue_item_id: string; account_id: string },
    expected: string[],
    next: 'PENDING' | 'SENT' | 'FAILED' | 'UNKNOWN_OUTCOME' | 'SKIPPED' | 'EXPIRED',
    event: PublicEvent,
    extra: { code?: string; replyId?: string; nextAt?: string; resetAttempts?: boolean; details?: Record<string, unknown> } = {},
  ): boolean {
    const now = this.clock();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.database.prepare(`UPDATE queue_items SET public_reply_state=?, public_reply_next_at=?,
          public_reply_attempts=CASE WHEN ? THEN 0 ELSE public_reply_attempts END, updated_at=?
        WHERE queue_item_id=? AND account_id=? AND public_reply_state IN (${expected.map(() => '?').join(',')})`)
        .run(next, extra.nextAt ?? null, extra.resetAttempts ? 1 : 0, new Date(now).toISOString(), row.queue_item_id, row.account_id, ...expected);
      if (Number(updated.changes) !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.appendPublicEvent(row, event, now, extra.details ?? {}, extra.replyId, extra.code);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private appendPublicEvent(
    row: { queue_item_id: string; account_id: string }, event: PublicEvent, at: number, details: Record<string, unknown>,
    replyId?: string, code?: string,
  ): void {
    this.database.prepare(`INSERT INTO public_reply_attempts
      (attempt_event_id, account_id, queue_item_id, event_type, event_at, reply_id, safe_error_code, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), row.account_id, row.queue_item_id, event, new Date(at).toISOString(), replyId ?? null, code ?? null,
        JSON.stringify(details));
  }

  /**
   * Called inside the accepted-private transaction: when the automation has an enabled public reply with variants and
   * Dry Run is off, picks a variant (rotation per account), renders it and marks the public step PENDING.
   */
  private schedulePublicReply(row: QueueRow, comment: { text?: string; username?: string }): void {
    if (this.readDryRun() || row.dry_run) return;
    const automation = this.database.prepare(`SELECT public_reply_enabled, public_reply_variants_json, match_mode
      FROM automations WHERE account_id=? AND automation_id=?`).get(row.account_id, row.automation_id) as {
        public_reply_enabled: number; public_reply_variants_json: string; match_mode: 'exact' | 'contains';
      } | undefined;
    if (!automation || automation.public_reply_enabled !== 1) return;
    const keywords = (this.database.prepare(`SELECT phrase FROM automation_keywords WHERE account_id=? AND automation_id=? ORDER BY rowid`)
      .all(row.account_id, row.automation_id) as Array<{ phrase: string }>).map(({ phrase }) => phrase);
    const keyword = matchAutomation(comment.text ?? '', keywords, automation.match_mode)[0] ?? keywords[0] ?? '';
    const selection = this.choosePublicReply(row.account_id, storedPublicReplyVariants(automation.public_reply_variants_json),
      { username: comment.username ?? '', keyword });
    if (!selection) return;
    this.database.prepare(`UPDATE queue_items SET public_reply_state='PENDING', public_reply_text=?, public_reply_variant=?,
        public_reply_selected_at=?, public_reply_attempts=0, public_reply_next_at=NULL
      WHERE queue_item_id=? AND state='SENT' AND public_reply_state IS NULL`)
      .run(selection.text, selection.variant, new Date(this.clock()).toISOString(), row.queue_item_id);
  }

  /**
   * Called inside the accepted-private transaction for a queue item whose frozen payload carries a follow gate. The
   * IGSID comes from the send response (preferred) or the stored comment author; without one the session is recorded
   * as FAILED (igsid_unknown) and the private item stays SENT (it is never resent).
   */
  private createGateSession(row: QueueRow, recipientId: string | undefined): void {
    // Defensive: with the gate retired a gate payload is skipped before sending, so no session can ever start.
    if (!this.followGateAvailable()) return;
    let snapshot: { buttonTitle?: unknown; resource?: { text?: unknown; buttons?: unknown }; attachment?: { kind?: unknown; url?: unknown } } | undefined;
    try {
      snapshot = (JSON.parse(row.payload_json) as { followGate?: typeof snapshot }).followGate;
    } catch {
      snapshot = undefined;
    }
    if (!snapshot || typeof snapshot.buttonTitle !== 'string' || typeof snapshot.resource?.text !== 'string' || !Array.isArray(snapshot.resource.buttons)) return;
    const author = this.database.prepare(`SELECT author_igsid FROM comments WHERE account_id=? AND comment_id=?`)
      .get(row.account_id, row.comment_id) as { author_igsid: string | null } | undefined;
    const igsid = recipientId ?? safeIgsid(author?.author_igsid);
    const now = this.clock();
    const nowIso = new Date(now).toISOString();
    const sessionId = randomUUID();
    // The attachment is frozen on the session like the other snapshots ('' = none; an invalid snapshot is never sent).
    const attachment = snapshot.attachment ? storedResourceAttachment(snapshot.attachment.kind, snapshot.attachment.url) : null;
    this.database.prepare(`INSERT INTO gate_sessions (gate_session_id, account_id, automation_id, queue_item_id, comment_id, igsid, state,
        gate_sent_at, next_poll_at, button_title, resource_payload_json, last_error_code, created_at, updated_at,
        resource_attachment_kind, resource_attachment_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, row.account_id, row.automation_id, row.queue_item_id, row.comment_id, igsid ?? null, igsid ? 'AWAITING_TAP' : 'FAILED',
        nowIso, igsid ? new Date(now + GATE_FIRST_POLL_MS).toISOString() : null, snapshot.buttonTitle,
        JSON.stringify({ text: snapshot.resource.text, buttons: snapshot.resource.buttons }), igsid ? null : 'igsid_unknown', nowIso, nowIso,
        attachment?.kind ?? '', attachment?.url ?? '');
    this.database.prepare(`INSERT INTO gate_events (gate_event_id, account_id, gate_session_id, event_type, event_at, safe_error_code, details_json)
      VALUES (?, ?, ?, 'session_created', ?, ?, ?)`)
      .run(randomUUID(), row.account_id, sessionId, nowIso, igsid ? null : 'igsid_unknown',
        JSON.stringify({ igsidSource: recipientId ? 'send_response' : igsid ? 'comment_author' : 'none' }));
  }

  /** Rotation: avoids the account's most recent variants (see selectPublicReplyVariant). Null when nothing valid renders. */
  private choosePublicReply(accountId: string, variants: string[], variables: { username: string; keyword: string }):
    { variant: string; text: string } | null {
    if (!variants.length || !variables.username.trim()) return null;
    const recent = (this.database.prepare(`SELECT public_reply_variant FROM queue_items
      WHERE account_id=? AND public_reply_variant IS NOT NULL
      ORDER BY public_reply_selected_at DESC, rowid DESC LIMIT ?`).all(accountId, PUBLIC_REPLY_RECENT_WINDOW) as Array<{ public_reply_variant: string }>)
      .map((entry) => entry.public_reply_variant);
    const variant = selectPublicReplyVariant(variants, recent, this.options.rng ?? Math.random);
    try {
      return { variant, text: renderPublicReply(variant, variables) };
    } catch {
      return null;
    }
  }

  private readDryRun(): boolean {
    const row = this.database.prepare(`SELECT state_value FROM app_state WHERE state_key='dry_run'`).get() as { state_value: string } | undefined;
    return row?.state_value !== 'false';
  }

  private followGateAvailable(): boolean {
    return followGateAvailable(this.options.followGateAvailable);
  }

  private legacyAcknowledged(row: QueueRow, ownLockHeld = false): boolean {
    return legacyAcknowledged(this.database, this.options.legacyInterlock, row.account_id, row.username, ownLockHeld);
  }

  private nextQueued(accountId?: string, queueItemId?: string, now = Date.now()): QueueRow | undefined {
    const filter = queueItemId ? 'AND q.queue_item_id = ?' : accountId ? 'AND q.account_id = ?' : '';
    const parameter = queueItemId ?? accountId;
    // media_id is the comment's publication; for a media-scoped automation it equals the automation media (enqueue rule).
    return this.database.prepare(`SELECT q.queue_item_id, q.account_id, q.comment_id, q.automation_id, q.state,
        q.dry_run, q.payload_json, cm.media_id, a.media_id AS automation_media_id, a.scope AS automation_scope,
        a.status AS automation_status, a.real_enabled, a.match_mode,
        a.reply_text, a.version AS automation_version, s.username, s.provider_account_id, s.connection_id,
        a.buttons_json, q.attempt_count, s.status AS account_status, c.status AS connection_status, c.monitoring_paused AS connection_paused
        , EXISTS (SELECT 1 FROM account_send_holds h WHERE h.account_id=q.account_id) AS send_held
      FROM queue_items q
      JOIN automations a ON a.account_id=q.account_id AND a.automation_id=q.automation_id
      JOIN comments cm ON cm.account_id=q.account_id AND cm.comment_id=q.comment_id
      JOIN social_accounts s ON s.account_id=q.account_id
      JOIN connections c ON c.id=s.connection_id
      WHERE (q.state='QUEUED' OR (q.state='FAILED_RETRYABLE' AND (q.next_attempt_at IS NULL OR q.next_attempt_at<=?)))
        ${filter} ORDER BY q.created_at, q.rowid LIMIT 1`).get(new Date(now).toISOString(), ...(parameter ? [parameter] : [])) as QueueRow | undefined;
  }

  private stillAllowed(row: QueueRow, comment: { commentId: string; text?: string; username?: string; createdAt?: string; parentId?: string }): boolean {
    if (comment.commentId !== row.comment_id || row.dry_run || !row.real_enabled || row.automation_status !== 'enabled'
      || row.connection_status !== 'valid' || row.connection_paused !== 0 || row.account_status !== 'valid') return false;
    if (row.send_held) return false;
    const queuedVersion = Number((JSON.parse(row.payload_json) as { automation_version?: unknown }).automation_version);
    if (queuedVersion !== row.automation_version) return false;
    const matches = this.database.prepare(`SELECT phrase FROM automation_keywords WHERE account_id=? AND automation_id=?`)
      .all(row.account_id, row.automation_id) as Array<{ phrase: string }>;
    const classification = classifyComment(comment, matches.map((item) => item.phrase), row.username, this.clock(), row.match_mode,
      hasOwnerReply(this.database, row.account_id, row.comment_id, row.username));
    return classification.eligible && classification.matchedKeywords.length > 0;
  }

  private recordIntent(row: QueueRow, now: number): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const previousIntent = this.database.prepare(`SELECT MAX(event_at) AS event_at FROM send_attempts
        WHERE event_type='intent_recorded'`).get() as { event_at: string | null };
      if (previousIntent.event_at && now - Date.parse(previousIntent.event_at)
        < Math.max(0, this.options.sendSpacingMs ?? 10_000)) {
        this.database.exec('ROLLBACK');
        return false;
      }
      const result = this.database.prepare(`UPDATE queue_items SET state='SENDING', attempt_count=attempt_count+1,
        next_attempt_at=NULL, updated_at=?
        WHERE queue_item_id=? AND state IN ('QUEUED','FAILED_RETRYABLE') AND dry_run=0
          AND EXISTS (SELECT 1 FROM app_state WHERE state_key='dry_run' AND state_value='false')
          AND EXISTS (SELECT 1 FROM automations a WHERE a.automation_id=? AND a.account_id=?
            AND a.real_enabled=1 AND a.version=? AND ${claimsMediaSql('a', '?')})
          AND EXISTS (SELECT 1 FROM social_accounts s WHERE s.account_id=? AND s.connection_id=?
            AND s.provider_account_id=? AND s.status='valid' AND s.monitoring_paused=0)
          AND EXISTS (SELECT 1 FROM connections c WHERE c.id=? AND c.status='valid'
            AND c.monitoring_paused=0 AND c.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM account_send_holds h WHERE h.account_id=?)
          AND NOT EXISTS (SELECT 1 FROM queue_items active WHERE active.state='SENDING'
            AND active.queue_item_id<>?)`)
        .run(new Date().toISOString(), row.queue_item_id, row.automation_id, row.account_id, row.automation_version,
          row.media_id, row.media_id, row.account_id, row.connection_id, row.provider_account_id, row.connection_id, row.account_id, row.queue_item_id);
      if (Number(result.changes) !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.appendEvent(row, 'intent_recorded', undefined, undefined, { automation_version: row.automation_version });
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private markState(
    row: { queue_item_id: string; account_id: string },
    state: string,
    event: 'ambiguous_outcome' | 'definitive_rejection' | 'retryable_failure',
    code: string,
    details: Record<string, unknown> = {},
    expectedState: 'QUEUED' | 'FAILED_RETRYABLE' | 'SEND_INTENT_RECORDED' | 'SENDING' = 'SENDING',
  ): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const queued = this.database.prepare(`SELECT attempt_count FROM queue_items WHERE queue_item_id=? AND state=?`)
        .get(row.queue_item_id, expectedState) as { attempt_count: number } | undefined;
      if (!queued) {
        this.database.exec('ROLLBACK');
        return;
      }
      let nextState = state;
      let nextAttemptAt: string | null = null;
      if (state === 'FAILED_RETRYABLE') {
        if ((queued?.attempt_count ?? 0) >= 5) {
          nextState = 'FAILED_PERMANENT';
        } else {
          const delay = boundedRetryDelay(details.retryAfter, queued?.attempt_count ?? 0);
          const retryAt = this.clock() + delay;
          nextAttemptAt = new Date(retryAt).toISOString();
          const comment = this.database.prepare(`SELECT c.created_at FROM queue_items q
            JOIN comments c ON c.account_id=q.account_id AND c.comment_id=q.comment_id WHERE q.queue_item_id=?`)
            .get(row.queue_item_id) as { created_at: string | null } | undefined;
          if (isPastPrivateReplyWindow(comment?.created_at, retryAt)) {
            // The retry would land after the private-reply window: expire instead of retrying.
            nextState = 'EXPIRED';
            nextAttemptAt = null;
          }
        }
      }
      const updated = this.database.prepare(`UPDATE queue_items SET state=?, next_attempt_at=?, state_reason_code=?, updated_at=? WHERE queue_item_id=? AND state=?`)
        .run(nextState, nextAttemptAt, nextState === 'EXPIRED' ? EXPIRED_REASON : null, new Date().toISOString(), row.queue_item_id, expectedState);
      if (Number(updated.changes) !== 1) {
        this.database.exec('ROLLBACK');
        return;
      }
      this.appendEvent(row, event, undefined, code, details);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private appendEvent(
    row: { queue_item_id: string; account_id: string },
    event: string,
    messageId?: string,
    errorCode?: string,
    details: Record<string, unknown> = {},
  ): void {
    this.database.prepare(`INSERT INTO send_attempts
      (attempt_event_id, account_id, queue_item_id, event_type, event_at, message_id, safe_error_code, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      // event_at uses the queue clock: the send-spacing check compares it with this.clock(), so both must share one clock.
      .run(randomUUID(), row.account_id, row.queue_item_id, event, new Date(this.clock()).toISOString(), messageId ?? null,
        errorCode ?? null, JSON.stringify(details));
  }

  private clock(): number {
    return this.options.clock?.() ?? Date.now();
  }
}

/** Legacy interlock rule shared by every send path (private, public, follow gate resource). */
export function legacyAcknowledged(
  database: DatabaseSync, interlock: LegacyQueueInterlock | undefined, accountId: string, username: string, ownLockHeld = false,
): boolean {
  const state = interlock?.inspect(username);
  if (!state || (!ownLockHeld && state.lockPresent)) return false;
  const acknowledgement = database.prepare(`SELECT username, counter_version FROM legacy_account_acknowledgements WHERE account_id=?`)
    .get(accountId) as { username: string; counter_version: string } | undefined;
  const normalized = username.normalize('NFC').trim().replace(/^@/u, '').toLocaleLowerCase('und');
  if (state.counterVersion === 'unreadable') return false;
  if (state.counterVersion === 'absent' && !state.holdConfigured) return true;
  return Boolean(acknowledgement && acknowledgement.username === normalized && acknowledgement.counter_version === state.counterVersion);
}

function boundedRetryDelay(retryAfter: unknown, attemptCount: number): number {
  const maximum = 15 * 60 * 1000;
  if (typeof retryAfter === 'string') {
    const seconds = /^\d{1,6}$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  return Math.min(maximum, 10_000 * (2 ** Math.max(0, attemptCount - 1)));
}

function publicRetryDelay(retryAfter: string | undefined, attempts: number, now: number): number {
  if (typeof retryAfter === 'string') {
    const delay = /^\d{1,6}$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  return Math.min(PUBLIC_RETRY_MAX_DELAY_MS, PUBLIC_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempts - 1)));
}

/** True for a frozen payload of the retired experiment: quick replies, or postback buttons without a follow gate. */
function retiredInteractivePayload(payloadJson: string): boolean {
  try {
    const payload = JSON.parse(payloadJson) as { quickReplies?: unknown; postbackButtons?: unknown; followGate?: unknown };
    return payload.quickReplies !== undefined || (payload.postbackButtons !== undefined && !payload.followGate);
  } catch {
    return false;
  }
}

/** True for a frozen payload carrying a follow gate snapshot (first message with the gate button). */
function frozenFollowGatePayload(payloadJson: string): boolean {
  try {
    const payload = JSON.parse(payloadJson) as { followGate?: unknown };
    return payload.followGate !== undefined && payload.followGate !== null;
  } catch {
    return false;
  }
}

/** Opaque Instagram-scoped id from the send response: bounded, simple charset, otherwise dropped. */
function safeRecipientId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : undefined;
}

/** Maps a readback failure to a short safe code: never raw messages, bodies or tokens. */
function safeReadbackErrorCode(error: unknown): string {
  const fallback = 'readback_unavailable';
  if (!error || typeof error !== 'object') return fallback;
  const { code, metaCode, httpStatus, name } = error as { code?: unknown; metaCode?: unknown; httpStatus?: unknown; name?: unknown };
  if (typeof code === 'string' && /^[a-z][a-z0-9_]{2,63}$/u.test(code)) return code;
  if (typeof metaCode === 'number' && Number.isInteger(metaCode) && metaCode > 0) return `meta_${metaCode}`;
  if (typeof httpStatus === 'number' && httpStatus >= 100 && httpStatus < 600) return `http_${Math.floor(httpStatus / 100)}xx`;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return fallback;
}

const DIAGNOSTIC_BOOLEANS = ['idMatches', 'senderIdMatches', 'usernamePresent', 'usernameMatches', 'hasAttachments'] as const;
const DIAGNOSTIC_ENUMS: Record<string, readonly string[]> = {
  toShape: ['array', 'data', 'other', 'missing'], attachmentsShape: ['array', 'data', 'missing', 'other'],
};

/** Whitelists readback diagnostics (booleans, a bounded count and fixed enums); anything else is dropped. */
function safeReadbackDiagnostics(error: unknown): Record<string, boolean | number | string> | undefined {
  const raw = error && typeof error === 'object' ? (error as { diagnostics?: unknown }).diagnostics : undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const safe: Record<string, boolean | number | string> = {};
  for (const key of DIAGNOSTIC_BOOLEANS) if (typeof source[key] === 'boolean') safe[key] = source[key] as boolean;
  const count = source.recipientCount;
  if (typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 1000) safe.recipientCount = count;
  for (const [key, allowed] of Object.entries(DIAGNOSTIC_ENUMS)) {
    if (typeof source[key] === 'string' && allowed.includes(source[key] as string)) safe[key] = source[key] as string;
  }
  return Object.keys(safe).length ? safe : undefined;
}

/** Informational comparison of the sent payload with what Meta reports; never triggers any action. */
function compareReadback(payload: SentPayload, readback: MessageReadback): { matches: boolean; reason: string } {
  const text = (payload.text ?? '').trim();
  const buttons = payload.buttons ?? [];
  if (!buttons.length) {
    if (readback.text === undefined) return { matches: false, reason: 'content_unavailable' };
    return readback.text.trim() === text ? { matches: true, reason: 'match' } : { matches: false, reason: 'text_mismatch' };
  }
  const template = readback.templates?.[0];
  if (!template) return { matches: false, reason: 'content_unavailable' };
  if ((template.title ?? '').trim() !== text) return { matches: false, reason: 'text_mismatch' };
  const same = template.buttons.length === buttons.length
    && buttons.every((button, index) => template.buttons[index]!.title === button.title && template.buttons[index]!.url === button.url);
  return same ? { matches: true, reason: 'match' } : { matches: false, reason: 'buttons_mismatch' };
}
