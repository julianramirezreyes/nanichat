/**
 * Demo copy of server.ts for the user-manual screenshots. Differences from the real server:
 *  - wires the DemoProvider (no network I/O) instead of MetaProvider;
 *  - refuses to start unless LOCAL_SOCIAL_DATA_DIR is under /tmp (never touches ./data);
 *  - uses a legacy interlock stub that is never blocked and never reads ~/.local/share/gestor-instagram;
 *  - never reads the root .env (the env-import endpoint is disabled);
 *  - refuses port 3000 (the real app's port).
 * Run through docs/manual/tools/capture.mjs, or: LOCAL_SOCIAL_DATA_DIR=/tmp/x PORT=3100 NODE_ENV=production npx tsx docs/manual/tools/demo-server.ts
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import next from 'next';
import { acquireApplicationLock } from '../../../src/core/application-lock.ts';
import { loadConfig } from '../../../src/core/config.ts';
import { openDatabase } from '../../../src/db/database.ts';
import { migrateDatabase } from '../../../src/db/migrations.ts';
import { listEncryptedCredentials } from '../../../src/db/repositories.ts';
import { createVault } from '../../../src/security/vault.ts';
import { QueueService } from '../../../src/services/queue.ts';
import { Scanner } from '../../../src/services/scanner.ts';
import { Scheduler } from '../../../src/services/scheduler.ts';
import { ConnectionService } from '../../../src/services/connections.ts';
import { AutomationService } from '../../../src/services/automations.ts';
import { BacklogService } from '../../../src/services/backlog.ts';
import { createApiHandler } from '../../../src/http/router.ts';
import { DemoProvider, assertDemoDataDir, createNeverBlockedInterlock } from './demo-provider.ts';

const dataDir = assertDemoDataDir(process.env.LOCAL_SOCIAL_DATA_DIR);
const config = loadConfig({ ...process.env, LOCAL_SOCIAL_DATA_DIR: dataDir }, process.cwd());
if (config.port === 3000) throw new Error('Refusing to start the demo on port 3000 (reserved for the real app)');

const applicationLock = acquireApplicationLock(config.dataDir);
const database = openDatabase(config.dataDir);
migrateDatabase(database);
// Throwaway vault key generated inside the temp data dir by createVault.
const vault = createVault(config.dataDir, () => listEncryptedCredentials(database));

const provider = new DemoProvider({
  resolveSent: (messageId) => {
    const row = database.prepare(`SELECT q.payload_json AS payload, c.username AS recipient
      FROM send_attempts e JOIN queue_items q ON q.queue_item_id=e.queue_item_id AND q.account_id=e.account_id
      LEFT JOIN comments c ON c.account_id=q.account_id AND c.comment_id=q.comment_id
      WHERE e.message_id=? AND e.event_type='accepted' LIMIT 1`).get(messageId) as { payload: string; recipient: string | null } | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(row.payload) as { text?: string; buttons?: Array<{ title: string; url: string }> };
    return { text: parsed.text ?? '', buttons: parsed.buttons ?? [], recipientId: `demo_user_${row.recipient ?? 'x'}` };
  },
});
const legacyInterlock = createNeverBlockedInterlock();
const queue = new QueueService(database, provider, { legacyInterlock });
const scanner = new Scanner(database, provider);
const connections = new ConnectionService(database, vault, provider);
const scheduler = new Scheduler(database, scanner, queue, { mediaRefresher: connections });
const automations = new AutomationService(database);
const backlog = new BacklogService(database, scanner, queue);
const apiHandler = createApiHandler({ database, csrfToken: randomBytes(32).toString('base64url'), connections, automations, scheduler, backlog, queue, legacy: legacyInterlock,
  importEnvironment: async () => { throw new Error('environment import is disabled in the demo'); } });

const projectRoot = resolve(import.meta.dirname, '../../..');
const isDevelopment = process.env.NODE_ENV === 'development';
const app = next({ dev: isDevelopment, dir: projectRoot, hostname: config.host, port: config.port });
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
    process.stdout.write(`Demo app listening on http://${config.host}:${config.port} (data: ${join(config.dataDir)})\n`);
  });

  function shutdown(): void {
    server.close(() => {
      database.close();
      applicationLock.release();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void start().catch((error) => {
  database.close();
  applicationLock.release();
  process.stderr.write(`Demo server failed to start: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exitCode = 1;
});
