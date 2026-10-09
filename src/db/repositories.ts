import type { DatabaseSync } from 'node:sqlite';
import { RepositoryConflictError } from '../core/errors.ts';
import type {
  AccountStatus,
  ConnectionStatus,
  ConnectionValidation,
  EncryptedSecret,
  MetaLoginKind,
  ProviderCode,
} from '../core/domain.ts';

export type NewConnection = {
  id: string;
  name: string;
  providerCode: ProviderCode;
  loginKind: MetaLoginKind;
  appId?: string | null;
  graphVersion: string;
  status: ConnectionStatus;
  accessToken?: EncryptedSecret;
};

export type NewDiscoveredAccount = {
  accountId: string;
  connectionId: string;
  providerAccountId: string;
  username: string;
  displayName?: string | null;
  accountType?: string | null;
  relatedPageId?: string | null;
  status: AccountStatus;
  capabilities?: string[];
};

export type ConnectionSummary = {
  id: string;
  name: string;
  provider_code: string;
  login_kind: string;
  app_id: string | null;
  graph_version: string;
  status: string;
  last_validated_at: string | null;
  validation_error_code: string | null;
  deleted_at?: string | null;
  monitoring_paused?: number;
  observed_user_id?: string | null;
  observed_username?: string | null;
  capabilities_json?: string;
};

export type AccountSummary = {
  accountId: string;
  connectionId: string;
  providerAccountId: string;
  username: string;
  displayName?: string;
  accountType?: string;
  relatedPageId?: string;
  status: string;
};

export type StoredEncryptedCredential = {
  contextId: string;
  secret: EncryptedSecret;
};

export function createConnection(database: DatabaseSync, input: NewConnection): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO connections
    (id, name, provider_code, login_kind, app_id, graph_version, status,
     access_token_nonce, access_token_ciphertext, access_token_tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      input.name.trim(),
      input.providerCode,
      input.loginKind,
      input.appId ?? null,
      input.graphVersion,
      input.status,
      input.accessToken?.nonce ?? null,
      input.accessToken?.ciphertext ?? null,
      input.accessToken?.tag ?? null,
      now,
      now,
    );
}

export function getConnectionSummary(database: DatabaseSync, connectionId: string): ConnectionSummary {
  const row = database.prepare(`SELECT id, name, provider_code, login_kind, app_id, graph_version, status,
      last_validated_at, validation_error_code, deleted_at, monitoring_paused, observed_user_id,
      observed_username, capabilities_json
    FROM connections WHERE id = ?`).get(connectionId) as ConnectionSummary | undefined;

  if (!row) throw new Error('Connection not found');
  return row;
}

export function listConnections(database: DatabaseSync): ConnectionSummary[] {
  return database.prepare(`SELECT id, name, provider_code, login_kind, app_id, graph_version, status,
      last_validated_at, validation_error_code, deleted_at, monitoring_paused, observed_user_id,
      observed_username, capabilities_json
    FROM connections WHERE deleted_at IS NULL ORDER BY created_at, id`).all() as ConnectionSummary[];
}

export function hasEncryptedSecrets(database: DatabaseSync): boolean {
  return database.prepare(`SELECT 1 FROM connections WHERE access_token_ciphertext IS NOT NULL
    UNION ALL SELECT 1 FROM social_accounts WHERE page_token_ciphertext IS NOT NULL LIMIT 1`).get() !== undefined;
}

export function listEncryptedCredentials(database: DatabaseSync): StoredEncryptedCredential[] {
  return database.prepare(`SELECT id AS context_id, access_token_nonce AS nonce,
      access_token_ciphertext AS ciphertext, access_token_tag AS tag
    FROM connections WHERE access_token_ciphertext IS NOT NULL
    UNION ALL
    SELECT 'account:' || account_id AS context_id, page_token_nonce AS nonce,
      page_token_ciphertext AS ciphertext, page_token_tag AS tag
    FROM social_accounts WHERE page_token_ciphertext IS NOT NULL`).all().map((row) => {
    const credential = row as { context_id: string; nonce: string; ciphertext: string; tag: string };
    return {
      contextId: credential.context_id,
      secret: {
        nonce: credential.nonce,
        ciphertext: credential.ciphertext,
        tag: credential.tag,
      },
    };
  });
}

export function getConnectionCredential(
  database: DatabaseSync,
  connectionId: string,
): { loginKind: MetaLoginKind; graphVersion: string; secret: EncryptedSecret } {
  const row = database.prepare(`SELECT login_kind, graph_version, access_token_nonce,
      access_token_ciphertext, access_token_tag
    FROM connections WHERE id = ? AND deleted_at IS NULL`).get(connectionId) as {
    login_kind: MetaLoginKind;
    graph_version: string;
    access_token_nonce: string | null;
    access_token_ciphertext: string | null;
    access_token_tag: string | null;
  } | undefined;

  if (!row?.access_token_nonce || !row.access_token_ciphertext || !row.access_token_tag) {
    throw new Error('Connection credential is unavailable');
  }
  return {
    loginKind: row.login_kind,
    graphVersion: row.graph_version,
    secret: {
      nonce: row.access_token_nonce,
      ciphertext: row.access_token_ciphertext,
      tag: row.access_token_tag,
    },
  };
}

export function addDiscoveredAccount(database: DatabaseSync, input: NewDiscoveredAccount): void {
  const username = input.username.normalize('NFC').trim().replace(/^@/u, '');
  const normalized = username.toLocaleLowerCase('und');
  if (!username || !normalized) throw new TypeError('A discovered account must include a username');

  const matches = database.prepare(`SELECT account_id, connection_id, provider_account_id, normalized_username
    FROM social_accounts WHERE provider_account_id = ? OR normalized_username = ?`)
    .all(input.providerAccountId, normalized) as Array<{
      account_id: string;
      connection_id: string;
      provider_account_id: string;
      normalized_username: string;
    }>;

  if (matches.length) {
    if (matches.length !== 1 || matches[0]!.account_id !== input.accountId
      || matches[0]!.connection_id !== input.connectionId) {
      throw new RepositoryConflictError('This physical Instagram account is already managed or tombstoned under another connection');
    }
    const now = new Date().toISOString();
    database.prepare(`UPDATE social_accounts SET provider_account_id = ?, username = ?, normalized_username = ?,
        display_name = ?, account_type = ?, related_page_id = ?, status = ?, capabilities_json = ?,
        last_validated_at = ?, monitoring_paused = 0, last_validation_error_code = NULL, updated_at = ?
      WHERE account_id = ? AND connection_id = ?`)
      .run(
        input.providerAccountId,
        username,
        normalized,
        input.displayName ?? null,
        input.accountType ?? null,
        input.relatedPageId ?? null,
        input.status,
        JSON.stringify(input.capabilities ?? []),
        now,
        now,
        input.accountId,
        input.connectionId,
      );
    return;
  }

  const now = new Date().toISOString();
  database.prepare(`INSERT INTO social_accounts
      (account_id, connection_id, provider_account_id, username, normalized_username, display_name,
       account_type, related_page_id, status, capabilities_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.accountId,
      input.connectionId,
      input.providerAccountId,
      username,
      normalized,
      input.displayName ?? null,
      input.accountType ?? null,
      input.relatedPageId ?? null,
      input.status,
      JSON.stringify(input.capabilities ?? []),
      now,
      now,
    );
}

const ACCOUNT_SELECT = `SELECT account_id AS accountId, connection_id AS connectionId,
    provider_account_id AS providerAccountId, username, display_name AS displayName,
    account_type AS accountType, related_page_id AS relatedPageId, status
  FROM social_accounts`;

export function getAccountSummary(database: DatabaseSync, accountId: string): AccountSummary {
  const row = database.prepare(`${ACCOUNT_SELECT} WHERE account_id = ?`).get(accountId) as AccountSummary | undefined;
  if (!row) throw new Error('Account not found');
  return row;
}

export function listAccountSummaries(database: DatabaseSync, connectionId: string): AccountSummary[] {
  return database.prepare(`${ACCOUNT_SELECT} WHERE connection_id = ? ORDER BY created_at, account_id`)
    .all(connectionId) as AccountSummary[];
}

export function createMedia(
  database: DatabaseSync,
  input: { accountId: string; mediaId: string; permalink: string | null; publishedAt: string | null },
): void {
  database.prepare(`INSERT INTO media (account_id, media_id, permalink, published_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(input.accountId, input.mediaId, input.permalink, input.publishedAt, new Date().toISOString());
}

export function createMediaIfMissing(
  database: DatabaseSync,
  input: { accountId: string; mediaId: string; permalink: string | null; publishedAt: string | null; caption?: string | null; mediaType?: string | null; thumbnailUrl?: string | null },
): void {
  database.prepare(`INSERT INTO media (account_id, media_id, permalink, published_at, last_seen_at, caption, media_type, thumbnail_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, media_id) DO UPDATE SET permalink = excluded.permalink,
      published_at = excluded.published_at, last_seen_at = excluded.last_seen_at,
      caption = excluded.caption, media_type = excluded.media_type, thumbnail_url = excluded.thumbnail_url`)
    .run(input.accountId, input.mediaId, input.permalink, input.publishedAt, new Date().toISOString(),
      input.caption ?? null, input.mediaType ?? null, input.thumbnailUrl ?? null);
}

export function listMedia(
  database: DatabaseSync,
  accountId: string,
): Array<{ mediaId: string; permalink: string | null; publishedAt: string | null; caption: string | null; mediaType: string | null; thumbnailUrl: string | null }> {
  return database.prepare(`SELECT media_id AS mediaId, permalink, published_at AS publishedAt, caption, media_type AS mediaType, thumbnail_url AS thumbnailUrl
    FROM media WHERE account_id = ? ORDER BY published_at DESC, media_id`)
    .all(accountId) as Array<{ mediaId: string; permalink: string | null; publishedAt: string | null; caption: string | null; mediaType: string | null; thumbnailUrl: string | null }>;
}

export function createComment(
  database: DatabaseSync,
  input: {
    accountId: string;
    mediaId: string;
    commentId: string;
    text: string | null;
    username: string | null;
    createdAt: string | null;
    parentId?: string | null;
  },
): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO comments
      (account_id, media_id, comment_id, text, username, created_at, parent_id, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(input.accountId, input.mediaId, input.commentId, input.text, input.username, input.createdAt,
      input.parentId ?? null, now, now);
}

export function listComments(
  database: DatabaseSync,
  accountId: string,
): Array<{ media_id: string; comment_id: string; text: string | null; username: string | null; created_at: string | null }> {
  return database.prepare(`SELECT media_id, comment_id, text, username, created_at
    FROM comments WHERE account_id = ? ORDER BY created_at, comment_id`)
    .all(accountId) as Array<{ media_id: string; comment_id: string; text: string | null; username: string | null; created_at: string | null }>;
}

export function saveAccountPageToken(database: DatabaseSync, accountId: string, secret: EncryptedSecret): void {
  database.prepare(`UPDATE social_accounts SET page_token_nonce = ?, page_token_ciphertext = ?,
      page_token_tag = ?, updated_at = ? WHERE account_id = ?`)
    .run(secret.nonce, secret.ciphertext, secret.tag, new Date().toISOString(), accountId);
}

export function getAccountCredential(
  database: DatabaseSync,
  accountId: string,
): { secret: EncryptedSecret | null; connectionId: string; providerAccountId: string } {
  const row = database.prepare(`SELECT connection_id, provider_account_id, page_token_nonce,
      page_token_ciphertext, page_token_tag
    FROM social_accounts WHERE account_id = ?`).get(accountId) as {
    connection_id: string;
    provider_account_id: string;
    page_token_nonce: string | null;
    page_token_ciphertext: string | null;
    page_token_tag: string | null;
  } | undefined;

  if (!row) throw new Error('Account not found');
  const secret = row.page_token_nonce && row.page_token_ciphertext && row.page_token_tag
    ? { nonce: row.page_token_nonce, ciphertext: row.page_token_ciphertext, tag: row.page_token_tag }
    : null;
  return { connectionId: row.connection_id, providerAccountId: row.provider_account_id, secret };
}

export function updateConnection(
  database: DatabaseSync,
  id: string,
  update: { name: string; appId: string | null; graphVersion: string; accessToken?: EncryptedSecret; invalidate?: boolean },
): void {
  const now = new Date().toISOString();
  if (update.accessToken) {
    database.prepare(`UPDATE connections SET name = ?, app_id = ?, graph_version = ?, access_token_nonce = ?,
        access_token_ciphertext = ?, access_token_tag = ?, status = 'unvalidated', monitoring_paused = 1,
        last_validated_at = NULL, validation_error_code = NULL, observed_username = NULL,
        capabilities_json = '[]', updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(update.name, update.appId, update.graphVersion, update.accessToken.nonce,
        update.accessToken.ciphertext, update.accessToken.tag, now, id);
    pauseAndClearAccountCredentials(database, id, now);
    return;
  }

  if (update.invalidate) {
    database.prepare(`UPDATE connections SET name = ?, app_id = ?, graph_version = ?, status = 'unvalidated',
        monitoring_paused = 1, last_validated_at = NULL, validation_error_code = NULL,
        observed_username = NULL, capabilities_json = '[]', updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`)
      .run(update.name, update.appId, update.graphVersion, now, id);
    pauseAndClearAccountCredentials(database, id, now);
    return;
  }

  database.prepare(`UPDATE connections SET name = ?, app_id = ?, graph_version = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL`).run(update.name, update.appId, update.graphVersion, now, id);
}

export function saveConnectionValidation(
  database: DatabaseSync,
  id: string,
  validation: ConnectionValidation,
): ConnectionValidation {
  const previous = database.prepare(`SELECT observed_user_id FROM connections WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as { observed_user_id: string | null } | undefined;
  if (!previous) throw new Error('Connection not found');

  let result = validation;
  if (validation.status === 'valid' && !validation.providerUserId) {
    result = { ...validation, status: 'invalid', capabilities: [], safeErrorCode: 'connection_identity_unverified' };
  } else if (validation.status === 'valid' && previous.observed_user_id
    && previous.observed_user_id !== validation.providerUserId) {
    result = { ...validation, status: 'invalid', capabilities: [], safeErrorCode: 'connection_identity_mismatch' };
  }

  const valid = result.status === 'valid';
  const now = new Date().toISOString();
  database.prepare(`UPDATE connections SET status = ?, last_validated_at = ?, validation_error_code = ?,
      observed_user_id = CASE WHEN ? = 1 THEN COALESCE(observed_user_id, ?) ELSE observed_user_id END,
      observed_username = CASE WHEN ? = 1 THEN ? ELSE observed_username END,
      capabilities_json = ?, monitoring_paused = ?, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL`)
    .run(
      result.status,
      result.observedAt,
      result.safeErrorCode ?? null,
      valid ? 1 : 0,
      result.providerUserId ?? null,
      valid ? 1 : 0,
      result.username ?? null,
      JSON.stringify(valid ? result.capabilities : []),
      valid ? 0 : 1,
      now,
      id,
    );

  if (!valid) pauseAndClearAccountCredentials(database, id, now, result.safeErrorCode ?? null);
  return result;
}

function pauseAndClearAccountCredentials(database: DatabaseSync, connectionId: string, now: string, errorCode: string | null = null): void {
  database.prepare(`UPDATE social_accounts SET status = 'unvalidated', capabilities_json = '[]', monitoring_paused = 1,
      last_validated_at = NULL, last_validation_error_code = ?, page_token_nonce = NULL,
      page_token_ciphertext = NULL, page_token_tag = NULL, updated_at = ? WHERE connection_id = ?`)
    .run(errorCode, now, connectionId);
}

export function disconnectConnection(database: DatabaseSync, id: string, deleted: boolean): void {
  const now = new Date().toISOString();
  database.prepare(`UPDATE connections SET status = 'disconnected', monitoring_paused = 1,
      access_token_nonce = NULL, access_token_ciphertext = NULL, access_token_tag = NULL,
      capabilities_json = '[]', validation_error_code = NULL,
      deleted_at = CASE WHEN ? THEN ? ELSE deleted_at END, updated_at = ? WHERE id = ?`)
    .run(deleted ? 1 : 0, now, now, id);
  database.prepare(`UPDATE social_accounts SET status = 'disconnected', monitoring_paused = 1,
      capabilities_json = '[]', page_token_nonce = NULL, page_token_ciphertext = NULL,
      page_token_tag = NULL, updated_at = ? WHERE connection_id = ?`)
    .run(now, id);
}
