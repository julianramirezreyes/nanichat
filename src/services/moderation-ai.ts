import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { CredentialVault } from '../security/vault.ts';
import { normalizeMatchText } from './automations.ts';
import { commentTimeSql } from './moderation.ts';
import { ModerationAiError, sanitizeAiResult, type ModerationAiEngine } from './moderation-ai-engine.ts';
import { GEMINI_DEFAULT_MODEL, GEMINI_MODELS, createGeminiEngine, isAllowedGeminiModel } from './moderation-ai-gemini.ts';
import type { AiFlagCategory } from './moderation-ai-prompt.ts';

/**
 * AI comment review (moderation PR 2). The operator starts a batch job; the job sends the account's unflagged comments
 * in chunks to the configured engine and turns every non-neutral answer into a PENDING flag with source 'ai'. It only
 * creates flags: it never calls Meta (hiding/deleting stays with the PR 1 tools). AI is off by default.
 */
export const AI_CHUNK_SIZE = 40;
export const AI_MAX_COMMENTS = 2000;
export const AI_TEXT_LIMIT = 500;
/** Minimum spacing between two chunk requests (free-tier friendly). */
export const AI_CHUNK_SPACING_MS = 4000;
export const AI_WINDOWS = ['24h', '3d', '7d', '30d'] as const;
export type AiWindow = typeof AI_WINDOWS[number];
export type AiEngineName = 'off' | 'gemini' | 'local';
export const AI_TEST_COMMENT = 'Gracias por la info!';

const WINDOW_MS: Record<AiWindow, number> = { '24h': 86_400_000, '3d': 3 * 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{20,128}$/u;

/** Spanish label stored in reasons_json as `IA: <label>` (kept in sync with app/moderation-labels.ts). */
export const AI_REASON_LABELS: Record<AiFlagCategory, string> = {
  ai_insult: 'Insulto o acoso',
  ai_hate: 'Odio o discriminación',
  ai_spam: 'Spam o estafa',
  ai_complaint: 'Queja legítima',
};

export function aiKeyContextId(accountId: string): string {
  return `moderation-ai:gemini:${accountId}`;
}

export class ModerationAiServiceError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'ModerationAiServiceError';
  }
}

export type AiSettingsDto = {
  engine: AiEngineName;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  consentAt: string | null;
  availableModels: string[];
};

export type AiProgress = {
  chunksDone: number; chunksTotal: number; commentsSent: number; flagged: number; invalidOutput: number;
  chunksFailed: number; commentsTotal: number; truncated: boolean;
};

export type AiJobDto = {
  jobId: string;
  state: 'running' | 'completed' | 'failed' | 'stopped';
  window: AiWindow;
  progress: AiProgress;
  errorCode?: string;
  startedAt: string;
  finishedAt?: string;
};

export type EngineConfig = { engine: 'gemini'; model: string; apiKey: string };

export type ModerationAiOptions = {
  engineFactory?: (config: EngineConfig) => ModerationAiEngine;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

type SettingsRow = {
  engine: AiEngineName; model: string | null; api_key_nonce: string | null; api_key_ciphertext: string | null;
  api_key_tag: string | null; api_key_hint: string | null; consent_at: string | null;
};

type Running = { jobId: string; controller: AbortController; done: Promise<void> };

const STOP_JOB_CODES = new Set(['ai_rate_limited', 'ai_auth_failed', 'ai_request_rejected']);

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export class ModerationAiService {
  private readonly running = new Map<string, Running>();
  private readonly engineFactory: (config: EngineConfig) => ModerationAiEngine;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly database: DatabaseSync,
    private readonly vault: CredentialVault,
    options: ModerationAiOptions = {},
  ) {
    this.engineFactory = options.engineFactory ?? ((config) => createGeminiEngine({ apiKey: config.apiKey, model: config.model }));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  // ---------- Settings ----------

  private row(accountId: string): SettingsRow | undefined {
    return this.database.prepare(`SELECT engine, model, api_key_nonce, api_key_ciphertext, api_key_tag, api_key_hint, consent_at
      FROM moderation_ai_settings WHERE account_id=?`).get(accountId) as SettingsRow | undefined;
  }

  getSettings(accountId: string): AiSettingsDto {
    const row = this.row(accountId);
    return {
      engine: row?.engine ?? 'off',
      model: row?.model && isAllowedGeminiModel(row.model) ? row.model : GEMINI_DEFAULT_MODEL,
      hasApiKey: Boolean(row?.api_key_ciphertext),
      apiKeyHint: row?.api_key_ciphertext ? row.api_key_hint : null,
      consentAt: row?.consent_at ?? null,
      availableModels: [...GEMINI_MODELS],
    };
  }

  /**
   * engine: 'off' | 'gemini' ('local' is reserved: 409 ai_engine_unavailable). model: optional, allowlisted.
   * apiKey: write-only; omitted keeps the stored key, '' clears it. Switching to Gemini needs confirmed === true while
   * no consent was recorded (the privacy disclosure); the consent time is then stored.
   */
  updateSettings(accountId: string, input: { engine: unknown; model?: unknown; apiKey?: unknown; confirmed?: unknown }): AiSettingsDto {
    const engine = input.engine;
    if (engine === 'local') throw new ModerationAiServiceError(409, 'ai_engine_unavailable');
    if (engine !== 'off' && engine !== 'gemini') throw new ModerationAiServiceError(400, 'invalid_request');
    if (input.model !== undefined && !isAllowedGeminiModel(input.model)) throw new ModerationAiServiceError(400, 'ai_model_invalid');
    if (input.apiKey !== undefined && input.apiKey !== '' && (typeof input.apiKey !== 'string' || !API_KEY_PATTERN.test(input.apiKey))) {
      throw new ModerationAiServiceError(400, 'ai_key_invalid');
    }
    const previous = this.row(accountId);
    const nowIso = new Date(this.now()).toISOString();
    let consentAt = previous?.consent_at ?? null;
    if (engine === 'gemini' && !consentAt) {
      if (input.confirmed !== true) throw new Error('confirmation_required');
      consentAt = nowIso;
    }
    // Turning the AI off or removing the key stops a running review first (same path as stop: the in-flight request
    // is aborted and the job ends 'stopped' before its next chunk).
    if (engine === 'off' || input.apiKey === '') this.running.get(accountId)?.controller.abort();
    let secret = previous?.api_key_ciphertext
      ? { nonce: previous.api_key_nonce, ciphertext: previous.api_key_ciphertext, tag: previous.api_key_tag, hint: previous.api_key_hint }
      : { nonce: null, ciphertext: null, tag: null, hint: null };
    if (input.apiKey === '') secret = { nonce: null, ciphertext: null, tag: null, hint: null };
    else if (typeof input.apiKey === 'string') {
      const encrypted = this.vault.encrypt(aiKeyContextId(accountId), input.apiKey);
      secret = { ...encrypted, hint: `…${input.apiKey.slice(-4)}` };
    }
    const model = typeof input.model === 'string' ? input.model : previous?.model ?? GEMINI_DEFAULT_MODEL;
    this.database.prepare(`
      INSERT INTO moderation_ai_settings (account_id, engine, model, api_key_nonce, api_key_ciphertext, api_key_tag, api_key_hint, consent_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET engine=excluded.engine, model=excluded.model, api_key_nonce=excluded.api_key_nonce,
        api_key_ciphertext=excluded.api_key_ciphertext, api_key_tag=excluded.api_key_tag, api_key_hint=excluded.api_key_hint,
        consent_at=excluded.consent_at, updated_at=excluded.updated_at
    `).run(accountId, engine, model, secret.nonce, secret.ciphertext, secret.tag, secret.hint, consentAt, nowIso);
    return this.getSettings(accountId);
  }

  private engineConfig(accountId: string): EngineConfig {
    const row = this.row(accountId);
    if (!row?.api_key_ciphertext || !row.api_key_nonce || !row.api_key_tag) throw new ModerationAiServiceError(409, 'ai_key_missing');
    const apiKey = this.vault.decrypt(aiKeyContextId(accountId), { nonce: row.api_key_nonce, ciphertext: row.api_key_ciphertext, tag: row.api_key_tag });
    return { engine: 'gemini', model: row.model && isAllowedGeminiModel(row.model) ? row.model : GEMINI_DEFAULT_MODEL, apiKey };
  }

  /** Sends ONE tiny synthetic comment with the stored key. Only safe error codes come back. */
  async testKey(accountId: string): Promise<{ ok: true } | { ok: false; errorCode: string }> {
    const settings = this.getSettings(accountId);
    if (settings.engine !== 'gemini' || !settings.consentAt) throw new ModerationAiServiceError(409, 'ai_disabled');
    const config = this.engineConfig(accountId);
    try {
      const raw = await this.engineFactory(config).classify({ c1: AI_TEST_COMMENT });
      const { categories } = sanitizeAiResult(['c1'], raw);
      return categories.c1 ? { ok: true } : { ok: false, errorCode: 'ai_invalid_output' };
    } catch (error) {
      return { ok: false, errorCode: error instanceof ModerationAiError ? error.code : 'ai_unavailable' };
    }
  }

  // ---------- Job ----------

  /**
   * Comments in scope: own account, inside the window, not owner-authored, with text, and without any flag. Newest
   * first. Window, flag exclusion and order run in SQL and rows are streamed (iterate), so only the first
   * AI_MAX_COMMENTS are kept in memory; the owner check (accent-insensitive) runs on the stream.
   */
  private scope(accountId: string, window: AiWindow): { items: Array<{ commentId: string; mediaId: string; text: string }>; total: number } {
    const owner = this.database.prepare(`SELECT username FROM social_accounts WHERE account_id=?`).get(accountId) as { username: string } | undefined;
    const ownerName = normalizeMatchText(owner?.username ?? '');
    const cutoff = new Date(this.now() - WINDOW_MS[window]).toISOString();
    const time = commentTimeSql('c.created_at');
    const rows = this.database.prepare(`
      SELECT c.comment_id, c.media_id, substr(c.text, 1, ${AI_TEXT_LIMIT}) AS text, c.username FROM comments c
      WHERE c.account_id = ? AND c.text IS NOT NULL AND TRIM(c.text) <> ''
        AND ${time} >= julianday(?)
        AND NOT EXISTS (SELECT 1 FROM moderation_flags f WHERE f.account_id = c.account_id AND f.comment_id = c.comment_id)
      ORDER BY ${time} DESC, c.comment_id ASC
    `).iterate(accountId, cutoff) as Iterable<{ comment_id: string; media_id: string; text: string; username: string | null }>;
    const items: Array<{ commentId: string; mediaId: string; text: string }> = [];
    let total = 0;
    for (const row of rows) {
      if (ownerName && row.username && normalizeMatchText(row.username) === ownerName) continue;
      total++;
      if (items.length < AI_MAX_COMMENTS) items.push({ commentId: row.comment_id, mediaId: row.media_id, text: row.text });
    }
    return { total, items };
  }

  start(accountId: string, window: unknown): { jobId: string } {
    if (typeof window !== 'string' || !(AI_WINDOWS as readonly string[]).includes(window)) throw new ModerationAiServiceError(400, 'invalid_request');
    const settings = this.getSettings(accountId);
    if (settings.engine === 'off') throw new ModerationAiServiceError(409, 'ai_disabled');
    if (settings.engine !== 'gemini') throw new ModerationAiServiceError(409, 'ai_engine_unavailable');
    if (this.running.has(accountId)) throw new ModerationAiServiceError(409, 'ai_job_running');
    const config = this.engineConfig(accountId);
    const engine = this.engineFactory(config);
    const { items, total } = this.scope(accountId, window as AiWindow);
    const chunks: typeof items[] = [];
    for (let index = 0; index < items.length; index += AI_CHUNK_SIZE) chunks.push(items.slice(index, index + AI_CHUNK_SIZE));
    const jobId = randomUUID();
    try {
      this.database.prepare(`INSERT INTO moderation_ai_jobs (job_id, account_id, state, review_window, chunks_total, comments_total, truncated, started_at)
        VALUES (?, ?, 'running', ?, ?, ?, ?, ?)`).run(jobId, accountId, window, chunks.length, total, total > items.length ? 1 : 0, new Date(this.now()).toISOString());
    } catch {
      // The partial unique index allows one running job per account.
      throw new ModerationAiServiceError(409, 'ai_job_running');
    }
    const controller = new AbortController();
    const done = this.run(jobId, accountId, engine, chunks, controller.signal)
      .catch(() => this.finish(jobId, 'failed', 'ai_engine_error'))
      .finally(() => { this.running.delete(accountId); });
    this.running.set(accountId, { jobId, controller, done });
    return { jobId };
  }

  private async run(jobId: string, accountId: string, engine: ModerationAiEngine,
    chunks: Array<Array<{ commentId: string; mediaId: string; text: string }>>, signal: AbortSignal): Promise<void> {
    const progress = { chunksDone: 0, chunksFailed: 0, commentsSent: 0, flagged: 0, invalidOutput: 0 };
    const save = () => this.database.prepare(`UPDATE moderation_ai_jobs SET chunks_done=?, chunks_failed=?, comments_sent=?, flagged=?, invalid_output=?
      WHERE job_id=?`).run(progress.chunksDone, progress.chunksFailed, progress.commentsSent, progress.flagged, progress.invalidOutput, jobId);
    const insert = this.database.prepare(`INSERT OR IGNORE INTO moderation_flags
      (flag_id, account_id, media_id, comment_id, category, source, reasons_json, state, created_at, updated_at, settings_version)
      VALUES (?, ?, ?, ?, ?, 'ai', ?, 'PENDING', ?, ?, NULL)`);
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) await this.sleep(AI_CHUNK_SPACING_MS, signal);
      if (signal.aborted) return this.finish(jobId, 'stopped');
      // Chunk-local aliases: the model never sees (nor has to copy) Meta comment ids.
      const byAlias = new Map(chunk.map((item, position) => [`c${position + 1}`, item]));
      const batch = Object.fromEntries([...byAlias].map(([alias, item]) => [alias, item.text]));
      progress.commentsSent += chunk.length;
      try {
        const { categories, invalid } = sanitizeAiResult([...byAlias.keys()], await engine.classify(batch, signal));
        progress.invalidOutput += invalid;
        const nowIso = new Date(this.now()).toISOString();
        for (const [alias, category] of Object.entries(categories)) {
          if (category === 'neutral') continue;
          const item = byAlias.get(alias)!;
          const result = insert.run(randomUUID(), accountId, item.mediaId, item.commentId, category,
            JSON.stringify([`IA: ${AI_REASON_LABELS[category]}`]), nowIso, nowIso);
          progress.flagged += Number(result.changes);
        }
      } catch (error) {
        const code = error instanceof ModerationAiError ? error.code : 'ai_engine_error';
        if (code === 'ai_invalid_output') progress.invalidOutput += chunk.length;
        else if (code === 'ai_unavailable') progress.chunksFailed++;
        else {
          progress.chunksDone++;
          save();
          return this.finish(jobId, 'failed', STOP_JOB_CODES.has(code) ? code : 'ai_engine_error');
        }
      }
      progress.chunksDone++;
      save();
    }
    this.finish(jobId, signal.aborted ? 'stopped' : 'completed');
  }

  private finish(jobId: string, state: 'completed' | 'failed' | 'stopped', errorCode?: string): void {
    this.database.prepare(`UPDATE moderation_ai_jobs SET state=?, error_code=?, finished_at=? WHERE job_id=? AND state='running'`)
      .run(state, errorCode ?? null, new Date(this.now()).toISOString(), jobId);
  }

  status(accountId: string): AiJobDto | { state: 'idle' } {
    const row = this.database.prepare(`SELECT * FROM moderation_ai_jobs WHERE account_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(accountId) as any;
    if (!row) return { state: 'idle' };
    return {
      jobId: row.job_id,
      state: row.state,
      window: row.review_window,
      progress: {
        chunksDone: row.chunks_done, chunksTotal: row.chunks_total, commentsSent: row.comments_sent, flagged: row.flagged,
        invalidOutput: row.invalid_output, chunksFailed: row.chunks_failed, commentsTotal: row.comments_total, truncated: row.truncated === 1,
      },
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      startedAt: row.started_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    };
  }

  /** Requests the stop; the job ends as 'stopped' before its next chunk (an in-flight request is aborted). */
  stop(accountId: string): AiJobDto | { state: 'idle' } {
    const running = this.running.get(accountId);
    if (!running) throw new ModerationAiServiceError(409, 'ai_job_not_running');
    running.controller.abort();
    return this.status(accountId);
  }

  /** Resolves when the account has no running job (used by tests and shutdown). */
  async waitForIdle(accountId: string): Promise<void> {
    await this.running.get(accountId)?.done;
  }

  /** Boot: a job cannot survive a restart; running rows become 'stopped' (ai_interrupted). */
  recoverInterrupted(): void {
    this.database.prepare(`UPDATE moderation_ai_jobs SET state='stopped', error_code='ai_interrupted', finished_at=? WHERE state='running'`)
      .run(new Date(this.now()).toISOString());
  }
}
