import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const COUNTER_FILES = [
  'rejection-counter.json', 'rejection_counter.json', 'private-reply-counter.json',
  'private_reply_rejections.json', 'private-reply-rejection-counter.json',
] as const;

export type LegacyInterlockState = {
  blocked: boolean;
  reasonCode?: 'legacy_lock_present' | 'legacy_rejection_history';
  lockPresent: boolean;
  counterVersion: string;
};

export function createLegacyInterlock(accountsRoot: string) {
  const root = resolve(accountsRoot);

  function paths(username: string) {
    const normalized = normalizeUsername(username);
    if (!/^[a-z0-9._]{1,30}$/u.test(normalized)) throw new TypeError('Invalid legacy account name');
    const directory = join(root, normalized);
    return { directory, lock: join(directory, 'run.lock') };
  }

  function inspect(username: string): LegacyInterlockState {
    const { directory, lock } = paths(username);
    const lockPresent = existsSync(lock);
    let counterVersion = 'absent';
    for (const filename of COUNTER_FILES) {
      const path = join(directory, filename);
      if (!existsSync(path)) continue;
      try {
        const bytes = readFileSync(path);
        counterVersion = createHash('sha256').update(bytes).digest('hex');
      } catch {
        counterVersion = 'unreadable';
      }
      break;
    }
    const hasRejectionHistory = counterVersion !== 'absent';
    return {
      blocked: lockPresent || hasRejectionHistory,
      ...(lockPresent ? { reasonCode: 'legacy_lock_present' as const }
        : hasRejectionHistory ? { reasonCode: 'legacy_rejection_history' as const } : {}),
      lockPresent,
      counterVersion,
    };
  }

  function acknowledge(username: string, expectedCounterVersion: string): { ok: boolean; state: LegacyInterlockState } {
    const state = inspect(username);
    return { ok: !state.lockPresent && state.counterVersion !== 'unreadable' && expectedCounterVersion === state.counterVersion, state };
  }

  async function withExclusiveLock<T>(username: string, operation: () => Promise<T>): Promise<T> {
    const { directory, lock } = paths(username);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const owner = randomBytes(24).toString('base64url');
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Legacy account lock already exists');
      throw error;
    }
    try {
      writeFileSync(fd, JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    try {
      return await operation();
    } finally {
      try {
        const current = JSON.parse(readFileSync(lock, 'utf8')) as { owner?: unknown };
        if (current.owner === owner) unlinkSync(lock);
      } catch {
        // If ownership cannot be proven, preserve the lock for operator recovery.
      }
    }
  }

  return { inspect, acknowledge, withExclusiveLock };
}

function normalizeUsername(value: string): string {
  return value.normalize('NFC').trim().replace(/^@/u, '').toLocaleLowerCase('und');
}
