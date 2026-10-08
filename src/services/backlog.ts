import type { DatabaseSync } from 'node:sqlite';
import type { AccountRef } from '../core/domain.ts';
import { QueueService } from './queue.ts';
import { getCatchUpCutoff, type CatchUpWindow, Scanner } from './scanner.ts';

/** Account-scoped, secret-free scan progress aggregated across media and accounts. */
export class ScanProgress {
  private mediaDone = 0;
  private mediaTotal = 0;
  private pagesRead = 0;
  private commentsSeen = 0;
  private currentStartedAt: string | undefined;
  private readonly planned = new Set<string>();

  plan(accountId: string, mediaCount: number): void {
    if (this.planned.has(accountId)) return;
    this.planned.add(accountId);
    this.mediaTotal += mediaCount;
  }
  startMedia(): void { this.currentStartedAt = new Date().toISOString(); }
  page(newComments: number): void { this.pagesRead++; this.commentsSeen += newComments; }
  finishMedia(): void { this.mediaDone++; this.currentStartedAt = undefined; }
  snapshot(): { mediaDone: number; mediaTotal: number; pagesRead: number; commentsSeen: number; currentStartedAt?: string } {
    return {
      mediaDone: this.mediaDone, mediaTotal: this.mediaTotal, pagesRead: this.pagesRead, commentsSeen: this.commentsSeen,
      ...(this.currentStartedAt ? { currentStartedAt: this.currentStartedAt } : {}),
    };
  }
}

type ScanOptions = { window: CatchUpWindow; customSince?: string; now?: number; signal?: AbortSignal; progress?: ScanProgress };

export class BacklogService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly scanner: Scanner,
    private readonly queue: QueueService,
  ) {}

  async scan(account: AccountRef, options: ScanOptions) {
    const now = options.now ?? Date.now();
    const cutoffAt = getCatchUpCutoff(options.window, now, options.customSince);
    const media = this.database.prepare(`SELECT media_id FROM media WHERE account_id=? ORDER BY media_id`)
      .all(account.accountId) as Array<{ media_id: string }>;
    const reports = [];
    const progress = options.progress;
    progress?.plan(account.accountId, media.length);
    for (const item of media) {
      progress?.startMedia();
      reports.push(await this.scanner.scanMedia(account, item.media_id, {
        kind: 'backlog', cutoffAt, untilAt: new Date(now).toISOString(), now, signal: options.signal,
        onPage: progress ? ({ newComments }) => progress.page(newComments) : undefined,
      }));
      progress?.finishMedia();
    }
    const expiredCount = reports.reduce((sum, report) => sum + report.expiredCount, 0);
    return { accountId: account.accountId, cutoffAt, expiredCount, reports };
  }

  async scanAll(accounts: AccountRef[], options: ScanOptions) {
    const results = [];
    // Plan the aggregate total up front so the bar is determinate across accounts.
    for (const account of accounts) {
      const count = this.database.prepare(`SELECT COUNT(*) AS count FROM media WHERE account_id=?`).get(account.accountId) as { count: number };
      options.progress?.plan(account.accountId, count.count);
    }
    for (const account of accounts) {
      try {
        const result = await this.scan(account, options);
        const statuses = result.reports.map((report) => report.status);
        const status = statuses.includes('incomplete') ? 'incomplete'
            : statuses.includes('cancelled') ? 'cancelled' : 'complete';
        results.push({ accountId: account.accountId, status, result });
      } catch {
        results.push({ accountId: account.accountId, status: 'error' as const, safeErrorCode: 'account_scan_failed' });
      }
    }
    return results;
  }

  async processEligible(accountId: string, automationId: string, reviewedIds: string[]): Promise<string[]> {
    if (!reviewedIds.length) throw new TypeError('Select eligible comments explicitly before processing');
    // Provenance: every ID must be classified 'eligible' for this account+automation by a completed backlog/catch-up scan.
    const ids = [...new Set(reviewedIds)];
    const reviewed = this.database.prepare(`SELECT 1 FROM comment_classifications c
      JOIN scan_runs s ON s.scan_id = c.scan_id AND s.account_id = c.account_id
      WHERE c.account_id = ? AND c.automation_id = ? AND c.comment_id = ? AND c.result = 'eligible'
        AND s.status = 'complete' AND s.scan_kind IN ('backlog', 'catch_up')`);
    for (const commentId of ids) {
      if (!reviewed.get(accountId, automationId, commentId)) {
        throw new Error('Comment has not been reviewed as eligible by a completed backlog scan for this automation');
      }
    }
    return this.queue.enqueueReviewed(accountId, automationId, ids);
  }
}
