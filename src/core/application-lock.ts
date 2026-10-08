import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

type LockOwner = { pid: number; processStart: string; nonce: string };

export type ApplicationLock = {
  owned: true;
  release(): void;
};

export function acquireApplicationLock(dataDir: string): ApplicationLock {
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.application-owner.json');
  const owner: LockOwner = {
    pid: process.pid,
    processStart: readProcessStart(process.pid),
    nonce: randomUUID(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(descriptor, JSON.stringify(owner));
        fsyncSync(descriptor);
      } catch (error) {
        closeSync(descriptor);
        unlinkSync(lockPath);
        throw error;
      }
      return {
        owned: true,
        release() {
          closeSync(descriptor);
          const current = readOwner(lockPath);
          if (current?.nonce === owner.nonce && current.pid === owner.pid) unlinkSync(lockPath);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      reclaimIfOwnerIsProvenDead(lockPath);
    }
  }
  throw new Error('Application data directory is already running or ownership is uncertain');
}

function reclaimIfOwnerIsProvenDead(lockPath: string): void {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimDescriptor: number;
  try {
    reclaimDescriptor = openSync(reclaimPath, 'wx', 0o600);
  } catch {
    throw new Error('Application data directory ownership is already running or recovery is uncertain');
  }
  try {
    const owner = readOwner(lockPath);
    if (!owner || !isProvenDead(owner)) {
      throw new Error('Application data directory is already running or ownership is uncertain');
    }
    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    renameSync(lockPath, stalePath);
    unlinkSync(stalePath);
  } finally {
    closeSync(reclaimDescriptor);
    unlinkSync(reclaimPath);
  }
}

function readOwner(lockPath: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (!value || typeof value !== 'object') return undefined;
    const owner = value as Partial<LockOwner>;
    if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0
      || typeof owner.processStart !== 'string' || !owner.processStart
      || typeof owner.nonce !== 'string' || !owner.nonce) {
      return undefined;
    }
    return owner as LockOwner;
  } catch {
    return undefined;
  }
}

function isProvenDead(owner: LockOwner): boolean {
  let currentStart: string;
  try {
    currentStart = readProcessStart(owner.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }
  return currentStart !== owner.processStart;
}

function readProcessStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const closeParenthesis = stat.lastIndexOf(')');
  if (closeParenthesis < 0) throw new Error('Process identity is unavailable; refusing unsafe application lock');
  const fields = stat.slice(closeParenthesis + 1).trim().split(/\s+/u);
  const startTime = fields[19];
  if (!startTime) throw new Error('Process identity is unavailable; refusing unsafe application lock');
  return startTime;
}
