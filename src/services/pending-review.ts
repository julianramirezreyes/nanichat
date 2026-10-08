import type { DatabaseSync } from 'node:sqlite';
import { claimsMediaSql, hasOwnerReply, isPastPrivateReplyWindow, renderReply } from './automations.ts';

export const COMMENT_PREVIEW_LIMIT = 280;
// Must stay identical to the provenance rule in BacklogService.processEligible.
export const REVIEWABLE_SCAN_KINDS = ['backlog', 'catch_up'] as const;

/** Collapses whitespace and bounds length so DTOs never carry unbounded comment bodies. */
export function truncateText(value: string | null | undefined, max = COMMENT_PREVIEW_LIMIT): string {
  const clean = (value ?? '').replace(/\s+/gu, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export type PendingReviewItem = {
  accountId: string; commentId: string; automationId: string; automationName: string;
  /** 'account' = general automation (applies to the comment's publication because it has no own automation). */
  scope: 'media' | 'account';
  /** The publication of the comment, with display-only metadata for a short label (caption/type/date). */
  mediaId: string; mediaCaption: string | null; mediaType: string | null; mediaPublishedAt: string | null; username: string;
  commentText: string; commentCreatedAt: string | null; matchedKeywords: string[]; analyzedAt: string | null;
  previewText: string | null; previewButtons: Array<{ title: string; url: string }>;
};

type Row = {
  comment_id: string; automation_id: string; automation_name: string; scope: 'media' | 'account'; media_id: string; reply_text: string;
  buttons_json: string; permalink: string | null; caption: string | null; media_type: string | null; published_at: string | null; author: string | null; text: string | null; comment_created_at: string | null;
  matched_keywords_json: string; analyzed_at: string | null;
};

function parseList<T>(value: string, fallback: T[]): T[] {
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed as T[] : fallback; } catch { return fallback; }
}

/**
 * Comments currently awaiting review for one account: the stored 'eligible' classification from a COMPLETE
 * backlog/catch_up scan (exactly what processEligible accepts), not yet queued, not past the private-reply window,
 * and belonging to an enabled, non-archived automation. Read-only; never calls a provider.
 */
export function listPendingReview(database: DatabaseSync, accountId: string, options: { limit: number; offset: number; now: number }) {
  const kinds = REVIEWABLE_SCAN_KINDS.map(() => '?').join(',');
  // Only automations that currently claim the comment's publication are listed (a general automation yields to an
  // enabled media-specific one), so a comment appears once per claiming automation, exactly as enqueue accepts it.
  const rows = database.prepare(`SELECT c.comment_id, c.automation_id, a.name AS automation_name, a.scope, cm.media_id, a.reply_text,
      a.buttons_json, m.permalink, m.caption, m.media_type, m.published_at, cm.username AS author, cm.text,
      cm.created_at AS comment_created_at, c.matched_keywords_json, s.finished_at AS analyzed_at
    FROM comment_classifications c
    JOIN scan_runs s ON s.scan_id = c.scan_id AND s.account_id = c.account_id
    JOIN automations a ON a.automation_id = c.automation_id AND a.account_id = c.account_id
    JOIN comments cm ON cm.account_id = c.account_id AND cm.comment_id = c.comment_id
    LEFT JOIN media m ON m.account_id = cm.account_id AND m.media_id = cm.media_id
    WHERE c.account_id = ? AND c.result = 'eligible' AND s.status = 'complete' AND s.scan_kind IN (${kinds})
      AND ${claimsMediaSql('a', 'cm.media_id')}
      AND NOT EXISTS (SELECT 1 FROM queue_items q WHERE q.account_id = c.account_id AND q.comment_id = c.comment_id)
    ORDER BY cm.created_at DESC, c.comment_id, c.automation_id`).all(accountId, ...REVIEWABLE_SCAN_KINDS) as Row[];
  const account = database.prepare(`SELECT username FROM social_accounts WHERE account_id=?`).get(accountId) as { username: string } | undefined;
  // Comments the account already answered publicly (stored reply by its own username) are never pending.
  const live = rows.filter((row) => !isPastPrivateReplyWindow(row.comment_created_at, options.now)
    && !(account && hasOwnerReply(database, accountId, row.comment_id, account.username)));
  const items: PendingReviewItem[] = live.slice(options.offset, options.offset + options.limit).map((row) => {
    const matchedKeywords = parseList<string>(row.matched_keywords_json, []).filter((k) => typeof k === 'string');
    const buttons = parseList<{ title: string; url: string }>(row.buttons_json, []);
    let previewText: string | null = null; let previewButtons: Array<{ title: string; url: string }> = [];
    try {
      const payload = renderReply(row.reply_text, {
        username: row.author ?? '', comment: row.text ?? '', keyword: matchedKeywords[0] ?? '', account: account?.username ?? '',
        media: (row.permalink || row.media_id).slice(0, 100),
      }, buttons);
      previewText = payload.text; previewButtons = payload.buttons;
    } catch { /* invalid template: still list the comment, without a preview */ }
    return {
      accountId, commentId: row.comment_id, automationId: row.automation_id, automationName: row.automation_name, scope: row.scope,
      mediaId: row.media_id, mediaCaption: row.caption ? truncateText(row.caption, 80) : null, mediaType: row.media_type,
      mediaPublishedAt: row.published_at,
      username: row.author ?? '', commentText: truncateText(row.text), commentCreatedAt: row.comment_created_at, matchedKeywords,
      analyzedAt: row.analyzed_at, previewText, previewButtons,
    };
  });
  const last = database.prepare(`SELECT MAX(finished_at) AS at FROM scan_runs WHERE account_id=? AND status='complete' AND scan_kind IN (${kinds})`)
    .get(accountId, ...REVIEWABLE_SCAN_KINDS) as { at: string | null };
  return { items, total: live.length, lastAnalyzedAt: last.at ?? null, limit: options.limit, offset: options.offset };
}
