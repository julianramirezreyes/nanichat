import type { ProviderComment, PrivateReplyPayload } from '../core/domain.ts';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { storedPublicReplyVariants, validatePublicReplyVariants } from './public-reply.ts';

export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** True when a valid comment timestamp is at or past the private-reply window (conservative boundary). */
export function isPastPrivateReplyWindow(createdAt: string | null | undefined, now: number): boolean {
  if (!createdAt) return false;
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && created <= now && now - created >= PRIVATE_REPLY_WINDOW_MS;
}

export type ReplyVariables = {
  username: string;
  comment: string;
  keyword: string;
  account?: string;
  media?: string;
};

export type CommentClassification = {
  eligible: boolean;
  reason: 'eligible' | 'own_authored' | 'reply_thread' | 'missing_author' | 'missing_timestamp' | 'invalid_timestamp'
    | 'future_timestamp' | 'expired' | 'no_keyword_match' | 'owner_replied' | 'multiple_keyword_matches';
  matchedKeywords: string[];
};

export function normalizeMatchText(value: string): string {
  return value.normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('und')
    .replace(/[\s\u00a0]+/gu, ' ')
    .trim();
}

export function matchesKeyword(text: string, keyword: string, mode: 'exact' | 'contains'): boolean {
  const normalizedText = normalizeMatchText(text);
  const normalizedKeyword = normalizeMatchText(keyword);
  if (!normalizedText || !normalizedKeyword) return false;
  if (mode === 'exact') return normalizedText === normalizedKeyword;

  let offset = 0;
  while (offset <= normalizedText.length - normalizedKeyword.length) {
    const index = normalizedText.indexOf(normalizedKeyword, offset);
    if (index < 0) return false;
    const before = index === 0 ? '' : normalizedText[index - 1]!;
    const afterIndex = index + normalizedKeyword.length;
    const after = afterIndex >= normalizedText.length ? '' : normalizedText[afterIndex]!;
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    offset = index + 1;
  }
  return false;
}

export function matchAutomation(text: string, keywords: string[], mode: 'exact' | 'contains'): string[] {
  return keywords.filter((keyword) => matchesKeyword(text, keyword, mode));
}

export function renderReply(
  template: string,
  variables: ReplyVariables,
  buttons: Array<{ title: string; url: string }>,
): PrivateReplyPayload {
  if (!template.trim()) throw new TypeError('Reply text is required');
  if (buttons.length > 2) throw new TypeError('At most two buttons are allowed');

  const text = template.replace(/\{\{([^{}]+)\}\}/gu, (_whole, name: string) => {
    if (name !== 'username' && name !== 'comment' && name !== 'keyword' && name !== 'account' && name !== 'media') {
      throw new TypeError('Unsupported reply variable');
    }
    return variables[name] ?? '';
  });
  if (/\{\{|\}\}/u.test(text)) throw new TypeError('Malformed reply variable');
  if (!text.trim() || text.length > 1000) throw new TypeError('Reply text is empty or too long');

  const safeButtons = buttons.map(({ title, url }) => {
    if (!title.trim() || title.length > 20) throw new TypeError('Button title is empty or too long');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError('Button URL is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
      throw new TypeError('Button URL must be a public HTTPS URL');
    }
    return { title, url: parsed.toString() };
  });

  return { text, buttons: safeButtons };
}

export function classifyComment(
  comment: ProviderComment,
  keywords: string[],
  ownerUsername: string,
  now = Date.now(),
  mode: 'exact' | 'contains' = 'contains',
  ownerReplied = false,
): CommentClassification {
  const matchedKeywords = matchAutomation(comment.text ?? '', keywords, mode);
  const classify = (reason: CommentClassification['reason'], eligible = false): CommentClassification => ({
    eligible,
    reason,
    matchedKeywords,
  });

  if (comment.parentId) return classify('reply_thread');
  if (!comment.username?.trim()) return classify('missing_author');
  if (normalizeMatchText(comment.username) === normalizeMatchText(ownerUsername)) {
    return classify('own_authored');
  }
  if (!comment.createdAt) return classify('missing_timestamp');
  const createdAt = Date.parse(comment.createdAt);
  if (!Number.isFinite(createdAt)) return classify('invalid_timestamp');
  if (createdAt > now) return classify('future_timestamp');
  if (now - createdAt >= PRIVATE_REPLY_WINDOW_MS) return classify('expired');
  if (!matchedKeywords.length) return classify('no_keyword_match');
  // Meta allows one private reply per comment: a root the account already answered publicly is not safe to answer again.
  if (ownerReplied) return classify('owner_replied');
  return classify('eligible', true);
}

/**
 * True when the stored comments contain a reply (same account, parent_id = commentId) authored by the account's own
 * username. Relies only on replies stored locally by scans; a reply created after the last scan is not known.
 */
export function hasOwnerReply(database: DatabaseSync, accountId: string, commentId: string, ownerUsername: string): boolean {
  const owner = normalizeMatchText(ownerUsername);
  if (!owner) return false;
  const rows = database.prepare(`SELECT username FROM comments WHERE account_id=? AND parent_id=?`)
    .all(accountId, commentId) as Array<{ username: string | null }>;
  return rows.some((row) => row.username != null && normalizeMatchText(row.username) === owner);
}

/** Set of root comment IDs on one media that have a stored reply by the account's own username (one query). */
export function ownerRepliedParentIds(database: DatabaseSync, accountId: string, mediaId: string, ownerUsername: string): Set<string> {
  const owner = normalizeMatchText(ownerUsername);
  const result = new Set<string>();
  if (!owner) return result;
  const rows = database.prepare(`SELECT parent_id, username FROM comments WHERE account_id=? AND media_id=? AND parent_id IS NOT NULL`)
    .all(accountId, mediaId) as Array<{ parent_id: string; username: string | null }>;
  for (const row of rows) if (row.username != null && normalizeMatchText(row.username) === owner) result.add(row.parent_id);
  return result;
}

export type AutomationScope = 'media' | 'account';

/**
 * SQL predicate: the automation row aliased `alias` currently claims the media given by the SQL expression `media`.
 * Only enabled, non-archived automations claim anything. A media-scoped automation claims its own media; an
 * account-scoped ("general") automation claims every media of its account that has NO enabled, non-archived
 * media-scoped automation (the general one yields). Used by scanning, enqueue ambiguity, pending review and the
 * pre-send recheck so the precedence rule is identical everywhere.
 */
export function claimsMediaSql(alias: string, media: string): string {
  return `(${alias}.status = 'enabled' AND ${alias}.name NOT LIKE '% (archived)' AND (
    (${alias}.scope = 'media' AND ${alias}.media_id = ${media})
    OR (${alias}.scope = 'account' AND NOT EXISTS (SELECT 1 FROM automations claim_specific
      WHERE claim_specific.account_id = ${alias}.account_id AND claim_specific.scope = 'media'
        AND claim_specific.media_id = ${media} AND claim_specific.status = 'enabled'
        AND claim_specific.name NOT LIKE '% (archived)'))))`;
}

/** True when the media has an enabled, non-archived media-specific automation (a general automation yields there). */
export function hasEnabledMediaAutomation(database: DatabaseSync, accountId: string, mediaId: string): boolean {
  return Boolean(database.prepare(`SELECT 1 FROM automations WHERE account_id=? AND scope='media' AND media_id=?
    AND status='enabled' AND name NOT LIKE '% (archived)' LIMIT 1`).get(accountId, mediaId));
}

export type ClaimingAutomation = {
  automation_id: string; account_id: string; media_id: string | null; scope: AutomationScope; status: string;
  match_mode: 'exact' | 'contains'; monitoring_started_at: string | null;
};

/** Enabled, non-archived automations that claim one media of one account (specific ones, else the general ones). */
export function claimingAutomations(database: DatabaseSync, accountId: string, mediaId: string): ClaimingAutomation[] {
  return database.prepare(`SELECT a.automation_id, a.account_id, a.media_id, a.scope, a.status, a.match_mode, a.monitoring_started_at
    FROM automations a WHERE a.account_id = ? AND ${claimsMediaSql('a', '?')} ORDER BY a.automation_id`)
    .all(accountId, mediaId, mediaId) as ClaimingAutomation[];
}

export class AutomationService {
  constructor(private readonly database: DatabaseSync) {}

  create(input: {
    accountId: string;
    /** Required for scope 'media'; must be omitted (or null) for scope 'account'. */
    mediaId?: string | null;
    scope?: AutomationScope;
    name: string;
    replyText: string;
    matchMode?: 'exact' | 'contains';
    buttons?: Array<{ title: string; url: string }>;
    /** Optional public reply after an accepted private reply; enabled requires at least one valid variant. */
    publicReplyEnabled?: boolean;
    publicReplyVariants?: string[];
  }): string {
    if (!input.name.trim()) throw new TypeError('Automation name is required');
    const publicReply = publicReplyConfig(input.publicReplyEnabled, input.publicReplyVariants, { enabled: false, variants: [] });
    const scope = input.scope ?? 'media';
    if (scope !== 'media' && scope !== 'account') throw new TypeError('Invalid automation scope');
    renderReply(input.replyText, { username: 'user', comment: 'comment', keyword: 'keyword', account: 'account', media: 'media' }, input.buttons ?? []);
    let mediaId: string | null = null;
    if (scope === 'account') {
      if (input.mediaId !== undefined && input.mediaId !== null) throw new TypeError('A general automation cannot target one media');
      const account = this.database.prepare(`SELECT 1 FROM social_accounts WHERE account_id=?`).get(input.accountId);
      if (!account) throw new Error('Account does not exist');
    } else {
      if (typeof input.mediaId !== 'string' || !input.mediaId) throw new TypeError('A media-specific automation requires a media');
      const media = this.database.prepare(`SELECT 1 FROM media WHERE account_id=? AND media_id=?`)
        .get(input.accountId, input.mediaId);
      if (!media) throw new Error('Media does not belong to this account');
      mediaId = input.mediaId;
    }
    const automationId = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO automations
      (automation_id, account_id, media_id, scope, name, status, match_mode, reply_text, buttons_json,
       created_at, updated_at, real_enabled, monitoring_started_at, public_reply_enabled, public_reply_variants_json)
      VALUES (?, ?, ?, ?, ?, 'disabled', ?, ?, ?, ?, ?, 0, NULL, ?, ?)`)
      .run(automationId, input.accountId, mediaId, scope, input.name.trim(), input.matchMode ?? 'contains',
        input.replyText, JSON.stringify(input.buttons ?? []), now, now, publicReply.enabled ? 1 : 0, JSON.stringify(publicReply.variants));
    return automationId;
  }

  update(accountId: string, automationId: string, input: {
    name: string;
    /** Media of a media-scoped automation; null/omitted for a general one. */
    mediaId?: string | null;
    /** Optional: when present it must equal the stored scope (scope never changes silently). */
    scope?: AutomationScope;
    replyText: string;
    matchMode: 'exact' | 'contains';
    buttons: Array<{ title: string; url: string }>;
    keywords: string[];
    /** Omitted: keep the stored public reply configuration. */
    publicReplyEnabled?: boolean;
    publicReplyVariants?: string[];
  }): void {
    if (!input.name.trim()) throw new TypeError('Automation name is required');
    const stored = this.database.prepare(`SELECT scope, public_reply_enabled, public_reply_variants_json FROM automations
      WHERE account_id=? AND automation_id=?`)
      .get(accountId, automationId) as { scope: AutomationScope; public_reply_enabled: number; public_reply_variants_json: string } | undefined;
    if (!stored) throw new Error('Automation does not belong to this account');
    const storedVariants = storedPublicReplyVariants(stored.public_reply_variants_json);
    const publicReply = publicReplyConfig(input.publicReplyEnabled, input.publicReplyVariants,
      { enabled: stored.public_reply_enabled === 1, variants: storedVariants });
    // Changing scope would reparent queue/history between "one media" and "whole account"; create a new one instead.
    if (input.scope !== undefined && input.scope !== stored.scope) throw new Error('Automation scope cannot change');
    const mediaId = input.mediaId ?? null;
    if (stored.scope === 'account' && mediaId !== null) throw new Error('A general automation cannot be attached to one media');
    if (stored.scope === 'media' && !mediaId) throw new TypeError('A media-specific automation requires a media');
    const normalizedKeywords = input.keywords.map(normalizeMatchText);
    if (!normalizedKeywords.length || normalizedKeywords.some((phrase) => !phrase)
      || new Set(normalizedKeywords).size !== normalizedKeywords.length) throw new TypeError('Automation keywords must be distinct non-empty phrases');
    renderReply(input.replyText, { username: 'user', comment: 'comment', keyword: 'keyword', account: 'account', media: 'media' }, input.buttons);
    if (mediaId !== null) {
      const media = this.database.prepare(`SELECT 1 FROM media WHERE account_id=? AND media_id=?`).get(accountId, mediaId);
      if (!media) throw new Error('Media does not belong to this account');
    }
    const now = new Date().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.database.prepare(`UPDATE automations SET media_id=?, name=?, match_mode=?, reply_text=?, buttons_json=?,
        public_reply_enabled=?, public_reply_variants_json=?,
        version=version+1, updated_at=? WHERE account_id=? AND automation_id=? AND scope=? AND name NOT LIKE '% (archived)'`)
        .run(mediaId, input.name.trim(), input.matchMode, input.replyText, JSON.stringify(input.buttons),
          publicReply.enabled ? 1 : 0, JSON.stringify(publicReply.variants), now, accountId, automationId, stored.scope);
      if (Number(updated.changes) !== 1) throw new Error('Automation does not belong to this account');
      this.database.prepare(`DELETE FROM automation_keywords WHERE account_id=? AND automation_id=?`).run(accountId, automationId);
      for (const phrase of input.keywords) this.addKeyword(accountId, automationId, phrase);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  addKeyword(accountId: string, automationId: string, phrase: string): string {
    const normalized = normalizeMatchText(phrase);
    if (!normalized) throw new TypeError('A non-empty keyword phrase is required');
    const keywordId = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO automation_keywords
      (account_id, automation_id, keyword_id, phrase, normalized_phrase, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(accountId, automationId, keywordId, phrase.trim(), normalized, now);
    this.database.prepare(`UPDATE automations SET version=version+1, updated_at=?
      WHERE automation_id=? AND account_id=?`).run(now, automationId, accountId);
    return keywordId;
  }

  setEnabled(accountId: string, automationId: string, enabled: boolean): void {
    const now = new Date().toISOString();
    const result = this.database.prepare(`UPDATE automations SET status=?, monitoring_started_at=?,
      version=version+1, updated_at=? WHERE automation_id=? AND account_id=? AND name NOT LIKE '% (archived)'`)
      .run(enabled ? 'enabled' : 'disabled', enabled ? now : null, now, automationId, accountId);
    if (Number(result.changes) !== 1) throw new Error('Automation does not belong to this account');
  }

  setRealEnabled(accountId: string, automationId: string, enabled: boolean, confirmed = false): void {
    if (enabled && !confirmed) throw new Error('Explicit confirmation is required to enable real replies');
    if (enabled) {
      const hold = this.database.prepare(`SELECT 1 FROM account_send_holds WHERE account_id=?`).get(accountId);
      const owner = this.database.prepare(`SELECT s.status AS account_status, c.status AS connection_status, c.deleted_at
        FROM social_accounts s JOIN connections c ON c.id=s.connection_id WHERE s.account_id=?`).get(accountId) as {
        account_status: string; connection_status: string; deleted_at: string | null;
      } | undefined;
      if (hold) throw new Error('A safety hold blocks real replies for this account');
      if (!owner || owner.account_status !== 'valid' || owner.connection_status !== 'valid' || owner.deleted_at) {
        throw new Error('Real replies require a validated account and connection');
      }
    }
    const result = this.database.prepare(`UPDATE automations SET real_enabled=?, version=version+1, updated_at=?
      WHERE automation_id=? AND account_id=? AND status='enabled'`)
      .run(enabled ? 1 : 0, new Date().toISOString(), automationId, accountId);
    if (Number(result.changes) !== 1) throw new Error('Only an enabled automation can change real-reply mode');
  }

  setAccountSendHold(accountId: string, reasonCode: string): void {
    if (!/^[a-z0-9_]{3,64}$/u.test(reasonCode)) throw new TypeError('Safety hold needs a safe reason code');
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO account_send_holds(account_id, reason_code, created_at)
      VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET reason_code=excluded.reason_code, created_at=excluded.created_at`)
      .run(accountId, reasonCode, now);
  }

  clearAccountSendHold(accountId: string, expectedReasonCode: string): void {
    const result = this.database.prepare(`DELETE FROM account_send_holds WHERE account_id=? AND reason_code=?`)
      .run(accountId, expectedReasonCode);
    if (Number(result.changes) !== 1) throw new Error('Safety hold changed or does not belong to this account');
  }
}

/**
 * Resolves the public reply configuration: omitted fields keep `current`; present fields are validated strictly
 * (enabled must be a boolean, variants a valid list) and enabling requires at least one variant.
 */
function publicReplyConfig(enabled: unknown, variants: unknown, current: { enabled: boolean; variants: string[] }): { enabled: boolean; variants: string[] } {
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new TypeError('publicReplyEnabled must be a boolean');
  const nextVariants = variants === undefined ? current.variants : validatePublicReplyVariants(variants);
  const nextEnabled = enabled === undefined ? current.enabled : enabled;
  if (nextEnabled && nextVariants.length === 0) throw new TypeError('Public reply requires at least one variant');
  return { enabled: nextEnabled, variants: nextVariants };
}

function isWordCharacter(value: string): boolean {
  return value !== '' && /[\p{L}\p{N}_]/u.test(value);
}
