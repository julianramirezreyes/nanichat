import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/core/config.ts';
import { createApiHandler } from '../src/http/router.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { AutomationService } from '../src/services/automations.ts';
import { createLegacyInterlock, legacyInterlockFromConfig } from '../src/services/legacy-interlock.ts';
import { QueueService } from '../src/services/queue.ts';

const CSRF = 'legacy-csrf';

async function listen(handler: ReturnType<typeof createApiHandler>): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function call(origin: string, path: string, body?: unknown) {
  const url = new URL(path, origin);
  const headers: Record<string, string> = body === undefined ? {} : { origin, 'x-csrf-token': CSRF, 'content-type': 'application/json' };
  return new Promise<{ status: number; json: any }>((done, fail) => {
    const req = request(url, { method: body === undefined ? 'GET' : 'POST', headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on('error', fail);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function tempDir(context: { after(fn: () => void): void }, prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('configuration: legacy interlock and .env import are disabled unless their variables are set', () => {
  const config = loadConfig({}, '/app');
  assert.equal(config.legacyAccountsDir, null);
  assert.deepEqual(config.legacyHoldUsernames, []);
  assert.equal(config.importEnvPath, null);
  const blank = loadConfig({ SOCIAL_DESK_LEGACY_ACCOUNTS_DIR: '  ', SOCIAL_DESK_LEGACY_HOLD_USERNAMES: ' , ', SOCIAL_DESK_IMPORT_ENV_PATH: '' }, '/app');
  assert.equal(blank.legacyAccountsDir, null);
  assert.deepEqual(blank.legacyHoldUsernames, []);
  assert.equal(blank.importEnvPath, null);
});

test('configuration: legacy variables are parsed, normalized and validated', () => {
  const config = loadConfig({
    SOCIAL_DESK_LEGACY_ACCOUNTS_DIR: 'legacy/accounts',
    SOCIAL_DESK_LEGACY_HOLD_USERNAMES: ' @Cuenta_Demo , otra.cuenta,cuenta_demo ',
    SOCIAL_DESK_IMPORT_ENV_PATH: 'config/meta.env',
  }, '/app');
  assert.equal(config.legacyAccountsDir, resolve('/app', 'legacy/accounts'));
  assert.deepEqual(config.legacyHoldUsernames, ['cuenta_demo', 'otra.cuenta']);
  assert.equal(config.importEnvPath, resolve('/app', 'config/meta.env'));
  assert.equal(loadConfig({ SOCIAL_DESK_LEGACY_ACCOUNTS_DIR: '~/legado' }, '/app').legacyAccountsDir, join(homedir(), 'legado'));
  assert.throws(() => loadConfig({ SOCIAL_DESK_LEGACY_HOLD_USERNAMES: 'valid,not valid!' }, '/app'), /SOCIAL_DESK_LEGACY_HOLD_USERNAMES/);
});

test('no legacy configuration means no interlock at all (nothing is read)', () => {
  assert.equal(legacyInterlockFromConfig({ legacyAccountsDir: null, legacyHoldUsernames: [] }), undefined);
});

test('hold usernames without a legacy directory: configured accounts are held, others are not, and no file is touched', async (context) => {
  const cwd = tempDir(context, 'social-legacy-nodir-');
  const interlock = legacyInterlockFromConfig({ legacyAccountsDir: null, legacyHoldUsernames: ['cuenta_demo'] })!;
  const held = interlock.inspect('@Cuenta_Demo');
  assert.deepEqual(held, { blocked: true, reasonCode: 'legacy_historical_rejection', lockPresent: false, counterVersion: 'absent', holdConfigured: true });
  assert.deepEqual(interlock.inspect('otra_cuenta'), { blocked: false, lockPresent: false, counterVersion: 'absent', holdConfigured: false });
  assert.equal(interlock.acknowledge('cuenta_demo', 'absent').ok, true);
  assert.equal(interlock.acknowledge('cuenta_demo', 'something-else').ok, false);
  assert.equal(await interlock.withExclusiveLock('cuenta_demo', async () => 'ran'), 'ran');
  assert.equal(existsSync(join(cwd, 'cuenta_demo')), false);
});

test('a configured legacy directory keeps lock/counter detection and adds the configured hold', (context) => {
  const root = tempDir(context, 'social-legacy-dir-');
  mkdirSync(join(root, 'otra_cuenta'));
  writeFileSync(join(root, 'otra_cuenta', 'rejection-counter.json'), '{"count":1}');
  const interlock = createLegacyInterlock({ accountsDir: root, holdUsernames: ['cuenta_demo'] });
  assert.equal(interlock.inspect('otra_cuenta').reasonCode, 'legacy_rejection_history');
  assert.equal(interlock.inspect('otra_cuenta').holdConfigured, false);
  assert.equal(interlock.inspect('cuenta_demo').reasonCode, 'legacy_historical_rejection');
  assert.equal(interlock.inspect('tercera').blocked, false);
});

function seedAccount(database: ReturnType<typeof openDatabase>, username: string) {
  createConnection(database, { id: 'connection', name: 'Test', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
  addDiscoveredAccount(database, { accountId: 'account', connectionId: 'connection', providerAccountId: 'provider', username, status: 'valid' });
}

async function selectThroughApi(context: { after(fn: () => void): void }, username: string,
  legacy?: ReturnType<typeof createLegacyInterlock>) {
  const directory = tempDir(context, 'social-legacy-api-');
  const database = openDatabase(directory);
  migrateDatabase(database);
  context.after(() => database.close());
  seedAccount(database, username);
  const handler = createApiHandler({ database, csrfToken: CSRF, automations: new AutomationService(database),
    connections: { async selectAccount() { return { accountId: 'account', username }; } } as never,
    ...(legacy ? { legacy } : {}) });
  const { server, origin } = await listen(handler);
  context.after(() => server.close());
  const selected = await call(origin, '/api/connections/connection/select', { account: { providerAccountId: 'provider', username } });
  assert.equal(selected.status, 201);
  const hold = database.prepare(`SELECT reason_code FROM account_send_holds WHERE account_id='account'`).get() as { reason_code: string } | undefined;
  return { origin, database, hold: hold?.reason_code };
}

test('API: without legacy configuration no account starts held and the legacy status never blocks', async (context) => {
  const { origin, hold } = await selectThroughApi(context, 'cuenta_demo');
  assert.equal(hold, undefined);
  const status = await call(origin, '/api/settings/legacy?username=cuenta_demo');
  assert.equal(status.json.blocked, false);
  assert.equal(status.json.enabled, false);
  const features = await call(origin, '/api/settings/features');
  assert.deepEqual(features.json, { envImport: false, legacyInterlock: false });
});

test('API: a configured hold username starts held on selection and is released only by an acknowledgement', async (context) => {
  const legacy = createLegacyInterlock({ accountsDir: null, holdUsernames: ['cuenta_demo'] });
  const { origin, database, hold } = await selectThroughApi(context, 'Cuenta_Demo', legacy);
  assert.equal(hold, 'legacy_historical_rejection');
  const status = await call(origin, '/api/settings/legacy?username=cuenta_demo');
  assert.equal(status.json.blocked, true);
  assert.equal(status.json.enabled, true);
  assert.deepEqual((await call(origin, '/api/settings/features')).json, { envImport: false, legacyInterlock: true });
  const ack = await call(origin, '/api/settings/legacy/acknowledge', { accountId: 'account', counterVersion: 'absent', confirmed: true });
  assert.equal(ack.status, 200);
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM account_send_holds`).get()!.n, 0);
});

test('API: an account not listed is not held even when the interlock is configured', async (context) => {
  const legacy = createLegacyInterlock({ accountsDir: null, holdUsernames: ['cuenta_demo'] });
  const { hold } = await selectThroughApi(context, 'otra_cuenta', legacy);
  assert.equal(hold, undefined);
});

test('API: a pre-existing legacy hold can still be acknowledged after the feature is turned off', async (context) => {
  const { origin, database } = await selectThroughApi(context, 'cuenta_demo');
  new AutomationService(database).setAccountSendHold('account', 'legacy_historical_rejection');
  const ack = await call(origin, '/api/settings/legacy/acknowledge', { accountId: 'account', counterVersion: 'absent', confirmed: true });
  assert.equal(ack.status, 200);
  assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM account_send_holds`).get()!.n, 0);
});

test('API: .env import is reported as enabled only when an import source is configured', async (context) => {
  const directory = tempDir(context, 'social-env-feature-');
  const database = openDatabase(directory);
  migrateDatabase(database);
  context.after(() => database.close());
  const handler = createApiHandler({ database, csrfToken: CSRF,
    async importEnvironment() { throw new Error('not called'); } });
  const { server, origin } = await listen(handler);
  context.after(() => server.close());
  assert.deepEqual((await call(origin, '/api/settings/features')).json, { envImport: true, legacyInterlock: false });
});

async function queueFixture(context: { after(fn: () => void): void }) {
  const directory = tempDir(context, 'social-legacy-queue-generic-');
  const database = openDatabase(directory);
  migrateDatabase(database);
  context.after(() => database.close());
  seedAccount(database, 'cuenta_demo');
  createMedia(database, { accountId: 'account', mediaId: 'media', permalink: null, publishedAt: null });
  const createdAt = new Date(Date.now() - 1000).toISOString();
  createComment(database, { accountId: 'account', mediaId: 'media', commentId: 'comment', text: 'guide', username: 'visitor', createdAt });
  database.prepare(`UPDATE social_accounts SET monitoring_paused=0 WHERE account_id='account'`).run();
  database.prepare(`UPDATE connections SET monitoring_paused=0 WHERE id='connection'`).run();
  const automations = new AutomationService(database);
  const automationId = automations.create({ accountId: 'account', mediaId: 'media', name: 'Test', replyText: 'Hi' });
  automations.addKeyword('account', automationId, 'guide');
  automations.setEnabled('account', automationId, true);
  automations.setRealEnabled('account', automationId, true, true);
  const counter = { sends: 0 };
  const provider = {
    async getComment() { return { commentId: 'comment', text: 'guide', username: 'visitor', createdAt }; },
    async sendPrivateReply() { counter.sends++; return { outcome: 'accepted' as const, messageId: 'message-id' }; },
    async readMessage() { return { messageId: 'message-id', observedAt: new Date().toISOString() }; },
  };
  return { database, automationId, counter, provider };
}

test('queue: a configured hold username with no counter file still needs an acknowledgement before sending', async (context) => {
  const { database, automationId, counter, provider } = await queueFixture(context);
  const legacyInterlock = createLegacyInterlock({ accountsDir: null, holdUsernames: ['cuenta_demo'] });
  const queue = new QueueService(database, provider as never, { legacyInterlock });
  queue.setDryRun(false, true);
  await queue.enqueueReviewed('account', automationId, ['comment']);
  await queue.processOne();
  assert.equal(counter.sends, 0);
  database.prepare(`INSERT INTO legacy_account_acknowledgements(account_id, username, counter_version, acknowledged_at)
    VALUES ('account','cuenta_demo','absent',?)`).run(new Date().toISOString());
  await queue.processOne();
  assert.equal(counter.sends, 1);
});

test('queue: an account not listed sends without an acknowledgement when no counter exists', async (context) => {
  const { database, automationId, counter, provider } = await queueFixture(context);
  const legacyInterlock = createLegacyInterlock({ accountsDir: null, holdUsernames: ['otra_cuenta'] });
  const queue = new QueueService(database, provider as never, { legacyInterlock });
  queue.setDryRun(false, true);
  await queue.enqueueReviewed('account', automationId, ['comment']);
  await queue.processOne();
  assert.equal(counter.sends, 1);
});
