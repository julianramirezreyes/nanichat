import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer as createTcpServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { AutomationService } from '../src/services/automations.ts';
import { createVault } from '../src/security/vault.ts';
import { stopProcessTree } from './helpers/process.ts';
import { removeTempDir } from './helpers/tmp.ts';

async function unusedPort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function getStatus(port: number, path: string, host = `127.0.0.1:${port}`, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('local server starts with the supported Node runner and exposes a loopback-only health route', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'local-social-server-'));
  const port = await unusedPort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), LOCAL_SOCIAL_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    await stopProcessTree(child);
    removeTempDir(directory);
  });

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const deadline = Date.now() + 15000;
  let result: { status: number; body: string } | undefined;
  while (Date.now() < deadline && child.exitCode === null && !result) {
    if (output.includes('Local app listening')) {
      result = await getStatus(port, '/api/health');
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(result, `server did not start; exit=${child.exitCode}; output=${output}`);
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { status: 'ok', ready: true });
  assert.equal((await getStatus(port, '/api/health', `untrusted.example:${port}`)).status, 421);
  assert.equal((await getStatus(port, '/api/health', `127.0.0.1:${port}`, 'POST')).status, 405);

  const secondPort = await unusedPort();
  const sharedDb = openDatabase(directory);
  migrateDatabase(sharedDb);
  const vault = createVault(directory, () => []);
  createConnection(sharedDb, {
    id: 'active-connection', name: 'Active', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid',
    accessToken: vault.encrypt('active-connection', 'test-token-not-live'),
  });
  addDiscoveredAccount(sharedDb, {
    accountId: 'active-account', connectionId: 'active-connection', providerAccountId: 'provider-id', username: 'brand', status: 'valid',
  });
  createMedia(sharedDb, { accountId: 'active-account', mediaId: 'active-media', permalink: null, publishedAt: null });
  createComment(sharedDb, { accountId: 'active-account', mediaId: 'active-media', commentId: 'active-comment', text: 'guide', username: 'visitor',
    createdAt: new Date(Date.now() - 1000).toISOString() });
  const automationId = new AutomationService(sharedDb).create({
    accountId: 'active-account', mediaId: 'active-media', name: 'active', replyText: 'Hello',
  });
  sharedDb.prepare(`INSERT INTO queue_items(queue_item_id, account_id, comment_id, automation_id, state, dry_run, payload_json, created_at, updated_at)
    VALUES ('live-intent', 'active-account', 'active-comment', ?, 'SENDING', 0, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).run(automationId);
  sharedDb.prepare(`INSERT INTO send_attempts(attempt_event_id, account_id, queue_item_id, event_type, event_at)
    VALUES ('live-intent-event', 'active-account', 'live-intent', 'intent_recorded', CURRENT_TIMESTAMP)`).run();
  sharedDb.close();

  const second = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(secondPort), LOCAL_SOCIAL_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let secondOutput = '';
  second.stdout.setEncoding('utf8');
  second.stderr.setEncoding('utf8');
  second.stdout.on('data', (chunk) => { secondOutput += chunk; });
  second.stderr.on('data', (chunk) => { secondOutput += chunk; });
  context.after(() => stopProcessTree(second));
  await Promise.race([once(second, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
  assert.equal(second.exitCode, 1, `second owner did not fail safely; output=${secondOutput}`);
  assert.match(secondOutput, /already running|ownership is uncertain/i);
  assert.equal(secondOutput.includes('Local app listening'), false);
  const stateDb = openDatabase(directory);
  assert.equal((stateDb.prepare(`SELECT state FROM queue_items WHERE queue_item_id='live-intent'`).get() as { state: string }).state, 'SENDING');
  stateDb.close();
});

test('server refuses readiness when the vault key cannot authenticate persisted credentials', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'local-social-corrupt-vault-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  const encrypted = createVault(directory, () => []).encrypt('connection-with-secret', 'do-not-print-this');
  createConnection(db, {
    id: 'connection-with-secret', name: 'Stored connection', providerCode: 'META',
    loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid', accessToken: encrypted,
  });
  db.close();
  const replacementKey = randomBytes(32);
  writeFileSync(join(directory, 'vault.key'), replacementKey, { mode: 0o600 });
  const port = await unusedPort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), LOCAL_SOCIAL_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    await stopProcessTree(child);
    removeTempDir(directory);
  });

  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && child.exitCode === null && !output.includes('Local app listening')) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(child.exitCode, 1, `server did not fail closed; output=${output}`);
  assert.equal(output.includes('Local app listening'), false);
  assert.equal(output.includes('do-not-print-this'), false);
  assert.deepEqual(readFileSync(join(directory, 'vault.key')), replacementKey);
  const preservedDb = openDatabase(directory);
  assert.equal((preservedDb.prepare('SELECT COUNT(*) AS count FROM connections WHERE access_token_ciphertext IS NOT NULL').get() as { count: number }).count, 1);
  preservedDb.close();
});
