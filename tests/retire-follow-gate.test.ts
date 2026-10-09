import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AccountRef } from '../src/core/domain.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { AutomationService } from '../src/services/automations.ts';
import { FollowGateService } from '../src/services/follow-gate.ts';
import { FOLLOW_GATE_AVAILABLE, followGateAvailable } from '../src/services/follow-gate-rules.ts';
import { listPendingReview } from '../src/services/pending-review.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { Scheduler } from '../src/services/scheduler.ts';
import {
  FOLLOW_GATE_RETIRED_LABEL, MEDIA_LINK_TIP, followGateErrorHint, showFollowGateDetail,
} from '../app/follow-gate.ts';
import { ATTACHMENT_ERROR_LABELS, ATTACHMENT_RETIRED_LABEL } from '../app/resource-attachment.ts';

/*
 * Retirement of the follow gate («Pedir primero que me sigan») and of the resource attachment (2026-10-09). With a
 * polling-only app, Meta rejects the follow-up send after the tap (HTTP 403, code 10, subcode 2534022 "outside of
 * allowed window"), so the person who taps receives nothing. One central switch (FOLLOW_GATE_AVAILABLE = false) turns
 * every entry point off; the dormant engine stays covered by tests that enable it explicitly.
 */

type Db = ReturnType<typeof openDatabase>;
const one = (db: Db, sql: string, ...params: unknown[]) => ({ ...(db.prepare(sql).get(...params as never[]) as Record<string, any>) });
const all = (db: Db, sql: string, ...params: unknown[]) => (db.prepare(sql).all(...params as never[]) as Array<Record<string, any>>).map((row) => ({ ...row }));
const AUDIO = 'https://cdn.example.com/audio/guia.m4a';
const DAY = 24 * 60 * 60_000;

async function withDb(run: (db: Db) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'retire-follow-gate-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  try { await run(db); } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}

function seed(db: Db): AccountRef & { mediaId: string } {
  createConnection(db, { id: 'conn', name: 'c', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
    status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
  addDiscoveredAccount(db, { accountId: 'acc', connectionId: 'conn', providerAccountId: 'p', username: 'brand', status: 'valid' });
  db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='conn'`).run();
  db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='acc'`).run();
  createMedia(db, { accountId: 'acc', mediaId: 'm', permalink: null, publishedAt: null });
  return { accountId: 'acc', connectionId: 'conn', providerAccountId: 'p', username: 'brand', mediaId: 'm' };
}

/** A real-enabled automation whose row still has the gate ON and an audio attachment (a pre-retirement test config). */
function legacyGateAutomation(db: Db, ctx: { accountId: string; mediaId: string }): string {
  const service = new AutomationService(db);
  const id = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'pruebaaudio', replyText: 'Aquí tienes {{keyword}}, {{username}}',
    buttons: [{ title: 'Guía', url: 'https://example.com/guia' }] });
  db.prepare(`UPDATE automations SET follow_gate_enabled=1, follow_gate_message='Sígueme y toca 👇', follow_gate_button_title='Ya te sigo',
    resource_attachment_kind='audio', resource_attachment_url=? WHERE automation_id=?`).run(AUDIO, id);
  service.addKeyword(ctx.accountId, id, 'guide');
  service.setEnabled(ctx.accountId, id, true);
  service.setRealEnabled(ctx.accountId, id, true, true);
  return id;
}

function trackingProvider() {
  const calls = { getComment: 0, sent: [] as unknown[] };
  return {
    calls,
    async getComment(_account: unknown, commentId: string) {
      calls.getComment++;
      return { commentId, text: 'quiero la guide', username: 'customer', createdAt: new Date(Date.now() - 60_000).toISOString() };
    },
    async sendPrivateReply(_account: unknown, _commentId: string, payload: unknown) { calls.sent.push(payload); return { outcome: 'accepted', messageId: 'mid.1', recipientId: '5544332211' }; },
    async readMessage(_account: unknown, messageId: string) { return { messageId, observedAt: new Date().toISOString() }; },
  };
}

function fakeGate() {
  const gate = { taps: 0, sends: 0,
    async findUserTap() { gate.taps++; return { found: true, tapMessageId: 'tap.1', tapAt: new Date().toISOString() }; },
    async sendMessage() { gate.sends++; return { outcome: 'accepted', messageId: 'mid.resource' }; } };
  return gate;
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
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request(new URL(path, origin), { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : undefined }));
    });
    req.on('error', reject);
    req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

/** Direct insert of a SENT queue item plus a gate session in the given state. */
function insertSession(db: Db, automationId: string, index: number, state: string, overrides: Record<string, unknown> = {}): string {
  const commentId = `k${index}`;
  createComment(db, { accountId: 'acc', mediaId: 'm', commentId, text: 'guide', username: `user${index}`, createdAt: new Date().toISOString() });
  const nowIso = new Date().toISOString();
  db.prepare(`INSERT INTO queue_items(queue_item_id, account_id, comment_id, automation_id, state, dry_run, payload_json, created_at, updated_at)
    VALUES (?, 'acc', ?, ?, 'SENT', 0, '{}', ?, ?)`).run(`q${index}`, commentId, automationId, nowIso, nowIso);
  const values: Record<string, unknown> = {
    gate_session_id: `s${index}`, account_id: 'acc', automation_id: automationId, queue_item_id: `q${index}`, comment_id: commentId,
    igsid: `igsid${index}`, state, gate_sent_at: new Date(Date.now() - 60_000).toISOString(),
    next_poll_at: state === 'AWAITING_TAP' ? new Date(Date.now() - 1000).toISOString() : null, button_title: 'Ya te sigo',
    resource_payload_json: JSON.stringify({ text: 'Aquí tienes', buttons: [] }), created_at: nowIso, updated_at: nowIso, ...overrides,
  };
  const keys = Object.keys(values);
  db.prepare(`INSERT INTO gate_sessions(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(Object.values(values) as never[]));
  return values.gate_session_id as string;
}

test('one central switch: the follow gate is retired by default and only an explicit (test) override enables it', () => {
  assert.equal(FOLLOW_GATE_AVAILABLE, false);
  assert.equal(followGateAvailable(), false);
  assert.equal(followGateAvailable(undefined), false);
  assert.equal(followGateAvailable(true), true);
});

test('API: gate or attachment requests are rejected with 400 follow_gate_retired / attachment_retired; plain requests still work', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', automations: new AutomationService(db) } as never);
    const { server, origin } = await listen(handler);
    const headers = { origin, 'content-type': 'application/json', 'x-csrf-token': 'csrf' };
    const base = { accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Auto', keywords: ['guia'], replyText: 'Hola' };
    try {
      for (const [extra, code] of [
        [{ followGateEnabled: true, followGateMessage: 'Sígueme', followGateButtonTitle: 'Ya te sigo' }, 'follow_gate_retired'],
        [{ followGateEnabled: true }, 'follow_gate_retired'],
        [{ followGateEnabled: 'yes' }, 'follow_gate_retired'],
        [{ followGateEnabled: false, followGateMessage: 'Sígueme' }, 'follow_gate_retired'],
        [{ followGateButtonTitle: 'Toca aquí' }, 'follow_gate_retired'],
        [{ resourceAttachmentKind: 'audio', resourceAttachmentUrl: AUDIO }, 'attachment_retired'],
        [{ resourceAttachmentKind: 'audio' }, 'attachment_retired'],
        [{ resourceAttachmentUrl: AUDIO }, 'attachment_retired'],
        [{ resourceAttachmentKind: 'bogus', resourceAttachmentUrl: 'http://x' }, 'attachment_retired'],
      ] as Array<[Record<string, unknown>, string]>) {
        const result = await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, ...extra } });
        assert.deepEqual([result.status, result.json.error], [400, code], JSON.stringify(extra));
      }
      assert.equal(one(db, `SELECT COUNT(*) AS n FROM automations`).n, 0);
      assert.equal((await call(origin, '/api/automations', { method: 'POST', headers, body: base })).status, 201);
      const neutral = await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, name: 'B', followGateEnabled: false,
        followGateMessage: '', followGateButtonTitle: 'Ya te sigo', resourceAttachmentKind: '', resourceAttachmentUrl: '' } });
      assert.equal(neutral.status, 201);
      assert.deepEqual(one(db, `SELECT follow_gate_enabled, follow_gate_message, follow_gate_button_title, resource_attachment_kind, resource_attachment_url
        FROM automations WHERE automation_id=?`, neutral.json.automationId),
      { follow_gate_enabled: 0, follow_gate_message: '', follow_gate_button_title: 'Ya te sigo', resource_attachment_kind: '', resource_attachment_url: '' });
    } finally { server.close(); }
  });
});

test('PUT resets a stored gate and attachment (old test configs); GET exposes them as disabled; a gate request is 400 and changes nothing', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const id = legacyGateAutomation(db, ctx);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', automations: new AutomationService(db) } as never);
    const { server, origin } = await listen(handler);
    const headers = { origin, 'content-type': 'application/json', 'x-csrf-token': 'csrf' };
    const body = { accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'pruebaaudio', keywords: ['guide'], replyText: 'Hola', matchMode: 'contains' };
    const stored = () => one(db, `SELECT follow_gate_enabled, follow_gate_message, follow_gate_button_title, resource_attachment_kind, resource_attachment_url
      FROM automations WHERE automation_id=?`, id);
    try {
      const listed = (await call(origin, `/api/automations?accountId=${ctx.accountId}`)).json.automations[0];
      assert.deepEqual([listed.followGateEnabled, listed.followGateMessage, listed.resourceAttachmentKind, listed.resourceAttachmentUrl], [false, '', '', '']);
      const rejected = await call(origin, `/api/automations/${id}`, { method: 'PUT', headers, body: { ...body, followGateEnabled: true } });
      assert.deepEqual([rejected.status, rejected.json.error], [400, 'follow_gate_retired']);
      const rejectedAttachment = await call(origin, `/api/automations/${id}`, { method: 'PUT', headers,
        body: { ...body, resourceAttachmentKind: 'audio', resourceAttachmentUrl: AUDIO } });
      assert.deepEqual([rejectedAttachment.status, rejectedAttachment.json.error], [400, 'attachment_retired']);
      assert.equal(stored().follow_gate_enabled, 1, 'a rejected request changes nothing');
      const ok = await call(origin, `/api/automations/${id}`, { method: 'PUT', headers, body });
      assert.equal(ok.status, 200);
      assert.deepEqual(stored(), { follow_gate_enabled: 0, follow_gate_message: '', follow_gate_button_title: 'Ya te sigo',
        resource_attachment_kind: '', resource_attachment_url: '' });
    } finally { server.close(); }
  });
});

test('enqueue ignores a stored gate and attachment: the first message is the normal text + URL buttons and no session is created', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const id = legacyGateAutomation(db, ctx);
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer',
      createdAt: new Date(Date.now() - 60_000).toISOString() });
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c2', text: 'quiero la guide', username: 'other',
      createdAt: new Date(Date.now() - 60_000).toISOString() });
    const provider = trackingProvider();
    const queue = new QueueService(db, provider as never, { sendSpacingMs: 0 });
    // Dry Run preview: a single normal message, no gate snapshot.
    await queue.enqueueReviewed(ctx.accountId, id, ['c2']);
    const simulated = JSON.parse(one(db, `SELECT payload_json FROM queue_items WHERE comment_id='c2'`).payload_json);
    assert.deepEqual(Object.keys(simulated), ['text', 'buttons', 'automation_version']);
    queue.setDryRun(false, true);
    await queue.enqueueReviewed(ctx.accountId, id, ['c1']);
    await queue.processOne(ctx.accountId);
    assert.deepEqual(provider.calls.sent[0], { text: 'Aquí tienes guide, customer', buttons: [{ title: 'Guía', url: 'https://example.com/guia' }],
      automation_version: one(db, `SELECT version FROM automations WHERE automation_id=?`, id).version });
    assert.equal(one(db, `SELECT state FROM queue_items WHERE comment_id='c1'`).state, 'SENT');
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_sessions`).n, 0);
  });
});

test('a queued item frozen with a gate payload is SKIPPED (follow_gate_retired) before any provider call, intent or session', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const id = legacyGateAutomation(db, ctx);
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer',
      createdAt: new Date(Date.now() - 60_000).toISOString() });
    // Frozen while the gate still existed (dormant code path, enabled explicitly).
    const before = new QueueService(db, trackingProvider() as never, { sendSpacingMs: 0, followGateAvailable: true });
    before.setDryRun(false, true);
    await before.enqueueReviewed(ctx.accountId, id, ['c1']);
    assert.ok(JSON.parse(one(db, `SELECT payload_json FROM queue_items`).payload_json).followGate);
    const provider = trackingProvider();
    const queue = new QueueService(db, provider as never, { sendSpacingMs: 0 });
    await queue.processOne(ctx.accountId);
    assert.deepEqual(one(db, `SELECT state, state_reason_code FROM queue_items`), { state: 'SKIPPED', state_reason_code: 'follow_gate_retired' });
    assert.deepEqual([provider.calls.getComment, provider.calls.sent.length], [0, 0]);
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM send_attempts`).n, 0);
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_sessions`).n, 0);
  });
});

test('engine (flag off): open sessions are CANCELLED follow_gate_retired with no provider call; closed sessions are history and untouched', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const id = legacyGateAutomation(db, ctx);
    db.prepare(`UPDATE app_state SET state_value='false' WHERE state_key='dry_run'`).run();
    const waiting = insertSession(db, id, 1, 'AWAITING_TAP');
    const tapped = insertSession(db, id, 2, 'AWAITING_TAP', { tap_message_id: 'tap.2', tap_at: new Date().toISOString(),
      window_expires_at: new Date(Date.now() + DAY).toISOString() });
    const closed = ['COMPLETED', 'FAILED', 'EXPIRED', 'UNKNOWN_OUTCOME', 'CANCELLED'].map((state, index) =>
      insertSession(db, id, 10 + index, state, { last_error_code: state === 'FAILED' ? 'meta_10' : null }));
    const snapshot = () => all(db, `SELECT gate_session_id, state, last_error_code, next_poll_at, updated_at FROM gate_sessions WHERE gate_session_id IN (${closed.map(() => '?').join(',')}) ORDER BY gate_session_id`, ...closed);
    const closedBefore = snapshot();
    const gate = fakeGate();
    const service = new FollowGateService(db, gate as never, { sleep: async () => undefined });
    assert.equal(await service.processDue(), 0);
    assert.deepEqual([gate.taps, gate.sends], [0, 0]);
    for (const session of [waiting, tapped]) {
      assert.deepEqual(one(db, `SELECT state, last_error_code, next_poll_at FROM gate_sessions WHERE gate_session_id=?`, session),
        { state: 'CANCELLED', last_error_code: 'follow_gate_retired', next_poll_at: null });
      assert.deepEqual(all(db, `SELECT event_type, safe_error_code FROM gate_events WHERE gate_session_id=?`, session),
        [{ event_type: 'cancelled', safe_error_code: 'follow_gate_retired' }]);
    }
    assert.deepEqual(snapshot(), closedBefore);
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_events WHERE gate_session_id IN (${closed.map(() => '?').join(',')})`, ...closed).n, 0);
    // Idempotent: a second run changes nothing and appends nothing.
    await service.processDue();
    assert.equal(one(db, `SELECT COUNT(*) AS n FROM gate_events`).n, 2);
    assert.deepEqual([gate.taps, gate.sends], [0, 0]);
  });
});

test('startup recovery still turns an in-flight RESOURCE_SENDING into UNKNOWN_OUTCOME; the scheduler tick then cancels the rest without Meta', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const id = legacyGateAutomation(db, ctx);
    const inflight = insertSession(db, id, 1, 'RESOURCE_SENDING', { tap_message_id: 'tap.1', tap_at: new Date().toISOString(),
      window_expires_at: new Date(Date.now() + DAY).toISOString(), send_attempts: 1 });
    const waiting = insertSession(db, id, 2, 'AWAITING_TAP');
    const gate = fakeGate();
    const followGate = new FollowGateService(db, gate as never, { sleep: async () => undefined });
    const queue = new QueueService(db, trackingProvider() as never);
    const scanner = new Scanner(db, { async listComments() { return { items: [], complete: true }; } } as never);
    const scheduler = new Scheduler(db, scanner, queue, { followGate });
    assert.deepEqual(one(db, `SELECT state, last_error_code FROM gate_sessions WHERE gate_session_id=?`, inflight),
      { state: 'UNKNOWN_OUTCOME', last_error_code: 'process_interrupted_after_intent' });
    scheduler.startAll();
    await scheduler.tick();
    scheduler.stopAll();
    assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, waiting).state, 'CANCELLED');
    assert.equal(one(db, `SELECT state FROM gate_sessions WHERE gate_session_id=?`, inflight).state, 'UNKNOWN_OUTCOME');
    assert.deepEqual([gate.taps, gate.sends], [0, 0]);
  });
});

test('pending review previews the single normal message even when the automation row still has the gate and an attachment', async () => {
  await withDb((db) => {
    const ctx = seed(db);
    const id = legacyGateAutomation(db, ctx);
    createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer', createdAt: new Date().toISOString() });
    db.exec(`INSERT INTO scan_runs(scan_id, account_id, media_id, scan_kind, status, started_at, finished_at) VALUES ('s1','acc','m','backlog','complete','2026','2026');
      INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, matched_keywords_json, observed_at, scan_id)
        VALUES ('acc','c1','${id}','eligible','eligible','["guide"]','2026','s1');`);
    const item = listPendingReview(db, ctx.accountId, { limit: 10, offset: 0, now: Date.now() }).items[0]!;
    assert.equal(Object.hasOwn(item, 'gatePreview'), false);
    assert.equal(item.previewText, 'Aquí tienes guide, customer');
    assert.deepEqual(item.previewButtons, [{ title: 'Guía', url: 'https://example.com/guia' }]);
  });
});

test('queue DTO: a historical session stays readable (state, code, events); a skipped item shows its safe reason code', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const id = legacyGateAutomation(db, ctx);
    insertSession(db, id, 1, 'FAILED', { last_error_code: 'meta_10', tap_message_id: 'tap.1', tap_at: new Date().toISOString() });
    db.prepare(`INSERT INTO gate_events(gate_event_id, account_id, gate_session_id, event_type, event_at, safe_error_code)
      VALUES ('e1', 'acc', 's1', 'resource_rejected', ?, 'meta_10')`).run(new Date().toISOString());
    createComment(db, { accountId: 'acc', mediaId: 'm', commentId: 'k9', text: 'guide', username: 'u9', createdAt: new Date().toISOString() });
    db.prepare(`INSERT INTO queue_items(queue_item_id, account_id, comment_id, automation_id, state, dry_run, payload_json, created_at, updated_at, state_reason_code)
      VALUES ('q9', 'acc', 'k9', ?, 'SKIPPED', 0, '{}', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', 'follow_gate_retired')`).run(id);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf' } as never);
    const { server, origin } = await listen(handler);
    try {
      const items = (await call(origin, `/api/queue?accountId=${ctx.accountId}`)).json.items as Array<Record<string, any>>;
      const historical = items.find((item) => item.id === 'q1')!;
      assert.deepEqual([historical.followGate.state, historical.followGate.lastErrorCode], ['FAILED', 'meta_10']);
      assert.equal(items.find((item) => item.id === 'q9')!.safeErrorCode, 'follow_gate_retired');
      const attempts = await call(origin, `/api/queue/q1/attempts?accountId=${ctx.accountId}`);
      assert.deepEqual(attempts.json.gateEvents.map((event: { type: string }) => event.type), ['resource_rejected']);
    } finally { server.close(); }
  });
});

test('UI helpers: Spanish retirement labels, the media tip and the «Seguimiento» block only for a historical session', () => {
  assert.match(FOLLOW_GATE_RETIRED_LABEL, /^Esta opción está desactivada: Meta no permite entregar el recurso después del toque del botón con esta aplicación\./u);
  assert.match(ATTACHMENT_RETIRED_LABEL, /^Esta opción está desactivada/u);
  assert.equal(ATTACHMENT_ERROR_LABELS.attachment_retired, ATTACHMENT_RETIRED_LABEL);
  assert.equal(MEDIA_LINK_TIP, 'Para entregar un audio o un video, ponlo en tu página y enlázalo con un botón de enlace.');
  assert.match(followGateErrorHint('follow_gate_retired') ?? '', /retirad/u);
  const snapshot = { buttonTitle: 'Ya te sigo', resource: { text: 'x', buttons: [] } };
  assert.equal(showFollowGateDetail({ payload: { followGate: snapshot }, followGate: null }), false);
  assert.equal(showFollowGateDetail({ payload: {}, followGate: undefined }), false);
  assert.equal(showFollowGateDetail({ payload: { followGate: snapshot }, followGate: { state: 'FAILED' } }), true);
});

test('UI page: the gate block and the attachment fields are gone from the form and the edit dialog; the tip and labels are wired', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  for (const removed of ['<FollowGateFields', 'followGateRequestFields(', 'attachmentRequestFields(', 'FOLLOW_GATE_BADGE', 'attachmentBadge(', 'ATTACHMENT_LABEL', 'gatePreview']) {
    assert.equal(page.includes(removed), false, removed);
  }
  for (const kept of ['MEDIA_LINK_TIP', 'showFollowGateDetail(', 'follow_gate_retired', 'Inspeccionar conversación']) {
    assert.equal(page.includes(kept), true, kept);
  }
});
