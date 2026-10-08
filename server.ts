import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import next from 'next';
import { acquireApplicationLock } from './src/core/application-lock.ts';
import { loadConfig } from './src/core/config.ts';
import { openDatabase } from './src/db/database.ts';
import { migrateDatabase } from './src/db/migrations.ts';
import { listEncryptedCredentials } from './src/db/repositories.ts';
import { createVault } from './src/security/vault.ts';
import { MetaProvider } from './src/providers/meta/provider.ts';
import { QueueService } from './src/services/queue.ts';
import { Scanner } from './src/services/scanner.ts';
import { Scheduler } from './src/services/scheduler.ts';
import { ConnectionService } from './src/services/connections.ts';
import { AutomationService } from './src/services/automations.ts';
import { BacklogService } from './src/services/backlog.ts';
import { createApiHandler } from './src/http/router.ts';
import { createLegacyInterlock } from './src/services/legacy-interlock.ts';
import { readImportedEnvironment } from './src/security/env-import.ts';

const config = loadConfig(process.env);
const applicationLock = acquireApplicationLock(config.dataDir);
const database = openDatabase(config.dataDir);
migrateDatabase(database);
const vault = createVault(config.dataDir, () => listEncryptedCredentials(database));
const provider = new MetaProvider(database, vault);
const legacyInterlock = createLegacyInterlock(join(homedir(), '.local/share/gestor-instagram/accounts'));
const queue = new QueueService(database, provider, { legacyInterlock });
const scanner = new Scanner(database, provider);
const connections = new ConnectionService(database, vault, provider);
// General (account-wide) automations refresh the account's publication list through the same provider path as the UI.
const scheduler = new Scheduler(database, scanner, queue, { mediaRefresher: connections });
const automations = new AutomationService(database);
const backlog = new BacklogService(database, scanner, queue);
const rootEnvPath = join(process.cwd(), '..', '.env');
const apiHandler = createApiHandler({ database, csrfToken: randomBytes(32).toString('base64url'), connections, automations, scheduler, backlog, queue, legacy: legacyInterlock,
  importEnvironment: async () => readImportedEnvironment(rootEnvPath) });
export const engine = { database, vault, provider, queue, scanner, scheduler, connections, automations, backlog };

const isDevelopment = process.env.NODE_ENV !== 'production';
const app = next({ dev: isDevelopment, hostname: config.host, port: config.port });
const handle = app.getRequestHandler();

function requestHost(request: IncomingMessage): string {
  return (request.headers.host ?? '').replace(/:\d+$/u, '').toLowerCase();
}

async function start(): Promise<void> {
  await app.prepare();
  const server = createServer((request, response) => {
    const host = requestHost(request);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      response.writeHead(421, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'invalid_local_host' }));
      return;
    }
    if (request.url?.startsWith('/api/')) {
      void apiHandler(request, response);
      return;
    }
    void handle(request, response);
  });

  server.listen(config.port, config.host, () => {
    process.stdout.write(`Local app listening on http://${config.host}:${config.port}\n`);
  });

  function shutdown(): void {
    server.close(() => {
      database.close();
      applicationLock.release();
      process.exit(0);
    });
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void start().catch(() => {
  database.close();
  applicationLock.release();
  process.stderr.write('Local server failed to start\n');
  process.exitCode = 1;
});
