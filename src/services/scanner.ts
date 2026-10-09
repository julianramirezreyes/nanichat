import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AccountRef, ProviderComment, SocialProvider } from '../core/domain.ts';
import { claimingAutomations, classifyComment, ownerRepliedParentIds } from './automations.ts';
import { getSettings } from './moderation.ts';
import { classifyForModeration } from './moderation-rules.ts';

export type ScanKind = 'monitor' | 'catch_up' | 'backlog';
export type ScanCandidate = { commentId: string; automationId: string; eligible: boolean; reason: string; matchedKeywords: string[] };
export type ScanReport = {
  scanId: string;
  accountId: string;
  mediaId: string;
  kind: ScanKind;
  status: 'complete' | 'incomplete' | 'cancelled';
  pagesRead: number;
  commentsSeen: number;
  /** Distinct comments classified as past the private-reply window (too old to answer). */
  expiredCount: number;
  stopReason?: string;
  candidates: ScanCandidate[];
};

type AutomationRow = {
  automation_id: string;
  account_id: string;
  media_id: string | null;
  status: string;
  match_mode: 'exact' | 'contains';
  monitoring_started_at: string | null;
};

export class Scanner {
  constructor(private readonly database: DatabaseSync, private readonly provider: Pick<SocialProvider, 'listComments'>) {}

  async scanMedia(
    account: AccountRef,
    mediaId: string,
    options: {
      kind: ScanKind;
      cutoffAt?: string;
      untilAt?: string;
      now?: number;
      signal?: AbortSignal;
      monitoringAutomationId?: string;
      /** Called after each provider page with the number of newly seen distinct comments. Observational only. */
      onPage?: (update: { newComments: number }) => void;
    },
  ): Promise<ScanReport> {
    const owner = this.database.prepare(`SELECT username, connection_id, provider_account_id, status
      FROM social_accounts WHERE account_id=?`).get(account.accountId) as {
      username: string; connection_id: string; provider_account_id: string; status: string;
    } | undefined;
    const media = this.database.prepare(`SELECT 1 FROM media WHERE account_id=? AND media_id=?`).get(account.accountId, mediaId);
    if (!owner || !media || owner.connection_id !== account.connectionId || owner.provider_account_id !== account.providerAccountId) {
      throw new Error('Account or media is not owned by the selected account reference');
    }
    if (owner.status !== 'valid') throw new Error('Account is not validated');
    if (options.kind === 'monitor' && (!options.cutoffAt || !Number.isFinite(Date.parse(options.cutoffAt)))) {
      throw new TypeError('Monitoring requires an explicit valid cutoff');
    }
    const scanId = randomUUID();
    const startedAt = new Date().toISOString();
    this.database.prepare(`INSERT INTO scan_runs
      (scan_id, account_id, media_id, scan_kind, status, cutoff_at, started_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?)`)
      .run(scanId, account.accountId, mediaId, options.kind, options.cutoffAt ?? null, startedAt);
    this.writeCheckpoint(account.accountId, mediaId, scanId, {
      scanId, kind: options.kind, status: 'running', cursor: null, pagesRead: 0, commentsSeen: 0,
    });

    if (options.cutoffAt && !Number.isFinite(Date.parse(options.cutoffAt))) throw new TypeError('Scan start must be a valid timestamp');
    if (options.untilAt && !Number.isFinite(Date.parse(options.untilAt))) throw new TypeError('Scan end must be a valid timestamp');
    if (options.cutoffAt && options.untilAt && Date.parse(options.cutoffAt) > Date.parse(options.untilAt)) {
      throw new TypeError('Scan interval start must not be after its end');
    }
    // Precedence: media-specific automations claim their media; a general (account) automation only claims media
    // without an enabled specific one. A monitor scan only classifies for the automation being monitored.
    const automations: AutomationRow[] = claimingAutomations(this.database, account.accountId, mediaId)
      .filter((automation) => !options.monitoringAutomationId || automation.automation_id === options.monitoringAutomationId);
    const keywordQuery = this.database.prepare(`SELECT phrase FROM automation_keywords
      WHERE account_id=? AND automation_id=? ORDER BY rowid`);
    const cursors = new Set<string>();
    const seen = new Set<string>();
    const candidates: ScanCandidate[] = [];
    const expiredIds = new Set<string>();
    let cursor: string | undefined;
    let checkpointCursor: string | null = null;
    let monitorCursor: string | undefined;
    const monitorCheckpointKey = options.kind === 'monitor' && options.monitoringAutomationId
      ? `monitor:${options.monitoringAutomationId}` : undefined;
    if (monitorCheckpointKey) {
      const saved = this.database.prepare(`SELECT value_json FROM checkpoints WHERE account_id=? AND media_id=? AND checkpoint_key=?`)
        .get(account.accountId, mediaId, monitorCheckpointKey) as { value_json: string } | undefined;
      if (saved) {
        try {
          const checkpoint = JSON.parse(saved.value_json) as { cutoffAt?: unknown; cursor?: unknown };
          if (checkpoint.cutoffAt === options.cutoffAt && typeof checkpoint.cursor === 'string' && checkpoint.cursor) {
            monitorCursor = checkpoint.cursor;
          }
        } catch {
          monitorCursor = undefined;
        }
      }
    }
    const persistedIds: string[] = [];
    let complete = false;
    let stopReason: string | undefined;
    let pagesRead = 0;
    let firstMonitorPageRead = false;

    // Classification runs after every page is persisted so replies seen anywhere in this scan (any page order) count.
    const classifyPersisted = (): void => {
      const ownerReplied = ownerRepliedParentIds(this.database, account.accountId, mediaId, owner.username);
      for (const commentId of persistedIds) {
        const commentRow = this.database.prepare(`SELECT text, username, created_at, parent_id FROM comments
          WHERE account_id=? AND comment_id=?`).get(account.accountId, commentId) as {
          text: string | null; username: string | null; created_at: string | null; parent_id: string | null;
        };
        const eligibleRows: ScanCandidate[] = [];
        for (const automation of automations) {
          const phrases = keywordQuery.all(account.accountId, automation.automation_id) as Array<{ phrase: string }>;
          const classification = classifyComment({
            commentId,
            text: commentRow.text ?? undefined,
            username: commentRow.username ?? undefined,
            createdAt: commentRow.created_at ?? undefined,
            parentId: commentRow.parent_id ?? undefined,
          }, phrases.map((item) => item.phrase), owner.username, options.now ?? Date.now(), automation.match_mode, ownerReplied.has(commentId));
          if (classification.reason === 'expired') expiredIds.add(commentId);
          const automationCutoff = options.kind === 'monitor'
            ? automation.monitoring_started_at ?? options.cutoffAt
            : options.cutoffAt;
          const timestamp = Date.parse(commentRow.created_at ?? '');
          const beforeCutoff = Boolean(automationCutoff && Number.isFinite(timestamp) && timestamp < Date.parse(automationCutoff));
          const afterCutoff = Boolean(options.untilAt && Number.isFinite(timestamp) && timestamp > Date.parse(options.untilAt));
          const result = beforeCutoff || afterCutoff ? 'review' : classification.eligible ? 'eligible' : 'review';
          const reason = beforeCutoff ? (options.kind === 'monitor' ? 'before_monitor_cutoff' : 'before_scan_window')
            : afterCutoff ? 'after_scan_window' : classification.reason;
          this.database.prepare(`INSERT INTO comment_classifications
            (account_id, comment_id, automation_id, result, reason, matched_keywords_json, observed_at, scan_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, comment_id, automation_id) DO UPDATE SET result=excluded.result,
              reason=excluded.reason, matched_keywords_json=excluded.matched_keywords_json, observed_at=excluded.observed_at,
              scan_id=excluded.scan_id`)
            .run(account.accountId, commentId, automation.automation_id, result, reason,
              JSON.stringify(classification.matchedKeywords), new Date().toISOString(), scanId);
          if (classification.eligible && !beforeCutoff && !afterCutoff) {
            eligibleRows.push({ commentId, automationId: automation.automation_id,
              eligible: true, reason, matchedKeywords: classification.matchedKeywords });
          } else {
            candidates.push({ commentId, automationId: automation.automation_id,
              eligible: false, reason, matchedKeywords: classification.matchedKeywords });
          }
        }
        if (eligibleRows.length > 1) {
          this.database.prepare(`UPDATE comment_classifications SET result='review', reason='multiple_automation_matches', observed_at=?
            WHERE account_id=? AND comment_id=? AND automation_id IN (${eligibleRows.map(() => '?').join(',')})`)
            .run(new Date().toISOString(), account.accountId, commentId, ...eligibleRows.map((item) => item.automationId));
          candidates.push(...eligibleRows.map((item) => ({ ...item, eligible: false, reason: 'multiple_automation_matches' })));
        } else {
          candidates.push(...eligibleRows);
        }
      }
    };

    for (let request = 0; request < (options.kind === 'monitor' ? 2 : 100); request++) {
      if (options.signal?.aborted) {
        stopReason = 'scan_cancelled';
        break;
      }
      if (options.kind === 'monitor') {
        if (firstMonitorPageRead) {
          cursor = monitorCursor;
          if (!cursor) {
            complete = true;
            break;
          }
          if (cursors.has(cursor)) {
            monitorCursor = undefined;
            stopReason = 'cursor_loop';
            break;
          }
          cursors.add(cursor);
        } else {
          cursor = undefined;
        }
      }
      let page;
      try {
        page = await this.provider.listComments(account, mediaId, cursor);
      } catch {
        stopReason = 'provider_error';
        if (options.kind === 'monitor' && cursor) monitorCursor = undefined;
        break;
      }
      if (options.signal?.aborted) {
        stopReason = 'scan_cancelled';
        break;
      }
      pagesRead++;
      const seenBefore = seen.size;
      const previousMonitorCursor = monitorCursor;
      if (options.kind === 'monitor' && !firstMonitorPageRead) firstMonitorPageRead = true;
      for (const comment of page.items) {
        if (!comment.commentId || seen.has(comment.commentId)) continue;
        seen.add(comment.commentId);
        this.upsertComment(account.accountId, mediaId, comment);
        persistedIds.push(comment.commentId);
      }
      options.onPage?.({ newComments: seen.size - seenBefore });
      this.writeCheckpoint(account.accountId, mediaId, scanId, {
        scanId,
        kind: options.kind,
        status: 'running',
        cursor: page.nextCursor ?? null,
        pagesRead,
        commentsSeen: seen.size,
      });
      checkpointCursor = page.nextCursor ?? null;
      if (page.complete) {
        if (page.nextCursor) {
          stopReason = 'provider_marked_complete_with_cursor';
          break;
        }
        checkpointCursor = null;
        complete = true;
        if (monitorCheckpointKey) monitorCursor = undefined;
        break;
      }
      if (options.kind === 'monitor') {
        const nextMonitorCursor = firstMonitorPageRead && request === 0
          ? previousMonitorCursor ?? page.nextCursor
          : page.nextCursor;
        if (!nextMonitorCursor) {
          stopReason = page.stopReason ?? 'incomplete_without_cursor';
          monitorCursor = undefined;
          break;
        }
        if (cursor && nextMonitorCursor === cursor) {
          stopReason = 'cursor_loop';
          monitorCursor = undefined;
          break;
        }
        monitorCursor = nextMonitorCursor;
        checkpointCursor = nextMonitorCursor;
        if (request === 0) continue;
        stopReason = 'monitor_page_bound';
        break;
      }
      if (!page.nextCursor || cursors.has(page.nextCursor)) {
        stopReason = page.stopReason ?? (page.nextCursor ? 'cursor_loop' : 'incomplete_without_cursor');
        break;
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    classifyPersisted();
    const modSettings = getSettings(this.database, account.accountId);
    if (modSettings.enabled) {
      for (const commentId of persistedIds) {
        const commentRow = this.database.prepare(`SELECT text, username FROM comments WHERE account_id=? AND comment_id=?`).get(account.accountId, commentId) as any;
        if (!commentRow) continue;
        const comment = { commentId, text: commentRow.text ?? undefined, username: commentRow.username ?? undefined };
        const classification = classifyForModeration(comment, owner.username, modSettings);
        if (classification.flagged) {
          const now = new Date().toISOString();
          this.database.prepare(`
            INSERT OR IGNORE INTO moderation_flags
            (flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(randomUUID(), account.accountId, mediaId ?? null, commentId, String(classification.category), 'rules', JSON.stringify(classification.reasons), 'PENDING', now, now, Number(modSettings.version ?? 1));
        }
      }
    }
    if (!complete && !stopReason) stopReason = 'scanner_page_limit';
    const finishedAt = new Date().toISOString();
    const status = stopReason === 'scan_cancelled' ? 'cancelled' : complete ? 'complete' : 'incomplete';
    this.database.prepare(`UPDATE scan_runs SET status=?, pages_read=?, comments_seen=?, stop_reason=?, finished_at=? WHERE scan_id=?`)
      .run(status, pagesRead, seen.size, stopReason ?? null, finishedAt, scanId);
    this.writeCheckpoint(account.accountId, mediaId, scanId, {
      scanId, kind: options.kind, status, cursor: checkpointCursor, pagesRead, commentsSeen: seen.size,
      ...(stopReason ? { stopReason } : {}), finishedAt,
    });
    if (monitorCheckpointKey) {
      this.writeCheckpoint(account.accountId, mediaId, monitorCheckpointKey, {
        kind: 'monitor', cutoffAt: options.cutoffAt, cursor: monitorCursor ?? null,
        status, stopReason: stopReason ?? null, updatedAt: finishedAt,
      }, monitorCheckpointKey);
    }
    return {
      scanId,
      accountId: account.accountId,
      mediaId,
      kind: options.kind,
      status,
      pagesRead,
      commentsSeen: seen.size,
      expiredCount: expiredIds.size,
      ...(stopReason ? { stopReason } : {}),
      candidates,
    };
  }

  private upsertComment(accountId: string, mediaId: string, comment: ProviderComment): void {
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO comments
      (account_id, media_id, comment_id, text, username, created_at, parent_id, first_seen_at, last_seen_at, author_igsid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, comment_id) DO UPDATE SET text=excluded.text, username=excluded.username,
        created_at=excluded.created_at, parent_id=excluded.parent_id, last_seen_at=excluded.last_seen_at,
        author_igsid=COALESCE(excluded.author_igsid, comments.author_igsid)`)
      .run(accountId, mediaId, comment.commentId, comment.text ?? null, comment.username ?? null,
        comment.createdAt ?? null, comment.parentId ?? null, now, now, comment.authorId ?? null);
  }

  private writeCheckpoint(accountId: string, mediaId: string, scanId: string, value: Record<string, unknown>, key = `scan:${scanId}`): void {
    this.database.prepare(`INSERT INTO checkpoints(account_id, media_id, checkpoint_key, value_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, media_id, checkpoint_key) DO UPDATE SET value_json=excluded.value_json,
        updated_at=excluded.updated_at`)
      .run(accountId, mediaId, key, JSON.stringify(value), new Date().toISOString());
  }
}

export type CatchUpWindow = '2h' | '24h' | '3d' | '7d' | 'custom';

export function getCatchUpCutoff(window: CatchUpWindow, now: number, customSince?: string): string {
  const durations: Record<Exclude<CatchUpWindow, 'custom'>, number> = {
    '2h': 2 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };
  if (window === 'custom') {
    const date = customSince ? Date.parse(customSince) : Number.NaN;
    if (!Number.isFinite(date) || date > now) throw new TypeError('Custom catch-up start must be a valid past date');
    return new Date(date).toISOString();
  }
  return new Date(now - durations[window]).toISOString();
}
