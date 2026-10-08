import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/core/config.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import {
  addDiscoveredAccount,
  createConnection,
  createMedia,
  createComment,
  getConnectionSummary,
  hasEncryptedSecrets,
  listEncryptedCredentials,
  listComments,
} from '../src/db/repositories.ts';
import { RepositoryConflictError } from '../src/core/errors.ts';
import { createVault } from '../src/security/vault.ts';
import { redactSecrets } from '../src/security/redact.ts';

function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'local-social-foundation-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function seededDatabase(directory: string) {
  const db = openDatabase(directory);
  migrateDatabase(db);
  createConnection(db, {
    id: 'connection-instagram', name: 'Main IG', providerCode: 'META', loginKind: 'instagram_login',
    graphVersion: 'v26.0', status: 'valid',
  });
  createConnection(db, {
    id: 'connection-facebook', name: 'Page login', providerCode: 'META', loginKind: 'facebook_login',
    graphVersion: 'v26.0', status: 'valid',
  });
  addDiscoveredAccount(db, {
    accountId: 'account-main', connectionId: 'connection-instagram', providerAccountId: 'ig-app-id-1',
    username: 'BrandAccount', status: 'valid',
  });
  return db;
}

test('configuration defaults to a loopback-only local app and keeps monitoring off and dry run on', () => {
  const config = loadConfig({}, '/app');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.monitoringEnabled, false);
  assert.equal(config.dryRun, true);
  assert.equal(config.dataDir, resolve('/app', 'data'));
});

test('vault encrypts with authenticated connection context and refuses missing keys for encrypted state', () => {
  withTempDir((directory) => {
    const vault = createVault(directory, () => []);
    const encrypted = vault.encrypt('connection-one', 'secret-access-token');
    assert.equal(vault.decrypt('connection-one', encrypted), 'secret-access-token');
    assert.throws(() => vault.decrypt('connection-two', encrypted));
    const keyMode = statSync(join(directory, 'vault.key')).mode & 0o777;
    assert.equal(keyMode, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.ok(!JSON.stringify(encrypted).includes('secret-access-token'));
    rmSync(join(directory, 'vault.key'));
    assert.throws(() => createVault(directory, () => [{ contextId: 'connection-one', secret: encrypted }]), /key.*missing|missing.*key/i);
  });
});

test('vault refuses a valid-length replacement key when stored ciphertext cannot authenticate', () => {
  withTempDir((directory) => {
    const original = createVault(directory, () => []);
    const encrypted = original.encrypt('connection-one', 'stored-token');
    writeFileSync(join(directory, 'vault.key'), randomBytes(32), { mode: 0o600 });
    assert.throws(() => createVault(directory, () => [{ contextId: 'connection-one', secret: encrypted }]), /key|credential|decrypt/i);
  });
});

test('redaction removes known secrets and bearer credentials from safe error text', () => {
  assert.equal(
    redactSecrets('failed token=plain-secret Authorization: Bearer another-secret', ['plain-secret']),
    'failed token=[REDACTED] Authorization: Bearer [REDACTED]',
  );
});

test('SQLite initializes durability pragmas and migrations are safe to reopen', () => {
  withTempDir((directory) => {
    const db = openDatabase(directory);
    migrateDatabase(db);
    migrateDatabase(db);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    assert.equal((db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous, 2);
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    db.close();
    const reopened = openDatabase(directory);
    migrateDatabase(reopened);
    assert.ok((reopened.prepare('PRAGMA user_version').get() as { user_version: number }).user_version >= 1);
    reopened.close();
  });
});

test('failed migration rolls back its partial schema and preserves the pre-existing database state', () => {
  withTempDir((directory) => {
    const db = openDatabase(directory);
    db.exec('CREATE TABLE comments (legacy_marker TEXT); INSERT INTO comments VALUES (\'keep\');');
    assert.throws(() => migrateDatabase(db));
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0);
    assert.equal((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'connections'").get()), undefined);
    assert.equal((db.prepare('SELECT legacy_marker FROM comments').get() as { legacy_marker: string }).legacy_marker, 'keep');
    db.close();
  });
});

test('queue storage enforces one private reply item per account/comment regardless of automation', () => {
  withTempDir((directory) => {
    const db = seededDatabase(directory);
    createMedia(db, { accountId: 'account-main', mediaId: 'media-queue', permalink: null, publishedAt: null });
    createComment(db, { accountId: 'account-main', mediaId: 'media-queue', commentId: 'comment-queue', text: 'hello', username: 'person', createdAt: null });
    createComment(db, { accountId: 'account-main', mediaId: 'media-queue', commentId: 'comment-queue-two', text: 'hello again', username: 'person', createdAt: null });
    const now = new Date().toISOString();
    const insertAutomation = db.prepare(`INSERT INTO automations
      (automation_id, account_id, media_id, name, created_at, updated_at)
      VALUES (?, 'account-main', 'media-queue', ?, ?, ?)`);
    insertAutomation.run('auto-one', 'First', now, now);
    insertAutomation.run('auto-two', 'Second', now, now);
    const insertQueue = db.prepare(`INSERT INTO queue_items
      (queue_item_id, account_id, comment_id, automation_id, state, dry_run, payload_json, created_at, updated_at)
      VALUES (?, 'account-main', ?, ?, 'SIMULATED', 1, '{}', ?, ?)`);
    insertQueue.run('queue-one', 'comment-queue', null, now, now);
    assert.throws(() => insertQueue.run('queue-null-duplicate', 'comment-queue', null, now, now));
    assert.throws(() => insertQueue.run('queue-auto-one', 'comment-queue', 'auto-one', now, now));
    assert.throws(() => insertQueue.run('queue-auto-two', 'comment-queue', 'auto-two', now, now));
    insertQueue.run('queue-comment-two-auto-one', 'comment-queue-two', 'auto-one', now, now);
    assert.throws(() => insertQueue.run('queue-comment-two-auto-two', 'comment-queue-two', 'auto-two', now, now));
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM queue_items WHERE account_id = 'account-main' AND comment_id = 'comment-queue'").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM queue_items WHERE account_id = 'account-main' AND comment_id = 'comment-queue-two'").get() as { count: number }).count, 1);
    db.close();
  });
});

test('v1 migration with duplicate queue items fails without deleting or changing them', () => {
  withTempDir((directory) => {
    const db = openDatabase(directory);
    db.exec(`CREATE TABLE queue_items (
      queue_item_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, comment_id TEXT NOT NULL,
      automation_id TEXT, UNIQUE(account_id, comment_id, automation_id)
    );
    INSERT INTO queue_items VALUES ('q1', 'a1', 'c1', NULL);
    INSERT INTO queue_items VALUES ('q2', 'a1', 'c1', NULL);
    PRAGMA user_version = 1;`);
    assert.throws(() => migrateDatabase(db), /duplicate|one.*reply|queue/i);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM queue_items WHERE account_id = 'a1' AND comment_id = 'c1'").get() as { count: number }).count, 2);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='queue_one_initial_reply_per_comment'").get(), undefined);
    db.close();
  });
});

test('account repository isolates content and rejects duplicate provider IDs or normalized usernames', () => {
  withTempDir((directory) => {
    const db = seededDatabase(directory);
    createMedia(db, { accountId: 'account-main', mediaId: 'media-1', permalink: null, publishedAt: null });
    createComment(db, { accountId: 'account-main', mediaId: 'media-1', commentId: 'comment-1', text: 'hello', username: 'person', createdAt: null });
    assert.deepEqual(listComments(db, 'account-main').map((row) => row.comment_id), ['comment-1']);
    assert.deepEqual(listComments(db, 'account-other'), []);
    assert.throws(() => createComment(db, {
      accountId: 'account-main', mediaId: 'some-other-account-media', commentId: 'foreign-comment',
      text: 'should fail', username: null, createdAt: null,
    }));
    assert.throws(() => addDiscoveredAccount(db, {
      accountId: 'account-other-id', connectionId: 'connection-facebook', providerAccountId: 'ig-app-id-1',
      username: 'other', status: 'valid',
    }), RepositoryConflictError);
    assert.throws(() => addDiscoveredAccount(db, {
      accountId: 'account-other-name', connectionId: 'connection-facebook', providerAccountId: 'different-app-scoped-id',
      username: ' brandACCOUNT ', status: 'valid',
    }), RepositoryConflictError);
    const safeSummary = getConnectionSummary(db, 'connection-instagram');
    assert.equal('tokenCiphertext' in safeSummary, false);
    const vault = createVault(directory, () => listEncryptedCredentials(db));
    const encryptedToken = vault.encrypt('connection-with-token', 'do-not-return-this-token');
    createConnection(db, {
      id: 'connection-with-token', name: 'Token connection', providerCode: 'META',
      loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'unvalidated', accessToken: encryptedToken,
    });
    assert.equal(hasEncryptedSecrets(db), true);
    assert.equal(JSON.stringify(getConnectionSummary(db, 'connection-with-token')).includes('do-not-return-this-token'), false);
    db.close();
  });
});
