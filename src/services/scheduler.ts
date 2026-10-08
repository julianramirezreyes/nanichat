import type { DatabaseSync } from 'node:sqlite';
import type { AccountRef } from '../core/domain.ts';
import { QueueService } from './queue.ts';
import { Scanner } from './scanner.ts';

const DEFAULT_POLL_MS = 60_000;
const DEFAULT_SEND_SPACING_MS = 10_000;
/** General (account-wide) automations: refresh the account's publication list at most this often. */
export const GENERAL_MEDIA_REFRESH_MS = 5 * 60_000;
/** General automations: scan each covered publication at most this often. */
export const GENERAL_MEDIA_SCAN_INTERVAL_MS = 2 * 60_000;
/** General automations: hard cap of publication scans per scheduler tick (across all accounts), so a tick cannot burst. */
export const GENERAL_MAX_MEDIA_SCANS_PER_TICK = 25;

type MonitorRow = {
  automation_id: string; account_id: string; media_id: string | null; scope: 'media' | 'account'; monitoring_started_at: string;
  connection_id: string; provider_account_id: string; username: string;
};

export type SchedulerOptions = {
  pollIntervalMs?: number;
  sendSpacingMs?: number;
  /** Clock used for the general-automation cadence (injectable for tests). */
  clock?: () => number;
  /** Refreshes the account's publication list through the provider (ConnectionService.listMedia in production). */
  mediaRefresher?: { listMedia(accountId: string): Promise<unknown> };
  generalMediaRefreshMs?: number;
  generalMediaScanIntervalMs?: number;
  generalMaxMediaScansPerTick?: number;
};

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;
  // In-memory cadence state for general automations (reset on restart, which only means one earlier refresh/scan).
  private readonly lastMediaRefreshAt = new Map<string, number>();
  private readonly lastGeneralScanAt = new Map<string, number>();

  constructor(
    private readonly database: DatabaseSync,
    private readonly scanner: Scanner,
    private readonly queue: QueueService,
    private readonly options: SchedulerOptions = {},
  ) {
    this.setGlobalMonitor(false);
    this.database.prepare(`UPDATE social_accounts SET monitoring_paused=1`).run();
    this.queue.recoverInterrupted();
    this.queue.expireStale();
  }

  start(accountId: string): void {
    const row = this.database.prepare(`SELECT s.status AS account_status, c.status AS connection_status,
      c.deleted_at FROM social_accounts s JOIN connections c ON c.id=s.connection_id WHERE s.account_id=?`)
      .get(accountId) as { account_status: string; connection_status: string; deleted_at: string | null } | undefined;
    if (!row || row.account_status !== 'valid' || row.connection_status !== 'valid' || row.deleted_at) {
      throw new Error('Only a currently validated account can be monitored');
    }
    this.database.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id=?`).run(accountId);
    this.setGlobalMonitor(true);
    this.ensureTimer();
  }

  startAll(): void {
    this.database.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE status='valid'
      AND connection_id IN (SELECT id FROM connections WHERE status='valid' AND deleted_at IS NULL)`).run();
    this.setGlobalMonitor(true);
    this.ensureTimer();
  }

  stop(accountId: string): void {
    const result = this.database.prepare(`UPDATE social_accounts SET monitoring_paused=1 WHERE account_id=?`).run(accountId);
    if (Number(result.changes) !== 1) throw new Error('Account does not exist');
    const active = this.database.prepare(`SELECT 1 FROM social_accounts WHERE monitoring_paused=0 AND status='valid' LIMIT 1`).get();
    if (!active) this.stopTimerAndGlobal();
  }

  stopAll(): void {
    this.database.prepare(`UPDATE social_accounts SET monitoring_paused=1`).run();
    this.stopTimerAndGlobal();
  }

  status(): { enabled: boolean; accounts: Array<{ accountId: string; username: string; paused: boolean }> } {
    const enabled = this.database.prepare(`SELECT state_value FROM app_state WHERE state_key='monitoring_enabled'`).get() as { state_value: string } | undefined;
    const rows = this.database.prepare(`SELECT account_id AS accountId, username, monitoring_paused
      FROM social_accounts ORDER BY username, account_id`).all() as Array<{ accountId: string; username: string; monitoring_paused: number }>;
    return { enabled: enabled?.state_value === 'true', accounts: rows.map(({ monitoring_paused, ...row }) => ({ ...row, paused: monitoring_paused !== 0 })) };
  }

  async tick(): Promise<void> {
    if (this.scanning || !this.isGloballyEnabled()) return;
    this.scanning = true;
    try {
      this.queue.expireStale();
      const rows = this.database.prepare(`SELECT a.automation_id, a.account_id, a.media_id, a.scope, a.monitoring_started_at,
          s.connection_id, s.provider_account_id, s.username
        FROM automations a
        JOIN social_accounts s ON s.account_id=a.account_id
        JOIN connections c ON c.id=s.connection_id
        WHERE a.status='enabled' AND a.name NOT LIKE '% (archived)' AND a.monitoring_started_at IS NOT NULL
          AND s.status='valid' AND s.monitoring_paused=0 AND c.status='valid' AND c.monitoring_paused=0 AND c.deleted_at IS NULL
        ORDER BY a.account_id, a.scope DESC, a.automation_id`).all() as MonitorRow[];
      // Media-specific automations keep the per-tick cadence; general ones are rate-limited below.
      for (const row of rows) {
        if (row.scope !== 'media' || !row.media_id) continue;
        await this.monitorMedia(row, row.media_id);
      }
      let budget = Math.max(0, this.options.generalMaxMediaScansPerTick ?? GENERAL_MAX_MEDIA_SCANS_PER_TICK);
      for (const row of rows) {
        if (row.scope !== 'account') continue;
        budget = await this.monitorGeneral(row, budget);
      }
      if (!this.isDryRun() && this.sendSpacingElapsed()) {
        const before = this.database.prepare(`SELECT MAX(event_at) AS last_intent FROM send_attempts WHERE event_type='intent_recorded'`)
          .get() as { last_intent: string | null };
        await this.queue.processOne();
        const after = this.database.prepare(`SELECT MAX(event_at) AS last_intent FROM send_attempts WHERE event_type='intent_recorded'`)
          .get() as { last_intent: string | null };
        if (after.last_intent !== before.last_intent && after.last_intent) this.writeLastSend(after.last_intent);
      }
      // Public replies run strictly after the private step, at most one per tick, with their own spacing inside
      // QueueService (it also expires stale ones and never posts in Dry Run).
      await this.queue.processPublicReply();
    } finally {
      this.scanning = false;
    }
  }

  private account(row: MonitorRow): AccountRef {
    return { accountId: row.account_id, connectionId: row.connection_id, providerAccountId: row.provider_account_id, username: row.username };
  }

  /** One monitor scan (page one + bounded continuation) and enqueue of eligible comments; returns the scan stop reason. */
  private async monitorMedia(row: MonitorRow, mediaId: string): Promise<string | undefined> {
    try {
      const report = await this.scanner.scanMedia(this.account(row), mediaId, {
        kind: 'monitor', cutoffAt: row.monitoring_started_at, monitoringAutomationId: row.automation_id,
      });
      const eligible = [...new Set(report.candidates.filter((candidate) => candidate.eligible
        && candidate.automationId === row.automation_id).map((candidate) => candidate.commentId))];
      for (const commentId of eligible) {
        try {
          await this.queue.enqueueReviewed(row.account_id, row.automation_id, [commentId]);
        } catch {
          // A single stale or ambiguous comment must not stop other accounts from scanning.
        }
      }
      return report.stopReason;
    } catch {
      // Provider and account errors are isolated to this automation/account.
      return 'monitor_error';
    }
  }

  /**
   * General automation: refresh the account's publications at most every GENERAL_MEDIA_REFRESH_MS, then scan the
   * publications it covers (no enabled specific automation) that were not scanned for it in the last
   * GENERAL_MEDIA_SCAN_INTERVAL_MS, never-scanned first, spending at most `budget` scans. A provider error stops further
   * general scans of this account in this tick (conservative; the next due tick retries).
   */
  private async monitorGeneral(row: MonitorRow, budget: number): Promise<number> {
    const now = this.clock();
    const refreshEvery = this.options.generalMediaRefreshMs ?? GENERAL_MEDIA_REFRESH_MS;
    const scanEvery = this.options.generalMediaScanIntervalMs ?? GENERAL_MEDIA_SCAN_INTERVAL_MS;
    const lastRefresh = this.lastMediaRefreshAt.get(row.account_id);
    if (this.options.mediaRefresher && (lastRefresh === undefined || now - lastRefresh >= refreshEvery)) {
      // Recorded before the call so a failing refresh is not retried every tick.
      this.lastMediaRefreshAt.set(row.account_id, now);
      try {
        await this.options.mediaRefresher.listMedia(row.account_id);
      } catch {
        // Keep monitoring the publications already stored.
      }
    }
    if (budget <= 0) return budget;
    const media = this.database.prepare(`SELECT m.media_id FROM media m WHERE m.account_id=?
        AND NOT EXISTS (SELECT 1 FROM automations sp WHERE sp.account_id=m.account_id AND sp.scope='media'
          AND sp.media_id=m.media_id AND sp.status='enabled' AND sp.name NOT LIKE '% (archived)')
      ORDER BY m.published_at DESC, m.media_id`).all(row.account_id) as Array<{ media_id: string }>;
    const due = media
      .map((item) => ({ mediaId: item.media_id, last: this.lastGeneralScanAt.get(`${row.automation_id}:${item.media_id}`) }))
      .filter((item) => item.last === undefined || now - item.last >= scanEvery)
      .sort((a, b) => (a.last ?? Number.NEGATIVE_INFINITY) - (b.last ?? Number.NEGATIVE_INFINITY));
    for (const item of due) {
      if (budget <= 0) break;
      budget--;
      this.lastGeneralScanAt.set(`${row.automation_id}:${item.mediaId}`, now);
      const stopReason = await this.monitorMedia(row, item.mediaId);
      if (stopReason === 'provider_error' || stopReason === 'monitor_error') break;
    }
    return budget;
  }

  private clock(): number {
    return this.options.clock?.() ?? Date.now();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    const interval = Math.max(1000, this.options.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.timer = setInterval(() => { void this.tick(); }, interval);
    this.timer.unref?.();
  }

  private setGlobalMonitor(enabled: boolean): void {
    this.database.prepare(`INSERT INTO app_state(state_key, state_value, updated_at) VALUES ('monitoring_enabled', ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET state_value=excluded.state_value, updated_at=excluded.updated_at`)
      .run(enabled ? 'true' : 'false', new Date().toISOString());
  }

  private isGloballyEnabled(): boolean {
    const row = this.database.prepare(`SELECT state_value FROM app_state WHERE state_key='monitoring_enabled'`).get() as { state_value: string } | undefined;
    return row?.state_value === 'true';
  }

  private isDryRun(): boolean {
    const row = this.database.prepare(`SELECT state_value FROM app_state WHERE state_key='dry_run'`).get() as { state_value: string } | undefined;
    return row?.state_value !== 'false';
  }

  private sendSpacingElapsed(): boolean {
    const row = this.database.prepare(`SELECT state_value FROM app_state WHERE state_key='last_send_intent_at'`).get() as { state_value: string } | undefined;
    if (!row) return true;
    return Date.now() - Date.parse(row.state_value) >= Math.max(0, this.options.sendSpacingMs ?? DEFAULT_SEND_SPACING_MS);
  }

  private writeLastSend(value: string): void {
    this.database.prepare(`INSERT INTO app_state(state_key, state_value, updated_at) VALUES ('last_send_intent_at', ?, ?)
      ON CONFLICT(state_key) DO UPDATE SET state_value=excluded.state_value, updated_at=excluded.updated_at`)
      .run(value, new Date().toISOString());
  }

  private stopTimerAndGlobal(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.setGlobalMonitor(false);
  }
}
