import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/db/migrations.ts';
import * as moderation from '../src/services/moderation.ts';
import { createApiHandler } from '../src/http/router.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { createScheduler } from '../src/services/scheduler.ts';
import type { ModerationResult, SocialProvider } from '../src/core/domain.ts';
import * as labels from '../app/moderation-labels.ts';

type FlagSeed = { id: string; account?: string; state?: string; category?: string; createdAt?: string };

async function withDb(fn: (db: DatabaseSync) => unknown | Promise<unknown>): Promise<void> {
  const db = new DatabaseSync(':memory:');
  try {
    migrateDatabase(db);
    db.exec('PRAGMA foreign_keys = ON');
    await fn(db);
  } finally {
    db.close();
  }
}

function seed(db: DatabaseSync, options: { dryRun?: boolean; flags?: FlagSeed[] } = {}): void {
  db.exec(`
    INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
      VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
    INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
      VALUES ('acc1', 'conn1', 'ig1', 'tu_cuenta', 'tu_cuenta', 'valid', '2026', '2026');
    INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
      VALUES ('acc2', 'conn1', 'ig2', 'otra_cuenta', 'otra_cuenta', 'valid', '2026', '2026');
    INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p1', '2026', '2026');
    INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m2', 'acc2', 'p2', '2026', '2026');
  `);
  db.exec(`UPDATE social_accounts SET monitoring_paused=0`);
  db.prepare(`INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', ?, '2026')`)
    .run(options.dryRun ? 'true' : 'false');
  for (const flag of options.flags ?? []) {
    const account = flag.account ?? 'acc1';
    const media = account === 'acc1' ? 'm1' : 'm2';
    const commentId = `c_${flag.id}`;
    // Auto-hide compares the COMMENT date: the seeded comment is published when its flag was created.
    db.prepare(`INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, 'text', 'commenter', ?, '2026', '2026')`).run(commentId, account, media, flag.createdAt ?? '2026-01-01T00:00:00.000Z');
    db.prepare(`INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state,
      created_at, updated_at, settings_version) VALUES (?, ?, ?, ?, ?, 'rules', '[]', ?, ?, '2026', 1)`)
      .run(flag.id, account, media, commentId, flag.category ?? 'spam_link', flag.state ?? 'PENDING', flag.createdAt ?? '2026-01-01T00:00:00.000Z');
  }
}

type FakeProvider = SocialProvider & { calls: string[] };

function fakeProvider(results: Record<string, ModerationResult> = {}, onCall?: (commentId: string) => void): FakeProvider {
  const calls: string[] = [];
  return {
    calls,
    async setCommentHidden(_account: unknown, commentId: string, hidden: boolean) {
      calls.push(`${hidden ? 'hide' : 'unhide'}:${commentId}`);
      onCall?.(commentId);
      return results[commentId] ?? { status: 'accepted' };
    },
    async deleteComment(_account: unknown, commentId: string) {
      calls.push(`delete:${commentId}`);
      onCall?.(commentId);
      return results[commentId] ?? { status: 'accepted' };
    },
  } as unknown as FakeProvider;
}

function state(db: DatabaseSync, flagId: string): string {
  return (db.prepare(`SELECT state FROM moderation_flags WHERE flag_id=?`).get(flagId) as { state: string }).state;
}

async function withApi(
  db: DatabaseSync,
  provider: SocialProvider,
  fn: (call: (path: string, method: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<void>,
): Promise<void> {
  const deps = { database: db, provider, automations: {} as never, scanner: {} as never, backlog: {} as never, queue: {} as never, csrfToken: 'csrf' };
  const server = createServer(createApiHandler(deps as never));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(async (path, method, body) => {
      const response = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf', origin: base },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    server.close();
  }
}

// ---------- B1: scheduler wiring ----------

test('B1: server.ts builds the scheduler through createScheduler (moderation wired)', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(server, /createScheduler\(/);
  assert.doesNotMatch(server, /new Scheduler\(/);
});

test('B1: createScheduler recovers *_INTENT flags at startup and auto-hides one allowed PENDING flag per tick in real mode', async () => {
  await withDb(async (db) => {
    seed(db, {
      flags: [
        { id: 'fi', state: 'HIDE_INTENT' },
        { id: 'fd', state: 'DELETE_INTENT' },
        { id: 'fa', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'fb', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
    });
    db.exec(`INSERT INTO moderation_settings(account_id, enabled, auto_hide_enabled, auto_hide_categories_json, auto_hide_since, updated_at)
      VALUES ('acc1', 1, 1, '["spam_link"]', '2025-01-01T00:00:00.000Z', '2026')`);
    const provider = fakeProvider();
    const queue = new QueueService(db, provider as never, { sendSpacingMs: 0, publicReplySpacingMs: 0 } as never);
    const scheduler = createScheduler(db, new Scanner(db, provider as never), queue, { provider });
    assert.equal(state(db, 'fi'), 'UNKNOWN_OUTCOME');
    assert.equal(state(db, 'fd'), 'UNKNOWN_OUTCOME');
    scheduler.startAll();
    try {
      await scheduler.tick();
    } finally {
      scheduler.stopAll();
    }
    assert.deepEqual(provider.calls, ['hide:c_fa']);
    assert.equal(state(db, 'fa'), 'HIDDEN');
    assert.equal(state(db, 'fb'), 'PENDING');
  });
});

// ---------- B2 / M2: bulk delete confirmation, strict confirmed ----------

test('B2: bulk delete requires body.confirmed === true; with it the flags are deleted', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }] });
    const provider = fakeProvider();
    await withApi(db, provider, async (call) => {
      for (const confirmed of [undefined, false, 'yes', 1]) {
        const res = await call('/api/moderation/flags/bulk', 'POST', { accountId: 'acc1', flagIds: ['f1'], action: 'delete', confirmed });
        assert.equal(res.status, 400, `confirmed=${String(confirmed)}`);
        assert.equal(res.body.error, 'confirmation_required');
      }
      assert.equal(provider.calls.length, 0);
      const ok = await call('/api/moderation/flags/bulk', 'POST', { accountId: 'acc1', flagIds: ['f1'], action: 'delete', confirmed: true });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.body, { results: [{ flagId: 'f1', state: 'DELETED' }] });
      assert.deepEqual(provider.calls, ['delete:c_f1']);
    });
  });
});

test('B2: the UI bulk delete warns about permanence with the count and sends confirmed', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('`Vas a borrar ${selectedIds.length} comentarios. Borrar es permanente y no se puede deshacer.`'));
  assert.match(page, /\/api\/moderation\/flags\/bulk', 'POST', \{[^}]*confirmed: action === 'delete'/);
});

test('M2: single delete and settings reject non-boolean confirmed values', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }] });
    const provider = fakeProvider();
    await withApi(db, provider, async (call) => {
      for (const confirmed of ['no', 1]) {
        const del = await call('/api/moderation/flags/f1/delete', 'POST', { accountId: 'acc1', confirmed });
        assert.equal(del.status, 400);
        assert.equal(del.body.error, 'confirmation_required');
        const put = await call('/api/moderation/settings', 'PUT', {
          accountId: 'acc1', enabled: true, blockedTerms: [], autoHideEnabled: true, autoHideCategories: ['spam_link'], confirmed,
        });
        assert.equal(put.status, 400);
        assert.equal(put.body.error, 'confirmation_required');
      }
      assert.equal(provider.calls.length, 0);
      assert.equal(moderation.getSettings(db, 'acc1').autoHideEnabled, false);
    });
  });
});

// ---------- B3: all-or-nothing ownership, per-flag results ----------

test('B3: bulk with a flag of another account is rejected with 404 and acts on none', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }, { id: 'g1', account: 'acc2' }] });
    const provider = fakeProvider();
    await withApi(db, provider, async (call) => {
      for (const action of ['hide', 'dismiss']) {
        const res = await call('/api/moderation/flags/bulk', 'POST', { accountId: 'acc1', flagIds: ['f1', 'g1'], action });
        assert.equal(res.status, 404);
        assert.equal(res.body.error, 'not_found');
      }
      const missing = await call('/api/moderation/flags/bulk', 'POST', { accountId: 'acc1', flagIds: ['f1', 'nope'], action: 'hide' });
      assert.equal(missing.status, 404);
    });
    assert.equal(provider.calls.length, 0);
    assert.equal(state(db, 'f1'), 'PENDING');
    assert.equal(state(db, 'g1'), 'PENDING');
  });
});

test('B3: bulk validates 1..100 unique ids and the action', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }] });
    const provider = fakeProvider();
    await withApi(db, provider, async (call) => {
      const bodies = [
        { accountId: 'acc1', flagIds: [], action: 'hide' },
        { accountId: 'acc1', flagIds: ['f1', 'f1'], action: 'hide' },
        { accountId: 'acc1', flagIds: Array.from({ length: 101 }, (_, i) => `x${i}`), action: 'hide' },
        { accountId: 'acc1', flagIds: ['f1'], action: 'explode' },
        { accountId: 'acc1', flagIds: [42], action: 'hide' },
      ];
      for (const body of bodies) assert.equal((await call('/api/moderation/flags/bulk', 'POST', body)).status, 400);
    });
    assert.equal(provider.calls.length, 0);
    await assert.rejects(moderation.executeBulkAction(db, provider, 'acc1', ['f1', 'f1'], 'hide'), TypeError);
  });
});

test('B3: per-flag invalid_state is reported and the batch continues; unhide is supported', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1', state: 'DELETED' }, { id: 'f2' }, { id: 'f3', state: 'HIDDEN' }] });
    const provider = fakeProvider();
    const sleeps: number[] = [];
    const hide = await moderation.executeBulkAction(db, provider, 'acc1', ['f1', 'f2'], 'hide', { sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(hide.results, [
      { flagId: 'f1', state: 'DELETED', error: 'invalid_state' },
      { flagId: 'f2', state: 'HIDDEN' },
    ]);
    const unhide = await moderation.executeBulkAction(db, provider, 'acc1', ['f3'], 'unhide', { sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(unhide.results, [{ flagId: 'f3', state: 'VISIBLE' }]);
    assert.deepEqual(provider.calls, ['hide:c_f2', 'unhide:c_f3']);
  });
});

test('B3: real provider calls are spaced 1 s apart and a rate limit stops the batch', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }, { id: 'f4' }] });
    const provider = fakeProvider({ c_f2: { status: 'rejected', safeErrorCode: 'moderation_rate_limited' } });
    const sleeps: number[] = [];
    const { results } = await moderation.executeBulkAction(db, provider, 'acc1', ['f1', 'f2', 'f3', 'f4'], 'hide', { sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(provider.calls, ['hide:c_f1', 'hide:c_f2']);
    assert.deepEqual(sleeps, [1000]);
    assert.deepEqual(results, [
      { flagId: 'f1', state: 'HIDDEN' },
      { flagId: 'f2', state: 'FAILED', safeErrorCode: 'moderation_rate_limited' },
      { flagId: 'f3', state: 'PENDING', error: 'not_attempted' },
      { flagId: 'f4', state: 'PENDING', error: 'not_attempted' },
    ]);
  });
});

test('B3: bulk in Dry Run simulates every flag without provider calls or waits', async () => {
  await withDb(async (db) => {
    seed(db, { dryRun: true, flags: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }] });
    const provider = fakeProvider();
    const sleeps: number[] = [];
    const { results } = await moderation.executeBulkAction(db, provider, 'acc1', ['f1', 'f2', 'f3'], 'delete', { confirmed: true, sleep: async (ms) => { sleeps.push(ms); } });
    assert.deepEqual(results.map((r) => r.state), ['SIMULATED', 'SIMULATED', 'SIMULATED']);
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(sleeps, []);
  });
});

test('B3: executeBulkAction refuses delete without confirmation before touching anything', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }] });
    const provider = fakeProvider();
    await assert.rejects(moderation.executeBulkAction(db, provider, 'acc1', ['f1'], 'delete'), /confirmation_required/);
    assert.equal(provider.calls.length, 0);
    assert.equal(state(db, 'f1'), 'PENDING');
  });
});

// ---------- B4 / L4: dismiss rules ----------

test('B4: bulk dismiss only moves PENDING, FAILED and SIMULATED; never UNKNOWN_OUTCOME or other states', async () => {
  await withDb(async (db) => {
    const states = ['PENDING', 'FAILED', 'SIMULATED', 'HIDE_INTENT', 'UNHIDE_INTENT', 'DELETE_INTENT', 'HIDDEN', 'DELETED', 'VISIBLE', 'UNKNOWN_OUTCOME'];
    seed(db, { flags: states.map((s, i) => ({ id: `f${i}`, state: s })) });
    const provider = fakeProvider();
    const { results } = await moderation.executeBulkAction(db, provider, 'acc1', states.map((_, i) => `f${i}`), 'dismiss');
    assert.deepEqual(results, states.map((s, i) => i < 3
      ? { flagId: `f${i}`, state: 'DISMISSED' }
      : { flagId: `f${i}`, state: s, error: 'invalid_state' }));
    assert.equal(provider.calls.length, 0);
  });
});

test('L4: single dismiss resolves UNKNOWN_OUTCOME (manual check); other accounts get not_found', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1', state: 'UNKNOWN_OUTCOME' }, { id: 'f2', state: 'HIDDEN' }, { id: 'g1', account: 'acc2' }] });
    moderation.dismiss(db, 'acc1', 'f1');
    assert.equal(state(db, 'f1'), 'DISMISSED');
    assert.throws(() => moderation.dismiss(db, 'acc1', 'f2'), /invalid_state/);
    assert.throws(() => moderation.dismiss(db, 'acc1', 'g1'), /not_found/);
    assert.equal(state(db, 'g1'), 'PENDING');
  });
});

// ---------- M1: confirmation only on escalation ----------

test('M1: saving rules with auto-hide already enabled needs no confirmation unless a category is added', async () => {
  await withDb(async (db) => {
    seed(db);
    const base = { enabled: true, blockedTerms: [], detectLinks: true, detectPhones: true, detectMentions: true, detectEmoji: false };
    assert.throws(() => moderation.updateSettings(db, 'acc1', { ...base, autoHideEnabled: true, autoHideCategories: ['spam_link'] }, false), /confirmation_required/);
    moderation.updateSettings(db, 'acc1', { ...base, autoHideEnabled: true, autoHideCategories: ['spam_link', 'spam_phone'] }, true);
    // Same categories, other edits: no confirmation.
    moderation.updateSettings(db, 'acc1', { ...base, blockedTerms: ['estafa'], autoHideEnabled: true, autoHideCategories: ['spam_phone', 'spam_link'] }, false);
    // Removing a category is not an escalation.
    moderation.updateSettings(db, 'acc1', { ...base, autoHideEnabled: true, autoHideCategories: ['spam_link'] }, false);
    assert.deepEqual(moderation.getSettings(db, 'acc1').autoHideCategories, ['spam_link']);
    // Gaining a category again is.
    assert.throws(() => moderation.updateSettings(db, 'acc1', { ...base, autoHideEnabled: true, autoHideCategories: ['spam_link', 'blocked_term'] }, false), /confirmation_required/);
    // Disabling and re-enabling requires confirmation again.
    moderation.updateSettings(db, 'acc1', { ...base, autoHideEnabled: false, autoHideCategories: ['spam_link'] }, false);
    assert.throws(() => moderation.updateSettings(db, 'acc1', { ...base, autoHideEnabled: true, autoHideCategories: ['spam_link'] }, false), /confirmation_required/);
  });
});

test('M1: PUT settings through the API keeps working without confirmed when auto-hide stays as it was', async () => {
  await withDb(async (db) => {
    seed(db);
    await withApi(db, fakeProvider(), async (call) => {
      const body = { accountId: 'acc1', enabled: true, blockedTerms: [], detectLinks: true, detectPhones: true, detectMentions: true, detectEmoji: false, autoHideEnabled: true, autoHideCategories: ['spam_link'] };
      assert.equal((await call('/api/moderation/settings', 'PUT', { ...body, confirmed: true })).status, 200);
      const again = await call('/api/moderation/settings', 'PUT', { ...body, blockedTerms: ['estafa'] });
      assert.equal(again.status, 200);
      assert.deepEqual(again.body.blockedTerms, ['estafa']);
    });
  });
});

// ---------- L1: expected-state guards ----------

test('L1: the intent UPDATE is guarded by the expected state (concurrent change → no provider call)', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }] });
    const originalExec = db.exec.bind(db);
    let raced = false;
    // Another writer commits a state change between the pre-check read and the intent transaction.
    db.exec = ((sql: string) => {
      if (sql === 'BEGIN IMMEDIATE' && !raced) {
        raced = true;
        db.prepare(`UPDATE moderation_flags SET state='DELETED' WHERE flag_id='f1'`).run();
      }
      return originalExec(sql);
    }) as typeof db.exec;
    const provider = fakeProvider();
    await assert.rejects(moderation.act(db, provider, 'acc1', 'f1', 'hide', 'operator'), /invalid_state/);
    assert.equal(provider.calls.length, 0);
    assert.equal(state(db, 'f1'), 'DELETED');
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM moderation_actions`).get() as { n: number }).n, 0);
  });
});

test('L1: the result UPDATE only applies while the flag is still in its intent state', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }] });
    // Simulates a startup recovery (or any writer) moving the flag while the provider call is in flight.
    const provider = fakeProvider({}, () => { db.prepare(`UPDATE moderation_flags SET state='UNKNOWN_OUTCOME' WHERE flag_id='f1'`).run(); });
    await moderation.act(db, provider, 'acc1', 'f1', 'hide', 'operator');
    assert.equal(state(db, 'f1'), 'UNKNOWN_OUTCOME');
    const outcomes = db.prepare(`SELECT outcome FROM moderation_actions WHERE flag_id='f1' ORDER BY rowid`).all() as Array<{ outcome: string }>;
    assert.deepEqual(outcomes.map((o) => o.outcome), ['intent', 'accepted']);
  });
});

// ---------- L2: SIMULATED never leads to a real unhide ----------

test('L2: unhide is not allowed from SIMULATED (hide, delete and dismiss are)', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1', state: 'SIMULATED' }, { id: 'f2', state: 'SIMULATED' }] });
    const provider = fakeProvider();
    await assert.rejects(moderation.act(db, provider, 'acc1', 'f1', 'unhide', 'operator'), /invalid_state/);
    assert.equal(provider.calls.length, 0);
    await moderation.act(db, provider, 'acc1', 'f1', 'hide', 'operator');
    assert.equal(state(db, 'f1'), 'HIDDEN');
    moderation.dismiss(db, 'acc1', 'f2');
    assert.equal(state(db, 'f2'), 'DISMISSED');
  });
});

// ---------- M4: auto-hide safety ----------

test('M4: auto-hide does nothing in Dry Run, never deletes and skips held or invalid accounts', async () => {
  await withDb(async (db) => {
    seed(db, { dryRun: true, flags: [{ id: 'f1' }, { id: 'g1', account: 'acc2' }] });
    db.exec(`INSERT INTO moderation_settings(account_id, enabled, auto_hide_enabled, auto_hide_categories_json, auto_hide_since, updated_at)
      VALUES ('acc1', 1, 1, '["spam_link"]', '2025-01-01T00:00:00.000Z', '2026'), ('acc2', 1, 1, '["spam_link"]', '2025-01-01T00:00:00.000Z', '2026')`);
    const provider = fakeProvider();
    await moderation.processAutoHide(db, provider);
    assert.equal(provider.calls.length, 0);
    assert.equal(state(db, 'f1'), 'PENDING');

    db.exec(`UPDATE app_state SET state_value='false' WHERE state_key='dry_run'`);
    db.exec(`INSERT INTO account_send_holds(account_id, reason_code, created_at) VALUES ('acc1', 'legacy_lock_present', '2026')`);
    db.exec(`UPDATE social_accounts SET status='disconnected' WHERE account_id='acc2'`);
    await moderation.processAutoHide(db, provider);
    assert.equal(provider.calls.length, 0);

    db.exec(`DELETE FROM account_send_holds`);
    await moderation.processAutoHide(db, provider);
    assert.deepEqual(provider.calls, ['hide:c_f1']);
    assert.equal(state(db, 'f1'), 'HIDDEN');
    assert.equal(state(db, 'g1'), 'PENDING');
    const actions = db.prepare(`SELECT action, actor FROM moderation_actions`).all() as Array<{ action: string; actor: string }>;
    assert.ok(actions.every((a) => a.action === 'hide' && a.actor === 'auto'));
  });
});

// ---------- L5 / L6: source hygiene ----------

test('L5: moderation tests carry no console debug output', () => {
  const source = readFileSync(new URL('./moderation.test.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.(log|error)/);
});

test('L6: the diagnostics JSDoc sits directly above diagnoseConversation', () => {
  // Normalize CRLF: Windows checkouts convert line endings.
  const source = readFileSync(new URL('../src/providers/meta/provider.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /Calls are spaced \(Meta documents 2 calls\/s for this API\)\.\n\s*\*\/\n\s*async diagnoseConversation\(/);
});

// ---------- Docs ----------

test('Docs: README, REFERENCIA-TECNICA and AGENTS describe the moderation rules', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const readme = read('../README.md');
  assert.match(readme, /## Moderación de comentarios/);
  assert.match(readme, /Nada se borra nunca automáticamente/);
  const reference = read('../docs/REFERENCIA-TECNICA.md');
  for (const fragment of ['nada se borra nunca automáticamente', 'not_attempted', 'confirmation_required', 'account_invalid_or_held',
    '7 o más dígitos', '3 o más', '10 s', 'DELETE /{comment-id}', 'transmisiones en vivo', 'Esquema (v16, ampliado en v17 y v18)', 'moderation_rate_limited',
    '### Revisión con IA', 'x-goog-api-key', 'ai_rate_limited', 'ai_job_running', 'moderation_ai_jobs', 'confirmed: true']) {
    assert.ok(reference.includes(fragment), fragment);
  }
  const agents = read('../AGENTS.md');
  assert.match(agents, /esquema v1\.\.v18/);
  assert.match(agents, /moderation-ai-local/);
  assert.ok(reference.includes('### Modelo local') && reference.includes('/api/moderation/ai-local/download'), 'local model documented');
  assert.match(readme, /Modelo local: gratis y 100 % privado/);
  assert.match(agents, /moderation-ai/);
  assert.match(readme, /### Revisión con IA/);
  assert.match(agents, /moderation-rules/);
});

// ---------- Round 4 ----------

test('R4-1: the UI never JSON.parses reasons (the API already returns an array)', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /JSON\.parse\(flag\.reasons/);
  assert.match(page, /reasonsText\(flag\.reasons\)/);
});

test('R4-1: reasonsText and categoryLabel are defensive pure helpers', () => {
  assert.equal(labels.reasonsText(['Contiene un enlace', 'Posible número de teléfono']), 'Contiene un enlace, Posible número de teléfono');
  assert.equal(labels.reasonsText(undefined), '');
  assert.equal(labels.reasonsText('["x"]'), '');
  assert.equal(labels.reasonsText(['ok', 3, null]), 'ok');
  assert.equal(labels.categoryLabel('spam_link'), 'Enlace');
  assert.equal(labels.categoryLabel('nueva'), 'nueva');
  assert.equal(labels.stateLabel('UNKNOWN_OUTCOME'), 'Por revisar');
});

test('R4-2: auto-hide never acts on an account whose monitoring is paused', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }] });
    db.exec(`INSERT INTO moderation_settings(account_id, enabled, auto_hide_enabled, auto_hide_categories_json, auto_hide_since, updated_at)
      VALUES ('acc1', 1, 1, '["spam_link"]', '2025-01-01T00:00:00.000Z', '2026')`);
    db.exec(`UPDATE social_accounts SET monitoring_paused=1 WHERE account_id='acc1'`);
    const provider = fakeProvider();
    await moderation.processAutoHide(db, provider);
    assert.equal(provider.calls.length, 0);
    assert.equal(state(db, 'f1'), 'PENDING');
    db.exec(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='acc1'`);
    await moderation.processAutoHide(db, provider);
    assert.deepEqual(provider.calls, ['hide:c_f1']);
  });
});

test('R4-3: auto-hide is not retroactive (only comments published since it was enabled)', async () => {
  await withDb(async (db) => {
    const before = new Date(Date.now() - 60_000).toISOString();
    seed(db, { flags: [{ id: 'old', createdAt: before }] });
    const base = { enabled: true, blockedTerms: [], detectLinks: true, detectPhones: true, detectMentions: true, detectEmoji: false };
    moderation.updateSettings(db, 'acc1', { ...base, autoHideEnabled: true, autoHideCategories: ['spam_link'] }, true);
    const since = (db.prepare(`SELECT auto_hide_since FROM moderation_settings WHERE account_id='acc1'`).get() as { auto_hide_since: string | null }).auto_hide_since;
    assert.ok(since && since > before);
    // Saving again while enabled keeps the original start.
    moderation.updateSettings(db, 'acc1', { ...base, blockedTerms: ['estafa'], autoHideEnabled: true, autoHideCategories: ['spam_link'] }, false);
    assert.equal((db.prepare(`SELECT auto_hide_since FROM moderation_settings WHERE account_id='acc1'`).get() as { auto_hide_since: string }).auto_hide_since, since);
    const provider = fakeProvider();
    await moderation.processAutoHide(db, provider);
    assert.equal(provider.calls.length, 0);
    assert.equal(state(db, 'old'), 'PENDING');

    db.prepare(`INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at)
      VALUES ('c_new', 'acc1', 'm1', 'text', 'commenter', ?, '2026', '2026')`).run(new Date(Date.now() + 1000).toISOString());
    db.prepare(`INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
      VALUES ('new', 'acc1', 'm1', 'c_new', 'spam_link', 'rules', '[]', 'PENDING', ?, '2026', 1)`).run(new Date(Date.now() + 1000).toISOString());
    await moderation.processAutoHide(db, provider);
    assert.deepEqual(provider.calls, ['hide:c_new']);

    moderation.updateSettings(db, 'acc1', { ...base, autoHideEnabled: false, autoHideCategories: ['spam_link'] }, false);
    assert.equal((db.prepare(`SELECT auto_hide_since FROM moderation_settings WHERE account_id='acc1'`).get() as { auto_hide_since: string | null }).auto_hide_since, null);
  });
});

test('R4-3: the auto-hide confirmation says it only applies from now on', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('Solo se aplica a comentarios publicados desde ahora.'));
});

test('R4-4: single and bulk dismiss write an audit row', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }, { id: 'f2', state: 'FAILED' }, { id: 'f3' }] });
    moderation.dismiss(db, 'acc1', 'f1');
    await moderation.executeBulkAction(db, fakeProvider(), 'acc1', ['f2'], 'dismiss');
    db.exec(`UPDATE app_state SET state_value='true' WHERE state_key='dry_run'`);
    moderation.dismiss(db, 'acc1', 'f3');
    const rows = db.prepare(`SELECT flag_id, comment_id, action, actor, mode, outcome FROM moderation_actions ORDER BY rowid`).all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { flag_id: 'f1', comment_id: 'c_f1', action: 'dismiss', actor: 'operator', mode: 'real', outcome: 'accepted' },
      { flag_id: 'f2', comment_id: 'c_f2', action: 'dismiss', actor: 'operator', mode: 'real', outcome: 'accepted' },
      { flag_id: 'f3', comment_id: 'c_f3', action: 'dismiss', actor: 'operator', mode: 'dry_run', outcome: 'accepted' },
    ]);
    // A refused dismiss writes nothing.
    assert.throws(() => moderation.dismiss(db, 'acc1', 'f1'), /invalid_state/);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM moderation_actions`).get() as { n: number }).n, 3);
  });
});

test('R4-6: UI action availability mirrors the service transition tables', () => {
  assert.deepEqual(labels.ACTION_STATES.hide, [...moderation.VALID_TRANSITIONS.hide]);
  assert.deepEqual(labels.ACTION_STATES.unhide, [...moderation.VALID_TRANSITIONS.unhide]);
  assert.deepEqual(labels.ACTION_STATES.delete, [...moderation.VALID_TRANSITIONS.delete]);
  assert.deepEqual(labels.ACTION_STATES.dismiss, [...moderation.SINGLE_DISMISS_STATES]);
  assert.deepEqual(labels.ACTION_STATES.bulkDismiss, [...moderation.BULK_DISMISS_STATES]);
  assert.deepEqual(labels.availableActions('PENDING'), { hide: true, unhide: false, delete: true, dismiss: true });
  assert.deepEqual(labels.availableActions('HIDDEN'), { hide: false, unhide: true, delete: true, dismiss: false });
  assert.deepEqual(labels.availableActions('UNKNOWN_OUTCOME'), { hide: false, unhide: false, delete: false, dismiss: true });
  assert.deepEqual(labels.availableActions('DELETED'), { hide: false, unhide: false, delete: false, dismiss: false });
  assert.deepEqual(labels.availableActions('SIMULATED'), { hide: true, unhide: false, delete: true, dismiss: true });
  assert.equal(labels.bulkAllowed('dismiss', ['UNKNOWN_OUTCOME']), false);
  assert.equal(labels.bulkAllowed('dismiss', ['UNKNOWN_OUTCOME', 'PENDING']), true);
  assert.equal(labels.bulkAllowed('unhide', ['PENDING', 'SIMULATED']), false);
});

test('R4-6: bulkSummary counts results in Spanish', () => {
  assert.equal(labels.bulkSummary([
    { flagId: 'a', state: 'HIDDEN' }, { flagId: 'b', state: 'HIDDEN' }, { flagId: 'c', state: 'HIDDEN' },
    { flagId: 'd', state: 'DELETED', error: 'invalid_state' },
  ]), '3 ocultados, 1 sin cambios');
  assert.equal(labels.bulkSummary([
    { flagId: 'a', state: 'SIMULATED' }, { flagId: 'b', state: 'FAILED', safeErrorCode: 'moderation_rate_limited' },
    { flagId: 'c', state: 'PENDING', error: 'not_attempted' }, { flagId: 'd', state: 'UNKNOWN_OUTCOME', safeErrorCode: 'x' },
  ]), '1 simulado, 1 falló, 1 por revisar, 1 no intentado');
  assert.equal(labels.bulkSummary([{ flagId: 'a', state: 'DISMISSED' }]), '1 descartado');
  assert.equal(labels.bulkSummary([]), 'Sin cambios');
});

test('R4-6: pagination renders the computed range and the UI uses the helpers', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.ok(!page.includes('- Math.min(offset + 50, total) de'));
  assert.ok(page.includes('{Math.min(offset + 50, total)}'));
  assert.match(page, /availableActions\(flag\.state\)/);
  assert.match(page, /bulkSummary\(/);
});

test('R4-7: no leftover monologue comments in moderation tests', () => {
  const source = readFileSync(new URL('./moderation.test.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Wait, let's|Actually, wait/);
});

test('R4-5: docs cover bulk stop on account_invalid_or_held, real permission codes, pause, non-retroactive and dismiss audit', () => {
  const reference = readFileSync(new URL('../docs/REFERENCIA-TECNICA.md', import.meta.url), 'utf8');
  for (const fragment of ['operation_rejected', 'códigos 3, 10, 102 o 190', 'monitoring_paused', 'auto_hide_since', 'no es retroactivo', "action = 'dismiss'"]) {
    assert.ok(reference.includes(fragment), fragment);
  }
  assert.match(reference, /`account_invalid_or_held`[^\n]*detiene el lote|detiene el lote[^\n]*`account_invalid_or_held`/);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /desde que lo activas/);
  assert.match(readme, /pausad/);
});

test('R4-5: bulk stops at account_invalid_or_held and reports the rest as not_attempted', async () => {
  await withDb(async (db) => {
    seed(db, { flags: [{ id: 'f1' }, { id: 'f2' }] });
    db.exec(`INSERT INTO account_send_holds(account_id, reason_code, created_at) VALUES ('acc1', 'legacy_lock_present', '2026')`);
    const provider = fakeProvider();
    const { results } = await moderation.executeBulkAction(db, provider, 'acc1', ['f1', 'f2'], 'hide', { sleep: async () => {} });
    assert.deepEqual(results, [
      { flagId: 'f1', state: 'PENDING', error: 'account_invalid_or_held' },
      { flagId: 'f2', state: 'PENDING', error: 'not_attempted' },
    ]);
    assert.equal(provider.calls.length, 0);
  });
});
