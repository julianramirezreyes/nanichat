import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AccountRef } from '../src/core/domain.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import {
  addDiscoveredAccount, createComment, createConnection, createMedia, listEncryptedCredentials,
} from '../src/db/repositories.ts';
import { MetaProvider } from '../src/providers/meta/provider.ts';
import { createVault } from '../src/security/vault.ts';
import { AutomationService } from '../src/services/automations.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { removeTempDir } from './helpers/tmp.ts';

async function withProvider(
  rows: unknown,
  run: (ctx: { db: ReturnType<typeof openDatabase>; provider: MetaProvider; account: AccountRef; urls: URL[] }) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'comment-author-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  try {
    const vault = createVault(directory, () => listEncryptedCredentials(db));
    createConnection(db, {
      id: 'conn', name: 'test', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
      status: 'valid', accessToken: vault.encrypt('conn', 'ig-user-token'),
    });
    addDiscoveredAccount(db, {
      accountId: 'account', connectionId: 'conn', providerAccountId: '17841400000000000', username: 'brand', status: 'valid',
    });
    createMedia(db, { accountId: 'account', mediaId: 'media-1', permalink: null, publishedAt: null });
    createComment(db, { accountId: 'account', mediaId: 'media-1', commentId: 'c1', text: 'x', username: null, createdAt: null });
    const urls: URL[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      return url.pathname.endsWith('/comments') ? Response.json({ data: rows }) : Response.json((rows as unknown[])[0]);
    };
    const provider = new MetaProvider(db, vault, fetcher);
    const account: AccountRef = { accountId: 'account', connectionId: 'conn', providerAccountId: '17841400000000000', username: 'brand' };
    await run({ db, provider, account, urls });
  } finally {
    db.close();
    removeTempDir(directory);
  }
}

const base = { id: 'c1', text: 'guide please', timestamp: '2026-10-05T11:00:00Z' };

const cases: Array<[string, Record<string, unknown>, string | undefined]> = [
  ['top-level username only', { ...base, username: 'top' }, 'top'],
  ['from.username only', { ...base, from: { id: '1', username: 'fromUser' } }, 'fromUser'],
  ['both: top-level wins', { ...base, username: 'top', from: { id: '1', username: 'fromUser' } }, 'top'],
  ['empty top-level falls back to from', { ...base, username: '', from: { username: 'fromUser' } }, 'fromUser'],
  ['neither stays missing', { ...base }, undefined],
  ['from as string ignored', { ...base, from: 'fromUser' }, undefined],
  ['from as array ignored', { ...base, from: ['fromUser'] }, undefined],
  ['from as number ignored', { ...base, from: 7 }, undefined],
  ['non-string from.username ignored', { ...base, from: { username: 42 } }, undefined],
];

for (const [name, row, expected] of cases) {
  test(`author mapping: ${name} (listComments and getComment)`, async () => {
    await withProvider([row], async ({ provider, account, urls }) => {
      const page = await provider.listComments(account, 'media-1');
      assert.equal(page.items[0]!.username, expected);
      const single = await provider.getComment(account, 'c1');
      assert.equal(single.username, expected);
      for (const url of urls) {
        const fields = url.searchParams.get('fields')!.split(',');
        assert.ok(fields.includes('from'), 'fields must include from');
        assert.ok(fields.includes('username'));
        for (const required of ['id', 'text', 'timestamp', 'parent_id']) assert.ok(fields.includes(required));
      }
      assert.equal(urls.length, 2);
    });
  });
}

test('end to end: from.username-only root comment becomes eligible and renders {{username}}', async () => {
  await withProvider([{ ...base, id: 'c1', from: { id: '9', username: 'Maria' } }], async ({ db, provider, account }) => {
    const automations = new AutomationService(db);
    const id = automations.create({ accountId: 'account', mediaId: 'media-1', name: 'a', replyText: 'Hi {{username}}' });
    automations.addKeyword('account', id, 'guide');
    automations.setEnabled('account', id, true);
    const now = Date.parse('2026-10-05T12:00:00Z');
    const report = await new Scanner(db, provider).scanMedia(account, 'media-1', { kind: 'backlog', now });
    assert.equal(report.candidates.find((c) => c.commentId === 'c1')?.eligible, true);
    const queue = new QueueService(db, {} as never, { clock: () => Date.now() } as never);
    assert.deepEqual(await queue.enqueueReviewed('account', id, ['c1']), ['c1']);
    const item = db.prepare(`SELECT payload_json FROM queue_items WHERE comment_id='c1'`).get() as { payload_json: string };
    assert.equal(JSON.parse(item.payload_json).text, 'Hi Maria');
  });
});

test('end to end: own account username in from.username is rejected as own-author; neither is missing_author', async () => {
  const rows = [
    { ...base, id: 'c1', from: { id: '17841400000000000', username: 'brand' } },
    { ...base, id: 'c2' },
  ];
  await withProvider(rows, async ({ db, provider, account }) => {
    const automations = new AutomationService(db);
    const id = automations.create({ accountId: 'account', mediaId: 'media-1', name: 'a', replyText: 'Hi' });
    automations.addKeyword('account', id, 'guide');
    automations.setEnabled('account', id, true);
    const report = await new Scanner(db, provider).scanMedia(account, 'media-1', { kind: 'backlog', now: Date.parse('2026-10-05T12:00:00Z') });
    const own = report.candidates.find((c) => c.commentId === 'c1')!;
    const none = report.candidates.find((c) => c.commentId === 'c2')!;
    assert.equal(own.eligible, false);
    assert.equal(own.reason, 'own_authored');
    assert.equal(none.eligible, false);
    assert.equal(none.reason, 'missing_author');
  });
});
