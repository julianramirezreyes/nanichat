import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AccountRef, PrivateReplyPayload } from '../src/core/domain.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia, listEncryptedCredentials } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { MetaProvider } from '../src/providers/meta/provider.ts';
import { createVault } from '../src/security/vault.ts';
import { AutomationService, renderReply } from '../src/services/automations.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { interactiveRequestFields } from '../app/interactive-buttons.ts';

type Db = ReturnType<typeof openDatabase>;
const one = (db: Db, sql: string, ...params: unknown[]) => ({ ...(db.prepare(sql).get(...params as never[]) as Record<string, any>) });
const ACCOUNT_IG_ID = '17841400000000000';
const COMMENT = '18000000000000001';

async function withDb(run: (db: Db, directory: string) => Promise<void> | void, target?: number): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'follow-gate-'));
  const db = openDatabase(directory);
  if (target === undefined) migrateDatabase(db); else migrateDatabase(db, target);
  try { await run(db, directory); } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}

function seed(db: Db, suffix = ''): AccountRef & { mediaId: string } {
  createConnection(db, { id: `conn${suffix}`, name: 'c', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
    status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
  addDiscoveredAccount(db, { accountId: `acc${suffix}`, connectionId: `conn${suffix}`, providerAccountId: `p${suffix}`, username: `brand${suffix}`, status: 'valid' });
  db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id=?`).run(`conn${suffix}`);
  db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id=?`).run(`acc${suffix}`);
  createMedia(db, { accountId: `acc${suffix}`, mediaId: `m${suffix}`, permalink: null, publishedAt: null });
  return { accountId: `acc${suffix}`, connectionId: `conn${suffix}`, providerAccountId: `p${suffix}`, username: `brand${suffix}`, mediaId: `m${suffix}` };
}

function providerState(directory: string) {
  const db = openDatabase(directory);
  migrateDatabase(db);
  const vault = createVault(directory, () => listEncryptedCredentials(db));
  createConnection(db, { id: 'conn', name: 'p', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid',
    accessToken: vault.encrypt('conn', 'ig-user-token') });
  addDiscoveredAccount(db, { accountId: 'acc', connectionId: 'conn', providerAccountId: ACCOUNT_IG_ID, username: 'brand', status: 'valid' });
  createMedia(db, { accountId: 'acc', mediaId: 'media', permalink: null, publishedAt: null });
  createComment(db, { accountId: 'acc', mediaId: 'media', commentId: COMMENT, text: 'guide', username: 'customer', createdAt: null });
  return { db, vault, account: { accountId: 'acc', connectionId: 'conn', providerAccountId: ACCOUNT_IG_ID, username: 'brand' } satisfies AccountRef };
}

type Call = { url: URL; init: RequestInit };
async function withProvider(respond: (call: Call) => Response | Promise<Response>, run: (provider: MetaProvider, calls: Call[], state: ReturnType<typeof providerState>) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'follow-gate-provider-'));
  const state = providerState(directory);
  const calls: Call[] = [];
  try {
    const provider = new MetaProvider(state.db, state.vault, async (input, init = {}) => {
      const call = { url: new URL(String(input)), init };
      calls.push(call);
      return respond(call);
    }, { diagnosticSpacingMs: 0 });
    await run(provider, calls, state);
  } finally { state.db.close(); rmSync(directory, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------------------------
// Migration v11 -> v12
// ---------------------------------------------------------------------------------------------------------------

test('migration v11 -> v12 adds comments.author_igsid and automation interactive columns, preserving rows', async () => {
  await withDb((db) => {
    assert.equal(one(db, 'PRAGMA user_version').user_version, 11);
    const ctx = seed(db);
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'hola', username: 'u', createdAt: '2026-01-01T00:00:00.000Z' });
    db.exec(`INSERT INTO automations (automation_id, account_id, media_id, scope, name, status, created_at, updated_at, real_enabled, version, buttons_json)
      VALUES ('a1','acc','m','media','Old','enabled','2026','2026',1,7,'[{"title":"x","url":"https://a.b"}]');
      INSERT INTO queue_items(queue_item_id,account_id,comment_id,automation_id,state,dry_run,payload_json,created_at,updated_at)
        VALUES ('q1','acc','c1','a1','SENT',0,'{"text":"x"}','2026','2026');`);
    migrateDatabase(db);
    assert.equal(one(db, 'PRAGMA user_version').user_version, 12);
    assert.equal(one(db, 'PRAGMA foreign_keys').foreign_keys, 1);
    const comment = one(db, `SELECT * FROM comments WHERE comment_id='c1'`);
    assert.equal(comment.text, 'hola');
    assert.equal(comment.author_igsid, null);
    const automation = one(db, `SELECT * FROM automations WHERE automation_id='a1'`);
    assert.equal(automation.interactive_mode, 'none');
    assert.equal(automation.interactive_titles_json, '[]');
    assert.equal(automation.version, 7);
    assert.equal(automation.buttons_json, '[{"title":"x","url":"https://a.b"}]');
    assert.equal(one(db, `SELECT state FROM queue_items WHERE queue_item_id='q1'`).state, 'SENT');
    assert.throws(() => db.exec(`UPDATE automations SET interactive_mode='bogus' WHERE automation_id='a1'`), /CHECK/);
    migrateDatabase(db);
    assert.equal(one(db, 'PRAGMA user_version').user_version, 12);
  }, 11);
});

// ---------------------------------------------------------------------------------------------------------------
// IGSID capture
// ---------------------------------------------------------------------------------------------------------------

test('provider maps from.id defensively into authorId on listComments and getComment', async () => {
  await withProvider(({ url }) => {
    if (url.pathname.endsWith('/comments')) {
      return Response.json({ data: [
        { id: 'k1', text: 'a', from: { id: '1234567890', username: 'x' }, timestamp: '2026-01-01T00:00:00+0000' },
        { id: 'k2', text: 'b', from: { id: 42, username: 'y' } },
        { id: 'k3', text: 'c', from: { id: '../evil id', username: 'z' } },
        { id: 'k4', text: 'd', username: 'w' },
      ] });
    }
    return Response.json({ id: COMMENT, text: 'guide', from: { id: '9988776655', username: 'customer' } });
  }, async (provider, _calls, state) => {
    const page = await provider.listComments(state.account, 'media');
    assert.deepEqual(page.items.map((item) => item.authorId), ['1234567890', undefined, undefined, undefined]);
    assert.equal(page.items[1]!.username, 'y');
    const comment = await provider.getComment(state.account, COMMENT);
    assert.equal(comment.authorId, '9988776655');
  });
});

test('scanner persists author_igsid and never erases a known value with a missing one', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    let authorId: string | undefined = 'igsid-111';
    const scanner = new Scanner(db, {
      async listComments() {
        return { items: [{ commentId: 'c1', text: 'hola', username: 'u', createdAt: new Date().toISOString(), ...(authorId ? { authorId } : {}) }], complete: true };
      },
    });
    await scanner.scanMedia(ctx, ctx.mediaId, { kind: 'catch_up' });
    assert.equal(one(db, `SELECT author_igsid FROM comments WHERE comment_id='c1'`).author_igsid, 'igsid-111');
    authorId = undefined;
    await scanner.scanMedia(ctx, ctx.mediaId, { kind: 'catch_up' });
    assert.equal(one(db, `SELECT author_igsid FROM comments WHERE comment_id='c1'`).author_igsid, 'igsid-111');
  });
});

test('private reply captures a valid recipient_id from the send response, ignoring malformed ones', async () => {
  let body: Record<string, unknown> = { recipient_id: '5544332211', message_id: 'mid.1' };
  await withProvider(() => Response.json(body), async (provider, _calls, state) => {
    const accepted = await provider.sendPrivateReply(state.account, COMMENT, { text: 'Hola', buttons: [] });
    assert.deepEqual({ outcome: accepted.outcome, messageId: accepted.messageId, recipientId: accepted.recipientId },
      { outcome: 'accepted', messageId: 'mid.1', recipientId: '5544332211' });
    for (const bad of [12345, '', 'a b', 'x'.repeat(200), { id: '1' }]) {
      body = { recipient_id: bad, message_id: 'mid.2' };
      const result = await provider.sendPrivateReply(state.account, COMMENT, { text: 'Hola', buttons: [] });
      assert.equal(result.outcome, 'accepted');
      assert.equal(result.recipientId, undefined, JSON.stringify(bad));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Interactive payload shapes
// ---------------------------------------------------------------------------------------------------------------

test("mode 'none' request bodies are byte-for-byte unchanged (text and web_url template)", async () => {
  await withProvider(() => Response.json({ message_id: 'mid.1' }), async (provider, calls, state) => {
    await provider.sendPrivateReply(state.account, COMMENT, { text: 'Hola', buttons: [] });
    await provider.sendPrivateReply(state.account, COMMENT, { text: 'Hola', buttons: [{ title: 'Ver', url: 'https://example.com/a' }] });
    assert.equal(String(calls[0]!.init.body), `{"recipient":{"comment_id":"${COMMENT}"},"message":{"text":"Hola"}}`);
    assert.equal(String(calls[1]!.init.body), `{"recipient":{"comment_id":"${COMMENT}"},"message":{"attachment":{"type":"template","payload":{"template_type":"button","text":"Hola","buttons":[{"type":"web_url","title":"Ver","url":"https://example.com/a"}]}}}}`);
  });
});

test('quick replies are sent on the message next to text with content_type text', async () => {
  await withProvider(() => Response.json({ message_id: 'mid.1' }), async (provider, calls, state) => {
    const result = await provider.sendPrivateReply(state.account, COMMENT, {
      text: 'Hola', buttons: [], quickReplies: [{ title: 'Ya te sigo', payload: 'gate:a1:0' }, { title: 'Aún no', payload: 'gate:a1:1' }],
    });
    assert.equal(result.outcome, 'accepted');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      recipient: { comment_id: COMMENT },
      message: { text: 'Hola', quick_replies: [
        { content_type: 'text', title: 'Ya te sigo', payload: 'gate:a1:0' },
        { content_type: 'text', title: 'Aún no', payload: 'gate:a1:1' },
      ] },
    });
  });
});

test('postback buttons go inside the button template after web_url buttons', async () => {
  await withProvider(() => Response.json({ message_id: 'mid.1' }), async (provider, calls, state) => {
    await provider.sendPrivateReply(state.account, COMMENT, {
      text: 'Hola', buttons: [{ title: 'Web', url: 'https://example.com/x' }],
      postbackButtons: [{ title: 'Ya te sigo', payload: 'gate:a1:0' }, { title: 'Enviar', payload: 'gate:a1:1' }],
    });
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      recipient: { comment_id: COMMENT },
      message: { attachment: { type: 'template', payload: { template_type: 'button', text: 'Hola', buttons: [
        { type: 'web_url', title: 'Web', url: 'https://example.com/x' },
        { type: 'postback', title: 'Ya te sigo', payload: 'gate:a1:0' },
        { type: 'postback', title: 'Enviar', payload: 'gate:a1:1' },
      ] } } },
    });
  });
});

test('provider rejects invalid interactive payloads before any request', async () => {
  const qr = (title: string, payload = 'gate:a1:0') => ({ title, payload });
  const invalid: PrivateReplyPayload[] = [
    { text: 'x', buttons: [], quickReplies: [qr('a'), qr('b', 'gate:a1:1'), qr('c', 'gate:a1:2'), qr('d', 'gate:a1:2')] },
    { text: 'x', buttons: [], quickReplies: [qr('x'.repeat(21))] },
    { text: 'x', buttons: [], quickReplies: [qr('   ')] },
    { text: 'x', buttons: [], quickReplies: [qr('Sí'), qr('sí', 'gate:a1:1')] },
    { text: 'x', buttons: [], quickReplies: [qr('ok', 'https://evil.example')] },
    { text: 'x', buttons: [], quickReplies: [qr('ok', 'user-chosen')] },
    { text: 'x', buttons: [], quickReplies: [qr('ver https://x.co')] },
    { text: 'x', buttons: [{ title: 'Web', url: 'https://example.com' }], quickReplies: [qr('ok')] },
    { text: 'x', buttons: [], quickReplies: [qr('ok')], postbackButtons: [qr('ok')] },
    { text: 'x', buttons: [], quickReplies: [] },
    { text: 'x', buttons: [{ title: 'A', url: 'https://a.example' }, { title: 'B', url: 'https://b.example' }],
      postbackButtons: [qr('c'), qr('d', 'gate:a1:1')] },
    { text: 'x', buttons: [], postbackButtons: [qr('www.evil.com')] },
  ];
  await withProvider(() => Response.json({ message_id: 'mid.1' }), async (provider, calls, state) => {
    for (const payload of invalid) {
      const result = await provider.sendPrivateReply(state.account, COMMENT, payload);
      assert.deepEqual({ outcome: result.outcome, safeErrorCode: result.safeErrorCode },
        { outcome: 'definitive_rejection', safeErrorCode: 'invalid_reply_payload' }, JSON.stringify(payload));
    }
    assert.equal(calls.length, 0);
  });
});

test('an explicit Meta rejection of an interactive payload is a safe definitive rejection; unknown outcomes stay ambiguous', async () => {
  let response: () => Response = () => Response.json({ error: { code: 100, message: 'Invalid parameter token=abc' } }, { status: 400 });
  const interactive: PrivateReplyPayload = { text: 'Hola', buttons: [], quickReplies: [{ title: 'Ok', payload: 'gate:a1:0' }] };
  await withProvider(() => response(), async (provider, _calls, state) => {
    const rejected = await provider.sendPrivateReply(state.account, COMMENT, interactive);
    assert.deepEqual({ outcome: rejected.outcome, safeErrorCode: rejected.safeErrorCode }, { outcome: 'definitive_rejection', safeErrorCode: 'interactive_payload_rejected' });
    assert.equal(JSON.stringify(rejected).includes('token'), false);
    // Same error without interactive elements keeps the historic code.
    assert.equal((await provider.sendPrivateReply(state.account, COMMENT, { text: 'Hola', buttons: [] })).safeErrorCode, 'meta_100');
    response = () => Response.json({ error: { code: 2 } }, { status: 500 });
    assert.equal((await provider.sendPrivateReply(state.account, COMMENT, interactive)).outcome, 'ambiguous');
    response = () => Response.json({ message: 'no id' });
    assert.equal((await provider.sendPrivateReply(state.account, COMMENT, interactive)).outcome, 'ambiguous');
    response = () => Response.json({ error: { code: 4 } }, { status: 429 });
    const throttled = await provider.sendPrivateReply(state.account, COMMENT, interactive);
    assert.equal(throttled.httpStatus, 429);
    assert.notEqual(throttled.safeErrorCode, 'interactive_payload_rejected');
    response = () => Response.json({ error: { code: 190 } }, { status: 400 });
    assert.equal((await provider.sendPrivateReply(state.account, COMMENT, interactive)).safeErrorCode, 'meta_190');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// renderReply and automation configuration
// ---------------------------------------------------------------------------------------------------------------

const VARS = { username: 'u', comment: 'c', keyword: 'k' };

test("renderReply generates server-side payloads and leaves mode 'none' untouched", () => {
  assert.deepEqual(renderReply('Hola', VARS, []), { text: 'Hola', buttons: [] });
  assert.deepEqual(renderReply('Hola', VARS, [], { mode: 'none', titles: [], automationId: 'a1' }), { text: 'Hola', buttons: [] });
  assert.deepEqual(renderReply('Hola', VARS, [], { mode: 'quick_reply', titles: ['Ya te sigo', 'Aún no'], automationId: 'a1' }), {
    text: 'Hola', buttons: [], quickReplies: [{ title: 'Ya te sigo', payload: 'gate:a1:0' }, { title: 'Aún no', payload: 'gate:a1:1' }],
  });
  assert.deepEqual(renderReply('Hola', VARS, [{ title: 'Web', url: 'https://example.com/x' }], { mode: 'postback', titles: ['Listo'], automationId: 'a1' }), {
    text: 'Hola', buttons: [{ title: 'Web', url: 'https://example.com/x' }], postbackButtons: [{ title: 'Listo', payload: 'gate:a1:0' }],
  });
  const bad: Array<[string, string[], Array<{ title: string; url: string }>]> = [
    ['quick_reply', [], []],
    ['quick_reply', ['a', 'b', 'c', 'd'], []],
    ['quick_reply', ['x'.repeat(21)], []],
    ['quick_reply', ['https://x.co'], []],
    ['quick_reply', ['Sí', 'SÍ'], []],
    ['quick_reply', ['ok'], [{ title: 'Web', url: 'https://example.com' }]],
    ['postback', ['a', 'b'], [{ title: 'A', url: 'https://a.example' }, { title: 'B', url: 'https://b.example' }]],
    ['none', ['a'], []],
    ['other', ['a'], []],
  ];
  for (const [mode, titles, buttons] of bad) {
    assert.throws(() => renderReply('Hola', VARS, buttons, { mode: mode as never, titles, automationId: 'a1' }), TypeError, `${mode} ${titles.join('|')}`);
  }
});

test('automation service stores interactive configuration with defaults and keeps it when omitted on update', async () => {
  await withDb((db) => {
    const ctx = seed(db);
    const service = new AutomationService(db);
    const plain = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Plain', replyText: 'Hola' });
    assert.deepEqual(one(db, `SELECT interactive_mode, interactive_titles_json FROM automations WHERE automation_id=?`, plain),
      { interactive_mode: 'none', interactive_titles_json: '[]' });
    const gate = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Gate', replyText: 'Hola',
      interactiveMode: 'quick_reply', interactiveTitles: [' Ya te sigo ', 'Aún no'] });
    assert.deepEqual(one(db, `SELECT interactive_mode, interactive_titles_json FROM automations WHERE automation_id=?`, gate),
      { interactive_mode: 'quick_reply', interactive_titles_json: '["Ya te sigo","Aún no"]' });
    service.update(ctx.accountId, gate, { name: 'Gate', mediaId: ctx.mediaId, replyText: 'Hola 2', matchMode: 'contains', buttons: [], keywords: ['guia'] });
    assert.equal(one(db, `SELECT interactive_mode FROM automations WHERE automation_id=?`, gate).interactive_mode, 'quick_reply');
    service.update(ctx.accountId, gate, { name: 'Gate', mediaId: ctx.mediaId, replyText: 'Hola', matchMode: 'contains', buttons: [], keywords: ['guia'],
      interactiveMode: 'none', interactiveTitles: [] });
    assert.deepEqual(one(db, `SELECT interactive_mode, interactive_titles_json FROM automations WHERE automation_id=?`, gate),
      { interactive_mode: 'none', interactive_titles_json: '[]' });
    assert.throws(() => service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Bad', replyText: 'Hola',
      interactiveMode: 'quick_reply', interactiveTitles: 'Ya' as never }), TypeError);
    assert.throws(() => service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Bad', replyText: 'Hola',
      interactiveMode: 'postback', interactiveTitles: ['a', 'b'], buttons: [{ title: 'A', url: 'https://a.example' }, { title: 'B', url: 'https://b.example' }] }), TypeError);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Queue: payload freezing, recipient capture and DTOs
// ---------------------------------------------------------------------------------------------------------------

async function listen(handler: ReturnType<typeof createApiHandler>): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function call(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL(path, origin);
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : undefined }));
    });
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

function realAutomation(db: Db, ctx: { accountId: string; mediaId: string }, extra: Record<string, unknown> = {}): string {
  const service = new AutomationService(db);
  const id = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Auto', replyText: 'Hola {{username}}', ...extra } as never);
  service.addKeyword(ctx.accountId, id, 'guide');
  service.setEnabled(ctx.accountId, id, true);
  service.setRealEnabled(ctx.accountId, id, true, true);
  return id;
}

function sendingProvider(result: Record<string, unknown>) {
  const sent: unknown[] = [];
  return {
    sent,
    async getComment(_account: unknown, commentId: string) {
      return { commentId, text: 'quiero la guide', username: 'customer', createdAt: new Date(Date.now() - 60_000).toISOString() };
    },
    async sendPrivateReply(_account: unknown, _commentId: string, payload: unknown) { sent.push(payload); return result; },
    async readMessage(_account: unknown, messageId: string) { return { messageId, observedAt: new Date().toISOString() }; },
  };
}

test("queue freezes interactive payloads, records recipientId on accept and exposes both in DTOs; 'none' payload is unchanged", async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const gate = realAutomation(db, ctx, { interactiveMode: 'quick_reply', interactiveTitles: ['Ya te sigo', 'Aún no'] });
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer',
      createdAt: new Date(Date.now() - 60_000).toISOString() });
    const provider = sendingProvider({ outcome: 'accepted', messageId: 'mid.1', recipientId: '5544332211' });
    const queue = new QueueService(db, provider as never, { sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed(ctx.accountId, gate, ['c1']);
    await queue.processOne(ctx.accountId);
    assert.deepEqual((provider.sent[0] as PrivateReplyPayload).quickReplies,
      [{ title: 'Ya te sigo', payload: `gate:${gate}:0` }, { title: 'Aún no', payload: `gate:${gate}:1` }]);
    const accepted = one(db, `SELECT details_json FROM send_attempts WHERE event_type='accepted'`);
    assert.equal(JSON.parse(accepted.details_json).recipientId, '5544332211');

    const handler = createApiHandler({ database: db, csrfToken: 'csrf', queue } as never);
    const { server, origin } = await listen(handler);
    try {
      const page = await call(origin, `/api/queue?accountId=${ctx.accountId}`);
      assert.deepEqual(page.json.items[0].payload, { text: 'Hola customer', buttons: [], quickReplies: [{ title: 'Ya te sigo' }, { title: 'Aún no' }] });
      const queueId = page.json.items[0].id;
      const attempts = await call(origin, `/api/queue/${queueId}/attempts?accountId=${ctx.accountId}`);
      assert.equal(attempts.json.events.find((event: { type: string }) => event.type === 'accepted').details.recipientId, '5544332211');
    } finally { server.close(); }
  });
  await withDb(async (db) => {
    const ctx = seed(db);
    const plain = realAutomation(db, ctx);
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer',
      createdAt: new Date(Date.now() - 60_000).toISOString() });
    const provider = sendingProvider({ outcome: 'accepted', messageId: 'mid.1' });
    const queue = new QueueService(db, provider as never, { sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed(ctx.accountId, plain, ['c1']);
    const version = one(db, `SELECT version FROM automations WHERE automation_id=?`, plain).version;
    assert.equal(one(db, `SELECT payload_json FROM queue_items`).payload_json, `{"text":"Hola customer","buttons":[],"automation_version":${version}}`);
    await queue.processOne(ctx.accountId);
    assert.deepEqual(Object.keys(provider.sent[0] as object), ['text', 'buttons', 'automation_version']);
    assert.equal(Object.hasOwn(JSON.parse(one(db, `SELECT details_json FROM send_attempts WHERE event_type='accepted'`).details_json), 'recipientId'), false);
  });
});

test('automations API validates interactive fields strictly and lists them', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', automations: new AutomationService(db) } as never);
    const { server, origin } = await listen(handler);
    const headers = { origin, 'content-type': 'application/json', 'x-csrf-token': 'csrf' };
    const base = { accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Gate', keywords: ['guia'], replyText: 'Hola' };
    try {
      for (const extra of [
        { interactiveMode: 'bogus', interactiveTitles: ['a'] },
        { interactiveMode: 'quick_reply', interactiveTitles: [] },
        { interactiveMode: 'quick_reply', interactiveTitles: ['a', 'b', 'c', 'd'] },
        { interactiveMode: 'quick_reply', interactiveTitles: [12] },
        { interactiveMode: 'quick_reply', interactiveTitles: ['http://x.co'] },
        { interactiveMode: 'none', interactiveTitles: ['a'] },
        { interactiveMode: 'postback', interactiveTitles: 'a' },
      ]) {
        const result = await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, ...extra } });
        assert.equal(result.status, 400, JSON.stringify(extra));
      }
      assert.equal((await call(origin, '/api/automations', { method: 'POST', headers, body: base })).status, 201);
      const created = await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, name: 'Gate 2', interactiveMode: 'postback', interactiveTitles: ['Listo'] } });
      assert.equal(created.status, 201);
      const listed = (await call(origin, `/api/automations?accountId=${ctx.accountId}`)).json.automations as Array<Record<string, unknown>>;
      assert.deepEqual(listed.map((row) => [row.name, row.interactiveMode, row.interactiveTitles]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
        [['Gate', 'none', []], ['Gate 2', 'postback', ['Listo']]]);
      const put = await call(origin, `/api/automations/${created.json.automationId}`, { method: 'PUT', headers,
        body: { ...base, name: 'Gate 2', matchMode: 'contains', interactiveMode: 'quick_reply', interactiveTitles: ['x'.repeat(21)] } });
      assert.equal(put.status, 400);
      const ok = await call(origin, `/api/automations/${created.json.automationId}`, { method: 'PUT', headers,
        body: { ...base, name: 'Gate 2', matchMode: 'contains', interactiveMode: 'quick_reply', interactiveTitles: ['Sí', 'No'] } });
      assert.equal(ok.status, 200);
      assert.equal(one(db, `SELECT interactive_titles_json FROM automations WHERE automation_id=?`, created.json.automationId).interactive_titles_json, '["Sí","No"]');
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Read-only diagnostics (provider)
// ---------------------------------------------------------------------------------------------------------------

const IGSID = '5544332211';

function conversationResponder(options: { conversations?: unknown; messageCount?: number } = {}) {
  return ({ url, init }: Call): Response => {
    assert.equal(init.method ?? 'GET', 'GET');
    if (url.pathname.endsWith('/conversations')) return Response.json(options.conversations ?? { data: [{ id: 'conv_1', updated_time: 'x' }] });
    if (url.pathname.endsWith('/conv_1')) {
      const count = options.messageCount ?? 25;
      return Response.json({ id: 'conv_1', messages: { data: Array.from({ length: count }, (_value, index) => ({ id: `msg_${index}`, created_time: '2026-10-08T10:00:00+0000' })) } });
    }
    const id = url.pathname.split('/').pop()!;
    const index = Number(id.replace('msg_', ''));
    const fromAccount = index % 2 === 0;
    return Response.json({
      id, created_time: '2026-10-08T10:00:00+0000',
      from: fromAccount ? { id: ACCOUNT_IG_ID, username: 'brand' } : { id: IGSID, username: 'customer' },
      to: { data: [{ id: fromAccount ? IGSID : ACCOUNT_IG_ID, username: 'RAW_SECRET_RECIPIENT' }] },
      message: `${'m'.repeat(100)} access_token=EAAB-should-not-leak`,
      ...(index === 1 ? { quick_reply: { payload: 'gate:a:0' }, attachments: { data: [{ x: 1 }] } } : {}),
    });
  };
}

test('diagnoseConversation finds the conversation with GETs only, caps details at 20 and returns sanitized summaries', async () => {
  await withProvider(conversationResponder(), async (provider, calls, state) => {
    const result = await provider.diagnoseConversation(state.account, IGSID);
    assert.equal(result.found, true);
    assert.equal(calls[0]!.url.pathname, `/v26.0/${ACCOUNT_IG_ID}/conversations`);
    assert.equal(calls[0]!.url.searchParams.get('platform'), 'instagram');
    assert.equal(calls[0]!.url.searchParams.get('user_id'), IGSID);
    assert.equal(calls[1]!.url.pathname, '/v26.0/conv_1');
    assert.equal(calls[1]!.url.searchParams.get('fields'), 'messages');
    assert.equal(calls.length, 2 + 20);
    assert.equal(calls[2]!.url.searchParams.get('fields'), 'id,created_time,from,to,message,attachments');
    assert.ok(calls.every((entry) => (entry.init.method ?? 'GET') === 'GET' && entry.init.body === undefined));
    assert.equal(result.messages.length, 20);
    assert.deepEqual(result.messages[0], {
      id: 'msg_0', createdTime: '2026-10-08T10:00:00+0000', direction: 'account', text: 'm'.repeat(80),
      keys: ['created_time', 'from', 'id', 'message', 'to'], attachmentsShape: 'missing',
    });
    assert.equal(result.messages[1]!.direction, 'user');
    assert.deepEqual(result.messages[1]!.keys, ['attachments', 'created_time', 'from', 'id', 'message', 'quick_reply', 'to']);
    assert.equal(result.messages[1]!.attachmentsShape, 'data');
    const serialized = JSON.stringify(result);
    for (const leak of ['RAW_SECRET_RECIPIENT', 'access_token', 'EAAB', 'ig-user-token', 'gate:a:0', '__safe_usage']) {
      assert.equal(serialized.includes(leak), false, leak);
    }
  });
});

test('diagnoseConversation reports not found, rejects unsafe ids and never follows unsafe provider ids', async () => {
  await withProvider(conversationResponder({ conversations: { data: [] } }), async (provider, calls, state) => {
    assert.deepEqual(await provider.diagnoseConversation(state.account, IGSID), { found: false, messages: [] });
    assert.equal(calls.length, 1);
    for (const bad of ['', '../x', 'a b', 'x'.repeat(200), 'a?b=c']) {
      const result = await provider.diagnoseConversation(state.account, bad);
      assert.deepEqual(result, { found: false, messages: [], safeErrorCode: 'invalid_igsid' });
      assert.equal((await provider.getUserProfile(state.account, bad)).safeErrorCode, 'invalid_igsid');
    }
    assert.equal(calls.length, 1);
  });
  await withProvider(conversationResponder({ conversations: { data: [{ id: '../../me/messages' }] } }), async (provider, calls, state) => {
    const result = await provider.diagnoseConversation(state.account, IGSID);
    assert.deepEqual(result, { found: false, messages: [], safeErrorCode: 'invalid_provider_response' });
    assert.equal(calls.length, 1);
  });
  await withProvider(() => Response.json({ error: { code: 10, message: 'secret' } }, { status: 403 }), async (provider, _calls, state) => {
    assert.deepEqual(await provider.diagnoseConversation(state.account, IGSID), { found: false, messages: [], safeErrorCode: 'meta_10' });
  });
});

test('getUserProfile returns only follow booleans and maps the consent error to user_consent_required', async () => {
  let response: () => Response = () => Response.json({ name: 'Real Name', username: 'customer', is_user_follow_business: true, is_business_follow_user: false });
  await withProvider(() => response(), async (provider, calls, state) => {
    const ok = await provider.getUserProfile(state.account, IGSID);
    assert.deepEqual(ok, { ok: true, isUserFollowBusiness: true, isBusinessFollowUser: false });
    assert.equal(calls[0]!.url.pathname, `/v26.0/${IGSID}`);
    assert.equal(calls[0]!.url.searchParams.get('fields'), 'name,username,is_user_follow_business,is_business_follow_user');
    response = () => Response.json({ error: { code: 230, message: 'User consent is required to access user profile.' } }, { status: 400 });
    assert.deepEqual(await provider.getUserProfile(state.account, IGSID), { ok: false, safeErrorCode: 'user_consent_required' });
    response = () => Response.json({ error: { code: 100, message: 'Unsupported get request token=abc' } }, { status: 400 });
    const other = await provider.getUserProfile(state.account, IGSID);
    assert.deepEqual(other, { ok: false, safeErrorCode: 'meta_100' });
    response = () => Response.json({ is_user_follow_business: 'yes' });
    assert.deepEqual(await provider.getUserProfile(state.account, IGSID), { ok: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Diagnostics endpoint
// ---------------------------------------------------------------------------------------------------------------

test('diagnostics endpoint: guards, ownership, igsid_unknown, sanitized result and per-comment rate limit', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const other = seed(db, '2');
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'hola', username: 'u', createdAt: null });
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c2', text: 'hola', username: 'u', createdAt: null });
    createComment(db, { accountId: other.accountId, mediaId: other.mediaId, commentId: 'c3', text: 'hola', username: 'u', createdAt: null });
    db.prepare(`UPDATE comments SET author_igsid=? WHERE comment_id IN ('c1','c3')`).run(IGSID);
    let now = 1_000_000;
    const seen: Array<{ account: AccountRef; igsid: string }> = [];
    const diagnostics = {
      async diagnoseConversation(account: AccountRef, igsid: string) {
        seen.push({ account, igsid });
        return { found: true, messages: [{ id: 'm1', createdTime: 't', direction: 'user', text: 'hi', keys: ['id', 'message'], attachmentsShape: 'missing', raw: 'LEAK' }], raw: 'LEAK' };
      },
      async getUserProfile() { return { ok: false, safeErrorCode: 'user_consent_required', raw: 'LEAK' }; },
    };
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', diagnostics, clock: () => now } as never);
    const { server, origin } = await listen(handler);
    const headers = { 'x-csrf-token': 'csrf' };
    const path = (accountId: string, commentId: string) => `/api/diagnostics/conversation?accountId=${encodeURIComponent(accountId)}&commentId=${encodeURIComponent(commentId)}`;
    try {
      assert.equal((await call(origin, path(ctx.accountId, 'c1'))).status, 403);
      assert.equal((await call(origin, path(ctx.accountId, 'c1'), { headers: { 'x-csrf-token': 'wrong' } })).status, 403);
      assert.equal((await call(origin, '/api/diagnostics/conversation?commentId=c1', { headers })).status, 400);
      assert.equal((await call(origin, path('missing', 'c1'), { headers })).status, 404);
      assert.equal((await call(origin, path(ctx.accountId, 'bad id/../x'), { headers })).status, 400);
      const cross = await call(origin, path(ctx.accountId, 'c3'), { headers });
      assert.deepEqual([cross.status, cross.json.error], [404, 'comment_not_found']);
      const unknown = await call(origin, path(ctx.accountId, 'c2'), { headers });
      assert.deepEqual([unknown.status, unknown.json.error], [409, 'igsid_unknown']);
      assert.equal((await call(origin, path(ctx.accountId, 'c1'), { method: 'POST', headers: { ...headers, origin, 'content-type': 'application/json' }, body: {} })).status, 404);
      assert.equal(seen.length, 0);

      const ok = await call(origin, path(ctx.accountId, 'c1'), { headers });
      assert.equal(ok.status, 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.igsid, IGSID);
      assert.equal(seen[0]!.account.accountId, ctx.accountId);
      assert.equal(ok.json.igsid, '…2211');
      assert.deepEqual(ok.json.conversation, { found: true, messages: [{ id: 'm1', createdTime: 't', direction: 'user', text: 'hi', keys: ['id', 'message'], attachmentsShape: 'missing' }] });
      assert.deepEqual(ok.json.profile, { ok: false, safeErrorCode: 'user_consent_required' });
      assert.equal(JSON.stringify(ok.json).includes('LEAK'), false);
      assert.equal(JSON.stringify(ok.json).includes(IGSID), false);

      const limited = await call(origin, path(ctx.accountId, 'c1'), { headers });
      assert.deepEqual([limited.status, limited.json.error], [429, 'diagnostics_rate_limited']);
      now += 21_000;
      assert.equal((await call(origin, path(ctx.accountId, 'c1'), { headers })).status, 200);
      assert.equal(seen.length, 2);
    } finally { server.close(); }

    const unavailable = createApiHandler({ database: db, csrfToken: 'csrf' } as never);
    const second = await listen(unavailable);
    try {
      assert.equal((await call(second.origin, path(ctx.accountId, 'c1'), { headers })).status, 503);
    } finally { second.server.close(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// UI helper
// ---------------------------------------------------------------------------------------------------------------

test('interactiveRequestFields sends none with no titles and trims non-empty titles otherwise', () => {
  assert.deepEqual(interactiveRequestFields('none', ['a', 'b']), { interactiveMode: 'none', interactiveTitles: [] });
  assert.deepEqual(interactiveRequestFields('quick_reply', [' Ya te sigo ', '', '  ', 'No']), { interactiveMode: 'quick_reply', interactiveTitles: ['Ya te sigo', 'No'] });
  assert.deepEqual(interactiveRequestFields('weird', ['a']), { interactiveMode: 'none', interactiveTitles: [] });
});
