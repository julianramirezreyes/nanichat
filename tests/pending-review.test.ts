import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { truncateText } from '../src/services/pending-review.ts';
import { autoPickAutomation, describeQueuePayload } from '../app/pending-review.ts';

type Db = ReturnType<typeof openDatabase>;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const FRESH = '2026-10-05T12:00:00Z';
const STALE = '2026-09-20T12:00:00Z';

async function withEnv(run: (ctx: { db: Db; origin: string }) => Promise<void>, now = NOW): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'pending-review-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  for (const [suffix, username] of [['A', 'alpha'], ['B', 'beta']] as const) {
    createConnection(db, { id: `conn${suffix}`, name: suffix, providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid', accessToken: { nonce: 'secret-nonce', ciphertext: 'secret-cipher', tag: 'secret-tag' } });
    addDiscoveredAccount(db, { accountId: `account${suffix}`, connectionId: `conn${suffix}`, providerAccountId: `p${suffix}`, username, status: 'valid' });
    createMedia(db, { accountId: `account${suffix}`, mediaId: `media${suffix}`, permalink: `https://www.instagram.com/p/${suffix}/`, publishedAt: null });
  }
  db.prepare(`INSERT INTO automations(automation_id,account_id,media_id,name,status,match_mode,reply_text,buttons_json,created_at,updated_at)
    VALUES ('autoA','accountA','mediaA','Guía','enabled','contains','Hola {{username}}, vi "{{comment}}" ({{keyword}}) en {{account}} {{media}}',
    '[{"title":"Ver guía","url":"https://example.com/g"}]',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
  db.prepare(`INSERT INTO automations(automation_id,account_id,media_id,name,status,match_mode,reply_text,created_at,updated_at)
    VALUES ('autoB','accountB','mediaB','Beta','enabled','contains','Hi',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
  const server: Server = createServer((req, res) => { void createApiHandler({ database: db, clock: () => now } as never)(req, res); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  try { await run({ db, origin: `http://127.0.0.1:${address.port}` }); }
  finally { server.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
}

function scan(db: Db, id: string, account: string, kind: string, status: string, finishedAt = '2026-10-06T11:00:00Z') {
  db.prepare(`INSERT INTO scan_runs(scan_id,account_id,media_id,scan_kind,status,started_at,finished_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, account, account === 'accountA' ? 'mediaA' : 'mediaB', kind, status, finishedAt, finishedAt);
}
function classify(db: Db, o: { account?: string; media?: string; comment: string; automation?: string; scan: string; result?: string; text?: string; user?: string; at?: string; kw?: string[] }) {
  const account = o.account ?? 'accountA'; const media = o.media ?? 'mediaA';
  if (!db.prepare(`SELECT 1 FROM comments WHERE account_id=? AND comment_id=?`).get(account, o.comment)) {
    createComment(db, { accountId: account, mediaId: media, commentId: o.comment, text: o.text ?? 'quiero la guía', username: o.user ?? 'cliente', createdAt: o.at ?? FRESH });
  }
  db.prepare(`INSERT OR REPLACE INTO comment_classifications(account_id,comment_id,automation_id,result,reason,matched_keywords_json,observed_at,scan_id) VALUES (?,?,?,?,?,?,?,?)`)
    .run(account, o.comment, o.automation ?? 'autoA', o.result ?? 'eligible', o.result ?? 'eligible', JSON.stringify(o.kw ?? ['guía']), '2026-10-06T11:00:00Z', o.scan);
}
async function get(origin: string, path: string) {
  return new Promise<{ status: number; body: any; raw: string }>((resolve, reject) => {
    request(new URL(path, origin), (res) => { let raw = ''; res.setEncoding('utf8'); res.on('data', (c) => { raw += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, raw, body: raw ? JSON.parse(raw) : null })); }).on('error', reject).end();
  });
}

test('pending list requires a valid owned account and is account scoped', async () => {
  await withEnv(async ({ db, origin }) => {
    scan(db, 's1', 'accountA', 'backlog', 'complete');
    classify(db, { comment: 'c1', scan: 's1' });
    assert.equal((await get(origin, '/api/backlog/pending')).status, 400);
    assert.equal((await get(origin, '/api/backlog/pending?accountId=all')).status, 404);
    assert.equal((await get(origin, '/api/backlog/pending?accountId=nope')).status, 404);
    assert.equal((await get(origin, '/api/backlog/pending?accountId=bad%20id!')).status, 400);
    const other = await get(origin, '/api/backlog/pending?accountId=accountB');
    assert.equal(other.status, 200); assert.equal(other.body.total, 0); assert.deepEqual(other.body.items, []);
    const own = await get(origin, '/api/backlog/pending?accountId=accountA');
    assert.equal(own.body.total, 1); assert.equal(own.body.items[0].commentId, 'c1');
    assert.equal(own.body.items[0].accountId, 'accountA');
  });
});

test('pending list returns only eligible rows from complete backlog/catch_up scans', async () => {
  await withEnv(async ({ db, origin }) => {
    scan(db, 'ok-b', 'accountA', 'backlog', 'complete'); scan(db, 'ok-c', 'accountA', 'catch_up', 'complete');
    scan(db, 'mon', 'accountA', 'monitor', 'complete'); scan(db, 'inc', 'accountA', 'backlog', 'incomplete'); scan(db, 'can', 'accountA', 'backlog', 'cancelled');
    classify(db, { comment: 'good1', scan: 'ok-b' }); classify(db, { comment: 'good2', scan: 'ok-c' });
    classify(db, { comment: 'monitor', scan: 'mon' }); classify(db, { comment: 'incomplete', scan: 'inc' }); classify(db, { comment: 'cancelled', scan: 'can' });
    classify(db, { comment: 'review', scan: 'ok-b', result: 'review' }); classify(db, { comment: 'nomatch', scan: 'ok-b', result: 'ineligible' });
    const ids = (await get(origin, '/api/backlog/pending?accountId=accountA')).body.items.map((i: any) => i.commentId).sort();
    assert.deepEqual(ids, ['good1', 'good2']);
  });
});

test('pending list excludes queued, expired (server clock), and archived automations', async () => {
  await withEnv(async ({ db, origin }) => {
    scan(db, 's1', 'accountA', 'backlog', 'complete');
    classify(db, { comment: 'open', scan: 's1' }); classify(db, { comment: 'queued', scan: 's1' }); classify(db, { comment: 'old', scan: 's1', at: STALE });
    db.prepare(`INSERT INTO queue_items(queue_item_id,account_id,comment_id,automation_id,state,dry_run,payload_json,created_at,updated_at)
      VALUES ('q1','accountA','queued','autoA','SIMULATED',1,'{}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
    db.prepare(`INSERT INTO automations(automation_id,account_id,media_id,name,status,match_mode,reply_text,created_at,updated_at)
      VALUES ('autoOld','accountA','mediaA','Vieja (archived)','disabled','contains','Hi',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
    classify(db, { comment: 'archivedOnly', scan: 's1', automation: 'autoOld' });
    const body = (await get(origin, '/api/backlog/pending?accountId=accountA')).body;
    assert.deepEqual(body.items.map((i: any) => i.commentId), ['open']);
    assert.equal(body.total, 1);
  });
});

test('pending list paginates with defaults, caps, and a total; lastAnalyzedAt is the latest complete scan', async () => {
  await withEnv(async ({ db, origin }) => {
    scan(db, 's1', 'accountA', 'backlog', 'complete', '2026-10-06T10:00:00Z'); scan(db, 's2', 'accountA', 'catch_up', 'complete', '2026-10-06T11:30:00Z');
    scan(db, 's3', 'accountA', 'backlog', 'incomplete', '2026-10-06T11:59:00Z');
    for (let i = 0; i < 5; i++) classify(db, { comment: `c${i}`, scan: 's1', at: `2026-10-05T0${i}:00:00Z` });
    const page = (await get(origin, '/api/backlog/pending?accountId=accountA&limit=2&offset=1')).body;
    assert.equal(page.total, 5); assert.equal(page.limit, 2); assert.equal(page.offset, 1); assert.equal(page.items.length, 2);
    assert.equal(page.lastAnalyzedAt, '2026-10-06T11:30:00Z');
    const dflt = (await get(origin, '/api/backlog/pending?accountId=accountA')).body;
    assert.equal(dflt.limit, 50); assert.equal(dflt.items.length, 5);
    assert.equal((await get(origin, '/api/backlog/pending?accountId=accountA&limit=9999')).body.limit, 200);
    const empty = (await get(origin, '/api/backlog/pending?accountId=accountB')).body;
    assert.equal(empty.lastAnalyzedAt, null);
  });
});

test('pending DTO renders the preview, truncates the comment, and exposes no secrets', async () => {
  await withEnv(async ({ db, origin }) => {
    scan(db, 's1', 'accountA', 'backlog', 'complete');
    classify(db, { comment: 'c1', scan: 's1', text: `quiero la guía ${'x'.repeat(400)}`, user: 'maria' });
    const response = await get(origin, '/api/backlog/pending?accountId=accountA');
    const item = response.body.items[0];
    assert.deepEqual(Object.keys(item).sort(), ['accountId', 'analyzedAt', 'automationId', 'automationName', 'commentCreatedAt', 'commentId', 'commentText', 'matchedKeywords', 'mediaCaption', 'mediaId', 'mediaPublishedAt', 'mediaType', 'previewButtons', 'previewText', 'scope', 'username']);
    assert.equal(item.username, 'maria'); assert.equal(item.automationName, 'Guía'); assert.equal(item.mediaId, 'mediaA');
    assert.ok(item.commentText.length <= 281 && item.commentText.endsWith('…'));
    assert.deepEqual(item.matchedKeywords, ['guía']); assert.equal(item.analyzedAt, '2026-10-06T11:00:00Z'); assert.equal(item.commentCreatedAt, FRESH);
    assert.ok(item.previewText.startsWith('Hola maria, vi "quiero la guía x'));
    assert.ok(item.previewText.includes('(guía) en alpha https://www.instagram.com/p/A/'));
    assert.deepEqual(item.previewButtons, [{ title: 'Ver guía', url: 'https://example.com/g' }]);
    for (const secret of ['secret-nonce', 'secret-cipher', 'secret-tag', 'token', 'payload_json']) assert.equal(response.raw.includes(secret), false, secret);
  });
});

test('queue DTO exposes commenter username and truncated comment text only', async () => {
  await withEnv(async ({ db, origin }) => {
    createComment(db, { accountId: 'accountA', mediaId: 'mediaA', commentId: 'cq', text: 'y'.repeat(500), username: 'pedro', createdAt: FRESH });
    db.prepare(`INSERT INTO queue_items(queue_item_id,account_id,comment_id,automation_id,state,dry_run,payload_json,created_at,updated_at)
      VALUES ('q1','accountA','cq','autoA','SIMULATED',1,'{"text":"Hola pedro","buttons":[{"title":"Ver","url":"https://example.com"}],"secret":"no"}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
    const item = (await get(origin, '/api/queue?accountId=accountA')).body.items[0];
    assert.equal(item.commentUsername, 'pedro'); assert.equal(item.commentText.length, 281);
    assert.deepEqual(item.payload, { text: 'Hola pedro', buttons: [{ title: 'Ver', url: 'https://example.com' }] });
    assert.equal(JSON.stringify(item).includes('"secret"'), false);
  });
});

test('truncateText bounds length and handles empty values', () => {
  assert.equal(truncateText('abc', 5), 'abc'); assert.equal(truncateText('abcdef', 3), 'abc…');
  assert.equal(truncateText(null, 5), ''); assert.equal(truncateText('  a   b ', 10), 'a b');
});

test('autoPickAutomation picks only a single enabled automation for the account', () => {
  const rows = [
    { automationId: 'a1', accountId: 'x', status: 'enabled' }, { automationId: 'a2', accountId: 'x', status: 'disabled' },
    { automationId: 'b1', accountId: 'y', status: 'enabled' }, { automationId: 'b2', accountId: 'y', status: 'enabled' },
  ];
  assert.equal(autoPickAutomation(rows, 'x', ''), 'a1');
  assert.equal(autoPickAutomation(rows, 'y', ''), '');
  assert.equal(autoPickAutomation(rows, 'y', 'b2'), 'b2');
  assert.equal(autoPickAutomation(rows, 'y', 'a1'), '');
  assert.equal(autoPickAutomation(rows, '', ''), '');
  assert.equal(autoPickAutomation(rows, 'x', 'a1'), 'a1');
});

test('describeQueuePayload labels simulated items WOULD_SEND and keeps real states as sent/attempted', () => {
  const payload = { text: 'Hola', buttons: [{ title: 'Ver', url: 'https://example.com' }] };
  const sim = describeQueuePayload({ state: 'SIMULATED', payload });
  assert.equal(sim.label, 'WOULD_SEND · No se envió (modo prueba)'); assert.equal(sim.text, 'Hola'); assert.deepEqual(sim.buttons, payload.buttons);
  assert.equal(describeQueuePayload({ state: 'SENT', payload }).label, 'Mensaje enviado');
  assert.equal(describeQueuePayload({ state: 'FAILED_PERMANENT', payload }).label, 'Mensaje intentado');
  assert.equal(describeQueuePayload({ state: 'QUEUED', payload }).label, 'Mensaje pendiente de envío');
  assert.equal(describeQueuePayload({ state: 'SIMULATED', payload: undefined }).text, '');
});
