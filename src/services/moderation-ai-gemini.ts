import { ModerationAiError, type ModerationAiEngine } from './moderation-ai-engine.ts';
import { SYSTEM_INSTRUCTION, buildUserPrompt, responseSchema } from './moderation-ai-prompt.ts';

/**
 * Gemini API client for the AI comment review (generateContent, v1beta). The host is fixed; the model id comes from a
 * strict allowlist; the key travels only in the `x-goog-api-key` header (never in the URL) and never appears in any
 * error: every failure becomes a ModerationAiError with a safe code.
 */
export const GEMINI_ENDPOINT_ORIGIN = 'https://generativelanguage.googleapis.com';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash-lite';
/** Free-tier Flash / Flash-Lite models offered in the UI. */
export const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'] as const;
export const GEMINI_MODEL_PATTERN = /^gemini-[0-9a-z.-]+$/u;
export const GEMINI_TIMEOUT_MS = 20_000;
export const GEMINI_MAX_RETRY_DELAY_MS = 60_000;
export const GEMINI_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RATE_LIMIT_DELAY_MS = 15_000;
const UNAVAILABLE_RETRY_DELAY_MS = 2_000;
const RESPONSE_LIMIT_BYTES = 256 * 1024;

export function isAllowedGeminiModel(model: unknown): model is string {
  return typeof model === 'string' && GEMINI_MODEL_PATTERN.test(model) && (GEMINI_MODELS as readonly string[]).includes(model);
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export type GeminiEngineOptions = {
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
  sleep?: Sleep;
  timeoutMs?: number;
};

const defaultSleep: Sleep = (ms, signal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

class Attempt {
  constructor(readonly kind: 'rate_limited' | 'unavailable', readonly retryDelayMs = 0) {}
}

export function createGeminiEngine(options: GeminiEngineOptions): ModerationAiEngine {
  if (!isAllowedGeminiModel(options.model)) throw new TypeError('ai_model_invalid');
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const url = `${GEMINI_ENDPOINT_ORIGIN}/v1beta/models/${options.model}:generateContent`;
  const apiKey = options.apiKey;

  async function once(batch: Record<string, string>, signal?: AbortSignal): Promise<Record<string, string> | Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let response: Response;
    let raw: string;
    try {
      response = await fetcher(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(requestBody(batch)),
      });
      raw = await readBounded(response, RESPONSE_LIMIT_BYTES);
    } catch (error) {
      if (error instanceof ModerationAiError) throw error;
      // Network failure, redirect or timeout: the provider's message (which could echo the URL) is discarded.
      return new Attempt('unavailable', UNAVAILABLE_RETRY_DELAY_MS);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (response.status === 429) return new Attempt('rate_limited', retryDelay(raw, response.headers));
    if (response.status === 401 || response.status === 403) throw new ModerationAiError('ai_auth_failed');
    if (response.status === 400) throw new ModerationAiError(isKeyInvalid(raw) ? 'ai_auth_failed' : 'ai_request_rejected');
    if (response.status >= 500) return new Attempt('unavailable', UNAVAILABLE_RETRY_DELAY_MS);
    if (!response.ok) throw new ModerationAiError('ai_request_rejected');
    return parseOutput(raw);
  }

  return {
    async classify(batch, signal) {
      let rateLimitRetries = 0;
      let unavailableRetries = 0;
      for (;;) {
        const result = await once(batch, signal);
        if (!(result instanceof Attempt)) return result;
        if (signal?.aborted) throw new ModerationAiError('ai_unavailable');
        if (result.kind === 'rate_limited') {
          if (rateLimitRetries >= GEMINI_RATE_LIMIT_RETRIES) throw new ModerationAiError('ai_rate_limited');
          rateLimitRetries++;
        } else {
          if (unavailableRetries >= 1) throw new ModerationAiError('ai_unavailable');
          unavailableRetries++;
        }
        await sleep(result.retryDelayMs, signal);
        if (signal?.aborted) throw new ModerationAiError('ai_unavailable');
      }
    },
  };
}

function requestBody(batch: Record<string, string>) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: buildUserPrompt(batch) }] }],
    // Insults and hate are exactly what is being classified: the default filters would block the answer.
    safetySettings: ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
      .map((category) => ({ category, threshold: 'BLOCK_NONE' })),
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: responseSchema(Object.keys(batch)),
      temperature: 0,
    },
  };
}

/** Google answers an invalid key with 400 INVALID_ARGUMENT + google.rpc.ErrorInfo reason API_KEY_INVALID. */
function isKeyInvalid(raw: string): boolean {
  try {
    const details = (JSON.parse(raw) as { error?: { details?: unknown } })?.error?.details;
    return Array.isArray(details) && details.some((detail) => (detail as { reason?: unknown })?.reason === 'API_KEY_INVALID');
  } catch {
    return false;
  }
}

/** Delay for a 429: google.rpc.RetryInfo.retryDelay ("13s", "1.5s"), else the retry-after header, else a default. */
function retryDelay(raw: string, headers: Headers): number {
  let delay: number | undefined;
  try {
    const details = (JSON.parse(raw) as { error?: { details?: unknown } })?.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        const value = (detail as { retryDelay?: unknown })?.retryDelay;
        const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)s$/u.exec(value) : null;
        if (match) { delay = Math.round(Number(match[1]) * 1000); break; }
      }
    }
  } catch { /* not JSON: fall back to the header */ }
  if (delay === undefined) {
    const header = headers.get('retry-after');
    if (header && /^\d+$/u.test(header.trim())) delay = Number(header.trim()) * 1000;
  }
  return Math.min(GEMINI_MAX_RETRY_DELAY_MS, Math.max(0, delay ?? DEFAULT_RATE_LIMIT_DELAY_MS));
}

function parseOutput(raw: string): Record<string, string> {
  let decoded: any;
  try { decoded = JSON.parse(raw); } catch { throw new ModerationAiError('ai_invalid_output'); }
  const parts = decoded?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new ModerationAiError('ai_invalid_output');
  const text = parts.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join('');
  let output: unknown;
  try { output = JSON.parse(text); } catch { throw new ModerationAiError('ai_invalid_output'); }
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new ModerationAiError('ai_invalid_output');
  return output as Record<string, string>;
}

async function readBounded(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new ModerationAiError('ai_invalid_output');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
