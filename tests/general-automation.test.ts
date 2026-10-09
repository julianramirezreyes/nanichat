import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia, createMediaIfMissing } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { AutomationService } from '../src/services/automations.ts';
import { BacklogService } from '../src/services/backlog.ts';
import { listPendingReview } from '../src/services/pending-review.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { Scheduler } from '../src/services/scheduler.ts';
import { mediaLabel } from '../app/media-label.ts';

type Db = ReturnType<typeof openDatabase>;
const NOW = Date.now();
const FRESH = new Date(NOW - 60_000).toISOString();
const MINUTE = 60_000;

async function withDb(run: (db: Db) => Promise<void> | void, target?: number): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'general-automation-'));
  const db = openDatabase(directory);
  if (target === undefined) migrateDatabase(db); else migrateDatabase(db, target);
  try { await run(db); } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}

function seedAccount(db: Db, suffix = '', media: string[] = ['m1', 'm2']) {
  const accountId = `acc${suffix}`;
  createConnection(db, { id: `conn${suffix}`, name: 'c', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
    status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
  addDiscoveredAccount(db, { accountId, connectionId: `conn${suffix}`, providerAccountId: `p${suffix}`, username: `brand${suffix}`, status: 'valid' });
  db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id=?`).run(`conn${suffix}`);
  for (const mediaId of media) createMedia(db, { accountId, mediaId: `${mediaId}${suffix}`, permalink: `https://instagram.com/p/${mediaId}${suffix}`, publishedAt: FRESH });
  return { accountId, connectionId: `conn${suffix}`, providerAccountId: `p${suffix}`, username: `brand${suffix}` };
}

function general(db: Db, accountId: string, name = 'General', keyword = 'guide'): string {
  const service = new AutomationService(db);
  const id = service.create({ accountId, scope: 'account', name, replyText: 'Hola {{username}} {{media}}' });
  service.addKeyword(accountId, id, keyword);
  service.setEnabled(accountId, id, true);
  return id;
}

function specific(db: Db, accountId: string, mediaId: string, name = 'Specific', keyword = 'guide'): string {
  const service = new AutomationService(db);
  const id = service.create({ accountId, mediaId, name, replyText: 'Hi {{username}}' });
  service.addKeyword(accountId, id, keyword);
  service.setEnabled(accountId, id, true);
  return id;
}

function classifyEligible(db: Db, accountId: string, mediaId: string, commentId: string, automationId: string) {
  db.prepare(`INSERT OR IGNORE INTO scan_runs(scan_id,account_id,media_id,scan_kind,status,started_at,finished_at)
    VALUES (?,?,?,'backlog','complete',?,?)`).run(`scan-${mediaId}`, accountId, mediaId, FRESH, FRESH);
  db.prepare(`INSERT OR REPLACE INTO comment_classifications(account_id,comment_id,automation_id,result,reason,matched_keywords_json,observed_at,scan_id)
    VALUES (?,?,?,'eligible','eligible','["guide"]',?,?)`).run(accountId, commentId, automationId, FRESH, `scan-${mediaId}`);
}

const rowsFor = (db: Db, commentId: string) => db.prepare(`SELECT automation_id AS automationId, result, reason FROM comment_classifications
  WHERE comment_id=? ORDER BY automation_id`).all(commentId).map((row) => ({ ...row })) as Array<{ automationId: string; result: string; reason: string }>;

// ---------------------------------------------------------------------------------------------------------------
// 1. Migration
// ---------------------------------------------------------------------------------------------------------------

test('migration v9 -> v10 preserves automations, keywords, classifications, queue and attempts and allows account scope', async () => {
  await withDb((db) => {
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
    const ctx = seedAccount(db);
    createComment(db, { accountId: ctx.accountId, mediaId: 'm1', commentId: 'c1', text: 'guide', username: 'customer', createdAt: FRESH });
    db.exec(`INSERT INTO automations (automation_id, account_id, media_id, name, status, match_mode, reply_text, created_at, updated_at,
        real_enabled, buttons_json, monitoring_started_at, version)
      VALUES ('auto1', 'acc', 'm1', 'Old', 'enabled', 'exact', 'Hi', '2026-01-01', '2026-01-02', 1, '[{"title":"x","url":"https://a.b"}]', '2026-01-03', 7);
      INSERT INTO automation_keywords(account_id, automation_id, keyword_id, phrase, normalized_phrase, created_at)
        VALUES ('acc','auto1','k1','guide','guide','2026-01-01'), ('acc','auto1','k2','ebook','ebook','2026-01-01');
      INSERT INTO scan_runs(scan_id,account_id,media_id,scan_kind,status,started_at) VALUES ('s1','acc','m1','backlog','complete','2026-01-01');
      INSERT INTO comment_classifications(account_id,comment_id,automation_id,result,reason,observed_at,scan_id)
        VALUES ('acc','c1','auto1','eligible','eligible','2026-01-01','s1');
      INSERT INTO queue_items(queue_item_id,account_id,comment_id,automation_id,state,dry_run,payload_json,created_at,updated_at)
        VALUES ('q1','acc','c1','auto1','SENT',0,'{}','2026-01-01','2026-01-01');
      INSERT INTO send_attempts(attempt_event_id,account_id,queue_item_id,event_type,event_at) VALUES ('e1','acc','q1','intent_recorded','2026-01-01');`);
    migrateDatabase(db);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 12);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    const row = db.prepare(`SELECT * FROM automations WHERE automation_id='auto1'`).get() as Record<string, unknown>;
    assert.equal(row.scope, 'media');
    assert.equal(row.media_id, 'm1');
    assert.equal(row.match_mode, 'exact');
    assert.equal(row.version, 7);
    assert.equal(row.real_enabled, 1);
    assert.equal(row.monitoring_started_at, '2026-01-03');
    assert.equal(row.buttons_json, '[{"title":"x","url":"https://a.b"}]');
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    assert.equal(count('automation_keywords'), 2);
    assert.equal(count('comment_classifications'), 1);
    assert.equal(count('queue_items'), 1);
    assert.equal(count('send_attempts'), 1);
    // FK still enforced after the rebuild: dangling automation reference is rejected.
    assert.throws(() => db.prepare(`INSERT INTO automation_keywords(account_id, automation_id, keyword_id, phrase, normalized_phrase, created_at)
      VALUES ('acc','missing','k3','x','x','2026')`).run());
    // Cascade still wired: deleting an automation without dependants removes its keywords only.
    db.exec(`INSERT INTO automations (automation_id, account_id, media_id, scope, name, created_at, updated_at)
      VALUES ('g1','acc',NULL,'account','G','2026','2026')`);
    assert.throws(() => db.exec(`INSERT INTO automations (automation_id, account_id, media_id, scope, name, created_at, updated_at)
      VALUES ('bad1','acc',NULL,'media','B','2026','2026')`), /CHECK/);
    assert.throws(() => db.exec(`INSERT INTO automations (automation_id, account_id, media_id, scope, name, created_at, updated_at)
      VALUES ('bad2','acc','m1','account','B','2026','2026')`), /CHECK/);
    assert.throws(() => db.exec(`INSERT INTO automations (automation_id, account_id, media_id, scope, name, created_at, updated_at)
      VALUES ('bad3','acc','nope','media','B','2026','2026')`), /FOREIGN KEY/);
    migrateDatabase(db);
    assert.equal(count('automations'), 2);
  }, 9);
});

test('a failing v10 migration rolls back and restores foreign key enforcement', async () => {
  await withDb((db) => {
    seedAccount(db);
    db.exec(`INSERT INTO automations (automation_id, account_id, media_id, name, created_at, updated_at) VALUES ('a','acc','m1','A','x','x');`);
    // Simulate pre-existing dangling data that a rebuild must not silently accept.
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec(`INSERT INTO automation_keywords(account_id, automation_id, keyword_id, phrase, normalized_phrase, created_at)
      VALUES ('acc','ghost','k','x','x','x')`);
    db.exec('PRAGMA foreign_keys=ON');
    assert.throws(() => migrateDatabase(db), /foreign key/i);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM automations`).get() as { n: number }).n, 1);
  }, 9);
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Precedence at classification / scan time
// ---------------------------------------------------------------------------------------------------------------

function scanProvider(byMedia: Record<string, Array<{ commentId: string; text: string; createdAt?: string }>>, calls: string[] = []) {
  return {
    async listComments(_account: unknown, mediaId: string) {
      calls.push(mediaId);
      return { items: (byMedia[mediaId] ?? []).map((c) => ({ username: 'customer', createdAt: FRESH, ...c })), complete: true };
    },
  };
}

test('backlog scan: general yields on a media with an enabled specific automation and applies elsewhere', async () => {
  await withDb(async (db) => {
    const ctx = seedAccount(db);
    const s = specific(db, ctx.accountId, 'm1');
    const g = general(db, ctx.accountId);
    const scanner = new Scanner(db, scanProvider({ m1: [{ commentId: 'c1', text: 'guide' }], m2: [{ commentId: 'c2', text: 'guide' }] }) as never);
    const backlog = new BacklogService(db, scanner, new QueueService(db, {} as never));
    await backlog.scan(ctx, { window: '24h', now: NOW });
    assert.deepEqual(rowsFor(db, 'c1'), [{ automationId: s, result: 'eligible', reason: 'eligible' }]);
    assert.deepEqual(rowsFor(db, 'c2'), [{ automationId: g, result: 'eligible', reason: 'eligible' }]);
  });
});

for (const variant of ['paused', 'archived'] as const) {
  test(`backlog scan: general applies on a media whose specific automation is ${variant}`, async () => {
    await withDb(async (db) => {
      const ctx = seedAccount(db);
      const s = specific(db, ctx.accountId, 'm1');
      const g = general(db, ctx.accountId);
      if (variant === 'paused') new AutomationService(db).setEnabled(ctx.accountId, s, false);
      else db.prepare(`UPDATE automations SET status='disabled', name=name || ' (archived)' WHERE automation_id=?`).run(s);
      const scanner = new Scanner(db, scanProvider({ m1: [{ commentId: 'c1', text: 'guide' }] }) as never);
      await new BacklogService(db, scanner, new QueueService(db, {} as never)).scan(ctx, { window: '24h', now: NOW });
      assert.deepEqual(rowsFor(db, 'c1'), [{ automationId: g, result: 'eligible', reason: 'eligible' }]);
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------
// 3. Enqueue / ambiguity / pending / pre-send
// ---------------------------------------------------------------------------------------------------------------

test('enqueueReviewed: general enqueues any account media, yields to a specific, and two enabled generals stay ambiguous', async () => {
  await withDb(async (db) => {
    const ctx = seedAccount(db);
    createComment(db, { accountId: ctx.accountId, mediaId: 'm1', commentId: 'c1', text: 'guide', username: 'customer', createdAt: FRESH });
    createComment(db, { accountId: ctx.accountId, mediaId: 'm2', commentId: 'c2', text: 'guide', username: 'customer', createdAt: FRESH });
    const s = specific(db, ctx.accountId, 'm1');
    const g = general(db, ctx.accountId);
    // Stale general row on m1 (classified before the specific existed) must not make the specific ambiguous.
    classifyEligible(db, ctx.accountId, 'm1', 'c1', g);
    classifyEligible(db, ctx.accountId, 'm1', 'c1', s);
    const queue = new QueueService(db, {} as never);
    await assert.rejects(queue.enqueueReviewed(ctx.accountId, g, ['c1']), /media-specific automation/);
    assert.deepEqual(await queue.enqueueReviewed(ctx.accountId, s, ['c1']), ['c1']);
    classifyEligible(db, ctx.accountId, 'm2', 'c2', g);
    assert.deepEqual(await queue.enqueueReviewed(ctx.accountId, g, ['c2']), ['c2']);
    const item = db.prepare(`SELECT state, payload_json FROM queue_items WHERE comment_id='c2'`).get() as { state: string; payload_json: string };
    assert.equal(item.state, 'SIMULATED');
    assert.match(JSON.parse(item.payload_json).text, /https:\/\/instagram\.com\/p\/m2/u);

    createComment(db, { accountId: ctx.accountId, mediaId: 'm2', commentId: 'c3', text: 'guide', username: 'customer', createdAt: FRESH });
    const g2 = general(db, ctx.accountId, 'General 2');
    classifyEligible(db, ctx.accountId, 'm2', 'c3', g);
    classifyEligible(db, ctx.accountId, 'm2', 'c3', g2);
    await assert.rejects(queue.enqueueReviewed(ctx.accountId, g, ['c3']), /multiple automations/);
  });
});

test('enqueueReviewed: general cannot enqueue a comment of another account', async () => {
  await withDb(async (db) => {
    const a = seedAccount(db, 'A');
    const b = seedAccount(db, 'B');
    createComment(db, { accountId: b.accountId, mediaId: 'm1B', commentId: 'cb', text: 'guide', username: 'customer', createdAt: FRESH });
    const g = general(db, a.accountId);
    await assert.rejects(new QueueService(db, {} as never).enqueueReviewed(a.accountId, g, ['cb']), /does not belong/);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM queue_items`).get() as { n: number }).n, 0);
  });
});

test('pending list shows a general match once with its media label and hides the general on a yielded media', async () => {
  await withDb((db) => {
    const ctx = seedAccount(db);
    db.prepare(`UPDATE media SET caption='Receta de pan casero', media_type='VIDEO' WHERE media_id='m2'`).run();
    createComment(db, { accountId: ctx.accountId, mediaId: 'm1', commentId: 'c1', text: 'guide', username: 'u1', createdAt: FRESH });
    createComment(db, { accountId: ctx.accountId, mediaId: 'm2', commentId: 'c2', text: 'guide', username: 'u2', createdAt: FRESH });
    const s = specific(db, ctx.accountId, 'm1');
    const g = general(db, ctx.accountId);
    classifyEligible(db, ctx.accountId, 'm1', 'c1', g);
    classifyEligible(db, ctx.accountId, 'm1', 'c1', s);
    classifyEligible(db, ctx.accountId, 'm2', 'c2', g);
    const pending = listPendingReview(db, ctx.accountId, { limit: 50, offset: 0, now: NOW });
    assert.equal(pending.total, 2);
    const byComment = Object.fromEntries(pending.items.map((item) => [item.commentId, item]));
    assert.equal(byComment.c1!.automationId, s);
    assert.equal(byComment.c1!.scope, 'media');
    assert.equal(byComment.c2!.automationId, g);
    assert.equal(byComment.c2!.scope, 'account');
    assert.equal(byComment.c2!.mediaId, 'm2');
    assert.equal(byComment.c2!.mediaCaption, 'Receta de pan casero');
    assert.equal(byComment.c2!.mediaType, 'VIDEO');
    assert.match(byComment.c2!.previewText ?? '', /m2/u);
    assert.match(mediaLabel({ mediaId: byComment.c2!.mediaId, caption: byComment.c2!.mediaCaption, mediaType: byComment.c2!.mediaType }), /Reel\/Video · Receta de pan casero/u);
  });
});

function realProvider(sends: string[]) {
  return {
    async getComment(_account: unknown, commentId: string) { return { commentId, text: 'guide', username: 'customer', createdAt: FRESH }; },
    async sendPrivateReply(_account: unknown, commentId: string) { sends.push(commentId); return { outcome: 'accepted' as const, messageId: `msg-${commentId}` }; },
    async readMessage(_account: unknown, messageId: string) { return { messageId, observedAt: new Date().toISOString() }; },
  };
}

function enableRealGeneral(db: Db, ctx: { accountId: string }) {
  db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id=?`).run(ctx.accountId);
  const g = general(db, ctx.accountId);
  const service = new AutomationService(db);
  service.setRealEnabled(ctx.accountId, g, true, true);
  return g;
}

test('pre-send: a real general automation sends on a media without a specific automation', async () => {
  await withDb(async (db) => {
    const ctx = seedAccount(db);
    createComment(db, { accountId: ctx.accountId, mediaId: 'm2', commentId: 'c2', text: 'guide', username: 'customer', createdAt: FRESH });
    const g = enableRealGeneral(db, ctx);
    classifyEligible(db, ctx.accountId, 'm2', 'c2', g);
    const sends: string[] = [];
    const queue = new QueueService(db, realProvider(sends) as never, { sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed(ctx.accountId, g, ['c2']);
    await queue.processOne(ctx.accountId);
    assert.deepEqual(sends, ['c2']);
    assert.equal((db.prepare(`SELECT state FROM queue_items WHERE comment_id='c2'`).get() as { state: string }).state, 'SENT');
  });
});

test('pre-send: a queued general item yields (SKIPPED, no intent, no POST) when a specific automation is enabled on its media', async () => {
  await withDb(async (db) => {
    const ctx = seedAccount(db);
    createComment(db, { accountId: ctx.accountId, mediaId: 'm2', commentId: 'c2', text: 'guide', username: 'customer', createdAt: FRESH });
    const g = enableRealGeneral(db, ctx);
    classifyEligible(db, ctx.accountId, 'm2', 'c2', g);
    const sends: string[] = [];
    const queue = new QueueService(db, realProvider(sends) as never, { sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed(ctx.accountId, g, ['c2']);
    specific(db, ctx.accountId, 'm2');
    await queue.processOne(ctx.accountId);
    assert.deepEqual(sends, []);
    const item = db.prepare(`SELECT state, state_reason_code FROM queue_items WHERE comment_id='c2'`).get() as { state: string; state_reason_code: string };
    assert.deepEqual({ ...item }, { state: 'SKIPPED', state_reason_code: 'yielded_to_media_automation' });
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM send_attempts`).get() as { n: number }).n, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 4. Monitor cadence
// ---------------------------------------------------------------------------------------------------------------

function monitorEnv(db: Db, options: { media?: string[]; cap?: number } = {}) {
  const ctx = seedAccount(db, '', options.media ?? ['m1', 'm2']);
  const calls: string[] = [];
  const byMedia: Record<string, Array<{ commentId: string; text: string; createdAt?: string }>> = {};
  const provider = { ...scanProvider(byMedia, calls), ...realProvider([]) };
  const refreshes: string[] = [];
  const newMedia: string[] = [];
  const refresher = {
    async listMedia(accountId: string) {
      refreshes.push(accountId);
      for (const mediaId of newMedia) createMediaIfMissing(db, { accountId, mediaId, permalink: null, publishedAt: FRESH });
    },
  };
  let clock = NOW;
  const queue = new QueueService(db, provider as never);
  const scheduler = new Scheduler(db, new Scanner(db, provider as never), queue, {
    clock: () => clock, mediaRefresher: refresher, ...(options.cap ? { generalMaxMediaScansPerTick: options.cap } : {}),
  });
  return { ctx, calls, byMedia, refreshes, newMedia, scheduler, queue, advance(ms: number) { clock += ms; } };
}

const count = (calls: string[], mediaId: string) => calls.filter((value) => value === mediaId).length;

test('monitor: general refreshes media at most every 5 minutes and scans each media at most every 2 minutes', async () => {
  await withDb(async (db) => {
    const env = monitorEnv(db);
    const g = general(db, env.ctx.accountId);
    db.prepare(`UPDATE automations SET monitoring_started_at=? WHERE automation_id=?`).run(new Date(NOW - 10 * MINUTE).toISOString(), g);
    const s = specific(db, env.ctx.accountId, 'm1');
    db.prepare(`UPDATE automations SET monitoring_started_at=? WHERE automation_id=?`).run(new Date(NOW - 10 * MINUTE).toISOString(), s);
    env.scheduler.start(env.ctx.accountId);
    await env.scheduler.tick();
    assert.deepEqual(env.refreshes, ['acc']);
    assert.equal(count(env.calls, 'm2'), 1);
    assert.equal(count(env.calls, 'm1'), 1, 'm1 is scanned only by its specific automation');
    env.advance(MINUTE);
    await env.scheduler.tick();
    assert.equal(env.refreshes.length, 1);
    assert.equal(count(env.calls, 'm2'), 1, 'not rescanned before 2 minutes');
    assert.equal(count(env.calls, 'm1'), 2, 'specific automations keep the per-tick cadence');
    env.advance(MINUTE - 1);
    await env.scheduler.tick();
    assert.equal(count(env.calls, 'm2'), 1, 'still under the 2-minute interval');
    env.advance(1);
    await env.scheduler.tick();
    assert.equal(count(env.calls, 'm2'), 2, 'rescanned once 2 minutes have elapsed');
    assert.equal(env.refreshes.length, 1, 'the publication list is refreshed only every 5 minutes');
    env.newMedia.push('m3');
    env.advance(3 * MINUTE - 1);
    await env.scheduler.tick();
    assert.equal(env.refreshes.length, 1);
    assert.equal(count(env.calls, 'm3'), 0, 'a new publication is unknown until the media refresh');
    env.advance(1);
    await env.scheduler.tick();
    assert.equal(env.refreshes.length, 2);
    assert.equal(count(env.calls, 'm3'), 1, 'a publication added by the media refresh is picked up');
    env.scheduler.stopAll();
  });
});

test('monitor: per-tick cap bounds general media scans; the rest are scanned on the next tick', async () => {
  await withDb(async (db) => {
    const media = Array.from({ length: 30 }, (_, index) => `m${String(index).padStart(2, '0')}`);
    const env = monitorEnv(db, { media });
    const g = general(db, env.ctx.accountId);
    db.prepare(`UPDATE automations SET monitoring_started_at=? WHERE automation_id=?`).run(new Date(NOW - 10 * MINUTE).toISOString(), g);
    env.scheduler.start(env.ctx.accountId);
    await env.scheduler.tick();
    assert.equal(env.calls.length, 25);
    env.advance(MINUTE);
    await env.scheduler.tick();
    assert.equal(env.calls.length, 30);
    assert.equal(new Set(env.calls).size, 30);
    env.scheduler.stopAll();
  });
});

test('monitor: general respects the activation cutoff, picks new publications, and is Dry Run by default', async () => {
  await withDb(async (db) => {
    const env = monitorEnv(db, { media: ['old'] });
    const g = general(db, env.ctx.accountId);
    db.prepare(`UPDATE automations SET monitoring_started_at=? WHERE automation_id=?`).run(new Date(NOW - 10 * MINUTE).toISOString(), g);
    env.byMedia.old = [
      { commentId: 'before', text: 'guide', createdAt: new Date(NOW - 24 * 60 * MINUTE).toISOString() },
      { commentId: 'after', text: 'guide', createdAt: new Date(NOW - MINUTE).toISOString() },
    ];
    env.byMedia.fresh = [{ commentId: 'on-new', text: 'guide', createdAt: new Date(NOW - MINUTE).toISOString() }];
    env.scheduler.start(env.ctx.accountId);
    await env.scheduler.tick();
    env.newMedia.push('fresh');
    env.advance(5 * MINUTE);
    await env.scheduler.tick();
    const states = db.prepare(`SELECT comment_id, state, dry_run FROM queue_items ORDER BY comment_id`).all() as Array<{ comment_id: string; state: string; dry_run: number }>;
    assert.deepEqual(states.map((row) => ({ ...row })), [
      { comment_id: 'after', state: 'SIMULATED', dry_run: 1 },
      { comment_id: 'on-new', state: 'SIMULATED', dry_run: 1 },
    ]);
    assert.equal(rowsFor(db, 'before')[0]!.reason, 'before_monitor_cutoff');
    env.scheduler.stopAll();
  });
});

test('monitor: real-authorized general automation enqueues real (non-simulated) items when Dry Run is off', async () => {
  await withDb(async (db) => {
    const env = monitorEnv(db, { media: ['m1'] });
    db.prepare(`UPDATE social_accounts SET monitoring_paused=0`).run();
    const g = general(db, env.ctx.accountId);
    new AutomationService(db).setRealEnabled(env.ctx.accountId, g, true, true);
    db.prepare(`UPDATE automations SET monitoring_started_at=? WHERE automation_id=?`).run(new Date(NOW - 10 * MINUTE).toISOString(), g);
    env.byMedia.m1 = [{ commentId: 'c-real', text: 'guide', createdAt: new Date(NOW - MINUTE).toISOString() }];
    env.queue.setDryRun(false, true);
    env.scheduler.start(env.ctx.accountId);
    await env.scheduler.tick();
    const row = db.prepare(`SELECT dry_run, state FROM queue_items WHERE comment_id='c-real'`).get() as { dry_run: number; state: string };
    assert.equal(row.dry_run, 0);
    assert.notEqual(row.state, 'SIMULATED');
    env.scheduler.stopAll();
  });
});

test('monitor: general automation of one account never refreshes or scans another account', async () => {
  await withDb(async (db) => {
    const env = monitorEnv(db);
    const other = seedAccount(db, 'B', ['x1']);
    const g = general(db, env.ctx.accountId);
    db.prepare(`UPDATE automations SET monitoring_started_at=? WHERE automation_id=?`).run(new Date(NOW - 10 * MINUTE).toISOString(), g);
    env.scheduler.startAll();
    await env.scheduler.tick();
    assert.deepEqual(env.refreshes, ['acc']);
    assert.equal(count(env.calls, 'x1B'), 0);
    assert.ok(other.accountId);
    env.scheduler.stopAll();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 5. HTTP API
// ---------------------------------------------------------------------------------------------------------------

async function withApi(run: (ctx: { db: Db; call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }> }) => Promise<void>) {
  await withDb(async (db) => {
    seedAccount(db);
    const handler = createApiHandler({ database: db, csrfToken: 'csrf', automations: new AutomationService(db) } as never);
    const server = createServer((req, res) => { void handler(req, res); });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const call = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request(new URL(path, origin), { method, headers: { origin, 'x-csrf-token': 'csrf', 'content-type': 'application/json' } }, (res) => {
        let raw = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try { await run({ db, call }); } finally { server.close(); }
  });
}

const baseBody = { accountId: 'acc', name: 'General', keywords: ['guide'], replyText: 'Hola {{username}}' };

test('API: creates a general automation with null or omitted mediaId and exposes scope in the DTO', async () => {
  await withApi(async ({ call }) => {
    const created = await call('POST', '/api/automations', { ...baseBody, scope: 'account', mediaId: null });
    assert.equal(created.status, 201);
    const omitted = await call('POST', '/api/automations', { ...baseBody, name: 'G2', scope: 'account' });
    assert.equal(omitted.status, 201);
    const specificCreated = await call('POST', '/api/automations', { ...baseBody, name: 'S', mediaId: 'm1' });
    assert.equal(specificCreated.status, 201);
    const list = await call('GET', '/api/automations?accountId=acc');
    const byId = Object.fromEntries(list.body.automations.map((row: { automationId: string }) => [row.automationId, row]));
    assert.equal(byId[created.body.automationId].scope, 'account');
    assert.equal(byId[created.body.automationId].mediaId, null);
    assert.equal(byId[specificCreated.body.automationId].scope, 'media');
    assert.equal(byId[specificCreated.body.automationId].mediaId, 'm1');
  });
});

test('API: rejects inconsistent scope/mediaId combinations and keeps keyword validation', async () => {
  await withApi(async ({ call, db }) => {
    for (const body of [
      { ...baseBody, scope: 'account', mediaId: 'm1' },
      { ...baseBody, mediaId: null },
      { ...baseBody },
      { ...baseBody, scope: 'bogus', mediaId: 'm1' },
      { ...baseBody, scope: 'account', keywords: ['guide', 'GUIDE'] },
      { ...baseBody, scope: 'account', matchMode: 'fuzzy' },
      { ...baseBody, scope: 'account', buttons: [{ title: 'a', url: 'https://a.b' }, { title: 'b', url: 'https://a.b' }, { title: 'c', url: 'https://a.b' }] },
    ]) {
      const result = await call('POST', '/api/automations', body);
      assert.equal(result.status, 400, JSON.stringify(body));
    }
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM automations`).get() as { n: number }).n, 0);
  });
});

test('API: editing keeps the scope; a silent scope change is rejected and history stays attached', async () => {
  await withApi(async ({ call, db }) => {
    const g = (await call('POST', '/api/automations', { ...baseBody, scope: 'account' })).body.automationId as string;
    const s = (await call('POST', '/api/automations', { ...baseBody, name: 'S', mediaId: 'm1' })).body.automationId as string;
    const edit = { accountId: 'acc', name: 'General editada', replyText: 'Hola', matchMode: 'exact', buttons: [], keywords: ['ebook'] };
    assert.equal((await call('PUT', `/api/automations/${g}`, { ...edit, mediaId: null })).status, 200);
    assert.equal((await call('PUT', `/api/automations/${g}`, { ...edit })).status, 200);
    assert.equal((await call('PUT', `/api/automations/${g}`, { ...edit, mediaId: 'm1' })).status, 409);
    assert.equal((await call('PUT', `/api/automations/${g}`, { ...edit, scope: 'media', mediaId: 'm1' })).status, 409);
    assert.equal((await call('PUT', `/api/automations/${s}`, { ...edit, scope: 'account', mediaId: null })).status, 409);
    assert.equal((await call('PUT', `/api/automations/${s}`, { ...edit, mediaId: null })).status, 400);
    assert.equal((await call('PUT', `/api/automations/${s}`, { ...edit, mediaId: 'm2' })).status, 200);
    const rows = db.prepare(`SELECT scope, media_id FROM automations ORDER BY scope`).all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => [row.scope, row.media_id]), [['account', null], ['media', 'm2']]);
    assert.equal((await call('POST', `/api/automations/${g}/delete`, { accountId: 'acc' })).status, 200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 6. UI helpers
// ---------------------------------------------------------------------------------------------------------------

test('UI helper: the general option maps to scope account with a null mediaId; other choices stay media-specific', async () => {
  const { GENERAL_MEDIA_OPTION, automationTargetPayload, automationTargetLabel } = await import('../app/automation-scope.ts');
  assert.deepEqual(automationTargetPayload(GENERAL_MEDIA_OPTION), { scope: 'account', mediaId: null });
  assert.deepEqual(automationTargetPayload('m1'), { scope: 'media', mediaId: 'm1' });
  const media = [{ accountId: 'acc', mediaId: 'm1', caption: 'Pan casero', mediaType: 'IMAGE', publishedAt: '2026-10-01T00:00:00Z' }];
  assert.equal(automationTargetLabel({ scope: 'account', mediaId: null }, media), 'Todas las publicaciones');
  assert.equal(automationTargetLabel({ scope: 'media', mediaId: 'm1' }, media), '2026-10-01 · Foto · Pan casero');
  assert.equal(automationTargetLabel({ mediaId: 'zzz123456' }, media), 'Sin texto · …123456');
});
