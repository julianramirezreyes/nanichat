import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
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
import { INTERACTIVE_RETIRED_LABEL } from '../app/interactive-buttons.ts';
import { removeTempDir } from './helpers/tmp.ts';

/*
 * Phase 0 of "attachments by URL": the experimental interactive buttons (quick replies / postback buttons on a normal
 * automation) are retired. Their buttons did nothing when tapped. The follow gate keeps its own postback button.
 */

type Db = ReturnType<typeof openDatabase>;
const one = (db: Db, sql: string, ...params: unknown[]) => ({ ...(db.prepare(sql).get(...params as never[]) as Record<string, any>) });

async function withDb(run: (db: Db, directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'retire-interactive-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
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

function realAutomation(db: Db, ctx: { accountId: string; mediaId: string }): string {
  const service = new AutomationService(db);
  const id = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Auto', replyText: 'Hola {{username}}' });
  service.addKeyword(ctx.accountId, id, 'guide');
  service.setEnabled(ctx.accountId, id, true);
  service.setRealEnabled(ctx.accountId, id, true, true);
  return id;
}

test('API rejects any interactive mode other than none (and non-empty titles) with 400 interactive_mode_retired; none/omitted still work', async () => {
  await withDb(async (db) => {
    const ctx = seed(db);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', automations: new AutomationService(db) } as never);
    const { server, origin } = await listen(handler);
    const headers = { origin, 'content-type': 'application/json', 'x-csrf-token': 'csrf' };
    const base = { accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'Auto', keywords: ['guia'], replyText: 'Hola' };
    try {
      for (const extra of [
        { interactiveMode: 'quick_reply', interactiveTitles: ['Ya te sigo'] },
        { interactiveMode: 'postback', interactiveTitles: ['Listo'] },
        { interactiveMode: 'postback' },
        { interactiveMode: 'bogus', interactiveTitles: [] },
        { interactiveMode: 'none', interactiveTitles: ['a'] },
        { interactiveTitles: ['a'] },
        { interactiveTitles: 'a' },
        { interactiveMode: 7 },
      ]) {
        const result = await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, ...extra } });
        assert.deepEqual([result.status, result.json.error], [400, 'interactive_mode_retired'], JSON.stringify(extra));
      }
      assert.equal(one(db, `SELECT COUNT(*) AS n FROM automations`).n, 0);
      const created = await call(origin, '/api/automations', { method: 'POST', headers, body: base });
      assert.equal(created.status, 201);
      assert.equal((await call(origin, '/api/automations', { method: 'POST', headers, body: { ...base, name: 'B', interactiveMode: 'none', interactiveTitles: [] } })).status, 201);
      const put = await call(origin, `/api/automations/${created.json.automationId}`, { method: 'PUT', headers,
        body: { ...base, matchMode: 'contains', interactiveMode: 'postback', interactiveTitles: ['Listo'] } });
      assert.deepEqual([put.status, put.json.error], [400, 'interactive_mode_retired']);
      const ok = await call(origin, `/api/automations/${created.json.automationId}`, { method: 'PUT', headers, body: { ...base, matchMode: 'contains' } });
      assert.equal(ok.status, 200);
      // The automation DTO no longer carries the retired experimental fields.
      const listed = (await call(origin, `/api/automations?accountId=${ctx.accountId}`)).json.automations as Array<Record<string, unknown>>;
      assert.ok(listed.every((row) => !Object.hasOwn(row, 'interactiveMode') && !Object.hasOwn(row, 'interactiveTitles')));
    } finally { server.close(); }
  });
});

test('service rejects interactive modes with code interactive_mode_retired and resets a legacy stored mode on update', async () => {
  await withDb((db) => {
    const ctx = seed(db);
    const service = new AutomationService(db);
    const retired = (error: unknown) => error instanceof TypeError && (error as { code?: string }).code === 'interactive_mode_retired';
    assert.throws(() => service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'X', replyText: 'Hola',
      interactiveMode: 'quick_reply', interactiveTitles: ['Ok'] } as never), retired);
    assert.throws(() => service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'X', replyText: 'Hola', interactiveTitles: ['Ok'] } as never), retired);
    const id = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name: 'X', replyText: 'Hola', interactiveMode: 'none', interactiveTitles: [] } as never);
    assert.deepEqual(one(db, `SELECT interactive_mode, interactive_titles_json FROM automations WHERE automation_id=?`, id),
      { interactive_mode: 'none', interactive_titles_json: '[]' });
    const base = { name: 'X', mediaId: ctx.mediaId, replyText: 'Hola', matchMode: 'contains' as const, buttons: [], keywords: ['guia'] };
    assert.throws(() => service.update(ctx.accountId, id, { ...base, interactiveMode: 'postback', interactiveTitles: ['Ok'] } as never), retired);
    // A legacy row (created before the retirement) is normalized to 'none' by any later edit.
    db.prepare(`UPDATE automations SET interactive_mode='postback', interactive_titles_json='["Ya te sigo"]' WHERE automation_id=?`).run(id);
    service.update(ctx.accountId, id, base);
    assert.deepEqual(one(db, `SELECT interactive_mode, interactive_titles_json FROM automations WHERE automation_id=?`, id),
      { interactive_mode: 'none', interactive_titles_json: '[]' });
    // A legacy mode no longer blocks the follow gate (dormant code: the gate itself is retired, enabled here explicitly).
    db.prepare(`UPDATE automations SET interactive_mode='quick_reply', interactive_titles_json='["Ok"]' WHERE automation_id=?`).run(id);
    new AutomationService(db, { followGateAvailable: true }).update(ctx.accountId, id, { ...base, followGateEnabled: true, followGateMessage: 'Sígueme', followGateButtonTitle: 'Ya te sigo' } as never);
    assert.equal(one(db, `SELECT follow_gate_enabled FROM automations WHERE automation_id=?`, id).follow_gate_enabled, 1);
  });
});

test('enqueue ignores a legacy non-none interactive_mode: the payload is the historic text + URL buttons, no dead button is sent', async () => {
  for (const mode of ['postback', 'quick_reply']) {
    await withDb(async (db) => {
      const ctx = seed(db);
      const id = realAutomation(db, ctx);
      db.prepare(`UPDATE automations SET interactive_mode=?, interactive_titles_json='["Ya te sigo"]' WHERE automation_id=?`).run(mode, id);
      createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer',
        createdAt: new Date(Date.now() - 60_000).toISOString() });
      const provider = sendingProvider({ outcome: 'accepted', messageId: 'mid.1' });
      const queue = new QueueService(db, provider as never, { sendSpacingMs: 0 });
      queue.setDryRun(false, true);
      await queue.enqueueReviewed(ctx.accountId, id, ['c1']);
      const version = one(db, `SELECT version FROM automations WHERE automation_id=?`, id).version;
      assert.equal(one(db, `SELECT payload_json FROM queue_items`).payload_json, `{"text":"Hola customer","buttons":[],"automation_version":${version}}`, mode);
      await queue.processOne(ctx.accountId);
      assert.deepEqual(Object.keys(provider.sent[0] as object), ['text', 'buttons', 'automation_version']);
    });
  }
});

test('a legacy queued item whose frozen payload carries experimental buttons is SKIPPED before any intent or provider call', async () => {
  const legacyPayloads = [
    { text: 'Hola', buttons: [], postbackButtons: [{ title: 'Ya te sigo', payload: 'gate:AUTO:0' }] },
    { text: 'Hola', buttons: [], quickReplies: [{ title: 'Ya te sigo', payload: 'gate:AUTO:0' }] },
  ];
  for (const legacy of legacyPayloads) {
    await withDb(async (db) => {
      const ctx = seed(db);
      const id = realAutomation(db, ctx);
      createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'quiero la guide', username: 'customer',
        createdAt: new Date(Date.now() - 60_000).toISOString() });
      const version = one(db, `SELECT version FROM automations WHERE automation_id=?`, id).version;
      const nowIso = new Date().toISOString();
      db.prepare(`INSERT INTO queue_items(queue_item_id, account_id, comment_id, automation_id, state, dry_run, payload_json, created_at, updated_at)
        VALUES ('q1', ?, 'c1', ?, 'QUEUED', 0, ?, ?, ?)`).run(ctx.accountId, id, JSON.stringify({ ...legacy, automation_version: version }), nowIso, nowIso);
      const provider = sendingProvider({ outcome: 'accepted', messageId: 'mid.1' });
      const queue = new QueueService(db, provider as never, { sendSpacingMs: 0 });
      queue.setDryRun(false, true);
      await queue.processOne(ctx.accountId);
      assert.deepEqual(one(db, `SELECT state, state_reason_code FROM queue_items WHERE queue_item_id='q1'`), { state: 'SKIPPED', state_reason_code: 'interactive_mode_retired' });
      assert.equal(provider.sent.length, 0);
      assert.equal(one(db, `SELECT COUNT(*) AS n FROM send_attempts`).n, 0);
    });
  }
});

test('provider no longer builds quick replies (rejected before any request); the gate postback builder stays', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retire-interactive-provider-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  const vault = createVault(directory, () => listEncryptedCredentials(db));
  createConnection(db, { id: 'conn', name: 'p', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid',
    accessToken: vault.encrypt('conn', 'ig-user-token') });
  addDiscoveredAccount(db, { accountId: 'acc', connectionId: 'conn', providerAccountId: '178414', username: 'brand', status: 'valid' });
  createMedia(db, { accountId: 'acc', mediaId: 'media', permalink: null, publishedAt: null });
  createComment(db, { accountId: 'acc', mediaId: 'media', commentId: '18000', text: 'guide', username: 'customer', createdAt: null });
  const bodies: string[] = [];
  const provider = new MetaProvider(db, vault, async (_input, init = {}) => { bodies.push(String(init.body)); return Response.json({ message_id: 'mid.1' }); });
  const account = { accountId: 'acc', connectionId: 'conn', providerAccountId: '178414', username: 'brand' };
  try {
    const rejected = await provider.sendPrivateReply(account, '18000', { text: 'Hola', buttons: [], quickReplies: [{ title: 'Ok', payload: 'gate:a1:0' }] });
    assert.deepEqual([rejected.outcome, rejected.safeErrorCode], ['definitive_rejection', 'invalid_reply_payload']);
    assert.equal(bodies.length, 0);
    const gate = await provider.sendPrivateReply(account, '18000', { text: 'Hola', buttons: [], postbackButtons: [{ title: 'Ya te sigo', payload: 'gate:a1:0' }] });
    assert.equal(gate.outcome, 'accepted');
    assert.equal(bodies[0], '{"recipient":{"comment_id":"18000"},"message":{"attachment":{"type":"template","payload":{"template_type":"button","text":"Hola","buttons":[{"type":"postback","title":"Ya te sigo","payload":"gate:a1:0"}]}}}}');
  } finally { db.close(); removeTempDir(directory); }
});

test('UI: the experimental section and badge are gone, the inspector stays, the retired code has a Spanish label', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.equal(page.includes('Botones interactivos (experimental)'), false);
  assert.equal(page.includes('Botones experimentales'), false);
  assert.equal(page.includes('InteractiveFields'), false);
  assert.equal(page.includes('interactiveRequestFields'), false);
  assert.equal(page.includes('Inspeccionar conversación'), true);
  assert.match(INTERACTIVE_RETIRED_LABEL, /retirad/u);
  assert.equal(page.includes('interactive_mode_retired'), true);
});
