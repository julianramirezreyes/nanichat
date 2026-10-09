import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { AutomationService, renderReply } from '../src/services/automations.ts';
import { BacklogService } from '../src/services/backlog.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { removeTempDir } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDatabase>;

async function withDatabase(run: (db: Db) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'social-automation-review-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  try { await run(db); } finally { db.close(); removeTempDir(directory); }
}

function seedAccount(db: Db, suffix = '', username = 'brand') {
  createConnection(db, {
    id: `conn${suffix}`, name: `test${suffix}`, providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
    status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' },
  });
  addDiscoveredAccount(db, { accountId: `account${suffix}`, connectionId: `conn${suffix}`, providerAccountId: `provider${suffix}`, username, status: 'valid' });
  createMedia(db, { accountId: `account${suffix}`, mediaId: `media${suffix}`, permalink: `https://www.instagram.com/p/abc${suffix}/`, publishedAt: null });
  return { accountId: `account${suffix}`, connectionId: `conn${suffix}`, providerAccountId: `provider${suffix}`, username };
}

function seedAutomation(db: Db, accountId: string, mediaId: string) {
  const automations = new AutomationService(db);
  const automationId = automations.create({ accountId, mediaId, name: 'lead', replyText: 'Hi {{username}}' });
  automations.addKeyword(accountId, automationId, 'guide');
  automations.setEnabled(accountId, automationId, true);
  return automationId;
}

function providerWith(commentId: string, complete: boolean) {
  return { async listComments() {
    return { items: [{ commentId, text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() }],
      complete, ...(complete ? {} : { nextCursor: 'loop' }) };
  } } as never;
}

test('processEligible rejects an ID that was never scanned and enqueues nothing', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const automationId = seedAutomation(db, account.accountId, 'media');
    createComment(db, { accountId: account.accountId, mediaId: 'media', commentId: 'unscanned', text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() });
    const backlog = new BacklogService(db, new Scanner(db, providerWith('scanned', true)), new QueueService(db, {} as never));
    await assert.rejects(backlog.processEligible(account.accountId, automationId, ['unscanned']), /not been reviewed|not.*eligible/i);
    assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM queue_items`).get() as { c: number }).c, 0);
  });
});

test('processEligible rejects IDs classified by an incomplete scan', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const automationId = seedAutomation(db, account.accountId, 'media');
    const backlog = new BacklogService(db, new Scanner(db, providerWith('partial', false)), new QueueService(db, {} as never));
    const report = await backlog.scan(account, { window: '24h' });
    assert.equal(report.reports[0]?.status, 'incomplete');
    await assert.rejects(backlog.processEligible(account.accountId, automationId, ['partial']), /not been reviewed|not.*eligible/i);
    assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM queue_items`).get() as { c: number }).c, 0);
  });
});

test('processEligible rejects IDs scanned for another account and is all-or-nothing', async () => {
  await withDatabase(async (db) => {
    const accountA = seedAccount(db, 'A', 'alpha');
    const accountB = seedAccount(db, 'B', 'beta');
    const automationA = seedAutomation(db, accountA.accountId, 'mediaA');
    const automationB = seedAutomation(db, accountB.accountId, 'mediaB');
    const queue = new QueueService(db, {} as never);
    const backlog = new BacklogService(db, new Scanner(db, providerWith('shared-id', true)), queue);
    await backlog.scan(accountA, { window: '24h' });
    await assert.rejects(backlog.processEligible(accountB.accountId, automationB, ['shared-id']));
    // Mixed batch: one reviewed ID plus one unreviewed ID must enqueue neither.
    createComment(db, { accountId: accountA.accountId, mediaId: 'mediaA', commentId: 'extra', text: 'guide', username: 'other', createdAt: new Date(Date.now() - 1000).toISOString() });
    await assert.rejects(backlog.processEligible(accountA.accountId, automationA, ['shared-id', 'extra']));
    assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM queue_items`).get() as { c: number }).c, 0);
  });
});

test('processEligible accepts a legitimately scanned eligible ID', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const automationId = seedAutomation(db, account.accountId, 'media');
    const backlog = new BacklogService(db, new Scanner(db, providerWith('good', true)), new QueueService(db, {} as never));
    await backlog.scan(account, { window: '24h' });
    assert.deepEqual(await backlog.processEligible(account.accountId, automationId, ['good']), ['good']);
  });
});

async function listen(handler: ReturnType<typeof createApiHandler>): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function post(origin: string, path: string, body: unknown, method = 'POST') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(new URL(path, origin), { method, headers: { origin, 'content-type': 'application/json', 'x-csrf-token': 'csrf' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('POST /api/backlog/process rejects unreviewed IDs with a safe 4xx', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'social-automation-review-http-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  const account = seedAccount(db);
  const automationId = seedAutomation(db, account.accountId, 'media');
  createComment(db, { accountId: account.accountId, mediaId: 'media', commentId: 'unscanned', text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() });
  const backlog = new BacklogService(db, new Scanner(db, providerWith('x', true)), new QueueService(db, {} as never));
  const { server, origin } = await listen(createApiHandler({ database: db, csrfToken: 'csrf', backlog } as never));
  context.after(() => { server.close(); db.close(); removeTempDir(directory); });
  const response = await post(origin, '/api/backlog/process', { accountId: account.accountId, automationId, commentIds: ['unscanned'], confirmed: true });
  assert.ok(response.status >= 400 && response.status < 500, String(response.status));
  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM queue_items`).get() as { c: number }).c, 0);
});

test('router rejects invalid matchMode on create and update, defaults only when omitted', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'social-automation-review-mode-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  const account = seedAccount(db);
  const { server, origin } = await listen(createApiHandler({ database: db, csrfToken: 'csrf', automations: new AutomationService(db) } as never));
  context.after(() => { server.close(); db.close(); removeTempDir(directory); });
  const base = { accountId: account.accountId, mediaId: 'media', name: 'n', keywords: ['guide'], replyText: 'Hi' };
  for (const bad of ['EXACT', 'regex', '', 5, null]) {
    const created = await post(origin, '/api/automations', { ...base, matchMode: bad });
    assert.equal(created.status, 400, JSON.stringify(bad));
    assert.equal(JSON.parse(created.body).error, 'invalid_request');
  }
  assert.equal((db.prepare(`SELECT COUNT(*) AS c FROM automations`).get() as { c: number }).c, 0);
  const omitted = await post(origin, '/api/automations', base);
  assert.equal(omitted.status, 201);
  const { automationId } = JSON.parse(omitted.body) as { automationId: string };
  assert.equal((db.prepare(`SELECT match_mode FROM automations WHERE automation_id=?`).get(automationId) as { match_mode: string }).match_mode, 'contains');
  const exact = await post(origin, '/api/automations', { ...base, name: 'e', matchMode: 'exact' });
  assert.equal(exact.status, 201);
  const badUpdate = await post(origin, `/api/automations/${automationId}`, { ...base, matchMode: 'fuzzy', buttons: [] }, 'PUT');
  assert.equal(badUpdate.status, 400);
  assert.equal((db.prepare(`SELECT match_mode FROM automations WHERE automation_id=?`).get(automationId) as { match_mode: string }).match_mode, 'contains');
  const goodUpdate = await post(origin, `/api/automations/${automationId}`, { ...base, matchMode: 'exact', buttons: [] }, 'PUT');
  assert.equal(goodUpdate.status, 200);
  assert.equal((db.prepare(`SELECT match_mode FROM automations WHERE automation_id=?`).get(automationId) as { match_mode: string }).match_mode, 'exact');
});

test('renderReply supports {{account}} and bounded {{media}} and still rejects unknown variables', () => {
  const rendered = renderReply('Hi {{username}} from {{account}} re {{media}}', {
    username: 'ana', comment: 'c', keyword: 'k', account: 'brand', media: 'https://www.instagram.com/p/abc/',
  }, []);
  assert.equal(rendered.text, 'Hi ana from brand re https://www.instagram.com/p/abc/');
  assert.throws(() => renderReply('{{unknown}}', { username: 'a', comment: 'c', keyword: 'k' }, []), /Unsupported reply variable/);
  assert.throws(() => renderReply('{{account}} {{Account}}', { username: 'a', comment: 'c', keyword: 'k' }, []), /Unsupported reply variable/);
});

test('automation save accepts new variables and rejects unknown ones', async () => {
  await withDatabase((db) => {
    const account = seedAccount(db);
    const automations = new AutomationService(db);
    assert.ok(automations.create({ accountId: account.accountId, mediaId: 'media', name: 'ok', replyText: '{{account}} {{media}}' }));
    assert.throws(() => automations.create({ accountId: account.accountId, mediaId: 'media', name: 'bad', replyText: '{{postcaption}}' }), /Unsupported reply variable/);
  });
});

test('queue renders account username and a bounded media identifier', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const longPermalink = `https://www.instagram.com/p/${'x'.repeat(300)}/`;
    db.prepare(`UPDATE media SET permalink=? WHERE account_id=? AND media_id=?`).run(longPermalink, account.accountId, 'media');
    const automations = new AutomationService(db);
    const automationId = automations.create({ accountId: account.accountId, mediaId: 'media', name: 'v', replyText: '{{account}}|{{media}}' });
    automations.addKeyword(account.accountId, automationId, 'guide');
    automations.setEnabled(account.accountId, automationId, true);
    createComment(db, { accountId: account.accountId, mediaId: 'media', commentId: 'c1', text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() });
    await new QueueService(db, {} as never).enqueueReviewed(account.accountId, automationId, ['c1']);
    const row = db.prepare(`SELECT payload_json FROM queue_items WHERE comment_id='c1'`).get() as { payload_json: string };
    const [accountPart, mediaPart] = (JSON.parse(row.payload_json) as { text: string }).text.split('|');
    assert.equal(accountPart, 'brand');
    assert.ok(mediaPart!.length > 0 && mediaPart!.length <= 100);
  });
});
