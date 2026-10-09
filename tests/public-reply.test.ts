import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AccountRef } from '../src/core/domain.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia, listEncryptedCredentials } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { MetaProvider } from '../src/providers/meta/provider.ts';
import { createVault } from '../src/security/vault.ts';
import { AutomationService } from '../src/services/automations.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { Scheduler } from '../src/services/scheduler.ts';
import { removeTempDir } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDatabase>;
const HOUR = 60 * 60 * 1000;
const VARIANTS = ['¡Listo @{{username}}! Te escribí por DM', 'Revisa tu bandeja, @{{username}}', 'Enviado, {{username}} ({{keyword}})'];

async function withDb(run: (db: Db, directory: string) => Promise<void> | void, target?: number): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'public-reply-'));
  const db = openDatabase(directory);
  if (target === undefined) migrateDatabase(db); else migrateDatabase(db, target);
  try { await run(db, directory); } finally { db.close(); removeTempDir(directory); }
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

function automation(db: Db, ctx: { accountId: string; mediaId: string }, options: { variants?: string[]; enabled?: boolean; real?: boolean } = {}): string {
  const service = new AutomationService(db);
  const id = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Auto', replyText: 'Hola {{username}}',
    publicReplyEnabled: options.enabled ?? true, publicReplyVariants: options.variants ?? VARIANTS } as never);
  service.addKeyword(ctx.accountId, id, 'guide');
  service.setEnabled(ctx.accountId, id, true);
  if (options.real ?? true) service.setRealEnabled(ctx.accountId, id, true, true);
  return id;
}

function comment(db: Db, ctx: { accountId: string; mediaId: string }, commentId: string, username = 'customer'): void {
  createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId, text: 'quiero la guide', username,
    createdAt: new Date(Date.now() - 60_000).toISOString() });
}

type Outcome = { outcome: 'accepted' | 'definitive_rejection' | 'ambiguous'; messageId?: string; replyId?: string; safeErrorCode?: string; httpStatus?: number; usageHeaders?: { retryAfter?: string } };

function fakeProvider(options: { privateResult?: () => Outcome; publicResult?: () => Outcome | Promise<Outcome>; onPublic?: () => void } = {}) {
  const order: string[] = [];
  const publicTexts: string[] = [];
  let sequence = 0;
  const provider = {
    order, publicTexts,
    async getComment(_account: unknown, commentId: string) {
      return { commentId, text: 'quiero la guide', username: 'customer', createdAt: new Date(Date.now() - 60_000).toISOString() };
    },
    async sendPrivateReply() { order.push('private'); sequence++; return options.privateResult?.() ?? { outcome: 'accepted', messageId: `msg-${sequence}` }; },
    async readMessage(_account: unknown, messageId: string) { return { messageId, observedAt: new Date().toISOString() }; },
    async replyToComment(_account: AccountRef, _commentId: string, message: string) {
      order.push('public'); publicTexts.push(message); sequence++;
      options.onPublic?.();
      return (await options.publicResult?.()) ?? { outcome: 'accepted', replyId: `reply-${sequence}` };
    },
    async listComments() { return { items: [], complete: true }; },
    async listMedia() { return { items: [], complete: true }; },
  };
  return provider;
}

const one = (db: Db, sql: string, ...params: unknown[]) => db.prepare(sql).get(...params as never[]) as Record<string, any>;
const publicEvents = (db: Db, commentId: string) => (db.prepare(`SELECT e.event_type, e.reply_id, e.safe_error_code FROM public_reply_attempts e
  JOIN queue_items q ON q.queue_item_id=e.queue_item_id WHERE q.comment_id=? ORDER BY e.rowid`).all(commentId) as Array<Record<string, any>>);
const item = (db: Db, commentId: string) => one(db, `SELECT * FROM queue_items WHERE comment_id=?`, commentId);
const privateIntents = (db: Db) => (one(db, `SELECT COUNT(*) AS n FROM send_attempts WHERE event_type='intent_recorded'`)).n as number;

async function sendPrivate(db: Db, queue: QueueService, ctx: { accountId: string }, automationId: string, commentId: string) {
  await queue.enqueueReviewed(ctx.accountId, automationId, [commentId]);
  await queue.processOne(ctx.accountId);
}

// ---------------------------------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------------------------------

test('migration v10 -> v11 adds public reply columns and append-only attempts table, preserving existing rows', async () => {
  await withDb((db) => {
    assert.equal(one(db, 'PRAGMA user_version').user_version, 10);
    const ctx = seed(db);
    comment(db, ctx, 'c1');
    db.exec(`INSERT INTO automations (automation_id, account_id, media_id, scope, name, status, created_at, updated_at, real_enabled, version)
        VALUES ('a1','acc','m','media','Old','enabled','2026','2026',1,4);
      INSERT INTO automations (automation_id, account_id, media_id, scope, name, created_at, updated_at) VALUES ('g1','acc',NULL,'account','G','2026','2026');
      INSERT INTO queue_items(queue_item_id,account_id,comment_id,automation_id,state,dry_run,payload_json,created_at,updated_at)
        VALUES ('q1','acc','c1','a1','SENT',0,'{"text":"x"}','2026','2026');
      INSERT INTO send_attempts(attempt_event_id,account_id,queue_item_id,event_type,event_at) VALUES ('e1','acc','q1','accepted','2026');`);
    migrateDatabase(db);
    assert.equal(one(db, 'PRAGMA user_version').user_version, 17);
    assert.equal(one(db, 'PRAGMA foreign_keys').foreign_keys, 1);
    const auto = one(db, `SELECT * FROM automations WHERE automation_id='a1'`);
    assert.equal(auto.public_reply_enabled, 0);
    assert.equal(auto.public_reply_variants_json, '[]');
    assert.equal(auto.version, 4);
    assert.equal(one(db, `SELECT scope FROM automations WHERE automation_id='g1'`).scope, 'account');
    const queued = one(db, `SELECT * FROM queue_items WHERE queue_item_id='q1'`);
    assert.equal(queued.state, 'SENT');
    assert.equal(queued.public_reply_state, null);
    assert.equal(queued.public_reply_text, null);
    assert.equal(queued.public_reply_attempts, 0);
    assert.equal(queued.public_reply_next_at, null);
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM send_attempts`).n, 1);
    assert.throws(() => db.exec(`UPDATE queue_items SET public_reply_state='BOGUS' WHERE queue_item_id='q1'`), /CHECK/);
    assert.throws(() => db.exec(`UPDATE automations SET public_reply_enabled=2 WHERE automation_id='a1'`), /CHECK/);
    db.exec(`INSERT INTO public_reply_attempts(attempt_event_id,account_id,queue_item_id,event_type,event_at) VALUES ('p1','acc','q1','intent_recorded','2026')`);
    assert.throws(() => db.exec(`INSERT INTO public_reply_attempts(attempt_event_id,account_id,queue_item_id,event_type,event_at) VALUES ('p2','acc','q1','bogus','2026')`), /CHECK/);
    assert.throws(() => db.exec(`INSERT INTO public_reply_attempts(attempt_event_id,account_id,queue_item_id,event_type,event_at) VALUES ('p3','other','q1','intent_recorded','2026')`), /FOREIGN KEY/);
    db.exec(`INSERT INTO public_reply_attempts(attempt_event_id,account_id,queue_item_id,event_type,event_at,reply_id) VALUES ('p4','acc','q1','accepted','2026','r1')`);
    assert.throws(() => db.exec(`INSERT INTO public_reply_attempts(attempt_event_id,account_id,queue_item_id,event_type,event_at,reply_id) VALUES ('p5','acc','q1','accepted','2026','r2')`), /UNIQUE/);
    assert.throws(() => db.exec(`UPDATE public_reply_attempts SET safe_error_code='x'`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM public_reply_attempts`), /append-only/);
    migrateDatabase(db);
    assert.equal(one(db, 'PRAGMA user_version').user_version, 17);
  }, 10);
});

// ---------------------------------------------------------------------------------------------------------------
// Provider request construction and error mapping
// ---------------------------------------------------------------------------------------------------------------

function providerState(directory: string, loginKind: 'instagram_login' | 'facebook_login') {
  const db = openDatabase(join(directory, loginKind));
  migrateDatabase(db);
  const vault = createVault(join(directory, loginKind), () => listEncryptedCredentials(db));
  const connectionId = `${loginKind}-conn`;
  createConnection(db, { id: connectionId, name: 'p', providerCode: 'META', loginKind, graphVersion: 'v26.0', status: 'valid',
    accessToken: vault.encrypt(connectionId, loginKind === 'instagram_login' ? 'ig-user-token' : 'fb-user-token') });
  addDiscoveredAccount(db, { accountId: 'acc', connectionId, providerAccountId: '17841400000000000', username: 'brand', status: 'valid' });
  if (loginKind === 'facebook_login') {
    const secret = vault.encrypt('account:acc', 'page-token');
    db.prepare(`UPDATE social_accounts SET page_token_nonce=?, page_token_ciphertext=?, page_token_tag=? WHERE account_id='acc'`).run(secret.nonce, secret.ciphertext, secret.tag);
  }
  createMedia(db, { accountId: 'acc', mediaId: 'media', permalink: null, publishedAt: null });
  createComment(db, { accountId: 'acc', mediaId: 'media', commentId: '18000000000000001', text: 'guide', username: 'customer', createdAt: null });
  return { db, vault, account: { accountId: 'acc', connectionId, providerAccountId: '17841400000000000', username: 'brand' } satisfies AccountRef };
}

for (const [loginKind, origin, token] of [['instagram_login', 'https://graph.instagram.com', 'ig-user-token'], ['facebook_login', 'https://graph.facebook.com', 'page-token']] as const) {
  test(`provider replyToComment (${loginKind}) posts /{comment-id}/replies on ${origin} with bearer header and JSON message`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'public-provider-'));
    const state = providerState(directory, loginKind);
    try {
      const calls: Array<{ url: URL; init: RequestInit }> = [];
      const provider = new MetaProvider(state.db, state.vault, async (input, init = {}) => {
        calls.push({ url: new URL(String(input)), init });
        return Response.json({ id: '17900000000000099' });
      });
      const result = await provider.replyToComment(state.account, '18000000000000001', '¡Listo @customer!');
      assert.deepEqual({ outcome: result.outcome, replyId: result.replyId }, { outcome: 'accepted', replyId: '17900000000000099' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.url.origin, origin);
      assert.equal(calls[0]!.url.pathname, '/v26.0/18000000000000001/replies');
      assert.equal(calls[0]!.url.search, '');
      assert.equal(calls[0]!.init.method, 'POST');
      assert.equal(calls[0]!.init.redirect, 'error');
      assert.equal(new Headers(calls[0]!.init.headers).get('authorization'), `Bearer ${token}`);
      assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { message: '¡Listo @customer!' });
      assert.equal(String(calls[0]!.init.body).includes(token), false);
      // Foreign comment or invalid message: definitive rejection without any request.
      assert.equal((await provider.replyToComment(state.account, 'foreign-comment', 'x')).safeErrorCode, 'comment_not_owned');
      assert.equal((await provider.replyToComment(state.account, '18000000000000001', '   ')).outcome, 'definitive_rejection');
      assert.equal((await provider.replyToComment(state.account, '18000000000000001', 'x'.repeat(1001))).outcome, 'definitive_rejection');
      assert.equal(calls.length, 1);
    } finally { state.db.close(); removeTempDir(directory); }
  });
}

test('provider replyToComment maps permission, rate-limit, server and malformed outcomes safely', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'public-provider-'));
  const state = providerState(directory, 'instagram_login');
  try {
    const reply = (response: () => Response | Promise<Response>) => new MetaProvider(state.db, state.vault, async () => response())
      .replyToComment(state.account, '18000000000000001', 'hola');
    const error = (status: number, code: number, headers: Record<string, string> = {}) => () => Response.json({ error: { code, message: 'secret detail token=abc' } }, { status, headers });
    for (const code of [10, 200, 230, 190, 102, 3]) {
      const result = await reply(error(403, code));
      assert.deepEqual({ outcome: result.outcome, safeErrorCode: result.safeErrorCode }, { outcome: 'definitive_rejection', safeErrorCode: 'public_reply_permission_denied' }, String(code));
    }
    for (const code of [4, 17, 32, 613]) {
      const result = await reply(error(400, code, { 'retry-after': '120' }));
      assert.equal(result.outcome, 'definitive_rejection');
      assert.equal(result.safeErrorCode, 'public_reply_rate_limited');
      assert.equal(result.usageHeaders?.retryAfter, '120');
    }
    assert.equal((await reply(error(429, 1))).safeErrorCode, 'public_reply_rate_limited');
    const other = await reply(error(400, 100));
    assert.deepEqual({ outcome: other.outcome, safeErrorCode: other.safeErrorCode }, { outcome: 'definitive_rejection', safeErrorCode: 'meta_100' });
    assert.equal((await reply(error(500, 2))).outcome, 'ambiguous');
    assert.equal((await reply(() => Response.json({}))).outcome, 'ambiguous');
    assert.equal((await reply(() => Response.json({}))).safeErrorCode, 'meta_missing_reply_id');
    assert.equal((await reply(() => new Response('not json', { status: 200 }))).outcome, 'ambiguous');
    assert.equal((await reply(() => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); })).outcome, 'ambiguous');
    assert.equal((await reply(() => { throw new TypeError('redirect'); })).outcome, 'ambiguous');
    const serialized = JSON.stringify(await reply(error(403, 10)));
    assert.equal(serialized.includes('secret'), false);
  } finally { state.db.close(); removeTempDir(directory); }
});

// ---------------------------------------------------------------------------------------------------------------
// Ordering, scheduling and failure isolation
// ---------------------------------------------------------------------------------------------------------------

test('private first, public after: PENDING is set atomically with SENT and the public POST happens only afterwards', async () => {
  await withDb(async (db, directory) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    const observer = openDatabase(directory);
    let observed: Record<string, any> | undefined;
    const provider = fakeProvider({ onPublic: () => {
      observed = {
        state: { ...(observer.prepare(`SELECT state, public_reply_state FROM queue_items WHERE comment_id='c1'`).get() as Record<string, any>) },
        intents: (observer.prepare(`SELECT COUNT(*) AS n FROM public_reply_attempts WHERE event_type='intent_recorded'`).get() as { n: number }).n,
      };
    } });
    try {
      const queue = new QueueService(db, provider as never, { rng: () => 0 } as never);
      queue.setDryRun(false, true);
      await sendPrivate(db, queue, ctx, automationId, 'c1');
      const afterPrivate = item(db, 'c1');
      assert.equal(afterPrivate.state, 'SENT');
      assert.equal(afterPrivate.public_reply_state, 'PENDING');
      assert.equal(afterPrivate.public_reply_text, '¡Listo @customer! Te escribí por DM');
      assert.deepEqual(provider.order, ['private']);
      assert.ok(await queue.processPublicReply(ctx.accountId));
      assert.deepEqual(provider.order, ['private', 'public']);
      assert.deepEqual(provider.publicTexts, ['¡Listo @customer! Te escribí por DM']);
      // Durable intent committed and visible from a second connection before the POST.
      assert.deepEqual(observed, { state: { state: 'SENT', public_reply_state: 'SENDING' }, intents: 1 });
      const done = item(db, 'c1');
      assert.equal(done.public_reply_state, 'SENT');
      assert.equal(done.public_reply_attempts, 1);
      assert.deepEqual(publicEvents(db, 'c1').map((event) => [event.event_type, event.reply_id]), [['intent_recorded', null], ['accepted', 'reply-2']]);
      // Idempotent: nothing else is posted.
      assert.equal(await queue.processPublicReply(ctx.accountId), null);
      assert.equal(await queue.processPublicReply(), null);
      assert.deepEqual(provider.order, ['private', 'public']);
    } finally { observer.close(); }
  });
});

test('a failed or ambiguous private reply never schedules a public reply', async () => {
  for (const privateResult of [
    (): Outcome => ({ outcome: 'definitive_rejection', safeErrorCode: 'meta_100', httpStatus: 400 }),
    (): Outcome => ({ outcome: 'ambiguous', safeErrorCode: 'meta_timeout' }),
    (): Outcome => ({ outcome: 'accepted' }),
  ]) {
    await withDb(async (db) => {
      const ctx = seed(db);
      const automationId = automation(db, ctx);
      comment(db, ctx, 'c1');
      const provider = fakeProvider({ privateResult });
      const queue = new QueueService(db, provider as never);
      queue.setDryRun(false, true);
      await sendPrivate(db, queue, ctx, automationId, 'c1');
      assert.notEqual(item(db, 'c1').state, 'SENT');
      assert.equal(item(db, 'c1').public_reply_state, null);
      assert.equal(await queue.processPublicReply(), null);
      assert.deepEqual(provider.order, ['private']);
    });
  }
});

test('a public failure never changes the private SENT state and never re-sends the private message', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    const provider = fakeProvider({ publicResult: () => ({ outcome: 'definitive_rejection', safeErrorCode: 'meta_100', httpStatus: 400 }) });
    let now = Date.now();
    const queue = new QueueService(db, provider as never, { clock: () => now, sendSpacingMs: 0, publicReplySpacingMs: 0 } as never);
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    await queue.processPublicReply();
    assert.equal(item(db, 'c1').state, 'SENT');
    assert.equal(item(db, 'c1').public_reply_state, 'FAILED');
    for (let index = 0; index < 3; index++) {
      now += HOUR;
      assert.equal(await queue.processOne(), null);
      assert.equal(await queue.processPublicReply(), null);
    }
    assert.deepEqual(provider.order, ['private', 'public']);
    assert.equal(privateIntents(db), 1);
    assert.equal(item(db, 'c1').state, 'SENT');
    // Also with an explicit retry the private state is untouched and only the public step runs again.
    queue.retryPublicReply(ctx.accountId, item(db, 'c1').queue_item_id);
    assert.equal(item(db, 'c1').public_reply_state, 'PENDING');
    await queue.processPublicReply();
    assert.deepEqual(provider.order, ['private', 'public', 'public']);
    assert.equal(privateIntents(db), 1);
    assert.equal(item(db, 'c1').state, 'SENT');
  });
});

test('concurrent processPublicReply calls dispatch at most one POST', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    const provider = fakeProvider({ publicResult: () => new Promise((resolve) => setTimeout(() => resolve({ outcome: 'accepted', replyId: 'r' }), 20)) });
    const queue = new QueueService(db, provider as never, { publicReplySpacingMs: 0 } as never);
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    await Promise.all([queue.processPublicReply(), queue.processPublicReply(), queue.processPublicReply(ctx.accountId)]);
    assert.deepEqual(provider.order, ['private', 'public']);
  });
});

test('ambiguous public outcome becomes UNKNOWN_OUTCOME and is never retried, also not by the retry action', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    const provider = fakeProvider({ publicResult: () => { throw new Error('socket hang up'); } });
    let now = Date.now();
    const queue = new QueueService(db, provider as never, { clock: () => now, publicReplySpacingMs: 0 } as never);
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    await queue.processPublicReply();
    assert.equal(item(db, 'c1').public_reply_state, 'UNKNOWN_OUTCOME');
    now += HOUR;
    assert.equal(await queue.processPublicReply(), null);
    assert.throws(() => queue.retryPublicReply(ctx.accountId, item(db, 'c1').queue_item_id), /public_reply_not_failed/);
    assert.deepEqual(provider.order, ['private', 'public']);
    assert.deepEqual(publicEvents(db, 'c1').map((event) => event.event_type), ['intent_recorded', 'ambiguous']);
    assert.equal(item(db, 'c1').state, 'SENT');
  });
});

test('startup recovery turns an interrupted public SENDING into UNKNOWN_OUTCOME without any POST', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    const provider = fakeProvider();
    const queue = new QueueService(db, provider as never);
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    const id = item(db, 'c1').queue_item_id;
    // Simulate a crash after the durable intent commit and before any outcome was persisted.
    db.prepare(`UPDATE queue_items SET public_reply_state='SENDING', public_reply_attempts=1 WHERE queue_item_id=?`).run(id);
    db.prepare(`INSERT INTO public_reply_attempts(attempt_event_id,account_id,queue_item_id,event_type,event_at) VALUES ('crash','acc',?,'intent_recorded',?)`).run(id, new Date().toISOString());
    const restarted = new QueueService(db, provider as never, { publicReplySpacingMs: 0 } as never);
    new Scheduler(db, new Scanner(db, provider as never), restarted);
    assert.equal(item(db, 'c1').public_reply_state, 'UNKNOWN_OUTCOME');
    assert.equal(item(db, 'c1').state, 'SENT');
    assert.equal(await restarted.processPublicReply(), null);
    assert.deepEqual(provider.order, ['private']);
    assert.deepEqual(publicEvents(db, 'c1').map((event) => event.event_type), ['intent_recorded', 'ambiguous']);
  });
});

test('rate-limited public replies retry with bounded attempts, respecting Retry-After, then FAILED', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    const provider = fakeProvider({ publicResult: () => ({ outcome: 'definitive_rejection', safeErrorCode: 'public_reply_rate_limited', httpStatus: 400, usageHeaders: { retryAfter: '600' } }) });
    let now = Date.now();
    const queue = new QueueService(db, provider as never, { clock: () => now, publicReplySpacingMs: 0 } as never);
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    await queue.processPublicReply();
    let row = item(db, 'c1');
    assert.equal(row.public_reply_state, 'PENDING');
    assert.ok(Date.parse(row.public_reply_next_at) >= now + 600_000);
    now += 599_000;
    assert.equal(await queue.processPublicReply(), null);
    now += 2_000;
    await queue.processPublicReply();
    row = item(db, 'c1');
    assert.equal(row.public_reply_state, 'PENDING');
    now = Date.parse(row.public_reply_next_at) + 1;
    await queue.processPublicReply();
    row = item(db, 'c1');
    assert.equal(row.public_reply_state, 'FAILED');
    assert.equal(row.public_reply_attempts, 3);
    now += HOUR;
    assert.equal(await queue.processPublicReply(), null);
    assert.equal(provider.order.filter((entry) => entry === 'public').length, 3);
    assert.equal(row.state, 'SENT');
  });
});

test('permission denied is permanent: FAILED after one attempt, never retried automatically', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    const provider = fakeProvider({ publicResult: () => ({ outcome: 'definitive_rejection', safeErrorCode: 'public_reply_permission_denied', httpStatus: 403 }) });
    let now = Date.now();
    const queue = new QueueService(db, provider as never, { clock: () => now, publicReplySpacingMs: 0 } as never);
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    await queue.processPublicReply();
    assert.equal(item(db, 'c1').public_reply_state, 'FAILED');
    assert.equal(item(db, 'c1').public_reply_attempts, 1);
    assert.deepEqual(publicEvents(db, 'c1').map((event) => [event.event_type, event.safe_error_code]),
      [['intent_recorded', null], ['definitive_rejection', 'public_reply_permission_denied']]);
    now += 2 * HOUR;
    assert.equal(await queue.processPublicReply(), null);
    assert.equal(provider.order.filter((entry) => entry === 'public').length, 1);
  });
});

test('Dry Run never calls the public provider and stores a would-be public reply preview on the simulated item', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx, { real: false });
    comment(db, ctx, 'c1');
    const provider = fakeProvider();
    const queue = new QueueService(db, provider as never, { rng: () => 0, publicReplySpacingMs: 0 } as never);
    await queue.enqueueReviewed(ctx.accountId, automationId, ['c1']);
    const row = item(db, 'c1');
    assert.equal(row.state, 'SIMULATED');
    assert.equal(row.public_reply_state, null);
    assert.equal(row.public_reply_text, '¡Listo @customer! Te escribí por DM');
    assert.equal(await queue.processOne(), null);
    assert.equal(await queue.processPublicReply(), null);
    // Even a PENDING item is not posted while global Dry Run is on.
    db.prepare(`UPDATE queue_items SET state='SENT', public_reply_state='PENDING' WHERE comment_id='c1'`).run();
    assert.equal(await queue.processPublicReply(), null);
    assert.deepEqual(provider.order, []);
  });
});

test('variant rotation persists the rendered text and never repeats within the last three for the account', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const variants = ['A {{username}}', 'B {{username}}', 'C {{username}}', 'D {{username}}', 'E {{username}}'];
    const automationId = automation(db, ctx, { variants });
    let now = Date.now();
    const provider = fakeProvider();
    const queue = new QueueService(db, provider as never, { clock: () => (now += 1), rng: () => 0, sendSpacingMs: 0, publicReplySpacingMs: 0 } as never);
    queue.setDryRun(false, true);
    const posted: string[] = [];
    for (let index = 0; index < 8; index++) {
      comment(db, ctx, `c${index}`);
      await sendPrivate(db, queue, ctx, automationId, `c${index}`);
      await queue.processPublicReply();
      posted.push(item(db, `c${index}`).public_reply_text as string);
    }
    assert.deepEqual(posted, ['A customer', 'B customer', 'C customer', 'D customer', 'A customer', 'B customer', 'C customer', 'D customer']);
    assert.deepEqual(provider.publicTexts, posted);
    for (let index = 0; index < posted.length; index++) assert.equal(posted.slice(Math.max(0, index - 3), index).includes(posted[index]!), false);
  });
});

// Regression (Windows CI): the private send-spacing check compared the injected queue clock against intent events
// stamped with the wall clock. When the queue clock lags wall time (slow runner, coarse timer) every later send was
// refused, so the rotation above saw null public replies. All queue timestamps must come from one clock.
for (const [label, makeClock] of [
  ['lags wall time', () => { let now = Date.now() - 5_000; return () => (now += 1); }],
  ['returns the same millisecond for every call', () => { const now = Date.now() - 5_000; return () => now; }],
] as const) {
  test(`variant rotation still holds when the queue clock ${label}`, async () => {
    await withDb(async (db) => {
      const ctx = seed(db);
      const variants = ['A {{username}}', 'B {{username}}', 'C {{username}}', 'D {{username}}', 'E {{username}}'];
      const automationId = automation(db, ctx, { variants });
      const provider = fakeProvider();
      const queue = new QueueService(db, provider as never, { clock: makeClock(), rng: () => 0, sendSpacingMs: 0, publicReplySpacingMs: 0 } as never);
      queue.setDryRun(false, true);
      const posted: Array<string | null> = [];
      for (let index = 0; index < 6; index++) {
        comment(db, ctx, `c${index}`);
        await sendPrivate(db, queue, ctx, automationId, `c${index}`);
        await queue.processPublicReply();
        posted.push(item(db, `c${index}`).public_reply_text as string | null);
      }
      assert.deepEqual(posted, ['A customer', 'B customer', 'C customer', 'D customer', 'A customer', 'B customer']);
      assert.equal(privateIntents(db), 6);
    });
  });
}

test('public replies keep their own minimum spacing (default 20 s)', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    let now = Date.now() + 5_000; // ahead of real time: private spacing compares this clock with real-time intent timestamps
    const provider = fakeProvider();
    const queue = new QueueService(db, provider as never, { clock: () => now, sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    comment(db, ctx, 'c1');
    comment(db, ctx, 'c2');
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    await sendPrivate(db, queue, ctx, automationId, 'c2');
    assert.ok(await queue.processPublicReply());
    now += 19_000;
    assert.equal(await queue.processPublicReply(), null);
    now += 1_000;
    assert.ok(await queue.processPublicReply());
    assert.equal(provider.order.filter((entry) => entry === 'public').length, 2);
  });
});

test('public reply expires after 24 h from the private send without any POST', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    let now = Date.now();
    const provider = fakeProvider();
    const queue = new QueueService(db, provider as never, { clock: () => now, publicReplySpacingMs: 0 } as never);
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    now += 24 * HOUR + 60_000;
    await queue.processPublicReply();
    assert.equal(item(db, 'c1').public_reply_state, 'EXPIRED');
    assert.equal(item(db, 'c1').state, 'SENT');
    assert.deepEqual(publicEvents(db, 'c1').map((event) => event.event_type), ['expired']);
    assert.deepEqual(provider.order, ['private']);
  });
});

test('public reply turned off or automation archived after the private send becomes SKIPPED', async () => {
  for (const change of [
    (db: Db) => db.prepare(`UPDATE automations SET public_reply_enabled=0`).run(),
    (db: Db) => db.prepare(`UPDATE automations SET name=name || ' (archived)', status='disabled'`).run(),
    (db: Db) => db.prepare(`UPDATE automations SET status='disabled'`).run(),
  ]) {
    await withDb(async (db) => {
      const ctx = seed(db);
      const automationId = automation(db, ctx);
      comment(db, ctx, 'c1');
      const provider = fakeProvider();
      const queue = new QueueService(db, provider as never, { publicReplySpacingMs: 0 } as never);
      queue.setDryRun(false, true);
      await sendPrivate(db, queue, ctx, automationId, 'c1');
      change(db);
      await queue.processPublicReply();
      assert.equal(item(db, 'c1').public_reply_state, 'SKIPPED');
      assert.equal(item(db, 'c1').state, 'SENT');
      assert.deepEqual(provider.order, ['private']);
    });
  }
});

test('automation without public reply never schedules one', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx, { enabled: false });
    comment(db, ctx, 'c1');
    const provider = fakeProvider();
    const queue = new QueueService(db, provider as never);
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    assert.equal(item(db, 'c1').state, 'SENT');
    assert.equal(item(db, 'c1').public_reply_state, null);
    assert.equal(await queue.processPublicReply(), null);
  });
});

test('account isolation: processing and retry are scoped to the owning account', async () => {
  await withDb(async (db) => {
    const first = seed(db);
    const second = seed(db, '2');
    const automationId = automation(db, first);
    comment(db, first, 'c1');
    const provider = fakeProvider({ publicResult: () => ({ outcome: 'definitive_rejection', safeErrorCode: 'meta_100', httpStatus: 400 }) });
    const queue = new QueueService(db, provider as never, { publicReplySpacingMs: 0 } as never);
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, first, automationId, 'c1');
    assert.equal(await queue.processPublicReply(second.accountId), null);
    assert.equal(item(db, 'c1').public_reply_state, 'PENDING');
    await queue.processPublicReply(first.accountId);
    assert.equal(item(db, 'c1').public_reply_state, 'FAILED');
    assert.throws(() => queue.retryPublicReply(second.accountId, item(db, 'c1').queue_item_id), /queue_item_not_found/);
    assert.equal(item(db, 'c1').public_reply_state, 'FAILED');
  });
});

test('owner_replied: our own later public reply does not affect the sent private item; an earlier owner reply still excludes', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    const provider = fakeProvider();
    const queue = new QueueService(db, provider as never, { sendSpacingMs: 0, publicReplySpacingMs: 0 } as never);
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    await queue.processPublicReply();
    // A later scan stores the public reply this app created (authored by the account itself).
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'own-public-reply', text: '¡Listo!', username: ctx.username,
      createdAt: new Date().toISOString(), parentId: 'c1' } as never);
    assert.equal(await queue.processOne(), null);
    assert.equal(await queue.processPublicReply(), null);
    assert.equal(item(db, 'c1').state, 'SENT');
    assert.equal(item(db, 'c1').public_reply_state, 'SENT');
    assert.deepEqual(provider.order, ['private', 'public']);
    await assert.rejects(queue.enqueueReviewed(ctx.accountId, automationId, ['c1']), /not safely eligible/);
    // A comment the owner already answered publicly BEFORE queueing is still excluded.
    comment(db, ctx, 'c2');
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'manual-reply', text: 'Te escribí', username: ctx.username,
      createdAt: new Date().toISOString(), parentId: 'c2' } as never);
    await assert.rejects(queue.enqueueReviewed(ctx.accountId, automationId, ['c2']), /not safely eligible/);
    assert.equal(item(db, 'c2'), undefined);
  });
});

test('scheduler tick runs the public step after the private step, at most one public reply per tick', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    comment(db, ctx, 'c2');
    const provider = fakeProvider();
    const queue = new QueueService(db, provider as never, { sendSpacingMs: 0, publicReplySpacingMs: 0 } as never);
    const scheduler = new Scheduler(db, new Scanner(db, provider as never), queue, { sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed(ctx.accountId, automationId, ['c1', 'c2']);
    scheduler.startAll();
    await scheduler.tick();
    assert.deepEqual(provider.order, ['private', 'public']);
    await scheduler.tick();
    assert.deepEqual(provider.order, ['private', 'public', 'private', 'public']);
    await scheduler.tick();
    assert.equal(provider.order.length, 4);
    scheduler.stopAll();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------------------------------------------

async function withApi(run: (ctx: { db: Db; queue: QueueService; provider: ReturnType<typeof fakeProvider>; call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }> }) => Promise<void>) {
  await withDb(async (db) => {
    seed(db);
    seed(db, '2');
    const provider = fakeProvider({ publicResult: () => ({ outcome: 'definitive_rejection', safeErrorCode: 'public_reply_permission_denied', httpStatus: 403 }) });
    const queue = new QueueService(db, provider as never, { rng: () => 0, publicReplySpacingMs: 0 } as never);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', automations: new AutomationService(db), queue });
    const server = createServer((req, res) => { void handler(req, res); });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request(new URL(path, origin), { method, headers: { origin, 'x-csrf-token': 'csrf', 'content-type': 'application/json' } }, (res) => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try { await run({ db, queue, provider, call }); } finally { server.close(); }
  });
}

const body = { accountId: 'acc', mediaId: 'm', name: 'Auto', keywords: ['guide'], replyText: 'Hola {{username}}' };

test('API: automations accept and expose publicReplyEnabled/publicReplyVariants with strict validation', async () => {
  await withApi(async ({ call }) => {
    const created = await call('POST', '/api/automations', { ...body, publicReplyEnabled: true, publicReplyVariants: [' Hola @{{username}} ', 'Listo {{keyword}}'] });
    assert.equal(created.status, 201);
    const plain = await call('POST', '/api/automations', { ...body, name: 'Plain' });
    assert.equal(plain.status, 201);
    const list = await call('GET', '/api/automations?accountId=acc');
    const byId = Object.fromEntries(list.body.automations.map((row: { automationId: string }) => [row.automationId, row]));
    assert.equal(byId[created.body.automationId].publicReplyEnabled, true);
    assert.deepEqual(byId[created.body.automationId].publicReplyVariants, ['Hola @{{username}}', 'Listo {{keyword}}']);
    assert.equal(byId[plain.body.automationId].publicReplyEnabled, false);
    assert.deepEqual(byId[plain.body.automationId].publicReplyVariants, []);
    for (const invalid of [
      { publicReplyEnabled: true }, { publicReplyEnabled: true, publicReplyVariants: [] }, { publicReplyEnabled: 'true', publicReplyVariants: ['x'] },
      { publicReplyEnabled: 1, publicReplyVariants: ['x'] }, { publicReplyVariants: 'x' }, { publicReplyVariants: [1] },
      { publicReplyEnabled: true, publicReplyVariants: ['Hola {{comment}}'] }, { publicReplyEnabled: true, publicReplyVariants: ['a', 'A'] },
      { publicReplyEnabled: true, publicReplyVariants: Array.from({ length: 51 }, (_, index) => `v${index}`) },
    ]) {
      const response = await call('POST', '/api/automations', { ...body, name: 'Bad', ...invalid });
      assert.equal(response.status, 400, JSON.stringify(invalid).slice(0, 60));
    }
    const edit = { accountId: 'acc', mediaId: 'm', name: 'Auto', replyText: 'Hola {{username}}', matchMode: 'contains', buttons: [], keywords: ['guide'] };
    assert.equal((await call('PUT', `/api/automations/${created.body.automationId}`, edit)).status, 200);
    let row = (await call('GET', '/api/automations?accountId=acc')).body.automations.find((entry: { automationId: string }) => entry.automationId === created.body.automationId);
    assert.equal(row.publicReplyEnabled, true, 'omitted fields keep the stored configuration');
    assert.equal((await call('PUT', `/api/automations/${created.body.automationId}`, { ...edit, publicReplyEnabled: false, publicReplyVariants: ['Nueva'] })).status, 200);
    row = (await call('GET', '/api/automations?accountId=acc')).body.automations.find((entry: { automationId: string }) => entry.automationId === created.body.automationId);
    assert.deepEqual([row.publicReplyEnabled, row.publicReplyVariants], [false, ['Nueva']]);
    assert.equal((await call('PUT', `/api/automations/${created.body.automationId}`, { ...edit, publicReplyEnabled: true, publicReplyVariants: [] })).status, 400);
    assert.equal((await call('PUT', `/api/automations/${created.body.automationId}`, { ...edit, publicReplyEnabled: 'yes' })).status, 400);
    assert.equal((await call('PUT', `/api/automations/${created.body.automationId}`, { ...edit, scope: 'account', mediaId: null })).status, 409);
  });
});

test('API: queue DTO exposes public reply state/text and the retry endpoint enforces ownership and FAILED state', async () => {
  await withApi(async ({ db, queue, provider, call }) => {
    const ctx = { accountId: 'acc', mediaId: 'm' };
    const automationId = automation(db, ctx);
    comment(db, ctx, 'c1');
    queue.setDryRun(false, true);
    await sendPrivate(db, queue, ctx, automationId, 'c1');
    const id = item(db, 'c1').queue_item_id as string;
    let listed = (await call('GET', '/api/queue?accountId=acc')).body.items[0];
    assert.deepEqual([listed.publicReply.state, listed.publicReply.text], ['PENDING', '¡Listo @customer! Te escribí por DM']);
    assert.equal((await call('POST', `/api/queue/${id}/public-reply/retry`, { accountId: 'acc' })).status, 409);
    await queue.processPublicReply();
    listed = (await call('GET', '/api/queue?accountId=acc')).body.items[0];
    assert.deepEqual([listed.state, listed.publicReply.state, listed.publicReply.safeErrorCode], ['SENT', 'FAILED', 'public_reply_permission_denied']);
    assert.equal((await call('POST', `/api/queue/${id}/public-reply/retry`, { accountId: 'acc2' })).status, 404);
    assert.equal((await call('POST', `/api/queue/nope/public-reply/retry`, { accountId: 'acc' })).status, 404);
    assert.equal((await call('POST', `/api/queue/${id}/public-reply/retry`, {})).status, 400);
    const retried = await call('POST', `/api/queue/${id}/public-reply/retry`, { accountId: 'acc' });
    assert.equal(retried.status, 200);
    assert.equal(item(db, 'c1').public_reply_state, 'PENDING');
    assert.equal(item(db, 'c1').state, 'SENT');
    assert.equal(privateIntents(db), 1);
    const events = (await call('GET', `/api/queue/${id}/attempts?accountId=acc`)).body;
    assert.deepEqual(events.publicEvents.map((event: { type: string }) => event.type), ['intent_recorded', 'definitive_rejection', 'manual_retry']);
    assert.deepEqual(provider.order, ['private', 'public']);
  });
});

test('API: simulated queue items expose the would-be public reply preview', async () => {
  await withApi(async ({ db, queue, call }) => {
    const ctx = { accountId: 'acc', mediaId: 'm' };
    const automationId = automation(db, ctx, { real: false });
    comment(db, ctx, 'c1');
    await queue.enqueueReviewed('acc', automationId, ['c1']);
    const listed = (await call('GET', '/api/queue?accountId=acc')).body.items[0];
    assert.equal(listed.state, 'SIMULATED');
    assert.deepEqual(listed.publicReply, { state: null, text: '¡Listo @customer! Te escribí por DM', attempts: 0, nextAt: null, safeErrorCode: null, replyId: null, preview: true });
  });
});
