import { chmodSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(dataDir: string): DatabaseSync {
  const directory = resolve(dataDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, 'social-automation.sqlite');
  const database = new DatabaseSync(path);
  chmodSync(path, 0o600);
  database.exec(`PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;`);
  return database;
}
