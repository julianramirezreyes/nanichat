import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  acquireApplicationLock,
  nodeProcessProbe,
  type ProcessProbe,
} from '../src/core/application-lock.ts';
import { removeTempDir } from './helpers/tmp.ts';

const LOCK_FILE = '.application-owner.json';
const REFUSAL = /already running or ownership is uncertain/;

function tempDir(context: { after(fn: () => void): void }): string {
  const directory = mkdtempSync(join(tmpdir(), 'social-app-lock-platform-'));
  context.after(() => removeTempDir(directory));
  return directory;
}

/** Simulated platform: a table of live processes, and optionally a /proc-like start-time source. */
function simulatedProbe(options: {
  alive?: Record<number, string | null>;
  permissionDenied?: number[];
  uncertain?: number[];
  hasProc: boolean;
}): ProcessProbe & { startTimeCalls: number } {
  const probe = {
    startTimeCalls: 0,
    liveness(pid: number) {
      if (options.uncertain?.includes(pid)) return 'uncertain' as const;
      if (options.permissionDenied?.includes(pid)) return 'alive' as const;
      return pid in (options.alive ?? {}) ? 'alive' as const : 'dead' as const;
    },
    startTime(pid: number) {
      probe.startTimeCalls++;
      if (!options.hasProc) return undefined;
      const value = options.alive?.[pid];
      return typeof value === 'string' ? value : undefined;
    },
  };
  return probe;
}

function writeOwner(directory: string, owner: unknown): void {
  writeFileSync(join(directory, LOCK_FILE), typeof owner === 'string' ? owner : JSON.stringify(owner), { mode: 0o600 });
}

test('without /proc (macOS/Windows) the owner is recorded without a start time and a second process is refused', (context) => {
  const directory = tempDir(context);
  const probe = simulatedProbe({ alive: { 100: null, 200: null }, hasProc: false });
  const first = acquireApplicationLock(directory, { probe, pid: 100 });
  const recorded = JSON.parse(readFileSync(join(directory, LOCK_FILE), 'utf8')) as { pid: number; processStart: unknown };
  assert.equal(recorded.pid, 100);
  assert.equal(recorded.processStart, null);
  assert.throws(() => acquireApplicationLock(directory, { probe, pid: 200 }), REFUSAL);
  first.release();
  assert.equal(existsSync(join(directory, LOCK_FILE)), false);
  const next = acquireApplicationLock(directory, { probe, pid: 200 });
  next.release();
});

test('without /proc a stale lock is reclaimed only when the recorded PID is provably dead (ESRCH)', (context) => {
  const directory = tempDir(context);
  writeOwner(directory, { pid: 4242, processStart: null, nonce: 'stale' });
  const probe = simulatedProbe({ alive: { 100: null }, hasProc: false });
  const lock = acquireApplicationLock(directory, { probe, pid: 100 });
  assert.equal(lock.owned, true);
  assert.equal((JSON.parse(readFileSync(join(directory, LOCK_FILE), 'utf8')) as { pid: number }).pid, 100);
  lock.release();
  assert.equal(existsSync(join(directory, `${LOCK_FILE}.reclaim`)), false);
});

test('without /proc a live recorded PID fails closed because PID reuse cannot be ruled out', (context) => {
  const directory = tempDir(context);
  writeOwner(directory, { pid: 4242, processStart: null, nonce: 'other' });
  const probe = simulatedProbe({ alive: { 100: null, 4242: null }, hasProc: false });
  assert.throws(() => acquireApplicationLock(directory, { probe, pid: 100 }), REFUSAL);
  assert.equal((JSON.parse(readFileSync(join(directory, LOCK_FILE), 'utf8')) as { nonce: string }).nonce, 'other');
  assert.equal(existsSync(join(directory, `${LOCK_FILE}.reclaim`)), false);
});

test('EPERM (process exists but belongs to another user) counts as alive and is refused', (context) => {
  const directory = tempDir(context);
  writeOwner(directory, { pid: 4242, processStart: null, nonce: 'other' });
  const probe = simulatedProbe({ alive: { 100: null }, permissionDenied: [4242], hasProc: false });
  assert.throws(() => acquireApplicationLock(directory, { probe, pid: 100 }), REFUSAL);
});

test('an uncertain liveness answer is refused instead of reclaiming', (context) => {
  const directory = tempDir(context);
  writeOwner(directory, { pid: 4242, processStart: 'start-1', nonce: 'other' });
  const probe = simulatedProbe({ alive: { 100: 'start-me' }, uncertain: [4242], hasProc: true });
  assert.throws(() => acquireApplicationLock(directory, { probe, pid: 100 }), REFUSAL);
});

test('with /proc a live PID whose start time differs is detected as PID reuse and reclaimed', (context) => {
  const directory = tempDir(context);
  writeOwner(directory, { pid: 4242, processStart: 'old-start', nonce: 'stale' });
  const probe = simulatedProbe({ alive: { 100: 'start-me', 4242: 'new-start' }, hasProc: true });
  const lock = acquireApplicationLock(directory, { probe, pid: 100 });
  const recorded = JSON.parse(readFileSync(join(directory, LOCK_FILE), 'utf8')) as { pid: number; processStart: string };
  assert.deepEqual([recorded.pid, recorded.processStart], [100, 'start-me']);
  lock.release();
});

test('with /proc a live PID with the same start time is the real owner and is refused', (context) => {
  const directory = tempDir(context);
  writeOwner(directory, { pid: 4242, processStart: 'same-start', nonce: 'other' });
  const probe = simulatedProbe({ alive: { 100: 'start-me', 4242: 'same-start' }, hasProc: true });
  assert.throws(() => acquireApplicationLock(directory, { probe, pid: 100 }), REFUSAL);
});

test('with /proc a lock recorded without a start time (written on another platform) still fails closed while the PID is alive', (context) => {
  const directory = tempDir(context);
  writeOwner(directory, { pid: 4242, processStart: null, nonce: 'other' });
  const probe = simulatedProbe({ alive: { 100: 'start-me', 4242: 'some-start' }, hasProc: true });
  assert.throws(() => acquireApplicationLock(directory, { probe, pid: 100 }), REFUSAL);
});

test('a corrupt or incomplete lock file is never reclaimed', (context) => {
  for (const corrupt of ['not json', '{}', JSON.stringify({ pid: -1, processStart: null, nonce: 'x' }),
    JSON.stringify({ pid: 4242, processStart: null }), JSON.stringify({ pid: 4242, processStart: 7, nonce: 'x' })]) {
    const directory = tempDir(context);
    writeOwner(directory, corrupt);
    const probe = simulatedProbe({ alive: { 100: null }, hasProc: false });
    assert.throws(() => acquireApplicationLock(directory, { probe, pid: 100 }), REFUSAL, corrupt);
    assert.equal(readFileSync(join(directory, LOCK_FILE), 'utf8'), corrupt);
  }
});

test('release removes only the lock it owns', (context) => {
  const directory = tempDir(context);
  const probe = simulatedProbe({ alive: { 100: null }, hasProc: false });
  const lock = acquireApplicationLock(directory, { probe, pid: 100 });
  writeOwner(directory, { pid: 999, processStart: null, nonce: 'replaced' });
  lock.release();
  assert.equal(existsSync(join(directory, LOCK_FILE)), true);
});

test('the default Node probe reports this process alive and a reaped child dead', async () => {
  assert.equal(nodeProcessProbe.liveness(process.pid), 'alive');
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  assert.equal(nodeProcessProbe.liveness(child.pid!), 'dead');
  const ownStart = nodeProcessProbe.startTime(process.pid);
  if (existsSync('/proc/self/stat')) assert.match(ownStart ?? '', /^\d+$/u);
  else assert.equal(ownStart, undefined);
});
