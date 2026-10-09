import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanupStack, removeTempDir } from './helpers/tmp.ts';

test('cleanupStack runs cleanups in reverse registration order (close before remove), unlike context.after', async () => {
  const order: string[] = [];
  let hook: (() => void | Promise<void>) | undefined;
  const defer = cleanupStack({ after(fn) { hook = fn; } });
  defer(() => { order.push('remove temp dir'); });
  defer(() => { order.push('close database'); });
  defer(async () => { order.push('close server'); });
  await hook!();
  assert.deepEqual(order, ['close server', 'close database', 'remove temp dir']);
});

test('cleanupStack still runs every cleanup when one fails, then reports the failure', async () => {
  const order: string[] = [];
  let hook: (() => void | Promise<void>) | undefined;
  const defer = cleanupStack({ after(fn) { hook = fn; } });
  defer(() => { order.push('remove'); });
  defer(() => { throw new Error('close failed'); });
  await assert.rejects(async () => hook!(), /close failed/);
  assert.deepEqual(order, ['remove']);
});

test('removeTempDir removes a populated directory and tolerates one that is already gone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'social-helper-'));
  writeFileSync(join(directory, 'file.txt'), 'x');
  removeTempDir(directory);
  assert.equal(existsSync(directory), false);
  removeTempDir(directory);
});
