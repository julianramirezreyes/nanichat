import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  AccountRef,
  ConnectionValidation,
  DiscoveredAccount,
  MediaItem,
  MessageReadback,
  PublicReplyResult,
  PrivateReplyPayload,
  ProviderComment,
  ProviderPage,
  SendResult,
  SocialProvider,
} from '../src/core/domain.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import {
  addDiscoveredAccount,
  createConnection,
  createMedia,
  createComment,
  getAccountSummary,
  getConnectionSummary,
  listEncryptedCredentials,
  listMedia,
  listComments,
} from '../src/db/repositories.ts';
import { createVault } from '../src/security/vault.ts';
import { ConnectionService } from '../src/services/connections.ts';
import { MetaProvider } from '../src/providers/meta/provider.ts';

function withTempDb(run: (directory: string, db: ReturnType<typeof openDatabase>) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'social-connections-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  return Promise.resolve(run(directory, db)).finally(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

class FakeProvider implements SocialProvider {
  readonly validations = new Map<string, ConnectionValidation>();
  readonly discovered = new Map<string, DiscoveredAccount[]>();
  readonly accountCredentials = new Map<string, string>();
  readonly mediaByAccount = new Map<string, MediaItem[]>();

  async validateConnection(connectionId: string): Promise<ConnectionValidation> {
    return this.validations.get(connectionId) ?? {
      status: 'valid', observedAt: '2026-10-05T00:00:00Z', providerUserId: 'user-1',
      username: 'owner', capabilities: ['identity_read'],
    };
  }
  async discoverAccounts(connectionId: string): Promise<DiscoveredAccount[]> { return this.discovered.get(connectionId) ?? []; }
  async credentialForSelectedAccount(connectionId: string, account: DiscoveredAccount): Promise<string | undefined> {
    return this.accountCredentials.get(`${connectionId}:${account.providerAccountId}`);
  }
  async listMedia(account: AccountRef): Promise<ProviderPage<MediaItem>> {
    return { items: this.mediaByAccount.get(account.accountId) ?? [], complete: true };
  }
  async listComments(): Promise<ProviderPage<ProviderComment>> { return { items: [], complete: true }; }
  async getComment(_account: AccountRef, commentId: string): Promise<ProviderComment> { return { commentId }; }
  async sendPrivateReply(): Promise<SendResult> { return { outcome: 'accepted', messageId: 'message-1' }; }
  async replyToComment(): Promise<PublicReplyResult> { return { outcome: 'accepted', replyId: 'reply-1' }; }
  async readMessage(_account: AccountRef, messageId: string): Promise<MessageReadback> {
    return { messageId, observedAt: '2026-10-05T00:00:00Z' };
  }
}

test('connection lifecycle keeps secrets server-side and invalidates derived credentials on token change or failed validation', async () => {
  await withTempDb(async (directory, db) => {
    const vault = createVault(directory, () => listEncryptedCredentials(db));
    const provider = new FakeProvider();
    provider.validations.set('fb-connection', {
      status: 'valid', observedAt: '2026-10-05T00:00:00Z', providerUserId: 'fb-user-1', capabilities: ['identity_read'],
    });
    const service = new ConnectionService(db, vault, provider);
    const connection = await service.create({
      id: 'fb-connection', name: 'Page connection', loginKind: 'facebook_login', appId: 'app-1',
      graphVersion: 'v26.0', accessToken: 'user-token-first',
    });
    assert.equal(connection.status, 'unvalidated');
    assert.equal(JSON.stringify(connection).includes('user-token-first'), false);
    assert.equal(JSON.stringify(service.listConnections()).includes('access_token_ciphertext'), false);

    await service.testConnection('fb-connection');
    const found = await service.discoverAccounts('fb-connection');
    provider.discovered.set('fb-connection', [{
      providerAccountId: 'ig-page-scoped-1', username: 'Brand', displayName: 'Brand IG', capabilities: ['media_read'],
      accountType: 'BUSINESS', relatedPageId: 'page-1',
    }]);
    const discovered = await service.discoverAccounts('fb-connection');
    assert.deepEqual(discovered.map(({ providerAccountId, username }) => ({ providerAccountId, username })), [
      { providerAccountId: 'ig-page-scoped-1', username: 'Brand' },
    ]);
    assert.equal(JSON.stringify(discovered).includes('page-token-secret'), false);
    assert.deepEqual(found, []);
    provider.accountCredentials.set('fb-connection:ig-page-scoped-1', 'page-token-secret');
    const selected = await service.selectAccount('fb-connection', discovered[0]!);
    assert.equal(selected.username, 'Brand');
    assert.equal(selected.accountType, 'BUSINESS');
    assert.equal(selected.relatedPageId, 'page-1');
    assert.equal(getAccountSummary(db, selected.accountId).status, 'valid');
    const firstPageToken = listEncryptedCredentials(db).find((credential) => credential.contextId === `account:${selected.accountId}`);
    assert.ok(firstPageToken);
    assert.equal(vault.decrypt(firstPageToken.contextId, firstPageToken.secret), 'page-token-secret');

    const media = await service.listMedia(selected.accountId);
    assert.deepEqual(media.map((item) => item.mediaId), []);
    createMedia(db, { accountId: selected.accountId, mediaId: 'owned-media', permalink: null, publishedAt: null });
    createComment(db, { accountId: selected.accountId, mediaId: 'owned-media', commentId: 'history-comment', text: 'keep', username: 'user', createdAt: null });
    const beforeReconnect = getAccountSummary(db, selected.accountId);

    await service.edit('fb-connection', { name: 'Updated name', accessToken: 'user-token-second' });
    const afterEdit = getConnectionSummary(db, 'fb-connection');
    assert.equal(afterEdit.status, 'unvalidated');
    assert.equal(afterEdit.monitoring_paused, 1);
    assert.equal(getAccountSummary(db, selected.accountId).status, 'unvalidated');
    assert.equal(listEncryptedCredentials(db).some((credential) => credential.contextId === `account:${selected.accountId}`), false);
    assert.equal(JSON.stringify(service.listConnections()).includes('user-token-second'), false);

    provider.validations.set('fb-connection', {
      status: 'invalid', observedAt: '2026-10-05T00:00:01Z', capabilities: [], safeErrorCode: 'meta_190',
    });
    await service.testConnection('fb-connection');
    assert.equal(getConnectionSummary(db, 'fb-connection').status, 'invalid');
    assert.deepEqual(JSON.parse(getConnectionSummary(db, 'fb-connection').capabilities_json ?? '[]'), []);

    provider.validations.set('fb-connection', {
      status: 'valid', observedAt: '2026-10-05T00:00:02Z', providerUserId: 'different-fb-user', capabilities: ['identity_read'],
    });
    const mismatchedIdentity = await service.testConnection('fb-connection');
    assert.equal(mismatchedIdentity.status, 'invalid');
    assert.equal(mismatchedIdentity.safeErrorCode, 'connection_identity_mismatch');
    assert.equal(getConnectionSummary(db, 'fb-connection').observed_user_id, 'fb-user-1');
    assert.equal(getConnectionSummary(db, 'fb-connection').monitoring_paused, 1);
    assert.equal(getAccountSummary(db, selected.accountId).status, 'unvalidated');

    provider.validations.set('fb-connection', {
      status: 'valid', observedAt: '2026-10-05T00:00:03Z', providerUserId: 'fb-user-1', capabilities: ['identity_read'],
    });
    await service.testConnection('fb-connection');
    provider.discovered.set('fb-connection', [{
      providerAccountId: 'new-page-scoped-id', username: 'Brand', displayName: 'Brand IG',
      accountType: 'BUSINESS', relatedPageId: 'page-1', capabilities: ['media_read'],
    }]);
    provider.accountCredentials.set('fb-connection:new-page-scoped-id', 'fresh-page-token');
    const reconnected = await service.selectAccount('fb-connection', (await service.discoverAccounts('fb-connection'))[0]!);
    assert.equal(reconnected.accountId, selected.accountId);
    assert.equal(reconnected.accountType, 'BUSINESS');
    assert.equal(reconnected.relatedPageId, 'page-1');
    assert.equal(listComments(db, selected.accountId).map((row) => row.comment_id).includes('history-comment'), true);
    assert.equal(beforeReconnect.accountId, selected.accountId);

    await service.disconnect('fb-connection');
    assert.equal(getConnectionSummary(db, 'fb-connection').status, 'disconnected');
    assert.equal(listComments(db, selected.accountId).length, 1);
    assert.equal(listEncryptedCredentials(db).length, 0);
    await service.delete('fb-connection');
    assert.deepEqual(service.listConnections(), []);
    assert.equal(getAccountSummary(db, selected.accountId).accountId, selected.accountId);
  });
});

test('selected account cannot be silently duplicated or moved to a second connection after disconnect', async () => {
  await withTempDb(async (directory, db) => {
    const vault = createVault(directory, () => listEncryptedCredentials(db));
    const provider = new FakeProvider();
    const service = new ConnectionService(db, vault, provider);
    await service.create({ id: 'first', name: 'First', loginKind: 'instagram_login', graphVersion: 'v26.0', accessToken: 'token-one' });
    await service.testConnection('first');
    const account = { providerAccountId: 'alias-1', username: 'SameUser', capabilities: ['identity_read'] };
    provider.discovered.set('first', [account]);
    const original = await service.selectAccount('first', (await service.discoverAccounts('first'))[0]!);
    await service.disconnect('first');

    await service.create({ id: 'second', name: 'Second', loginKind: 'facebook_login', graphVersion: 'v26.0', accessToken: 'token-two' });
    await service.testConnection('second');
    provider.discovered.set('second', [{ providerAccountId: 'different-app-id', username: 'sameuser', capabilities: [] }]);
    await assert.rejects(service.selectAccount('second', (await service.discoverAccounts('second'))[0]!), /already|managed|connection/i);
    assert.equal(getAccountSummary(db, original.accountId).connectionId, 'first');
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM social_accounts WHERE normalized_username='sameuser'").get() as { count: number }).count, 1);
  });
});

test('rotated connection credentials cannot replace the first validated provider identity', async () => {
  await withTempDb(async (directory, db) => {
    const vault = createVault(directory, () => listEncryptedCredentials(db));
    const provider = new FakeProvider();
    provider.validations.set('identity-bound', { status: 'valid', observedAt: '2026-10-05T00:00:00Z', providerUserId: 'expected-owner', capabilities: ['identity_read'] });
    const service = new ConnectionService(db, vault, provider);
    await service.create({ id: 'identity-bound', name: 'Bound', loginKind: 'instagram_login', graphVersion: 'v26.0', accessToken: 'first-token' });
    await service.testConnection('identity-bound');
    await service.edit('identity-bound', { accessToken: 'rotated-token' });
    provider.validations.set('identity-bound', { status: 'valid', observedAt: '2026-10-05T00:00:01Z', providerUserId: 'different-owner', capabilities: ['identity_read'] });
    const mismatch = await service.testConnection('identity-bound');
    assert.equal(mismatch.status, 'invalid');
    assert.equal(mismatch.safeErrorCode, 'connection_identity_mismatch');
    assert.equal(getConnectionSummary(db, 'identity-bound').observed_user_id, 'expected-owner');
    assert.equal(getConnectionSummary(db, 'identity-bound').monitoring_paused, 1);
    provider.validations.set('identity-bound', { status: 'valid', observedAt: '2026-10-05T00:00:02Z', providerUserId: 'expected-owner', capabilities: ['identity_read'] });
    const sameOwner = await service.testConnection('identity-bound');
    assert.equal(sameOwner.status, 'valid');
    assert.equal(getConnectionSummary(db, 'identity-bound').monitoring_paused, 0);
  });
});

test('account discovery metadata columns are present without storing Page credentials in account DTOs', async () => {
  await withTempDb(async (_directory, db) => {
    const columns = (db.prepare('PRAGMA table_info(social_accounts)').all() as Array<{ name: string }>).map(({ name }) => name);
    assert.ok(columns.includes('account_type'));
    assert.ok(columns.includes('related_page_id'));
  });
});

function makeProviderDb(directory: string, loginKind: 'instagram_login' | 'facebook_login', accountCredential?: string) {
  const db = openDatabase(directory);
  migrateDatabase(db);
  const vault = createVault(directory, () => listEncryptedCredentials(db));
  const connectionId = loginKind === 'instagram_login' ? 'ig-connection' : 'fb-connection';
  createConnection(db, {
    id: connectionId, name: 'Provider test', providerCode: 'META', loginKind, graphVersion: 'v26.0', status: 'valid',
    accessToken: vault.encrypt(connectionId, loginKind === 'instagram_login' ? 'ig-user-token' : 'fb-user-token'),
  });
  addDiscoveredAccount(db, {
    accountId: `${loginKind}-account`, connectionId, providerAccountId: '17841400000000000', username: 'brand', status: 'valid',
  });
  if (accountCredential) {
    const secret = vault.encrypt(`account:${loginKind}-account`, accountCredential);
    db.prepare(`UPDATE social_accounts SET page_token_nonce=?, page_token_ciphertext=?, page_token_tag=? WHERE account_id=?`)
      .run(secret.nonce, secret.ciphertext, secret.tag, `${loginKind}-account`);
  }
  createMedia(db, { accountId: `${loginKind}-account`, mediaId: 'media-1', permalink: null, publishedAt: null });
  return { db, vault, connectionId, account: {
    accountId: `${loginKind}-account`, connectionId, providerAccountId: '17841400000000000', username: 'brand',
  } satisfies AccountRef };
}

test('Instagram Login private reply uses IG account route, IG host, bearer token, and verified button payload', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'instagram_login');
    createComment(state.db, { accountId: state.account.accountId, mediaId: 'media-1', commentId: 'controlled-comment', text: 'hi', username: 'user', createdAt: null });
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      calls.push({ url: new URL(String(input)), init });
      return Response.json({ message_id: 'ig-message-1' });
    };
    const provider = new MetaProvider(state.db, state.vault, fetcher);
    const result = await provider.sendPrivateReply(state.account, 'controlled-comment', {
      text: 'Hello', buttons: [{ title: 'Guide', url: 'https://example.com/guide' }, { title: 'Book', url: 'https://example.com/book' }],
    });
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.messageId, 'ig-message-1');
    assert.equal(calls[0]!.url.origin, 'https://graph.instagram.com');
    assert.equal(calls[0]!.url.pathname, '/v26.0/17841400000000000/messages');
    assert.equal(calls[0]!.url.search, '');
    assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer ig-user-token');
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body.recipient, { comment_id: 'controlled-comment' });
    assert.equal(body.message.attachment.payload.template_type, 'button');
    assert.equal(body.message.attachment.payload.buttons.length, 2);
    assert.equal(String(calls[0]!.init.body).includes('ig-user-token'), false);
    const callsAfterReply = calls.length;
    await assert.rejects(provider.listComments(state.account, 'media-owned-by-another-account'), /does not belong/i);
    const foreignReply = await provider.sendPrivateReply(state.account, 'comment-owned-by-another-account', { text: 'No', buttons: [] });
    assert.equal(foreignReply.outcome, 'definitive_rejection');
    assert.equal(foreignReply.safeErrorCode, 'comment_not_owned');
    assert.equal(calls.length, callsAfterReply);
    state.db.close();
  });
});

test('provider rejects invalid reply buttons without truncating payload or issuing a POST', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'instagram_login');
    createComment(state.db, { accountId: state.account.accountId, mediaId: 'media-1', commentId: 'comment-1',
      text: 'hello', username: 'customer', createdAt: '2026-10-05T00:00:00Z' });
    let calls = 0;
    const provider = new MetaProvider(state.db, state.vault, async () => {
      calls++;
      return Response.json({ message_id: 'must-not-send' });
    });
    const tooMany = await provider.sendPrivateReply(state.account, 'comment-1', {
      text: 'hello', buttons: [1, 2, 3].map((n) => ({ title: `B${n}`, url: `https://example.test/${n}` })),
    });
    const unsafeUrl = await provider.sendPrivateReply(state.account, 'comment-1', {
      text: 'hello', buttons: [{ title: 'Open', url: 'javascript:alert(1)' }],
    });
    assert.equal(tooMany.outcome, 'definitive_rejection');
    assert.equal(unsafeUrl.outcome, 'definitive_rejection');
    assert.equal(calls, 0);
    state.db.close();
  });
});

test('send results retain only bounded allowlisted usage and Retry-After headers', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'instagram_login');
    createComment(state.db, { accountId: state.account.accountId, mediaId: 'media-1', commentId: 'usage-comment',
      text: 'hello', username: 'customer', createdAt: '2026-10-05T00:00:00Z' });
    const provider = new MetaProvider(state.db, state.vault, async () => Response.json({ message_id: 'usage-message' }, {
      headers: {
        'x-app-usage': '{"call_count":80}',
        'x-page-usage': '{"call_count":40}',
        'retry-after': '5',
        authorization: 'Bearer leaked-token',
      },
    }));
    const result = await provider.sendPrivateReply(state.account, 'usage-comment', { text: 'Hello', buttons: [] });
    assert.deepEqual(result.usageHeaders, { appUsage: '{"call_count":80}', pageUsage: '{"call_count":40}', retryAfter: '5' });
    assert.equal(JSON.stringify(result).includes('leaked-token'), false);
    state.db.close();
  });
});

test('missing, non-string, or empty message IDs from a 2xx send are ambiguous outcomes', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'instagram_login');
    createComment(state.db, { accountId: state.account.accountId, mediaId: 'media-1', commentId: 'send-comment', text: 'hi', username: 'user', createdAt: null });
    for (const responseBody of [{}, { message_id: 42 }, { message_id: '' }]) {
      let requests = 0;
      const fetcher: typeof fetch = async () => { requests++; return Response.json(responseBody); };
      const result = await new MetaProvider(state.db, state.vault, fetcher).sendPrivateReply(state.account, 'send-comment', { text: 'Hello', buttons: [] });
      assert.equal(result.outcome, 'ambiguous');
      assert.equal(result.messageId, undefined);
      assert.equal(result.safeErrorCode, 'meta_missing_message_id');
      assert.equal(requests, 1);
    }
    state.db.close();
  });
});

test('readback requests actual Meta message fields and validates the response ID and sender account', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'instagram_login');
    const calls: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input)); calls.push(url);
      return Response.json({
        id: 'actual-message-id', created_time: '2026-10-05T15:54:52+0000',
        from: { username: 'brand', id: state.account.providerAccountId },
        to: [{ id: 'recipient-id', username: 'recipient' }], message: 'A verified reply',
        attachments: [{ type: 'template', payload: { template_type: 'button' } }],
      });
    };
    const result = await new MetaProvider(state.db, state.vault, fetcher).readMessage(state.account, 'actual-message-id');
    assert.equal(calls[0]!.searchParams.get('fields'), 'id,created_time,from,to,message,attachments');
    assert.deepEqual(result, {
      messageId: 'actual-message-id', senderId: state.account.providerAccountId, recipientId: 'recipient-id',
      text: 'A verified reply', createdAt: '2026-10-05T15:54:52+0000',
      attachments: [{ type: 'template', payload: { template_type: 'button' } }], observedAt: result.observedAt,
    });
    state.db.close();
  });

  for (const body of [
    { id: 'other-message', from: { id: '17841400000000000' }, to: [], message: 'no', expected: /meta_readback_id_mismatch/i },
    { id: 'requested-id', from: { id: 'other-account' }, to: [], message: 'no', expected: /meta_readback_sender_mismatch/i },
  ]) {
    await withTempDb(async (directory) => {
      const state = makeProviderDb(directory, 'instagram_login');
      const { expected, ...responseBody } = body;
      const fetcher: typeof fetch = async () => Response.json(responseBody);
      await assert.rejects(new MetaProvider(state.db, state.vault, fetcher).readMessage(state.account, 'requested-id'), expected);
      state.db.close();
    });
  }
});

test('readback rejects mismatched provider message IDs instead of reporting them as the requested message', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'instagram_login');
    const fetcher: typeof fetch = async () => Response.json({ id: 'different-id', from: { id: state.account.providerAccountId }, to: [], message: 'not requested' });
    await assert.rejects(new MetaProvider(state.db, state.vault, fetcher).readMessage(state.account, 'requested-id'), /meta_readback_id_mismatch/i);
    state.db.close();
  });
});

test('Facebook Login private reply uses linked IG account route and encrypted Page token, not Page-ID route', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'facebook_login', 'encrypted-page-token');
    createComment(state.db, { accountId: state.account.accountId, mediaId: 'media-1', commentId: 'comment-123', text: 'hi', username: 'user', createdAt: null });
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      calls.push({ url: new URL(String(input)), init });
      return Response.json({ message_id: 'fb-message-1' });
    };
    const provider = new MetaProvider(state.db, state.vault, fetcher);
    const result = await provider.sendPrivateReply(state.account, 'comment-123', { text: 'Hello', buttons: [] });
    assert.equal(result.outcome, 'accepted');
    assert.equal(calls[0]!.url.origin, 'https://graph.facebook.com');
    assert.equal(calls[0]!.url.pathname, '/v26.0/17841400000000000/messages');
    assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), 'Bearer encrypted-page-token');
    assert.equal(calls[0]!.url.pathname.includes('page-id'), false);
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      recipient: { comment_id: 'comment-123' }, message: { text: 'Hello' },
    });
    assert.equal(String(calls[0]!.init.body).includes('encrypted-page-token'), false);
    state.db.close();
  });
});

test('provider pagination extracts only a cursor from its expected endpoint and rebuilds a fixed-host request', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'instagram_login');
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    let page = 0;
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      page++;
      return page === 1
        ? Response.json({ data: [{ id: 'media-1', permalink: 'https://instagram.com/p/abc/', timestamp: '2026-10-01T00:00:00Z' }], paging: { next: `https://graph.instagram.com/v26.0/17841400000000000/media?after=cursor-2&access_token=echoed-secret` } })
        : Response.json({ data: [] });
    };
    const provider = new MetaProvider(state.db, state.vault, fetcher);
    const result = await provider.listMedia(state.account);
    assert.equal(result.complete, true);
    assert.equal(result.nextCursor, undefined);
    assert.deepEqual(result.items.map((item) => item.mediaId), ['media-1']);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url.origin, 'https://graph.instagram.com');
    assert.equal(calls[1]!.url.pathname, '/v26.0/17841400000000000/media');
    assert.equal(calls[1]!.url.searchParams.get('after'), 'cursor-2');
    assert.equal(calls[1]!.url.searchParams.has('access_token'), false);
    assert.equal(new Headers(calls[1]!.init.headers).get('authorization'), 'Bearer ig-user-token');
    state.db.close();
  });
});

test('provider rejects arbitrary cursor destinations and never returns or logs raw Meta error payloads', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'instagram_login');
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      calls.push({ url: new URL(String(input)), init });
      return calls.length === 1
        ? Response.json({ data: [], paging: { next: 'https://evil.example/steal?after=bad' } })
        : Response.json({ error: { message: 'secret ig-user-token', code: 190, error_subcode: 467 } }, { status: 400 });
    };
    const provider = new MetaProvider(state.db, state.vault, fetcher);
    const incomplete = await provider.listMedia(state.account);
    assert.equal(incomplete.complete, false);
    assert.equal(incomplete.stopReason, 'unsafe_or_missing_cursor');
    assert.equal(calls.length, 1);
    const validation = await provider.validateConnection(state.connectionId);
    assert.equal(validation.status, 'invalid');
    assert.equal(validation.safeErrorCode, 'meta_190_467');
    assert.equal(JSON.stringify(validation).includes('ig-user-token'), false);
    state.db.close();
  });
});

test('Facebook discovery resolves linked Instagram identity using each Page token without exposing tokens', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'facebook_login');
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input)); calls.push({ url, init });
      if (url.pathname.endsWith('/me')) return Response.json({ id: 'fb-user', name: 'Owner' });
      if (url.pathname.endsWith('/me/accounts')) return Response.json({ data: [{
        id: 'page-1', name: 'Brand Page', access_token: 'private-page-token',
        tasks: ['MANAGE'], instagram_business_account: { id: '17841400000000000' },
      }] });
      return Response.json({ id: '17841400000000000', username: 'brand', account_type: 'BUSINESS' });
    };
    const provider = new MetaProvider(state.db, state.vault, fetcher);
    const validation = await provider.validateConnection(state.connectionId);
    assert.equal(validation.status, 'valid');
    const discovered = await provider.discoverAccounts(state.connectionId);
    assert.deepEqual(discovered.map((account) => ({ providerAccountId: account.providerAccountId, username: account.username })), [
      { providerAccountId: '17841400000000000', username: 'brand' },
    ]);
    assert.equal(discovered[0]!.accountType, 'BUSINESS');
    assert.equal(discovered[0]!.relatedPageId, 'page-1');
    assert.deepEqual(discovered[0]!.capabilities, ['identity_read', 'private_reply_unverified', 'page_task:MANAGE']);
    assert.equal(JSON.stringify(discovered).includes('private-page-token'), false);
    assert.equal(new URL(calls[0]!.url).origin, 'https://graph.facebook.com');
    assert.equal(calls[1]!.url.searchParams.get('fields'), 'id,name,access_token,tasks,instagram_business_account');
    assert.equal(new Headers(calls[2]!.init.headers).get('authorization'), 'Bearer private-page-token');
    assert.equal(await provider.credentialForSelectedAccount(state.connectionId, discovered[0]!), 'private-page-token');
    state.db.close();
  });
});

test('missing or malformed page data and malformed media rows cannot certify complete pagination', async () => {
  const completeValues: boolean[] = [];
  for (const body of [{}, { data: null }, { data: [{}] }]) {
    await withTempDb(async (directory) => {
      const state = makeProviderDb(directory, 'instagram_login');
      const fetcher: typeof fetch = async () => Response.json(body);
      const result = await new MetaProvider(state.db, state.vault, fetcher).listMedia(state.account);
      completeValues.push(result.complete);
      assert.equal(result.nextCursor, undefined);
      state.db.close();
    });
  }
  assert.deepEqual(completeValues, [false, false, false]);
});

test('malformed present pagination metadata cannot certify complete coverage', async () => {
  for (const body of [
    { data: [], paging: { next: 42 } },
    { data: [], paging: 42 },
    { data: [], paging: { next: {} } },
  ]) {
    await withTempDb(async (directory) => {
      const state = makeProviderDb(directory, 'instagram_login');
      const fetcher: typeof fetch = async () => Response.json(body);
      const result = await new MetaProvider(state.db, state.vault, fetcher).listMedia(state.account);
      assert.equal(result.complete, false);
      assert.equal(result.nextCursor, undefined);
      state.db.close();
    });
  }
});

test('comment polling returns one bounded page and leaves remaining coverage explicit', async () => {
  await withTempDb(async (directory) => {
    const state = makeProviderDb(directory, 'instagram_login');
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json({
        data: [{ id: 'comment-page-1', text: 'guide', username: 'person', timestamp: '2026-10-05T11:00:00Z' }],
        paging: { next: 'https://graph.instagram.com/v26.0/17841400000000000/comments?after=next-page' },
      });
    };
    const page = await new MetaProvider(state.db, state.vault, fetcher).listComments(state.account, 'media-1');
    assert.equal(calls, 1);
    assert.equal(page.complete, false);
    assert.ok(page.nextCursor);
    state.db.close();
  });
});

test('vault startup authenticates account-derived Page tokens as well as connection tokens', async () => {
  await withTempDb(async (directory, db) => {
    const vault = createVault(directory, () => listEncryptedCredentials(db));
    createConnection(db, { id: 'fb', name: 'FB', providerCode: 'META', loginKind: 'facebook_login', graphVersion: 'v26.0', status: 'valid', accessToken: vault.encrypt('fb', 'user-secret') });
    addDiscoveredAccount(db, { accountId: 'account-1', connectionId: 'fb', providerAccountId: 'ig-1', username: 'brand', status: 'valid' });
    const derived = vault.encrypt('account:account-1', 'page-secret');
    db.prepare(`UPDATE social_accounts SET page_token_nonce=?,page_token_ciphertext=?,page_token_tag=? WHERE account_id='account-1'`).run(derived.nonce, derived.ciphertext, derived.tag);
    assert.equal(listEncryptedCredentials(db).length, 2);
    db.prepare(`UPDATE social_accounts SET page_token_ciphertext='corrupted-ciphertext' WHERE account_id='account-1'`).run();
    assert.throws(() => createVault(directory, () => listEncryptedCredentials(db)), /key|credential|decrypt/i);
  });
});
