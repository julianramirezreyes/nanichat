import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ConnectionValidation,
  DiscoveredAccount,
  MetaLoginKind,
  SocialProvider,
} from '../core/domain.ts';
import { AccountAdoptionRequiredError, RepositoryConflictError } from '../core/errors.ts';
import type { CredentialVault } from '../security/vault.ts';
import {
  addDiscoveredAccount,
  createConnection,
  createMediaIfMissing,
  disconnectConnection,
  getAccountSummary,
  getConnectionCredential,
  getConnectionSummary,
  listAccountSummaries,
  listConnections,
  listMedia,
  saveAccountPageToken,
  saveConnectionValidation,
  updateConnection,
} from '../db/repositories.ts';

export type CreateConnectionInput = {
  id: string;
  name: string;
  loginKind: MetaLoginKind;
  appId?: string;
  graphVersion: string;
  accessToken: string;
};

export type EditConnectionInput = {
  name?: string;
  appId?: string | null;
  graphVersion?: string;
  accessToken?: string;
};

type AccountCredentialProvider = SocialProvider & {
  credentialForSelectedAccount(
    connectionId: string,
    account: DiscoveredAccount,
  ): Promise<string | undefined>;
};

export class ConnectionService {
  private readonly discovered = new Map<string, DiscoveredAccount[]>();

  constructor(
    private readonly database: DatabaseSync,
    private readonly vault: CredentialVault,
    private readonly provider: AccountCredentialProvider,
  ) {}

  async create(input: CreateConnectionInput) {
    if (!input.name.trim() || !/^v\d+\.\d+$/.test(input.graphVersion) || !input.accessToken.trim()) {
      throw new TypeError('Connection name, valid Graph version, and access token are required');
    }

    createConnection(this.database, {
      id: input.id,
      name: input.name,
      providerCode: 'META',
      loginKind: input.loginKind,
      appId: input.appId ?? null,
      graphVersion: input.graphVersion,
      status: 'unvalidated',
      accessToken: this.vault.encrypt(input.id, input.accessToken),
    });
    return this.publicConnection(input.id);
  }

  listConnections() {
    return listConnections(this.database).map((connection) => ({
      ...connection,
      capabilities: parseCapabilities(connection.capabilities_json),
    }));
  }

  async edit(id: string, input: EditConnectionInput) {
    const current = getConnectionSummary(this.database, id);
    if (current.deleted_at) throw new Error('Deleted connections cannot be edited');

    const graphVersion = input.graphVersion ?? current.graph_version;
    if (!/^v\d+\.\d+$/.test(graphVersion)) throw new TypeError('Invalid Graph version');
    if (input.accessToken !== undefined && !input.accessToken.trim()) {
      throw new TypeError('Access token cannot be empty');
    }

    const appId = input.appId === undefined ? current.app_id : input.appId;
    const tokenChanged = typeof input.accessToken === 'string';
    const identitySettingsChanged = graphVersion !== current.graph_version || appId !== current.app_id;
    updateConnection(this.database, id, {
      name: (input.name ?? current.name).trim(),
      appId,
      graphVersion,
      invalidate: identitySettingsChanged,
      ...(tokenChanged ? { accessToken: this.vault.encrypt(id, input.accessToken!) } : {}),
    });
    this.discovered.delete(id);
    return this.publicConnection(id);
  }

  async update(id: string, input: EditConnectionInput) {
    return this.edit(id, input);
  }

  async testConnection(id: string): Promise<ConnectionValidation> {
    getConnectionCredential(this.database, id);
    const validation = await this.provider.validateConnection(id);
    const persisted = saveConnectionValidation(this.database, id, validation);
    if (persisted.status !== 'valid') this.discovered.delete(id);
    return persisted;
  }

  async discoverAccounts(id: string): Promise<DiscoveredAccount[]> {
    const connection = getConnectionSummary(this.database, id);
    if (connection.status !== 'valid' || connection.monitoring_paused) {
      throw new Error('Validate the connection before discovering accounts');
    }

    const accounts = await this.provider.discoverAccounts(id);
    const safeAccounts = accounts.map((account) => ({
      providerAccountId: account.providerAccountId,
      username: account.username,
      displayName: account.displayName,
      accountType: account.accountType,
      relatedPageId: account.relatedPageId,
      capabilities: [...account.capabilities],
    }));
    this.discovered.set(id, safeAccounts);
    return safeAccounts;
  }

  async selectAccount(id: string, candidate: DiscoveredAccount, options: { adopt?: boolean } = {}) {
    const connection = getConnectionSummary(this.database, id);
    if (connection.status !== 'valid' || connection.monitoring_paused) {
      throw new Error('Validate the connection before selecting an account');
    }

    const normalized = normalizeUsername(candidate.username);
    const verified = (this.discovered.get(id) ?? []).find((account) =>
      account.providerAccountId === candidate.providerAccountId
      && normalizeUsername(account.username) === normalized);
    if (!verified) throw new Error('Select an account from the latest provider discovery results');

    const matches = this.database.prepare(`SELECT s.account_id, s.connection_id, c.status AS owner_status
      FROM social_accounts s LEFT JOIN connections c ON c.id = s.connection_id
      WHERE s.provider_account_id = ? OR s.normalized_username = ?`)
      .all(verified.providerAccountId, normalized) as Array<{ account_id: string; connection_id: string; owner_status: string | null }>;
    if (matches.length > 1) {
      throw new RepositoryConflictError('This physical Instagram account is already managed or tombstoned under another connection');
    }
    // Only a disconnected (or deleted) owner can hand its account over, and only after explicit confirmation.
    const foreign = matches.find((row) => row.connection_id !== id);
    if (foreign) {
      if (foreign.owner_status !== 'disconnected') {
        throw new RepositoryConflictError('This physical Instagram account is already managed or tombstoned under another connection');
      }
      if (!options.adopt) throw new AccountAdoptionRequiredError();
    }

    const accountId = matches[0]?.account_id ?? randomUUID();
    const derivedToken = await this.provider.credentialForSelectedAccount(id, verified);
    if (getConnectionSummary(this.database, id).status !== 'valid') {
      throw new Error('Connection changed during account validation; retry after revalidation');
    }

    // One transaction: the ownership change and its page token land together or not at all.
    this.database.exec('BEGIN IMMEDIATE');
    try {
      addDiscoveredAccount(this.database, {
        accountId,
        connectionId: id,
        providerAccountId: verified.providerAccountId,
        username: verified.username,
        displayName: verified.displayName,
        accountType: verified.accountType,
        relatedPageId: verified.relatedPageId,
        status: 'valid',
        capabilities: verified.capabilities,
        adopt: options.adopt === true,
      });
      if (derivedToken) {
        saveAccountPageToken(this.database, accountId, this.vault.encrypt(`account:${accountId}`, derivedToken));
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return getAccountSummary(this.database, accountId);
  }

  listAccounts(connectionId: string) {
    return listAccountSummaries(this.database, connectionId);
  }

  async listMedia(accountId: string) {
    const account = getAccountSummary(this.database, accountId);
    const connection = getConnectionSummary(this.database, account.connectionId);
    if (account.status !== 'valid' || connection.status !== 'valid' || connection.monitoring_paused) {
      throw new Error('Account is not currently validated');
    }

    const page = await this.provider.listMedia(account);
    for (const media of page.items) {
      createMediaIfMissing(this.database, {
        accountId, mediaId: media.mediaId, permalink: media.permalink ?? null, publishedAt: media.publishedAt ?? null,
        caption: media.caption ?? null, mediaType: media.mediaType ?? null,
      });
    }
    return listMedia(this.database, accountId);
  }

  async disconnect(id: string) {
    getConnectionSummary(this.database, id);
    disconnectConnection(this.database, id, false);
    this.discovered.delete(id);
  }

  async delete(id: string) {
    getConnectionSummary(this.database, id);
    disconnectConnection(this.database, id, true);
    this.discovered.delete(id);
  }

  private publicConnection(id: string) {
    const { capabilities_json: capabilitiesJson, ...safe } = getConnectionSummary(this.database, id);
    return { ...safe, capabilities: parseCapabilities(capabilitiesJson) };
  }
}

function normalizeUsername(username: string): string {
  return username.normalize('NFC').trim().replace(/^@/u, '').toLocaleLowerCase('und');
}

function parseCapabilities(json?: string): string[] {
  try {
    const value: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
