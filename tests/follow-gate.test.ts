import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AccountRef, SendResult, TapResult } from '../src/core/domain.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia, listEncryptedCredentials } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { MetaProvider } from '../src/providers/meta/provider.ts';
import { createVault } from '../src/security/vault.ts';
import { AutomationService, renderFollowGatePayload, validateFollowGateConfig } from '../src/services/automations.ts';
import { FollowGateService } from '../src/services/follow-gate.ts';
import { GATE_FIRST_POLL_MS, nextGatePollDelay, normalizeTapText } from '../src/services/follow-gate-rules.ts';
import { listPendingReview } from '../src/services/pending-review.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { Scheduler } from '../src/services/scheduler.ts';
import {
  FOLLOW_GATE_DEFAULT_MESSAGE, FOLLOW_GATE_DEFAULT_TITLE, FOLLOW_GATE_NOTE, followGateErrorHint, followGateEventLabel,
  followGatePreview, followGateRequestFields, followGateStateLabel,
} from '../app/follow-gate.ts';
import { removeTempDir } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDatabase>;
/**
 * The follow gate and its attachment are RETIRED (FOLLOW_GATE_AVAILABLE = false). These tests cover the dormant code,
 * so they enable it explicitly through the test-only override; tests/retire-follow-gate.test.ts covers the retirement.
 */
const DORMANT = { followGateAvailable: true } as const;
const one = (db: Db, sql: string, ...params: unknown[]) => ({ ...(db.prepare(sql).get(...params as never[]) as Record<string, any>) });
const all = (db: Db, sql: string, ...params: unknown[]) => (db.prepare(sql).all(...params as never[]) as Array<Record<string, any>>).map((row) => ({ ...row }));
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GATE_MESSAGE = '¡Hola {{username}}! Sígueme y toca el botón 👇';

async function withDb(run: (db: Db, directory: string) => Promise<void> | void, target?: number): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'follow-gate-v13-'));
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

function gateAutomation(db: Db, ctx: { accountId: string; mediaId: string }, extra: Record<string, unknown> = {}): string {
  const service = new AutomationService(db, DORMANT);
  const id = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Gate', replyText: 'Aquí tienes {{keyword}}, {{username}}',
    buttons: [{ title: 'Guía', url: 'https://example.com/guia' }], followGateEnabled: true, followGateMessage: GATE_MESSAGE,
    followGateButtonTitle: 'Ya te sigo', ...extra } as never);
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

/** Real path: enqueue + private send through QueueService (fake provider). Returns the created session (if any). */
async function sendGate(db: Db, ctx: AccountRef & { mediaId: string }, options: { recipientId?: string; authorIgsid?: string; commentId?: string; automationId?: string } = {}) {
  const automationId = options.automationId ?? gateAutomation(db, ctx);
  const commentId = options.commentId ?? 'c1';
  createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId, text: 'quiero la guide', username: 'customer',
    createdAt: new Date(Date.now() - 60_000).toISOString() });
  if (options.authorIgsid) db.prepare(`UPDATE comments SET author_igsid=? WHERE comment_id=?`).run(options.authorIgsid, commentId);
  const provider = sendingProvider({ outcome: 'accepted', messageId: `mid.${commentId}`, ...(options.recipientId ? { recipientId: options.recipientId } : {}) });
  const queue = new QueueService(db, provider as never, { sendSpacingMs: 0, ...DORMANT });
  queue.setDryRun(false, true);
  await queue.enqueueReviewed(ctx.accountId, automationId, [commentId]);
  await queue.processOne(ctx.accountId);
  return { automationId, provider, queue, session: db.prepare(`SELECT * FROM gate_sessions WHERE comment_id=? AND account_id=?`).get(commentId, ctx.accountId) as Record<string, any> | undefined };
}

type FakeGate = {
  taps: Array<{ account: AccountRef; igsid: string; search: { afterIso: string; titleNormalized: string } }>;
  sends: Array<{ account: AccountRef; igsid: string; payload: unknown }>;
  tap: TapResult | (() => TapResult);
  send: SendResult | (() => SendResult | Promise<SendResult>);
  findUserTap(account: AccountRef, igsid: string, search: { afterIso: string; titleNormalized: string }): Promise<TapResult>;
  sendMessage(account: AccountRef, igsid: string, payload: unknown): Promise<SendResult>;
};

function fakeGate(): FakeGate {
  const fake: FakeGate = {
    taps: [], sends: [], tap: { found: false }, send: { outcome: 'accepted', messageId: 'mid.resource' },
    async findUserTap(account, igsid, search) { fake.taps.push({ account, igsid, search }); return typeof fake.tap === 'function' ? fake.tap() : fake.tap; },
    async sendMessage(account, igsid, payload) { fake.sends.push({ account, igsid, payload }); return typeof fake.send === 'function' ? fake.send() : fake.send; },
  };
  return fake;
}

function engine(db: Db, provider: FakeGate, clock: () => number, extra: Record<string, unknown> = {}) {
  const sleeps: number[] = [];
  const service = new FollowGateService(db, provider as never, { ...DORMANT, clock, sleep: async (ms: number) => { sleeps.push(ms); }, ...extra });
  return { service, sleeps };
}

function setDryRun(db: Db, value: boolean) {
  db.prepare(`UPDATE app_state SET state_value=? WHERE state_key='dry_run'`).run(value ? 'true' : 'false');
}

const events = (db: Db, sessionId: string) => all(db, `SELECT event_type, message_id, safe_error_code, details_json FROM gate_events WHERE gate_session_id=? ORDER BY rowid`, sessionId);

// ---------------------------------------------------------------------------------------------------------------
// Migration v12 -> v13
// ---------------------------------------------------------------------------------------------------------------

test('migration v12 -> v13 adds follow gate columns and tables, preserving queue, classifications and public reply data', async () => {
  await withDb((db) => {
    assert.equal(one(db, 'PRAGMA user_version').user_version, 12);
    const ctx = seed(db);
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'hola', username: 'u', createdAt: '2026-01-01T00:00:00.000Z' });
    db.exec(`INSERT INTO automations (automation_id, account_id, media_id, scope, name, status, created_at, updated_at, real_enabled, version,
        buttons_json, public_reply_enabled, public_reply_variants_json, interactive_mode, interactive_titles_json)
      VALUES ('a1','acc','m','media','Old','enabled','2026','2026',1,7,'[]',1,'["Listo @{{username}}"]','postback','["Ok"]');
      INSERT INTO queue_items(queue_item_id,account_id,comment_id,automation_id,state,dry_run,payload_json,created_at,updated_at,public_reply_state,public_reply_text)
        VALUES ('q1','acc','c1','a1','SENT',0,'{"text":"x"}','2026','2026','PENDING','Listo @u');
      INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, observed_at) VALUES ('acc','c1','a1','eligible','eligible','2026');`);
    migrateDatabase(db);
    assert.equal(one(db, 'PRAGMA user_version').user_version, 17);
    assert.equal(one(db, 'PRAGMA foreign_keys').foreign_keys, 1);
    const automation = one(db, `SELECT * FROM automations WHERE automation_id='a1'`);
    assert.deepEqual([automation.follow_gate_enabled, automation.follow_gate_message, automation.follow_gate_button_title], [0, '', 'Ya te sigo']);
    assert.deepEqual([automation.version, automation.interactive_mode, automation.public_reply_enabled], [7, 'postback', 1]);
    assert.deepEqual(one(db, `SELECT state, public_reply_state, public_reply_text FROM queue_items WHERE queue_item_id='q1'`),
      { state: 'SENT', public_reply_state: 'PENDING', public_reply_text: 'Listo @u' });
    assert.equal(one(db, `SELECT result FROM comment_classifications`).result, 'eligible');
    assert.throws(() => db.exec(`UPDATE automations SET follow_gate_enabled=2 WHERE automation_id='a1'`), /CHECK/);
    // New tables: state CHECK, FK to queue item, append-only events, one accepted resource per session.
    const insert = (id: string, queueId: string, state = 'AWAITING_TAP') => db.prepare(`INSERT INTO gate_sessions(gate_session_id, account_id, automation_id,
      queue_item_id, comment_id, igsid, state, gate_sent_at, next_poll_at, button_title, resource_payload_json, created_at, updated_at)
      VALUES (?, 'acc', 'a1', ?, 'c1', 'i1', ?, '2026', '2026', 'Ya te sigo', '{}', '2026', '2026')`).run(id, queueId, state);
    assert.throws(() => insert('s0', 'q1', 'BOGUS'), /CHECK/);
    assert.throws(() => insert('s0', 'missing'), /FOREIGN KEY/);
    insert('s1', 'q1');
    assert.throws(() => insert('s2', 'q1'), /UNIQUE/);
    const event = (id: string, type: string) => db.prepare(`INSERT INTO gate_events(gate_event_id, account_id, gate_session_id, event_type, event_at)
      VALUES (?, 'acc', 's1', ?, '2026')`).run(id, type);
    event('e1', 'resource_accepted');
    assert.throws(() => event('e2', 'resource_accepted'), /UNIQUE/);
    assert.throws(() => event('e3', 'bogus'), /CHECK/);
    assert.throws(() => db.exec(`UPDATE gate_events SET event_type='expired'`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM gate_events`), /append-only/);
    migrateDatabase(db);
    assert.equal(one(db, 'PRAGMA user_version').user_version, 17);
  }, 12);
});

// ---------------------------------------------------------------------------------------------------------------
// Validation and configuration
// ---------------------------------------------------------------------------------------------------------------

test('validateFollowGateConfig enforces every limit, never coerces and rejects combination with interactive modes', () => {
  const ok = validateFollowGateConfig({ enabled: true, message: `  ${GATE_MESSAGE}  `, buttonTitle: ' Ya te sigo ' }, 'none');
  assert.deepEqual(ok, { enabled: true, message: GATE_MESSAGE, buttonTitle: 'Ya te sigo' });
  assert.deepEqual(validateFollowGateConfig({}, 'none'), { enabled: false, message: '', buttonTitle: 'Ya te sigo' });
  assert.deepEqual(validateFollowGateConfig({ enabled: true, message: 'x'.repeat(640), buttonTitle: 'y'.repeat(20) }, 'none').enabled, true);
  const codes: Array<[Record<string, unknown>, string, string]> = [
    [{ enabled: 'true', message: 'Hola', buttonTitle: 'Ok' }, 'none', 'follow_gate_invalid'],
    [{ enabled: 1, message: 'Hola', buttonTitle: 'Ok' }, 'none', 'follow_gate_invalid'],
    [{ enabled: true, buttonTitle: 'Ok' }, 'none', 'follow_gate_message_invalid'],
    [{ enabled: true, message: '   ', buttonTitle: 'Ok' }, 'none', 'follow_gate_message_invalid'],
    [{ enabled: true, message: 'x'.repeat(641), buttonTitle: 'Ok' }, 'none', 'follow_gate_message_invalid'],
    [{ enabled: true, message: 42, buttonTitle: 'Ok' }, 'none', 'follow_gate_message_invalid'],
    [{ enabled: true, message: 'Hola {{secreto}}', buttonTitle: 'Ok' }, 'none', 'follow_gate_message_invalid'],
    [{ enabled: true, message: 'Hola {{username', buttonTitle: 'Ok' }, 'none', 'follow_gate_message_invalid'],
    [{ enabled: true, message: 'Hola' }, 'none', 'follow_gate_button_title_invalid'],
    [{ enabled: true, message: 'Hola', buttonTitle: '' }, 'none', 'follow_gate_button_title_invalid'],
    [{ enabled: true, message: 'Hola', buttonTitle: 'x'.repeat(21) }, 'none', 'follow_gate_button_title_invalid'],
    [{ enabled: true, message: 'Hola', buttonTitle: 'ver https://x.co' }, 'none', 'follow_gate_button_title_invalid'],
    [{ enabled: true, message: 'Hola', buttonTitle: 'www.evil.com' }, 'none', 'follow_gate_button_title_invalid'],
    [{ enabled: true, message: 'Hola', buttonTitle: 'Ya\nte sigo' }, 'none', 'follow_gate_button_title_invalid'],
    [{ enabled: true, message: 'Hola', buttonTitle: ['Ok'] }, 'none', 'follow_gate_button_title_invalid'],
    [{ enabled: true, message: 'Hola', buttonTitle: 'Ok' }, 'postback', 'follow_gate_interactive_conflict'],
    [{ enabled: true, message: 'Hola', buttonTitle: 'Ok' }, 'quick_reply', 'follow_gate_interactive_conflict'],
    [{ enabled: false, message: 7 }, 'none', 'follow_gate_message_invalid'],
    [{ enabled: false, buttonTitle: 'x'.repeat(21) }, 'none', 'follow_gate_button_title_invalid'],
  ];
  for (const [input, mode, code] of codes) {
    assert.throws(() => validateFollowGateConfig(input, mode), (error: unknown) => error instanceof TypeError && (error as { code?: string }).code === code,
      `${JSON.stringify(input)} ${mode}`);
  }
});

test('automation service stores the follow gate (off by default), keeps it when omitted and rejects interactive combinations', async () => {
  await withDb((db) => {
    const ctx = seed(db);
    const service = new AutomationService(db, DORMANT);
    const plain = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Plain', replyText: 'Hola' });
    assert.deepEqual(one(db, `SELECT follow_gate_enabled, follow_gate_message, follow_gate_button_title FROM automations WHERE automation_id=?`, plain),
      { follow_gate_enabled: 0, follow_gate_message: '', follow_gate_button_title: 'Ya te sigo' });
    const gate = gateAutomation(db, ctx);
    assert.deepEqual(one(db, `SELECT follow_gate_enabled, follow_gate_message, follow_gate_button_title FROM automations WHERE automation_id=?`, gate),
      { follow_gate_enabled: 1, follow_gate_message: GATE_MESSAGE, follow_gate_button_title: 'Ya te sigo' });
    const base = { name: 'Gate', mediaId: ctx.mediaId, replyText: 'Hola', matchMode: 'contains' as const, buttons: [], keywords: ['guide'] };
    service.update(ctx.accountId, gate, base);
    assert.equal(one(db, `SELECT follow_gate_enabled FROM automations WHERE automation_id=?`, gate).follow_gate_enabled, 1);
    service.update(ctx.accountId, gate, { ...base, followGateEnabled: false } as never);
    assert.deepEqual(one(db, `SELECT follow_gate_enabled, follow_gate_message FROM automations WHERE automation_id=?`, gate),
      { follow_gate_enabled: 0, follow_gate_message: GATE_MESSAGE });
    // Phase 0 retirement: any interactive mode is now rejected as retired (before the old gate conflict check).
    assert.throws(() => service.update(ctx.accountId, gate, { ...base, followGateEnabled: true, interactiveMode: 'postback', interactiveTitles: ['Ok'] } as never),
      (error: unknown) => (error as { code?: string }).code === 'interactive_mode_retired');
    // Re-enabling with the stored message works without resending it.
    service.update(ctx.accountId, gate, { ...base, followGateEnabled: true } as never);
    assert.equal(one(db, `SELECT follow_gate_enabled FROM automations WHERE automation_id=?`, gate).follow_gate_enabled, 1);
    // Turning interactive mode on while the stored gate is enabled is rejected too (retired).
    assert.throws(() => service.update(ctx.accountId, gate, { ...base, interactiveMode: 'quick_reply', interactiveTitles: ['Ok'] } as never),
      (error: unknown) => (error as { code?: string }).code === 'interactive_mode_retired');
    assert.throws(() => service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Bad', replyText: 'Hola', followGateEnabled: true,
      followGateMessage: 'Hola', followGateButtonTitle: 'Ok', interactiveMode: 'postback', interactiveTitles: ['Listo'] } as never), TypeError);
  });
});

test('renderFollowGatePayload renders variables and builds ONE postback button with the resource snapshot', () => {
  const payload = renderFollowGatePayload({ message: 'Hola {{username}} ({{keyword}}) en {{account}} · {{media}} · {{comment}}', buttonTitle: 'Ya te sigo' },
    { username: 'ana', keyword: 'guía', account: 'marca', media: 'https://x.co/p/1', comment: 'quiero guía' },
    { replyText: 'Aquí tienes {{keyword}}', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] }, 'a1');
  assert.deepEqual(payload, {
    text: 'Hola ana (guía) en marca · https://x.co/p/1 · quiero guía', buttons: [],
    postbackButtons: [{ title: 'Ya te sigo', payload: 'gate:a1:0' }],
    followGate: { buttonTitle: 'Ya te sigo', resource: { text: 'Aquí tienes guía', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] } },
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Router
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

test('automations API validates follow gate fields strictly (400 with a specific code) and lists them', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', ...DORMANT, automations: new AutomationService(db, DORMANT) } as never);
    const { server, origin } = await listen(handler);
    const headers = { origin, 'content-type': 'application/json', 'x-csrf-token': 'csrf' };
    const base = { accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Gate', keywords: ['guia'], replyText: 'Hola' };
    try {
      for (const [extra, code] of [
        [{ followGateEnabled: 'yes', followGateMessage: 'Hola', followGateButtonTitle: 'Ok' }, 'follow_gate_invalid'],
        [{ followGateEnabled: true, followGateButtonTitle: 'Ok' }, 'follow_gate_message_invalid'],
        [{ followGateEnabled: true, followGateMessage: 'x'.repeat(641), followGateButtonTitle: 'Ok' }, 'follow_gate_message_invalid'],
        [{ followGateEnabled: true, followGateMessage: 'Hola', followGateButtonTitle: 'x'.repeat(21) }, 'follow_gate_button_title_invalid'],
        [{ followGateEnabled: true, followGateMessage: 'Hola', followGateButtonTitle: 'https://x.co' }, 'follow_gate_button_title_invalid'],
        [{ followGateEnabled: true, followGateMessage: 'Hola', followGateButtonTitle: 'Ok', interactiveMode: 'postback', interactiveTitles: ['Listo'] }, 'interactive_mode_retired'],
      ] as Array<[Record<string, unknown>, string]>) {
        const result = await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, ...extra } });
        assert.deepEqual([result.status, result.json.error], [400, code], JSON.stringify(extra));
      }
      assert.equal(one(db, `SELECT COUNT(*) AS n FROM automations`).n, 0);
      const created = await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, followGateEnabled: true,
        followGateMessage: GATE_MESSAGE, followGateButtonTitle: 'Ya te sigo', buttons: [] } });
      assert.equal(created.status, 201);
      assert.equal((await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, name: 'Plain' } })).status, 201);
      const listed = (await call(origin, `/api/automations?accountId=${ctx.accountId}`)).json.automations as Array<Record<string, unknown>>;
      const gate = listed.find((row) => row.name === 'Gate')!;
      const plain = listed.find((row) => row.name === 'Plain')!;
      assert.deepEqual([gate.followGateEnabled, gate.followGateMessage, gate.followGateButtonTitle], [true, GATE_MESSAGE, 'Ya te sigo']);
      assert.deepEqual([plain.followGateEnabled, plain.followGateMessage, plain.followGateButtonTitle], [false, '', 'Ya te sigo']);
      const put = await call(origin, `/api/automations/${created.json.automationId}`, { method: 'PUT', headers,
        body: { ...base, matchMode: 'contains', interactiveMode: 'quick_reply', interactiveTitles: ['Sí'] } });
      assert.deepEqual([put.status, put.json.error], [400, 'interactive_mode_retired']);
      const off = await call(origin, `/api/automations/${created.json.automationId}`, { method: 'PUT', headers,
        body: { ...base, matchMode: 'contains', followGateEnabled: false } });
      assert.equal(off.status, 200);
      assert.equal(one(db, `SELECT follow_gate_enabled FROM automations WHERE automation_id=?`, created.json.automationId).follow_gate_enabled, 0);
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Enqueue, Dry Run and session creation
// ---------------------------------------------------------------------------------------------------------------

test('Dry Run: simulated item stores both previews, creates NO session and never calls a provider', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer',
      createdAt: new Date(Date.now() - 60_000).toISOString() });
    const provider = sendingProvider({ outcome: 'accepted', messageId: 'mid.1' });
    const queue = new QueueService(db, provider as never, { sendSpacingMs: 0, ...DORMANT });
    await queue.enqueueReviewed(ctx.accountId, automationId, ['c1']);
    assert.equal(one(db, `SELECT state FROM queue_items`).state, 'SIMULATED');
    assert.equal(await queue.processOne(ctx.accountId), null);
    assert.equal(provider.sent.length, 0);
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_sessions`).n, 0);
    const gate = fakeGate();
    const { service } = engine(db, gate, () => Date.now());
    assert.equal(await service.processDue(), 0);
    assert.equal(gate.taps.length + gate.sends.length, 0);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', queue } as never);
    const { server, origin } = await listen(handler);
    try {
      const item = (await call(origin, `/api/queue?accountId=${ctx.accountId}`)).json.items[0];
      assert.deepEqual(item.payload, {
        text: '¡Hola customer! Sígueme y toca el botón 👇', buttons: [], postbackButtons: [{ title: 'Ya te sigo' }],
        followGate: { buttonTitle: 'Ya te sigo', resource: { text: 'Aquí tienes guide, customer', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] } },
      });
      assert.equal(item.followGate, null);
    } finally { server.close(); }
  });
});

test('real send: first message is the gate (one postback, no URL buttons) and the session is created with the send response IGSID', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const before = Date.now();
    const { automationId, provider, session } = await sendGate(db, ctx, { recipientId: '5544332211', authorIgsid: '1111111111' });
    const sent = provider.sent[0] as Record<string, unknown>;
    assert.deepEqual([sent.text, sent.buttons, sent.postbackButtons], ['¡Hola customer! Sígueme y toca el botón 👇', [], [{ title: 'Ya te sigo', payload: `gate:${automationId}:0` }]]);
    assert.equal(one(db, `SELECT state FROM queue_items`).state, 'SENT');
    assert.ok(session);
    assert.equal(session.state, 'AWAITING_TAP');
    assert.equal(session.igsid, '5544332211');
    assert.equal(session.automation_id, automationId);
    assert.equal(session.button_title, 'Ya te sigo');
    assert.deepEqual(JSON.parse(session.resource_payload_json), { text: 'Aquí tienes guide, customer', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] });
    const sentAt = Date.parse(session.gate_sent_at);
    assert.ok(sentAt >= before - 1000 && sentAt <= Date.now() + 1000);
    assert.equal(Date.parse(session.next_poll_at) - sentAt, GATE_FIRST_POLL_MS);
    assert.equal(session.tap_message_id, null);
    assert.deepEqual(events(db, session.gate_session_id).map((event) => event.event_type), ['session_created']);
  });
});

test('session falls back to comments.author_igsid; without any IGSID it is FAILED igsid_unknown and the private item stays SENT', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const { session } = await sendGate(db, ctx, { authorIgsid: '1111111111' });
    assert.deepEqual([session!.state, session!.igsid], ['AWAITING_TAP', '1111111111']);
  });
  await withDb(async (db) => {
    const ctx = seed(db);
    const { session, queue, provider } = await sendGate(db, ctx);
    assert.deepEqual([session!.state, session!.igsid, session!.last_error_code, session!.next_poll_at], ['FAILED', null, 'igsid_unknown', null]);
    assert.equal(one(db, `SELECT state FROM queue_items`).state, 'SENT');
    assert.equal(events(db, session!.gate_session_id)[0]!.safe_error_code, 'igsid_unknown');
    await queue.processOne(ctx.accountId);
    assert.equal(provider.sent.length, 1, 'never resent');
  });
});

test('session creation is atomic with SENT: if the session insert fails, the private item is not marked SENT', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    db.exec(`CREATE TRIGGER block_gate BEFORE INSERT ON gate_sessions BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
    await assert.rejects(() => sendGate(db, ctx, { recipientId: '5544332211' }), /blocked/);
    assert.equal(one(db, `SELECT state FROM queue_items`).state, 'SENDING');
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM send_attempts WHERE event_type='accepted'`).n, 0);
  });
});

test("an automation without the gate creates no session and keeps the historic payload keys", async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const service = new AutomationService(db, DORMANT);
    const id = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Plain', replyText: 'Hola {{username}}' });
    service.addKeyword(ctx.accountId, id, 'guide'); service.setEnabled(ctx.accountId, id, true); service.setRealEnabled(ctx.accountId, id, true, true);
    const { provider, session } = await sendGate(db, ctx, { automationId: id, recipientId: '5544332211' });
    assert.equal(session, undefined);
    assert.deepEqual(Object.keys(provider.sent[0] as object), ['text', 'buttons', 'automation_version']);
  });
});

test('editing the gate after enqueue never alters in-flight sessions (snapshot on the session)', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const { automationId, session } = await sendGate(db, ctx, { recipientId: '5544332211' });
    new AutomationService(db, DORMANT).update(ctx.accountId, automationId, { name: 'Gate', mediaId: ctx.mediaId, replyText: 'OTRO', matchMode: 'contains',
      buttons: [], keywords: ['guide'], followGateEnabled: true, followGateMessage: 'Nuevo', followGateButtonTitle: 'Otro' } as never);
    let now = Date.now() + MINUTE;
    const gate = fakeGate();
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(now - 1000).toISOString() };
    await engine(db, gate, () => now).service.processDue();
    assert.equal(gate.taps[0]!.search.titleNormalized, 'ya te sigo');
    assert.deepEqual(gate.sends[0]!.payload, { text: 'Aquí tienes guide, customer', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] });
    assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, session!.gate_session_id).state, 'COMPLETED');
    now += 0;
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Provider: Send by IGSID and tap detection
// ---------------------------------------------------------------------------------------------------------------

const ACCOUNT_IG_ID = '17841400000000000';
const IGSID = '5544332211';
const COMMENT = '18000000000000001';

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
  const directory = mkdtempSync(join(tmpdir(), 'follow-gate-v13-provider-'));
  const state = providerState(directory);
  const calls: Call[] = [];
  try {
    const provider = new MetaProvider(state.db, state.vault, async (input, init = {}) => {
      const entry = { url: new URL(String(input)), init };
      calls.push(entry);
      return respond(entry);
    }, { diagnosticSpacingMs: 0 });
    await run(provider, calls, state);
  } finally { state.db.close(); removeTempDir(directory); }
}

test('gate first message: exact JSON of the private reply (button template with ONE postback button, no URL buttons)', async () => {
  const payload = renderFollowGatePayload({ message: 'Hola {{username}}', buttonTitle: 'Ya te sigo' }, { username: 'customer', comment: 'x', keyword: 'guide' },
    { replyText: 'Recurso', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] }, 'a1');
  await withProvider(() => Response.json({ message_id: 'mid.1', recipient_id: IGSID }), async (provider, calls, state) => {
    const result = await provider.sendPrivateReply(state.account, COMMENT, payload);
    assert.deepEqual([result.outcome, result.recipientId], ['accepted', IGSID]);
    assert.equal(String(calls[0]!.init.body), `{"recipient":{"comment_id":"${COMMENT}"},"message":{"attachment":{"type":"template","payload":{"template_type":"button","text":"Hola customer","buttons":[{"type":"postback","title":"Ya te sigo","payload":"gate:a1:0"}]}}}}`);
  });
});

test('sendMessage posts to /<ig-id>/messages with recipient.id: exact JSON for text and for web_url buttons', async () => {
  await withProvider(() => Response.json({ message_id: 'mid.r', recipient_id: IGSID }), async (provider, calls, state) => {
    const text = await provider.sendMessage(state.account, IGSID, { text: 'Recurso', buttons: [] });
    assert.deepEqual([text.outcome, text.messageId, text.recipientId], ['accepted', 'mid.r', IGSID]);
    await provider.sendMessage(state.account, IGSID, { text: 'Recurso', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] });
    assert.equal(calls[0]!.url.toString(), `https://graph.instagram.com/v26.0/${ACCOUNT_IG_ID}/messages`);
    assert.equal(calls[0]!.init.method, 'POST');
    assert.equal(calls[0]!.init.redirect, 'error');
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer ig-user-token');
    assert.equal(String(calls[0]!.init.body), `{"recipient":{"id":"${IGSID}"},"message":{"text":"Recurso"}}`);
    assert.equal(String(calls[1]!.init.body), `{"recipient":{"id":"${IGSID}"},"message":{"attachment":{"type":"template","payload":{"template_type":"button","text":"Recurso","buttons":[{"type":"web_url","title":"Guía","url":"https://example.com/guia"}]}}}}`);
    assert.equal(String(calls[1]!.init.body).includes('ig-user-token'), false);
  });
});

test('sendMessage rejects unsafe ids and invalid payloads before any request and classifies errors like private sends', async () => {
  let response: () => Response = () => Response.json({ message_id: 'mid.r' });
  await withProvider(() => response(), async (provider, calls, state) => {
    for (const bad of ['', '../x', 'a b', 'x'.repeat(65)]) {
      assert.deepEqual(await provider.sendMessage(state.account, bad, { text: 'x', buttons: [] }), { outcome: 'definitive_rejection', safeErrorCode: 'invalid_igsid' });
    }
    for (const payload of [{ text: '', buttons: [] }, { text: 'x', buttons: [{ title: 'a', url: 'http://insecure.example' }] },
      { text: 'x', buttons: [], postbackButtons: [{ title: 'a', payload: 'gate:a1:0' }] }, { text: 'x', buttons: [], quickReplies: [{ title: 'a', payload: 'gate:a1:0' }] }]) {
      assert.equal((await provider.sendMessage(state.account, IGSID, payload as never)).safeErrorCode, 'invalid_message_payload', JSON.stringify(payload));
    }
    assert.equal(calls.length, 0);
    response = () => Response.json({ error: { code: 10, message: 'token=abc' } }, { status: 400 });
    const rejected = await provider.sendMessage(state.account, IGSID, { text: 'x', buttons: [] });
    assert.deepEqual([rejected.outcome, rejected.safeErrorCode, rejected.metaCode], ['definitive_rejection', 'meta_10', 10]);
    assert.equal(JSON.stringify(rejected).includes('token'), false);
    response = () => Response.json({ error: { code: 4 } }, { status: 429, headers: { 'retry-after': '120' } });
    const throttled = await provider.sendMessage(state.account, IGSID, { text: 'x', buttons: [] });
    assert.deepEqual([throttled.outcome, throttled.httpStatus, throttled.usageHeaders?.retryAfter], ['definitive_rejection', 429, '120']);
    response = () => Response.json({ error: { code: 2 } }, { status: 500 });
    assert.equal((await provider.sendMessage(state.account, IGSID, { text: 'x', buttons: [] })).outcome, 'ambiguous');
    response = () => Response.json({ ok: true });
    assert.deepEqual((await provider.sendMessage(state.account, IGSID, { text: 'x', buttons: [] })).safeErrorCode, 'meta_missing_message_id');
  });
});

type Message = { id: string; created: string; fromAccount?: boolean; text?: string; fail?: boolean };
function tapResponder(messages: Message[], options: { conversations?: unknown } = {}) {
  return ({ url, init }: Call): Response => {
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(init.body, undefined);
    if (url.pathname.endsWith('/conversations')) return Response.json(options.conversations ?? { data: [{ id: 'conv_1' }] });
    if (url.pathname.endsWith('/conv_1')) return Response.json({ id: 'conv_1', messages: { data: messages.map((message) => ({ id: message.id, created_time: message.created })) } });
    const id = decodeURIComponent(url.pathname.split('/').pop()!);
    const message = messages.find((entry) => entry.id === id)!;
    if (message.fail) return Response.json({ error: { code: 2 } }, { status: 500 });
    return Response.json({ id, created_time: message.created,
      from: message.fromAccount ? { id: ACCOUNT_IG_ID, username: 'brand' } : { id: IGSID, username: 'customer' },
      to: { data: [{ id: message.fromAccount ? IGSID : ACCOUNT_IG_ID }] }, ...(message.text !== undefined ? { message: message.text } : {}) });
  };
}

const GATE_SENT = '2026-10-08T10:00:00.000Z';
const at = (seconds: number) => new Date(Date.parse(GATE_SENT) + seconds * 1000).toISOString().replace('.000Z', '+0000');

test('findUserTap matches the first user message equal to the title (normalized), ignoring account messages and older messages', async () => {
  const messages: Message[] = [
    { id: 'm5', created: at(90), text: 'gracias' },
    { id: 'm4', created: at(60), text: 'Ya te sigo' },
    { id: 'm3', created: at(40), text: '  YA   te sigo!! 🙌 ' },
    { id: 'm2', created: at(30), fromAccount: true, text: 'Ya te sigo' },
    { id: 'm1', created: at(-10), text: 'Ya te sigo' },
    { id: 'm0', created: at(-20), text: 'Ya te sigo' },
  ];
  await withProvider(tapResponder(messages), async (provider, calls, state) => {
    const result = await provider.findUserTap(state.account, IGSID, { afterIso: GATE_SENT, titleNormalized: normalizeTapText('Ya te sigo') });
    assert.deepEqual(result, { found: true, tapMessageId: 'm3', tapAt: new Date(Date.parse(GATE_SENT) + 40_000).toISOString() });
    assert.equal(calls[0]!.url.pathname, `/v26.0/${ACCOUNT_IG_ID}/conversations`);
    assert.equal(calls[0]!.url.searchParams.get('user_id'), IGSID);
    assert.equal(calls[0]!.url.searchParams.get('platform'), 'instagram');
    // conversations + listing + details m5, m4, m3, m2, m1 (m1 is older than the gate: stop there).
    assert.deepEqual(calls.slice(2).map((entry) => entry.url.pathname.split('/').pop()), ['m5', 'm4', 'm3', 'm2', 'm1']);
  });
});

test('findUserTap: no match, not found, 5-detail cap, unsafe ids, missing timestamps and errors', async () => {
  await withProvider(tapResponder([{ id: 'm1', created: at(10), text: 'Ya te sigo pero no' }, { id: 'm0', created: at(5), text: 'otra cosa' }]), async (provider, _calls, state) => {
    assert.deepEqual(await provider.findUserTap(state.account, IGSID, { afterIso: GATE_SENT, titleNormalized: 'ya te sigo' }), { found: false });
  });
  await withProvider(tapResponder([], { conversations: { data: [] } }), async (provider, calls, state) => {
    assert.deepEqual(await provider.findUserTap(state.account, IGSID, { afterIso: GATE_SENT, titleNormalized: 'ya te sigo' }), { found: false });
    assert.equal(calls.length, 1);
  });
  const many: Message[] = Array.from({ length: 8 }, (_v, index) => ({ id: `m${8 - index}`, created: at(100 - index), text: index === 6 ? 'Ya te sigo' : 'hola' }));
  await withProvider(tapResponder(many), async (provider, calls, state) => {
    assert.deepEqual(await provider.findUserTap(state.account, IGSID, { afterIso: GATE_SENT, titleNormalized: 'ya te sigo' }), { found: false });
    assert.equal(calls.length, 2 + 5);
  });
  await withProvider(tapResponder([{ id: '../evil', created: at(10), text: 'Ya te sigo' }, { id: 'ok_1', created: at(9) }, { id: 'nots', created: 'garbage', text: 'Ya te sigo' }]), async (provider, calls, state) => {
    assert.deepEqual(await provider.findUserTap(state.account, IGSID, { afterIso: GATE_SENT, titleNormalized: 'ya te sigo' }), { found: false });
    assert.equal(calls.some((entry) => entry.url.pathname.includes('evil')), false);
  });
  await withProvider(tapResponder([{ id: 'm1', created: at(10), fail: true }]), async (provider, _calls, state) => {
    assert.deepEqual(await provider.findUserTap(state.account, IGSID, { afterIso: GATE_SENT, titleNormalized: 'ya te sigo' }), { found: false, pollError: 'meta_2' });
  });
  await withProvider(() => Response.json({ error: { code: 4 } }, { status: 429 }), async (provider, _calls, state) => {
    assert.deepEqual(await provider.findUserTap(state.account, IGSID, { afterIso: GATE_SENT, titleNormalized: 'ya te sigo' }), { found: false, pollError: 'meta_4' });
  });
  await withProvider(tapResponder([]), async (provider, calls, state) => {
    assert.deepEqual(await provider.findUserTap(state.account, '../x', { afterIso: GATE_SENT, titleNormalized: 'ya te sigo' }), { found: false, pollError: 'invalid_igsid' });
    assert.deepEqual(await provider.findUserTap(state.account, IGSID, { afterIso: 'nope', titleNormalized: 'ya te sigo' }), { found: false, pollError: 'invalid_tap_search' });
    assert.equal(calls.length, 0);
  });
});

test('normalizeTapText and the polling schedule', () => {
  assert.equal(normalizeTapText('  ¡YA   te sigo!! 🙌 '), 'ya te sigo');
  assert.equal(normalizeTapText('Ya te sigo'), normalizeTapText('ya te sigo.'));
  assert.notEqual(normalizeTapText('Ya te sigo'), normalizeTapText('Ya te sigo pero no'));
  assert.equal(normalizeTapText('Café'), normalizeTapText('Café'));
  const sent = 0;
  assert.equal(nextGatePollDelay(sent, 20_000), 30_000);
  assert.equal(nextGatePollDelay(sent, 9 * MINUTE), 30_000);
  assert.equal(nextGatePollDelay(sent, 10 * MINUTE), 2 * MINUTE);
  assert.equal(nextGatePollDelay(sent, 119 * MINUTE), 2 * MINUTE);
  assert.equal(nextGatePollDelay(sent, 2 * HOUR), 10 * MINUTE);
  assert.equal(nextGatePollDelay(sent, 5 * DAY), 10 * MINUTE);
});

// ---------------------------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------------------------

test('tap detected -> durable intent BEFORE the POST (seen from a second connection) -> COMPLETED; second tick never sends again', async () => {
  await withDb(async (db, directory) => {
    const ctx = seed(db);
    const { session } = await sendGate(db, ctx, { recipientId: '5544332211' });
    const id = session!.gate_session_id as string;
    let now = Date.parse(session!.gate_sent_at) + 25_000;
    const gate = fakeGate();
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(now - 5000).toISOString() };
    const observer = openDatabase(directory);
    let observed: Record<string, unknown> = {};
    gate.send = () => {
      observed = { state: one(observer, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, id).state,
        events: all(observer, `SELECT event_type FROM gate_events WHERE gate_session_id=? ORDER BY rowid`, id).map((row) => row.event_type) };
      return { outcome: 'accepted', messageId: 'mid.resource', recipientId: '5544332211' };
    };
    try {
      const { service, sleeps } = engine(db, gate, () => now);
      assert.equal(await service.processDue(), 1);
      assert.deepEqual(observed, { state: 'RESOURCE_SENDING', events: ['session_created', 'tap_detected', 'resource_intent_recorded'] });
      assert.deepEqual(sleeps, [500]);
      assert.equal(gate.sends[0]!.igsid, '5544332211');
      assert.equal(gate.taps[0]!.search.afterIso, session!.gate_sent_at);
      const row = one(db, `SELECT * FROM gate_sessions WHERE gate_session_id=?`, id);
      assert.deepEqual([row.state, row.tap_message_id, row.resource_message_id, row.send_attempts], ['COMPLETED', 'tap.1', 'mid.resource', 1]);
      assert.equal(row.tap_at, new Date(now - 5000).toISOString());
      assert.equal(Date.parse(row.window_expires_at) - Date.parse(row.tap_at), DAY);
      assert.deepEqual(events(db, id).map((event) => [event.event_type, event.message_id]),
        [['session_created', null], ['tap_detected', 'tap.1'], ['resource_intent_recorded', null], ['resource_accepted', 'mid.resource']]);
      now += HOUR;
      await service.processDue();
      await service.processDue();
      assert.equal(gate.sends.length, 1);
      assert.equal(gate.taps.length, 1, 'later or duplicate taps are never looked up again');
    } finally { observer.close(); }
  });
});

test('no tap: nothing is sent, poll count grows and the schedule follows the backoff; not due sessions are not polled', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const { session } = await sendGate(db, ctx, { recipientId: '5544332211' });
    const id = session!.gate_session_id as string;
    const sent = Date.parse(session!.gate_sent_at);
    let now = sent + 10_000;
    const gate = fakeGate();
    const { service } = engine(db, gate, () => now);
    await service.processDue();
    assert.equal(gate.taps.length, 0, 'first poll only after 20 s');
    now = sent + 21_000;
    await service.processDue();
    let row = one(db, `SELECT * FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.deepEqual([row.state, row.poll_count, Date.parse(row.next_poll_at) - now], ['AWAITING_TAP', 1, 30_000]);
    now = sent + 3 * HOUR;
    await service.processDue();
    row = one(db, `SELECT * FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.deepEqual([row.poll_count, Date.parse(row.next_poll_at) - now], [2, 10 * MINUTE]);
    assert.equal(gate.sends.length, 0);
    assert.deepEqual(events(db, id).map((event) => event.event_type), ['session_created']);
  });
});

test('poll errors never change state, are recorded and back off', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const id = insertSessionSafe(db, ctx, automationId, 1);
    const now = Date.now();
    const gate = fakeGate();
    gate.tap = { found: false, pollError: 'meta_4' };
    await engine(db, gate, () => now).service.processDue();
    const row = one(db, `SELECT * FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.deepEqual([row.state, row.tap_message_id, row.last_error_code], ['AWAITING_TAP', null, 'meta_4']);
    assert.ok(Date.parse(row.next_poll_at) - now >= 2 * MINUTE);
    assert.deepEqual(events(db, id).map((event) => [event.event_type, event.safe_error_code]), [['poll_error', 'meta_4']]);
    gate.tap = () => { throw new Error('boom'); };
    const later = Date.parse(row.next_poll_at) + 1;
    await engine(db, gate, () => later).service.processDue();
    assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, id).state, 'AWAITING_TAP');
    assert.equal(gate.sends.length, 0);
  });
});

test('ambiguous resource send -> UNKNOWN_OUTCOME and never retried; accepted without id is ambiguous too', async () => {
  for (const result of [{ outcome: 'ambiguous', safeErrorCode: 'meta_timeout' }, { outcome: 'accepted' }, 'throw'] as const) {
    await withDb(async (db) => {
      const ctx = seed(db);
      const automationId = gateAutomation(db, ctx);
      const id = insertSessionSafe(db, ctx, automationId, 1);
      let now = Date.now();
      const gate = fakeGate();
      gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(now - 1000).toISOString() };
      gate.send = () => { if (result === 'throw') throw new Error('network'); return result as SendResult; };
      const { service } = engine(db, gate, () => now);
      await service.processDue();
      assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, id).state, 'UNKNOWN_OUTCOME', String(result));
      assert.deepEqual(events(db, id).map((event) => event.event_type), ['tap_detected', 'resource_intent_recorded', 'resource_ambiguous']);
      now += DAY / 2;
      await service.processDue();
      assert.equal(gate.sends.length, 1);
    });
  }
});

test('rate-limited resource send is retried (send only, not tap detection) at most 3 times respecting Retry-After', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const id = insertSessionSafe(db, ctx, automationId, 1);
    let now = Date.now();
    const gate = fakeGate();
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(now - 1000).toISOString() };
    gate.send = { outcome: 'definitive_rejection', safeErrorCode: 'meta_4', httpStatus: 400, metaCode: 4, usageHeaders: { retryAfter: '120' } };
    const { service } = engine(db, gate, () => now);
    await service.processDue();
    let row = one(db, `SELECT * FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.deepEqual([row.state, row.send_attempts, Date.parse(row.next_poll_at) - now], ['AWAITING_TAP', 1, 120_000]);
    now += 60_000;
    await service.processDue();
    assert.equal(gate.sends.length, 1, 'Retry-After respected');
    now += 61_000;
    gate.send = { outcome: 'definitive_rejection', safeErrorCode: 'http_429', httpStatus: 429 };
    await service.processDue();
    row = one(db, `SELECT * FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.deepEqual([row.state, row.send_attempts], ['AWAITING_TAP', 2]);
    now = Date.parse(row.next_poll_at) + 1;
    await service.processDue();
    row = one(db, `SELECT * FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.deepEqual([row.state, row.send_attempts, row.last_error_code], ['FAILED', 3, 'http_429']);
    now += DAY / 4;
    await service.processDue();
    assert.equal(gate.sends.length, 3);
    assert.equal(gate.taps.length, 1);
  });
});

test('definitive rejection -> FAILED without retry', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const id = insertSessionSafe(db, ctx, automationId, 1);
    let now = Date.now();
    const gate = fakeGate();
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(now).toISOString() };
    gate.send = { outcome: 'definitive_rejection', safeErrorCode: 'meta_10', httpStatus: 400, metaCode: 10 };
    const { service } = engine(db, gate, () => now);
    await service.processDue();
    now += HOUR;
    await service.processDue();
    assert.deepEqual(Object.values(one(db, `SELECT state, last_error_code FROM gate_sessions WHERE gate_session_id=?`, id)), ['FAILED', 'meta_10']);
    assert.equal(gate.sends.length, 1);
    assert.deepEqual(events(db, id).map((event) => event.event_type), ['tap_detected', 'resource_intent_recorded', 'resource_rejected']);
  });
});

test('startup recovery turns RESOURCE_SENDING into UNKNOWN_OUTCOME; the scheduler calls it and the engine on every tick', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const id = insertSessionSafe(db, ctx, automationId, 1, { state: 'RESOURCE_SENDING', tap_message_id: 'tap.1', tap_at: new Date().toISOString(),
      window_expires_at: new Date(Date.now() + DAY).toISOString(), send_attempts: 1 });
    const gate = fakeGate();
    const service = new FollowGateService(db, gate as never, { ...DORMANT, sleep: async () => undefined });
    const queue = new QueueService(db, sendingProvider({ outcome: 'accepted', messageId: 'x' }) as never, DORMANT);
    const scanner = new Scanner(db, { async listComments() { return { items: [], complete: true }; } } as never);
    let ticks = 0;
    const wrapped = { recoverInterrupted: () => service.recoverInterrupted(), processDue: async () => { ticks++; return service.processDue(); } };
    const scheduler = new Scheduler(db, scanner, queue, { followGate: wrapped });
    assert.deepEqual(Object.values(one(db, `SELECT state, last_error_code FROM gate_sessions WHERE gate_session_id=?`, id)), ['UNKNOWN_OUTCOME', 'process_interrupted_after_intent']);
    assert.equal(events(db, id).at(-1)!.event_type, 'resource_ambiguous');
    await scheduler.tick();
    assert.equal(ticks, 0, 'monitoring off: nothing runs');
    scheduler.startAll();
    await scheduler.tick();
    assert.equal(ticks, 1);
    scheduler.stopAll();
    assert.equal(gate.sends.length, 0);
  });
});

test('expiry: 7 days without tap -> EXPIRED with no provider call; tap older than 24 h -> EXPIRED with no send', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const now = Date.now();
    const old = insertSessionSafe(db, ctx, automationId, 1, { gate_sent_at: new Date(now - 7 * DAY).toISOString() });
    const fresh = insertSessionSafe(db, ctx, automationId, 2, { gate_sent_at: new Date(now - 7 * DAY + MINUTE).toISOString(), next_poll_at: new Date(now + HOUR).toISOString() });
    const tapped = insertSessionSafe(db, ctx, automationId, 3, { tap_message_id: 'tap.3', tap_at: new Date(now - DAY).toISOString(),
      window_expires_at: new Date(now).toISOString() });
    const gate = fakeGate();
    await engine(db, gate, () => now).service.processDue();
    assert.equal(gate.taps.length + gate.sends.length, 0);
    assert.deepEqual(Object.values(one(db, `SELECT state, last_error_code FROM gate_sessions WHERE gate_session_id=?`, old)), ['EXPIRED', 'gate_no_tap_7d']);
    assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, fresh).state, 'AWAITING_TAP');
    assert.deepEqual(Object.values(one(db, `SELECT state, last_error_code FROM gate_sessions WHERE gate_session_id=?`, tapped)), ['EXPIRED', 'resource_window_elapsed']);
    assert.equal(events(db, old)[0]!.event_type, 'expired');
  });
});

test('CANCELLED (automation_inactive) when the automation is paused, archived or loses real authorization before the send', async () => {
  for (const change of [
    `UPDATE automations SET status='paused'`,
    `UPDATE automations SET status='disabled', real_enabled=0, name=name || ' (archived)'`,
    `UPDATE automations SET real_enabled=0`,
  ]) {
    await withDb(async (db) => {
      const ctx = seed(db);
      const automationId = gateAutomation(db, ctx);
      const id = insertSessionSafe(db, ctx, automationId, 1);
      db.exec(change);
      const gate = fakeGate();
      gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date().toISOString() };
      await engine(db, gate, () => Date.now()).service.processDue();
      assert.deepEqual(Object.values(one(db, `SELECT state, last_error_code FROM gate_sessions WHERE gate_session_id=?`, id)), ['CANCELLED', 'automation_inactive'], change);
      assert.equal(gate.sends.length, 0);
      assert.deepEqual(events(db, id).map((event) => event.event_type), ['tap_detected', 'cancelled']);
    });
  }
});

test('turning the gate off on the automation does not cancel an in-flight session (applies to new sessions only)', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const id = insertSessionSafe(db, ctx, automationId, 1);
    db.exec(`UPDATE automations SET follow_gate_enabled=0`);
    const gate = fakeGate();
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date().toISOString() };
    await engine(db, gate, () => Date.now()).service.processDue();
    assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, id).state, 'COMPLETED');
  });
});

test('Dry Run on: the engine makes no provider call; send holds and account pauses defer without changing state', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const id = insertSessionSafe(db, ctx, automationId, 1);
    const gate = fakeGate();
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date().toISOString() };
    setDryRun(db, true);
    await engine(db, gate, () => Date.now()).service.processDue();
    assert.equal(gate.taps.length + gate.sends.length, 0);
    setDryRun(db, false);
    db.prepare(`INSERT INTO account_send_holds(account_id, reason_code, created_at) VALUES (?, 'legacy_lock_present', '2026')`).run(ctx.accountId);
    await engine(db, gate, () => Date.now()).service.processDue();
    const row = one(db, `SELECT state, tap_message_id FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.deepEqual([row.state, row.tap_message_id], ['AWAITING_TAP', 'tap.1']);
    assert.equal(gate.sends.length, 0);
    db.exec(`DELETE FROM account_send_holds`);
    await engine(db, gate, () => Date.now() + MINUTE).service.processDue();
    assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, id).state, 'COMPLETED');
    assert.equal(gate.taps.length, 1);
  });
});

test('per-tick cap of 10 sessions, 0.5 s spacing between Meta calls, account isolation', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const other = seed(db, '2');
    const automationId = gateAutomation(db, ctx);
    const otherAutomation = gateAutomation(db, other);
    for (let index = 0; index < 12; index++) insertSessionSafe(db, ctx, automationId, index);
    const paused = insertSessionSafe(db, other, otherAutomation, 99);
    db.prepare(`UPDATE social_accounts SET monitoring_paused=1 WHERE account_id=?`).run(other.accountId);
    const gate = fakeGate();
    const now = Date.now();
    const { service, sleeps } = engine(db, gate, () => now);
    assert.equal(await service.processDue(), 10);
    assert.equal(gate.taps.length, 10);
    assert.deepEqual(sleeps, Array.from({ length: 9 }, () => 500));
    assert.ok(gate.taps.every((entry) => entry.account.accountId === ctx.accountId && entry.account.providerAccountId === ctx.providerAccountId));
    assert.equal(await service.processDue(), 2);
    assert.equal(one(db, `SELECT poll_count FROM gate_sessions WHERE gate_session_id=?`, paused).poll_count, 0);
    db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id=?`).run(other.accountId);
    assert.equal(await service.processDue(), 1);
    assert.equal(gate.taps.at(-1)!.account.accountId, other.accountId);
    assert.equal(gate.taps.at(-1)!.igsid, 'igsid99');
  });
});

test('a tap message id already used by another session is never recorded twice', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    insertSessionSafe(db, ctx, automationId, 1, { tap_message_id: 'tap.same', tap_at: new Date().toISOString(), window_expires_at: new Date(Date.now() + DAY).toISOString(), state: 'COMPLETED' });
    const id = insertSessionSafe(db, ctx, automationId, 2);
    const gate = fakeGate();
    gate.tap = { found: true, tapMessageId: 'tap.same', tapAt: new Date().toISOString() };
    await engine(db, gate, () => Date.now()).service.processDue();
    const row = one(db, `SELECT state, tap_message_id, last_error_code FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.deepEqual([row.state, row.tap_message_id, row.last_error_code], ['AWAITING_TAP', null, 'tap_already_used']);
    assert.equal(gate.sends.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DTOs and pending review
// ---------------------------------------------------------------------------------------------------------------

test('queue DTO exposes the session (Spanish UI maps states) and the attempts endpoint lists gate events, account scoped', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const other = seed(db, '2');
    const { session, queue } = await sendGate(db, ctx, { recipientId: '5544332211' });
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', queue } as never);
    const { server, origin } = await listen(handler);
    try {
      const item = (await call(origin, `/api/queue?accountId=${ctx.accountId}`)).json.items[0];
      assert.deepEqual(Object.keys(item.followGate).sort(), ['buttonTitle', 'gateSentAt', 'lastErrorCode', 'nextPollAt', 'pollCount', 'resourceMessageId', 'state', 'tapAt', 'windowExpiresAt']);
      assert.equal(item.followGate.state, 'AWAITING_TAP');
      assert.equal(JSON.stringify(item).includes('5544332211'), false, 'IGSID is never exposed');
      const attempts = await call(origin, `/api/queue/${item.id}/attempts?accountId=${ctx.accountId}`);
      assert.deepEqual(attempts.json.gateEvents.map((event: { type: string }) => event.type), ['session_created']);
      const cross = await call(origin, `/api/queue/${item.id}/attempts?accountId=${other.accountId}`);
      assert.equal(cross.status, 404);
      assert.ok(session);
    } finally { server.close(); }
  });
});

test('pending review shows both messages when the gate is on (and no gate preview otherwise)', async () => {
  await withDb((db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer', createdAt: new Date().toISOString() });
    db.exec(`INSERT INTO scan_runs(scan_id, account_id, media_id, scan_kind, status, started_at, finished_at) VALUES ('s1','acc','m','backlog','complete','2026','2026');
      INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, matched_keywords_json, observed_at, scan_id)
        VALUES ('acc','c1','${automationId}','eligible','eligible','["guide"]','2026','s1');`);
    const page = listPendingReview(db, ctx.accountId, { limit: 10, offset: 0, now: Date.now(), ...DORMANT });
    const item = page.items[0]!;
    assert.deepEqual(item.gatePreview, { text: '¡Hola customer! Sígueme y toca el botón 👇', buttonTitle: 'Ya te sigo' });
    assert.equal(item.previewText, 'Aquí tienes guide, customer');
    db.exec(`UPDATE automations SET follow_gate_enabled=0`);
    assert.equal(Object.hasOwn(listPendingReview(db, ctx.accountId, { limit: 10, offset: 0, now: Date.now(), ...DORMANT }).items[0]!, 'gatePreview'), false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------------------------

test('UI helpers: request fields, Spanish labels, honest note and the two-step preview', () => {
  assert.equal(FOLLOW_GATE_DEFAULT_TITLE, 'Ya te sigo');
  assert.equal(FOLLOW_GATE_DEFAULT_MESSAGE, '¡Hola {{username}}! Antes de enviarte el recurso, sígueme y luego toca el botón 👇');
  assert.match(FOLLOW_GATE_NOTE, /Meta no permite comprobar si la persona te sigue/u);
  assert.deepEqual(followGateRequestFields(false, ' a ', ' b '), { followGateEnabled: false, followGateMessage: 'a', followGateButtonTitle: 'b' });
  assert.deepEqual(followGateRequestFields(true, ` ${GATE_MESSAGE} `, ' Ya te sigo '), { followGateEnabled: true, followGateMessage: GATE_MESSAGE, followGateButtonTitle: 'Ya te sigo' });
  assert.deepEqual(followGateRequestFields(false, '', ''), { followGateEnabled: false, followGateMessage: '', followGateButtonTitle: 'Ya te sigo' });
  assert.equal(followGateStateLabel('AWAITING_TAP'), 'Esperando toque');
  assert.equal(followGateStateLabel('AWAITING_TAP', '2026-01-01T00:00:00Z'), 'Toque recibido · enviando recurso');
  assert.equal(followGateStateLabel('COMPLETED'), 'Recurso enviado');
  assert.equal(followGateStateLabel('EXPIRED'), 'Expirado');
  assert.equal(followGateStateLabel('CANCELLED'), 'Cancelado');
  assert.equal(followGateStateLabel('FAILED'), 'Falló');
  assert.equal(followGateStateLabel('UNKNOWN_OUTCOME'), 'Resultado desconocido');
  assert.equal(followGateStateLabel('RESOURCE_SENDING'), 'Enviando recurso');
  assert.equal(followGateEventLabel('tap_detected'), 'Toque detectado');
  assert.match(followGateErrorHint('igsid_unknown') ?? '', /identificador/u);
  assert.match(followGateErrorHint('automation_inactive') ?? '', /automatización/u);
  assert.equal(followGateErrorHint('meta_999'), null);
  assert.deepEqual(followGatePreview('Hola {{username}}, {{keyword}}', 'Ya te sigo', 'Aquí está {{keyword}}', [{ title: 'Guía', url: 'https://x.co' }]), {
    first: { text: 'Hola cliente_ejemplo, guía', buttonTitle: 'Ya te sigo' },
    second: { text: 'Aquí está guía', buttons: [{ title: 'Guía', url: 'https://x.co' }] },
  });
});

/** Direct insert of a SENT queue item plus its AWAITING_TAP session (for engine tests). */
function insertSessionSafe(db: Db, ctx: { accountId: string; mediaId: string }, automationId: string, index: number, overrides: Record<string, unknown> = {}): string {
  setDryRun(db, false);
  const commentId = `k${index}`;
  createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId, text: 'guide', username: `user${index}`, createdAt: new Date().toISOString() });
  const queueId = `q-${ctx.accountId}-${index}`;
  const nowIso = new Date().toISOString();
  db.prepare(`INSERT INTO queue_items(queue_item_id, account_id, comment_id, automation_id, state, dry_run, payload_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'SENT', 0, '{}', ?, ?)`).run(queueId, ctx.accountId, commentId, automationId, nowIso, nowIso);
  const values: Record<string, unknown> = {
    gate_session_id: `s-${ctx.accountId}-${index}`, account_id: ctx.accountId, automation_id: automationId, queue_item_id: queueId, comment_id: commentId,
    igsid: `igsid${index}`, state: 'AWAITING_TAP', gate_sent_at: new Date(Date.now() - MINUTE).toISOString(),
    next_poll_at: new Date(Date.now() - 1000).toISOString(), poll_count: 0, send_attempts: 0, button_title: 'Ya te sigo',
    resource_payload_json: JSON.stringify({ text: 'Aquí tienes', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] }),
    created_at: nowIso, updated_at: nowIso, ...overrides,
  };
  const keys = Object.keys(values);
  db.prepare(`INSERT INTO gate_sessions(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(Object.values(values) as never[]));
  return values.gate_session_id as string;
}
