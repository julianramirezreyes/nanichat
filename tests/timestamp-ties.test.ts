import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { AutomationService } from '../src/services/automations.ts';
import { QueueService } from '../src/services/queue.ts';
import { removeTempDir } from './helpers/tmp.ts';

// Rows written in the same millisecond share an ISO timestamp (common on Windows' coarse timer and in tight batch
// loops). Every ordering by timestamp must break ties by insertion order (rowid), never by a random UUID.

type Db = ReturnType<typeof openDatabase>;
const STAMP = '2026-01-01T00:00:00.000Z';

async function withDb(run: (db: Db) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'timestamp-ties-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  try { await run(db); } finally { db.close(); removeTempDir(directory); }
}

function seed(db: Db): string {
  createConnection(db, { id: 'conn', name: 'c', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
    status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
  addDiscoveredAccount(db, { accountId: 'acc', connectionId: 'conn', providerAccountId: 'p', username: 'brand', status: 'valid' });
  db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='conn'`).run();
  db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='acc'`).run();
  createMedia(db, { accountId: 'acc', mediaId: 'm', permalink: null, publishedAt: null });
  const service = new AutomationService(db);
  const id = service.create({ accountId: 'acc', mediaId: 'm', name: 'Auto', replyText: 'Hola {{username}}' });
  service.addKeyword('acc', id, 'guide');
  service.setEnabled('acc', id, true);
  service.setRealEnabled('acc', id, true, true);
  return id;
}

function provider() {
  return {
    async getComment(_account: unknown, commentId: string) {
      return { commentId, text: 'quiero la guide', username: 'customer', createdAt: new Date(Date.now() - 60_000).toISOString() };
    },
    async sendPrivateReply() { return { outcome: 'accepted' as const, messageId: `msg-${Math.random()}` }; },
    async readMessage(_account: unknown, messageId: string) { return { messageId, observedAt: new Date().toISOString() }; },
  };
}

/** Enqueues c0..c(n-1) in one batch, then pins a shared created_at and ids that sort in reverse insertion order. */
async function enqueueTiedBatch(db: Db, queue: QueueService, automationId: string, count: number): Promise<void> {
  const ids = Array.from({ length: count }, (_, index) => `c${index}`);
  for (const id of ids) {
    createComment(db, { accountId: 'acc', mediaId: 'm', commentId: id, text: 'quiero la guide', username: 'customer',
      createdAt: new Date(Date.now() - 60_000).toISOString() });
  }
  assert.equal((await queue.enqueueReviewed('acc', automationId, ids)).length, count);
  for (const [index, id] of ids.entries()) {
    db.prepare(`UPDATE queue_items SET created_at=?, queue_item_id=? WHERE comment_id=?`).run(STAMP, `q-${count - index}`, id);
  }
}

test('batch-enqueued items with an identical created_at are sent in insertion order (FIFO)', async () => {
  await withDb(async (db) => {
    const automationId = seed(db);
    const queue = new QueueService(db, provider() as never, { sendSpacingMs: 0 } as never);
    queue.setDryRun(false, true);
    await enqueueTiedBatch(db, queue, automationId, 4);
    const sent: string[] = [];
    for (let index = 0; index < 4; index++) {
      await queue.processOne('acc');
      const rows = db.prepare(`SELECT comment_id FROM queue_items WHERE state='SENT' ORDER BY updated_at, rowid`).all() as Array<{ comment_id: string }>;
      sent.push(rows.map((row) => row.comment_id).find((id) => !sent.includes(id))!);
    }
    assert.deepEqual(sent, ['c0', 'c1', 'c2', 'c3']);
  });
});

async function withApi(run: (db: Db, get: (path: string) => Promise<any>) => Promise<void>): Promise<void> {
  await withDb(async (db) => {
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', automations: new AutomationService(db) });
    const server = createServer((req, res) => { void handler(req, res); });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const get = (path: string) => new Promise<any>((resolve, reject) => {
      const req = request(new URL(path, origin), { method: 'GET', headers: { connection: 'close' } }, (res) => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve(raw ? JSON.parse(raw) : null));
      });
      req.on('error', reject);
      req.end();
    });
    try { await run(db, get); } finally { server.closeAllConnections(); server.close(); }
  });
}

function insertEvent(db: Db, eventId: string, queueItemId: string, type: string, code: string | null): void {
  db.prepare(`INSERT INTO send_attempts (attempt_event_id, account_id, queue_item_id, event_type, event_at, message_id, safe_error_code, details_json)
    VALUES (?, 'acc', ?, ?, ?, NULL, ?, '{}')`).run(eventId, queueItemId, type, STAMP, code);
}

test('attempt timeline and latest error code break identical event_at ties by insertion order', async () => {
  await withApi(async (db, get) => {
    const automationId = seed(db);
    const queue = new QueueService(db, provider() as never, { sendSpacingMs: 0 } as never);
    await enqueueTiedBatch(db, queue, automationId, 1);
    // Ids sort in reverse of the insertion order, so a UUID/id tiebreak would scramble the timeline.
    insertEvent(db, 'z-intent', 'q-1', 'intent_recorded', null);
    insertEvent(db, 'y-retry', 'q-1', 'retryable_failure', 'first_error');
    insertEvent(db, 'x-retry', 'q-1', 'retryable_failure', 'latest_error');
    db.prepare(`UPDATE queue_items SET state='FAILED_RETRYABLE' WHERE queue_item_id='q-1'`).run();
    const timeline = await get('/api/queue/q-1/attempts?accountId=acc');
    assert.deepEqual(timeline.events.map((event: { safeErrorCode: string | null }) => event.safeErrorCode), [null, 'first_error', 'latest_error']);
    const page = await get('/api/queue?accountId=acc');
    assert.equal(page.items[0].safeErrorCode, 'latest_error');
  });
});

test('queue pages stay stable when items share created_at: newest inserted first, no duplicates or gaps', async () => {
  await withApi(async (db, get) => {
    const automationId = seed(db);
    const queue = new QueueService(db, provider() as never, {} as never);
    await enqueueTiedBatch(db, queue, automationId, 5);
    const seen: string[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const page = await get(`/api/queue?accountId=acc&limit=2&offset=${offset}`);
      seen.push(...page.items.map((item: { commentId: string }) => item.commentId));
    }
    assert.deepEqual(seen, ['c4', 'c3', 'c2', 'c1', 'c0']);
  });
});
