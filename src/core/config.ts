import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { InvalidConfigurationError } from './errors.ts';

export type AppConfig = {
  host: '127.0.0.1';
  port: number;
  dataDir: string;
  dryRun: true;
  monitoringEnabled: false;
  /** SOCIAL_DESK_LEGACY_ACCOUNTS_DIR: a legacy tool's per-account folders (run.lock, rejection counters); null = never read. */
  legacyAccountsDir: string | null;
  /** SOCIAL_DESK_LEGACY_HOLD_USERNAMES: normalized usernames that start with a safety hold when selected. */
  legacyHoldUsernames: string[];
  /** SOCIAL_DESK_IMPORT_ENV_PATH: the only file the explicit `.env` import may read; null = import disabled. */
  importEnvPath: string | null;
};

export function loadConfig(env: Readonly<Record<string, string | undefined>> = {}, appRoot = process.cwd()): AppConfig {
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidConfigurationError('PORT must be an integer from 1 to 65535');
  }
  const dataDir = env.LOCAL_SOCIAL_DATA_DIR
    ? resolve(env.LOCAL_SOCIAL_DATA_DIR)
    : resolve(appRoot, 'data');
  return {
    host: '127.0.0.1', port, dataDir, dryRun: true, monitoringEnabled: false,
    legacyAccountsDir: optionalPath(env.SOCIAL_DESK_LEGACY_ACCOUNTS_DIR, appRoot),
    legacyHoldUsernames: usernameList(env.SOCIAL_DESK_LEGACY_HOLD_USERNAMES),
    importEnvPath: optionalPath(env.SOCIAL_DESK_IMPORT_ENV_PATH, appRoot),
  };
}

/** Same normalization as stored account usernames: NFC, trimmed, without a leading "@", lower case. */
export function normalizeUsername(value: string): string {
  return value.normalize('NFC').trim().replace(/^@/u, '').toLocaleLowerCase('und');
}

function optionalPath(value: string | undefined, appRoot: string): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2));
  return resolve(appRoot, trimmed);
}

function usernameList(value: string | undefined): string[] {
  const usernames = (value ?? '').split(',').map(normalizeUsername).filter(Boolean);
  if (usernames.some((username) => !/^[a-z0-9._]{1,30}$/u.test(username))) {
    throw new InvalidConfigurationError('SOCIAL_DESK_LEGACY_HOLD_USERNAMES must be a comma-separated list of Instagram usernames');
  }
  return [...new Set(usernames)];
}
