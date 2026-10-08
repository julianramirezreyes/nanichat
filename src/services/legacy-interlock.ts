import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeUsername } from '../core/config.ts';

const COUNTER_FILES = [
  'rejection-counter.json', 'rejection_counter.json', 'private-reply-counter.json',
  'private_reply_rejections.json', 'private-reply-rejection-counter.json',
] as const;

export type LegacyInterlockState = {
  blocked: boolean;
  reasonCode?: 'legacy_lock_present' | 'legacy_rejection_history' | 'legacy_historical_rejection';
  lockPresent: boolean;
  counterVersion: string;
  /** The username is listed in SOCIAL_DESK_LEGACY_HOLD_USERNAMES: it needs an acknowledgement even without a counter file. */
  holdConfigured: boolean;
};

export type LegacyInterlockOptions = {
  /** Directory of a legacy tool's per-account folders; null = no file is ever read or written. */
  accountsDir: string | null;
  holdUsernames: readonly string[];
};

export type LegacyInterlock = ReturnType<typeof createLegacyInterlock>;

/** Opt-in: returns undefined (interlock fully disabled) when neither a directory nor hold usernames are configured. */
export function legacyInterlockFromConfig(config: { legacyAccountsDir: string | null; legacyHoldUsernames: readonly string[] }):
  LegacyInterlock | undefined {
  if (!config.legacyAccountsDir && !config.legacyHoldUsernames.length) return undefined;
  return createLegacyInterlock({ accountsDir: config.legacyAccountsDir, holdUsernames: config.legacyHoldUsernames });
}

export function createLegacyInterlock(options: LegacyInterlockOptions) {
  const root = options.accountsDir ? resolve(options.accountsDir) : null;
  const holdUsernames = new Set(options.holdUsernames.map(normalizeUsername));

  function account(username: string) {
    const normalized = normalizeUsername(username);
    if (!/^[a-z0-9._]{1,30}$/u.test(normalized)) throw new TypeError('Invalid legacy account name');
    const directory = root ? join(root, normalized) : null;
    return { normalized, directory, lock: directory ? join(directory, 'run.lock') : null };
  }

  function inspect(username: string): LegacyInterlockState {
    const { normalized, directory, lock } = account(username);
    const holdConfigured = holdUsernames.has(normalized);
    if (!directory || !lock) {
      return { blocked: holdConfigured, ...(holdConfigured ? { reasonCode: 'legacy_historical_rejection' as const } : {}),
        lockPresent: false, counterVersion: 'absent', holdConfigured };
    }
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
      blocked: lockPresent || hasRejectionHistory || holdConfigured,
      ...(lockPresent ? { reasonCode: 'legacy_lock_present' as const }
        : hasRejectionHistory ? { reasonCode: 'legacy_rejection_history' as const }
          : holdConfigured ? { reasonCode: 'legacy_historical_rejection' as const } : {}),
      lockPresent,
      counterVersion,
      holdConfigured,
    };
  }

  function acknowledge(username: string, expectedCounterVersion: string): { ok: boolean; state: LegacyInterlockState } {
    const state = inspect(username);
    return { ok: !state.lockPresent && state.counterVersion !== 'unreadable' && expectedCounterVersion === state.counterVersion, state };
  }

  async function withExclusiveLock<T>(username: string, operation: () => Promise<T>): Promise<T> {
    const { directory, lock } = account(username);
    // Without a legacy directory there is no other tool to coordinate with.
    if (!directory || !lock) return operation();
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
