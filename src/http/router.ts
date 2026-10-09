import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { AccountRef, SocialProvider } from '../core/domain.ts';
import type { ConnectionService } from '../services/connections.ts';
import type { AutomationService } from '../services/automations.ts';
import type { Scheduler } from '../services/scheduler.ts';
import { ScanProgress, type BacklogService } from '../services/backlog.ts';
import { QueueReadbackError, type QueueService } from '../services/queue.ts';
import { listPendingReview, truncateText } from '../services/pending-review.ts';
import { storedPublicReplyVariants } from '../services/public-reply.ts';
import { FollowGateConfigError, InteractiveModeRetiredError, assertInteractiveRetired, storedFollowGateConfig } from '../services/automations.ts';
import { ResourceAttachmentError, storedResourceAttachment } from '../services/resource-attachment.ts';
import { followGateAvailable } from '../services/follow-gate-rules.ts';
import type { ImportedMetaEnvironment } from '../security/env-import.ts';

const BODY_LIMIT = 64 * 1024;
const PAGE_LIMIT = 100;
type Json = Record<string, unknown>;
type ScanJob = { id: string; status: 'running' | 'complete' | 'partial' | 'failed' | 'cancelled'; createdAt: string; result?: unknown; errorCode?: string; controller: AbortController; progress: ScanProgress };

export type ApiDependencies = {
  database: DatabaseSync;
  csrfToken?: string;
  connections?: ConnectionService;
  automations?: AutomationService;
  scheduler?: Scheduler;
  backlog?: BacklogService;
  queue?: QueueService;
  /** Server clock (ms); injectable for deterministic expiry tests. */
  clock?: () => number;
  importEnvironment?: () => Promise<ImportedMetaEnvironment>;
  /** EXPERIMENTAL read-only diagnostics (follow gate phase 0): GET-only provider calls. */
  diagnostics?: Required<Pick<SocialProvider, 'diagnoseConversation' | 'getUserProfile'>>;
  /** TEST-ONLY override of FOLLOW_GATE_AVAILABLE (the retired follow gate); production never passes it. */
  followGateAvailable?: boolean;
  legacy?: {
    inspect(username: string): { blocked: boolean; reasonCode?: string; lockPresent: boolean; counterVersion: string; holdConfigured?: boolean };
    acknowledge(username: string, version: string): { ok: boolean; state: { lockPresent: boolean; counterVersion: string } };
  };
};

export function createApiHandler(deps: ApiDependencies) {
  const csrfToken = deps.csrfToken ?? randomBytes(32).toString('base64url');
  const jobs = new Map<string, ScanJob>();
  const diagnosticsCalls = new Map<string, number>();

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    try {
      const host = request.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d{1,5})?$/u.test(host)) return send(response, 421, { error: 'invalid_local_host' });
      const baseOrigin = `http://${host}`;
      const url = new URL(request.url ?? '/', baseOrigin);
      if (url.origin !== baseOrigin) return send(response, 421, { error: 'invalid_local_host' });
      if (!url.pathname.startsWith('/api/')) return send(response, 404, { error: 'not_found' });
      const method = request.method ?? 'GET';
      if (url.pathname === '/api/health' && method !== 'GET') return send(response, 405, { error: 'method_not_allowed' });
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return send(response, 405, { error: 'method_not_allowed' });
      const mutation = !['GET', 'HEAD'].includes(method);
      if (mutation) {
        const expectedOrigin = `http://${host}`;
        if (request.headers.origin !== expectedOrigin || request.headers['x-csrf-token'] !== csrfToken) {
          return send(response, 403, { error: 'origin_or_csrf_rejected' });
        }
      }
      let body: Json = {};
      if (mutation) body = await readJson(request);
      await route(request, response, url, method, body, deps, jobs, csrfToken, diagnosticsCalls);
    } catch (error) {
      if (error instanceof QueueReadbackError) return send(response, error.status, { error: error.code });
      const status = error instanceof ApiError ? error.status : error instanceof TypeError ? 400 : 409;
      const code = error instanceof ApiError ? error.code
        : error instanceof FollowGateConfigError || error instanceof ResourceAttachmentError || error instanceof InteractiveModeRetiredError ? error.code
          : error instanceof TypeError ? 'invalid_request' : 'operation_rejected';
      send(response, status, { error: code });
    }
  };
}

/** Stand-in used when the legacy interlock is not configured: never blocks and never touches the filesystem. */
const DISABLED_LEGACY: NonNullable<ApiDependencies['legacy']> = {
  inspect: () => ({ blocked: false, lockPresent: false, counterVersion: 'absent', holdConfigured: false }),
  acknowledge: (_username, version) => ({ ok: version === 'absent', state: { lockPresent: false, counterVersion: 'absent' } }),
};

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  body: Json,
  deps: ApiDependencies,
  jobs: Map<string, ScanJob>,
  csrfToken: string,
  diagnosticsCalls: Map<string, number> = new Map(),
): Promise<void> {
  const { database: db } = deps;
  const path = url.pathname;
  if (path === '/api/session' && method === 'GET') return send(response, 200, { csrfToken });
  if (path === '/api/health' && method === 'GET') return send(response, 200, { status: 'ok', ready: true });
  if (path === '/api/dashboard' && method === 'GET') return send(response, 200, dashboard(db, accountFilter(url)));
  if (path === '/api/connections' && method === 'GET') {
    const selected = accountFilter(url);
    const accounts = listAccounts(db, selected);
    const ownerConnections = new Set(accounts.map((account) => String(account.connectionId)));
    const visibleConnections = (deps.connections?.listConnections() ?? []).filter((connection) => !selected || ownerConnections.has(connection.id));
    return send(response, 200, { connections: visibleConnections, accounts });
  }
  if (path === '/api/connections' && method === 'POST') {
    const service = requireService(deps.connections, 'connections');
    return send(response, 201, { connection: await service.create({
      id: id(body.id), name: text(body.name), loginKind: loginKind(body.loginKind), appId: optionalText(body.appId),
      graphVersion: text(body.graphVersion), accessToken: text(body.accessToken),
    }) });
  }
  const connectionMatch = path.match(/^\/api\/connections\/([^/]+)(?:\/(test|discover|select|media|disconnect|delete))?$/u);
  if (connectionMatch) {
    const service = requireService(deps.connections, 'connections');
    const connectionId = decodeURIComponent(connectionMatch[1]!);
    const action = connectionMatch[2];
    if (!action && method === 'PUT') return send(response, 200, { connection: await service.update(connectionId, {
      name: optionalText(body.name), appId: body.appId === null ? null : optionalText(body.appId),
      graphVersion: optionalText(body.graphVersion), accessToken: optionalText(body.accessToken),
    }) });
    if (action === 'test' && method === 'POST') return send(response, 200, { validation: await service.testConnection(connectionId) });
    if (action === 'discover' && method === 'POST') return send(response, 200, { candidates: await service.discoverAccounts(connectionId) });
    if (action === 'select' && method === 'POST') {
      const candidate = object(body.account);
      const account = await service.selectAccount(connectionId, {
        providerAccountId: text(candidate.providerAccountId), username: text(candidate.username),
        capabilities: [],
      } as never);
      // Opt-in legacy interlock: without configuration nothing is inspected and no account starts held.
      const legacyState = deps.legacy?.inspect(account.username);
      if (legacyState?.blocked) {
        deps.automations?.setAccountSendHold(account.accountId,
          legacyState?.reasonCode === 'legacy_lock_present' ? 'legacy_lock_present'
            : legacyState?.reasonCode === 'legacy_rejection_history' ? 'legacy_rejection_history' : 'legacy_historical_rejection');
      }
      return send(response, 201, { account });
    }
    if (action === 'media' && method === 'POST') {
      const selectedAccount = accountId(body.accountId, db);
      const owner = db.prepare(`SELECT connection_id FROM social_accounts WHERE account_id=?`).get(selectedAccount) as { connection_id: string };
      if (owner.connection_id !== connectionId) throw new ApiError(404, 'account_not_owned_by_connection');
      return send(response, 200, { media: await service.listMedia(selectedAccount) });
    }
    if (action === 'disconnect' && method === 'POST') { await service.disconnect(connectionId); return send(response, 200, { ok: true }); }
    if (action === 'delete' && method === 'POST') { await service.delete(connectionId); return send(response, 200, { ok: true }); }
  }
  if (path === '/api/accounts' && method === 'GET') return send(response, 200, { accounts: listAccounts(db, accountFilter(url)) });
  if (path === '/api/media' && method === 'GET') {
    const accountIdValue = accountFilter(url);
    return send(response, 200, { media: listMedia(db, accountIdValue) });
  }
  if (path === '/api/automations' && method === 'GET') return send(response, 200, { automations: listAutomations(db, accountFilter(url), followGateAvailable(deps.followGateAvailable)) });
  if (path === '/api/automations' && method === 'POST') {
    const service = requireService(deps.automations, 'automations');
    const account = accountId(body.accountId, db);
    // The experimental interactive buttons are retired: anything but 'none'/[] (or omitted) is a 400.
    assertInteractiveRetired(body.interactiveMode, body.interactiveTitles);
    const keywords = stringList(body.keywords, 20);
    const normalizedKeywords = keywords.map((keyword) => keyword.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('und').replace(/[\s\u00a0]+/gu, ' ').trim());
    if (!keywords.length || normalizedKeywords.some((keyword) => !keyword) || new Set(normalizedKeywords).size !== normalizedKeywords.length) {
      throw new TypeError('Automation requires distinct keyword phrases');
    }
    // scope 'account' (general) requires mediaId omitted or null; scope 'media' (default) requires a media of the account.
    const scope = automationScope(body.scope, true)!;
    if (scope === 'account' && body.mediaId !== undefined && body.mediaId !== null) throw new TypeError('A general automation cannot target one media');
    // publicReplyEnabled / publicReplyVariants are passed through unchanged: the service validates them strictly
    // (boolean, list of valid variants, enabled requires >= 1) and never coerces; any violation is a TypeError (400).
    const automationId = service.create({ accountId: account, scope, mediaId: scope === 'account' ? null : text(body.mediaId), name: text(body.name),
      replyText: text(body.replyText), matchMode: matchMode(body.matchMode, true), buttons: buttons(body.buttons),
      publicReplyEnabled: body.publicReplyEnabled as boolean | undefined, publicReplyVariants: body.publicReplyVariants as string[] | undefined,
      // Follow gate and attachment: RETIRED (400 follow_gate_retired / attachment_retired unless the test-only override is on).
      ...followGateFields(body) });
    for (const keyword of keywords) service.addKeyword(account, automationId, keyword);
    return send(response, 201, { automationId });
  }
  const automationEdit = path.match(/^\/api\/automations\/([^/]+)$/u);
  if (automationEdit && method === 'PUT') {
    const account = accountId(body.accountId, db);
    assertInteractiveRetired(body.interactiveMode, body.interactiveTitles);
    // The stored scope is authoritative: a different `scope`, or a media for a general automation, is rejected (409).
    requireService(deps.automations, 'automations').update(account, decodeURIComponent(automationEdit[1]!), {
      name: text(body.name), mediaId: body.mediaId === undefined || body.mediaId === null ? null : text(body.mediaId),
      scope: automationScope(body.scope, false), replyText: text(body.replyText),
      matchMode: matchMode(body.matchMode, false), buttons: buttons(body.buttons), keywords: stringList(body.keywords, 20),
      // Omitted: the stored public reply configuration is kept.
      publicReplyEnabled: body.publicReplyEnabled as boolean | undefined, publicReplyVariants: body.publicReplyVariants as string[] | undefined,
      // Follow gate and attachment: RETIRED, so a valid PUT resets any stored configuration to off/empty (400 if requested).
      ...followGateFields(body),
    });
    return send(response, 200, { ok: true });
  }
  const automationMatch = path.match(/^\/api\/automations\/([^/]+)\/(enabled|real|delete)$/u);
  if (automationMatch) {
    const service = requireService(deps.automations, 'automations');
    const automationId = decodeURIComponent(automationMatch[1]!);
    const account = accountId(body.accountId, db);
    const action = automationMatch[2];
    if (action === 'enabled' && method === 'PATCH') { service.setEnabled(account, automationId, boolean(body.enabled)); return send(response, 200, { ok: true }); }
    if (action === 'real' && method === 'PATCH') { service.setRealEnabled(account, automationId, boolean(body.enabled), body.confirmed === true); return send(response, 200, { ok: true }); }
    if (action === 'delete' && method === 'POST') { archiveAutomation(db, account, automationId); return send(response, 200, { ok: true }); }
  }
  if (path === '/api/settings/dry-run' && method === 'POST') {
    const enabled = boolean(body.enabled);
    if (!enabled && body.confirmed !== true) throw new TypeError('Explicit confirmation is required to disable Dry Run');
    requireService(deps.queue, 'queue').setDryRun(enabled, body.confirmed === true);
    return send(response, 200, { dryRun: enabled });
  }
  if (path === '/api/settings/features' && method === 'GET') {
    return send(response, 200, { envImport: Boolean(deps.importEnvironment), legacyInterlock: Boolean(deps.legacy) });
  }
  if (path === '/api/settings/import-root-env' && method === 'POST') {
    if (body.confirmed !== true) throw new TypeError('Explicit import confirmation is required');
    const imported = await requireService(deps.importEnvironment, 'environment_import')();
    const connection = await requireService(deps.connections, 'connections').create({
      id: randomBytes(16).toString('hex'), name: imported.name, loginKind: imported.loginKind,
      appId: imported.appId, graphVersion: imported.graphVersion, accessToken: imported.accessToken,
    });
    return send(response, 201, { connection, imported: true, tokenStoredEncrypted: true });
  }
  if (path === '/api/monitor' && method === 'GET') return send(response, 200, { status: deps.scheduler?.status() ?? { enabled: false, accounts: [] } });
  if (path === '/api/monitor/all' && method === 'POST') {
    if (body.action === 'start') requireService(deps.scheduler, 'scheduler').startAll();
    else if (body.action === 'stop') requireService(deps.scheduler, 'scheduler').stopAll();
    else throw new TypeError('Invalid monitor action');
    return send(response, 200, { status: deps.scheduler!.status() });
  }
  const monitorMatch = path.match(/^\/api\/monitor\/([^/]+)$/u);
  if (monitorMatch && method === 'POST') {
    const account = accountId(decodeURIComponent(monitorMatch[1]!), db);
    if (body.action === 'start') requireService(deps.scheduler, 'scheduler').start(account);
    else if (body.action === 'stop') requireService(deps.scheduler, 'scheduler').stop(account);
    else throw new TypeError('Invalid monitor action');
    return send(response, 200, { status: deps.scheduler!.status() });
  }
  if (path === '/api/backlog/jobs' && method === 'POST') {
    const account = body.accountId === 'all' ? null : accountId(body.accountId, db);
    const window = body.window;
    if (!['2h', '24h', '3d', '7d', 'custom'].includes(String(window))) throw new TypeError('Invalid catch-up window');
    const id = randomBytes(16).toString('hex');
    const controller = new AbortController();
    const job: ScanJob = { id, status: 'running', createdAt: new Date().toISOString(), controller, progress: new ScanProgress() };
    jobs.set(id, job);
    const accounts = account ? [accountRef(db, account)] : allAccountRefs(db);
    void requireService(deps.backlog, 'backlog').scanAll(accounts, { window: window as never,
      customSince: optionalText(body.customSince), signal: controller.signal, progress: job.progress } as never).then((result) => {
      job.result = result;
      job.status = controller.signal.aborted || result.some((entry: { status?: string }) => entry.status === 'cancelled') ? 'cancelled'
        : result.some((entry: { status?: string }) => entry.status !== 'complete') ? 'partial' : 'complete';
    }).catch(() => { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.errorCode = 'scan_failed'; });
    return send(response, 202, { jobId: id });
  }
  const jobMatch = path.match(/^\/api\/backlog\/jobs\/([^/]+)(?:\/(cancel))?$/u);
  if (jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]!));
    if (!job) throw new ApiError(404, 'scan_job_not_found');
    if (jobMatch[2] === 'cancel' && method === 'POST') { job.controller.abort(); return send(response, 202, { status: job.status }); }
    if (method === 'GET') return send(response, 200, { id: job.id, status: job.status, createdAt: job.createdAt, result: job.result, errorCode: job.errorCode, progress: job.progress.snapshot() });
  }
  if (path === '/api/backlog/process' && method === 'POST') {
    if (body.confirmed !== true) throw new TypeError('Explicit review confirmation is required');
    const inserted = await requireService(deps.backlog, 'backlog').processEligible(accountId(body.accountId, db), text(body.automationId), stringList(body.commentIds, 200));
    return send(response, 200, { acceptedCount: inserted.length });
  }
  if (path === '/api/backlog/pending' && method === 'GET') {
    const selected = accountId(url.searchParams.get('accountId'), db);
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(url.searchParams.get('limit') ?? 50)) || 50));
    const offset = Math.max(0, Math.min(100_000, Math.trunc(Number(url.searchParams.get('offset') ?? 0)) || 0));
    return send(response, 200, listPendingReview(db, selected, { limit, offset, now: (deps.clock ?? Date.now)(),
      followGateAvailable: deps.followGateAvailable }));
  }
  if (path === '/api/queue' && method === 'GET') return send(response, 200, queuePage(db, accountFilter(url), url));
  const attemptsMatch = path.match(/^\/api\/queue\/([^/]+)\/attempts$/u);
  if (attemptsMatch && method === 'GET') {
    const selected = accountId(url.searchParams.get('accountId'), db);
    const queueId = decodeURIComponent(attemptsMatch[1]!);
    const owner = db.prepare(`SELECT 1 FROM queue_items WHERE queue_item_id=? AND account_id=?`).get(queueId, selected);
    if (!owner) throw new ApiError(404, 'queue_item_not_found');
    const events = db.prepare(`SELECT event_type AS type, event_at AS at, message_id AS messageId, safe_error_code AS safeErrorCode, details_json
      FROM send_attempts WHERE account_id=? AND queue_item_id=? ORDER BY event_at, attempt_event_id`).all(selected, queueId) as Array<Record<string, unknown>>;
    const publicEvents = db.prepare(`SELECT event_type AS type, event_at AS at, reply_id AS replyId, safe_error_code AS safeErrorCode, details_json
      FROM public_reply_attempts WHERE account_id=? AND queue_item_id=? ORDER BY event_at, rowid`).all(selected, queueId) as Array<Record<string, unknown>>;
    const gateEvents = db.prepare(`SELECT e.event_type AS type, e.event_at AS at, e.safe_error_code AS safeErrorCode, e.details_json
      FROM gate_events e JOIN gate_sessions g ON g.gate_session_id=e.gate_session_id AND g.account_id=e.account_id
      WHERE g.account_id=? AND g.queue_item_id=? ORDER BY e.event_at, e.rowid`).all(selected, queueId) as Array<Record<string, unknown>>;
    const gatePartEvents = db.prepare(`SELECT p.part, p.event_type AS type, p.event_at AS at, p.safe_error_code AS safeErrorCode
      FROM gate_part_events p JOIN gate_sessions g ON g.gate_session_id=p.gate_session_id AND g.account_id=p.account_id
      WHERE g.account_id=? AND g.queue_item_id=? ORDER BY p.rowid`).all(selected, queueId) as Array<Record<string, unknown>>;
    return send(response, 200, { events: events.map((event) => ({ type: event.type, at: event.at, messageId: event.messageId,
      safeErrorCode: event.safeErrorCode, details: safeAttemptDetails(String(event.details_json)) })),
      // Follow gate events: type, time and safe code only (message ids and IGSIDs stay server-side).
      gateEvents: gateEvents.map((event) => ({ type: event.type, at: event.at, safeErrorCode: event.safeErrorCode ?? null,
        details: safeGateDetails(String(event.details_json)) })),
      // Attachment sessions: per-part log (attachment / text); message ids stay server-side.
      gatePartEvents: gatePartEvents.map((event) => ({ part: event.part, type: event.type, at: event.at, safeErrorCode: event.safeErrorCode ?? null })),
      publicEvents: publicEvents.map((event) => ({ type: event.type, at: event.at, replyId: event.replyId,
        safeErrorCode: event.safeErrorCode, details: safeAttemptDetails(String(event.details_json)) })) });
  }
  const publicRetryMatch = path.match(/^\/api\/queue\/([^/]+)\/public-reply\/retry$/u);
  if (publicRetryMatch && method === 'POST') {
    // Explicit operator action: only a FAILED public reply of an item owned by this account; the private state is untouched.
    const selected = accountId(body.accountId, db);
    requireService(deps.queue, 'queue').retryPublicReply(selected, decodeURIComponent(publicRetryMatch[1]!));
    return send(response, 200, { ok: true, publicReplyState: 'PENDING' });
  }
  const readbackMatch = path.match(/^\/api\/queue\/([^/]+)\/readback$/u);
  if (readbackMatch && method === 'POST') {
    const selected = accountId(body.accountId, db);
    return send(response, 200, await requireService(deps.queue, 'queue').verifyReadback(selected, decodeURIComponent(readbackMatch[1]!)));
  }
  if (path === '/api/diagnostics/conversation' && method === 'GET') {
    // EXPERIMENTAL read-only diagnostics. Although it is a GET, it triggers provider calls, so it also requires the
    // session CSRF token (a cross-site page cannot send this header without a CORS preflight, which is never granted).
    if (request.headers['x-csrf-token'] !== csrfToken) throw new ApiError(403, 'origin_or_csrf_rejected');
    const selected = accountId(url.searchParams.get('accountId'), db);
    const commentId = url.searchParams.get('commentId') ?? '';
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(commentId)) throw new TypeError('Invalid comment ID');
    const comment = db.prepare(`SELECT author_igsid FROM comments WHERE account_id=? AND comment_id=?`).get(selected, commentId) as
      { author_igsid: string | null } | undefined;
    if (!comment) throw new ApiError(404, 'comment_not_found');
    const igsid = comment.author_igsid;
    if (!igsid || !/^[A-Za-z0-9_-]{1,64}$/u.test(igsid)) throw new ApiError(409, 'igsid_unknown');
    const provider = requireService(deps.diagnostics, 'diagnostics');
    const account = accountRef(db, selected);
    const now = (deps.clock ?? Date.now)();
    const key = `${selected}:${commentId}`;
    const last = diagnosticsCalls.get(key);
    if (last !== undefined && now - last < DIAGNOSTICS_MIN_INTERVAL_MS) throw new ApiError(429, 'diagnostics_rate_limited');
    if (diagnosticsCalls.size > 500) {
      for (const [entry, at] of diagnosticsCalls) if (now - at >= DIAGNOSTICS_MIN_INTERVAL_MS) diagnosticsCalls.delete(entry);
    }
    diagnosticsCalls.set(key, now);
    const conversation = await provider.diagnoseConversation(account, igsid);
    const profile = await provider.getUserProfile(account, igsid);
    return send(response, 200, { igsid: `…${igsid.slice(-4)}`, conversation: safeConversation(conversation), profile: safeProfile(profile) });
  }
  if (path === '/api/settings/legacy' && method === 'GET') {
    const username = (url.searchParams.get('username') ?? '').replace(/^@/u, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/u.test(username)) throw new TypeError('Invalid username');
    const result = (deps.legacy ?? DISABLED_LEGACY).inspect(username);
    return send(response, 200, { username, enabled: Boolean(deps.legacy), ...result });
  }
  if (path === '/api/settings/legacy/acknowledge' && method === 'POST') {
    if (body.confirmed !== true) throw new TypeError('Explicit historical hold acknowledgement is required');
    const account = accountId(body.accountId, db);
    const row = db.prepare(`SELECT username FROM social_accounts WHERE account_id=?`).get(account) as { username: string };
    const expectedVersion = text(body.counterVersion);
    // With the interlock disabled no legacy file is read; a hold left from an earlier configuration can still be
    // acknowledged explicitly against the "absent" counter version.
    const result = (deps.legacy ?? DISABLED_LEGACY).acknowledge(row.username, expectedVersion);
    if (!result?.ok) throw new ApiError(409, 'legacy_state_changed');
    const username = row.username.replace(/^@/u, '').toLocaleLowerCase('und');
    db.prepare(`INSERT INTO legacy_account_acknowledgements(account_id, username, counter_version, acknowledged_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET username=excluded.username,
      counter_version=excluded.counter_version, acknowledged_at=excluded.acknowledged_at`)
      .run(account, username, expectedVersion, new Date().toISOString());
    db.prepare(`DELETE FROM account_send_holds WHERE account_id=? AND reason_code LIKE 'legacy_%'`).run(account);
    return send(response, 200, { acknowledged: true, username, counterVersion: expectedVersion });
  }
  send(response, 404, { error: 'not_found' });
}

function dashboard(db: DatabaseSync, selected?: string) {
  if (selected) accountId(selected, db);
  const params = selected ? [selected] : [];
  const where = selected ? 'WHERE account_id=?' : '';
  const accounts = selected ? listAccounts(db, selected) : listAccounts(db);
  const queue = db.prepare(`SELECT state, COUNT(*) AS count FROM queue_items ${where} GROUP BY state`).all(...params) as Array<{ state: string; count: number }>;
  const automations = db.prepare(`SELECT status, COUNT(*) AS count FROM automations ${where} GROUP BY status`).all(...params) as Array<{ status: string; count: number }>;
  const scans = db.prepare(`SELECT account_id, MAX(finished_at) AS last_sync,
      (SELECT stop_reason FROM scan_runs latest WHERE latest.account_id=scan_runs.account_id ORDER BY started_at DESC LIMIT 1) AS last_error,
      (SELECT status FROM scan_runs latest WHERE latest.account_id=scan_runs.account_id ORDER BY started_at DESC LIMIT 1) AS coverage
      FROM scan_runs ${where} GROUP BY account_id`).all(...params) as Array<{ account_id: string; last_sync: string | null; last_error: string | null; coverage: string | null }>;
  const dryRunRow = db.prepare(`SELECT state_value FROM app_state WHERE state_key='dry_run'`).get() as { state_value: string } | undefined;
  const monitor = db.prepare(`SELECT state_value FROM app_state WHERE state_key='monitoring_enabled'`).get() as { state_value: string } | undefined;
  return { accounts: accounts.map((account) => ({ ...account, ...scans.find((scan) => scan.account_id === account.accountId) })), queue, automations, dryRun: dryRunRow?.state_value !== 'false', monitoringEnabled: monitor?.state_value === 'true' };
}

function listAccounts(db: DatabaseSync, selected?: string): Array<Record<string, unknown> & { accountId: string }> {
  const rows = db.prepare(`SELECT account_id AS accountId, connection_id AS connectionId, provider_account_id AS providerAccountId,
      username, display_name AS displayName, account_type AS accountType, related_page_id AS relatedPageId, status,
      monitoring_paused AS monitoringPaused,
      (SELECT reason_code FROM account_send_holds WHERE account_id=social_accounts.account_id) AS sendHoldReason
      FROM social_accounts ${selected ? 'WHERE account_id=?' : ''} ORDER BY username, account_id`)
    .all(...(selected ? [selected] : [])) as Array<Record<string, unknown> & { accountId: string }>;
  return rows.map((row) => ({ ...row, monitoringPaused: Boolean(row.monitoringPaused) }));
}

function listMedia(db: DatabaseSync, selected?: string) {
  if (selected) accountId(selected, db);
  return db.prepare(`SELECT account_id AS accountId, media_id AS mediaId, permalink, published_at AS publishedAt, last_seen_at AS lastSeenAt,
    caption, media_type AS mediaType
    FROM media ${selected ? 'WHERE account_id=?' : ''} ORDER BY published_at DESC, media_id LIMIT 500`).all(...(selected ? [selected] : []));
}

function listAutomations(db: DatabaseSync, selected?: string, gateAvailable = false) {
  if (selected) accountId(selected, db);
  const rows = db.prepare(`SELECT automation_id AS automationId, account_id AS accountId, media_id AS mediaId, scope, name,
      status, match_mode AS matchMode, reply_text AS replyText, buttons_json AS buttonsJson, real_enabled AS realEnabled,
      monitoring_started_at AS monitoringStartedAt, public_reply_enabled AS publicReplyEnabled,
      public_reply_variants_json AS publicReplyVariantsJson, follow_gate_enabled AS followGateEnabled,
      follow_gate_message AS followGateMessage, follow_gate_button_title AS followGateButtonTitle,
      resource_attachment_kind AS resourceAttachmentKind, resource_attachment_url AS resourceAttachmentUrl FROM automations ${selected ? "WHERE account_id=? AND name NOT LIKE '% (archived)'" : "WHERE name NOT LIKE '% (archived)'"} ORDER BY updated_at DESC LIMIT 500`)
    .all(...(selected ? [selected] : [])) as Array<Record<string, unknown>>;
  return rows.map(({ publicReplyVariantsJson, ...row }) => ({ ...row,
    ...(({ enabled, message, buttonTitle }) => ({ followGateEnabled: enabled, followGateMessage: message, followGateButtonTitle: buttonTitle }))(
      storedFollowGateConfig(row.followGateEnabled, row.followGateMessage, row.followGateButtonTitle)),
    // Retired follow gate: the fields stay in the DTO but always read as disabled/empty (stored values are inert).
    ...(gateAvailable ? {} : { followGateEnabled: false, followGateMessage: '', resourceAttachmentKind: '', resourceAttachmentUrl: '' }),
    buttons: JSON.parse(String(row.buttonsJson)), realEnabled: Boolean(row.realEnabled),
    publicReplyEnabled: Boolean(row.publicReplyEnabled), publicReplyVariants: storedPublicReplyVariants(String(publicReplyVariantsJson)),
    keywords: db.prepare(`SELECT phrase FROM automation_keywords WHERE account_id=? AND automation_id=? ORDER BY rowid`)
      .all(String(row.accountId), String(row.automationId)) }));
}

function queuePage(db: DatabaseSync, selected: string | undefined, url: URL) {
  if (selected) accountId(selected, db);
  const limit = Math.min(PAGE_LIMIT, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
  const offset = Math.max(0, Math.min(10_000, Number(url.searchParams.get('offset') ?? 0) || 0));
  const state = url.searchParams.get('state');
  if (state && !/^(SIMULATED|QUEUED|SEND_INTENT_RECORDED|SENDING|SENT|FAILED_RETRYABLE|FAILED_PERMANENT|UNKNOWN_OUTCOME|EXPIRED|SKIPPED)$/u.test(state)) throw new TypeError('Invalid queue state');
  const clauses = [selected ? 'q.account_id=?' : '', state ? 'q.state=?' : ''].filter(Boolean);
  const values = [...(selected ? [selected] : []), ...(state ? [state] : [])];
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const items = db.prepare(`SELECT q.queue_item_id AS id, q.account_id AS accountId, s.username, q.comment_id AS commentId, cm.username AS commentUsername, cm.text AS commentText,
      q.automation_id AS automationId, a.name AS automationName, q.state, q.created_at AS createdAt, q.updated_at AS updatedAt,
      q.attempt_count AS attemptCount, q.dry_run AS dryRun, q.payload_json AS payload,
      q.public_reply_state AS publicReplyState, q.public_reply_text AS publicReplyText, q.public_reply_attempts AS publicReplyAttempts,
      q.public_reply_next_at AS publicReplyNextAt,
      (SELECT safe_error_code FROM public_reply_attempts p WHERE p.account_id=q.account_id AND p.queue_item_id=q.queue_item_id
        AND p.safe_error_code IS NOT NULL ORDER BY p.event_at DESC, p.rowid DESC LIMIT 1) AS publicReplyErrorCode,
      (SELECT reply_id FROM public_reply_attempts p WHERE p.account_id=q.account_id AND p.queue_item_id=q.queue_item_id
        AND p.event_type='accepted' LIMIT 1) AS publicReplyId,
      (SELECT MAX(message_id) FROM send_attempts e WHERE e.account_id=q.account_id AND e.queue_item_id=q.queue_item_id) AS messageId,
      g.state AS gateState, g.gate_sent_at AS gateSentAt, g.tap_at AS gateTapAt, g.window_expires_at AS gateWindowExpiresAt,
      g.next_poll_at AS gateNextPollAt, g.poll_count AS gatePollCount, g.resource_message_id AS gateResourceMessageId,
      g.last_error_code AS gateLastErrorCode, g.button_title AS gateButtonTitle, g.gate_session_id AS gateSessionId,
      g.resource_attachment_kind AS gateAttachmentKind, g.resource_attachment_url AS gateAttachmentUrl,
      CASE WHEN q.state IN ('EXPIRED','SKIPPED') AND q.state_reason_code IS NOT NULL THEN q.state_reason_code
        ELSE (SELECT safe_error_code FROM send_attempts e WHERE e.account_id=q.account_id AND e.queue_item_id=q.queue_item_id ORDER BY event_at DESC LIMIT 1) END AS safeErrorCode
      FROM queue_items q JOIN social_accounts s ON s.account_id=q.account_id LEFT JOIN automations a ON a.automation_id=q.automation_id AND a.account_id=q.account_id
      LEFT JOIN comments cm ON cm.account_id=q.account_id AND cm.comment_id=q.comment_id
      LEFT JOIN gate_sessions g ON g.queue_item_id=q.queue_item_id AND g.account_id=q.account_id
      ${where} ORDER BY q.created_at DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as Array<Record<string, unknown>>;
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM queue_items q ${where}`).get(...values as never[]) as { count: number }).count;
  const partRows = db.prepare(`SELECT part, event_type, safe_error_code FROM gate_part_events WHERE gate_session_id=? AND account_id=? ORDER BY rowid`);
  return { items: items.map(({ payload, commentText, publicReplyState, publicReplyText, publicReplyAttempts, publicReplyNextAt, publicReplyErrorCode, publicReplyId,
    gateState, gateSentAt, gateTapAt, gateWindowExpiresAt, gateNextPollAt, gatePollCount, gateResourceMessageId, gateLastErrorCode, gateButtonTitle,
    gateSessionId, gateAttachmentKind, gateAttachmentUrl, ...row }) => {
    const attachment = gateState ? storedResourceAttachment(gateAttachmentKind, gateAttachmentUrl) : null;
    return {
    ...row,
    // Follow gate session (null without a session; simulated items never have one). The IGSID is never exposed.
    // `attachment` and `parts` exist only for sessions with an attachment, so every other session keeps its DTO.
    followGate: gateState ? {
      state: gateState, buttonTitle: gateButtonTitle ?? null, gateSentAt: gateSentAt ?? null, tapAt: gateTapAt ?? null,
      windowExpiresAt: gateWindowExpiresAt ?? null, nextPollAt: gateNextPollAt ?? null, pollCount: Number(gatePollCount ?? 0),
      resourceMessageId: gateResourceMessageId ?? null, lastErrorCode: gateLastErrorCode ?? null,
      ...(attachment ? { attachment, parts: summarizeParts(partRows.all(String(gateSessionId), String(row.accountId)) as PartRow[]) } : {}),
    } : null, commentText: truncateText(typeof commentText === 'string' ? commentText : ''), payload: safePayload(String(payload)),
    // Public reply DTO: exact text posted (or, for simulated items, the inert WOULD_REPLY_PUBLIC preview).
    publicReply: publicReplyState || publicReplyText ? {
      state: publicReplyState ?? null, text: publicReplyText ?? null, attempts: Number(publicReplyAttempts ?? 0),
      nextAt: publicReplyNextAt ?? null, safeErrorCode: publicReplyErrorCode ?? null, replyId: publicReplyId ?? null,
      preview: !publicReplyState && row.state === 'SIMULATED',
    } : null,
  }; }), total, limit, offset };
}

type PartRow = { part: string; event_type: string; safe_error_code: string | null };
type PartSummary = { state: 'pending' | 'sending' | 'retrying' | 'accepted' | 'skipped' | 'ambiguous' | 'rejected'; safeErrorCode: string | null; attempts: number };

/** Per-part state of an attachment session from its append-only part log (final outcome wins; else the last event). */
function summarizeParts(rows: PartRow[]): { attachment: PartSummary; text: PartSummary } {
  const summary = (part: 'attachment' | 'text'): PartSummary => {
    const own = rows.filter((row) => row.part === part);
    const final = own.find((row) => ['accepted', 'skipped', 'ambiguous'].includes(row.event_type));
    const last = own.at(-1)?.event_type;
    const state: PartSummary['state'] = final ? final.event_type as PartSummary['state']
      : last === 'intent_recorded' ? 'sending' : last === 'rejected' ? 'rejected' : 'pending';
    const code = [...own].reverse().find((row) => row.safe_error_code && SAFE_CODE.test(row.safe_error_code))?.safe_error_code ?? null;
    return { state, safeErrorCode: code, attempts: own.filter((row) => row.event_type === 'intent_recorded').length };
  };
  return { attachment: summary('attachment'), text: summary('text') };
}

function safePayload(value: string): unknown {
  try {
    const parsed = JSON.parse(value) as Json;
    const titles = (list: unknown) => (Array.isArray(list) ? list : []).slice(0, 3)
      .filter((entry): entry is Json => Boolean(entry) && typeof entry === 'object' && typeof (entry as Json).title === 'string')
      .map((entry) => ({ title: String(entry.title).slice(0, 20) }));
    // EXPERIMENTAL interactive buttons: titles only (payload strings stay server-side); absent keys keep the old DTO.
    return { text: typeof parsed.text === 'string' ? parsed.text : '', buttons: Array.isArray(parsed.buttons) ? parsed.buttons : [],
      ...(Array.isArray(parsed.quickReplies) ? { quickReplies: titles(parsed.quickReplies) } : {}),
      ...(Array.isArray(parsed.postbackButtons) ? { postbackButtons: titles(parsed.postbackButtons) } : {}),
      ...safeFollowGateSnapshot(parsed.followGate) };
  }
  catch { return { text: '', buttons: [] }; }
}

const DIAGNOSTICS_MIN_INTERVAL_MS = 20_000;
const SAFE_CODE = /^[a-z][a-z0-9_]{1,63}$/u;

/** Allow-list of the diagnostics conversation DTO (defense in depth over the provider's own sanitizing). */
function safeConversation(value: unknown): Json {
  const source = value && typeof value === 'object' ? value as Json : {};
  const messages = (Array.isArray(source.messages) ? source.messages : []).slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const message = entry as Json;
    if (typeof message.id !== 'string') return [];
    return [{
      id: message.id.slice(0, 256),
      ...(typeof message.createdTime === 'string' ? { createdTime: message.createdTime.slice(0, 40) } : {}),
      direction: ['account', 'user'].includes(String(message.direction)) ? message.direction : 'unknown',
      ...(typeof message.text === 'string' ? { text: Array.from(message.text).slice(0, 80).join('') } : {}),
      keys: (Array.isArray(message.keys) ? message.keys : []).filter((key): key is string => typeof key === 'string' && /^[a-z0-9_]{1,40}$/u.test(key)).slice(0, 30),
      attachmentsShape: ['array', 'data', 'missing', 'other'].includes(String(message.attachmentsShape)) ? message.attachmentsShape : 'other',
      ...(typeof message.safeErrorCode === 'string' && SAFE_CODE.test(message.safeErrorCode) ? { safeErrorCode: message.safeErrorCode } : {}),
    }];
  });
  return { found: source.found === true, messages,
    ...(typeof source.safeErrorCode === 'string' && SAFE_CODE.test(source.safeErrorCode) ? { safeErrorCode: source.safeErrorCode } : {}) };
}

function safeProfile(value: unknown): Json {
  const source = value && typeof value === 'object' ? value as Json : {};
  return { ok: source.ok === true,
    ...(typeof source.isUserFollowBusiness === 'boolean' ? { isUserFollowBusiness: source.isUserFollowBusiness } : {}),
    ...(typeof source.isBusinessFollowUser === 'boolean' ? { isBusinessFollowUser: source.isBusinessFollowUser } : {}),
    ...(typeof source.safeErrorCode === 'string' && SAFE_CODE.test(source.safeErrorCode) ? { safeErrorCode: source.safeErrorCode } : {}),
    ...(typeof source.requestedFields === 'string' && /^[a-z_,]{1,200}$/u.test(source.requestedFields) ? { requestedFields: source.requestedFields } : {}),
    ...(source.hostKind === 'instagram' || source.hostKind === 'facebook' ? { hostKind: source.hostKind } : {}),
    ...safeMetaErrorField(source.metaError) };
}

function safeMetaErrorField(value: unknown): Json {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Json;
  const int = (input: unknown) => typeof input === 'number' && Number.isSafeInteger(input) ? input : undefined;
  const entries: Array<[string, unknown]> = [
    ['httpStatus', int(raw.httpStatus)], ['code', int(raw.code)], ['subcode', int(raw.subcode)],
    ['type', typeof raw.type === 'string' ? raw.type.slice(0, 60) : undefined],
    ['message', typeof raw.message === 'string' ? raw.message.slice(0, 200) : undefined],
    ['fbtraceId', typeof raw.fbtraceId === 'string' ? raw.fbtraceId.slice(0, 40) : undefined],
  ];
  const metaError = Object.fromEntries(entries.filter(([, entry]) => entry !== undefined));
  return Object.keys(metaError).length > 0 ? { metaError } : {};
}

/** Follow gate snapshot of a queue payload: button title and the resource message (text + URL buttons). */
function safeFollowGateSnapshot(value: unknown): Json {
  if (!value || typeof value !== 'object') return {};
  const snapshot = value as Json;
  const resource = snapshot.resource && typeof snapshot.resource === 'object' ? snapshot.resource as Json : {};
  const buttons = (Array.isArray(resource.buttons) ? resource.buttons : []).slice(0, 2)
    .filter((entry): entry is Json => Boolean(entry) && typeof entry === 'object' && typeof (entry as Json).title === 'string' && typeof (entry as Json).url === 'string')
    .map((entry) => ({ title: String(entry.title), url: String(entry.url) }));
  const attachment = snapshot.attachment && typeof snapshot.attachment === 'object'
    ? storedResourceAttachment((snapshot.attachment as Json).kind, (snapshot.attachment as Json).url) : null;
  return { followGate: { buttonTitle: typeof snapshot.buttonTitle === 'string' ? snapshot.buttonTitle.slice(0, 20) : '',
    ...(attachment ? { attachment } : {}), resource: { text: typeof resource.text === 'string' ? resource.text : '', buttons } } };
}

function safeGateDetails(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as Json;
    const allowed = ['httpStatus', 'retryAfter', 'retryAt', 'expired', 'igsidSource', 'usageHeaders', 'part'];
    return Object.fromEntries(allowed.filter((key) => Object.hasOwn(parsed, key)).map((key) => [key, parsed[key]]));
  } catch { return {}; }
}

/** Follow gate request fields passed through untouched: the service validates them strictly and never coerces. */
function followGateFields(body: Json): { followGateEnabled?: boolean; followGateMessage?: string; followGateButtonTitle?: string;
  resourceAttachmentKind?: unknown; resourceAttachmentUrl?: unknown } {
  return { followGateEnabled: body.followGateEnabled as boolean | undefined, followGateMessage: body.followGateMessage as string | undefined,
    followGateButtonTitle: body.followGateButtonTitle as string | undefined,
    resourceAttachmentKind: body.resourceAttachmentKind, resourceAttachmentUrl: body.resourceAttachmentUrl };
}

function safeAttemptDetails(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as Json;
    const allowed = ['httpStatus', 'observed', 'observedMatches', 'matchReason', 'recipientId', 'retryAfter', 'automation_version', 'usageHeaders'];
    return Object.fromEntries(allowed.filter((key) => Object.hasOwn(parsed, key)).map((key) => [key, parsed[key]]));
  } catch { return {}; }
}

function archiveAutomation(db: DatabaseSync, account: string, id: string): void {
  const result = db.prepare(`UPDATE automations SET status='disabled', real_enabled=0, monitoring_started_at=NULL,
    name=name || ' (archived)', version=version+1, updated_at=? WHERE account_id=? AND automation_id=?`).run(new Date().toISOString(), account, id);
  if (Number(result.changes) !== 1) throw new ApiError(404, 'automation_not_found');
}

function accountFilter(url: URL): string | undefined { const value = url.searchParams.get('accountId'); return value && value !== 'all' ? value : undefined; }
function accountId(value: unknown, db: DatabaseSync): string {
  const id = text(value);
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) throw new TypeError('Invalid account ID');
  const found = db.prepare(`SELECT account_id FROM social_accounts WHERE account_id=?`).get(id);
  if (!found) throw new ApiError(404, 'account_not_found');
  return id;
}
function accountRef(db: DatabaseSync, id: string): AccountRef {
  const row = db.prepare(`SELECT account_id AS accountId, connection_id AS connectionId, provider_account_id AS providerAccountId, username FROM social_accounts WHERE account_id=? AND status='valid'`).get(id) as AccountRef | undefined;
  if (!row) throw new ApiError(409, 'account_not_validated');
  return row;
}
function allAccountRefs(db: DatabaseSync): AccountRef[] {
  return db.prepare(`SELECT s.account_id AS accountId, s.connection_id AS connectionId, s.provider_account_id AS providerAccountId, s.username
    FROM social_accounts s JOIN connections c ON c.id=s.connection_id WHERE s.status='valid' AND c.status='valid' AND c.deleted_at IS NULL ORDER BY s.account_id`).all() as AccountRef[];
}
async function readJson(request: IncomingMessage): Promise<Json> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'json_required');
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > BODY_LIMIT) throw new ApiError(413, 'body_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new ApiError(413, 'body_too_large');
    chunks.push(buffer);
  }
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'invalid_json'); }
  return object(decoded);
}
function send(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}
function requireService<T>(service: T | undefined, name: string): T { if (!service) throw new ApiError(503, `${name}_unavailable`); return service; }
function object(value: unknown): Json { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object'); return value as Json; }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 5000) throw new TypeError('Expected bounded text'); return value.trim(); }
function optionalText(value: unknown): string | undefined { if (value === undefined || value === null || value === '') return undefined; return text(value); }
function id(value: unknown): string { return text(value); }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new TypeError('Expected a boolean'); return value; }
function stringList(value: unknown, maximum: number): string[] { if (!Array.isArray(value) || value.length > maximum) throw new TypeError('Expected a bounded list'); return value.map(text); }
function matchMode(value: unknown, allowOmitted: boolean): 'exact' | 'contains' {
  if (value === undefined && allowOmitted) return 'contains';
  if (value !== 'exact' && value !== 'contains') throw new TypeError('Invalid match mode');
  return value;
}
function automationScope(value: unknown, defaultMedia: boolean): 'media' | 'account' | undefined {
  if (value === undefined) return defaultMedia ? 'media' : undefined;
  if (value !== 'media' && value !== 'account') throw new TypeError('Invalid automation scope');
  return value;
}
function buttons(value: unknown): Array<{ title: string; url: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) throw new TypeError('Expected at most two buttons');
  return value.map((item) => { const parsed = object(item); return { title: text(parsed.title), url: text(parsed.url) }; });
}
function loginKind(value: unknown): 'instagram_login' | 'facebook_login' { if (value !== 'instagram_login' && value !== 'facebook_login') throw new TypeError('Invalid login kind'); return value; }
