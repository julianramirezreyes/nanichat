import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLegacyInterlock } from '../src/services/legacy-interlock.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { addDiscoveredAccount, createComment, createConnection, createMedia } from '../src/db/repositories.ts';
import { AutomationService } from '../src/services/automations.ts';
import { QueueService } from '../src/services/queue.ts';
import { removeTempDir } from './helpers/tmp.ts';

test('legacy lock adapter blocks pre-existing ownership, acknowledges an unchanged counter version, and releases only its own lock', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'social-legacy-interlock-'));
  context.after(() => removeTempDir(root));
  const directory = join(root, 'customer');
  mkdirSync(directory);
  const counter = join(directory, 'rejection-counter.json');
  writeFileSync(counter, '{"count":3}', { mode: 0o600 });
  const interlock = createLegacyInterlock({ accountsDir: root, holdUsernames: [] });
  const observed = interlock.inspect('Customer');
  assert.equal(observed.blocked, true);
  assert.ok(observed.counterVersion);
  assert.equal(interlock.acknowledge('customer', observed.counterVersion!).ok, true);
  writeFileSync(counter, '{"count":4}', { mode: 0o600 });
  assert.equal(interlock.acknowledge('customer', observed.counterVersion!).ok, false);

  writeFileSync(join(directory, 'run.lock'), 'owned elsewhere', { mode: 0o600 });
  await assert.rejects(interlock.withExclusiveLock('customer', async () => 'sent'), /already exists/i);
  assert.equal((await import('node:fs')).readFileSync(join(directory, 'run.lock'), 'utf8'), 'owned elsewhere');
  rmSync(join(directory, 'run.lock'));
  assert.equal(await interlock.withExclusiveLock('customer', async () => 'completed'), 'completed');
  assert.equal(interlock.inspect('customer').lockPresent, false);
});

test('real queue sends only while holding the canonical lock and matching the acknowledged counter version', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'social-legacy-queue-'));
  const database = openDatabase(directory);
  // One hook, in order: node:test runs after-hooks FIFO, and Windows cannot remove a directory holding an open database.
  context.after(() => { database.close(); removeTempDir(directory); });
  migrateDatabase(database);
  createConnection(database, { id: 'connection', name: 'Test', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0', status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' } });
  addDiscoveredAccount(database, { accountId: 'account', connectionId: 'connection', providerAccountId: 'provider', username: 'customer', status: 'valid' });
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
  let lockCount = 0;
  let sends = 0;
  const interlock = {
    inspect() { return { blocked: true, lockPresent: false, counterVersion: 'stable-version' }; },
    async withExclusiveLock<T>(_username: string, operation: () => Promise<T>) { lockCount++; return operation(); },
  };
  database.prepare(`INSERT INTO legacy_account_acknowledgements(account_id, username, counter_version, acknowledged_at)
    VALUES ('account','customer','stable-version',?)`).run(new Date().toISOString());
  const queue = new QueueService(database, {
    async getComment() { return { commentId: 'comment', text: 'guide', username: 'visitor', createdAt }; },
    async sendPrivateReply() { sends++; return { outcome: 'accepted', messageId: 'message-id' }; },
    async readMessage() { return { messageId: 'message-id', observedAt: new Date().toISOString() }; },
  }, { legacyInterlock: interlock });
  queue.setDryRun(false, true);
  await queue.enqueueReviewed('account', automationId, ['comment']);
  await queue.processOne();
  assert.equal(lockCount, 1);
  assert.equal(sends, 1);
  assert.equal((database.prepare(`SELECT state FROM queue_items WHERE comment_id='comment'`).get() as { state: string }).state, 'SENT');
});
