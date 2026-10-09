import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../src/db/migrations.ts';
import { listEncryptedCredentials } from '../src/db/repositories.ts';
import { createVault, type CredentialVault } from '../src/security/vault.ts';
import { createApiHandler } from '../src/http/router.ts';
import * as moderation from '../src/services/moderation.ts';
import {
  AI_CHUNK_SIZE, AI_CHUNK_SPACING_MS, AI_MAX_COMMENTS, AI_TEXT_LIMIT, ModerationAiService, aiKeyContextId, type ModerationAiOptions,
} from '../src/services/moderation-ai.ts';
import { LocalModelManager } from '../src/services/moderation-ai-local-model.ts';
import { ModerationAiError, type ModerationAiEngine } from '../src/services/moderation-ai-engine.ts';
import type { SocialProvider } from '../src/core/domain.ts';
import * as labels from '../app/moderation-labels.ts';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const KEY = 'AIzaFAKE_test_key_0123456789abcdWXYZ';
const hoursAgo = (hours: number) => new Date(NOW - hours * 3600_000).toISOString().replace('.000Z', '+0000');

type Fixture = { db: DatabaseSync; vault: CredentialVault; dir: string };

async function withFixture(fn: (fixture: Fixture) => unknown | Promise<unknown>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mod-ai-'));
  const db = new DatabaseSync(':memory:');
  try {
    migrateDatabase(db);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`
      INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'Tu_Cuenta', 'tu_cuenta', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc2', 'conn1', 'ig2', 'otra_cuenta', 'otra_cuenta', 'valid', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m1', 'acc1', 'p1', '2026', '2026');
      INSERT INTO media(media_id, account_id, permalink, published_at, last_seen_at) VALUES ('m2', 'acc2', 'p2', '2026', '2026');
    `);
    const vault = createVault(dir, () => listEncryptedCredentials(db));
    await fn({ db, vault, dir });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function comment(db: DatabaseSync, id: string, text: string, options: { account?: string; hours?: number; username?: string } = {}): void {
  const account = options.account ?? 'acc1';
  db.prepare(`INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, '2026', '2026')`).run(id, account, account === 'acc1' ? 'm1' : 'm2', text, options.username ?? 'cliente', hoursAgo(options.hours ?? 1));
}

function categoryFor(text: string): string {
  if (text.includes('insulto')) return 'ai_insult';
  if (text.includes('odio')) return 'ai_hate';
  if (text.includes('spam')) return 'ai_spam';
  if (text.includes('queja')) return 'ai_complaint';
  return 'neutral';
}

function fakeEngine(behaviour?: (batch: Record<string, string>, call: number) => Record<string, string> | Promise<Record<string, string>>) {
  const batches: Array<Record<string, string>> = [];
  const engine: ModerationAiEngine = {
    async classify(batch) {
      batches.push(batch);
      if (behaviour) return behaviour(batch, batches.length);
      return Object.fromEntries(Object.entries(batch).map(([key, text]) => [key, categoryFor(text)]));
    },
  };
  return { engine, batches };
}

function service(fixture: Fixture, engine: ModerationAiEngine, sleeps: number[] = []) {
  const configs: unknown[] = [];
  const instance = new ModerationAiService(fixture.db, fixture.vault, {
    engineFactory: (config) => { configs.push(config); return engine; },
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => NOW,
  });
  return { instance, configs };
}

function enableGemini(instance: ModerationAiService, account = 'acc1'): void {
  instance.updateSettings(account, { engine: 'gemini', apiKey: KEY, confirmed: true });
}

function flags(db: DatabaseSync, account = 'acc1') {
  return db.prepare(`SELECT comment_id, category, source, state, reasons_json FROM moderation_flags WHERE account_id=? ORDER BY comment_id`).all(account) as Array<{ comment_id: string; category: string; source: string; state: string; reasons_json: string }>;
}

// ---------- Schema ----------

test('schema v17+: AI categories accepted, unknown rejected, AI tables created and v16 flags preserved', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateDatabase(db, 16);
    db.exec(`INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'u', 'u', 'valid', '2026', '2026');
      INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at)
        VALUES ('f1', 'acc1', 'm1', 'c1', 'spam_link', 'rules', '[]', 'HIDDEN', '2026', '2026');`);
    migrateDatabase(db);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 18);
    assert.deepEqual({ ...(db.prepare(`SELECT flag_id, category, state FROM moderation_flags`).get() as object) }, { flag_id: 'f1', category: 'spam_link', state: 'HIDDEN' });
    for (const [index, category] of ['ai_insult', 'ai_hate', 'ai_spam', 'ai_complaint'].entries()) {
      db.prepare(`INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at)
        VALUES (?, 'acc1', 'm1', ?, ?, 'ai', '[]', 'PENDING', '2026', '2026')`).run(`a${index}`, `ca${index}`, category);
    }
    assert.throws(() => db.prepare(`INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at)
      VALUES ('bad', 'acc1', 'm1', 'cbad', 'ai_bogus', 'ai', '[]', 'PENDING', '2026', '2026')`).run(), /CHECK/);
    assert.throws(() => db.prepare(`INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at)
      VALUES ('dup', 'acc1', 'm1', 'c1', 'ai_spam', 'ai', '[]', 'PENDING', '2026', '2026')`).run(), /UNIQUE/);
    db.exec(`INSERT INTO moderation_ai_settings(account_id, updated_at) VALUES ('acc1', '2026')`);
    assert.equal((db.prepare(`SELECT engine FROM moderation_ai_settings`).get() as { engine: string }).engine, 'off');
    assert.throws(() => db.exec(`UPDATE moderation_ai_settings SET engine='cloud'`), /CHECK/);
    db.exec(`INSERT INTO moderation_ai_jobs(job_id, account_id, state, review_window, started_at) VALUES ('j1', 'acc1', 'running', '24h', '2026')`);
    assert.throws(() => db.exec(`INSERT INTO moderation_ai_jobs(job_id, account_id, state, review_window, started_at) VALUES ('j2', 'acc1', 'running', '24h', '2026')`), /UNIQUE/);
  } finally {
    db.close();
  }
});

// ---------- Settings ----------

test('AI settings: off by default, DTO never exposes the key, only a masked hint', async () => {
  await withFixture((fixture) => {
    const { instance } = service(fixture, fakeEngine().engine);
    assert.deepEqual(instance.getSettings('acc1'), {
      engine: 'off', model: 'gemini-2.5-flash-lite', localModel: 'qwen2.5-1.5b', localModelInstalled: false, hasApiKey: false, apiKeyHint: null,
      consentAt: null, availableModels: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    });
    enableGemini(instance);
    const dto = instance.getSettings('acc1');
    assert.equal(dto.engine, 'gemini');
    assert.equal(dto.hasApiKey, true);
    assert.equal(dto.apiKeyHint, '…WXYZ');
    assert.equal(dto.consentAt, new Date(NOW).toISOString());
    assert.ok(!JSON.stringify(dto).includes(KEY));
  });
});

test('AI settings: the key is stored encrypted (no plaintext in the database) and decrypts with its context', async () => {
  await withFixture((fixture) => {
    const { instance } = service(fixture, fakeEngine().engine);
    enableGemini(instance);
    const dump = JSON.stringify(fixture.db.prepare(`SELECT * FROM moderation_ai_settings`).all());
    assert.ok(!dump.includes(KEY));
    assert.ok(!dump.includes(KEY.slice(0, 12)));
    const row = fixture.db.prepare(`SELECT api_key_nonce AS nonce, api_key_ciphertext AS ciphertext, api_key_tag AS tag FROM moderation_ai_settings WHERE account_id='acc1'`).get() as { nonce: string; ciphertext: string; tag: string };
    assert.equal(fixture.vault.decrypt(aiKeyContextId('acc1'), { ...row }), KEY);
    // The vault-key guard counts AI keys: a missing vault.key with encrypted AI keys must fail, never regenerate.
    assert.ok(listEncryptedCredentials(fixture.db).some((credential) => credential.contextId === aiKeyContextId('acc1')));
    // Empty string clears the key; omitting apiKey keeps it.
    instance.updateSettings('acc1', { engine: 'gemini', model: 'gemini-2.5-flash' });
    assert.equal(instance.getSettings('acc1').hasApiKey, true);
    assert.equal(instance.getSettings('acc1').model, 'gemini-2.5-flash');
    instance.updateSettings('acc1', { engine: 'gemini', apiKey: '' });
    assert.equal(instance.getSettings('acc1').hasApiKey, false);
    assert.equal(instance.getSettings('acc1').apiKeyHint, null);
  });
});

test('AI settings: Gemini requires confirmed === true the first time; local is unavailable; strict model and key validation', async () => {
  await withFixture((fixture) => {
    const { instance } = service(fixture, fakeEngine().engine);
    for (const confirmed of [undefined, false, 'true', 1]) {
      assert.throws(() => instance.updateSettings('acc1', { engine: 'gemini', apiKey: KEY, confirmed }), /confirmation_required/);
    }
    assert.equal(instance.getSettings('acc1').engine, 'off');
    assert.equal(instance.getSettings('acc1').hasApiKey, false);
    assert.throws(() => instance.updateSettings('acc1', { engine: 'local', confirmed: true }), (error: any) => error.code === 'ai_engine_unavailable' && error.status === 409);
    assert.throws(() => instance.updateSettings('acc1', { engine: 'cloud' }), (error: any) => error.code === 'invalid_request' && error.status === 400);
    for (const model of ['gemini-2.5-pro', 'gemini-2.5-flash/../x', 'Gemini-2.5-flash', 42]) {
      assert.throws(() => instance.updateSettings('acc1', { engine: 'off', model }), (error: any) => error.code === 'ai_model_invalid');
    }
    for (const apiKey of ['short', 'has space in it 0123456789', 'x'.repeat(200), 12]) {
      assert.throws(() => instance.updateSettings('acc1', { engine: 'off', apiKey }), (error: any) => error.code === 'ai_key_invalid');
    }
    enableGemini(instance);
    // Consent is recorded once; switching off and back on does not ask again.
    instance.updateSettings('acc1', { engine: 'off' });
    assert.doesNotThrow(() => instance.updateSettings('acc1', { engine: 'gemini' }));
    // Accounts are isolated.
    assert.equal(instance.getSettings('acc2').engine, 'off');
    assert.equal(instance.getSettings('acc2').hasApiKey, false);
  });
});

test('AI settings: the key test sends one tiny synthetic comment and reports a safe error code', async () => {
  await withFixture(async (fixture) => {
    const fake = fakeEngine();
    const { instance, configs } = service(fixture, fake.engine);
    instance.updateSettings('acc1', { engine: 'gemini', confirmed: true });
    await assert.rejects(instance.testKey('acc1'), (error: any) => error.code === 'ai_key_missing' && error.status === 409);
    enableGemini(instance);
    assert.deepEqual(await instance.testKey('acc1'), { ok: true });
    assert.deepEqual(fake.batches, [{ c1: 'Gracias por la info!' }]);
    assert.deepEqual(configs, [{ engine: 'gemini', model: 'gemini-2.5-flash-lite', apiKey: KEY }]);
    const failing = service(fixture, { classify: async () => { throw new ModerationAiError('ai_auth_failed'); } });
    assert.deepEqual(await failing.instance.testKey('acc1'), { ok: false, errorCode: 'ai_auth_failed' });
    const crashing = service(fixture, { classify: async () => { throw new Error(`boom ${KEY}`); } });
    const result = await crashing.instance.testKey('acc1');
    assert.deepEqual(result, { ok: false, errorCode: 'ai_unavailable' });
  });
});

// ---------- Job ----------

test('AI job: start requires an engine and a key', async () => {
  await withFixture(async (fixture) => {
    const { instance } = service(fixture, fakeEngine().engine);
    assert.throws(() => instance.start('acc1', '7d'), (error: any) => error.code === 'ai_disabled' && error.status === 409);
    instance.updateSettings('acc1', { engine: 'gemini', confirmed: true });
    assert.throws(() => instance.start('acc1', '7d'), (error: any) => error.code === 'ai_key_missing' && error.status === 409);
    instance.updateSettings('acc1', { engine: 'gemini', apiKey: KEY });
    assert.throws(() => instance.start('acc1', '90d' as never), (error: any) => error.code === 'invalid_request' && error.status === 400);
  });
});

test('AI job: scope = window, not owner, not already flagged, own account; neutral never flagged; flags are source ai + PENDING', async () => {
  await withFixture(async (fixture) => {
    const fake = fakeEngine();
    const { instance } = service(fixture, fake.engine);
    enableGemini(instance);
    comment(fixture.db, 'k1', 'esto es un insulto');
    comment(fixture.db, 'k2', 'discurso de odio');
    comment(fixture.db, 'k3', 'spam gana dinero');
    comment(fixture.db, 'k4', 'tengo una queja del envío');
    comment(fixture.db, 'k5', 'me encanta ❤️');
    comment(fixture.db, 'old', 'insulto viejo', { hours: 24 * 8 });
    comment(fixture.db, 'own', 'insulto del dueño', { username: 'tu_cuenta' });
    comment(fixture.db, 'flagged', 'insulto ya marcado');
    comment(fixture.db, 'empty', '');
    comment(fixture.db, 'other', 'insulto en otra cuenta', { account: 'acc2' });
    fixture.db.exec(`INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at)
      VALUES ('f0', 'acc1', 'm1', 'flagged', 'spam_link', 'rules', '[]', 'DISMISSED', '2026', '2026')`);
    instance.start('acc1', '7d');
    await instance.waitForIdle('acc1');
    const sent = Object.values(fake.batches.flatMap((batch) => Object.values(batch)));
    assert.deepEqual(sent.sort(), ['discurso de odio', 'esto es un insulto', 'me encanta ❤️', 'spam gana dinero', 'tengo una queja del envío'].sort());
    assert.ok(Object.keys(fake.batches[0]!).every((key) => /^c\d+$/u.test(key)), 'chunk-local aliases, never Meta ids');
    const created = flags(fixture.db).filter((flag) => flag.source === 'ai');
    assert.deepEqual(created.map((flag) => [flag.comment_id, flag.category, flag.state]), [
      ['k1', 'ai_insult', 'PENDING'], ['k2', 'ai_hate', 'PENDING'], ['k3', 'ai_spam', 'PENDING'], ['k4', 'ai_complaint', 'PENDING'],
    ]);
    assert.deepEqual(JSON.parse(created[0]!.reasons_json), ['IA: Insulto o acoso']);
    assert.deepEqual(JSON.parse(created[3]!.reasons_json), ['IA: Queja legítima']);
    assert.deepEqual(flags(fixture.db, 'acc2'), []);
    const status = instance.status('acc1') as any;
    assert.equal(status.state, 'completed');
    assert.deepEqual(status.progress, { chunksDone: 1, chunksTotal: 1, commentsSent: 5, flagged: 4, invalidOutput: 0, chunksFailed: 0, commentsTotal: 5, truncated: false });
    assert.equal(status.window, '7d');
    assert.ok(status.startedAt && status.finishedAt);
    // A second run skips everything flagged by the first; only the neutral comment is in scope again (24 h window).
    fake.batches.length = 0;
    instance.start('acc1', '24h');
    await instance.waitForIdle('acc1');
    assert.equal((instance.status('acc1') as any).progress.commentsSent, 1);
    assert.deepEqual(fake.batches, [{ c1: 'me encanta ❤️' }]);
  });
});

test('AI job: chunks of 40, at most 2000 comments (truncation reported), texts cut to 500 chars, >= 4 s between chunks', async () => {
  await withFixture(async (fixture) => {
    const fake = fakeEngine();
    const sleeps: number[] = [];
    const { instance } = service(fixture, { ...fake.engine, chunkSize: AI_CHUNK_SIZE, spacingMs: AI_CHUNK_SPACING_MS }, sleeps);
    enableGemini(instance);
    const insert = fixture.db.prepare(`INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at)
      VALUES (?, 'acc1', 'm1', ?, 'cliente', ?, '2026', '2026')`);
    fixture.db.exec('BEGIN');
    for (let index = 0; index < 2050; index++) insert.run(`n${index}`, index === 0 ? 'y'.repeat(900) : `hola ${index}`, hoursAgo(1 + index / 1000));
    fixture.db.exec('COMMIT');
    instance.start('acc1', '30d');
    await instance.waitForIdle('acc1');
    assert.equal(AI_CHUNK_SIZE, 40);
    assert.equal(AI_MAX_COMMENTS, 2000);
    assert.equal(AI_TEXT_LIMIT, 500);
    assert.ok(AI_CHUNK_SPACING_MS >= 4000);
    assert.equal(fake.batches.length, 50);
    assert.ok(fake.batches.every((batch) => Object.keys(batch).length === 40));
    assert.equal(Object.values(fake.batches[0]!)[0], 'y'.repeat(500));
    assert.deepEqual(sleeps, Array(49).fill(AI_CHUNK_SPACING_MS));
    const status = instance.status('acc1') as any;
    assert.equal(status.progress.commentsSent, 2000);
    assert.equal(status.progress.commentsTotal, 2050);
    assert.equal(status.progress.truncated, true);
    assert.equal(status.progress.chunksTotal, 50);
  });
});

test('AI job: invalid output is ignored and counted; ai_unavailable fails only the chunk; rate limit and auth stop the job', async () => {
  await withFixture(async (fixture) => {
    for (let index = 0; index < 90; index++) comment(fixture.db, `q${String(index).padStart(2, '0')}`, `insulto ${index}`);
    // Chunk 1: unknown id + unknown category + valid; chunk 2: unavailable; chunk 3: malformed.
    const fake = fakeEngine((batch, call) => {
      if (call === 2) throw new ModerationAiError('ai_unavailable');
      if (call === 3) throw new ModerationAiError('ai_invalid_output');
      const keys = Object.keys(batch);
      return { [keys[0]!]: 'ai_insult', [keys[1]!]: 'terrible', c999: 'ai_spam' };
    });
    const { instance } = service(fixture, fake.engine);
    enableGemini(instance);
    instance.start('acc1', '7d');
    await instance.waitForIdle('acc1');
    const status = instance.status('acc1') as any;
    assert.equal(status.state, 'completed');
    assert.equal(status.progress.flagged, 1);
    assert.equal(status.progress.chunksFailed, 1);
    assert.equal(status.progress.invalidOutput, 2 + 10);
    assert.equal(status.progress.chunksDone, 3);
    assert.equal(flags(fixture.db).length, 1);

    for (const code of ['ai_rate_limited', 'ai_auth_failed'] as const) {
      fixture.db.exec(`DELETE FROM moderation_flags`);
      const stopping = fakeEngine(() => { throw new ModerationAiError(code); });
      const other = service(fixture, stopping.engine);
      other.instance.start('acc1', '7d');
      await other.instance.waitForIdle('acc1');
      const failed = other.instance.status('acc1') as any;
      assert.equal(failed.state, 'failed');
      assert.equal(failed.errorCode, code);
      assert.equal(stopping.batches.length, 1, `${code} stops after the first chunk`);
    }
  });
});

test('AI job: one running job per account (409 ai_job_running), stop works, other accounts unaffected', async () => {
  await withFixture(async (fixture) => {
    for (let index = 0; index < 120; index++) comment(fixture.db, `s${index}`, `queja ${index}`);
    comment(fixture.db, 'x1', 'insulto', { account: 'acc2' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeEngine(async (batch, call) => {
      if (call === 1) await gate;
      return Object.fromEntries(Object.keys(batch).map((key) => [key, 'neutral']));
    });
    const { instance } = service(fixture, fake.engine);
    enableGemini(instance);
    enableGemini(instance, 'acc2');
    instance.start('acc1', '7d');
    assert.throws(() => instance.start('acc1', '7d'), (error: any) => error.code === 'ai_job_running' && error.status === 409);
    instance.start('acc2', '7d');
    await instance.waitForIdle('acc2');
    assert.equal((instance.status('acc2') as any).state, 'completed');
    const stopped = instance.stop('acc1') as any;
    assert.equal(stopped.state, 'running');
    release();
    await instance.waitForIdle('acc1');
    const final = instance.status('acc1') as any;
    assert.equal(final.state, 'stopped');
    assert.equal(fake.batches.filter((batch) => Object.values(batch)[0]!.startsWith('queja')).length, 1, 'no chunk after stop');
    assert.throws(() => instance.stop('acc1'), (error: any) => error.code === 'ai_job_not_running');
  });
});

test('AI job: a restart marks running jobs as stopped', async () => {
  await withFixture((fixture) => {
    fixture.db.exec(`INSERT INTO moderation_ai_jobs(job_id, account_id, state, review_window, started_at) VALUES ('j1', 'acc1', 'running', '24h', '2026-10-09T10:00:00.000Z')`);
    const { instance } = service(fixture, fakeEngine().engine);
    instance.recoverInterrupted();
    const status = instance.status('acc1') as any;
    assert.equal(status.state, 'stopped');
    assert.equal(status.errorCode, 'ai_interrupted');
    assert.ok(status.finishedAt);
    assert.deepEqual(new ModerationAiService(fixture.db, fixture.vault).status('acc2'), { state: 'idle' });
  });
});

test('server.ts wires the AI service and recovers interrupted jobs at boot', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(server, /new ModerationAiService\(database, vault[,)]/);
  assert.match(server, /moderationAi\.recoverInterrupted\(\)/);
  assert.match(server, /moderationAi[,\s]/);
});

// ---------- Auto-hide ----------

test('auto-hide: ai_complaint can never be allowed nor picked; other AI categories only when ticked', async () => {
  await withFixture(async (fixture) => {
    const base = { enabled: true, blockedTerms: [], detectLinks: true, detectPhones: true, detectMentions: true, detectEmoji: false, autoHideEnabled: true };
    assert.throws(() => moderation.updateSettings(fixture.db, 'acc1', { ...base, autoHideCategories: ['ai_complaint'] }, true), /invalid_category/);
    moderation.updateSettings(fixture.db, 'acc1', { ...base, autoHideCategories: ['ai_insult'] }, true);
    // Even if the stored list were tampered with, the selector skips ai_complaint.
    fixture.db.exec(`UPDATE moderation_settings SET auto_hide_categories_json='["ai_complaint","ai_insult"]', auto_hide_since='2020-01-01T00:00:00.000Z'`);
    fixture.db.exec(`UPDATE social_accounts SET monitoring_paused=0; INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', 'false', '2026');`);
    comment(fixture.db, 'cc', 'queja');
    comment(fixture.db, 'ci', 'insulto');
    comment(fixture.db, 'cs', 'spam');
    const add = fixture.db.prepare(`INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at)
      VALUES (?, 'acc1', 'm1', ?, ?, 'ai', '[]', 'PENDING', ?, '2026')`);
    add.run('fc', 'cc', 'ai_complaint', '2026-01-01T00:00:00.000Z');
    add.run('fs', 'cs', 'ai_spam', '2026-01-02T00:00:00.000Z');
    add.run('fi', 'ci', 'ai_insult', '2026-01-03T00:00:00.000Z');
    const calls: string[] = [];
    const provider = { async setCommentHidden(_a: unknown, id: string) { calls.push(id); return { status: 'accepted' }; } } as unknown as SocialProvider;
    for (let tick = 0; tick < 3; tick++) {
      fixture.db.exec(`DELETE FROM app_state WHERE state_key='moderation_last_auto_at'`);
      await moderation.processAutoHide(fixture.db, provider);
    }
    assert.deepEqual(calls, ['ci']);
  });
});

// ---------- API ----------

async function withApi(fixture: Fixture, instance: ModerationAiService | undefined, provider: SocialProvider,
  fn: (call: (path: string, method: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>) => Promise<void>,
  extra: Record<string, unknown> = {}): Promise<void> {
  const deps = { database: fixture.db, provider, csrfToken: 'csrf', ...(instance ? { moderationAi: instance } : {}), ...extra };
  const server = createServer(createApiHandler(deps as never));
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(async (path, method, body, headers) => {
      const response = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf', origin: base, ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    server.close();
  }
}

test('API: AI settings, review job and flags source filter; account scoping, CSRF, never calls Meta', async () => {
  await withFixture(async (fixture) => {
    const providerCalls: string[] = [];
    const provider = new Proxy({}, { get: (_target, name) => async () => { providerCalls.push(String(name)); return { status: 'accepted' }; } }) as SocialProvider;
    const { instance } = service(fixture, fakeEngine().engine);
    comment(fixture.db, 'a1', 'insulto');
    comment(fixture.db, 'a2', 'hola');
    fixture.db.exec(`INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at)
      VALUES ('r1', 'acc1', 'm1', 'a2', 'spam_link', 'rules', '[]', 'DISMISSED', '2026', '2026')`);
    await withApi(fixture, instance, provider, async (call) => {
      assert.equal((await call('/api/moderation/ai-settings?accountId=acc1', 'GET')).body.engine, 'off');
      assert.equal((await call('/api/moderation/ai-settings?accountId=nope', 'GET')).status, 404);
      assert.deepEqual((await call('/api/moderation/ai-review', 'POST', { accountId: 'acc1', window: '7d' })), { status: 409, body: { error: 'ai_disabled' } });
      assert.deepEqual(await call('/api/moderation/ai-settings', 'PUT', { accountId: 'acc1', engine: 'gemini', apiKey: KEY }), { status: 400, body: { error: 'confirmation_required' } });
      assert.deepEqual(await call('/api/moderation/ai-settings', 'PUT', { accountId: 'acc1', engine: 'gemini', apiKey: KEY, confirmed: 'true' }), { status: 400, body: { error: 'confirmation_required' } });
      assert.deepEqual(await call('/api/moderation/ai-settings', 'PUT', { accountId: 'acc1', engine: 'local', confirmed: true }), { status: 409, body: { error: 'ai_engine_unavailable' } });
      assert.equal((await call('/api/moderation/ai-settings', 'PUT', { accountId: 'acc1', engine: 'gemini', apiKey: KEY }, { 'x-csrf-token': 'bad' })).status, 403);
      const saved = await call('/api/moderation/ai-settings', 'PUT', { accountId: 'acc1', engine: 'gemini', apiKey: KEY, confirmed: true });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.hasApiKey, true);
      assert.ok(!JSON.stringify(saved.body).includes(KEY));
      assert.deepEqual(Object.keys(saved.body).sort(), ['apiKeyHint', 'availableModels', 'consentAt', 'engine', 'hasApiKey', 'localModel', 'localModelInstalled', 'model']);
      assert.equal((await call('/api/moderation/ai-settings?accountId=acc2', 'GET')).body.hasApiKey, false);
      assert.deepEqual(await call('/api/moderation/ai-settings/test', 'POST', { accountId: 'acc1' }), { status: 200, body: { ok: true } });
      assert.deepEqual(await call('/api/moderation/ai-settings/test', 'POST', { accountId: 'acc2' }), { status: 409, body: { error: 'ai_disabled' } });
      assert.equal((await call('/api/moderation/ai-review/stop', 'POST', { accountId: 'acc1' }, { origin: 'http://evil.example' })).status, 403);
      assert.deepEqual(await call('/api/moderation/ai-review', 'POST', { accountId: 'acc1', window: '1y' }), { status: 400, body: { error: 'invalid_request' } });
      assert.equal((await call('/api/moderation/ai-review', 'POST', { accountId: 'acc1', window: '7d' })).status, 202);
      await instance.waitForIdle('acc1');
      const status = await call('/api/moderation/ai-review?accountId=acc1', 'GET');
      assert.equal(status.body.state, 'completed');
      assert.equal(status.body.progress.flagged, 1);
      assert.deepEqual((await call('/api/moderation/ai-review?accountId=acc2', 'GET')).body, { state: 'idle' });
      assert.deepEqual(await call('/api/moderation/ai-review/stop', 'POST', { accountId: 'acc1' }), { status: 409, body: { error: 'ai_job_not_running' } });
      const aiFlags = await call('/api/moderation/flags?accountId=acc1&source=ai', 'GET');
      assert.deepEqual(aiFlags.body.items.map((item: any) => [item.commentId, item.source, item.category]), [['a1', 'ai', 'ai_insult']]);
      const ruleFlags = await call('/api/moderation/flags?accountId=acc1&source=rules', 'GET');
      assert.deepEqual(ruleFlags.body.items.map((item: any) => item.flagId), ['r1']);
      assert.equal((await call('/api/moderation/flags?accountId=acc1&source=x', 'GET')).status, 400);
      assert.equal((await call('/api/moderation/flags?accountId=acc1', 'GET')).body.total, 2);
    });
    assert.deepEqual(providerCalls, [], 'the AI review never calls the Meta provider');
    await withApi(fixture, undefined, provider, async (call) => {
      assert.deepEqual(await call('/api/moderation/ai-settings?accountId=acc1', 'GET'), { status: 503, body: { error: 'moderation_ai_unavailable' } });
    });
  });
});

// ---------- UI helpers ----------

test('labels: AI categories, complaint hint, progress text, auto-hide options and error labels', () => {
  assert.equal(labels.categoryLabel('ai_insult'), 'Insulto o acoso');
  assert.equal(labels.categoryLabel('ai_hate'), 'Odio o discriminación');
  assert.equal(labels.categoryLabel('ai_spam'), 'Spam o estafa');
  assert.equal(labels.categoryLabel('ai_complaint'), 'Queja legítima');
  assert.equal(labels.AI_COMPLAINT_HINT, 'Queja legítima: conviene responder, no ocultar');
  assert.equal(labels.aiProgressText({ chunksDone: 3, chunksTotal: 10, commentsSent: 120, flagged: 7, invalidOutput: 0 }), 'Lote 3 de 10 · 120 comentarios enviados · 7 marcados');
  assert.equal(labels.aiProgressText({ chunksDone: 1, chunksTotal: 1, commentsSent: 1, flagged: 1, invalidOutput: 0 }), 'Lote 1 de 1 · 1 comentario enviado · 1 marcado');
  assert.equal(labels.aiProgressPercent({ chunksDone: 3, chunksTotal: 10 }), 30);
  assert.equal(labels.aiProgressPercent({ chunksDone: 0, chunksTotal: 0 }), 0);
  const values = labels.AUTO_HIDE_OPTIONS.map((option) => option.value);
  assert.ok(values.includes('ai_insult') && values.includes('ai_hate') && values.includes('ai_spam'));
  assert.ok(!values.includes('ai_complaint'));
  assert.ok(labels.AUTO_HIDE_OPTIONS.filter((option) => option.value.startsWith('ai_')).every((option) => option.ai === true));
  assert.match(labels.AI_PRIVACY_NOTICE, /^Con la API gratuita, Google puede usar el contenido enviado para mejorar sus productos\. Los comentarios de sus clientes saldrán de este equipo\. Para que nada salga del equipo use el modelo local\.$/u);
  for (const code of ['ai_disabled', 'ai_key_missing', 'ai_job_running', 'ai_rate_limited', 'ai_auth_failed', 'ai_unavailable', 'ai_engine_unavailable', 'ai_model_invalid', 'ai_key_invalid']) {
    assert.ok(labels.AI_ERROR_LABELS[code], code);
  }
  assert.match(labels.aiJobSummary({ state: 'completed', progress: { chunksDone: 2, chunksTotal: 2, commentsSent: 80, flagged: 5, invalidOutput: 1, chunksFailed: 0, commentsTotal: 80, truncated: false } }), /80 comentarios revisados · 5 marcados/);
  assert.match(labels.aiJobSummary({ state: 'failed', errorCode: 'ai_rate_limited', progress: { chunksDone: 1, chunksTotal: 2, commentsSent: 40, flagged: 0, invalidOutput: 0, chunksFailed: 0, commentsTotal: 80, truncated: false } }), /límite/);
  assert.match(labels.aiJobSummary({ state: 'completed', progress: { chunksDone: 50, chunksTotal: 50, commentsSent: 2000, flagged: 0, invalidOutput: 0, chunksFailed: 0, commentsTotal: 2050, truncated: true } }), /2000 de 2050/);
});

test('page: AI review panel between rules and flags, off by default, key link, disclosure, source filter and complaint hint', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const view = page.slice(page.indexOf('export function ModerationView'));
  const rules = view.indexOf('Reglas de moderación</h3>');
  const ai = view.indexOf('<AiReviewPanel');
  const flagsPanel = view.indexOf('Comentarios marcados <span');
  assert.ok(rules > 0 && ai > rules && flagsPanel > ai, 'AI panel sits between rules and flags');
  assert.match(page, /Revisar comentarios negativos/);
  assert.match(page, /aiReviewGate\(/);
  assert.equal(labels.aiReviewGate({ savedEngine: 'off', localPicked: false, hasApiKey: false, localModelInstalled: false, running: false }).hint, 'Active la revisión con IA para usar este botón.');
  assert.match(page, /href="https:\/\/aistudio\.google\.com\/app\/apikey" target="_blank" rel="noreferrer"/);
  assert.doesNotMatch(page, /próximamente/);
  assert.match(page, /label: 'Modelo local'/);
  assert.match(page, /type="password"/);
  assert.match(page, /Probar key/);
  assert.match(page, /AI_PRIVACY_NOTICE/);
  assert.match(page, /Ver solo los marcados por IA/);
  assert.match(page, /source=|set\('source'/);
  assert.match(page, /AI_COMPLAINT_HINT/);
  assert.match(page, /IA puede equivocarse/);
  assert.match(page, /Sparkles/);
  assert.match(page, /Detener/);
});

// ---------- Round 2 ----------

async function autoHideFixture(fixture: Fixture, comments: Array<{ id: string; hoursAgo: number | null; category: string; source?: string }>, sinceHoursAgo: number) {
  const base = { enabled: true, blockedTerms: [], detectLinks: true, detectPhones: true, detectMentions: true, detectEmoji: false, autoHideEnabled: true };
  moderation.updateSettings(fixture.db, 'acc1', { ...base, autoHideCategories: ['ai_insult', 'spam_link'] }, true);
  fixture.db.prepare(`UPDATE moderation_settings SET auto_hide_since=?`).run(new Date(Date.now() - sinceHoursAgo * 3600_000).toISOString());
  fixture.db.exec(`UPDATE social_accounts SET monitoring_paused=0; INSERT OR REPLACE INTO app_state(state_key, state_value, updated_at) VALUES ('dry_run', 'false', '2026');`);
  const nowIso = new Date().toISOString();
  for (const item of comments) {
    if (item.hoursAgo !== null) {
      fixture.db.prepare(`INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at)
        VALUES (?, 'acc1', 'm1', 'x', 'cliente', ?, '2026', '2026')`).run(item.id, new Date(Date.now() - item.hoursAgo * 3600_000).toISOString().replace(/\.\d{3}Z$/u, '+0000'));
    }
    // The flag itself is always created NOW (e.g. by an AI review of old comments).
    fixture.db.prepare(`INSERT INTO moderation_flags(flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at)
      VALUES (?, 'acc1', 'm1', ?, ?, ?, '[]', 'PENDING', ?, ?)`).run(`f_${item.id}`, item.id, item.category, item.source ?? 'ai', nowIso, nowIso);
  }
  const calls: string[] = [];
  const provider = { async setCommentHidden(_a: unknown, id: string) { calls.push(id); return { status: 'accepted' }; } } as unknown as SocialProvider;
  for (let tick = 0; tick < comments.length + 1; tick++) {
    fixture.db.exec(`DELETE FROM app_state WHERE state_key='moderation_last_auto_at'`);
    await moderation.processAutoHide(fixture.db, provider);
  }
  return calls;
}

test('M1 auto-hide compares the COMMENT date with auto_hide_since, not the flag date (AI and rules alike)', async () => {
  await withFixture(async (fixture) => {
    const calls = await autoHideFixture(fixture, [
      { id: 'old_ai', hoursAgo: 240, category: 'ai_insult' },
      { id: 'old_rule', hoursAgo: 240, category: 'spam_link', source: 'rules' },
      { id: 'new_ai', hoursAgo: 0.5, category: 'ai_insult' },
      { id: 'new_rule', hoursAgo: 0.25, category: 'spam_link', source: 'rules' },
      { id: 'orphan', hoursAgo: null, category: 'ai_insult' },
    ], 1);
    assert.deepEqual(calls.sort(), ['new_ai', 'new_rule']);
  });
});

test('M1 auto-hide confirmation text talks about comments published from now on', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /Solo se aplica a comentarios publicados desde ahora\./);
  assert.doesNotMatch(page, /Solo se aplica a comentarios marcados desde ahora/);
});

test('M2 switching the engine off or clearing the key stops the running job and aborts the in-flight request', async () => {
  for (const change of [{ engine: 'off' }, { engine: 'gemini', apiKey: '' }]) {
    await withFixture(async (fixture) => {
      for (let index = 0; index < 120; index++) comment(fixture.db, `s${index}`, `queja ${index}`);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const signals: AbortSignal[] = [];
      let calls = 0;
      const engine: ModerationAiEngine = {
        async classify(batch, signal) {
          calls++;
          if (signal) signals.push(signal);
          await gate;
          return Object.fromEntries(Object.keys(batch).map((key) => [key, 'neutral']));
        },
      };
      const { instance } = service(fixture, engine);
      enableGemini(instance);
      instance.start('acc1', '7d');
      instance.updateSettings('acc1', change);
      assert.equal(signals[0]?.aborted, true, 'the in-flight request is aborted before the change is saved');
      release();
      await instance.waitForIdle('acc1');
      assert.equal((instance.status('acc1') as any).state, 'stopped');
      assert.equal(calls, 1, 'no chunk is sent after the change');
    });
  }
});

test('M2 page: engine selector and key removal are disabled while a review runs', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /Detenga la revisión para cambiar el motor\./);
  assert.match(page, /disabled=\{option\.disabled \|\| !settings \|\| running\}/);
  assert.match(page, /onClick=\{removeKey\} disabled=\{running\}|disabled=\{running\} onClick=\{removeKey\}/);
});

test('(b) key test requires Gemini with recorded consent', async () => {
  await withFixture(async (fixture) => {
    const { instance } = service(fixture, fakeEngine().engine);
    await assert.rejects(instance.testKey('acc1'), (error: any) => error.code === 'ai_disabled' && error.status === 409);
    enableGemini(instance);
    instance.updateSettings('acc1', { engine: 'off' });
    await assert.rejects(instance.testKey('acc1'), (error: any) => error.code === 'ai_disabled' && error.status === 409);
    instance.updateSettings('acc1', { engine: 'gemini' });
    assert.deepEqual(await instance.testKey('acc1'), { ok: true });
  });
});

test('(c) the job scope filters the window and caps in SQL (never loads every comment into memory)', async () => {
  await withFixture(async (fixture) => {
    const insert = fixture.db.prepare(`INSERT INTO comments(comment_id, account_id, media_id, text, username, created_at, first_seen_at, last_seen_at)
      VALUES (?, 'acc1', 'm1', ?, 'cliente', ?, '2026', '2026')`);
    fixture.db.exec('BEGIN');
    for (let index = 0; index < 2050; index++) insert.run(`in${index}`, `hola ${index}`, hoursAgo(1 + index / 1000));
    for (let index = 0; index < 600; index++) insert.run(`out${index}`, `viejo ${index}`, hoursAgo(24 * 40));
    fixture.db.exec('COMMIT');
    let largest = 0;
    const spied = new Proxy(fixture.db, {
      get(target, name) {
        if (name === 'prepare') {
          return (sql: string) => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get(inner, key) {
                if (key === 'all') return (...args: any[]) => { const rows = (inner.all as any)(...args); largest = Math.max(largest, rows.length); return rows; };
                const value = (inner as any)[key];
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            });
          };
        }
        const value = (target as any)[name];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseSync;
    const fake = fakeEngine();
    const instance = new ModerationAiService(spied, fixture.vault, { engineFactory: () => fake.engine, sleep: async () => {}, now: () => NOW });
    enableGemini(instance);
    instance.start('acc1', '30d');
    await instance.waitForIdle('acc1');
    const status = instance.status('acc1') as any;
    assert.equal(status.progress.commentsTotal, 2050);
    assert.equal(status.progress.commentsSent, 2000);
    assert.ok(largest <= AI_MAX_COMMENTS, `largest .all() returned ${largest} rows`);
    assert.ok(!fake.batches.some((batch) => Object.values(batch).some((text) => text.startsWith('viejo'))));
  });
});

// ---------- PR 3: local model ----------

function localService(fixture: Fixture, engine: ModerationAiEngine, installed: Set<string>, extra: Partial<ModerationAiOptions> = {}) {
  const configs: unknown[] = [];
  const sleeps: number[] = [];
  const instance = new ModerationAiService(fixture.db, fixture.vault, {
    engineFactory: (config) => { configs.push(config); return engine; },
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => NOW,
    localModels: { isInstalled: (id: string) => installed.has(id) },
    ...extra,
  });
  return { instance, configs, sleeps };
}

test('schema v18: moderation_ai_settings gains local_model without touching existing rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateDatabase(db, 17);
    db.exec(`INSERT INTO connections(id, name, provider_code, login_kind, graph_version, status, created_at, updated_at)
        VALUES ('conn1', 'conn1', 'META', 'instagram_login', 'v17.0', 'valid', '2026', '2026');
      INSERT INTO social_accounts(account_id, connection_id, provider_account_id, username, normalized_username, status, created_at, updated_at)
        VALUES ('acc1', 'conn1', 'ig1', 'u', 'u', 'valid', '2026', '2026');
      INSERT INTO moderation_ai_settings(account_id, engine, model, updated_at) VALUES ('acc1', 'gemini', 'gemini-2.5-flash', '2026');`);
    migrateDatabase(db);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 18);
    assert.deepEqual({ ...(db.prepare(`SELECT engine, model, local_model FROM moderation_ai_settings`).get() as object) },
      { engine: 'gemini', model: 'gemini-2.5-flash', local_model: null });
  } finally {
    db.close();
  }
});

test('local settings: needs the installed model (409 ai_model_missing), strict ids, no consent; switching keeps the Gemini key and model', async () => {
  await withFixture((fixture) => {
    const installed = new Set<string>();
    const { instance } = localService(fixture, fakeEngine().engine, installed);
    assert.equal(instance.getSettings('acc1').localModel, 'qwen2.5-1.5b');
    assert.equal(instance.getSettings('acc1').localModelInstalled, false);
    assert.throws(() => instance.updateSettings('acc1', { engine: 'local' }), (error: any) => error.code === 'ai_model_missing' && error.status === 409);
    assert.throws(() => instance.updateSettings('acc1', { engine: 'local', model: 'qwen3-4b' }), (error: any) => error.code === 'ai_model_missing');
    for (const model of ['qwen2.5-3b', 'gemini-2.5-flash', '../x', 7]) {
      assert.throws(() => instance.updateSettings('acc1', { engine: 'local', model }), (error: any) => error.code === 'ai_model_invalid' && error.status === 400, String(model));
    }
    assert.equal(instance.getSettings('acc1').engine, 'off');
    instance.updateSettings('acc1', { engine: 'gemini', apiKey: KEY, model: 'gemini-2.5-flash', confirmed: true });
    installed.add('qwen3-4b');
    // No consent dialog for local: nothing leaves the machine.
    const local = instance.updateSettings('acc1', { engine: 'local', model: 'qwen3-4b' });
    assert.equal(local.engine, 'local');
    assert.equal(local.localModel, 'qwen3-4b');
    assert.equal(local.localModelInstalled, true);
    assert.equal(local.hasApiKey, true, 'the Gemini key survives the switch');
    assert.equal(local.model, 'gemini-2.5-flash', 'and so does the Gemini model');
    const back = instance.updateSettings('acc1', { engine: 'gemini' });
    assert.equal(back.model, 'gemini-2.5-flash');
    assert.equal(back.localModel, 'qwen3-4b');
    assert.equal(back.hasApiKey, true);
    // Without a local model manager (tests, old wiring) local stays unavailable.
    const bare = new ModerationAiService(fixture.db, fixture.vault, { now: () => NOW });
    assert.throws(() => bare.updateSettings('acc2', { engine: 'local' }), (error: any) => error.code === 'ai_engine_unavailable' && error.status === 409);
  });
});

test('local job: engine chunk size (10) and no spacing; the config names the local model; key test stays Gemini-only', async () => {
  await withFixture(async (fixture) => {
    for (let index = 0; index < 25; index++) comment(fixture.db, `l${String(index).padStart(2, '0')}`, `insulto ${index}`);
    const fake = fakeEngine();
    const engine = { ...fake.engine, chunkSize: 10, spacingMs: 0 };
    const installed = new Set(['qwen2.5-1.5b']);
    const { instance, configs, sleeps } = localService(fixture, engine, installed);
    instance.updateSettings('acc1', { engine: 'local' });
    instance.start('acc1', '7d');
    await instance.waitForIdle('acc1');
    assert.deepEqual(configs, [{ engine: 'local', model: 'qwen2.5-1.5b' }]);
    assert.deepEqual(fake.batches.map((batch) => Object.keys(batch).length), [10, 10, 5]);
    assert.deepEqual(sleeps, [], 'local chunks are not spaced');
    const status = instance.status('acc1') as any;
    assert.equal(status.state, 'completed');
    assert.equal(status.progress.chunksTotal, 3);
    assert.equal(status.progress.flagged, 25);
    await assert.rejects(instance.testKey('acc1'), (error: any) => error.code === 'ai_disabled');
    // The model disappeared after the engine was chosen: start refuses with ai_model_missing.
    installed.clear();
    assert.throws(() => instance.start('acc1', '7d'), (error: any) => error.code === 'ai_model_missing' && error.status === 409);
  });
});

test('local job: ai_local_unavailable (runtime or model cannot load) stops the job after the first chunk', async () => {
  await withFixture(async (fixture) => {
    for (let index = 0; index < 25; index++) comment(fixture.db, `u${index}`, `hola ${index}`);
    const failing = fakeEngine(() => { throw new ModerationAiError('ai_local_unavailable'); });
    const { instance } = localService(fixture, { ...failing.engine, chunkSize: 10, spacingMs: 0 }, new Set(['qwen2.5-1.5b']));
    instance.updateSettings('acc1', { engine: 'local' });
    instance.start('acc1', '7d');
    await instance.waitForIdle('acc1');
    const status = instance.status('acc1') as any;
    assert.equal(status.state, 'failed');
    assert.equal(status.errorCode, 'ai_local_unavailable');
    assert.equal(failing.batches.length, 1);
  });
});

test('local model delete: confirmed === true, refused while a local job uses that model, unloads the runtime first', async () => {
  await withFixture(async (fixture) => {
    for (let index = 0; index < 15; index++) comment(fixture.db, `d${index}`, `hola ${index}`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = fakeEngine(async (batch, call) => {
      if (call === 1) await gate;
      return Object.fromEntries(Object.keys(batch).map((key) => [key, 'neutral']));
    });
    const deleted: Array<[unknown, unknown]> = [];
    const events: string[] = [];
    const { instance } = localService(fixture, { ...fake.engine, chunkSize: 10, spacingMs: 0 }, new Set(['qwen2.5-1.5b', 'qwen3-4b']), {
      localModels: {
        isInstalled: () => true,
        delete: async (model: unknown, confirmed: unknown) => { events.push('delete'); deleted.push([model, confirmed]); return { models: [] }; },
      },
      localRuntime: { engine: () => fake.engine, unload: async () => { events.push('unload'); } },
    });
    instance.updateSettings('acc1', { engine: 'local' });
    instance.start('acc1', '7d');
    await assert.rejects(instance.deleteLocalModel('qwen2.5-1.5b', true), (error: any) => error.code === 'model_in_use' && error.status === 409);
    await assert.rejects(instance.deleteLocalModel('qwen2.5-1.5b', 'true'), /confirmation_required/u);
    await instance.deleteLocalModel('qwen3-4b', true);
    release();
    await instance.waitForIdle('acc1');
    await instance.deleteLocalModel('qwen2.5-1.5b', true);
    assert.deepEqual(deleted, [['qwen3-4b', true], ['qwen2.5-1.5b', true]]);
    assert.deepEqual(events, ['unload', 'delete', 'unload', 'delete']);
  });
});

test('API: local model status, download, cancel and delete (CSRF, safe codes, global to the installation)', async () => {
  await withFixture(async (fixture) => {
    const bytes = Buffer.from('tiny-gguf');
    const { createHash } = await import('node:crypto');
    const modelsDir = join(fixture.dir, 'models');
    let hang = true;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      if (hang) {
        return new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) return reject(new Error('aborted'));
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;
    const localModels = new LocalModelManager({
      modelsDir, fetcher, statfs: async () => ({ bavail: 1e12, bsize: 1 }),
      catalog: [{ id: 'qwen2.5-1.5b', label: 'Tiny', fileName: 'tiny.gguf', url: 'https://huggingface.co/Qwen/x/resolve/abc/tiny.gguf', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
    });
    const { instance } = localService(fixture, fakeEngine().engine, new Set(), { localModels, localRuntime: { engine: () => fakeEngine().engine, unload: async () => undefined } });
    await withApi(fixture, instance, {} as SocialProvider, async (call) => {
      const initial = await call('/api/moderation/ai-local/status', 'GET');
      assert.equal(initial.status, 200);
      assert.deepEqual(initial.body, { models: [{ id: 'qwen2.5-1.5b', label: 'Tiny', sizeBytes: bytes.length, installed: false, partialBytes: 0 }] });
      assert.equal((await call('/api/moderation/ai-local/download', 'POST', { model: 'qwen2.5-1.5b' }, { 'x-csrf-token': 'bad' })).status, 403);
      assert.deepEqual(await call('/api/moderation/ai-local/download', 'POST', { model: 'nope' }), { status: 400, body: { error: 'invalid_request' } });
      const started = await call('/api/moderation/ai-local/download', 'POST', { model: 'qwen2.5-1.5b' });
      assert.equal(started.status, 202);
      assert.equal(started.body.download.state, 'running');
      assert.deepEqual(await call('/api/moderation/ai-local/download', 'POST', { model: 'qwen2.5-1.5b' }), { status: 409, body: { error: 'download_running' } });
      assert.equal((await call('/api/moderation/ai-local/download/cancel', 'POST', {})).status, 200);
      await localModels.waitForIdle();
      assert.equal((await call('/api/moderation/ai-local/status', 'GET')).body.download.state, 'cancelled');
      assert.deepEqual(await call('/api/moderation/ai-local/download/cancel', 'POST', {}), { status: 409, body: { error: 'download_not_running' } });
      hang = false;
      await call('/api/moderation/ai-local/download', 'POST', { model: 'qwen2.5-1.5b' });
      await localModels.waitForIdle();
      assert.equal((await call('/api/moderation/ai-local/status', 'GET')).body.models[0].installed, true);
      assert.deepEqual(await call('/api/moderation/ai-local/delete', 'POST', { model: 'qwen2.5-1.5b' }), { status: 400, body: { error: 'confirmation_required' } });
      const removed = await call('/api/moderation/ai-local/delete', 'POST', { model: 'qwen2.5-1.5b', confirmed: true });
      assert.equal(removed.status, 200);
      assert.equal(removed.body.models[0].installed, false);
    }, { localModels });
    await withApi(fixture, undefined, {} as SocialProvider, async (call) => {
      assert.deepEqual(await call('/api/moderation/ai-local/status', 'GET'), { status: 503, body: { error: 'moderation_ai_unavailable' } });
    });
  });
});

test('server.ts keeps models under <data>/models, recovers an interrupted download and wires the local runtime', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.match(server, /new LocalModelManager\(\{ modelsDir: join\(config\.dataDir, 'models'\) \}\)/);
  assert.match(server, /localModels\.recoverInterrupted\(\)/);
  assert.match(server, /new LocalAiRuntime\(/);
  assert.match(server, /new ModerationAiService\(database, vault, \{ localModels, localRuntime \}\)/);
  const service = readFileSync(new URL('../src/services/moderation-ai-local.ts', import.meta.url), 'utf8');
  assert.match(service, /await import\('node-llama-cpp'\)/, 'node-llama-cpp is loaded lazily');
  assert.doesNotMatch(service, /^import .*node-llama-cpp/mu, 'never a static import');
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(manifest.dependencies['node-llama-cpp'], /^\d+\.\d+\.\d+$/u, 'pinned exactly, in dependencies');
});

test('labels: local model cards, download progress, local notes and error labels for every state', () => {
  assert.equal(labels.AI_LOCAL_PRIVACY_NOTE, 'Todo se procesa en este equipo; ningún comentario sale de él.');
  assert.match(labels.AI_LOCAL_RESOURCE_NOTE, /memoria|RAM/u);
  assert.equal(labels.LOCAL_MODEL_INFO['qwen2.5-1.5b']!.detail, 'Rápido · ~1 GB · recomendado para 8 GB de RAM');
  assert.match(labels.LOCAL_MODEL_INFO['qwen3-4b']!.detail, /^Más preciso · ~2,5 GB · 16 GB de RAM recomendados$/u);
  assert.equal(labels.downloadProgressText({ receivedBytes: 500_000_000, totalBytes: 1_117_320_736 }), '500 MB de 1117 MB (44 %)');
  assert.equal(labels.downloadProgressText({ receivedBytes: 0, totalBytes: 0 }), '0 MB de 0 MB (0 %)');
  const entry = { id: 'qwen2.5-1.5b', installed: false, partialBytes: 0, sizeBytes: 1000 };
  assert.deepEqual(labels.localModelCardState(entry, undefined), { kind: 'idle', canDownload: true, canCancel: false, canDelete: false, downloadLabel: 'Descargar' });
  assert.deepEqual(labels.localModelCardState(entry, null), labels.localModelCardState(entry, undefined));
  assert.equal(labels.localModelCardState({ ...entry, installed: true }, undefined).kind, 'installed');
  assert.equal(labels.localModelCardState({ ...entry, installed: true }, undefined).canDelete, true);
  const running = labels.localModelCardState(entry, { model: 'qwen2.5-1.5b', state: 'running', receivedBytes: 250, totalBytes: 1000 });
  assert.equal(running.kind, 'downloading');
  assert.equal(running.percent, 25);
  assert.equal(running.canCancel, true);
  assert.equal(running.canDownload, false);
  const otherBusy = labels.localModelCardState(entry, { model: 'qwen3-4b', state: 'running', receivedBytes: 1, totalBytes: 9 });
  assert.equal(otherBusy.kind, 'idle');
  assert.equal(otherBusy.canDownload, false, 'one download at a time');
  const failed = labels.localModelCardState(entry, { model: 'qwen2.5-1.5b', state: 'failed', receivedBytes: 0, totalBytes: 1000, errorCode: 'checksum_mismatch' });
  assert.equal(failed.kind, 'failed');
  assert.match(failed.message!, /no coincide/u);
  const unknownError = labels.localModelCardState(entry, { model: 'qwen2.5-1.5b', state: 'failed', receivedBytes: 0, totalBytes: 1000, errorCode: 'weird' as never });
  assert.ok(unknownError.message && unknownError.message.length > 0);
  const resumable = labels.localModelCardState({ ...entry, partialBytes: 300 }, { model: 'qwen2.5-1.5b', state: 'cancelled', receivedBytes: 300, totalBytes: 1000 });
  assert.equal(resumable.kind, 'cancelled');
  assert.equal(resumable.downloadLabel, 'Reanudar descarga');
  assert.equal(labels.localModelCardState({ ...entry, installed: true }, { model: 'qwen2.5-1.5b', state: 'completed', receivedBytes: 1000, totalBytes: 1000 }).kind, 'installed');
  for (const code of ['ai_model_missing', 'ai_local_unavailable', 'model_in_use', 'download_running', 'insufficient_disk', 'checksum_mismatch',
    'download_host_rejected', 'download_timeout', 'download_failed', 'download_http_error', 'download_write_failed', 'model_installed', 'download_not_running']) {
    assert.ok(labels.AI_ERROR_LABELS[code], code);
  }
});

test('page: local option enabled with model cards, download progress, cancel, delete confirmation and the local notes', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /\/api\/moderation\/ai-local\/status/);
  assert.match(page, /\/api\/moderation\/ai-local\/download\/cancel/);
  assert.match(page, /\/api\/moderation\/ai-local\/delete', 'POST', \{ model: .*confirmed: true \}/u);
  assert.match(page, /AI_LOCAL_PRIVACY_NOTE/);
  assert.match(page, /AI_LOCAL_RESOURCE_NOTE/);
  assert.match(page, /localModelCardState\(/);
  assert.match(page, /aria-label="Progreso de la descarga"/);
  assert.match(page, />Cancelar</);
  assert.match(page, /Instalado/);
  assert.match(page, /Borrar modelo/);
  assert.match(page, /engine === 'local'/);
  // The Gemini privacy notice only shows for Gemini (or off), never next to the local engine.
  assert.match(page, /engine !== 'local' && <p className="ai-privacy"/);
  assert.match(page, /aiReviewGate\(/);
});

test('review button gate: picking "Modelo local" without a saved local engine never runs the previously saved Gemini', () => {
  const base = { savedEngine: 'gemini', localPicked: false, hasApiKey: true, localModelInstalled: false, running: false };
  assert.deepEqual(labels.aiReviewGate(base), { canReview: true, hint: '' });
  assert.deepEqual(labels.aiReviewGate({ ...base, localPicked: true }), { canReview: false, hint: 'Descargue un modelo y pulse «Usar este modelo» para revisar.' });
  assert.deepEqual(labels.aiReviewGate({ ...base, hasApiKey: false }), { canReview: false, hint: 'Guarde una API key de Gemini antes de revisar.' });
  assert.deepEqual(labels.aiReviewGate({ ...base, savedEngine: 'off' }), { canReview: false, hint: 'Active la revisión con IA para usar este botón.' });
  assert.deepEqual(labels.aiReviewGate({ ...base, savedEngine: 'local', localModelInstalled: true }), { canReview: true, hint: '' });
  assert.deepEqual(labels.aiReviewGate({ ...base, savedEngine: 'local' }), { canReview: false, hint: 'Descargue el modelo local antes de revisar.' });
  assert.equal(labels.aiReviewGate({ ...base, running: true }).canReview, false);
});
