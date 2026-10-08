import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AutomationService, classifyComment, matchesKeyword, normalizeMatchText, renderReply } from '../src/services/automations.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createConnection, createMedia, createComment } from '../src/db/repositories.ts';
import { createVault } from '../src/security/vault.ts';
import { QueueService } from '../src/services/queue.ts';
import { getCatchUpCutoff, Scanner } from '../src/services/scanner.ts';
import { BacklogService } from '../src/services/backlog.ts';
import { Scheduler } from '../src/services/scheduler.ts';

test('keyword matching uses Unicode normalization, spacing, and whole phrase boundaries', () => {
  assert.equal(normalizeMatchText('  Guía\t RÁPIDA  '), 'guia rapida');
  assert.equal(matchesKeyword('Mira la guía   rápida ahora', 'GUIA RAPIDA', 'contains'), true);
  assert.equal(matchesKeyword('GUIADO', 'GUIA', 'contains'), false);
  assert.equal(matchesKeyword('Una guía', 'GUIA', 'exact'), false);
  assert.equal(matchesKeyword('GUIA', 'Guía', 'exact'), true);
});

test('reply rendering substitutes only supported variables and rejects unsafe button payloads', () => {
  const rendered = renderReply('Hola {{username}}: {{comment}} ({{keyword}})', {
    username: 'ana', comment: 'Quiero guía', keyword: 'guia',
  }, [{ title: 'Open', url: 'https://example.test/info' }]);
  assert.deepEqual(rendered, {
    text: 'Hola ana: Quiero guía (guia)',
    buttons: [{ title: 'Open', url: 'https://example.test/info' }],
  });
  assert.throws(() => renderReply('x', { username: '', comment: '', keyword: '' }, [
    { title: 'A', url: 'https://example.test' },
    { title: 'B', url: 'https://example.test' },
    { title: 'C', url: 'https://example.test' },
  ]), /button/i);
  assert.throws(() => renderReply('{{unsupported}}', { username: '', comment: '', keyword: '' }, []), /variable/i);
  assert.throws(() => renderReply('x', { username: '', comment: '', keyword: '' }, [
    { title: 'Open', url: 'javascript:alert(1)' },
  ]), /URL/i);
});

test('comment eligibility rejects own replies, invalid timestamps, future comments, and expired comments', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const base = { commentId: 'c1', text: 'guia', username: 'customer', createdAt: '2026-10-05T11:00:00Z' };
  assert.equal(classifyComment(base, ['guia'], 'brand', now).eligible, true);
  assert.equal(classifyComment({ ...base, username: 'Brand' }, ['guia'], 'brand', now).reason, 'own_authored');
  assert.equal(classifyComment({ ...base, parentId: 'root' }, ['guia'], 'brand', now).reason, 'reply_thread');
  assert.equal(classifyComment({ ...base, createdAt: 'bad' }, ['guia'], 'brand', now).reason, 'invalid_timestamp');
  assert.equal(classifyComment({ ...base, createdAt: '2026-10-05T13:00:00Z' }, ['guia'], 'brand', now).reason, 'future_timestamp');
  assert.equal(classifyComment({ ...base, createdAt: '2026-09-28T11:59:59Z' }, ['guia'], 'brand', now).reason, 'expired');
  assert.equal(classifyComment({ ...base, createdAt: undefined }, ['guia'], 'brand', now).reason, 'missing_timestamp');
  assert.equal(classifyComment({ ...base, username: undefined }, ['guia'], 'brand', now).reason, 'missing_author');
  assert.equal(classifyComment({ ...base, text: 'sin palabra' }, ['guia'], 'brand', now).reason, 'no_keyword_match');
  assert.equal(classifyComment({ ...base, text: 'guia guide' }, ['guia', 'guide'], 'brand', now).eligible, true);
  assert.deepEqual(classifyComment({ ...base, text: 'guia guide' }, ['guia', 'guide'], 'brand', now).matchedKeywords, ['guia', 'guide']);
});

test('keywords in one automation are synonyms and use deterministic first match', () => {
  const result = classifyComment({
    commentId: 'c1', text: 'Quiero GUIA y EBOOK', username: 'customer', createdAt: '2026-10-05T11:00:00Z',
  }, ['guia', 'ebook'], 'brand', Date.parse('2026-10-05T12:00:00Z'));

  assert.equal(result.eligible, true);
  assert.equal(result.reason, 'eligible');
  assert.deepEqual(result.matchedKeywords, ['guia', 'ebook']);
});

test('automation schema persists monitor cutoff, real-enable, versions, and scan coverage', () => {
  withDatabase((db) => {
    const columns = db.prepare('PRAGMA table_info(automations)').all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'real_enabled'));
    assert.ok(columns.some((column) => column.name === 'monitoring_started_at'));
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='scan_runs'`).get());
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='comment_classifications'`).get());
  });
});

test('monitor scan requires explicit cutoff and does not classify older history as eligible', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const automation = new AutomationService(db);
    const id = automation.create({ accountId: account.accountId, mediaId: 'media', name: 'new leads', replyText: 'Hello {{username}}' });
    automation.addKeyword(account.accountId, id, 'guide');
    automation.setEnabled(account.accountId, id, true);
    db.prepare(`UPDATE automations SET monitoring_started_at='2026-10-05T10:00:00Z' WHERE automation_id=?`).run(id);
    const provider = { async listComments() {
      return {
        items: [
          { commentId: 'old', text: 'guide', username: 'person', createdAt: '2026-10-05T09:59:59Z' },
          { commentId: 'new', text: 'guide please', username: 'person', createdAt: '2026-10-05T10:00:01Z' },
        ],
        complete: true,
      };
    } } as never;
    const scanner = new Scanner(db, provider);
    await assert.rejects(scanner.scanMedia(account, 'media', { kind: 'monitor' }), /cutoff/i);
    const report = await scanner.scanMedia(account, 'media', {
      kind: 'monitor', cutoffAt: '2026-10-05T10:00:00Z', now: Date.parse('2026-10-05T11:00:00Z'),
    });
    assert.equal(report.status, 'complete');
    assert.equal(report.candidates.find((candidate) => candidate.commentId === 'old')?.reason, 'before_monitor_cutoff');
    assert.equal(report.candidates.find((candidate) => candidate.commentId === 'new')?.eligible, true);
    assert.equal((db.prepare(`SELECT state FROM queue_items`).get() as object | undefined), undefined);
  });
});

test('monitor records coverage after walking a bounded continuation page', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const automation = new AutomationService(db);
    const id = automation.create({ accountId: account.accountId, mediaId: 'media', name: 'bounded', replyText: 'Hi' });
    automation.addKeyword(account.accountId, id, 'guide');
    automation.setEnabled(account.accountId, id, true);
    const monitorCutoff = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`UPDATE automations SET monitoring_started_at=? WHERE automation_id=?`).run(monitorCutoff, id);
    let calls = 0;
    const provider = { async listComments(_account: unknown, _media: string, cursor?: string) {
      calls++;
      return cursor
        ? { items: [{ commentId: 'old', text: 'guide', username: 'person', createdAt: new Date(Date.now() - 120_000).toISOString() }], complete: true }
        : { items: [{ commentId: 'new', text: 'guide', username: 'person', createdAt: new Date(Date.now() - 1000).toISOString() }],
          complete: false, nextCursor: 'opaque-next' };
    } } as never;
    const report = await new Scanner(db, provider).scanMedia(account, 'media', {
      kind: 'monitor', cutoffAt: monitorCutoff, monitoringAutomationId: id,
    });
    assert.equal(calls, 2);
    assert.equal(report.status, 'complete');
    assert.equal(report.candidates.find((candidate) => candidate.commentId === 'new')?.eligible, true);
    assert.equal(report.candidates.find((candidate) => candidate.commentId === 'old')?.reason, 'before_monitor_cutoff');
    assert.equal((db.prepare(`SELECT status FROM scan_runs WHERE scan_id=?`).get(report.scanId) as { status: string }).status, 'complete');
    const checkpoint = db.prepare(`SELECT value_json FROM checkpoints WHERE account_id='account' AND media_id='media' AND checkpoint_key=?`)
      .get(`monitor:${id}`) as { value_json: string };
    assert.equal(JSON.parse(checkpoint.value_json).cursor, null);
  });
});

test('monitor continuation checks page one on every tick and resumes the bounded cursor after restart', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: account.accountId, mediaId: 'media', name: 'pages', replyText: 'Hi' });
    automation.addKeyword(account.accountId, automationId, 'guide');
    automation.setEnabled(account.accountId, automationId, true);
    const activation = new Date(Date.now() - 60_000).toISOString();
    db.prepare(`UPDATE automations SET monitoring_started_at=? WHERE automation_id=?`).run(activation, automationId);
    const seenCursors: Array<string | undefined> = [];
    const provider = { async listComments(_account: unknown, _media: string, cursor?: string) {
      seenCursors.push(cursor);
      if (!cursor) return { items: [{ commentId: `arrival-${seenCursors.length}`, text: 'guide', username: 'new', createdAt: new Date().toISOString() }], complete: false, nextCursor: 'page-2' };
      if (cursor === 'page-2') return { items: [{ commentId: 'older-page-2', text: 'guide', username: 'page2', createdAt: new Date().toISOString() }], complete: false, nextCursor: 'page-3' };
      if (cursor === 'page-3') return { items: [{ commentId: 'older-page-3', text: 'guide', username: 'page3', createdAt: new Date().toISOString() }], complete: false, nextCursor: 'page-4' };
      if (cursor === 'page-4') return { items: [{ commentId: 'older-page-4', text: 'guide', username: 'page4', createdAt: new Date().toISOString() }], complete: false, nextCursor: 'page-5' };
      return { items: [{ commentId: 'older-page-5', text: 'guide', username: 'page5', createdAt: new Date().toISOString() }], complete: true };
    } } as never;
    let scanner = new Scanner(db, provider);
    const first = await scanner.scanMedia(account, 'media', { kind: 'monitor', cutoffAt: activation, monitoringAutomationId: automationId });
    assert.equal(first.status, 'incomplete');
    assert.deepEqual(seenCursors, [undefined, 'page-2']);

    scanner = new Scanner(db, provider);
    const second = await scanner.scanMedia(account, 'media', { kind: 'monitor', cutoffAt: activation, monitoringAutomationId: automationId });
    assert.equal(second.status, 'incomplete');
    assert.deepEqual(seenCursors.slice(2), [undefined, 'page-3']);

    const third = await scanner.scanMedia(account, 'media', { kind: 'monitor', cutoffAt: activation, monitoringAutomationId: automationId });
    assert.equal(third.status, 'incomplete');
    const fourth = await scanner.scanMedia(account, 'media', { kind: 'monitor', cutoffAt: activation, monitoringAutomationId: automationId });
    assert.equal(fourth.status, 'complete');
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM comments WHERE account_id='account'`).get() as { count: number }).count, 8);
  });
});

test('cancelled scans persist a cancelled run and report incomplete coverage', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const controller = new AbortController();
    controller.abort();
    let requests = 0;
    const scanner = new Scanner(db, { async listComments() { requests++; return { items: [], complete: true }; } } as never);
    const report = await scanner.scanMedia(account, 'media', { kind: 'backlog', signal: controller.signal });
    assert.equal(report.status, 'cancelled');
    assert.equal(report.stopReason, 'scan_cancelled');
    assert.equal(requests, 0);
    assert.equal((db.prepare(`SELECT status FROM scan_runs WHERE scan_id=?`).get(report.scanId) as { status: string }).status, 'cancelled');
  });
});

test('scanner follows safe catch-up cursors and stops on a repeated cursor as incomplete', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    let calls = 0;
    const provider = { async listComments(_account: unknown, _mediaId: string, cursor?: string) {
      calls++;
      if (!cursor) return { items: [{ commentId: 'page-one', text: 'hello', username: 'one', createdAt: '2026-10-05T10:00:00Z' }],
        complete: false, nextCursor: 'cursor-one' };
      assert.equal(cursor, 'cursor-one');
      return { items: [{ commentId: 'page-two', text: 'hello', username: 'two', createdAt: '2026-10-05T10:00:00Z' }],
        complete: false, nextCursor: 'cursor-one' };
    } } as never;
    const report = await new Scanner(db, provider).scanMedia(account, 'media', { kind: 'backlog' });
    assert.equal(calls, 2);
    assert.equal(report.status, 'incomplete');
    assert.equal(report.stopReason, 'cursor_loop');
    assert.equal(report.commentsSeen, 2);
  });
});

test('queue accepts multiple synonym keywords in one automation and renders the first configured keyword', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const automations = new AutomationService(db);
    const automationId = automations.create({ accountId: account.accountId, mediaId: 'media', name: 'synonyms', replyText: '{{keyword}}' });
    automations.addKeyword(account.accountId, automationId, 'guide');
    automations.addKeyword(account.accountId, automationId, 'ebook');
    await automations.setEnabled(account.accountId, automationId, true);
    createComment(db, { accountId: account.accountId, mediaId: 'media', commentId: 'synonym-comment', text: 'guide and ebook', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() });
    const queue = new QueueService(db, {} as never);
    assert.deepEqual(await queue.enqueueReviewed(account.accountId, automationId, ['synonym-comment']), ['synonym-comment']);
    const item = db.prepare(`SELECT state, payload_json FROM queue_items WHERE comment_id='synonym-comment'`).get() as { state: string; payload_json: string };
    assert.equal(item.state, 'SIMULATED');
    assert.equal(JSON.parse(item.payload_json).text, 'guide');
  });
});

test('backlog scan classifies only; selected eligible IDs are required for queue processing', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: account.accountId, mediaId: 'media', name: 'lead', replyText: 'Hi' });
    automation.addKeyword(account.accountId, automationId, 'guide');
    automation.setEnabled(account.accountId, automationId, true);
    const provider = { async listComments() {
      return { items: [{ commentId: 'candidate', text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() }], complete: true };
    } } as never;
    const queue = new QueueService(db, {} as never);
    const backlog = new BacklogService(db, new Scanner(db, provider), queue);
    const report = await backlog.scan(account, { window: '24h' });
    assert.equal(report.reports[0]?.candidates[0]?.eligible, true, JSON.stringify(report));
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM queue_items`).get() as { count: number }).count, 0);
    await assert.rejects(backlog.processEligible(account.accountId, automationId, []), /select eligible/i);
    assert.deepEqual(await backlog.processEligible(account.accountId, automationId, ['candidate']), ['candidate']);
  });
});

test('backlog interval excludes comments before its selected window', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: account.accountId, mediaId: 'media', name: 'window', replyText: 'Hi' });
    automation.addKeyword(account.accountId, automationId, 'guide');
    automation.setEnabled(account.accountId, automationId, true);
    const now = Date.now();
    const cutoffAt = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const provider = { async listComments() {
      return { items: [
        { commentId: 'inside-window', text: 'guide', username: 'new', createdAt: new Date(now - 1000).toISOString() },
        { commentId: 'outside-window', text: 'guide', username: 'old', createdAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() },
        { commentId: 'after-window', text: 'guide', username: 'future', createdAt: new Date(now + 60_000).toISOString() },
      ], complete: true };
    } } as never;
    const report = await new Scanner(db, provider).scanMedia(account, 'media', { kind: 'backlog', cutoffAt, untilAt: new Date(now).toISOString(), now });
    assert.equal(report.candidates.find((candidate) => candidate.commentId === 'inside-window')?.eligible, true);
    assert.equal(report.candidates.find((candidate) => candidate.commentId === 'outside-window')?.reason, 'before_scan_window');
    assert.equal(report.candidates.find((candidate) => candidate.commentId === 'after-window')?.reason, 'after_scan_window');
  });
});

test('scanAll preserves partial child scan coverage instead of reporting complete', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const queue = new QueueService(db, {} as never);
    const scanner = new Scanner(db, { async listComments() {
      return { items: [], complete: false, nextCursor: 'page-2' };
    } } as never);
    const result = await new BacklogService(db, scanner, queue).scanAll([account], { window: '2h' });
    assert.equal(result[0]?.status, 'incomplete');
  });
});

test('backlog service forwards cancellation so scan jobs can stop between provider pages', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    const queue = new QueueService(db, {} as never);
    const controller = new AbortController();
    controller.abort();
    let providerCalls = 0;
    const scanner = new Scanner(db, { async listComments() { providerCalls++; return { items: [], complete: true }; } } as never);
    const result = await new BacklogService(db, scanner, queue).scan(account, { window: '2h', signal: controller.signal } as never);
    assert.equal(providerCalls, 0);
    assert.equal(result.reports[0]?.status, 'cancelled');
  });
});

test('catch-up windows are bounded and all-account backlog failures stay isolated', async () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  assert.equal(getCatchUpCutoff('2h', now), '2026-10-05T10:00:00.000Z');
  assert.throws(() => getCatchUpCutoff('custom', now, '2026-10-05T13:00:00Z'), /past date/i);
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    createConnection(db, { id: 'conn-2', name: 'second', providerCode: 'META', loginKind: 'instagram_login',
      graphVersion: 'v26.0', status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
    addDiscoveredAccount(db, { accountId: 'account-2', connectionId: 'conn-2', providerAccountId: 'p2', username: 'two', status: 'valid' });
    createMedia(db, { accountId: 'account-2', mediaId: 'media-2', permalink: null, publishedAt: null });
    const provider = { async listComments() { return { items: [], complete: true }; } } as never;
    const backlog = new BacklogService(db, new Scanner(db, provider), new QueueService(db, {} as never));
    const results = await backlog.scanAll([account, { ...account, accountId: 'account-2' }], { window: '24h' });
    assert.deepEqual(results.map((result) => result.status), ['complete', 'error']);
  });
});

test('scheduler forces monitoring off on startup and scopes account start/stop controls', async () => {
  await withDatabase(async (db) => {
    seedAccount(db);
    createConnection(db, { id: 'conn-2', name: 'second', providerCode: 'META', loginKind: 'instagram_login',
      graphVersion: 'v26.0', status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
    addDiscoveredAccount(db, { accountId: 'account-2', connectionId: 'conn-2', providerAccountId: 'provider-account-2', username: 'brand-two', status: 'valid' });
    db.prepare(`UPDATE connections SET monitoring_paused=0`).run();
    db.prepare(`UPDATE social_accounts SET monitoring_paused=0`).run();
    db.prepare(`UPDATE app_state SET state_value='true' WHERE state_key='monitoring_enabled'`).run();
    const queue = new QueueService(db, {} as never);
    const scheduler = new Scheduler(db, {} as never, queue, { pollIntervalMs: 60_000 });
    assert.equal(scheduler.status().enabled, false);
    assert.equal(scheduler.status().accounts.every((account) => account.paused), true);
    scheduler.startAll();
    assert.equal(scheduler.status().enabled, true);
    scheduler.stop('account');
    assert.equal(scheduler.status().enabled, true);
    assert.equal(scheduler.status().accounts.find((account) => account.accountId === 'account')?.paused, true);
    assert.equal(scheduler.status().accounts.find((account) => account.accountId === 'account-2')?.paused, false);
    scheduler.stopAll();
    assert.equal(scheduler.status().enabled, false);
  });
});

test('monitor tick queues new candidates as simulated and never calls provider send in Dry Run', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='conn'`).run();
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: 'account', mediaId: 'media', name: 'monitor', replyText: 'Hi {{username}}' });
    automation.addKeyword('account', automationId, 'guide');
    automation.setEnabled('account', automationId, true);
    db.prepare(`UPDATE automations SET monitoring_started_at=? WHERE automation_id=?`)
      .run(new Date(Date.now() - 60_000).toISOString(), automationId);
    let sends = 0;
    const provider = {
      async listComments() {
        return { items: [{ commentId: 'new-comment', text: 'guide', username: 'customer',
          createdAt: new Date(Date.now() - 1000).toISOString() }], complete: true };
      },
      async getComment(_account: unknown, commentId: string) { return { commentId, text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() }; },
      async sendPrivateReply() { sends++; return { outcome: 'accepted' as const, messageId: 'unexpected' }; },
      async readMessage(_account: unknown, messageId: string) { return { messageId, observedAt: new Date().toISOString() }; },
    } as never;
    const queue = new QueueService(db, provider);
    const scheduler = new Scheduler(db, new Scanner(db, provider), queue);
    scheduler.start('account');
    await scheduler.tick();
    await scheduler.tick();
    assert.equal((db.prepare(`SELECT state FROM queue_items WHERE comment_id='new-comment'`).get() as { state: string }).state, 'SIMULATED');
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM queue_items WHERE comment_id='new-comment'`).get() as { count: number }).count, 1);
    assert.equal(sends, 0);
    scheduler.stopAll();
  });
});

test('account interlock blocks real mode activation until its explicit safety hold is cleared', async () => {
  await withDatabase((db) => {
    seedAccount(db);
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: 'account', mediaId: 'media', name: 'held', replyText: 'Hi' });
    automation.addKeyword('account', automationId, 'guide');
    automation.setEnabled('account', automationId, true);
    automation.setAccountSendHold('account', 'legacy_sender_lock_uncertain');
    assert.throws(() => automation.setRealEnabled('account', automationId, true, true), /hold/i);
    automation.clearAccountSendHold('account', 'legacy_sender_lock_uncertain');
    assert.doesNotThrow(() => automation.setRealEnabled('account', automationId, true, true));
  });
});

test('queue never upgrades simulated rows and commits immutable intent before calling provider', async () => {
  await withDatabase(async (db, directory) => {
    const vault = createVault(directory, () => []);
    createConnection(db, {
      id: 'conn', name: 'test', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
      status: 'valid', accessToken: vault.encrypt('conn', 'opaque-token'),
    });
    addDiscoveredAccount(db, {
      accountId: 'account', connectionId: 'conn', providerAccountId: 'provider-account', username: 'brand', status: 'valid',
    });
    createMedia(db, { accountId: 'account', mediaId: 'media', permalink: null, publishedAt: null });
    createComment(db, {
      accountId: 'account', mediaId: 'media', commentId: 'comment', text: 'guide', username: 'customer',
      createdAt: new Date().toISOString(),
    });
    db.exec(`INSERT INTO automations (automation_id, account_id, media_id, name, status, match_mode, reply_text,
      created_at, updated_at, real_enabled, monitoring_started_at) VALUES
      ('auto', 'account', 'media', 'test', 'enabled', 'contains', 'reply {{username}}', CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP);
      INSERT INTO automation_keywords(account_id, automation_id, keyword_id, phrase, normalized_phrase, created_at)
      VALUES ('account', 'auto', 'keyword', 'guide', 'guide', CURRENT_TIMESTAMP);
      INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, observed_at)
      VALUES ('account', 'comment', 'auto', 'eligible', 'eligible', CURRENT_TIMESTAMP);`);

    let observedIntent = false;
    const provider = {
      async getComment(_account: unknown, commentId: string) {
        assert.equal(commentId, 'comment');
        return { commentId, text: 'guide', username: 'customer', createdAt: new Date().toISOString() };
      },
      async sendPrivateReply() {
        const events = db.prepare(`SELECT event_type FROM send_attempts WHERE queue_item_id =
          (SELECT queue_item_id FROM queue_items WHERE account_id='account' AND comment_id='comment')`).all() as Array<{ event_type: string }>;
        observedIntent = events.some((event) => event.event_type === 'intent_recorded');
        return { outcome: 'accepted' as const, messageId: 'msg-1' };
      },
      async readMessage(account: { accountId: string }, messageId: string) {
        return { messageId, observedAt: new Date().toISOString(), recipientId: account.accountId };
      },
    } as never;
    const service = new QueueService(db, provider);
    await service.enqueueReviewed('account', 'auto', ['comment']);
    assert.equal((db.prepare(`SELECT state FROM queue_items WHERE account_id='account' AND comment_id='comment'`).get() as { state: string }).state, 'SIMULATED');
    service.setDryRun(false, true);
    const simulatedCount = db.prepare(`SELECT COUNT(*) AS count FROM queue_items WHERE state='SIMULATED'`).get() as { count: number };
    assert.equal(simulatedCount.count, 1);
    assert.equal(await service.processOne('account'), null);
    assert.equal(observedIntent, false);
  });
});

test('real send observes a committed immutable intent from another SQLite connection before provider dispatch', async () => {
  await withDatabase(async (db, directory) => {
    const account = seedAccount(db);
    db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='conn'`).run();
    db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='account'`).run();
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'real-candidate', text: 'guide',
      username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() });
    const automations = new AutomationService(db);
    const automationId = automations.create({ accountId: 'account', mediaId: 'media', name: 'real', replyText: 'Hi {{username}}' });
    automations.addKeyword('account', automationId, 'guide');
    automations.setEnabled('account', automationId, true);
    automations.setRealEnabled('account', automationId, true, true);
    db.prepare(`INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, observed_at)
      VALUES ('account', 'real-candidate', ?, 'eligible', 'eligible', CURRENT_TIMESTAMP)`).run(automationId);

    const observer = openDatabase(directory);
    let sawCommittedIntent = false;
    let sawPersistedMessageId = false;
    let dispatched = false;
    let providerSendCalls = 0;
    const provider = {
      async getComment(_account: unknown, commentId: string) {
        return { commentId, text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() };
      },
      async sendPrivateReply() {
        providerSendCalls++;
        dispatched = true;
        const row = observer.prepare(`SELECT COUNT(*) AS count FROM send_attempts
          WHERE event_type='intent_recorded' AND queue_item_id=(SELECT queue_item_id FROM queue_items WHERE comment_id='real-candidate')`)
          .get() as { count: number };
        sawCommittedIntent = row.count === 1;
        return { outcome: 'accepted' as const, messageId: 'real-message-id' };
      },
      async readMessage(_account: unknown, messageId: string) {
        const saved = observer.prepare(`SELECT state, payload_json FROM queue_items WHERE comment_id='real-candidate'`)
          .get() as { state: string; payload_json: string };
        sawPersistedMessageId = saved.state === 'SENT'
          && JSON.parse(saved.payload_json).accepted_message_id === messageId;
        return { messageId, observedAt: new Date().toISOString() };
      },
    } as never;
    try {
      const queue = new QueueService(db, provider);
      queue.setDryRun(false, true);
      assert.deepEqual(await queue.enqueueReviewed('account', automationId, ['real-candidate']), ['real-candidate']);
      const ids = await Promise.all([queue.processOne('account'), queue.processOne('account')]);
      assert.ok(ids.some(Boolean));
      assert.equal(dispatched, true);
      assert.equal(providerSendCalls, 1);
      assert.equal(sawCommittedIntent, true);
      assert.equal(sawPersistedMessageId, true);
      assert.equal((db.prepare(`SELECT state FROM queue_items WHERE comment_id='real-candidate'`).get() as { state: string }).state, 'SENT');
      assert.throws(() => db.prepare(`UPDATE send_attempts SET safe_error_code='changed' WHERE event_type='intent_recorded'`).run(), /append-only/i);
    } finally {
      observer.close();
    }
  });
});

test('ambiguous provider outcome is UNKNOWN_OUTCOME and is never automatically retried', async () => {
  await withDatabase(async (db) => {
    seedAccount(db);
    db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='conn'`).run();
    db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='account'`).run();
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'ambiguous', text: 'guide', username: 'customer',
      createdAt: new Date(Date.now() - 1000).toISOString() });
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: 'account', mediaId: 'media', name: 'ambiguous', replyText: 'Hi' });
    automation.addKeyword('account', automationId, 'guide');
    automation.setEnabled('account', automationId, true);
    automation.setRealEnabled('account', automationId, true, true);
    db.prepare(`INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, observed_at)
      VALUES ('account', 'ambiguous', ?, 'eligible', 'eligible', CURRENT_TIMESTAMP)`).run(automationId);
    let sends = 0;
    const provider = {
      async getComment(_account: unknown, commentId: string) {
        return { commentId, text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() };
      },
      async sendPrivateReply() { sends++; return { outcome: 'ambiguous' as const, safeErrorCode: 'meta_timeout' }; },
      async readMessage() { throw new Error('must not read without accepted ID'); },
    } as never;
    const queue = new QueueService(db, provider, { sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed('account', automationId, ['ambiguous']);
    assert.ok(await queue.processOne('account'));
    assert.equal((db.prepare(`SELECT state FROM queue_items WHERE comment_id='ambiguous'`).get() as { state: string }).state, 'UNKNOWN_OUTCOME');
    assert.equal(await queue.processOne('account'), null);
    assert.equal(sends, 1);
  });
});

test('Dry Run switched on during async comment refresh blocks the pre-POST intent claim', async () => {
  await withDatabase(async (db) => {
    seedAccount(db);
    db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='conn'`).run();
    db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='account'`).run();
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'switch-race', text: 'guide', username: 'customer',
      createdAt: new Date(Date.now() - 1000).toISOString() });
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: 'account', mediaId: 'media', name: 'race', replyText: 'Hi' });
    automation.addKeyword('account', automationId, 'guide');
    automation.setEnabled('account', automationId, true);
    automation.setRealEnabled('account', automationId, true, true);
    db.prepare(`INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, observed_at)
      VALUES ('account', 'switch-race', ?, 'eligible', 'eligible', CURRENT_TIMESTAMP)`).run(automationId);
    let sends = 0;
    let queue: QueueService;
    const provider = {
      async getComment(_account: unknown, commentId: string) {
        queue.setDryRun(true);
        return { commentId, text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() };
      },
      async sendPrivateReply() { sends++; return { outcome: 'accepted' as const, messageId: 'should-not-send' }; },
      async readMessage() { throw new Error('unexpected readback'); },
    } as never;
    queue = new QueueService(db, provider, { sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed('account', automationId, ['switch-race']);
    assert.equal(await queue.processOne('account'), null);
    assert.equal(sends, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM send_attempts WHERE event_type='intent_recorded'`).get() as { count: number }).count, 0);
  });
});

test('startup recovery turns an interrupted durable intent into unknown without deleting evidence', async () => {
  await withDatabase((db) => {
    seedAccount(db);
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: 'account', mediaId: 'media', name: 'recovery', replyText: 'Hi' });
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'crashed', text: 'guide',
      username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() });
    db.prepare(`INSERT INTO queue_items(queue_item_id, account_id, comment_id, automation_id, state, dry_run,
      payload_json, created_at, updated_at) VALUES ('queue-crashed', 'account', 'crashed', ?, 'SENDING', 0, '{}', ?, ?)`)
      .run(automationId, new Date().toISOString(), new Date().toISOString());
    db.prepare(`INSERT INTO send_attempts(attempt_event_id, account_id, queue_item_id, event_type, event_at)
      VALUES ('intent-crashed', 'account', 'queue-crashed', 'intent_recorded', ?)`)
      .run(new Date().toISOString());
    const queue = new QueueService(db, {} as never);
    assert.equal(queue.recoverInterrupted(), 1);
    assert.equal((db.prepare(`SELECT state FROM queue_items WHERE queue_item_id='queue-crashed'`).get() as { state: string }).state, 'UNKNOWN_OUTCOME');
    const events = db.prepare(`SELECT event_type FROM send_attempts WHERE queue_item_id='queue-crashed' ORDER BY event_at, attempt_event_id`)
      .all() as Array<{ event_type: string }>;
    assert.deepEqual(events.map((event) => event.event_type).sort(), ['ambiguous_outcome', 'intent_recorded']);
    assert.throws(() => db.prepare(`DELETE FROM send_attempts WHERE attempt_event_id='intent-crashed'`).run(), /append-only/i);
  });
});

test('definitive 429 honors bounded Retry-After and retries only after the deadline', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='conn'`).run();
    db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='account'`).run();
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'rate-limited', text: 'guide', username: 'customer',
      createdAt: new Date(Date.now() - 1000).toISOString() });
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: 'account', mediaId: 'media', name: 'retry', replyText: 'Hi' });
    automation.addKeyword('account', automationId, 'guide');
    automation.setEnabled('account', automationId, true);
    automation.setRealEnabled('account', automationId, true, true);
    db.prepare(`INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, observed_at)
      VALUES ('account', 'rate-limited', ?, 'eligible', 'eligible', CURRENT_TIMESTAMP)`).run(automationId);
    let calls = 0;
    let clock = Date.now();
    const provider = {
      async getComment(_account: unknown, commentId: string) {
        return { commentId, text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() };
      },
      async sendPrivateReply() {
        calls++;
        return calls === 1
          ? { outcome: 'definitive_rejection' as const, httpStatus: 429, safeErrorCode: 'meta_rate_limited', usageHeaders: { retryAfter: '30' } }
          : { outcome: 'accepted' as const, messageId: 'after-retry' };
      },
      async readMessage(_account: unknown, messageId: string) { return { messageId, observedAt: new Date().toISOString() }; },
    } as never;
    const queue = new QueueService(db, provider, { sendSpacingMs: 0, clock: () => clock });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed('account', automationId, ['rate-limited']);
    assert.ok(await queue.processOne('account'));
    clock += 29_000;
    assert.equal(await queue.processOne('account'), null);
    clock += 2_000;
    assert.ok(await queue.processOne('account'));
    assert.equal(calls, 2);
    assert.equal((db.prepare(`SELECT state FROM queue_items WHERE comment_id='rate-limited'`).get() as { state: string }).state, 'SENT');
  });
});

test('a delayed comment-refresh failure cannot overwrite a newer sent outcome', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='conn'`).run();
    db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='account'`).run();
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'race', text: 'guide', username: 'customer',
      createdAt: new Date(Date.now() - 1000).toISOString() });
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: 'account', mediaId: 'media', name: 'race', replyText: 'Hi' });
    automation.addKeyword('account', automationId, 'guide');
    automation.setEnabled('account', automationId, true);
    automation.setRealEnabled('account', automationId, true, true);
    db.prepare(`INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, observed_at)
      VALUES ('account', 'race', ?, 'eligible', 'eligible', CURRENT_TIMESTAMP)`).run(automationId);
    let releaseFirst!: (error: Error) => void;
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    let refreshCalls = 0;
    let sends = 0;
    const provider = {
      async getComment() {
        refreshCalls++;
        if (refreshCalls === 1) {
          firstStarted();
          return await new Promise<never>((_resolve, reject) => { releaseFirst = reject; });
        }
        return { commentId: 'race', text: 'guide', username: 'customer', createdAt: new Date(Date.now() - 1000).toISOString() };
      },
      async sendPrivateReply() { sends++; return { outcome: 'accepted', messageId: 'sent-race' }; },
      async readMessage() { return { messageId: 'sent-race', observedAt: new Date().toISOString() }; },
    } as never;
    const queue = new QueueService(db, provider, { sendSpacingMs: 0 });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed('account', automationId, ['race']);
    const first = queue.processOne('account');
    await firstStartedPromise;
    assert.equal(await queue.processOne('account'), null);
    db.prepare(`UPDATE queue_items SET state='SENT' WHERE queue_item_id=(SELECT queue_item_id FROM queue_items WHERE comment_id='race')`).run();
    releaseFirst(new Error('delayed refresh failure'));
    await first;

    assert.equal((db.prepare(`SELECT state FROM queue_items WHERE comment_id='race'`).get() as { state: string }).state, 'SENT');
    assert.equal(sends, 0);
    const events = db.prepare(`SELECT event_type FROM send_attempts WHERE queue_item_id=(SELECT queue_item_id FROM queue_items WHERE comment_id='race') ORDER BY event_at`).all() as Array<{ event_type: string }>;
    assert.equal(events.some((event) => event.event_type === 'retryable_failure'), false);
  });
});

test('provider Retry-After longer than the local backoff cap is never shortened', async () => {
  await withDatabase(async (db) => {
    const account = seedAccount(db);
    db.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='conn'`).run();
    db.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='account'`).run();
    createComment(db, { accountId: 'account', mediaId: 'media', commentId: 'long-retry', text: 'guide', username: 'customer',
      createdAt: new Date(Date.now() - 1000).toISOString() });
    const automation = new AutomationService(db);
    const automationId = automation.create({ accountId: 'account', mediaId: 'media', name: 'long-retry', replyText: 'Hi' });
    automation.addKeyword('account', automationId, 'guide');
    automation.setEnabled('account', automationId, true);
    automation.setRealEnabled('account', automationId, true, true);
    db.prepare(`INSERT INTO comment_classifications(account_id, comment_id, automation_id, result, reason, observed_at)
      VALUES ('account', 'long-retry', ?, 'eligible', 'eligible', CURRENT_TIMESTAMP)`).run(automationId);
    const now = Date.now();
    const queue = new QueueService(db, {
      async getComment() { return { commentId: 'long-retry', text: 'guide', username: 'customer', createdAt: new Date(now - 1000).toISOString() }; },
      async sendPrivateReply() { return { outcome: 'definitive_rejection', httpStatus: 429, safeErrorCode: 'rate_limited', usageHeaders: { retryAfter: '3600' } }; },
    } as never, { sendSpacingMs: 0, clock: () => now });
    queue.setDryRun(false, true);
    await queue.enqueueReviewed('account', automationId, ['long-retry']);
    await queue.processOne('account');
    const row = db.prepare(`SELECT next_attempt_at FROM queue_items WHERE comment_id='long-retry'`).get() as { next_attempt_at: string };
    assert.ok(Date.parse(row.next_attempt_at) >= now + 3_600_000);
  });
});

async function withDatabase(run: (db: ReturnType<typeof openDatabase>, directory: string) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'social-automation-engine-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  try {
    await run(db, directory);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seedAccount(db: ReturnType<typeof openDatabase>) {
  createConnection(db, {
    id: 'conn', name: 'test', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
    status: 'valid', accessToken: { nonce: 'fixture-nonce', ciphertext: 'fixture-ciphertext', tag: 'fixture-tag' },
  });
  addDiscoveredAccount(db, {
    accountId: 'account', connectionId: 'conn', providerAccountId: 'provider-account', username: 'brand', status: 'valid',
  });
  createMedia(db, { accountId: 'account', mediaId: 'media', permalink: null, publishedAt: null });
  return { accountId: 'account', connectionId: 'conn', providerAccountId: 'provider-account', username: 'brand' };
}
