import { resolve } from 'node:path';
import { InvalidConfigurationError } from './errors.ts';

export type AppConfig = {
  host: '127.0.0.1';
  port: number;
  dataDir: string;
  dryRun: true;
  monitoringEnabled: false;
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
  return { host: '127.0.0.1', port, dataDir, dryRun: true, monitoringEnabled: false };
}
