import { AI_CATEGORIES, type AiCategory } from './moderation-ai-prompt.ts';

/**
 * Safe error codes of an AI engine. They never carry provider text:
 * - ai_rate_limited: quota/rate limit still hit after the allowed retries (the job stops).
 * - ai_auth_failed: invalid key or no permission (401/403, or 400 with reason API_KEY_INVALID; the job stops, no retry).
 * - ai_request_rejected: any other 4xx, including other 400s (for example an unknown model; the job stops, no retry).
 * - ai_unavailable: 5xx, timeout or network failure after one retry (the chunk fails, the job continues).
 * - ai_invalid_output: the answer is not a JSON object (the chunk's entries count as invalid output).
 * - ai_local_unavailable: the local runtime or model could not be loaded (native binary, missing or broken file, memory;
 *   the job stops). The reason goes to the server log, redacted.
 */
export type ModerationAiErrorCode = 'ai_rate_limited' | 'ai_auth_failed' | 'ai_request_rejected' | 'ai_unavailable' | 'ai_invalid_output'
  | 'ai_local_unavailable';

export class ModerationAiError extends Error {
  constructor(readonly code: ModerationAiErrorCode) {
    super(code);
    this.name = 'ModerationAiError';
  }
}

/**
 * An AI engine classifies one chunk: `{ "<key>": "<comment text>" }` → `{ "<key>": "<category>" }`.
 * The answer is untrusted; callers run it through sanitizeAiResult.
 *
 * `chunkSize` (comments per request, default AI_CHUNK_SIZE) and `spacingMs` (pause between two chunks, default 0) are
 * engine properties: Gemini spaces its requests for the free tier, the local model does not need to.
 */
export interface ModerationAiEngine {
  readonly chunkSize?: number;
  readonly spacingMs?: number;
  classify(batch: Record<string, string>, signal?: AbortSignal): Promise<Record<string, string>>;
}

const KNOWN = new Set<string>(AI_CATEGORIES);

/**
 * Keeps only entries whose key belongs to the chunk and whose value is a known category. Everything else (unknown ids,
 * unknown categories, non-string values) is ignored and counted as invalid output: a flag is never invented.
 */
export function sanitizeAiResult(keys: readonly string[], raw: Record<string, unknown>): { categories: Record<string, AiCategory>; invalid: number } {
  const allowed = new Set(keys);
  const categories: Record<string, AiCategory> = Object.create(null);
  let invalid = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (allowed.has(key) && typeof value === 'string' && KNOWN.has(value)) categories[key] = value as AiCategory;
    else invalid++;
  }
  return { categories: { ...categories }, invalid };
}
