import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AccountRef, MessageReadback } from '../src/core/domain.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { MetaProvider } from '../src/providers/meta/provider.ts';
import { createVault } from '../src/security/vault.ts';
import { listEncryptedCredentials } from '../src/db/repositories.ts';
import { AutomationService } from '../src/services/automations.ts';
import { QueueService } from '../src/services/queue.ts';

type Db = ReturnType<typeof openDatabase>;

async function withDb(run: (db: Db, directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'readback-fix-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  try { await run(db, directory); } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}

function providerState(db: Db, directory: string) {
  const vault = createVault(directory, () => listEncryptedCredentials(db));
  createConnection(db, { id: 'ig', name: 'p', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid', accessToken: vault.encrypt('ig', 'tok') });
  addDiscoveredAccount(db, { accountId: 'acc', connectionId: 'ig', providerAccountId: '29055718337365262', username: 'ModoVerbo', status: 'valid' });
  const account: AccountRef = { accountId: 'acc', connectionId: 'ig', providerAccountId: '29055718337365262', username: 'ModoVerbo' };
  return { vault, account };
}

const readbackBody = (from: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  id: 'mid', created_time: '2026-10-05T15:56:57+0000', from, to: [{ id: 'recipient' }], message: 'hello', ...extra,
});

async function read(from: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  let result: MessageReadback | undefined;
  let failure: unknown;
  await withDb(async (db, directory) => {
    const { vault, account } = providerState(db, directory);
    const fetcher: typeof fetch = async () => Response.json(readbackBody(from, extra));
    try { result = await new MetaProvider(db, vault, fetcher).readMessage(account, 'mid'); } catch (error) { failure = error; }
  });
  return { result, failure };
}

test('readback accepts the sender when its username aliases the account username', async () => {
  const { result, failure } = await read({ username: ' @modoverbo'.replace('@', ''), id: '17841475720699099' });
  assert.equal(failure, undefined);
  assert.equal(result?.messageId, 'mid');
});

test('readback rejects a wrong sender id with a different username, and a sender with neither', async () => {
  for (const from of [{ id: 'other', username: 'someoneelse' }, { id: 'other', username: '   ' }, { id: 'other' }, undefined]) {
    const { failure } = await read(from);
    assert.match(String(failure), /meta_readback_sender_mismatch/);
  }
});

test('readback still rejects a different message id or a missing recipient even with a matching username', async () => {
  const mismatch = await read({ username: 'modoverbo', id: 'x' }, { id: 'different' });
  assert.match(String(mismatch.failure), /meta_readback_id_mismatch/);
  const noRecipient = await read({ username: 'modoverbo', id: 'x' }, { to: [] });
  assert.match(String(noRecipient.failure), /meta_readback_no_recipient/);
});

test('readback maps the real object-shaped generic_template attachments with bounded cta buttons', async () => {
  const { result } = await read({ username: 'modoverbo', id: 'x' }, {
    message: '',
    attachments: { data: [{ generic_template: { title: 'TEST', cta: [
      { title: 'Prueba 1', url: 'https://example.com', type: 'web_url' },
      { title: 'Prueba 2', url: 'https://example.org', type: 'web_url' },
      { title: 5, url: null }, 'junk',
    ] } }, 'junk', { generic_template: 'bad' }], paging: {} },
  });
  assert.deepEqual(result?.templates, [{ title: 'TEST', buttons: [
    { title: 'Prueba 1', url: 'https://example.com', type: 'web_url' },
    { title: 'Prueba 2', url: 'https://example.org', type: 'web_url' },
  ] }]);
  const many = await read({ username: 'modoverbo', id: 'x' }, { attachments: { data: Array.from({ length: 50 }, () => ({ generic_template: { title: 't'.repeat(900), cta: Array.from({ length: 50 }, () => ({ title: 'b', url: 'https://e.com', type: 'web_url' })) } })) } });
  assert.ok((many.result?.templates?.length ?? 99) <= 5);
  assert.ok((many.result?.templates?.[0]?.buttons.length ?? 99) <= 10);
  assert.ok((many.result?.templates?.[0]?.title?.length ?? 999) <= 640);
});

// ---- queue service ----

function seedQueue(db: Db, opts: { state?: string; payload?: unknown; accountId?: string } = {}) {
  const accountId = opts.accountId ?? 'account';
  createConnection(db, { id: `conn-${accountId}`, name: 't', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
  addDiscoveredAccount(db, { accountId, connectionId: `conn-${accountId}`, providerAccountId: `prov-${accountId}`, username: `brand${accountId}`, status: 'valid' });
  createMedia(db, { accountId, mediaId: 'media', permalink: null, publishedAt: null });
  createComment(db, { accountId, mediaId: 'media', commentId: 'c1', text: 'guide', username: 'customer', createdAt: new Date().toISOString() });
  const automations = new AutomationService(db);
  const automationId = automations.create({ accountId, mediaId: 'media', name: 'a', replyText: 'x' });
  const now = new Date().toISOString();
  const queueItemId = `q-${accountId}`;
  db.prepare(`INSERT INTO queue_items(queue_item_id, account_id, comment_id, automation_id, state, dry_run, payload_json, created_at, updated_at)
    VALUES (?,?,?,?,?,0,?,?,?)`).run(queueItemId, accountId, 'c1', automationId, opts.state ?? 'SENT',
    JSON.stringify(opts.payload ?? { text: 'Hola', buttons: [{ title: 'Guía', url: 'https://example.com/g' }], accepted_message_id: 'mid-1' }), now, now);
  db.prepare(`INSERT INTO send_attempts(attempt_event_id, account_id, queue_item_id, event_type, event_at, message_id, details_json)
    VALUES (?,?,?,?,?,?,?)`).run(`acc-${accountId}`, accountId, queueItemId, 'accepted', now, 'mid-1', '{}');
  return { queueItemId, accountId };
}

type FakeOptions = { readback?: () => Promise<MessageReadback> };
function fakeProvider(options: FakeOptions = {}) {
  const calls = { send: 0, read: 0, getComment: 0 };
  const provider = {
    async getComment() { calls.getComment += 1; throw new Error('must not be called'); },
    async sendPrivateReply() { calls.send += 1; throw new Error('must not send'); },
    async readMessage(_a: unknown, messageId: string) {
      calls.read += 1;
      return options.readback ? options.readback() : { messageId, observedAt: new Date().toISOString(), recipientId: 'r' };
    },
  };
  return { provider: provider as never, calls };
}

const events = (db: Db, queueItemId: string) => db.prepare(`SELECT event_type, safe_error_code, details_json FROM send_attempts
  WHERE queue_item_id=? AND event_type='readback' ORDER BY rowid`).all(queueItemId) as Array<{ event_type: string; safe_error_code: string | null; details_json: string }>;

const MATCHING: MessageReadback = {
  messageId: 'mid-1', observedAt: 'now', recipientId: 'r', text: '',
  templates: [{ title: 'Hola', buttons: [{ title: 'Guía', url: 'https://example.com/g', type: 'web_url' }] }],
};

test('re-verification records the real safe error code and never the constant when the provider failed with a coded error', async () => {
  await withDb(async (db) => {
    const { queueItemId } = seedQueue(db);
    const error = Object.assign(new Error('meta_readback_mismatch'), { code: 'meta_readback_mismatch' });
    const { provider } = fakeProvider({ readback: async () => { throw error; } });
    const result = await new QueueService(db, provider).verifyReadback('account', queueItemId);
    assert.equal(result.observed, false);
    assert.equal(result.safeErrorCode, 'meta_readback_mismatch');
    assert.equal(events(db, queueItemId)[0]!.safe_error_code, 'meta_readback_mismatch');
  });
});

test('re-verification classifies http status and falls back to readback_unavailable for unknown errors', async () => {
  await withDb(async (db) => {
    const { queueItemId } = seedQueue(db);
    let n = 0;
    const errors = [Object.assign(new Error('x'), { code: 'meta_api_error', httpStatus: 503 }), new Error('secret raw body token=abc')];
    const { provider } = fakeProvider({ readback: async () => { throw errors[n++]; } });
    let t = 0;
    const service = new QueueService(db, provider, { clock: () => (t += 60_000) });
    const first = await service.verifyReadback('account', queueItemId);
    assert.equal(first.safeErrorCode, 'meta_api_error');
    const second = await service.verifyReadback('account', queueItemId);
    assert.equal(second.safeErrorCode, 'readback_unavailable');
    assert.ok(!JSON.stringify(events(db, queueItemId)).includes('secret'));
  });
});

test('re-verification records match info (text and buttons) without raw payload and changes no state', async () => {
  await withDb(async (db) => {
    const { queueItemId } = seedQueue(db);
    const { provider, calls } = fakeProvider({ readback: async () => MATCHING });
    const result = await new QueueService(db, provider).verifyReadback('account', queueItemId);
    assert.deepEqual({ observed: result.observed, matches: result.matches }, { observed: true, matches: true });
    const recorded = JSON.parse(events(db, queueItemId)[0]!.details_json);
    assert.equal(recorded.observed, true);
    assert.equal(recorded.observedMatches, true);
    assert.equal(recorded.matchReason, 'match');
    assert.ok(!JSON.stringify(recorded).includes('example.com'));
    assert.equal((db.prepare(`SELECT state FROM queue_items WHERE queue_item_id=?`).get(queueItemId) as { state: string }).state, 'SENT');
    assert.equal(calls.send, 0);
  });
});

test('mismatching buttons are reported as informational non-match', async () => {
  await withDb(async (db) => {
    const { queueItemId } = seedQueue(db);
    const bad: MessageReadback = { ...MATCHING, templates: [{ title: 'Hola', buttons: [{ title: 'Otro', url: 'https://example.com/g', type: 'web_url' }] }] };
    const { provider } = fakeProvider({ readback: async () => bad });
    const result = await new QueueService(db, provider).verifyReadback('account', queueItemId);
    assert.equal(result.observed, true);
    assert.equal(result.matches, false);
    assert.equal(JSON.parse(events(db, queueItemId)[0]!.details_json).matchReason, 'buttons_mismatch');
    assert.equal((db.prepare(`SELECT state FROM queue_items WHERE queue_item_id=?`).get(queueItemId) as { state: string }).state, 'SENT');
  });
});

test('plain text messages compare the message text', async () => {
  await withDb(async (db) => {
    const { queueItemId } = seedQueue(db, { payload: { text: 'Hola', buttons: [], accepted_message_id: 'mid-1' } });
    const { provider } = fakeProvider({ readback: async () => ({ messageId: 'mid-1', observedAt: 'n', recipientId: 'r', text: 'Hola' }) });
    assert.equal((await new QueueService(db, provider).verifyReadback('account', queueItemId)).matches, true);
  });
});

test('re-verification rejects non-SENT items, cross-account access and rate-limits to one call per item per 30s', async () => {
  await withDb(async (db) => {
    const sent = seedQueue(db);
    const queued = seedQueue(db, { accountId: 'other', state: 'QUEUED' });
    const { provider, calls } = fakeProvider();
    let now = 1_000_000;
    const service = new QueueService(db, provider, { clock: () => now });
    await assert.rejects(service.verifyReadback('other', queued.queueItemId), /not_sent/);
    await assert.rejects(service.verifyReadback('other', sent.queueItemId), /queue_item_not_found/);
    assert.equal(calls.read, 0);
    await service.verifyReadback('account', sent.queueItemId);
    await assert.rejects(service.verifyReadback('account', sent.queueItemId), /readback_rate_limited/);
    now += 29_000;
    await assert.rejects(service.verifyReadback('account', sent.queueItemId), /readback_rate_limited/);
    now += 2_000;
    await service.verifyReadback('account', sent.queueItemId);
    assert.equal(calls.read, 2);
    assert.equal(calls.send, 0);
    assert.equal(events(db, sent.queueItemId).length, 2);
  });
});

test('post-send readback in processOne records the real error code and the match info', async () => {
  for (const mode of ['fail', 'ok'] as const) {
    await withDb(async (db) => {
      createConnection(db, { id: 'conn', name: 't', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
      addDiscoveredAccount(db, { accountId: 'account', connectionId: 'conn', providerAccountId: 'prov', username: 'brand', status: 'valid' });
      db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='conn'`).run();
      db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='account'`).run();
      createMedia(db, { accountId: 'account', mediaId: 'media', permalink: null, publishedAt: null });
      createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'comment', text: 'guide', username: 'customer', createdAt: new Date().toISOString() });
      const automations = new AutomationService(db);
      const id = automations.create({ accountId: 'account', mediaId: 'media', name: 'a', replyText: 'Hola' });
      automations.addKeyword('account', id, 'guide');
      automations.setEnabled('account', id, true);
      automations.setRealEnabled('account', id, true, true);
      db.exec(`INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, observed_at)
        VALUES ('account', 'comment', '${id}', 'eligible', 'eligible', CURRENT_TIMESTAMP)`);
      const provider = {
        async getComment(_a: unknown, commentId: string) { return { commentId, text: 'guide', username: 'customer', createdAt: new Date().toISOString() }; },
        async sendPrivateReply() { return { outcome: 'accepted' as const, messageId: 'mid-9' }; },
        async readMessage() {
          if (mode === 'fail') throw Object.assign(new Error('boom'), { code: 'meta_readback_mismatch' });
          return { messageId: 'mid-9', observedAt: 'n', recipientId: 'r', text: 'Hola' };
        },
      } as never;
      const service = new QueueService(db, provider);
      service.setDryRun(false, true);
      await service.enqueueReviewed('account', id, ['comment']);
      assert.ok(await service.processOne('account'));
      const [event] = events(db, (db.prepare(`SELECT queue_item_id AS q FROM queue_items`).get() as { q: string }).q);
      assert.equal((db.prepare(`SELECT state FROM queue_items`).get() as { state: string }).state, 'SENT');
      if (mode === 'fail') {
        assert.equal(event!.safe_error_code, 'meta_readback_mismatch');
      } else {
        const details = JSON.parse(event!.details_json);
        assert.equal(details.observedMatches, true);
        assert.equal(details.matchReason, 'match');
      }
    });
  }
});

// ---- HTTP ----

async function withApi(run: (ctx: { db: Db; origin: string; post: (path: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any }>; calls: { send: number; read: number }; setNow(v: number): void; queueId: string }) => Promise<void>, options: FakeOptions = {}) {
  await withDb(async (db) => {
    const { queueItemId } = seedQueue(db);
    const { provider, calls } = fakeProvider(options);
    let now = 5_000_000;
    const queue = new QueueService(db, provider, { clock: () => now });
    const handler = createApiHandler({ database: db, csrfToken: 'tok', queue } as never);
    const server: Server = createServer((req, res) => { void handler(req, res); });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const origin = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> | undefined = { origin, 'x-csrf-token': 'tok' }) => new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request(new URL(path, origin), { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let data = ''; res.setEncoding('utf8'); res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : {} }));
      });
      req.on('error', reject); req.end(JSON.stringify(body));
    });
    try { await run({ db, origin, post, calls, setNow: (v) => { now = v; }, queueId: queueItemId }); } finally { server.close(); }
  });
}

test('POST /api/queue/:id/readback requires CSRF/Origin and a known owning account', async () => {
  await withApi(async ({ post, queueId, calls }) => {
    const noCsrf = await post(`/api/queue/${queueId}/readback`, { accountId: 'account' }, {});
    assert.equal(noCsrf.status, 403);
    const missing = await post(`/api/queue/${queueId}/readback`, {});
    assert.equal(missing.status, 400);
    const unknown = await post(`/api/queue/${queueId}/readback`, { accountId: 'nope' });
    assert.equal(unknown.status, 404);
    assert.equal(calls.read, 0);
  });
});

test('POST /api/queue/:id/readback re-verifies once, appends an event, keeps SENT state and never sends', async () => {
  await withApi(async ({ db, post, queueId, calls, setNow }) => {
    const first = await post(`/api/queue/${queueId}/readback`, { accountId: 'account' });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json, { observed: true, matches: true });
    assert.equal(events(db, queueId).length, 1);
    assert.equal((db.prepare(`SELECT state FROM queue_items WHERE queue_item_id=?`).get(queueId) as { state: string }).state, 'SENT');
    const limited = await post(`/api/queue/${queueId}/readback`, { accountId: 'account' });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error, 'readback_rate_limited');
    setNow(5_031_000);
    assert.equal((await post(`/api/queue/${queueId}/readback`, { accountId: 'account' })).status, 200);
    assert.equal(calls.send, 0);
    assert.equal(calls.read, 2);
    const attempts = db.prepare(`SELECT COUNT(*) AS n FROM send_attempts WHERE event_type IN ('intent_recorded','accepted')`).get() as { n: number };
    assert.equal(attempts.n, 1);
  }, { readback: async () => ({ messageId: 'mid-1', observedAt: 'n', recipientId: 'r', text: '', templates: [{ title: 'Hola', buttons: [{ title: 'Guía', url: 'https://example.com/g', type: 'web_url' }] }] }) });
});

test('POST /api/queue/:id/readback rejects cross-account and non-SENT items and exposes only safe error codes', async () => {
  await withApi(async ({ db, post, queueId }) => {
    seedQueue(db, { accountId: 'other', state: 'QUEUED' });
    const cross = await post(`/api/queue/${queueId}/readback`, { accountId: 'other' });
    assert.equal(cross.status, 404);
    const notSent = await post(`/api/queue/q-other/readback`, { accountId: 'other' });
    assert.equal(notSent.status, 409);
    assert.equal(notSent.json.error, 'queue_item_not_sent');
    const failed = await post(`/api/queue/${queueId}/readback`, { accountId: 'account' });
    assert.equal(failed.status, 200);
    assert.deepEqual(failed.json, { observed: false, safeErrorCode: 'meta_readback_mismatch' });
  }, { readback: async () => { throw Object.assign(new Error('raw body secret'), { code: 'meta_readback_mismatch' }); } });
});

// ---- readback diagnostics ----

const OK_FROM = { username: 'modoverbo', id: 'x' };

test('each readback failure has its own safe code and safe diagnostics', async () => {
  const cases: Array<[string, Record<string, unknown> | undefined, Record<string, unknown>, string, Record<string, unknown>]> = [
    ['id', OK_FROM, { id: 'different' }, 'meta_readback_id_mismatch', { idMatches: false, senderIdMatches: false, usernamePresent: true, usernameMatches: true, recipientCount: 1, toShape: 'array', hasAttachments: false, attachmentsShape: 'missing' }],
    ['sender', { id: 'other', username: 'someoneelse' }, {}, 'meta_readback_sender_mismatch', { idMatches: true, senderIdMatches: false, usernamePresent: true, usernameMatches: false, recipientCount: 1, toShape: 'array', hasAttachments: false, attachmentsShape: 'missing' }],
    ['recipient', OK_FROM, { to: {}, attachments: { data: [{}] } }, 'meta_readback_no_recipient', { idMatches: true, senderIdMatches: false, usernamePresent: true, usernameMatches: true, recipientCount: 0, toShape: 'other', hasAttachments: true, attachmentsShape: 'data' }],
  ];
  for (const [, from, extra, code, diagnostics] of cases) {
    const { failure } = await read(from, extra);
    assert.equal((failure as { code?: string }).code, code);
    assert.deepEqual((failure as { diagnostics?: unknown }).diagnostics, diagnostics);
    assert.doesNotMatch(JSON.stringify((failure as { diagnostics?: unknown }).diagnostics), /someoneelse|modoverbo|"recipient"|"tok"|different|hello/);
  }
  const missing = await read(OK_FROM, { to: undefined });
  assert.equal((missing.failure as { diagnostics: { toShape: string } }).diagnostics.toShape, 'missing');
});

test('readback accepts recipients as a plain array or as a {data:[...]} list, ignoring non-objects', async () => {
  const asData = await read(OK_FROM, { to: { data: [{ id: 'recipient', username: 'r' }] } });
  assert.equal(asData.failure, undefined);
  assert.equal(asData.result?.recipientId, 'recipient');
  const asArray = await read(OK_FROM, { to: [{ id: 'recipient' }] });
  assert.equal(asArray.result?.recipientId, 'recipient');
  const junk = await read(OK_FROM, { to: { data: ['junk', 5, null] } });
  assert.equal((junk.failure as { code?: string }).code, 'meta_readback_no_recipient');
  const bounded = await read(OK_FROM, { to: { data: Array.from({ length: 500 }, () => ({ id: 'r' })) } });
  assert.equal(bounded.failure, undefined);
});

test('queue stores safe readback diagnostics for post-send and re-verification failures, with no raw values', async () => {
  await withDb(async (db) => {
    const { queueItemId } = seedQueue(db);
    const diagnostics = { idMatches: true, senderIdMatches: false, usernamePresent: true, usernameMatches: false, recipientCount: 1, toShape: 'array', hasAttachments: false, attachmentsShape: 'missing', rawId: 'SECRET-ID', note: 'SECRET-TEXT' };
    const error = Object.assign(new Error('x'), { code: 'meta_readback_sender_mismatch', diagnostics });
    const { provider } = fakeProvider({ readback: async () => { throw error; } });
    await new QueueService(db, provider).verifyReadback('account', queueItemId);
    const [event] = events(db, queueItemId);
    assert.equal(event!.safe_error_code, 'meta_readback_sender_mismatch');
    const details = JSON.parse(event!.details_json);
    assert.equal(details.observed, false);
    assert.deepEqual(details.diagnostics, {
      idMatches: true, senderIdMatches: false, usernamePresent: true, usernameMatches: false, recipientCount: 1, toShape: 'array', hasAttachments: false, attachmentsShape: 'missing',
    });
    assert.doesNotMatch(event!.details_json, /SECRET/);
  });
});
