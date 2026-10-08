import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { AutomationService, classifyComment } from '../src/services/automations.ts';
import { BacklogService } from '../src/services/backlog.ts';
import { listPendingReview } from '../src/services/pending-review.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { reasonLabel, summarizeScan } from '../app/scan-summary.ts';

type Db = ReturnType<typeof openDatabase>;
const NOW = Date.parse('2026-10-06T12:00:00Z');
const FRESH = '2026-10-06T11:00:00Z';
const ROOT = { commentId: 'root', text: 'guide please', username: 'customer', createdAt: FRESH };
const account = { accountId: 'account', connectionId: 'conn', providerAccountId: 'provider-account', username: 'brand' };

async function withDb(run: (db: Db) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'owner-replied-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  try { await run(db); } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}

function seed(db: Db): string {
  createConnection(db, { id: 'conn', name: 't', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
  addDiscoveredAccount(db, { accountId: 'account', connectionId: 'conn', providerAccountId: 'provider-account', username: 'brand', status: 'valid' });
  createMedia(db, { accountId: 'account', mediaId: 'media', permalink: null, publishedAt: null });
  const automations = new AutomationService(db);
  const id = automations.create({ accountId: 'account', mediaId: 'media', name: 'lead', replyText: 'Hi {{username}}' });
  automations.addKeyword('account', id, 'guide');
  automations.setEnabled('account', id, true);
  return id;
}

function seedSecondAccount(db: Db): void {
  createConnection(db, { id: 'conn2', name: 't2', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
  addDiscoveredAccount(db, { accountId: 'account2', connectionId: 'conn2', providerAccountId: 'provider-2', username: 'other', status: 'valid' });
  createMedia(db, { accountId: 'account2', mediaId: 'media2', permalink: null, publishedAt: null });
}

function storeReply(db: Db, username: string, opts: { accountId?: string; mediaId?: string; parentId?: string; commentId?: string } = {}): void {
  createComment(db, {
    accountId: opts.accountId ?? 'account', mediaId: opts.mediaId ?? 'media', commentId: opts.commentId ?? `reply-${username}`,
    text: 'Listo! Te envié un mensaje!', username, createdAt: FRESH, parentId: opts.parentId ?? 'root',
  });
}

function pages(...items: Array<Array<Record<string, unknown>>>) {
  let index = 0;
  return { async listComments() {
    const page = items[Math.min(index++, items.length - 1)]!;
    const last = index >= items.length;
    return { items: page, complete: last, nextCursor: last ? undefined : `cursor-${index}` };
  } } as never;
}
const scanOptions = { kind: 'backlog' as const, cutoffAt: '2026-10-05T00:00:00Z', now: NOW };
const classificationOf = (db: Db, commentId: string, accountId = 'account') => {
  const row = db.prepare(
  `SELECT result, reason FROM comment_classifications WHERE account_id=? AND comment_id=?`).get(accountId, commentId);
  return row ? { result: row.result as string, reason: row.reason as string } : undefined;
};
const REPLY = { commentId: 'r1', text: 'Listo! Te envié un mensaje!', username: 'brand', createdAt: FRESH, parentId: 'root' };

test('classifyComment: owner reply blocks only otherwise-eligible roots and keeps earlier gates first', () => {
  const base = { commentId: 'c', text: 'guide', username: 'customer', createdAt: FRESH };
  assert.equal(classifyComment(base, ['guide'], 'brand', NOW, 'contains', true).reason, 'owner_replied');
  assert.equal(classifyComment(base, ['guide'], 'brand', NOW, 'contains', true).eligible, false);
  assert.equal(classifyComment(base, ['guide'], 'brand', NOW, 'contains', false).eligible, true);
  assert.equal(classifyComment({ ...base, createdAt: '2026-09-01T00:00:00Z' }, ['guide'], 'brand', NOW, 'contains', true).reason, 'expired');
  assert.equal(classifyComment({ ...base, text: 'nothing' }, ['guide'], 'brand', NOW, 'contains', true).reason, 'no_keyword_match');
});

for (const order of ['root-first', 'reply-first'] as const) {
  test(`scanner: owner reply in the same scan blocks the root (${order})`, async () => {
    await withDb(async (db) => {
      seed(db);
      const provider = order === 'root-first' ? pages([ROOT], [REPLY]) : pages([REPLY], [ROOT]);
      const report = await new Scanner(db, provider).scanMedia(account, 'media', scanOptions);
      assert.equal(report.status, 'complete');
      assert.deepEqual(classificationOf(db, 'root'), { result: 'review', reason: 'owner_replied' });
      const candidate = report.candidates.find((item) => item.commentId === 'root');
      assert.equal(candidate?.eligible, false);
      assert.equal(candidate?.reason, 'owner_replied');
    });
  });
}

test('scanner: an owner reply discovered in a later scan reclassifies a previously eligible root', async () => {
  await withDb(async (db) => {
    seed(db);
    await new Scanner(db, pages([ROOT])).scanMedia(account, 'media', scanOptions);
    assert.equal(classificationOf(db, 'root')?.result, 'eligible');
    await new Scanner(db, pages([ROOT, { ...REPLY, username: 'BRAND' }])).scanMedia(account, 'media', scanOptions);
    assert.deepEqual(classificationOf(db, 'root'), { result: 'review', reason: 'owner_replied' }); // case-insensitive
  });
});

test('scanner: replies by other users do not block', async () => {
  await withDb(async (db) => {
    seed(db);
    await new Scanner(db, pages([ROOT, { ...REPLY, username: 'someone_else' }])).scanMedia(account, 'media', scanOptions);
    assert.equal(classificationOf(db, 'root')?.result, 'eligible');
  });
});

test('account isolation: another account storing a reply by this username does not block', async () => {
  await withDb(async (db) => {
    const automationId = seed(db);
    seedSecondAccount(db);
    createComment(db, { accountId: 'account2', mediaId: 'media2', commentId: 'root', text: 'x', username: 'someone', createdAt: FRESH });
    storeReply(db, 'brand', { accountId: 'account2', mediaId: 'media2', commentId: 'r-other' });
    // account2's username is 'other', so a reply by 'brand' there must not block account2 either.
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'root', text: 'guide', username: 'customer', createdAt: FRESH });
    const queue = new QueueService(db, {} as never, { clock: () => NOW });
    assert.deepEqual(await queue.enqueueReviewed('account', automationId, ['root']), ['root']);
    const other = classifyComment({ ...ROOT, text: 'x' }, ['x'], 'other', NOW);
    assert.equal(other.eligible, true);
  });
});

test('enqueueReviewed and BacklogService.processEligible reject a root the account already answered', async () => {
  await withDb(async (db) => {
    const automationId = seed(db);
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'root', text: 'guide', username: 'customer', createdAt: FRESH });
    await new Scanner(db, pages([ROOT])).scanMedia(account, 'media', scanOptions);
    storeReply(db, 'Brand');
    const queue = new QueueService(db, {} as never, { clock: () => NOW });
    await assert.rejects(queue.enqueueReviewed('account', automationId, ['root']), /not safely eligible/i);
    const backlog = new BacklogService(db, new Scanner(db, pages([ROOT])), queue);
    await assert.rejects(backlog.processEligible('account', automationId, ['root']));
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }).n, 0);
  });
});

test('pending list excludes roots with a stored owner reply and keeps unrelated ones', async () => {
  await withDb(async (db) => {
    const automationId = seed(db);
    const scanner = new Scanner(db, pages([ROOT, { ...ROOT, commentId: 'plain' }]));
    await scanner.scanMedia(account, 'media', scanOptions);
    assert.equal(listPendingReview(db, 'account', { limit: 50, offset: 0, now: NOW }).total, 2);
    storeReply(db, 'brand');
    const pending = listPendingReview(db, 'account', { limit: 50, offset: 0, now: NOW });
    assert.equal(pending.total, 1);
    assert.deepEqual(pending.items.map((item) => item.commentId), ['plain']);
    assert.ok(automationId);
  });
});

test('pre-send recheck: an owner reply stored after queueing skips the item with no intent and no POST', async () => {
  await withDb(async (db) => {
    const automationId = seed(db);
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'root', text: 'guide', username: 'customer', createdAt: FRESH });
    db.prepare(`UPDATE automations SET real_enabled=1 WHERE automation_id=?`).run(automationId);
    let posts = 0;
    const provider = {
      async getComment() { return { ...ROOT }; },
      async sendPrivateReply() { posts++; return { outcome: 'accepted' as const, messageId: 'm' }; },
      async readMessage() { return { messageId: 'm', observedAt: '', recipientId: 'x' }; },
    } as never;
    const queue = new QueueService(db, provider, { clock: () => NOW, sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    assert.deepEqual(await queue.enqueueReviewed('account', automationId, ['root']), ['root']);
    assert.equal((db.prepare(`SELECT state FROM queue_items`).get() as { state: string }).state, 'QUEUED');
    storeReply(db, 'brand');
    assert.ok(await queue.processOne('account'));
    const item = db.prepare(`SELECT state, state_reason_code AS reason FROM queue_items`).get() as { state: string; reason: string | null };
    assert.equal(item.state, 'SKIPPED');
    assert.equal(item.reason, 'owner_replied');
    assert.equal(posts, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM send_attempts`).get() as { n: number }).n, 0);
  });
});

test('pre-send recheck: expired comments still expire before the owner-reply skip', async () => {
  await withDb(async (db) => {
    const automationId = seed(db);
    const old = '2026-09-20T00:00:00Z';
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'root', text: 'guide', username: 'customer', createdAt: FRESH });
    db.prepare(`UPDATE automations SET real_enabled=1 WHERE automation_id=?`).run(automationId);
    const provider = { async getComment() { return { ...ROOT, createdAt: old }; }, async sendPrivateReply() { throw new Error('no POST'); } } as never;
    const queue = new QueueService(db, provider, { clock: () => NOW, sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed('account', automationId, ['root']);
    storeReply(db, 'brand');
    await queue.processOne('account');
    assert.equal((db.prepare(`SELECT state FROM queue_items`).get() as { state: string }).state, 'EXPIRED');
  });
});

test('summary counts owner_replied under review and the UI has the Spanish label', () => {
  const summary = summarizeScan([{ status: 'complete', result: { expiredCount: 0, reports: [{ status: 'complete', commentsSeen: 3, candidates: [
    { eligible: false, reason: 'owner_replied' }, { eligible: false, reason: 'owner_replied' }, { eligible: true, reason: 'eligible' },
  ] }] } }]);
  assert.equal(summary.review, 2);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.ownerReplied, 2);
  assert.equal(reasonLabel('owner_replied'), 'Ya respondido por la cuenta');
});
