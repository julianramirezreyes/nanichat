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

/**
 * `processStart` is a strong process identity (Linux `/proc/<pid>/stat` start time) or `null` when the
 * platform cannot provide one (macOS, native Windows). Without it, PID reuse cannot be ruled out.
 */
type LockOwner = { pid: number; processStart: string | null; nonce: string };

/** Answer of a portable liveness check: `alive` includes EPERM (the process exists but is not ours). */
export type ProcessLiveness = 'alive' | 'dead' | 'uncertain';

/** Platform probe used to decide whether a recorded lock owner is provably dead. Injectable for tests. */
export type ProcessProbe = {
  liveness(pid: number): ProcessLiveness;
  /** Strong start-time identity, or `undefined` when unavailable on this platform or for this PID. */
  startTime(pid: number): string | undefined;
};

export type ApplicationLockOptions = {
  probe?: ProcessProbe;
  /** PID recorded as owner; defaults to the current process. */
  pid?: number;
};

export type ApplicationLock = {
  owned: true;
  release(): void;
};

const REFUSAL_MESSAGE = 'Application data directory is already running or ownership is uncertain';

export const nodeProcessProbe: ProcessProbe = {
  liveness(pid) {
    try {
      process.kill(pid, 0);
      return 'alive';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return 'dead';
      if (code === 'EPERM') return 'alive';
      return 'uncertain';
    }
  },
  startTime(pid) {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return undefined;
    }
    const closeParenthesis = stat.lastIndexOf(')');
    if (closeParenthesis < 0) return undefined;
    const startTime = stat.slice(closeParenthesis + 1).trim().split(/\s+/u)[19];
    return startTime && /^\d+$/u.test(startTime) ? startTime : undefined;
  },
};

export function acquireApplicationLock(dataDir: string, options: ApplicationLockOptions = {}): ApplicationLock {
  const probe = options.probe ?? nodeProcessProbe;
  const pid = options.pid ?? process.pid;
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.application-owner.json');
  const owner: LockOwner = {
    pid,
    processStart: probe.startTime(pid) ?? null,
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
      reclaimIfOwnerIsProvenDead(lockPath, probe);
    }
  }
  throw new Error(REFUSAL_MESSAGE);
}

function reclaimIfOwnerIsProvenDead(lockPath: string, probe: ProcessProbe): void {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimDescriptor: number;
  try {
    reclaimDescriptor = openSync(reclaimPath, 'wx', 0o600);
  } catch {
    throw new Error('Application data directory ownership is already running or recovery is uncertain');
  }
  try {
    const owner = readOwner(lockPath);
    if (!owner || !isProvenDead(owner, probe)) throw new Error(REFUSAL_MESSAGE);
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
      || !(owner.processStart === null || (typeof owner.processStart === 'string' && owner.processStart))
      || typeof owner.nonce !== 'string' || !owner.nonce) {
      return undefined;
    }
    return owner as LockOwner;
  } catch {
    return undefined;
  }
}

/**
 * Dead means provably dead: the PID does not exist (ESRCH), or a strong start-time identity proves the PID was
 * reused by another process. A live PID without a comparable strong identity is "running or uncertain".
 */
function isProvenDead(owner: LockOwner, probe: ProcessProbe): boolean {
  const liveness = probe.liveness(owner.pid);
  if (liveness === 'dead') return true;
  if (liveness !== 'alive' || owner.processStart === null) return false;
  const currentStart = probe.startTime(owner.pid);
  return currentStart !== undefined && currentStart !== owner.processStart;
}
