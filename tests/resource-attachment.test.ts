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
import { AutomationService } from '../src/services/automations.ts';
import { FollowGateService } from '../src/services/follow-gate.ts';
import { GATE_PART_SPACING_MS } from '../src/services/follow-gate-rules.ts';
import { listPendingReview } from '../src/services/pending-review.ts';
import { QueueService } from '../src/services/queue.ts';
import { isPublicHttpsUrl, storedResourceAttachment, validateResourceAttachment } from '../src/services/resource-attachment.ts';
import {
  ATTACHMENT_ERROR_LABELS, ATTACHMENT_OPTIONS, attachmentBadge, attachmentErrorHint, attachmentPartStateLabel, attachmentPreviewLine,
  attachmentRequestFields, attachmentWarnings, describeAttachment,
} from '../app/resource-attachment.ts';
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
const AUDIO = 'https://cdn.example.com/recursos/clase.m4a';
const GATE_MESSAGE = '¡Hola {{username}}! Sígueme y toca el botón 👇';

async function withDb(run: (db: Db, directory: string) => Promise<void> | void, target?: number): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'resource-attachment-'));
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
    followGateButtonTitle: 'Ya te sigo', resourceAttachmentKind: 'audio', resourceAttachmentUrl: AUDIO, ...extra } as never);
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

async function sendGate(db: Db, ctx: AccountRef & { mediaId: string }, options: { automationId?: string; dryRun?: boolean } = {}) {
  const automationId = options.automationId ?? gateAutomation(db, ctx);
  createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer',
    createdAt: new Date(Date.now() - 60_000).toISOString() });
  const provider = sendingProvider({ outcome: 'accepted', messageId: 'mid.c1', recipientId: '5544332211' });
  const queue = new QueueService(db, provider as never, { sendSpacingMs: 0, ...DORMANT });
  if (!options.dryRun) queue.setDryRun(false, true);
  await queue.enqueueReviewed(ctx.accountId, automationId, ['c1']);
  await queue.processOne(ctx.accountId);
  return { automationId, provider, queue, session: db.prepare(`SELECT * FROM gate_sessions WHERE comment_id='c1' AND account_id=?`).get(ctx.accountId) as Record<string, any> | undefined };
}

type Send = { account: AccountRef; igsid: string; payload: any; at: number };
type FakeGate = {
  taps: number; sends: Send[]; tap: TapResult;
  respond: (payload: any) => SendResult | Promise<SendResult>;
  findUserTap(): Promise<TapResult>;
  sendMessage(account: AccountRef, igsid: string, payload: unknown): Promise<SendResult>;
};

function fakeGate(clock: () => number): FakeGate {
  const fake: FakeGate = {
    taps: 0, sends: [], tap: { found: false },
    respond: (payload) => ({ outcome: 'accepted', messageId: payload.attachment ? 'mid.attachment' : 'mid.text' }),
    async findUserTap() { fake.taps++; return fake.tap; },
    async sendMessage(account, igsid, payload) { fake.sends.push({ account, igsid, payload, at: clock() }); return fake.respond(payload); },
  };
  return fake;
}

/** Engine with an injectable clock; by default the injected sleep advances that clock (like real time would). */
function engine(db: Db, gate: FakeGate, state: { now: number }, options: { advance?: boolean } = {}) {
  const sleeps: number[] = [];
  const service = new FollowGateService(db, gate as never, { ...DORMANT, clock: () => state.now,
    sleep: async (ms: number) => { sleeps.push(ms); if (options.advance !== false) state.now += ms; } });
  return { service, sleeps };
}

const partEvents = (db: Db, sessionId: string) => all(db, `SELECT part, event_type, message_id, safe_error_code, details_json, account_id
  FROM gate_part_events WHERE gate_session_id=? ORDER BY rowid`, sessionId);
const parts = (db: Db, sessionId: string) => partEvents(db, sessionId).map((event) => `${event.part}:${event.event_type}`);
const gateEvents = (db: Db, sessionId: string) => all(db, `SELECT event_type, message_id, safe_error_code, details_json FROM gate_events WHERE gate_session_id=? ORDER BY rowid`, sessionId);
const attachmentSends = (gate: FakeGate) => gate.sends.filter((send) => send.payload.attachment).length;
const textSends = (gate: FakeGate) => gate.sends.filter((send) => !send.payload.attachment).length;

/** Direct insert of a SENT queue item plus its AWAITING_TAP session (engine tests), with an audio attachment by default. */
function insertSession(db: Db, ctx: { accountId: string; mediaId: string }, automationId: string, index: number, overrides: Record<string, unknown> = {}): string {
  db.prepare(`UPDATE app_state SET state_value='false' WHERE state_key='dry_run'`).run();
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
    resource_attachment_kind: 'audio', resource_attachment_url: AUDIO,
    created_at: nowIso, updated_at: nowIso, ...overrides,
  };
  const keys = Object.keys(values);
  db.prepare(`INSERT INTO gate_sessions(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(Object.values(values) as never[]));
  return values.gate_session_id as string;
}

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

// ---------------------------------------------------------------------------------------------------------------
// Migration v13 -> v14
// ---------------------------------------------------------------------------------------------------------------

test('migration v13 -> v14 is additive: attachment columns default to empty, gate_part_events is append-only with one accepted per part', async () => {
  await withDb((db) => {
    assert.equal(one(db, 'PRAGMA user_version').user_version, 13);
    const ctx = seed(db);
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'hola', username: 'u', createdAt: '2026-01-01T00:00:00.000Z' });
    db.exec(`INSERT INTO automations (automation_id, account_id, media_id, scope, name, status, created_at, updated_at, real_enabled, version,
        buttons_json, follow_gate_enabled, follow_gate_message, follow_gate_button_title)
      VALUES ('a1','acc','m','media','Old','enabled','2026','2026',1,7,'[]',1,'Sígueme','Ya te sigo');
      INSERT INTO queue_items(queue_item_id,account_id,comment_id,automation_id,state,dry_run,payload_json,created_at,updated_at)
        VALUES ('q1','acc','c1','a1','SENT',0,'{"text":"x"}','2026','2026');
      INSERT INTO gate_sessions(gate_session_id, account_id, automation_id, queue_item_id, comment_id, igsid, state, gate_sent_at, button_title,
        resource_payload_json, created_at, updated_at) VALUES ('s1','acc','a1','q1','c1','i1','COMPLETED','2026','Ya te sigo','{"text":"r","buttons":[]}','2026','2026');
      INSERT INTO gate_events(gate_event_id, account_id, gate_session_id, event_type, event_at) VALUES ('e1','acc','s1','resource_accepted','2026');`);
    migrateDatabase(db);
    assert.equal(one(db, 'PRAGMA user_version').user_version, 14);
    assert.equal(one(db, 'PRAGMA foreign_keys').foreign_keys, 1);
    const automation = one(db, `SELECT * FROM automations WHERE automation_id='a1'`);
    assert.deepEqual([automation.resource_attachment_kind, automation.resource_attachment_url, automation.version, automation.follow_gate_message], ['', '', 7, 'Sígueme']);
    const session = one(db, `SELECT * FROM gate_sessions WHERE gate_session_id='s1'`);
    assert.deepEqual([session.resource_attachment_kind, session.resource_attachment_url, session.state, session.resource_payload_json], ['', '', 'COMPLETED', '{"text":"r","buttons":[]}']);
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_events`).n, 1);
    assert.throws(() => db.exec(`UPDATE automations SET resource_attachment_kind='pdf'`), /CHECK/);
    assert.throws(() => db.exec(`UPDATE gate_sessions SET resource_attachment_kind='template'`), /CHECK/);
    const event = (id: string, part: string, type: string, session = 's1') => db.prepare(`INSERT INTO gate_part_events(gate_part_event_id, account_id,
      gate_session_id, part, event_type, event_at) VALUES (?, 'acc', ?, ?, ?, '2026')`).run(id, session, part, type);
    event('p1', 'attachment', 'intent_recorded');
    event('p2', 'attachment', 'accepted');
    assert.throws(() => event('p3', 'attachment', 'accepted'), /UNIQUE/);
    event('p4', 'text', 'accepted');
    assert.throws(() => event('p5', 'text', 'accepted'), /UNIQUE/);
    event('p6', 'attachment', 'intent_recorded');
    assert.throws(() => event('p7', 'image', 'accepted'), /CHECK/);
    assert.throws(() => event('p8', 'text', 'bogus'), /CHECK/);
    assert.throws(() => event('p9', 'text', 'rejected', 'missing'), /FOREIGN KEY/);
    assert.throws(() => db.exec(`UPDATE gate_part_events SET event_type='rejected'`), /append-only/);
    assert.throws(() => db.exec(`DELETE FROM gate_part_events`), /append-only/);
    migrateDatabase(db);
    assert.equal(one(db, 'PRAGMA user_version').user_version, 14);
  }, 13);
});

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------

test('attachment URL rule: public https only, at most 2048 characters, no credentials, no local/private hosts or IP literals', () => {
  for (const ok of [AUDIO, 'https://example.com/a.mp3', 'https://example.com:8443/guia.pdf', 'https://files.example.co/x.jpg?v=2#top',
    `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`]) {
    assert.equal(isPublicHttpsUrl(ok), true, ok);
  }
  for (const bad of ['http://example.com/a.m4a', 'ftp://example.com/a.pdf', 'https://user:pass@example.com/a.pdf', 'https://user@example.com/a.pdf',
    'https://localhost/a.pdf', 'https://LOCALHOST:3000/a', 'https://app.localhost/a', 'https://printer.local/a', 'https://nas.lan/a', 'https://intranet/a',
    'https://router.home/a', 'https://svc.internal/a', 'https://127.0.0.1/a', 'https://10.0.0.5/a', 'https://192.168.1.10/a', 'https://8.8.8.8/a',
    'https://0x7f.1/a', 'https://[::1]/a', 'https://[2001:db8::1]/a', `https://example.com/${'a'.repeat(2049 - 'https://example.com/'.length)}`,
    'not a url', '', ' https://example.com/a.pdf', 'https://example.com/a b.pdf\n', 42, null]) {
    assert.equal(isPublicHttpsUrl(bad), false, String(bad));
  }
});

test('validateResourceAttachment: kinds, URL, follow gate requirement, keep-when-omitted and specific codes', () => {
  const none = { kind: '', url: '' };
  assert.deepEqual(validateResourceAttachment({}, true, none), { kind: '', url: '' });
  assert.deepEqual(validateResourceAttachment({ kind: 'audio', url: ` ${AUDIO} ` }, true, none), { kind: 'audio', url: AUDIO });
  for (const kind of ['image', 'audio', 'video', 'file']) assert.equal(validateResourceAttachment({ kind, url: AUDIO }, true, none).kind, kind);
  assert.deepEqual(validateResourceAttachment({ kind: '', url: '' }, false, { kind: 'audio', url: AUDIO }), { kind: '', url: '' });
  // Omitted fields keep the stored values; a stored attachment is kept as a draft while the gate is off.
  assert.deepEqual(validateResourceAttachment({}, false, { kind: 'audio', url: AUDIO }), { kind: 'audio', url: AUDIO });
  assert.deepEqual(validateResourceAttachment({ url: 'https://example.com/b.m4a' }, true, { kind: 'audio', url: AUDIO }), { kind: 'audio', url: 'https://example.com/b.m4a' });
  const cases: Array<[Record<string, unknown>, boolean, string]> = [
    [{ kind: 'pdf', url: AUDIO }, true, 'attachment_invalid'],
    [{ kind: 'IMAGE', url: AUDIO }, true, 'attachment_invalid'],
    [{ kind: 'template', url: AUDIO }, true, 'attachment_invalid'],
    [{ kind: 1, url: AUDIO }, true, 'attachment_invalid'],
    [{ kind: '', url: AUDIO }, true, 'attachment_invalid'],
    [{ kind: 'audio', url: '' }, true, 'attachment_url_invalid'],
    [{ kind: 'audio' }, true, 'attachment_url_invalid'],
    [{ kind: 'audio', url: 'http://example.com/a.m4a' }, true, 'attachment_url_invalid'],
    [{ kind: 'audio', url: 'https://localhost/a.m4a' }, true, 'attachment_url_invalid'],
    [{ kind: 'audio', url: 7 }, true, 'attachment_url_invalid'],
    [{ kind: 'audio', url: AUDIO }, false, 'attachment_requires_follow_gate'],
  ];
  for (const [input, gate, code] of cases) {
    assert.throws(() => validateResourceAttachment(input, gate, none),
      (error: unknown) => error instanceof TypeError && (error as { code?: string }).code === code, `${JSON.stringify(input)} gate=${gate}`);
  }
  assert.deepEqual(storedResourceAttachment('audio', AUDIO), { kind: 'audio', url: AUDIO });
  assert.equal(storedResourceAttachment('', ''), null);
  assert.equal(storedResourceAttachment('audio', 'http://x.co/a'), null);
  assert.equal(storedResourceAttachment('bogus', AUDIO), null);
});

test('automations API: attachment stored and listed; strict 400 codes; omitted keeps; empty kind clears', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', ...DORMANT, automations: new AutomationService(db, DORMANT) } as never);
    const { server, origin } = await listen(handler);
    const headers = { origin, 'content-type': 'application/json', 'x-csrf-token': 'csrf' };
    const gate = { followGateEnabled: true, followGateMessage: GATE_MESSAGE, followGateButtonTitle: 'Ya te sigo' };
    const base = { accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Gate', keywords: ['guia'], replyText: 'Hola', ...gate };
    try {
      for (const [extra, code] of [
        [{ resourceAttachmentKind: 'pdf', resourceAttachmentUrl: AUDIO }, 'attachment_invalid'],
        [{ resourceAttachmentKind: 'audio', resourceAttachmentUrl: 'http://example.com/a.m4a' }, 'attachment_url_invalid'],
        [{ resourceAttachmentKind: 'audio', resourceAttachmentUrl: 'https://192.168.0.2/a.m4a' }, 'attachment_url_invalid'],
        [{ resourceAttachmentKind: 'audio', resourceAttachmentUrl: AUDIO, followGateEnabled: false }, 'attachment_requires_follow_gate'],
        [{ resourceAttachmentKind: '', resourceAttachmentUrl: AUDIO }, 'attachment_invalid'],
      ] as Array<[Record<string, unknown>, string]>) {
        const result = await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, ...extra } });
        assert.deepEqual([result.status, result.json.error], [400, code], JSON.stringify(extra));
      }
      assert.equal(one(db, `SELECT COUNT(*) AS n FROM automations`).n, 0);
      const created = await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, resourceAttachmentKind: 'file', resourceAttachmentUrl: 'https://example.com/guia.pdf' } });
      assert.equal(created.status, 201);
      assert.equal((await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, name: 'Plain', followGateEnabled: false } })).status, 201);
      const listed = (await call(origin, `/api/automations?accountId=${ctx.accountId}`)).json.automations as Array<Record<string, unknown>>;
      const withFile = listed.find((row) => row.name === 'Gate')!;
      const plain = listed.find((row) => row.name === 'Plain')!;
      assert.deepEqual([withFile.resourceAttachmentKind, withFile.resourceAttachmentUrl], ['file', 'https://example.com/guia.pdf']);
      assert.deepEqual([plain.resourceAttachmentKind, plain.resourceAttachmentUrl], ['', '']);
      const id = created.json.automationId;
      const update = { ...base, matchMode: 'contains' };
      assert.equal((await call(origin, `/api/automations/${id}`, { method: 'PUT', headers, body: update })).status, 200);
      assert.deepEqual(Object.values(one(db, `SELECT resource_attachment_kind, resource_attachment_url FROM automations WHERE automation_id=?`, id)), ['file', 'https://example.com/guia.pdf']);
      const bad = await call(origin, `/api/automations/${id}`, { method: 'PUT', headers, body: { ...update, resourceAttachmentKind: 'video', resourceAttachmentUrl: 'https://nas.local/v.mp4' } });
      assert.deepEqual([bad.status, bad.json.error], [400, 'attachment_url_invalid']);
      assert.equal((await call(origin, `/api/automations/${id}`, { method: 'PUT', headers, body: { ...update, resourceAttachmentKind: '', resourceAttachmentUrl: '' } })).status, 200);
      assert.deepEqual(Object.values(one(db, `SELECT resource_attachment_kind, resource_attachment_url FROM automations WHERE automation_id=?`, id)), ['', '']);
    } finally { server.close(); }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Provider: exact JSON
// ---------------------------------------------------------------------------------------------------------------

const ACCOUNT_IG_ID = '17841400000000000';
const IGSID = '5544332211';

async function withProvider(respond: () => Response, run: (provider: MetaProvider, bodies: string[], account: AccountRef) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'resource-attachment-provider-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  const vault = createVault(directory, () => listEncryptedCredentials(db));
  createConnection(db, { id: 'conn', name: 'p', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid',
    accessToken: vault.encrypt('conn', 'ig-user-token') });
  addDiscoveredAccount(db, { accountId: 'acc', connectionId: 'conn', providerAccountId: ACCOUNT_IG_ID, username: 'brand', status: 'valid' });
  const bodies: string[] = [];
  const urls: string[] = [];
  try {
    const provider = new MetaProvider(db, vault, async (input, init = {}) => { urls.push(String(input)); bodies.push(String(init.body)); return respond(); });
    await run(provider, bodies, { accountId: 'acc', connectionId: 'conn', providerAccountId: ACCOUNT_IG_ID, username: 'brand' });
    assert.ok(urls.every((url) => url === `https://graph.instagram.com/v26.0/${ACCOUNT_IG_ID}/messages`));
  } finally { db.close(); removeTempDir(directory); }
}

test('sendMessage attachment: exact JSON for image, audio, video and file (payload.url), and the text message stays the button template', async () => {
  await withProvider(() => Response.json({ message_id: 'mid.a', recipient_id: IGSID }), async (provider, bodies, account) => {
    const cases: Array<[string, string]> = [['image', 'https://example.com/foto.jpg'], ['audio', AUDIO], ['video', 'https://example.com/v.mp4'], ['file', 'https://example.com/guia.pdf']];
    for (const [kind, url] of cases) {
      const result = await provider.sendMessage(account, IGSID, { attachment: { kind, url } } as never);
      assert.deepEqual([result.outcome, result.messageId], ['accepted', 'mid.a']);
    }
    assert.deepEqual(bodies, cases.map(([kind, url]) => `{"recipient":{"id":"${IGSID}"},"message":{"attachment":{"type":"${kind}","payload":{"url":"${url}"}}}}`));
    await provider.sendMessage(account, IGSID, { text: 'Recurso', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] });
    assert.equal(bodies.at(-1), `{"recipient":{"id":"${IGSID}"},"message":{"attachment":{"type":"template","payload":{"template_type":"button","text":"Recurso","buttons":[{"type":"web_url","title":"Guía","url":"https://example.com/guia"}]}}}}`);
  });
});

test('sendMessage attachment: invalid payloads are rejected before any request; Meta errors classify like other sends', async () => {
  let response = () => Response.json({ message_id: 'mid.a' });
  await withProvider(() => response(), async (provider, bodies, account) => {
    for (const payload of [
      { attachment: { kind: 'template', url: AUDIO } }, { attachment: { kind: 'audio', url: 'http://example.com/a.m4a' } },
      { attachment: { kind: 'audio', url: 'https://10.0.0.1/a.m4a' } }, { attachment: { kind: 'audio' } }, { attachment: null },
      { attachment: { kind: 'audio', url: AUDIO }, text: 'x', buttons: [] },
    ]) {
      assert.equal((await provider.sendMessage(account, IGSID, payload as never)).safeErrorCode, 'invalid_message_payload', JSON.stringify(payload));
    }
    assert.equal(bodies.length, 0);
    response = () => Response.json({ error: { code: 100, message: 'Invalid url token=abc' } }, { status: 400 });
    const rejected = await provider.sendMessage(account, IGSID, { attachment: { kind: 'audio', url: AUDIO } } as never);
    assert.deepEqual([rejected.outcome, rejected.safeErrorCode], ['definitive_rejection', 'meta_100']);
    assert.equal(JSON.stringify(rejected).includes('token'), false);
    response = () => Response.json({ error: { code: 2 } }, { status: 500 });
    assert.equal((await provider.sendMessage(account, IGSID, { attachment: { kind: 'audio', url: AUDIO } } as never)).outcome, 'ambiguous');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Enqueue, Dry Run and session snapshot
// ---------------------------------------------------------------------------------------------------------------

test('Dry Run: the simulated item previews both follow-up messages, no session, no provider call; DTO exposes the attachment', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const { provider, queue } = await sendGate(db, ctx, { dryRun: true });
    assert.equal(one(db, `SELECT state FROM queue_items`).state, 'SIMULATED');
    assert.equal(provider.sent.length, 0);
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_sessions`).n, 0);
    const state = { now: Date.now() };
    const gate = fakeGate(() => state.now);
    assert.equal(await engine(db, gate, state).service.processDue(), 0);
    assert.equal(gate.taps + gate.sends.length, 0);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', queue } as never);
    const { server, origin } = await listen(handler);
    try {
      const item = (await call(origin, `/api/queue?accountId=${ctx.accountId}`)).json.items[0];
      assert.deepEqual(item.payload.followGate, { buttonTitle: 'Ya te sigo', attachment: { kind: 'audio', url: AUDIO },
        resource: { text: 'Aquí tienes guide, customer', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] } });
      assert.equal(item.followGate, null);
    } finally { server.close(); }
  });
});

test('real send: the attachment snapshot is frozen on the session; the resource text snapshot is unchanged; later edits never alter it', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const { automationId, session } = await sendGate(db, ctx);
    assert.ok(session);
    assert.deepEqual([session.state, session.resource_attachment_kind, session.resource_attachment_url], ['AWAITING_TAP', 'audio', AUDIO]);
    assert.equal(session.resource_payload_json, '{"text":"Aquí tienes guide, customer","buttons":[{"title":"Guía","url":"https://example.com/guia"}]}');
    new AutomationService(db, DORMANT).update(ctx.accountId, automationId, { name: 'Gate', mediaId: ctx.mediaId, replyText: 'OTRO', matchMode: 'contains',
      buttons: [], keywords: ['guide'], resourceAttachmentKind: 'file', resourceAttachmentUrl: 'https://example.com/otro.pdf' } as never);
    const state = { now: Date.parse(session.gate_sent_at) + MINUTE };
    const gate = fakeGate(() => state.now);
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(state.now - 1000).toISOString() };
    await engine(db, gate, state).service.processDue();
    assert.deepEqual(gate.sends.map((send) => send.payload), [
      { attachment: { kind: 'audio', url: AUDIO } },
      { text: 'Aquí tienes guide, customer', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] },
    ]);
  });
});

test('sessions without an attachment are byte-for-byte unchanged: no part events, no attachment keys, same gate events', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx, { resourceAttachmentKind: '', resourceAttachmentUrl: '' });
    const { session } = await sendGate(db, ctx, { automationId });
    const payload = one(db, `SELECT payload_json FROM queue_items`).payload_json as string;
    assert.equal(payload.includes('attachment'), false);
    assert.deepEqual([session!.resource_attachment_kind, session!.resource_attachment_url], ['', '']);
    const state = { now: Date.parse(session!.gate_sent_at) + MINUTE };
    const gate = fakeGate(() => state.now);
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(state.now - 1000).toISOString() };
    const { sleeps } = { sleeps: [] as number[] };
    const service = new FollowGateService(db, gate as never, { ...DORMANT, clock: () => state.now, sleep: async (ms) => { sleeps.push(ms); } });
    await service.processDue();
    assert.deepEqual(sleeps, [500]);
    assert.deepEqual(gate.sends.map((send) => send.payload), [{ text: 'Aquí tienes guide, customer', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] }]);
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_part_events`).n, 0);
    assert.deepEqual(gateEvents(db, session!.gate_session_id).map((event) => [event.event_type, event.details_json]),
      [['session_created', '{"igsidSource":"send_response"}'], ['tap_detected', '{}'], ['resource_intent_recorded', '{}'], ['resource_accepted', '{}']]);
    const row = one(db, `SELECT state, send_attempts, last_error_code, resource_message_id FROM gate_sessions`);
    assert.deepEqual(row, { state: 'COMPLETED', send_attempts: 1, last_error_code: null, resource_message_id: 'mid.text' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Engine: order, spacing, idempotency, outcome policy
// ---------------------------------------------------------------------------------------------------------------

test('tap -> attachment first, then (>= 1 s later) the unchanged text + buttons; durable intent before EACH POST; COMPLETED', async () => {
  await withDb(async (db, directory) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const id = insertSession(db, ctx, automationId, 1);
    const state = { now: Date.now() };
    const gate = fakeGate(() => state.now);
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(state.now - 1000).toISOString() };
    const observer = openDatabase(directory);
    const observed: Array<Record<string, unknown>> = [];
    gate.respond = (payload) => {
      observed.push({ state: one(observer, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, id).state, parts: parts(observer, id) });
      return { outcome: 'accepted', messageId: payload.attachment ? 'mid.attachment' : 'mid.text' };
    };
    try {
      await engine(db, gate, state).service.processDue();
      assert.deepEqual(observed, [
        { state: 'RESOURCE_SENDING', parts: ['attachment:intent_recorded'] },
        { state: 'RESOURCE_SENDING', parts: ['attachment:intent_recorded', 'attachment:accepted', 'text:intent_recorded'] },
      ]);
    } finally { observer.close(); }
    assert.deepEqual(gate.sends.map((send) => Object.keys(send.payload)), [['attachment'], ['text', 'buttons']]);
    assert.deepEqual(gate.sends[1]!.payload, { text: 'Aquí tienes', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] });
    assert.ok(gate.sends[1]!.at - gate.sends[0]!.at >= GATE_PART_SPACING_MS, `spacing ${gate.sends[1]!.at - gate.sends[0]!.at}`);
    assert.ok(GATE_PART_SPACING_MS >= 1000);
    assert.ok(gate.sends.every((send) => send.igsid === 'igsid1'));
    const row = one(db, `SELECT state, last_error_code, resource_message_id FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.deepEqual(row, { state: 'COMPLETED', last_error_code: null, resource_message_id: 'mid.text' });
    assert.deepEqual(partEvents(db, id).map((event) => [event.part, event.event_type, event.message_id]), [
      ['attachment', 'intent_recorded', null], ['attachment', 'accepted', 'mid.attachment'], ['text', 'intent_recorded', null], ['text', 'accepted', 'mid.text']]);
    assert.deepEqual(gateEvents(db, id).map((event) => [event.event_type, JSON.parse(event.details_json).part ?? null]), [
      ['tap_detected', null], ['resource_intent_recorded', 'attachment'], ['resource_intent_recorded', 'text'], ['resource_accepted', 'text']]);
    // Later ticks never send anything again.
    state.now += HOUR;
    await engine(db, gate, state).service.processDue();
    assert.equal(gate.sends.length, 2);
  });
});

test('spacing is enforced with the injected clock: if no time passes, the text waits for a later tick and the attachment is never resent', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const id = insertSession(db, ctx, automationId, 1);
    const state = { now: Date.now() };
    const gate = fakeGate(() => state.now);
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(state.now - 1000).toISOString() };
    const frozen = engine(db, gate, state, { advance: false });
    await frozen.service.processDue();
    assert.deepEqual([attachmentSends(gate), textSends(gate)], [1, 0]);
    let row = one(db, `SELECT state, next_poll_at FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.equal(row.state, 'AWAITING_TAP');
    const acceptedAt = Date.parse(one(db, `SELECT event_at FROM gate_part_events WHERE part='attachment' AND event_type='accepted'`).event_at);
    assert.equal(Date.parse(row.next_poll_at), acceptedAt + GATE_PART_SPACING_MS);
    await frozen.service.processDue();
    assert.equal(gate.sends.length, 1, 'not due yet');
    state.now = acceptedAt + GATE_PART_SPACING_MS;
    await frozen.service.processDue();
    assert.deepEqual([attachmentSends(gate), textSends(gate)], [1, 1]);
    row = one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.equal(row.state, 'COMPLETED');
  });
});

test('attachment definitively rejected -> recorded and skipped, the text + buttons are STILL sent; COMPLETED with attachment_failed', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const id = insertSession(db, ctx, automationId, 1);
    const state = { now: Date.now() };
    const gate = fakeGate(() => state.now);
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(state.now - 1000).toISOString() };
    gate.respond = (payload) => payload.attachment
      ? { outcome: 'definitive_rejection', safeErrorCode: 'meta_100', httpStatus: 400, metaCode: 100 }
      : { outcome: 'accepted', messageId: 'mid.text' };
    await engine(db, gate, state).service.processDue();
    assert.deepEqual([attachmentSends(gate), textSends(gate)], [1, 1]);
    assert.deepEqual(one(db, `SELECT state, last_error_code, resource_message_id FROM gate_sessions WHERE gate_session_id=?`, id),
      { state: 'COMPLETED', last_error_code: 'attachment_failed', resource_message_id: 'mid.text' });
    assert.deepEqual(partEvents(db, id).map((event) => [event.part, event.event_type, event.safe_error_code]), [
      ['attachment', 'intent_recorded', null], ['attachment', 'rejected', 'meta_100'], ['attachment', 'skipped', 'attachment_failed'],
      ['text', 'intent_recorded', null], ['text', 'accepted', null]]);
    state.now += HOUR;
    await engine(db, gate, state).service.processDue();
    assert.equal(gate.sends.length, 2);
  });
});

test('attachment ambiguous (timeout, no message id, exception) -> UNKNOWN_OUTCOME and the text is NEVER sent', async () => {
  for (const outcome of [{ outcome: 'ambiguous', safeErrorCode: 'meta_timeout' }, { outcome: 'accepted' }, 'throw'] as const) {
    await withDb(async (db) => {
      const ctx = seed(db);
      const automationId = gateAutomation(db, ctx);
      const id = insertSession(db, ctx, automationId, 1);
      const state = { now: Date.now() };
      const gate = fakeGate(() => state.now);
      gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(state.now - 1000).toISOString() };
      gate.respond = () => { if (outcome === 'throw') throw new Error('network'); return outcome as SendResult; };
      await engine(db, gate, state).service.processDue();
      assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, id).state, 'UNKNOWN_OUTCOME', String(outcome));
      assert.deepEqual(parts(db, id), ['attachment:intent_recorded', 'attachment:ambiguous']);
      assert.equal(gateEvents(db, id).at(-1)!.event_type, 'resource_ambiguous');
      state.now += DAY / 2;
      await engine(db, gate, state).service.processDue();
      assert.deepEqual([attachmentSends(gate), textSends(gate)], [1, 0]);
    });
  }
});

test('rate-limited attachment retries the attachment only (Retry-After, at most 3 attempts), then skips it and sends the text', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const id = insertSession(db, ctx, automationId, 1);
    const state = { now: Date.now() };
    const gate = fakeGate(() => state.now);
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(state.now - 1000).toISOString() };
    gate.respond = (payload) => payload.attachment
      ? { outcome: 'definitive_rejection', safeErrorCode: 'meta_4', httpStatus: 400, metaCode: 4, usageHeaders: { retryAfter: '120' } }
      : { outcome: 'accepted', messageId: 'mid.text' };
    const { service } = engine(db, gate, state);
    await service.processDue();
    let row = one(db, `SELECT state, next_poll_at FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.equal(row.state, 'AWAITING_TAP');
    assert.equal(Date.parse(row.next_poll_at) - state.now, 120_000);
    state.now += 60_000;
    await service.processDue();
    assert.deepEqual([attachmentSends(gate), textSends(gate)], [1, 0], 'Retry-After respected, text not sent while retrying');
    state.now = Date.parse(row.next_poll_at) + 1;
    gate.respond = (payload) => payload.attachment ? { outcome: 'definitive_rejection', safeErrorCode: 'http_429', httpStatus: 429 } : { outcome: 'accepted', messageId: 'mid.text' };
    await service.processDue();
    assert.deepEqual([attachmentSends(gate), textSends(gate)], [2, 0]);
    row = one(db, `SELECT state, next_poll_at FROM gate_sessions WHERE gate_session_id=?`, id);
    state.now = Date.parse(row.next_poll_at) + 1;
    await service.processDue();
    assert.deepEqual([attachmentSends(gate), textSends(gate)], [3, 1]);
    assert.deepEqual(one(db, `SELECT state, last_error_code FROM gate_sessions WHERE gate_session_id=?`, id), { state: 'COMPLETED', last_error_code: 'attachment_failed' });
    assert.deepEqual(parts(db, id).filter((entry) => entry.startsWith('attachment')), ['attachment:intent_recorded', 'attachment:rejected',
      'attachment:intent_recorded', 'attachment:rejected', 'attachment:intent_recorded', 'attachment:rejected', 'attachment:skipped']);
    assert.equal(gate.taps, 1);
  });
});

test('after an accepted attachment, text failures never resend the attachment (rate limit retries the text only; ambiguous; rejected)', async () => {
  // Rate-limited text: retried alone, then accepted.
  await withDb(async (db) => {
    const ctx = seed(db);
    const id = insertSession(db, ctx, gateAutomation(db, ctx), 1);
    const state = { now: Date.now() };
    const gate = fakeGate(() => state.now);
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(state.now - 1000).toISOString() };
    let textCalls = 0;
    gate.respond = (payload) => payload.attachment ? { outcome: 'accepted', messageId: 'mid.attachment' }
      : ++textCalls === 1 ? { outcome: 'definitive_rejection', safeErrorCode: 'meta_613', httpStatus: 400, metaCode: 613 } : { outcome: 'accepted', messageId: 'mid.text' };
    const { service } = engine(db, gate, state);
    await service.processDue();
    const row = one(db, `SELECT state, next_poll_at FROM gate_sessions WHERE gate_session_id=?`, id);
    assert.equal(row.state, 'AWAITING_TAP');
    state.now = Date.parse(row.next_poll_at) + 1;
    await service.processDue();
    assert.deepEqual([attachmentSends(gate), textSends(gate)], [1, 2]);
    assert.deepEqual(one(db, `SELECT state, last_error_code FROM gate_sessions WHERE gate_session_id=?`, id), { state: 'COMPLETED', last_error_code: null });
  });
  for (const [textResult, finalState] of [
    [{ outcome: 'ambiguous', safeErrorCode: 'meta_timeout' }, 'UNKNOWN_OUTCOME'],
    [{ outcome: 'definitive_rejection', safeErrorCode: 'meta_10', httpStatus: 400, metaCode: 10 }, 'FAILED'],
  ] as const) {
    await withDb(async (db) => {
      const ctx = seed(db);
      const id = insertSession(db, ctx, gateAutomation(db, ctx), 1);
      const state = { now: Date.now() };
      const gate = fakeGate(() => state.now);
      gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(state.now - 1000).toISOString() };
      gate.respond = (payload) => payload.attachment ? { outcome: 'accepted', messageId: 'mid.attachment' } : textResult as SendResult;
      const { service } = engine(db, gate, state);
      await service.processDue();
      assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, id).state, finalState);
      for (let tick = 0; tick < 3; tick++) { state.now += HOUR; await service.processDue(); }
      assert.deepEqual([attachmentSends(gate), textSends(gate)], [1, 1], finalState);
      assert.deepEqual(parts(db, id), ['attachment:intent_recorded', 'attachment:accepted', 'text:intent_recorded',
        finalState === 'FAILED' ? 'text:rejected' : 'text:ambiguous']);
    });
  }
});

test('startup recovery: a part left with an intent and no outcome becomes ambiguous and the session UNKNOWN_OUTCOME', async () => {
  for (const pending of ['attachment', 'text'] as const) {
    await withDb(async (db) => {
      const ctx = seed(db);
      const id = insertSession(db, ctx, gateAutomation(db, ctx), 1, { state: 'RESOURCE_SENDING', tap_message_id: 'tap.1', tap_at: new Date().toISOString(),
        window_expires_at: new Date(Date.now() + DAY).toISOString(), send_attempts: 1 });
      const add = (part: string, type: string) => db.prepare(`INSERT INTO gate_part_events(gate_part_event_id, account_id, gate_session_id, part, event_type, event_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(`${part}-${type}`, ctx.accountId, id, part, type, new Date().toISOString());
      add('attachment', 'intent_recorded');
      if (pending === 'text') { add('attachment', 'accepted'); add('text', 'intent_recorded'); }
      const state = { now: Date.now() };
      const gate = fakeGate(() => state.now);
      const service = new FollowGateService(db, gate as never, { ...DORMANT, sleep: async () => undefined });
      assert.equal(service.recoverInterrupted(), 1);
      assert.deepEqual(one(db, `SELECT state, last_error_code FROM gate_sessions WHERE gate_session_id=?`, id), { state: 'UNKNOWN_OUTCOME', last_error_code: 'process_interrupted_after_intent' });
      const last = partEvents(db, id).at(-1)!;
      assert.deepEqual([last.part, last.event_type, last.safe_error_code], [pending, 'ambiguous', 'process_interrupted_after_intent']);
      await service.processDue();
      assert.equal(gate.sends.length, 0);
    });
  }
});

test('expiry, cancellation and Dry Run keep their rules for attachment sessions (no provider call)', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    const now = Date.now();
    const expired = insertSession(db, ctx, automationId, 1, { tap_message_id: 'tap.1', tap_at: new Date(now - DAY).toISOString(), window_expires_at: new Date(now).toISOString() });
    const state = { now };
    const gate = fakeGate(() => state.now);
    await engine(db, gate, state).service.processDue();
    assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, expired).state, 'EXPIRED');
    const cancelled = insertSession(db, ctx, automationId, 2);
    db.exec(`UPDATE automations SET real_enabled=0`);
    gate.tap = { found: true, tapMessageId: 'tap.2', tapAt: new Date(now).toISOString() };
    await engine(db, gate, state).service.processDue();
    assert.deepEqual(one(db, `SELECT state, last_error_code FROM gate_sessions WHERE gate_session_id=?`, cancelled), { state: 'CANCELLED', last_error_code: 'automation_inactive' });
    db.exec(`UPDATE automations SET real_enabled=1`);
    insertSession(db, ctx, automationId, 3);
    db.prepare(`UPDATE app_state SET state_value='true' WHERE state_key='dry_run'`).run();
    await engine(db, gate, state).service.processDue();
    assert.equal(gate.sends.length, 0);
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_part_events`).n, 0);
  });
});

test('account isolation: each session sends with its own account; part events belong to that account; attempts endpoint is account scoped', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const other = seed(db, '2');
    const first = insertSession(db, ctx, gateAutomation(db, ctx), 1);
    const second = insertSession(db, other, gateAutomation(db, other), 2, { resource_attachment_kind: 'file', resource_attachment_url: 'https://example.com/g.pdf' });
    const state = { now: Date.now() };
    const gate = fakeGate(() => state.now);
    gate.tap = { found: true, tapMessageId: 'tap.x', tapAt: new Date(state.now - 1000).toISOString() };
    let tapIndex = 0;
    gate.findUserTap = async () => { gate.taps++; return { found: true, tapMessageId: `tap.${++tapIndex}`, tapAt: new Date(state.now - 1000).toISOString() }; };
    await engine(db, gate, state).service.processDue();
    assert.equal(gate.sends.length, 4);
    for (const send of gate.sends) {
      const expected = send.igsid === 'igsid1' ? ctx.accountId : other.accountId;
      assert.equal(send.account.accountId, expected);
    }
    assert.deepEqual(gate.sends.filter((send) => send.payload.attachment).map((send) => [send.account.accountId, send.payload.attachment.kind]).sort(),
      [[ctx.accountId, 'audio'], [other.accountId, 'file']]);
    assert.ok(partEvents(db, first).every((event) => event.account_id === ctx.accountId));
    assert.ok(partEvents(db, second).every((event) => event.account_id === other.accountId));
    const handler = createApiHandler({ database: db, csrfToken: 'csrf' } as never);
    const { server, origin } = await listen(handler);
    try {
      const queueId = `q-${ctx.accountId}-1`;
      const attempts = await call(origin, `/api/queue/${queueId}/attempts?accountId=${ctx.accountId}`);
      assert.deepEqual(attempts.json.gatePartEvents.map((event: { part: string; type: string }) => `${event.part}:${event.type}`),
        ['attachment:intent_recorded', 'attachment:accepted', 'text:intent_recorded', 'text:accepted']);
      assert.equal(JSON.stringify(attempts.json).includes('mid.'), false, 'message ids stay server-side');
      assert.equal((await call(origin, `/api/queue/${queueId}/attempts?accountId=${other.accountId}`)).status, 404);
      const item = (await call(origin, `/api/queue?accountId=${ctx.accountId}`)).json.items[0];
      assert.deepEqual(item.followGate.attachment, { kind: 'audio', url: AUDIO });
      assert.deepEqual(item.followGate.parts, { attachment: { state: 'accepted', safeErrorCode: null, attempts: 1 }, text: { state: 'accepted', safeErrorCode: null, attempts: 1 } });
      assert.equal(JSON.stringify(item).includes('igsid'), false);
    } finally { server.close(); }
  });
});

test('queue DTO parts show a skipped attachment with its safe error code; sessions without attachment keep the old DTO keys', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const id = insertSession(db, ctx, gateAutomation(db, ctx), 1);
    insertSession(db, ctx, gateAutomation(db, ctx, { name: 'Plain gate' }), 2, { resource_attachment_kind: '', resource_attachment_url: '' });
    const state = { now: Date.now() };
    const gate = fakeGate(() => state.now);
    gate.tap = { found: true, tapMessageId: 'tap.1', tapAt: new Date(state.now - 1000).toISOString() };
    let tapIndex = 0;
    gate.findUserTap = async () => ({ found: true, tapMessageId: `tap.${++tapIndex}`, tapAt: new Date(state.now - 1000).toISOString() });
    gate.respond = (payload) => payload.attachment ? { outcome: 'definitive_rejection', safeErrorCode: 'meta_100', httpStatus: 400, metaCode: 100 } : { outcome: 'accepted', messageId: 'mid.t' };
    await engine(db, gate, state).service.processDue();
    const handler = createApiHandler({ database: db, csrfToken: 'csrf' } as never);
    const { server, origin } = await listen(handler);
    try {
      const items = (await call(origin, `/api/queue?accountId=${ctx.accountId}`)).json.items as Array<any>;
      const withAttachment = items.find((item) => item.id === `q-${ctx.accountId}-1`);
      const plain = items.find((item) => item.id === `q-${ctx.accountId}-2`);
      assert.equal(withAttachment.followGate.lastErrorCode, 'attachment_failed');
      assert.deepEqual(withAttachment.followGate.parts.attachment, { state: 'skipped', safeErrorCode: 'attachment_failed', attempts: 1 });
      assert.deepEqual(Object.keys(plain.followGate).sort(), ['buttonTitle', 'gateSentAt', 'lastErrorCode', 'nextPollAt', 'pollCount', 'resourceMessageId', 'state', 'tapAt', 'windowExpiresAt']);
      assert.ok(id);
    } finally { server.close(); }
  });
});

test('pending review shows the attachment step in the gate preview (only when configured)', async () => {
  await withDb((db) => {
    const ctx = seed(db);
    const automationId = gateAutomation(db, ctx);
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer', createdAt: new Date().toISOString() });
    db.exec(`INSERT INTO scan_runs(scan_id, account_id, media_id, scan_kind, status, started_at, finished_at) VALUES ('s1','acc','m','backlog','complete','2026','2026');
      INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, matched_keywords_json, observed_at, scan_id)
        VALUES ('acc','c1','${automationId}','eligible','eligible','["guide"]','2026','s1');`);
    const item = listPendingReview(db, ctx.accountId, { limit: 10, offset: 0, now: Date.now(), ...DORMANT }).items[0]!;
    assert.deepEqual(item.gatePreview, { text: '¡Hola customer! Sígueme y toca el botón 👇', buttonTitle: 'Ya te sigo', attachment: { kind: 'audio', url: AUDIO } });
    db.exec(`UPDATE automations SET resource_attachment_kind='', resource_attachment_url=''`);
    assert.deepEqual(listPendingReview(db, ctx.accountId, { limit: 10, offset: 0, now: Date.now(), ...DORMANT }).items[0]!.gatePreview,
      { text: '¡Hola customer! Sígueme y toca el botón 👇', buttonTitle: 'Ya te sigo' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------------------------

test('UI helpers: options, badge, request fields, warnings (.mp3, share pages), previews, part labels and error labels', () => {
  assert.deepEqual(ATTACHMENT_OPTIONS.map((option) => [option.value, option.label]),
    [['', 'Sin adjunto'], ['image', 'Imagen'], ['audio', 'Audio'], ['video', 'Video'], ['file', 'PDF']]);
  assert.equal(attachmentBadge('audio'), 'Adjunto: audio');
  assert.equal(attachmentBadge('image'), 'Adjunto: imagen');
  assert.equal(attachmentBadge('video'), 'Adjunto: video');
  assert.equal(attachmentBadge('file'), 'Adjunto: PDF');
  assert.equal(attachmentBadge(''), null);
  assert.deepEqual(attachmentRequestFields(true, 'audio', ` ${AUDIO} `), { resourceAttachmentKind: 'audio', resourceAttachmentUrl: AUDIO });
  assert.deepEqual(attachmentRequestFields(true, '', 'https://x.co/a'), { resourceAttachmentKind: '', resourceAttachmentUrl: '' });
  assert.deepEqual(attachmentRequestFields(false, 'audio', AUDIO), {});
  assert.deepEqual(attachmentWarnings('audio', 'https://example.com/clase.MP3?x=1'), ['Meta documenta aac, m4a, wav y mp4; mp3 no está documentado.']);
  assert.deepEqual(attachmentWarnings('audio', AUDIO), []);
  assert.deepEqual(attachmentWarnings('file', 'https://example.com/clase.mp3'), []);
  assert.match(attachmentWarnings('file', 'https://drive.google.com/file/d/abc/view?usp=sharing').join(' '), /descarga directa/u);
  assert.match(attachmentWarnings('file', 'https://www.dropbox.com/s/abc/guia.pdf?dl=0').join(' '), /descarga directa/u);
  assert.equal(describeAttachment('audio', AUDIO), 'cdn.example.com · clase.m4a');
  assert.equal(describeAttachment('file', 'https://example.com/'), 'example.com');
  assert.equal(attachmentPreviewLine('audio', AUDIO), 'Mensaje 1: se enviaría un audio (cdn.example.com · clase.m4a)');
  assert.equal(attachmentPreviewLine('file', 'https://example.com/guia.pdf'), 'Mensaje 1: se enviaría un PDF (example.com · guia.pdf)');
  assert.equal(attachmentPartStateLabel('accepted'), 'Aceptado por Meta');
  assert.equal(attachmentPartStateLabel('skipped'), 'Omitido');
  assert.equal(attachmentPartStateLabel('ambiguous'), 'Resultado desconocido');
  assert.equal(attachmentPartStateLabel('pending'), 'Pendiente');
  assert.equal(attachmentErrorHint('attachment_failed'), 'Meta rechazó el adjunto; se envió solo el texto.');
  for (const code of ['attachment_invalid', 'attachment_url_invalid', 'attachment_requires_follow_gate']) assert.ok(ATTACHMENT_ERROR_LABELS[code], code);
});
