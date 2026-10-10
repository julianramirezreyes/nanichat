import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ConnectionValidation, DiscoveredAccount } from '../src/core/domain.ts';
import { AccountAdoptionRequiredError, RepositoryConflictError } from '../src/core/errors.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { createComment, createMedia, getAccountSummary, listEncryptedCredentials } from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { createVault } from '../src/security/vault.ts';
import { ConnectionService } from '../src/services/connections.ts';
import { ADOPTION_REQUIRED_CODE, ADOPTION_PROMPT, isAdoptionRequired, orphanOrigin } from '../app/orphaned-accounts.ts';
import { removeTempDir } from './helpers/tmp.ts';

class FakeProvider {
  readonly discovered = new Map<string, DiscoveredAccount[]>();
  readonly accountCredentials = new Map<string, string>();
  async validateConnection(): Promise<ConnectionValidation> {
    return { status: 'valid', observedAt: '2026-10-05T00:00:00Z', providerUserId: 'user-1', username: 'owner', capabilities: ['identity_read'] };
  }
  async discoverAccounts(connectionId: string) { return this.discovered.get(connectionId) ?? []; }
  async credentialForSelectedAccount(connectionId: string, account: DiscoveredAccount) {
    return this.accountCredentials.get(`${connectionId}:${account.providerAccountId}`);
  }
}

async function setup(context: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'social-adopt-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  const vault = createVault(directory, () => listEncryptedCredentials(db));
  const provider = new FakeProvider();
  const service = new ConnectionService(db, vault, provider as never);
  context.after(() => { db.close(); removeTempDir(directory); });
  const connect = async (id: string, accounts: DiscoveredAccount[]) => {
    await service.create({ id, name: `Name ${id}`, loginKind: 'instagram_login', graphVersion: 'v26.0', accessToken: `token-${id}` });
    await service.testConnection(id);
    provider.discovered.set(id, accounts);
    return service.discoverAccounts(id);
  };
  return { db, service, provider, connect, vault };
}

const BRAND: DiscoveredAccount = { providerAccountId: 'ig-1', username: 'Brand', displayName: 'Brand', capabilities: ['media_read'] };

async function seedOrphan(env: Awaited<ReturnType<typeof setup>>, how: 'disconnect' | 'delete') {
  const [candidate] = await env.connect('old', [BRAND]);
  env.provider.accountCredentials.set('old:ig-1', 'old-page-token');
  const account = await env.service.selectAccount('old', candidate!);
  createMedia(env.db, { accountId: account.accountId, mediaId: 'm1', permalink: null, publishedAt: null });
  createComment(env.db, { accountId: account.accountId, mediaId: 'm1', commentId: 'c1', text: 'hi', username: 'u', createdAt: null });
  env.db.prepare(`INSERT INTO automations (automation_id, account_id, media_id, name, status, match_mode, reply_text, created_at, updated_at)
    VALUES ('auto-1', ?, 'm1', 'A', 'disabled', 'contains', 'hello', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`).run(account.accountId);
  if (how === 'delete') await env.service.delete('old'); else await env.service.disconnect('old');
  return account;
}

test('an account owned by an active connection is still rejected as a plain conflict', async (context) => {
  const env = await setup(context);
  const [candidate] = await env.connect('first', [BRAND]);
  await env.service.selectAccount('first', candidate!);
  const [again] = await env.connect('second', [{ ...BRAND, providerAccountId: 'ig-other' }]);
  await assert.rejects(env.service.selectAccount('second', again!, { adopt: true }), (error: unknown) =>
    error instanceof RepositoryConflictError && !(error instanceof AccountAdoptionRequiredError));
  await assert.rejects(env.service.selectAccount('second', again!), (error: unknown) =>
    error instanceof RepositoryConflictError && !(error instanceof AccountAdoptionRequiredError));
});

test('a disconnected owner yields a typed adoption-required error and changes nothing without confirmation', async (context) => {
  const env = await setup(context);
  const original = await seedOrphan(env, 'disconnect');
  const [candidate] = await env.connect('new', [BRAND]);
  await assert.rejects(env.service.selectAccount('new', candidate!), (error: unknown) =>
    error instanceof AccountAdoptionRequiredError && error.code === 'account_adoption_required');
  assert.equal(getAccountSummary(env.db, original.accountId).connectionId, 'old');
  assert.equal(getAccountSummary(env.db, original.accountId).status, 'disconnected');
});

test('confirmed adoption keeps the account id, its history and automations, and only moves the connection', async (context) => {
  const env = await setup(context);
  const original = await seedOrphan(env, 'disconnect');
  const oldBefore = env.db.prepare('SELECT status, deleted_at FROM connections WHERE id=?').get('old');
  const [candidate] = await env.connect('new', [BRAND]);
  env.provider.accountCredentials.set('new:ig-1', 'new-page-token');
  const adopted = await env.service.selectAccount('new', candidate!, { adopt: true });
  assert.equal(adopted.accountId, original.accountId);
  assert.equal(adopted.connectionId, 'new');
  assert.equal(adopted.status, 'valid');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM social_accounts').get()!.n, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE account_id=?').get(original.accountId)!.n, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM automations WHERE account_id=?').get(original.accountId)!.n, 1);
  assert.deepEqual(env.db.prepare('SELECT status, deleted_at FROM connections WHERE id=?').get('old'), oldBefore);
  const token = listEncryptedCredentials(env.db).find((item) => item.contextId === `account:${original.accountId}`);
  assert.ok(token);
  assert.equal(env.vault.decrypt(token.contextId, token.secret), 'new-page-token');
});

test('adoption also works when the previous connection was deleted', async (context) => {
  const env = await setup(context);
  const original = await seedOrphan(env, 'delete');
  assert.ok((env.db.prepare('SELECT deleted_at FROM connections WHERE id=?').get('old') as { deleted_at: string | null }).deleted_at);
  const [candidate] = await env.connect('new', [BRAND]);
  const adopted = await env.service.selectAccount('new', candidate!, { adopt: true });
  assert.equal(adopted.accountId, original.accountId);
  assert.equal(adopted.connectionId, 'new');
});

test('an ambiguous match (provider id and username on different rows) is never adopted', async (context) => {
  const env = await setup(context);
  const [a] = await env.connect('old-a', [{ providerAccountId: 'ig-a', username: 'alpha', capabilities: [] }]);
  await env.service.selectAccount('old-a', a!);
  const [b] = await env.connect('old-b', [{ providerAccountId: 'ig-b', username: 'beta', capabilities: [] }]);
  await env.service.selectAccount('old-b', b!);
  await env.service.disconnect('old-a');
  await env.service.disconnect('old-b');
  const [mixed] = await env.connect('new', [{ providerAccountId: 'ig-a', username: 'beta', capabilities: [] }]);
  await assert.rejects(env.service.selectAccount('new', mixed!, { adopt: true }), (error: unknown) =>
    error instanceof RepositoryConflictError && !(error instanceof AccountAdoptionRequiredError));
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM social_accounts WHERE connection_id='new'").get()!.n, 0);
});

async function listen(handler: ReturnType<typeof createApiHandler>): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
function call(origin: string, path: string, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { origin, 'x-csrf-token': 'csrf', 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('API: adoption needs confirmed:true, the orphan list has no secrets, and ownership is respected', async (context) => {
  const env = await setup(context);
  const original = await seedOrphan(env, 'delete');
  const [candidate] = await env.connect('new', [BRAND]);
  env.provider.accountCredentials.set('new:ig-1', 'new-page-token');
  const handler = createApiHandler({ database: env.db, csrfToken: 'csrf', connections: env.service } as never);
  const { server, origin } = await listen(handler);
  context.after(() => { server.close(); });

  const orphans = await call(origin, '/api/accounts/orphaned');
  assert.equal(orphans.status, 200);
  const listed = JSON.parse(orphans.body).accounts as Array<Record<string, unknown>>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.accountId, original.accountId);
  assert.equal(listed[0]!.previousConnectionName, 'Name old');
  assert.equal(listed[0]!.connectionDeleted, true);
  for (const secret of ['token', 'ciphertext', 'nonce', 'old-page-token', 'new-page-token']) assert.equal(orphans.body.includes(secret), false, secret);

  const plain = await call(origin, '/api/connections/new/select', { account: candidate });
  assert.equal(plain.status, 409);
  assert.equal(JSON.parse(plain.body).error, ADOPTION_REQUIRED_CODE);
  const notBoolean = await call(origin, '/api/connections/new/select', { account: candidate, confirmed: 'yes' });
  assert.equal(JSON.parse(notBoolean.body).error, ADOPTION_REQUIRED_CODE);
  assert.equal(getAccountSummary(env.db, original.accountId).connectionId, 'old');

  const wrongConnection = await call(origin, '/api/connections/ghost/select', { account: candidate, confirmed: true });
  assert.notEqual(wrongConnection.status, 201);

  const adopted = await call(origin, '/api/connections/new/select', { account: candidate, confirmed: true });
  assert.equal(adopted.status, 201);
  assert.equal(JSON.parse(adopted.body).account.accountId, original.accountId);
  assert.equal(adopted.body.includes('new-page-token'), false);
  const after = JSON.parse((await call(origin, '/api/accounts/orphaned')).body).accounts;
  assert.deepEqual(after, []);
});

test('UI helpers recognise the adoption code and label the origin of an orphaned account', () => {
  assert.equal(isAdoptionRequired('account_adoption_required'), true);
  assert.equal(isAdoptionRequired('operation_rejected'), false);
  assert.equal(isAdoptionRequired(undefined), false);
  assert.match(ADOPTION_PROMPT, /conservan su historial, cola y automatizaciones/u);
  assert.equal(orphanOrigin({ connectionDeleted: true }), 'Conexión eliminada');
  assert.equal(orphanOrigin({ connectionDeleted: false }), 'Conexión desconectada');
});
