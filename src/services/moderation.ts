import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { SocialProvider, ModerationResult } from '../core/domain.js';
import type { ModerationSettingsInput } from './moderation-rules.js';

export type ModerationSettings = ModerationSettingsInput & {
  accountId: string;
  version: number;
};

export type ModerationAction = 'hide' | 'unhide' | 'delete';

export function getSettings(database: DatabaseSync, accountId: string): ModerationSettings {
  const row = database.prepare(`SELECT * FROM moderation_settings WHERE account_id=?`).get(accountId) as any;
  if (!row) {
    return {
      accountId, enabled: false, blockedTerms: [], detectLinks: true, detectPhones: true,
      detectMentions: true, detectEmoji: false, autoHideEnabled: false, autoHideCategories: [], version: 1
    };
  }
  return {
    accountId,
    enabled: row.enabled === 1,
    blockedTerms: JSON.parse(row.blocked_terms_json),
    detectLinks: row.detect_links === 1,
    detectPhones: row.detect_phones === 1,
    detectMentions: row.detect_mentions === 1,
    detectEmoji: row.detect_emoji === 1,
    autoHideEnabled: row.auto_hide_enabled === 1,
    autoHideCategories: JSON.parse(row.auto_hide_categories_json),
    version: row.version
  };
}

/**
 * Auto-hide needs explicit confirmation only when it escalates: going from disabled to enabled, or gaining a category
 * that was not allowed before. Saving other edits (or removing categories) while it stays enabled needs none.
 */
function autoHideEscalates(previous: ModerationSettings, input: ModerationSettingsInput): boolean {
  if (!input.autoHideEnabled) return false;
  if (!previous.autoHideEnabled) return true;
  return input.autoHideCategories.some((category) => !previous.autoHideCategories.includes(category));
}

function previousSince(database: DatabaseSync, accountId: string): string | null {
  const row = database.prepare(`SELECT auto_hide_since FROM moderation_settings WHERE account_id=?`).get(accountId) as { auto_hide_since: string | null } | undefined;
  return row?.auto_hide_since ?? null;
}

/**
 * Categories auto-hide may act on. AI categories only when the operator ticks them; `ai_complaint` (a legitimate
 * complaint) is never allowed: it deserves an answer, not to be hidden.
 */
export const AUTO_HIDE_CATEGORIES = ['blocked_term', 'spam_link', 'spam_phone', 'spam_mentions', 'spam_emoji', 'ai_insult', 'ai_hate', 'ai_spam'] as const;

export function updateSettings(database: DatabaseSync, accountId: string, input: ModerationSettingsInput, confirmed: boolean): void {
  const previous = getSettings(database, accountId);
  if (autoHideEscalates(previous, input) && confirmed !== true) throw new Error('confirmation_required');
  if (input.blockedTerms.length > 200) throw new TypeError('Too many blocked terms');
  const VALID_CATEGORIES = new Set<string>(AUTO_HIDE_CATEGORIES);
  for (const c of input.autoHideCategories) {
    if (!VALID_CATEGORIES.has(c)) throw new TypeError('invalid_category');
  }
  const cleanTerms: string[] = [];
  const seenTerms = new Set<string>();
  for (const t of input.blockedTerms) {
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > 60) throw new Error('blocked_term_invalid');
    const normalized = trimmed.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!seenTerms.has(normalized)) {
      seenTerms.add(normalized);
      cleanTerms.push(trimmed);
    }
  }

  const now = new Date().toISOString();
  // Auto-hide is not retroactive: it only acts on flags created since it was switched on (kept while it stays on).
  const autoHideSince = input.autoHideEnabled ? (previous.autoHideEnabled ? previousSince(database, accountId) ?? now : now) : null;
  database.prepare(`
    INSERT INTO moderation_settings (
      account_id, enabled, blocked_terms_json, detect_links, detect_phones, detect_mentions, detect_emoji, auto_hide_enabled, auto_hide_categories_json, auto_hide_since, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      enabled = excluded.enabled,
      blocked_terms_json = excluded.blocked_terms_json,
      detect_links = excluded.detect_links,
      detect_phones = excluded.detect_phones,
      detect_mentions = excluded.detect_mentions,
      detect_emoji = excluded.detect_emoji,
      auto_hide_enabled = excluded.auto_hide_enabled,
      auto_hide_categories_json = excluded.auto_hide_categories_json,
      auto_hide_since = excluded.auto_hide_since,
      version = moderation_settings.version + 1,
      updated_at = excluded.updated_at
  `).run(
    accountId,
    input.enabled ? 1 : 0,
    JSON.stringify(cleanTerms),
    input.detectLinks ? 1 : 0,
    input.detectPhones ? 1 : 0,
    input.detectMentions ? 1 : 0,
    input.detectEmoji ? 1 : 0,
    input.autoHideEnabled ? 1 : 0,
    JSON.stringify(input.autoHideCategories),
    autoHideSince,
    now
  );
}

export function listFlags(database: DatabaseSync, accountId: string, options: { state?: string, source?: string, limit?: number, offset?: number }) {
  const limit = Math.min(100, Math.max(1, options.limit || 50));
  const offset = Math.max(0, options.offset || 0);

  let where = `f.account_id = ?`;
  const params: any[] = [accountId];
  if (options.state) {
    const VALID_STATES = new Set(['PENDING','DISMISSED','SIMULATED','HIDE_INTENT','HIDDEN','UNHIDE_INTENT','VISIBLE','DELETE_INTENT','DELETED','FAILED','UNKNOWN_OUTCOME']);
    if (!VALID_STATES.has(options.state)) throw new TypeError('invalid_request');
    where += ` AND f.state = ?`;
    params.push(options.state);
  }
  if (options.source) {
    if (options.source !== 'rules' && options.source !== 'ai') throw new TypeError('invalid_request');
    where += ` AND f.source = ?`;
    params.push(options.source);
  }

  const countRow = database.prepare(`SELECT COUNT(*) as total FROM moderation_flags f WHERE ${where}`).get(...params) as { total: number };
  const items = database.prepare(`
    SELECT f.*,
           c.text as c_text, c.username as c_username, c.created_at as c_created_at, c.parent_id as c_parent_id,
           m.permalink as m_permalink, m.thumbnail_url as m_thumbnail_url, m.caption as m_caption
    FROM moderation_flags f
    LEFT JOIN comments c ON f.comment_id = c.comment_id AND f.account_id = c.account_id
    LEFT JOIN media m ON f.media_id = m.media_id AND f.account_id = m.account_id
    WHERE ${where}
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  return {
    items: items.map(row => ({
      flagId: row.flag_id, accountId: row.account_id, mediaId: row.media_id, commentId: row.comment_id,
      category: row.category, source: row.source, reasons: JSON.parse(row.reasons_json), state: row.state, lastAction: row.last_action,
      safeErrorCode: row.safe_error_code, createdAt: row.created_at, updatedAt: row.updated_at,
      comment: { text: row.c_text, username: row.c_username, createdAt: row.c_created_at, parentId: row.c_parent_id },
      media: { permalink: row.m_permalink, thumbnailUrl: row.m_thumbnail_url, caption: row.m_caption?.slice(0, 100) }
    })),
    total: countRow.total
  };
}

/** States an operator may dismiss one by one. UNKNOWN_OUTCOME is included: the operator checked Instagram manually. */
export const SINGLE_DISMISS_STATES = ['PENDING', 'FAILED', 'SIMULATED', 'UNKNOWN_OUTCOME'] as const;
/** Bulk dismiss never resolves UNKNOWN_OUTCOME: that must stay a conscious, one-by-one decision. */
export const BULK_DISMISS_STATES = ['PENDING', 'FAILED', 'SIMULATED'] as const;

function dismissFrom(database: DatabaseSync, accountId: string, flagId: string, allowed: readonly string[]): void {
  const flag = database.prepare(`SELECT comment_id FROM moderation_flags WHERE flag_id = ? AND account_id = ?`).get(flagId, accountId) as { comment_id: string } | undefined;
  if (!flag) throw new Error('not_found');
  const now = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = database.prepare(`
      UPDATE moderation_flags
      SET state = 'DISMISSED', updated_at = ?
      WHERE flag_id = ? AND account_id = ? AND state IN (${allowed.map(() => '?').join(',')})
    `).run(now, flagId, accountId, ...allowed);
    if (Number(result.changes) !== 1) throw new Error('invalid_state');
    const dryRun = database.prepare(`SELECT 1 FROM app_state WHERE state_key='dry_run' AND state_value='true'`).get();
    // Audit: dismissing never calls Meta, but it is an operator decision and is recorded like any other action.
    database.prepare(`
      INSERT INTO moderation_actions (action_id, flag_id, account_id, comment_id, action, actor, mode, outcome, created_at)
      VALUES (?, ?, ?, ?, 'dismiss', 'operator', ?, 'accepted', ?)
    `).run(randomUUID(), flagId, accountId, flag.comment_id, dryRun ? 'dry_run' : 'real', now);
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function dismiss(database: DatabaseSync, accountId: string, flagId: string): void {
  dismissFrom(database, accountId, flagId, SINGLE_DISMISS_STATES);
}

/** Allowed source states per action. SIMULATED never allows unhide: nothing real was ever hidden. */
export const VALID_TRANSITIONS: Record<ModerationAction, readonly string[]> = {
  hide: ['PENDING', 'VISIBLE', 'FAILED', 'SIMULATED'],
  unhide: ['HIDDEN', 'FAILED'],
  delete: ['PENDING', 'HIDDEN', 'VISIBLE', 'FAILED', 'SIMULATED'],
};

export async function act(
  database: DatabaseSync,
  provider: SocialProvider,
  accountId: string,
  flagId: string,
  action: ModerationAction,
  actor: 'operator' | 'auto',
  confirmed?: boolean
): Promise<void> {
  if (action === 'delete' && !confirmed) throw new Error('confirmation_required');

  const flag = database.prepare(`SELECT state, comment_id FROM moderation_flags WHERE flag_id = ? AND account_id = ?`).get(flagId, accountId) as { state: string, comment_id: string } | undefined;
  if (!flag) throw new Error('not_found');

  const allowed = VALID_TRANSITIONS[action];
  if (!allowed.includes(flag.state)) throw new Error('invalid_state');
  const expectedState = `state IN (${allowed.map(() => '?').join(',')})`;

  const now = new Date().toISOString();
  const actionId = randomUUID();
  let accountValid: any;

  database.exec('BEGIN IMMEDIATE');
  try {
    const isDryRun = database.prepare(`SELECT 1 FROM app_state WHERE state_key='dry_run' AND state_value='true'`).get();
    
    if (isDryRun) {
      const simulated = database.prepare(`
        UPDATE moderation_flags SET state='SIMULATED', last_action=?, updated_at=? WHERE flag_id=? AND account_id=? AND ${expectedState}
      `).run(action, now, flagId, accountId, ...allowed);
      if (Number(simulated.changes) !== 1) {
        database.exec('ROLLBACK');
        throw new Error('invalid_state');
      }
      database.prepare(`
        INSERT INTO moderation_actions (action_id, flag_id, account_id, comment_id, action, actor, mode, outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'dry_run', 'simulated', ?)
      `).run(actionId, flagId, accountId, flag.comment_id, action, actor, now);
      database.exec('COMMIT');
      return;
    }

    accountValid = database.prepare(`
      SELECT a.account_id as accountId, a.connection_id as connectionId, a.provider_account_id as providerAccountId, a.username
      FROM social_accounts a
      JOIN connections c ON a.connection_id = c.id
      WHERE a.account_id = ? AND a.status = 'valid' AND c.status = 'valid'
      AND NOT EXISTS (SELECT 1 FROM account_send_holds h WHERE h.account_id = a.account_id)
    `).get(accountId) as any;

    if (!accountValid) {
      database.exec('ROLLBACK');
      throw new Error('account_invalid_or_held');
    }

    const intentState = action === 'hide' ? 'HIDE_INTENT' : action === 'unhide' ? 'UNHIDE_INTENT' : 'DELETE_INTENT';
    const update = database.prepare(`
      UPDATE moderation_flags SET state=?, last_action=?, updated_at=? WHERE flag_id=? AND account_id=? AND ${expectedState}
    `).run(intentState, action, now, flagId, accountId, ...allowed);

    if (Number(update.changes) !== 1) {
      database.exec('ROLLBACK');
      throw new Error('invalid_state');
    }

    database.prepare(`
      INSERT INTO moderation_actions (action_id, flag_id, account_id, comment_id, action, actor, mode, outcome, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'real', 'intent', ?)
    `).run(actionId, flagId, accountId, flag.comment_id, action, actor, now);

    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }

  // Make provider call
  let result: ModerationResult;
  try {
    if (action === 'delete') {
      result = await provider.deleteComment!(accountValid, flag.comment_id);
    } else {
      result = await provider.setCommentHidden!(accountValid, flag.comment_id, action === 'hide');
    }
  } catch (err) {
    result = { status: 'ambiguous', safeErrorCode: 'moderation_ambiguous' };
  }

  // Process result
  database.exec('BEGIN IMMEDIATE');
  try {
    const finalState = result.status === 'accepted' ? (action === 'hide' ? 'HIDDEN' : action === 'unhide' ? 'VISIBLE' : 'DELETED')
      : result.status === 'rejected' ? 'FAILED' : 'UNKNOWN_OUTCOME';
    const intentState = action === 'hide' ? 'HIDE_INTENT' : action === 'unhide' ? 'UNHIDE_INTENT' : 'DELETE_INTENT';

    // Guarded by the intent state: if anything moved the flag meanwhile (e.g. startup recovery), the flag is left as is
    // and only the provider outcome is recorded in the audit table.
    database.prepare(`
      UPDATE moderation_flags SET state=?, safe_error_code=?, updated_at=? WHERE flag_id=? AND account_id=? AND state=?
    `).run(finalState, result.status === 'rejected' || result.status === 'ambiguous' ? (result.safeErrorCode ?? null) : null, new Date().toISOString(), flagId, accountId, intentState);

    database.prepare(`
      INSERT INTO moderation_actions (action_id, flag_id, account_id, comment_id, action, actor, mode, outcome, safe_error_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'real', ?, ?, ?)
    `).run(randomUUID(), flagId, accountId, flag.comment_id, action, actor, result.status, result.status === 'rejected' || result.status === 'ambiguous' ? (result.safeErrorCode ?? null) : null, new Date().toISOString());

    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function recoverInterrupted(database: DatabaseSync): void {
  database.prepare(`
    UPDATE moderation_flags
    SET state = 'UNKNOWN_OUTCOME', updated_at = ?
    WHERE state IN ('HIDE_INTENT', 'UNHIDE_INTENT', 'DELETE_INTENT')
  `).run(new Date().toISOString());
}

/**
 * SQL expression with the julianday of a stored comment time, or NULL when it is not an ISO date-time. Meta writes
 * `+0000`, which SQLite only parses as `+00:00`; a bare number such as '2026' would otherwise read as a julian day.
 */
export function commentTimeSql(column: string): string {
  return `(CASE WHEN ${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' THEN julianday(CASE WHEN ${column} LIKE '%+0000'
    THEN substr(${column}, 1, length(${column}) - 5) || '+00:00' ELSE ${column} END) END)`;
}

export async function processAutoHide(database: DatabaseSync, provider: SocialProvider): Promise<void> {
  const isDryRun = database.prepare(`SELECT 1 FROM app_state WHERE state_key='dry_run' AND state_value='true'`).get();
  if (isDryRun) return;

  const lastAuto = database.prepare(`SELECT state_value FROM app_state WHERE state_key='moderation_last_auto_at'`).get() as { state_value: string } | undefined;
  if (lastAuto) {
    if (Date.now() - new Date(lastAuto.state_value).getTime() < 10000) return;
  }

  const flag = database.prepare(`
    SELECT f.flag_id, f.account_id
    FROM moderation_flags f
    JOIN moderation_settings s ON f.account_id = s.account_id
    JOIN comments cm ON cm.account_id = f.account_id AND cm.comment_id = f.comment_id
    WHERE f.state = 'PENDING' AND s.enabled = 1 AND s.auto_hide_enabled = 1
      -- Not retroactive by COMMENT date: only comments published after auto-hide was switched on (an AI review of old
      -- comments creates new flags, but those comments stay suggestions). A flag without a stored comment never qualifies.
      AND s.auto_hide_since IS NOT NULL AND ${commentTimeSql('cm.created_at')} >= julianday(s.auto_hide_since)
      AND (SELECT value FROM json_each(s.auto_hide_categories_json) WHERE value = f.category) IS NOT NULL
      AND f.category <> 'ai_complaint'
      AND NOT EXISTS (SELECT 1 FROM account_send_holds h WHERE h.account_id = f.account_id)
      AND EXISTS (SELECT 1 FROM social_accounts a JOIN connections c ON a.connection_id = c.id WHERE a.account_id = f.account_id AND a.status = 'valid' AND a.monitoring_paused = 0 AND c.status = 'valid')
    ORDER BY f.created_at ASC
    LIMIT 1
  `).get() as { flag_id: string, account_id: string } | undefined;

  if (!flag) return;

  try {
    await act(database, provider, flag.account_id, flag.flag_id, 'hide', 'auto');
    database.prepare(`INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('moderation_last_auto_at', ?, ?)`).run(new Date().toISOString(), new Date().toISOString());
  } catch (e) {
    // ignore
  }
}

export type BulkAction = ModerationAction | 'dismiss';
export const BULK_MAX_FLAGS = 100;
export const BULK_SPACING_MS = 1000;
export type BulkResult = { flagId: string; state: string; safeErrorCode?: string; error?: string };

const REAL_OUTCOME_STATES = new Set(['HIDDEN', 'VISIBLE', 'DELETED', 'FAILED', 'UNKNOWN_OUTCOME']);

/**
 * Bulk moderation. All-or-nothing ownership: every id must be unique and belong to the account before anything runs
 * (else `not_found`, nothing acted on). Then each flag goes through the single-flag logic (own intent and audit rows);
 * a per-flag `invalid_state` is reported and the batch continues. Real provider calls are spaced BULK_SPACING_MS apart
 * and a `moderation_rate_limited` result stops the batch (the rest are reported `not_attempted`).
 */
export async function executeBulkAction(
  database: DatabaseSync,
  provider: SocialProvider,
  accountId: string,
  flagIds: string[],
  action: BulkAction,
  options: { confirmed?: boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ results: BulkResult[] }> {
  if (!Array.isArray(flagIds) || flagIds.length < 1 || flagIds.length > BULK_MAX_FLAGS
    || flagIds.some((id) => typeof id !== 'string' || !id) || new Set(flagIds).size !== flagIds.length) {
    throw new TypeError('invalid_request');
  }
  if (!['hide', 'unhide', 'delete', 'dismiss'].includes(action)) throw new TypeError('invalid_request');
  if (action === 'delete' && options.confirmed !== true) throw new Error('confirmation_required');

  const owned = database.prepare(`SELECT COUNT(*) AS n FROM moderation_flags WHERE account_id = ? AND flag_id IN (${flagIds.map(() => '?').join(',')})`)
    .get(accountId, ...flagIds) as { n: number };
  if (Number(owned.n) !== flagIds.length) throw new Error('not_found');

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const current = (flagId: string) => database.prepare(`SELECT state, safe_error_code FROM moderation_flags WHERE flag_id = ? AND account_id = ?`)
    .get(flagId, accountId) as { state: string; safe_error_code: string | null };
  const results: BulkResult[] = [];
  let previousRealCall = false;
  let stopReason: string | undefined;

  for (const flagId of flagIds) {
    if (stopReason) {
      results.push({ flagId, state: current(flagId).state, error: 'not_attempted' });
      continue;
    }
    if (action === 'dismiss') {
      try {
        dismissFrom(database, accountId, flagId, BULK_DISMISS_STATES);
        results.push({ flagId, state: 'DISMISSED' });
      } catch (error) {
        results.push({ flagId, state: current(flagId).state, error: error instanceof Error && error.message === 'invalid_state' ? 'invalid_state' : 'operation_rejected' });
      }
      continue;
    }
    const before = current(flagId).state;
    if (previousRealCall && VALID_TRANSITIONS[action].includes(before)) await sleep(BULK_SPACING_MS);
    try {
      await act(database, provider, accountId, flagId, action, 'operator', options.confirmed);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      results.push({ flagId, state: current(flagId).state, error: code === 'invalid_state' || code === 'account_invalid_or_held' ? code : 'operation_rejected' });
      if (code !== 'invalid_state') stopReason = code || 'operation_rejected';
      continue;
    }
    const after = current(flagId);
    previousRealCall = REAL_OUTCOME_STATES.has(after.state);
    results.push(after.safe_error_code && (after.state === 'FAILED' || after.state === 'UNKNOWN_OUTCOME')
      ? { flagId, state: after.state, safeErrorCode: after.safe_error_code }
      : { flagId, state: after.state });
    if (after.state === 'FAILED' && after.safe_error_code === 'moderation_rate_limited') stopReason = 'moderation_rate_limited';
  }
  return { results };
}

/** Moderation engine for the scheduler: startup recovery and one auto-hide step per tick. */
export function moderationEngine(database: DatabaseSync, provider: SocialProvider): { recoverInterrupted(): void; processAutoHide(): Promise<void> } {
  return {
    recoverInterrupted: () => recoverInterrupted(database),
    processAutoHide: () => processAutoHide(database, provider),
  };
}
