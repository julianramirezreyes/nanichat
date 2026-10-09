import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { MediaItem, AccountRef } from '../src/core/domain.ts';
import { openDatabase } from '../src/db/database.ts';
import { migrateDatabase } from '../src/db/migrations.ts';
import { createConnection, addDiscoveredAccount, listMedia, createMediaIfMissing } from '../src/db/repositories.ts';
import { createVault } from '../src/security/vault.ts';
import { MetaProvider } from '../src/providers/meta/provider.ts';
import { removeTempDir } from './helpers/tmp.ts';

function withTempDb(run: (directory: string, db: ReturnType<typeof openDatabase>) => Promise<void> | void): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'social-media-thumbnail-'));
  const db = openDatabase(directory);
  migrateDatabase(db);
  return Promise.resolve(run(directory, db)).finally(() => {
    db.close();
    removeTempDir(directory);
  });
}

test('MetaProvider listMedia maps thumbnail_url and drops invalid URLs', async () => {
  await withTempDb(async (directory, db) => {
    const vault = createVault(directory, () => []);
    createConnection(db, {
      id: 'conn-1', name: 'Conn', providerCode: 'META', loginKind: 'instagram_login',
      graphVersion: 'v26.0', status: 'valid', accessToken: vault.encrypt('conn-1', 'token')
    });
    addDiscoveredAccount(db, {
      accountId: 'acc-1', connectionId: 'conn-1', providerAccountId: 'ig-1', username: 'test', status: 'valid'
    });

    const mockFetch = async (url: URL): Promise<Response> => {
      assert.ok(url.search.includes('fields=id,permalink,timestamp,caption,media_type,media_url,thumbnail_url'));
      const data = {
        data: [
          { id: '1', media_type: 'VIDEO', thumbnail_url: 'https://example.com/thumb.jpg', media_url: 'https://example.com/video.mp4' },
          { id: '2', media_type: 'IMAGE', media_url: 'https://example.com/image.jpg' },
          { id: '3', media_type: 'VIDEO', thumbnail_url: 'http://insecure.com/thumb.jpg' },
          { id: '4', media_type: 'IMAGE', media_url: 'not-a-url' }
        ]
      };
      return new Response(JSON.stringify(data), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });
    };

    const provider = new MetaProvider(db, vault, mockFetch as typeof fetch);
    const page = await provider.listMedia({ accountId: 'acc-1', connectionId: 'conn-1', providerAccountId: 'ig-1', username: 'test' });
    
    assert.equal(page.items.length, 4);
    assert.equal(page.items[0]!.thumbnailUrl, 'https://example.com/thumb.jpg'); // VIDEO uses thumbnail_url
    assert.equal(page.items[1]!.thumbnailUrl, 'https://example.com/image.jpg'); // IMAGE uses media_url
    assert.equal(page.items[2]!.thumbnailUrl, undefined); // drops non-https
    assert.equal(page.items[3]!.thumbnailUrl, undefined); // drops invalid URL
  });
});

test('migration adds thumbnail_url and upsert refreshes on conflict', async () => {
  await withTempDb(async (directory, db) => {
    createConnection(db, {
      id: 'conn-1', name: 'Conn', providerCode: 'META', loginKind: 'instagram_login',
      graphVersion: 'v26.0', status: 'valid'
    });
    addDiscoveredAccount(db, {
      accountId: 'acc-1', connectionId: 'conn-1', providerAccountId: 'ig-1', username: 'test', status: 'valid'
    });

    createMediaIfMissing(db, {
      accountId: 'acc-1', mediaId: 'media-1', permalink: 'link', publishedAt: '2026-01-01T00:00:00Z',
      caption: 'Initial', mediaType: 'VIDEO', thumbnailUrl: 'https://example.com/old.jpg'
    });

    const itemsBefore = listMedia(db, 'acc-1');
    assert.equal(itemsBefore[0]!.thumbnailUrl, 'https://example.com/old.jpg');

    createMediaIfMissing(db, {
      accountId: 'acc-1', mediaId: 'media-1', permalink: 'link', publishedAt: '2026-01-01T00:00:00Z',
      caption: 'Updated', mediaType: 'VIDEO', thumbnailUrl: 'https://example.com/new.jpg'
    });

    const itemsAfter = listMedia(db, 'acc-1');
    assert.equal(itemsAfter[0]!.thumbnailUrl, 'https://example.com/new.jpg');
    assert.equal(itemsAfter[0]!.caption, 'Updated');
  });
});
