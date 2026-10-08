import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import test from 'node:test';
import { createApiHandler } from '../src/http/router.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';

async function listen(handler: ReturnType<typeof createApiHandler>): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function call(origin: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const url = new URL(path, origin);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { method: options.method ?? 'GET', headers: options.headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

test('local API requires same-origin CSRF token and strict bounded JSON for mutations', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'local-social-http-'));
  const database = openDatabase(directory);
  migrateDatabase(database);
  const dryRun = { enabled: true, confirmed: false };
  const handler = createApiHandler({
    database,
    csrfToken: 'test-csrf-token',
    queue: { setDryRun(enabled: boolean, confirmed: boolean) { dryRun.enabled = enabled; dryRun.confirmed = confirmed; } },
  } as never);
  const { server, origin } = await listen(handler);
  context.after(() => {
    server.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const noOrigin = await call(origin, '/api/settings/dry-run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"enabled":false}' });
  assert.equal(noOrigin.status, 403);
  const wrongOrigin = await call(origin, '/api/settings/dry-run', {
    method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' }, body: '{"enabled":false}',
  });
  assert.equal(wrongOrigin.status, 403);
  const noToken = await call(origin, '/api/settings/dry-run', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{"enabled":false}',
  });
  assert.equal(noToken.status, 403);
  const noConfirmation = await call(origin, '/api/settings/dry-run', {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' }, body: '{"enabled":false}',
  });
  assert.equal(noConfirmation.status, 400);
  assert.equal(dryRun.enabled, true);
  const wrongContent = await call(origin, '/api/settings/dry-run', {
    method: 'POST', headers: { origin, 'content-type': 'text/plain', 'x-csrf-token': 'test-csrf-token' }, body: '{}',
  });
  assert.equal(wrongContent.status, 415);
  const oversized = await call(origin, '/api/settings/dry-run', {
    method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-csrf-token': 'test-csrf-token' }, body: JSON.stringify({ enabled: false, data: 'x'.repeat(70_000) }),
  });
  assert.equal(oversized.status, 413);
});

test('queue pagination, dashboard, and attempt history enforce account ownership server-side', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'local-social-scope-'));
  const database = openDatabase(directory);
  migrateDatabase(database);
  for (const [suffix, username] of [['a', 'alpha'], ['b', 'beta']] as const) {
    createConnection(database, { id: `connection-${suffix}`, name: `Connection ${suffix}`, providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid', accessToken: { nonce: 'token-nonce', ciphertext: 'private-ciphertext', tag: 'tag' } });
    addDiscoveredAccount(database, { accountId: `account-${suffix}`, connectionId: `connection-${suffix}`, providerAccountId: `provider-${suffix}`, username, status: 'valid' });
    createMedia(database, { accountId: `account-${suffix}`, mediaId: `media-${suffix}`, permalink: null, publishedAt: null });
    createComment(database, { accountId: `account-${suffix}`, mediaId: `media-${suffix}`, commentId: `comment-${suffix}`, text: 'guide', username: 'visitor', createdAt: new Date().toISOString() });
  }
  database.prepare(`INSERT INTO automations(automation_id,account_id,media_id,name,status,match_mode,reply_text,created_at,updated_at)
    VALUES ('auto-a','account-a','media-a','Automation','disabled','contains','Hi',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
  database.prepare(`INSERT INTO queue_items(queue_item_id,account_id,comment_id,automation_id,state,dry_run,payload_json,created_at,updated_at)
    VALUES ('queue-a','account-a','comment-a','auto-a','UNKNOWN_OUTCOME',0,'{"text":"Hi","buttons":[]}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();
  database.prepare(`INSERT INTO send_attempts(attempt_event_id,account_id,queue_item_id,event_type,event_at,message_id,safe_error_code,details_json)
    VALUES ('event-a','account-a','queue-a','ambiguous_outcome',CURRENT_TIMESTAMP,NULL,'network_timeout','{"secret":"must-not-escape","usageHeaders":{"appUsage":"safe"}}')`).run();
  const { server, origin } = await listen(createApiHandler({ database }));
  context.after(() => { server.close(); database.close(); rmSync(directory, { recursive: true, force: true }); });

  const own = await call(origin, '/api/queue?accountId=account-a&limit=1');
  assert.equal(JSON.parse(own.body).total, 1);
  assert.equal(JSON.parse(own.body).items[0].state, 'UNKNOWN_OUTCOME');
  const other = await call(origin, '/api/queue?accountId=account-b');
  assert.equal(JSON.parse(other.body).total, 0);
  const stats = await call(origin, '/api/dashboard?accountId=account-b');
  assert.deepEqual(JSON.parse(stats.body).queue, []);
  const attempts = await call(origin, '/api/queue/queue-a/attempts?accountId=account-b');
  assert.equal(attempts.status, 404);
  const history = await call(origin, '/api/queue/queue-a/attempts?accountId=account-a');
  assert.equal(history.status, 200);
  assert.equal(history.body.includes('must-not-escape'), false);
  assert.equal(history.body.includes('network_timeout'), true);
  const connections = await call(origin, '/api/connections');
  assert.equal(connections.body.includes('private-ciphertext'), false);
  assert.equal(connections.body.includes('token-nonce'), false);
});

test('explicit root environment import is invoked only after confirmation and never returns a token', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'local-social-import-'));
  const database = openDatabase(directory);
  migrateDatabase(database);
  let imports = 0;
  let receivedToken = '';
  const handler = createApiHandler({ database, csrfToken: 'import-csrf',
    async importEnvironment() { imports++; return { loginKind: 'instagram_login', accessToken: 'never-return-this-token', appId: 'app-id', graphVersion: 'v26.0', name: 'Imported' }; },
    connections: { async create(input: { accessToken: string }) { receivedToken = input.accessToken; return { id: 'safe-connection', status: 'unvalidated' }; } },
  } as never);
  const { server, origin } = await listen(handler);
  context.after(() => { server.close(); database.close(); rmSync(directory, { recursive: true, force: true }); });

  await call(origin, '/api/session');
  assert.equal(imports, 0);
  const refused = await call(origin, '/api/settings/import-root-env', { method: 'POST', headers: { origin, 'x-csrf-token': 'import-csrf', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 400);
  assert.equal(imports, 0);
  const imported = await call(origin, '/api/settings/import-root-env', { method: 'POST', headers: { origin, 'x-csrf-token': 'import-csrf', 'content-type': 'application/json' }, body: '{"confirmed":true,"path":"/tmp/attacker.env"}' });
  assert.equal(imported.status, 201);
  assert.equal(imports, 1);
  assert.equal(receivedToken, 'never-return-this-token');
  assert.equal(imported.body.includes('never-return-this-token'), false);
});
