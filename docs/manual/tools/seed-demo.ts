/**
 * Seeds a throwaway demo data dir with 100% synthetic state for the user-manual screenshots.
 * Usage (server NOT running): LOCAL_SOCIAL_DATA_DIR=/tmp/social-demo-xyz npx tsx docs/manual/tools/seed-demo.ts
 * Everything goes through the app's own services and the DemoProvider (no network I/O). It ends in Dry Run ON.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../../src/db/database.ts';
import { migrateDatabase } from '../../../src/db/migrations.ts';
import { listEncryptedCredentials } from '../../../src/db/repositories.ts';
import { createVault } from '../../../src/security/vault.ts';
import { QueueService } from '../../../src/services/queue.ts';
import { Scanner } from '../../../src/services/scanner.ts';
import { ConnectionService } from '../../../src/services/connections.ts';
import { AutomationService, renderReply } from '../../../src/services/automations.ts';
import { BacklogService } from '../../../src/services/backlog.ts';
import { DemoProvider, assertDemoDataDir, createNeverBlockedInterlock } from './demo-provider.ts';

const dataDir = assertDemoDataDir(process.env.LOCAL_SOCIAL_DATA_DIR);
const database = openDatabase(dataDir);
migrateDatabase(database);
const vault = createVault(dataDir, () => listEncryptedCredentials(database));
const provider = new DemoProvider({
  speed: 0,
  resolveSent: (messageId) => {
    const row = database.prepare(`SELECT q.payload_json AS payload FROM send_attempts e
      JOIN queue_items q ON q.queue_item_id=e.queue_item_id AND q.account_id=e.account_id
      WHERE e.message_id=? AND e.event_type='accepted' LIMIT 1`).get(messageId) as { payload: string } | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(row.payload) as { text?: string; buttons?: Array<{ title: string; url: string }> };
    return { text: parsed.text ?? '', buttons: parsed.buttons ?? [], recipientId: 'demo_user' };
  },
});
const legacyInterlock = createNeverBlockedInterlock();
const queue = new QueueService(database, provider, { legacyInterlock, sendSpacingMs: 0, publicReplySpacingMs: 0 });
const scanner = new Scanner(database, provider);
const connections = new ConnectionService(database, vault, provider);
const automations = new AutomationService(database);
const backlog = new BacklogService(database, scanner, queue);

const ids = DemoProvider.commentIds();
const cid = (index: number): string => ids[index]!.commentId;

async function main(): Promise<void> {
  // 1. Connection, validation, discovery, account selection and publications (through the services).
  const connectionId = 'demo-connection';
  await connections.create({ id: connectionId, name: 'Mi cuenta de Instagram', loginKind: 'instagram_login', graphVersion: 'v26.0', accessToken: 'DEMO-TOKEN-NOT-REAL' });
  await connections.testConnection(connectionId);
  const candidates = await connections.discoverAccounts(connectionId);
  const mine = candidates.find((candidate) => candidate.username === 'tu_cuenta')!;
  const account = await connections.selectAccount(connectionId, mine);
  const accountId = account.accountId;
  await connections.listMedia(accountId);
  const media = database.prepare(`SELECT media_id FROM media WHERE account_id=? ORDER BY published_at DESC`).all(accountId) as Array<{ media_id: string }>;
  const launchMedia = DemoProvider.mediaId(2);
  if (!media.some((row) => row.media_id === launchMedia)) throw new Error('Demo media missing');

  // 2. Automations: a general one with a public reply, and a specific one for the course launch.
  const general = automations.create({
    accountId, scope: 'account', name: 'Guía gratuita', matchMode: 'contains',
    replyText: 'Hola {{username}}, ¡gracias por comentar! Aquí tienes tu guía gratuita sobre {{keyword}}.',
    buttons: [{ title: 'Descargar guía', url: 'https://ejemplo.com/guia' }, { title: 'Ver más', url: 'https://ejemplo.com/mas' }],
    publicReplyEnabled: true,
    publicReplyVariants: [
      '¡Listo @{{username}}! Te escribí por mensaje privado 💌',
      'Revisa tu bandeja de entrada, @{{username}} 📬',
      '@{{username}} ya te envié la {{keyword}} por privado',
      '¡Gracias por comentar, @{{username}}! Te la mandé por DM ✨',
      'Hecho, @{{username}}: mira tus mensajes 😉',
      '@{{username}} te respondí por mensaje directo, revísalo 🙌',
      '¡Enviado, @{{username}}! Si no te llega, avísame',
      'Ya está en tu bandeja, @{{username}}. ¡Disfrútala!',
    ],
  });
  automations.addKeyword(accountId, general, 'guia');
  const course = automations.create({
    accountId, scope: 'media', mediaId: launchMedia, name: 'Lanzamiento del curso', matchMode: 'contains',
    replyText: 'Hola {{username}}, te comparto los detalles del curso. ¡Nos vemos dentro!',
    buttons: [{ title: 'Ver el curso', url: 'https://ejemplo.com/curso' }],
  });
  automations.addKeyword(accountId, course, 'curso');
  automations.setEnabled(accountId, general, true);
  automations.setEnabled(accountId, course, true);

  // 3. Complete backlog scan (7 days): stores the comments and the eligible classifications.
  const ref = { accountId, connectionId, providerAccountId: mine.providerAccountId, username: mine.username };
  const scan = await backlog.scanAll([ref], { window: '7d' });
  if (scan[0]?.status !== 'complete') throw new Error('Seed scan did not complete');

  // 4a. Dry Run ON: SIMULATED items (general x4, specific x3) with the inert public-reply preview.
  await backlog.processEligible(accountId, general, [15, 18, 20, 23].map(cid));
  await backlog.processEligible(accountId, course, [28, 30, 31].map(cid));

  // 4b. Real flow against the fake provider: SENT (+ public reply + readback), FAILED_RETRYABLE, UNKNOWN_OUTCOME.
  database.prepare(`UPDATE social_accounts SET monitoring_paused=0`).run();
  queue.setDryRun(false, true);
  automations.setRealEnabled(accountId, general, true, true);
  provider.setBehavior(cid(35), 'retryable');
  provider.setBehavior(cid(40), 'ambiguous');
  await backlog.processEligible(accountId, general, [5, 8, 10, 14, 35, 40].map(cid));
  for (let guard = 0; guard < 30; guard++) {
    if (!(await queue.processOne(accountId))) break;
  }
  for (let guard = 0; guard < 30; guard++) {
    if (!(await queue.processPublicReply(accountId))) break;
  }

  // 4c. Items that never reach the provider: SKIPPED (owner already replied) and EXPIRED (past the 7-day window).
  insertItem(accountId, general, cid(21), 'SKIPPED', 'owner_replied');
  insertItem(accountId, general, cid(36), 'EXPIRED', 'private_reply_window_elapsed');

  // 5. Back to the safe defaults: Dry Run ON, accounts paused, monitoring off.
  queue.setDryRun(true);
  database.prepare(`UPDATE social_accounts SET monitoring_paused=1`).run();
  database.prepare(`UPDATE app_state SET state_value='false' WHERE state_key='monitoring_enabled'`).run();

  // 6. Spread the creation times so the history reads naturally and mixes states from the first row.
  const order = [5, 15, 35, 8, 18, 40, 10, 20, 21, 14, 23, 28, 36, 30, 31];
  const update = database.prepare(`UPDATE queue_items SET created_at=?, updated_at=MAX(updated_at, ?) WHERE account_id=? AND comment_id=?`);
  const now = Date.now();
  order.forEach((commentIndex, position) => {
    const at = new Date(now - (8 + position * 12) * 60_000).toISOString();
    update.run(at, at, accountId, cid(commentIndex));
  });

  report(accountId);
}

function insertItem(accountId: string, automationId: string, commentId: string, state: 'SKIPPED' | 'EXPIRED', reason: string): void {
  const automation = database.prepare(`SELECT reply_text, buttons_json, version FROM automations WHERE account_id=? AND automation_id=?`)
    .get(accountId, automationId) as { reply_text: string; buttons_json: string; version: number };
  const comment = database.prepare(`SELECT username FROM comments WHERE account_id=? AND comment_id=?`).get(accountId, commentId) as { username: string };
  const payload = renderReply(automation.reply_text, { username: comment.username, comment: '', keyword: 'guia', account: 'tu_cuenta', media: '' },
    JSON.parse(automation.buttons_json) as Array<{ title: string; url: string }>);
  const at = new Date().toISOString();
  database.prepare(`INSERT INTO queue_items (queue_item_id, account_id, comment_id, automation_id, state, dry_run, payload_json, created_at, updated_at, state_reason_code)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
    .run(randomUUID(), accountId, commentId, automationId, state, JSON.stringify({ ...payload, automation_version: automation.version }), at, at, reason);
}

function report(accountId: string): void {
  const states = database.prepare(`SELECT state, COUNT(*) AS n FROM queue_items WHERE account_id=? GROUP BY state ORDER BY state`).all(accountId);
  const pending = database.prepare(`SELECT COUNT(*) AS n FROM comment_classifications c WHERE c.account_id=? AND c.result='eligible'
    AND NOT EXISTS (SELECT 1 FROM queue_items q WHERE q.account_id=c.account_id AND q.comment_id=c.comment_id)`).get(accountId);
  const comments = database.prepare(`SELECT COUNT(*) AS n FROM comments WHERE account_id=?`).get(accountId);
  const publics = database.prepare(`SELECT public_reply_state AS s, COUNT(*) AS n FROM queue_items WHERE public_reply_state IS NOT NULL GROUP BY 1`).all();
  const dry = database.prepare(`SELECT state_value FROM app_state WHERE state_key='dry_run'`).get();
  process.stdout.write(`${JSON.stringify({ states, pendingReview: pending, comments, publicStates: publics, dryRun: dry })}\n`);
}

main().then(() => database.close(), (error) => {
  process.stderr.write(`Seed failed: ${error instanceof Error ? error.stack ?? error.message : 'unknown'}\n`);
  (database as DatabaseSync).close();
  process.exitCode = 1;
});
