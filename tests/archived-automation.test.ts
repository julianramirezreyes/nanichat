import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { AutomationService } from '../src/services/automations.ts';
import { listPendingReview } from '../src/services/pending-review.ts';
import { QueueService } from '../src/services/queue.ts';

type Db = ReturnType<typeof openDatabase>;
const NOW = Date.now();
const FRESH = new Date(NOW - 60_000).toISOString();

function withDb(run: (db: Db) => void | Promise<void>): Promise<void> | void {
  const directory = mkdtempSync(join(tmpdir(), 'archived-automation-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  const done = () => { db.close(); rmSync(directory, { recursive: true, force: true }); };
  try {
    const result = run(db);
    if (result) return result.finally(done);
  } catch (error) { done(); throw error; }
  done();
}

function seedAccount(db: Db, suffix: string) {
  createConnection(db, { id: `conn${suffix}`, name: 'c', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
    status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
  addDiscoveredAccount(db, { accountId: `acc${suffix}`, connectionId: `conn${suffix}`, providerAccountId: `p${suffix}`, username: `brand${suffix}`, status: 'valid' });
  createMedia(db, { accountId: `acc${suffix}`, mediaId: `media${suffix}`, permalink: null, publishedAt: null });
  return { accountId: `acc${suffix}`, mediaId: `media${suffix}` };
}

function addAutomation(db: Db, ctx: { accountId: string; mediaId: string }, name: string): string {
  const service = new AutomationService(db);
  const id = service.create({ accountId: ctx.accountId, mediaId: ctx.mediaId, name, replyText: 'Hi {{username}}' });
  service.addKeyword(ctx.accountId, id, 'guide');
  service.setEnabled(ctx.accountId, id, true);
  return id;
}

function classifyEligible(db: Db, accountId: string, commentId: string, automationId: string) {
  db.prepare(`INSERT OR IGNORE INTO scan_runs(scan_id,account_id,media_id,scan_kind,status,started_at,finished_at)
    VALUES (?,?,?,'backlog','complete',?,?)`).run(`scan-${accountId}`, accountId, `media${accountId.slice(3)}`, FRESH, FRESH);
  db.prepare(`INSERT OR REPLACE INTO comment_classifications(account_id,comment_id,automation_id,result,reason,matched_keywords_json,observed_at,scan_id)
    VALUES (?,?,?,'eligible','eligible','["guide"]',?,?)`).run(accountId, commentId, automationId, FRESH, `scan-${accountId}`);
}

function archive(db: Db, accountId: string, automationId: string) {
  db.prepare(`UPDATE automations SET name=name || ' (archived)', status='disabled' WHERE account_id=? AND automation_id=?`).run(accountId, automationId);
}

const queue = (db: Db) => new QueueService(db, {} as never);
const queued = (db: Db) => (db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }).n;

function twoAutomations(db: Db) {
  const ctx = seedAccount(db, '1');
  createComment(db, { accountId: ctx.accountId, mediaId: ctx.mediaId, commentId: 'c1', text: 'guide', username: 'customer', createdAt: FRESH });
  const a = addAutomation(db, ctx, 'A');
  const b = addAutomation(db, ctx, 'B');
  classifyEligible(db, ctx.accountId, 'c1', a);
  classifyEligible(db, ctx.accountId, 'c1', b);
  return { ...ctx, a, b };
}

test('stale eligible row of an archived automation does not block the target automation', async () => {
  await withDb(async (db) => {
    const { accountId, a, b } = twoAutomations(db);
    archive(db, accountId, a);
    assert.deepEqual(await queue(db).enqueueReviewed(accountId, b, ['c1']), ['c1']);
    assert.equal(queued(db), 1);
  });
});

test('stale eligible row of a paused automation does not block the target automation', async () => {
  await withDb(async (db) => {
    const { accountId, a, b } = twoAutomations(db);
    new AutomationService(db).setEnabled(accountId, a, false);
    assert.deepEqual(await queue(db).enqueueReviewed(accountId, b, ['c1']), ['c1']);
  });
});

test('stale eligible row of a deleted automation does not block the target automation', async () => {
  await withDb(async (db) => {
    const { accountId, a, b } = twoAutomations(db);
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare(`DELETE FROM automations WHERE account_id=? AND automation_id=?`).run(accountId, a);
    assert.deepEqual(await queue(db).enqueueReviewed(accountId, b, ['c1']), ['c1']);
  });
});

test('two enabled non-archived automations eligible on the same comment still require review', async () => {
  await withDb(async (db) => {
    const { accountId, b } = twoAutomations(db);
    await assert.rejects(queue(db).enqueueReviewed(accountId, b, ['c1']), /multiple automations/);
    assert.equal(queued(db), 0);
  });
});

test('another account enabled automation with the same comment id does not block', async () => {
  await withDb(async (db) => {
    const { accountId, b } = twoAutomations(db);
    const other = seedAccount(db, '2');
    createComment(db, { accountId: other.accountId, mediaId: other.mediaId, commentId: 'c1', text: 'guide', username: 'customer', createdAt: FRESH });
    const o = addAutomation(db, other, 'O');
    classifyEligible(db, other.accountId, 'c1', o);
    // Same comment id, other account: only the target account's own rows are relevant.
    db.prepare(`DELETE FROM comment_classifications WHERE account_id=? AND automation_id<>?`).run(accountId, b);
    assert.deepEqual(await queue(db).enqueueReviewed(accountId, b, ['c1']), ['c1']);
  });
});

test('pending list omits archived and paused automations and lists a comment once', async () => {
  await withDb((db) => {
    const { accountId, a, b } = twoAutomations(db);
    archive(db, accountId, a);
    let pending = listPendingReview(db, accountId, { limit: 50, offset: 0, now: NOW });
    assert.deepEqual(pending.items.map((i) => [i.commentId, i.automationId]), [['c1', b]]);
    // Paused (not archived) other automation: still listed only once.
    db.prepare(`UPDATE automations SET name='A', status='disabled' WHERE automation_id=?`).run(a);
    pending = listPendingReview(db, accountId, { limit: 50, offset: 0, now: NOW });
    assert.equal(pending.total, 1);
    assert.deepEqual(pending.items.map((i) => i.automationId), [b]);
  });
});
