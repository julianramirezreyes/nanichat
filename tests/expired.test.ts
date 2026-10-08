import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { AutomationService } from '../src/services/automations.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { Scheduler } from '../src/services/scheduler.ts';

type Db = ReturnType<typeof openDatabase>;
const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 7 * DAY;

async function withDatabase(run: (db: Db) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'social-automation-expired-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  try { await run(db); } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}

function seed(db: Db, suffix = '') {
  const id = (name: string) => `${name}${suffix}`;
  createConnection(db, {
    id: id('conn'), name: 'test', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
    status: 'valid', accessToken: { nonce: 'fixture-nonce', ciphertext: 'fixture-ciphertext', tag: 'fixture-tag' },
  });
  addDiscoveredAccount(db, {
    accountId: id('account'), connectionId: id('conn'), providerAccountId: id('provider'), username: `brand${suffix}`, status: 'valid',
  });
  createMedia(db, { accountId: id('account'), mediaId: id('media'), permalink: null, publishedAt: null });
  db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id=?`).run(id('conn'));
  db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id=?`).run(id('account'));
  const automations = new AutomationService(db);
  const automationId = automations.create({ accountId: id('account'), mediaId: id('media'), name: 'auto', replyText: 'Hi {{username}}' });
  automations.addKeyword(id('account'), automationId, 'guide');
  automations.setEnabled(id('account'), automationId, true);
  automations.setRealEnabled(id('account'), automationId, true, true);
  return { accountId: id('account'), mediaId: id('media'), automationId };
}

function addItem(db: Db, ctx: { accountId: string; mediaId: string; automationId: string }, commentId: string, state: string, createdAt: string) {
  createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId, text: 'guide', username: 'customer', createdAt });
  db.prepare(`INSERT INTO queue_items(queue_item_id,account_id,comment_id,automation_id,state,dry_run,payload_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .run(`q-${commentId}`, ctx.accountId, commentId, ctx.automationId, state, state === 'SIMULATED' ? 1 : 0,
      JSON.stringify({ text: 'Hi', buttons: [], automation_version: (db.prepare(`SELECT version FROM automations WHERE automation_id=?`).get(ctx.automationId) as { version: number }).version }));
}

const stateOf = (db: Db, commentId: string) =>
  (db.prepare(`SELECT state FROM queue_items WHERE comment_id=?`).get(commentId) as { state: string }).state;

function recordingProvider(createdAtFor: (commentId: string) => string, send?: () => unknown) {
  const calls = { send: 0 };
  const provider = {
    async getComment(_account: unknown, commentId: string) {
      return { commentId, text: 'guide', username: 'customer', createdAt: createdAtFor(commentId) };
    },
    async sendPrivateReply() {
      calls.send++;
      return send ? send() : { outcome: 'accepted' as const, messageId: 'msg' };
    },
    async readMessage(_account: unknown, messageId: string) { return { messageId, observedAt: new Date().toISOString() }; },
  } as never;
  return { provider, calls };
}

test('pre-send gate expires a comment at exactly seven days without intent or POST', async () => {
  await withDatabase(async (db) => {
    const ctx = seed(db);
    const clock = Date.now();
    const created = new Date(clock - WINDOW).toISOString();
    addItem(db, ctx, 'old', 'QUEUED', created);
    const { provider, calls } = recordingProvider(() => created);
    const queue = new QueueService(db, provider, { sendSpacingMs: 0, clock: () => clock });
    queue.setDryRun(false, true);
    assert.equal(await queue.processOne(ctx.accountId), 'q-old');
    assert.equal(stateOf(db, 'old'), 'EXPIRED');
    assert.equal(calls.send, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM send_attempts`).get() as { n: number }).n, 0);
    const row = db.prepare(`SELECT attempt_count, state_reason_code FROM queue_items WHERE comment_id='old'`).get() as { attempt_count: number; state_reason_code: string };
    assert.equal(row.attempt_count, 0);
    assert.equal(row.state_reason_code, 'private_reply_window_elapsed');
  });
});

test('pre-send gate does not expire a comment one second under seven days', async () => {
  await withDatabase(async (db) => {
    const ctx = seed(db);
    const clock = Date.now();
    const created = new Date(clock - WINDOW + 1000).toISOString();
    addItem(db, ctx, 'young', 'QUEUED', created);
    const { provider, calls } = recordingProvider(() => created);
    const queue = new QueueService(db, provider, { sendSpacingMs: 0, clock: () => clock });
    queue.setDryRun(false, true);
    await queue.processOne(ctx.accountId);
    assert.equal(calls.send, 1);
    assert.equal(stateOf(db, 'young'), 'SENT');
  });
});

test('expireStale only moves unsent states past the window, is idempotent, and is account scoped', async () => {
  await withDatabase(async (db) => {
    const a = seed(db, '-a');
    const b = seed(db, '-b');
    const clock = Date.now();
    const old = new Date(clock - WINDOW - DAY).toISOString();
    const states = ['QUEUED', 'FAILED_RETRYABLE', 'SIMULATED', 'SENT', 'SENDING', 'SEND_INTENT_RECORDED', 'UNKNOWN_OUTCOME', 'FAILED_PERMANENT'];
    // Only one SENDING item may exist at a time in real flows; the sweep must still never touch it.
    states.forEach((state) => addItem(db, a, `a-${state}`, state, old));
    addItem(db, a, 'a-fresh', 'QUEUED', new Date(clock - DAY).toISOString());
    addItem(db, b, 'b-QUEUED', 'QUEUED', old);
    const queue = new QueueService(db, {} as never, { clock: () => clock });

    assert.equal(queue.expireStale(a.accountId), 3);
    assert.equal(stateOf(db, 'a-QUEUED'), 'EXPIRED');
    assert.equal(stateOf(db, 'a-FAILED_RETRYABLE'), 'EXPIRED');
    assert.equal(stateOf(db, 'a-SIMULATED'), 'EXPIRED');
    for (const state of ['SENT', 'SENDING', 'SEND_INTENT_RECORDED', 'UNKNOWN_OUTCOME', 'FAILED_PERMANENT']) {
      assert.equal(stateOf(db, `a-${state}`), state);
    }
    assert.equal(stateOf(db, 'a-fresh'), 'QUEUED');
    assert.equal(stateOf(db, 'b-QUEUED'), 'QUEUED');
    assert.equal(queue.expireStale(a.accountId), 0);

    assert.equal(queue.expireStale(), 1);
    assert.equal(stateOf(db, 'b-QUEUED'), 'EXPIRED');
    assert.equal(queue.expireStale(), 0);
  });
});

test('a retry that would fall after the window expires instead of retrying', async () => {
  await withDatabase(async (db) => {
    const ctx = seed(db);
    const clock = Date.now();
    const created = new Date(clock - WINDOW + 5000).toISOString();
    addItem(db, ctx, 'late', 'QUEUED', created);
    const { provider, calls } = recordingProvider(() => created,
      () => ({ outcome: 'definitive_rejection' as const, httpStatus: 429, safeErrorCode: 'meta_rate_limited', usageHeaders: { retryAfter: '30' } }));
    const queue = new QueueService(db, provider, { sendSpacingMs: 0, clock: () => clock });
    queue.setDryRun(false, true);
    await queue.processOne(ctx.accountId);
    assert.equal(calls.send, 1);
    const row = db.prepare(`SELECT state, next_attempt_at FROM queue_items WHERE comment_id='late'`).get() as { state: string; next_attempt_at: string | null };
    assert.equal(row.state, 'EXPIRED');
    assert.equal(row.next_attempt_at, null);
    const events = db.prepare(`SELECT event_type FROM send_attempts`).all() as Array<{ event_type: string }>;
    assert.deepEqual(events.map((event) => event.event_type).sort(), ['intent_recorded', 'retryable_failure']);
  });
});

test('scheduler startup recovery sweeps expired simulated items', async () => {
  await withDatabase(async (db) => {
    const ctx = seed(db);
    addItem(db, ctx, 'sim-old', 'SIMULATED', new Date(Date.now() - WINDOW - DAY).toISOString());
    const queue = new QueueService(db, {} as never);
    new Scheduler(db, new Scanner(db, {} as never), queue);
    assert.equal(stateOf(db, 'sim-old'), 'EXPIRED');
  });
});

test('dashboard counts and queue filter expose EXPIRED items with a safe reason', async () => {
  await withDatabase(async (db) => {
    const ctx = seed(db);
    addItem(db, ctx, 'dash-old', 'QUEUED', new Date(Date.now() - WINDOW - DAY).toISOString());
    new QueueService(db, {} as never).expireStale();
    const server = createServer((req, res) => { void createApiHandler({ database: db })(req, res); });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const get = (path: string) => new Promise<string>((resolve, reject) => {
      request(new URL(path, `http://127.0.0.1:${address.port}`), (res) => {
        let body = ''; res.setEncoding('utf8'); res.on('data', (c) => { body += c; }); res.on('end', () => resolve(body));
      }).on('error', reject).end();
    });
    try {
      const dashboard = JSON.parse(await get(`/api/dashboard?accountId=${ctx.accountId}`));
      assert.deepEqual(dashboard.queue, [{ state: 'EXPIRED', count: 1 }]);
      const queue = JSON.parse(await get(`/api/queue?accountId=${ctx.accountId}&state=EXPIRED`));
      assert.equal(queue.total, 1);
      assert.equal(queue.items[0].state, 'EXPIRED');
      assert.equal(queue.items[0].safeErrorCode, 'private_reply_window_elapsed');
    } finally { server.close(); }
  });
});

test('scan report counts expired comments separately from other ineligible reasons', async () => {
  await withDatabase(async (db) => {
    const ctx = seed(db);
    const now = Date.now();
    const provider = { async listComments() {
      return { items: [
        { commentId: 'ok', text: 'guide', username: 'a', createdAt: new Date(now - 1000).toISOString() },
        { commentId: 'old-1', text: 'guide', username: 'b', createdAt: new Date(now - WINDOW - DAY).toISOString() },
        { commentId: 'old-2', text: 'nothing', username: 'c', createdAt: new Date(now - WINDOW).toISOString() },
        { commentId: 'nomatch', text: 'nothing', username: 'd', createdAt: new Date(now - 1000).toISOString() },
      ], complete: true };
    } } as never;
    const account = { accountId: ctx.accountId, connectionId: 'conn', providerAccountId: 'provider', username: 'brand' };
    const report = await new Scanner(db, provider).scanMedia(account, ctx.mediaId, {
      kind: 'backlog', cutoffAt: new Date(now - 30 * DAY).toISOString(), untilAt: new Date(now).toISOString(), now,
    });
    assert.equal(report.expiredCount, 2);
    assert.equal(report.candidates.find((c) => c.commentId === 'old-1')?.reason, 'expired');
  });
});
