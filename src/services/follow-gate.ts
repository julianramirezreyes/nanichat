import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AccountRef, DirectAttachmentPayload, DirectMessagePayload, ResourceAttachment, SendResult, SocialProvider, TapResult } from '../core/domain.ts';
import {
  FOLLOW_GATE_RETIRED_CODE, followGateAvailable, GATE_MAX_SEND_ATTEMPTS, GATE_MAX_SESSIONS_PER_TICK, GATE_PART_SPACING_MS, GATE_POLL_ERROR_MIN_DELAY_MS, GATE_RESOURCE_WINDOW_MS, GATE_SPACING_MS,
  GATE_TAP_EXPIRY_MS, nextGatePollDelay, normalizeTapText,
} from './follow-gate-rules.ts';
import { legacyAcknowledged, type LegacyQueueInterlock } from './queue.ts';
import { storedResourceAttachment } from './resource-attachment.ts';

type GateProvider = Partial<Pick<SocialProvider, 'sendMessage' | 'findUserTap'>>;
type GateState = 'AWAITING_TAP' | 'RESOURCE_SENDING' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED' | 'FAILED' | 'UNKNOWN_OUTCOME';
type GateEvent = 'tap_detected' | 'resource_intent_recorded' | 'resource_accepted' | 'resource_rejected' | 'resource_ambiguous'
  | 'expired' | 'cancelled' | 'poll_error';

type SessionRow = {
  gate_session_id: string; account_id: string; automation_id: string; igsid: string | null; state: GateState;
  gate_sent_at: string; tap_message_id: string | null; tap_at: string | null; window_expires_at: string | null;
  send_attempts: number; button_title: string; resource_payload_json: string;
  resource_attachment_kind: string; resource_attachment_url: string;
  connection_id: string; provider_account_id: string; username: string;
};

/** Follow-up part of a session with an attachment: the media first, then the resource text + buttons. */
type Part = 'attachment' | 'text';
type PartEvent = 'intent_recorded' | 'accepted' | 'rejected' | 'ambiguous' | 'skipped';
type PartStatus = { status: 'pending' | 'sending' | 'accepted' | 'skipped' | 'ambiguous'; attempts: number; doneAt?: number };
type PartRecord = { part: Part; event: PartEvent; code?: string; messageId?: string; details?: Record<string, unknown> };

const SWEEP_LIMIT = 500;
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const RETRY_BASE_DELAY_MS = 30_000;
const RETRY_MAX_DELAY_MS = 15 * 60_000;
/** A send blocked by a transient guard (another send in flight, a hold, a lock) is looked at again after this delay. */
const DEFER_MS = 30_000;

export type FollowGateOptions = {
  clock?: () => number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  spacingMs?: number;
  maxPerTick?: number;
  legacyInterlock?: LegacyQueueInterlock;
  /** TEST-ONLY override of FOLLOW_GATE_AVAILABLE (the gate is retired); production never passes it. */
  followGateAvailable?: boolean;
};

/**
 * Follow gate engine (honor system). For each due session: poll the conversation for the user's tap on the gate
 * button; on the first tap, send the resource message by IGSID once. It never verifies follow status. Invariants:
 * the resource is sent at most once per session (expected-state updates, one `resource_accepted` per session), a
 * durable intent is committed before the POST, ambiguous outcomes become UNKNOWN_OUTCOME and are never retried, and
 * poll errors only back off. Nothing runs in Dry Run.
 *
 * A session with an attachment sends TWO follow-ups: (1) the attachment, then, at least GATE_PART_SPACING_MS later,
 * (2) the unchanged text + URL buttons. Each part has its own durable intent and append-only `gate_part_events`; each
 * part is accepted at most once (unique index) and an accepted or skipped attachment is never sent again. A rejected
 * attachment is skipped and the text still goes out (COMPLETED with `attachment_failed`); an ambiguous attachment
 * stops the session (UNKNOWN_OUTCOME) and the text is never sent. Sessions without an attachment are unchanged.
 */
export class FollowGateService {
  private running = false;
  private calls = 0;

  constructor(
    private readonly database: DatabaseSync,
    private readonly provider: GateProvider,
    private readonly options: FollowGateOptions = {},
  ) {}

  /**
   * Startup: a resource send interrupted after its durable intent has an unknown outcome (never retried). For a session
   * with an attachment, the part left with an intent and no outcome is recorded as ambiguous too.
   */
  recoverInterrupted(): number {
    const rows = this.database.prepare(`SELECT gate_session_id, account_id FROM gate_sessions WHERE state='RESOURCE_SENDING'`)
      .all() as Array<{ gate_session_id: string; account_id: string }>;
    let changed = 0;
    for (const row of rows) {
      const code = 'process_interrupted_after_intent';
      const pending = (['attachment', 'text'] as const).find((part) => this.partStatus(row.gate_session_id, part).status === 'sending');
      if (this.transition(row, ['RESOURCE_SENDING'], 'UNKNOWN_OUTCOME', 'resource_ambiguous', {
        code, ...(pending ? { details: { part: pending }, part: { part: pending, event: 'ambiguous', code } } : {}),
      })) changed++;
    }
    return changed;
  }

  /** Local-only sweep: untapped sessions past 7 days and tapped ones past their 24 h window expire (no send). */
  expireStale(): number {
    const now = this.clock();
    const rows = this.database.prepare(`SELECT gate_session_id, account_id, gate_sent_at, tap_message_id, window_expires_at
      FROM gate_sessions WHERE state='AWAITING_TAP' ORDER BY gate_sent_at LIMIT ?`).all(SWEEP_LIMIT) as Array<{
        gate_session_id: string; account_id: string; gate_sent_at: string; tap_message_id: string | null; window_expires_at: string | null;
      }>;
    let expired = 0;
    for (const row of rows) {
      if (row.tap_message_id) {
        if (!(now >= Date.parse(row.window_expires_at ?? ''))) continue;
        if (this.transition(row, ['AWAITING_TAP'], 'EXPIRED', 'expired', { code: 'resource_window_elapsed' })) expired++;
      } else if (now - Date.parse(row.gate_sent_at) >= GATE_TAP_EXPIRY_MS) {
        if (this.transition(row, ['AWAITING_TAP'], 'EXPIRED', 'expired', { code: 'gate_no_tap_7d' })) expired++;
      }
    }
    return expired;
  }

  /**
   * Retired gate (FOLLOW_GATE_AVAILABLE false): every session still waiting for a tap (tapped or not) is CANCELLED with
   * `follow_gate_retired` plus an append-only event, locally, without any provider call. Closed sessions (COMPLETED,
   * FAILED, EXPIRED, CANCELLED, UNKNOWN_OUTCOME) are history and stay untouched. A RESOURCE_SENDING session is never
   * cancelled here: its POST may have gone out, so startup recovery records it as UNKNOWN_OUTCOME instead.
   */
  cancelRetired(): number {
    const rows = this.database.prepare(`SELECT gate_session_id, account_id FROM gate_sessions WHERE state='AWAITING_TAP' ORDER BY gate_sent_at LIMIT ?`)
      .all(SWEEP_LIMIT) as Array<{ gate_session_id: string; account_id: string }>;
    let cancelled = 0;
    for (const row of rows) {
      if (this.transition(row, ['AWAITING_TAP'], 'CANCELLED', 'cancelled', { code: FOLLOW_GATE_RETIRED_CODE })) cancelled++;
    }
    return cancelled;
  }

  /** Processes at most `maxPerTick` due sessions sequentially. Returns how many sessions were looked at. */
  async processDue(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    this.calls = 0;
    try {
      if (!followGateAvailable(this.options.followGateAvailable)) {
        this.cancelRetired();
        return 0;
      }
      this.expireStale();
      if (this.readDryRun() || !this.provider.findUserTap || !this.provider.sendMessage) return 0;
      const nowIso = new Date(this.clock()).toISOString();
      const rows = this.database.prepare(`SELECT g.gate_session_id, g.account_id, g.automation_id, g.igsid, g.state, g.gate_sent_at,
          g.tap_message_id, g.tap_at, g.window_expires_at, g.send_attempts, g.button_title, g.resource_payload_json,
          g.resource_attachment_kind, g.resource_attachment_url, s.connection_id, s.provider_account_id, s.username
        FROM gate_sessions g
        JOIN social_accounts s ON s.account_id=g.account_id
        JOIN connections c ON c.id=s.connection_id
        WHERE g.state='AWAITING_TAP' AND g.next_poll_at IS NOT NULL AND g.next_poll_at<=?
          AND s.status='valid' AND s.monitoring_paused=0 AND c.status='valid' AND c.monitoring_paused=0 AND c.deleted_at IS NULL
        ORDER BY g.next_poll_at, g.gate_session_id LIMIT ?`)
        .all(nowIso, Math.max(0, this.options.maxPerTick ?? GATE_MAX_SESSIONS_PER_TICK)) as SessionRow[];
      for (const row of rows) await this.processSession(row);
      return rows.length;
    } finally {
      this.running = false;
    }
  }

  private async processSession(row: SessionRow): Promise<void> {
    const account: AccountRef = {
      accountId: row.account_id, connectionId: row.connection_id, providerAccountId: row.provider_account_id, username: row.username,
    };
    if (!row.igsid) {
      this.transition(row, ['AWAITING_TAP'], 'FAILED', 'poll_error', { code: 'igsid_unknown' });
      return;
    }
    let current = row;
    if (!row.tap_message_id) {
      await this.pace();
      let result: TapResult;
      try {
        result = await this.provider.findUserTap!(account, row.igsid, { afterIso: row.gate_sent_at, titleNormalized: normalizeTapText(row.button_title) });
      } catch {
        result = { found: false, pollError: 'provider_exception' };
      }
      const now = this.clock();
      const sentAt = Date.parse(row.gate_sent_at);
      if (result.pollError) {
        const code = /^[a-z][a-z0-9_]{1,63}$/u.test(result.pollError) ? result.pollError : 'poll_error';
        const delay = Math.max(GATE_POLL_ERROR_MIN_DELAY_MS, nextGatePollDelay(sentAt, now));
        this.recordPoll(row, now + delay, code);
        return;
      }
      const tapId = typeof result.tapMessageId === 'string' && /^[A-Za-z0-9_\-=.:]{1,256}$/u.test(result.tapMessageId) ? result.tapMessageId : undefined;
      if (!result.found || !tapId) {
        this.recordPoll(row, now + nextGatePollDelay(sentAt, now));
        return;
      }
      const reported = Date.parse(result.tapAt ?? '');
      // The 24 h window counts from the user's message; an unusable or future time is replaced by the detection time.
      const tapAt = Number.isFinite(reported) && reported <= now ? reported : now;
      if (!this.recordTap(row, tapId, tapAt, now)) return;
      current = { ...row, tap_message_id: tapId, tap_at: new Date(tapAt).toISOString(), window_expires_at: new Date(tapAt + GATE_RESOURCE_WINDOW_MS).toISOString() };
    }
    await this.sendResource(current, account);
  }

  private async sendResource(row: SessionRow, account: AccountRef): Promise<void> {
    const now = this.clock();
    if (!(now < Date.parse(row.window_expires_at ?? ''))) {
      this.transition(row, ['AWAITING_TAP'], 'EXPIRED', 'expired', { code: 'resource_window_elapsed' });
      return;
    }
    if (!this.automationActive(row)) {
      this.transition(row, ['AWAITING_TAP'], 'CANCELLED', 'cancelled', { code: 'automation_inactive' });
      return;
    }
    let payload: DirectMessagePayload;
    try {
      payload = JSON.parse(row.resource_payload_json) as DirectMessagePayload;
    } catch {
      this.transition(row, ['AWAITING_TAP'], 'FAILED', 'resource_rejected', { code: 'resource_snapshot_invalid' });
      return;
    }
    const kind = row.resource_attachment_kind ?? '';
    if (kind !== '') {
      const attachment = storedResourceAttachment(kind, row.resource_attachment_url);
      if (!attachment) {
        this.transition(row, ['AWAITING_TAP'], 'FAILED', 'resource_rejected', { code: 'resource_snapshot_invalid' });
        return;
      }
      await this.sendWithAttachment(row, account, payload, attachment);
      return;
    }
    const result = await this.postGuarded(row, account, undefined, { text: payload.text, buttons: payload.buttons });
    if (!result) {
      this.defer(row, now);
      return;
    }
    this.recordOutcome(row, result);
  }

  /**
   * Two follow-ups: the attachment (once), then the text + buttons. Re-entrant: each call resumes from the recorded part
   * state, so a crash or a deferral between the parts never resends an accepted or skipped attachment.
   */
  private async sendWithAttachment(row: SessionRow, account: AccountRef, payload: DirectMessagePayload, attachment: ResourceAttachment): Promise<void> {
    let first = this.partStatus(row.gate_session_id, 'attachment');
    if (first.status === 'sending' || first.status === 'ambiguous') {
      // Never reachable through the engine (the intent and RESOURCE_SENDING commit together); fail closed.
      this.transition(row, ['AWAITING_TAP'], 'UNKNOWN_OUTCOME', 'resource_ambiguous', { code: 'attachment_state_inconsistent', details: { part: 'attachment' } });
      return;
    }
    if (first.status === 'pending') {
      const result = await this.postGuarded(row, account, 'attachment', { attachment: { kind: attachment.kind, url: attachment.url } });
      if (!result) {
        this.defer(row, this.clock());
        return;
      }
      if (!this.recordOutcome(row, result, 'attachment')) return;
      first = this.partStatus(row.gate_session_id, 'attachment');
      if (first.status !== 'accepted' && first.status !== 'skipped') return;
    }
    // Minimum spacing between the two messages, measured with the (injectable) clock from the attachment outcome.
    const readyAt = (first.doneAt ?? 0) + Math.max(GATE_PART_SPACING_MS, this.options.spacingMs ?? 0);
    const wait = readyAt - this.clock();
    if (wait > 0) await (this.options.sleep ?? defaultSleep)(wait);
    if (this.clock() < readyAt) {
      this.database.prepare(`UPDATE gate_sessions SET next_poll_at=?, updated_at=? WHERE gate_session_id=? AND state='AWAITING_TAP'`)
        .run(new Date(readyAt).toISOString(), new Date(this.clock()).toISOString(), row.gate_session_id);
      return;
    }
    const result = await this.postGuarded(row, account, 'text', { text: payload.text, buttons: payload.buttons });
    if (!result) {
      this.defer(row, this.clock());
      return;
    }
    this.recordOutcome(row, result, 'text');
  }

  /** Durable intent, then the POST, under the shared legacy interlock. Null when the send is not allowed right now. */
  private async postGuarded(row: SessionRow, account: AccountRef, part: Part | undefined,
    message: DirectMessagePayload | DirectAttachmentPayload): Promise<SendResult | null> {
    const post = async (): Promise<SendResult | null> => {
      if (!this.recordIntent(row, part)) return null;
      await this.pace();
      try {
        return await this.provider.sendMessage!(account, row.igsid!, message);
      } catch {
        return { outcome: 'ambiguous', safeErrorCode: 'provider_exception' };
      }
    };
    const interlock = this.options.legacyInterlock;
    if (!interlock) return post();
    if (!legacyAcknowledged(this.database, interlock, row.account_id, row.username)) return null;
    try {
      return await interlock.withExclusiveLock(row.username, async () => {
        if (!legacyAcknowledged(this.database, interlock, row.account_id, row.username, true)) return null;
        return post();
      });
    } catch {
      return null;
    }
  }

  /**
   * Records the outcome of the in-flight send (state RESOURCE_SENDING). Without `part`, the historic single-message
   * rules. With a part, the same rules plus the part log; an attachment that is accepted or definitively rejected
   * returns the session to AWAITING_TAP (tap kept) so the text follows. Returns true when the session may continue.
   */
  private recordOutcome(row: SessionRow, result: SendResult, part?: Part): boolean {
    const details = { httpStatus: result.httpStatus, usageHeaders: result.usageHeaders };
    const tag = part ? { part } : {};
    const messageId = result.messageId?.trim();
    const now = this.clock();
    if (result.outcome === 'accepted' && messageId) {
      if (part === 'attachment') {
        return this.transition(row, ['RESOURCE_SENDING'], 'AWAITING_TAP', null, {
          set: { next_poll_at: new Date(now + GATE_PART_SPACING_MS).toISOString() }, part: { part, event: 'accepted', messageId },
        });
      }
      const warning: Record<string, string> = part === 'text' && this.partStatus(row.gate_session_id, 'attachment').status === 'skipped'
        ? { last_error_code: 'attachment_failed' } : {};
      this.transition(row, ['RESOURCE_SENDING'], 'COMPLETED', 'resource_accepted', { messageId, details: { ...details, ...tag },
        set: { resource_message_id: messageId, ...warning }, ...(part ? { part: { part, event: 'accepted', messageId } } : {}) });
      return false;
    }
    if (result.outcome !== 'definitive_rejection') {
      const code = result.outcome === 'accepted' ? 'accepted_without_message_id' : safeCode(result.safeErrorCode, 'ambiguous_provider_result');
      this.transition(row, ['RESOURCE_SENDING'], 'UNKNOWN_OUTCOME', 'resource_ambiguous', { code, details: { ...details, ...tag },
        ...(part ? { part: { part, event: 'ambiguous', code } } : {}) });
      return false;
    }
    const code = safeCode(result.safeErrorCode, 'provider_rejection');
    const rateLimited = result.httpStatus === 429 || (result.metaCode !== undefined && RATE_LIMIT_CODES.has(result.metaCode));
    // Attempts are counted per part for sessions with an attachment (an attachment retry never uses the text budget).
    const attempts = part ? this.partStatus(row.gate_session_id, part).attempts
      : (this.database.prepare(`SELECT send_attempts FROM gate_sessions WHERE gate_session_id=?`).get(row.gate_session_id) as
        { send_attempts: number } | undefined)?.send_attempts ?? GATE_MAX_SEND_ATTEMPTS;
    if (!rateLimited || attempts >= GATE_MAX_SEND_ATTEMPTS) {
      if (part === 'attachment') {
        // Bad URL/format/size/permission (or throttling that never cleared): skip the media, still deliver the text.
        return this.transition(row, ['RESOURCE_SENDING'], 'AWAITING_TAP', null, {
          set: { next_poll_at: new Date(now + GATE_PART_SPACING_MS).toISOString() },
          part: { part, event: 'rejected', code, details }, skip: { part, event: 'skipped', code: 'attachment_failed' },
        });
      }
      this.transition(row, ['RESOURCE_SENDING'], 'FAILED', 'resource_rejected', { code, details: { ...details, ...tag },
        ...(part ? { part: { part, event: 'rejected', code, details } } : {}) });
      return false;
    }
    // Provably unsent throttling: retry the failing SEND only (the tap stays recorded), never sooner than Retry-After.
    const retryAt = now + retryDelay(result.usageHeaders?.retryAfter, attempts, now);
    if (retryAt >= Date.parse(row.window_expires_at ?? '')) {
      this.transition(row, ['RESOURCE_SENDING'], 'EXPIRED', 'resource_rejected', { code, details: { ...details, ...tag, expired: true },
        set: { last_error_code: 'resource_window_elapsed' }, ...(part ? { part: { part, event: 'rejected', code, details: { expired: true } } } : {}) });
      return false;
    }
    const retryIso = new Date(retryAt).toISOString();
    if (part === 'attachment') {
      this.transition(row, ['RESOURCE_SENDING'], 'AWAITING_TAP', null, { code, set: { next_poll_at: retryIso },
        part: { part, event: 'rejected', code, details: { ...details, retryAt: retryIso } } });
      return false;
    }
    this.transition(row, ['RESOURCE_SENDING'], 'AWAITING_TAP', 'resource_rejected', { code, details: { ...details, ...tag, retryAt: retryIso },
      set: { next_poll_at: retryIso }, ...(part ? { part: { part, event: 'rejected', code, details: { ...details, retryAt: retryIso } } } : {}) });
    return false;
  }

  /** Current state of one part, derived from its append-only events (accepted/skipped/ambiguous are final). */
  private partStatus(sessionId: string, part: Part): PartStatus {
    const rows = this.database.prepare(`SELECT event_type, event_at FROM gate_part_events WHERE gate_session_id=? AND part=? ORDER BY rowid`)
      .all(sessionId, part) as Array<{ event_type: PartEvent; event_at: string }>;
    const attempts = rows.filter((entry) => entry.event_type === 'intent_recorded').length;
    const final = rows.find((entry) => entry.event_type === 'accepted' || entry.event_type === 'skipped' || entry.event_type === 'ambiguous');
    if (final) return { status: final.event_type as 'accepted' | 'skipped' | 'ambiguous', attempts, doneAt: Date.parse(final.event_at) };
    return { status: rows.at(-1)?.event_type === 'intent_recorded' ? 'sending' : 'pending', attempts };
  }

  /** Records the first tap (expected state, no tap yet). False when the session changed or the tap id is already used. */
  private recordTap(row: SessionRow, tapId: string, tapAt: number, now: number): boolean {
    const nowIso = new Date(now).toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const used = this.database.prepare(`SELECT 1 FROM gate_sessions WHERE tap_message_id=?`).get(tapId);
      if (used) {
        this.database.prepare(`UPDATE gate_sessions SET poll_count=poll_count+1, last_error_code='tap_already_used', next_poll_at=?, updated_at=?
          WHERE gate_session_id=? AND state='AWAITING_TAP' AND tap_message_id IS NULL`)
          .run(new Date(now + nextGatePollDelay(Date.parse(row.gate_sent_at), now)).toISOString(), nowIso, row.gate_session_id);
        this.database.exec('COMMIT');
        return false;
      }
      const updated = this.database.prepare(`UPDATE gate_sessions SET tap_message_id=?, tap_at=?, window_expires_at=?, poll_count=poll_count+1,
          last_error_code=NULL, next_poll_at=?, updated_at=?
        WHERE gate_session_id=? AND state='AWAITING_TAP' AND tap_message_id IS NULL`)
        .run(tapId, new Date(tapAt).toISOString(), new Date(tapAt + GATE_RESOURCE_WINDOW_MS).toISOString(), nowIso, nowIso, row.gate_session_id);
      if (Number(updated.changes) !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.appendEvent(row, 'tap_detected', now, { messageId: tapId });
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Durable intent (RESOURCE_SENDING + attempt + event) committed before the POST, with every send guard in SQL. For a
   * part of an attachment session the SQL also guarantees: the attachment only while it has no final outcome; the text
   * only after the attachment was accepted or skipped and while the text itself has no final outcome.
   */
  private recordIntent(row: SessionRow, part?: Part): boolean {
    const now = this.clock();
    const nowIso = new Date(now).toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.database.prepare(`UPDATE gate_sessions SET state='RESOURCE_SENDING', send_attempts=send_attempts+1, next_poll_at=NULL, updated_at=?
        WHERE gate_session_id=? AND account_id=? AND state='AWAITING_TAP' AND tap_message_id IS NOT NULL AND window_expires_at>?
          AND EXISTS (SELECT 1 FROM app_state WHERE state_key='dry_run' AND state_value='false')
          AND EXISTS (SELECT 1 FROM automations a WHERE a.automation_id=? AND a.account_id=? AND a.status='enabled' AND a.real_enabled=1
            AND a.name NOT LIKE '% (archived)')
          AND EXISTS (SELECT 1 FROM social_accounts s WHERE s.account_id=? AND s.connection_id=? AND s.provider_account_id=?
            AND s.status='valid' AND s.monitoring_paused=0)
          AND EXISTS (SELECT 1 FROM connections c WHERE c.id=? AND c.status='valid' AND c.monitoring_paused=0 AND c.deleted_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM account_send_holds h WHERE h.account_id=?)
          AND NOT EXISTS (SELECT 1 FROM gate_sessions other WHERE other.state='RESOURCE_SENDING' AND other.gate_session_id<>?)
          AND NOT EXISTS (SELECT 1 FROM queue_items active WHERE active.account_id=? AND (active.state='SENDING' OR active.public_reply_state='SENDING'))
          ${part ? PART_GUARDS[part] : ''}`)
        .run(nowIso, row.gate_session_id, row.account_id, nowIso, row.automation_id, row.account_id, row.account_id, row.connection_id,
          row.provider_account_id, row.connection_id, row.account_id, row.gate_session_id, row.account_id, ...(part ? [row.gate_session_id] : []),
          ...(part === 'text' ? [row.gate_session_id] : []));
      if (Number(updated.changes) !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.appendEvent(row, 'resource_intent_recorded', now, part ? { details: { part } } : {});
      if (part) this.appendPartEvent(row, { part, event: 'intent_recorded' }, now);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private automationActive(row: SessionRow): boolean {
    const automation = this.database.prepare(`SELECT status, real_enabled, name FROM automations WHERE account_id=? AND automation_id=?`)
      .get(row.account_id, row.automation_id) as { status: string; real_enabled: number; name: string } | undefined;
    return Boolean(automation && automation.status === 'enabled' && automation.real_enabled === 1 && !automation.name.endsWith(' (archived)'));
  }

  /** Not sent now for a transient reason (spacing, hold, lock, concurrent send): look again later, state unchanged. */
  private defer(row: SessionRow, now: number): void {
    this.database.prepare(`UPDATE gate_sessions SET next_poll_at=?, updated_at=? WHERE gate_session_id=? AND state='AWAITING_TAP'`)
      .run(new Date(now + DEFER_MS).toISOString(), new Date(now).toISOString(), row.gate_session_id);
  }

  private recordPoll(row: SessionRow, nextAt: number, errorCode?: string): void {
    const now = this.clock();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.database.prepare(`UPDATE gate_sessions SET poll_count=poll_count+1, next_poll_at=?, last_error_code=?, updated_at=?
        WHERE gate_session_id=? AND state='AWAITING_TAP' AND tap_message_id IS NULL`)
        .run(new Date(nextAt).toISOString(), errorCode ?? null, new Date(now).toISOString(), row.gate_session_id);
      if (errorCode && Number(updated.changes) === 1) this.appendEvent(row, 'poll_error', now, { code: errorCode });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Expected-state transition plus its append-only events, in one transaction: the session event (when given) and, for
   * a part of an attachment session, the part event(s) (`skip` adds a second one, e.g. rejected then skipped).
   */
  private transition(
    row: { gate_session_id: string; account_id: string },
    expected: GateState[],
    next: GateState,
    event: GateEvent | null,
    extra: { code?: string; messageId?: string; details?: Record<string, unknown>; set?: Record<string, string | null>;
      part?: PartRecord; skip?: PartRecord } = {},
  ): boolean {
    const now = this.clock();
    const nowIso = new Date(now).toISOString();
    const set = { last_error_code: extra.code ?? null, ...(next === 'AWAITING_TAP' ? {} : { next_poll_at: null }), ...extra.set };
    const columns = Object.keys(set).filter((key) => /^[a-z_]+$/u.test(key));
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.database.prepare(`UPDATE gate_sessions SET state=?, ${columns.map((key) => `${key}=?`).join(', ')}, updated_at=?
        WHERE gate_session_id=? AND account_id=? AND state IN (${expected.map(() => '?').join(',')})`)
        .run(next, ...columns.map((key) => (set as Record<string, string | null>)[key] ?? null), nowIso, row.gate_session_id, row.account_id, ...expected);
      if (Number(updated.changes) !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      if (event) this.appendEvent(row, event, now, extra);
      if (extra.part) this.appendPartEvent(row, extra.part, now);
      if (extra.skip) this.appendPartEvent(row, extra.skip, now);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private appendPartEvent(row: { gate_session_id: string; account_id: string }, record: PartRecord, at: number): void {
    this.database.prepare(`INSERT INTO gate_part_events (gate_part_event_id, account_id, gate_session_id, part, event_type, event_at, message_id,
        safe_error_code, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), row.account_id, row.gate_session_id, record.part, record.event, new Date(at).toISOString(), record.messageId ?? null,
        record.code ?? null, JSON.stringify(record.details ?? {}));
  }

  private appendEvent(row: { gate_session_id: string; account_id: string }, event: GateEvent, at: number,
    extra: { code?: string; messageId?: string; details?: Record<string, unknown> }): void {
    this.database.prepare(`INSERT INTO gate_events (gate_event_id, account_id, gate_session_id, event_type, event_at, message_id, safe_error_code, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), row.account_id, row.gate_session_id, event, new Date(at).toISOString(), extra.messageId ?? null, extra.code ?? null,
        JSON.stringify(extra.details ?? {}));
  }

  /** Global spacing between consecutive Meta calls of one tick (the provider spaces its own internal reads). */
  private async pace(): Promise<void> {
    if (this.calls++ === 0) return;
    const spacing = Math.max(0, this.options.spacingMs ?? GATE_SPACING_MS);
    if (spacing > 0) await (this.options.sleep ?? defaultSleep)(spacing);
  }

  private readDryRun(): boolean {
    const row = this.database.prepare(`SELECT state_value FROM app_state WHERE state_key='dry_run'`).get() as { state_value: string } | undefined;
    return row?.state_value !== 'false';
  }

  private clock(): number {
    return this.options.clock?.() ?? Date.now();
  }
}

/** Extra SQL guards of a part intent (session id bound once per NOT EXISTS / EXISTS, in this order). */
const PART_GUARDS: Record<Part, string> = {
  attachment: `AND NOT EXISTS (SELECT 1 FROM gate_part_events p WHERE p.gate_session_id=? AND p.part='attachment'
    AND p.event_type IN ('accepted','skipped','ambiguous'))`,
  text: `AND EXISTS (SELECT 1 FROM gate_part_events p WHERE p.gate_session_id=? AND p.part='attachment' AND p.event_type IN ('accepted','skipped'))
    AND NOT EXISTS (SELECT 1 FROM gate_part_events p WHERE p.gate_session_id=? AND p.part='text' AND p.event_type IN ('accepted','ambiguous'))`,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeCode(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{1,63}$/u.test(value) ? value : fallback;
}

function retryDelay(retryAfter: string | undefined, attempts: number, now: number): number {
  if (typeof retryAfter === 'string') {
    const delay = /^\d{1,6}$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(delay) && delay > 0) return delay;
  }
  return Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempts - 1)));
}
