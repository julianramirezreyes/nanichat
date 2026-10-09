import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AccountRef } from '../src/core/domain.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import {
  addDiscoveredAccount, createConnection, createMedia, createMediaIfMissing, listEncryptedCredentials, listMedia,
} from '../src/db/repositories.ts';
import { createApiHandler } from '../src/http/router.ts';
import { MetaProvider } from '../src/providers/meta/provider.ts';
import { createVault } from '../src/security/vault.ts';
import { BacklogService, ScanProgress } from '../src/services/backlog.ts';
import { QueueService } from '../src/services/queue.ts';
import { Scanner } from '../src/services/scanner.ts';
import { autoSelectAccount } from '../app/account-filter.ts';
import { mediaLabel, mediaTypeLabel } from '../app/media-label.ts';
import { removeTempDir } from './helpers/tmp.ts';

type Db = ReturnType<typeof openDatabase>;

async function withDb(run: (db: Db, directory: string) => Promise<void> | void, target?: number): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'ux-fixes2-'));
  const db = openDatabase(directory);
  if (target === undefined) migrateDatabase(db); else migrateDatabase(db, target);
  try { await run(db, directory); } finally { db.close(); removeTempDir(directory); }
}

function seedAccounts(db: Db, ids: string[], mediaPerAccount: number): AccountRef[] {
  createConnection(db, {
    id: 'conn', name: 'test', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
    status: 'valid', accessToken: { nonce: 'n', ciphertext: 'c', tag: 't' },
  });
  return ids.map((id) => {
    addDiscoveredAccount(db, { accountId: id, connectionId: 'conn', providerAccountId: `p-${id}`, username: `user_${id}`, status: 'valid' });
    for (let i = 0; i < mediaPerAccount; i++) createMedia(db, { accountId: id, mediaId: `${id}-m${i}`, permalink: null, publishedAt: null });
    return { accountId: id, connectionId: 'conn', providerAccountId: `p-${id}`, username: `user_${id}` };
  });
}

// ---------- Fix 3: provider mapping ----------

async function withMetaProvider(rows: unknown[], run: (provider: MetaProvider, account: AccountRef, urls: URL[]) => Promise<void>) {
  await withDb(async (db, directory) => {
    const vault = createVault(directory, () => listEncryptedCredentials(db));
    createConnection(db, {
      id: 'conn', name: 'test', providerCode: 'META', loginKind: 'instagram_login', graphVersion: 'v26.0',
      status: 'valid', accessToken: vault.encrypt('conn', 'ig-user-token'),
    });
    addDiscoveredAccount(db, { accountId: 'account', connectionId: 'conn', providerAccountId: '17841400000000000', username: 'brand', status: 'valid' });
    const urls: URL[] = [];
    const fetcher: typeof fetch = async (input) => { urls.push(new URL(String(input))); return Response.json({ data: rows }); };
    const account: AccountRef = { accountId: 'account', connectionId: 'conn', providerAccountId: '17841400000000000', username: 'brand' };
    await run(new MetaProvider(db, vault, fetcher), account, urls);
  });
}

test('listMedia requests caption and media_type and maps valid values', async () => {
  await withMetaProvider([
    { id: 'm1', permalink: 'https://instagram.com/p/a/', timestamp: '2026-10-01T00:00:00Z', caption: 'Hola mundo', media_type: 'VIDEO' },
    { id: 'm2', media_type: 'IMAGE', caption: 'Foto' },
    { id: 'm3', media_type: 'CAROUSEL_ALBUM' },
  ], async (provider, account, urls) => {
    const page = await provider.listMedia(account);
    const fields = urls[0]!.searchParams.get('fields')!.split(',');
    assert.ok(fields.includes('caption') && fields.includes('media_type') && fields.includes('id'));
    assert.deepEqual(page.items.map((i) => [i.mediaId, i.caption, i.mediaType]), [
      ['m1', 'Hola mundo', 'VIDEO'], ['m2', 'Foto', 'IMAGE'], ['m3', undefined, 'CAROUSEL_ALBUM'],
    ]);
  });
});

test('listMedia defensively handles missing, oversized, non-string caption and unknown media_type', async () => {
  const long = 'x'.repeat(5000);
  await withMetaProvider([
    { id: 'a' },
    { id: 'b', caption: long },
    { id: 'c', caption: 123, media_type: 7 },
    { id: 'd', caption: { text: 'no' }, media_type: 'REELS_V9' },
    { id: 'e', caption: '   ', media_type: 'video' },
    { id: 'f', caption: '😀'.repeat(300) },
  ], async (provider, account) => {
    const items = (await provider.listMedia(account)).items;
    const by = Object.fromEntries(items.map((i) => [i.mediaId, i]));
    assert.equal(by.a!.caption, undefined); assert.equal(by.a!.mediaType, undefined);
    assert.equal(by.b!.caption!.length, 200);
    assert.equal(by.c!.caption, undefined); assert.equal(by.c!.mediaType, undefined);
    assert.equal(by.d!.caption, undefined); assert.equal(by.d!.mediaType, undefined);
    assert.equal(by.e!.caption, undefined); assert.equal(by.e!.mediaType, undefined);
    assert.equal(Array.from(by.f!.caption!).length, 200);
    assert.ok(!/[\uD800-\uDBFF]$/u.test(by.f!.caption!));
  });
});

// ---------- Fix 3: migration ----------

test('migration v9 adds nullable caption/media_type, preserves rows, from the v8 shape', async () => {
  await withDb((db) => {
    const accounts = seedAccounts(db, ['a1'], 0);
    createMedia(db, { accountId: 'a1', mediaId: 'old-1', permalink: 'https://p/1', publishedAt: '2026-01-01T00:00:00Z' });
    createMedia(db, { accountId: 'a1', mediaId: 'old-2', permalink: null, publishedAt: null });
    assert.equal(accounts.length, 1);
    // Recreate the live v8 shape: no caption/media_type columns.
    db.exec('ALTER TABLE media DROP COLUMN caption; ALTER TABLE media DROP COLUMN media_type; PRAGMA user_version = 8;');
    assert.equal((db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string }>).some((c) => c.name === 'caption'), false);
    migrateDatabase(db);
    const cols = db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string; notnull: number }>;
    for (const name of ['caption', 'media_type']) {
      const col = cols.find((c) => c.name === name);
      assert.ok(col, name); assert.equal(col!.notnull, 0);
    }
    // Migration continues to the latest version (v10 automation scope) after adding the v9 columns.
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 18);
    const rows = db.prepare('SELECT media_id, permalink, published_at, caption, media_type FROM media ORDER BY media_id').all();
    assert.deepEqual(rows.map((r) => ({ ...r })), [
      { media_id: 'old-1', permalink: 'https://p/1', published_at: '2026-01-01T00:00:00Z', caption: null, media_type: null },
      { media_id: 'old-2', permalink: null, published_at: null, caption: null, media_type: null },
    ]);
    migrateDatabase(db); // idempotent at latest version
  }, 10); // start from the v10 shape: the v8 shape is recreated by dropping only the v9 columns
});

test('createMediaIfMissing stores caption/mediaType and an existing row without them stays renderable', async () => {
  await withDb((db) => {
    seedAccounts(db, ['a1'], 0);
    createMedia(db, { accountId: 'a1', mediaId: 'plain', permalink: null, publishedAt: null });
    createMediaIfMissing(db, { accountId: 'a1', mediaId: 'rich', permalink: null, publishedAt: null, caption: 'Texto', mediaType: 'IMAGE' });
    const rows = listMedia(db, 'a1');
    const plain = rows.find((r) => r.mediaId === 'plain')!;
    const rich = rows.find((r) => r.mediaId === 'rich')!;
    assert.equal(plain.caption, null); assert.equal(plain.mediaType, null);
    assert.equal(rich.caption, 'Texto'); assert.equal(rich.mediaType, 'IMAGE');
    // Upsert from Meta without caption must not erase an existing caption with garbage, but refreshes with new value.
    createMediaIfMissing(db, { accountId: 'a1', mediaId: 'rich', permalink: null, publishedAt: null, caption: 'Nuevo', mediaType: 'VIDEO' });
    assert.equal(listMedia(db, 'a1').find((r) => r.mediaId === 'rich')!.caption, 'Nuevo');
  });
});

// ---------- Fix 3: DTO ----------

async function serve(db: Db, extra: Record<string, unknown> = {}) {
  const handler = createApiHandler({ database: db, csrfToken: 'tok', ...extra } as never);
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const origin = `http://127.0.0.1:${address.port}`;
  const call = (path: string, method = 'GET', body?: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request(new URL(path, origin), { method, headers: method === 'GET' ? {} : { origin, 'x-csrf-token': 'tok', 'content-type': 'application/json' } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { call, close: () => server.close() };
}

test('GET /api/media DTO exposes caption and mediaType (null for legacy rows)', async () => {
  await withDb(async (db) => {
    seedAccounts(db, ['a1'], 0);
    createMedia(db, { accountId: 'a1', mediaId: 'legacy', permalink: null, publishedAt: '2026-01-01T00:00:00Z' });
    createMediaIfMissing(db, { accountId: 'a1', mediaId: 'rich', permalink: null, publishedAt: '2026-02-01T00:00:00Z', caption: 'Hola', mediaType: 'CAROUSEL_ALBUM' });
    const server = await serve(db);
    try {
      const { json } = await server.call('/api/media?accountId=a1');
      const byId = Object.fromEntries(json.media.map((m: any) => [m.mediaId, m]));
      assert.equal(byId.rich.caption, 'Hola'); assert.equal(byId.rich.mediaType, 'CAROUSEL_ALBUM');
      assert.equal(byId.legacy.caption, null); assert.equal(byId.legacy.mediaType, null);
      assert.deepEqual(Object.keys(byId.rich).sort(), ['accountId', 'caption', 'lastSeenAt', 'mediaId', 'mediaType', 'permalink', 'publishedAt', 'thumbnailUrl']);
    } finally { server.close(); }
  });
});

test('media labels: type names, short caption, legacy fallback', () => {
  assert.equal(mediaTypeLabel('VIDEO'), 'Reel/Video');
  assert.equal(mediaTypeLabel('IMAGE'), 'Foto');
  assert.equal(mediaTypeLabel('CAROUSEL_ALBUM'), 'Carrusel');
  assert.equal(mediaTypeLabel(null), null);
  assert.equal(mediaTypeLabel('WEIRD'), null);
  const full = mediaLabel({ mediaId: '1789012345678', caption: 'Hola mundo', mediaType: 'IMAGE', publishedAt: '2026-10-01T12:00:00Z' });
  assert.match(full, /2026-10-01/); assert.match(full, /Foto/); assert.match(full, /Hola mundo/);
  const legacy = mediaLabel({ mediaId: '17890123456789012', caption: null, mediaType: null, publishedAt: null });
  assert.match(legacy, /Sin texto/); assert.match(legacy, /…?789012$/);
  const long = mediaLabel({ mediaId: 'x', caption: 'a'.repeat(300), mediaType: null, publishedAt: null }, 40);
  assert.ok(long.length < 120);
  assert.equal(mediaLabel({ mediaId: 'x', caption: 'linea1\nlinea2', mediaType: null, publishedAt: null }).includes('\n'), false);
});

// ---------- Fix 2: progress ----------

test('ScanProgress aggregates media/pages/comments across accounts and exposes only safe fields', async () => {
  await withDb(async (db) => {
    const accounts = seedAccounts(db, ['a1', 'a2'], 2);
    const seen: Array<ReturnType<ScanProgress['snapshot']>> = [];
    const progress = new ScanProgress();
    const scanner = new Scanner(db, { async listComments(_a: AccountRef, mediaId: string, cursor?: string) {
      seen.push(progress.snapshot());
      return cursor
        ? { items: [{ commentId: `${mediaId}-c2`, text: 'x', username: 'u', createdAt: new Date().toISOString() }], complete: true }
        : { items: [{ commentId: `${mediaId}-c1`, text: 'x', username: 'u', createdAt: new Date().toISOString() }], complete: false, nextCursor: 'next' };
    } } as never);
    const backlog = new BacklogService(db, scanner, new QueueService(db, {} as never));
    assert.deepEqual(progress.snapshot(), { mediaDone: 0, mediaTotal: 0, pagesRead: 0, commentsSeen: 0 });
    await backlog.scanAll(accounts, { window: '24h', progress } as never);
    assert.equal(seen[0]!.mediaTotal, 4); // aggregate total known up front
    assert.equal(seen[0]!.mediaDone, 0);
    assert.ok(typeof seen[0]!.currentStartedAt === 'string');
    assert.equal(seen[seen.length - 1]!.mediaDone, 3); // monotonic progress
    const final = progress.snapshot();
    assert.deepEqual({ ...final, currentStartedAt: undefined }, { mediaDone: 4, mediaTotal: 4, pagesRead: 8, commentsSeen: 8, currentStartedAt: undefined });
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i]!.pagesRead >= seen[i - 1]!.pagesRead);
  });
});

test('job GET exposes progress while running, cancel keeps working, existing fields remain', async () => {
  await withDb(async (db) => {
    const accounts = seedAccounts(db, ['a1'], 2);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const scanner = new Scanner(db, { async listComments(_a: AccountRef, mediaId: string) {
      calls++;
      if (calls === 2) await gate;
      return { items: [{ commentId: `${mediaId}-c`, text: 'x', username: 'u', createdAt: new Date().toISOString() }], complete: true };
    } } as never);
    const backlog = new BacklogService(db, scanner, new QueueService(db, {} as never));
    const server = await serve(db, { backlog });
    try {
      const started = await server.call('/api/backlog/jobs', 'POST', { accountId: 'a1', window: '24h' });
      assert.equal(started.status, 202);
      const id = started.json.jobId;
      let job = (await server.call(`/api/backlog/jobs/${id}`)).json;
      for (let i = 0; i < 50 && job.progress.mediaDone < 1; i++) { await new Promise((r) => setTimeout(r, 20)); job = (await server.call(`/api/backlog/jobs/${id}`)).json; }
      assert.equal(job.status, 'running');
      assert.equal(job.progress.mediaTotal, 2);
      assert.equal(job.progress.mediaDone, 1);
      assert.equal(job.progress.pagesRead, 1);
      assert.equal(job.progress.commentsSeen, 1);
      assert.ok(job.progress.currentStartedAt);
      assert.ok(job.createdAt); assert.equal(job.id, id);
      assert.deepEqual(Object.keys(job.progress).sort(), ['commentsSeen', 'currentStartedAt', 'mediaDone', 'mediaTotal', 'pagesRead']);
      assert.equal((await server.call(`/api/backlog/jobs/${id}/cancel`, 'POST', {})).status, 202);
      release();
      for (let i = 0; i < 50 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 20)); job = (await server.call(`/api/backlog/jobs/${id}`)).json; }
      assert.equal(job.status, 'cancelled');
      assert.equal(job.progress.mediaTotal, 2);
    } finally { release(); server.close(); }
    assert.equal(accounts.length, 1);
  });
});

// ---------- Fix 1: auto select ----------

test('autoSelectAccount: single account is selected once unless the user already chose', () => {
  assert.equal(autoSelectAccount({ filter: 'all', userChose: false, accountIds: ['a1'] }), 'a1');
  assert.equal(autoSelectAccount({ filter: 'all', userChose: true, accountIds: ['a1'] }), null);
  assert.equal(autoSelectAccount({ filter: 'a1', userChose: false, accountIds: ['a1'] }), null);
  assert.equal(autoSelectAccount({ filter: 'all', userChose: false, accountIds: ['a1', 'a2'] }), null);
  assert.equal(autoSelectAccount({ filter: 'all', userChose: false, accountIds: [] }), null);
});

// ---------- Fix 2: UI helpers ----------

test('progress text, percent and elapsed formatting', async () => {
  const { progressText, progressPercent, formatElapsed } = await import('../app/scan-summary.ts');
  assert.equal(progressText({ mediaDone: 6, mediaTotal: 20, pagesRead: 40, commentsSeen: 4210 }), 'Publicación 7 de 20 · 4.210 comentarios leídos');
  assert.equal(progressText({ mediaDone: 20, mediaTotal: 20, pagesRead: 160, commentsSeen: 1 }), 'Publicación 20 de 20 · 1 comentario leído');
  assert.equal(progressText({ mediaDone: 0, mediaTotal: 0, pagesRead: 0, commentsSeen: 0 }), 'Preparando análisis…');
  assert.equal(progressPercent({ mediaDone: 5, mediaTotal: 20, pagesRead: 0, commentsSeen: 0 }), 25);
  assert.equal(progressPercent({ mediaDone: 0, mediaTotal: 0, pagesRead: 0, commentsSeen: 0 }), 0);
  assert.equal(progressPercent({ mediaDone: 30, mediaTotal: 20, pagesRead: 0, commentsSeen: 0 }), 100);
  assert.equal(formatElapsed(45_000), '45 s');
  assert.equal(formatElapsed(125_000), '2 min 05 s');
  assert.equal(formatElapsed(-5), '0 s');
});

test('summarizeScan counts reads, eligible, expired, replies, review and incomplete/error accounts', async () => {
  const { summarizeScan } = await import('../app/scan-summary.ts');
  const cand = (reason: string, eligible = false) => ({ commentId: reason + Math.random(), automationId: 'a', eligible, reason, matchedKeywords: [] });
  const summary = summarizeScan([
    { accountId: 'a1', status: 'incomplete', result: { expiredCount: 3, reports: [
      { status: 'complete', commentsSeen: 100, candidates: [cand('eligible', true), cand('eligible', true), cand('expired'), cand('reply_thread'), cand('no_keyword_match'), cand('missing_author')] },
      { status: 'incomplete', stopReason: 'provider_error', commentsSeen: 50, candidates: [] },
    ] } },
    { accountId: 'a2', status: 'error', safeErrorCode: 'account_scan_failed' },
    { accountId: 'a3', status: 'complete', result: { expiredCount: 0, reports: [{ status: 'complete', commentsSeen: 7, candidates: [] }] } },
  ]);
  assert.deepEqual(summary, { commentsRead: 157, eligible: 2, expired: 3, replies: 1, review: 1, ownerReplied: 0, incompleteReports: 1, failedAccounts: 1 });
  assert.deepEqual(summarizeScan(undefined), { commentsRead: 0, eligible: 0, expired: 0, replies: 0, review: 0, ownerReplied: 0, incompleteReports: 0, failedAccounts: 0 });
});
