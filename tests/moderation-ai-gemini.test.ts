import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiEngine, GEMINI_ENDPOINT_ORIGIN, GEMINI_MAX_RETRY_DELAY_MS } from '../src/services/moderation-ai-gemini.ts';
import { ModerationAiError } from '../src/services/moderation-ai-engine.ts';
import { SYSTEM_INSTRUCTION } from '../src/services/moderation-ai-prompt.ts';

const KEY = 'AIzaFAKE_test_key_0123456789abcdefXYZ';

type Call = { url: string; init: RequestInit };

function json(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function ok(result: Record<string, string>): Response {
  return json(200, { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(result) }] }, finishReason: 'STOP' }] });
}

function rateLimited(retryDelay?: string): Response {
  return json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota',
    details: retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : [] } });
}

function fakeFetch(responses: Array<Response | (() => Response | Promise<Response>) | Error>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra call');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { calls, fetcher };
}

function engine(responses: Parameters<typeof fakeFetch>[0], extra: { timeoutMs?: number; model?: string } = {}) {
  const fake = fakeFetch(responses);
  const sleeps: number[] = [];
  const instance = createGeminiEngine({ apiKey: KEY, model: extra.model ?? 'gemini-2.5-flash-lite', fetcher: fake.fetcher,
    sleep: async (ms) => { sleeps.push(ms); }, ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}) });
  return { instance, calls: fake.calls, sleeps };
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<ModerationAiError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ModerationAiError, `expected ModerationAiError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected rejection with ${code}`);
}

test('Gemini: POSTs to the fixed host with the key in x-goog-api-key, JSON schema, temperature 0 and the batch as JSON', async () => {
  const { instance, calls } = engine([ok({ c1: 'ai_insult', c2: 'neutral' })]);
  const result = await instance.classify({ c1: 'eres un idiota', c2: 'hola "amigo"' });
  assert.deepEqual(result, { c1: 'ai_insult', c2: 'neutral' });
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, `${GEMINI_ENDPOINT_ORIGIN}/v1beta/models/gemini-2.5-flash-lite:generateContent`);
  assert.equal(GEMINI_ENDPOINT_ORIGIN, 'https://generativelanguage.googleapis.com');
  assert.ok(!call.url.includes(KEY), 'the key never travels in the URL');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'error');
  assert.ok(call.init.signal, 'request has an abort signal (timeout)');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers['x-goog-api-key'], KEY);
  assert.equal(headers['content-type'], 'application/json');
  const body = JSON.parse(String(call.init.body));
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.temperature, 0);
  assert.deepEqual(Object.keys(body.generationConfig.responseSchema.properties), ['c1', 'c2']);
  assert.equal(body.systemInstruction.parts[0].text, SYSTEM_INSTRUCTION);
  const userText: string = body.contents[0].parts[0].text;
  assert.equal(body.contents[0].role, 'user');
  assert.deepEqual(JSON.parse(userText.slice(userText.indexOf('{'))), { c1: 'eres un idiota', c2: 'hola "amigo"' });
  assert.ok(Array.isArray(body.safetySettings) && body.safetySettings.every((s: any) => s.threshold === 'BLOCK_NONE'));
});

test('Gemini: only allowlisted model ids matching the strict regex are accepted', () => {
  for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
    assert.doesNotThrow(() => createGeminiEngine({ apiKey: KEY, model, fetcher: fakeFetch([]).fetcher }));
  }
  for (const model of ['gemini-2.5-pro', '../models/x', 'gemini-2.5-flash?key=1', 'GEMINI-2.5-FLASH', '']) {
    assert.throws(() => createGeminiEngine({ apiKey: KEY, model, fetcher: fakeFetch([]).fetcher }), /ai_model_invalid/);
  }
});

test('Gemini: 429 honors retryDelay and retries up to 3 times, then succeeds', async () => {
  const { instance, calls, sleeps } = engine([rateLimited('7s'), rateLimited('1.5s'), ok({ c1: 'neutral' })]);
  assert.deepEqual(await instance.classify({ c1: 'hola' }), { c1: 'neutral' });
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [7000, 1500]);
});

test('Gemini: 429 retryDelay is capped and after 3 retries the call fails with ai_rate_limited', async () => {
  const { instance, calls, sleeps } = engine([rateLimited('120s'), rateLimited('120s'), rateLimited('120s'), rateLimited('120s')]);
  await rejectsWith(instance.classify({ c1: 'hola' }), 'ai_rate_limited');
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [GEMINI_MAX_RETRY_DELAY_MS, GEMINI_MAX_RETRY_DELAY_MS, GEMINI_MAX_RETRY_DELAY_MS]);
  assert.equal(GEMINI_MAX_RETRY_DELAY_MS, 60_000);
});

test('Gemini: 429 without RetryInfo uses retry-after, else a bounded default', async () => {
  const { instance, sleeps } = engine([
    new Response('{}', { status: 429, headers: { 'retry-after': '5' } }),
    rateLimited(),
    ok({ c1: 'neutral' }),
  ]);
  await instance.classify({ c1: 'hola' });
  assert.equal(sleeps[0], 5000);
  assert.ok(sleeps[1]! > 0 && sleeps[1]! <= GEMINI_MAX_RETRY_DELAY_MS);
});

const keyInvalid = (status: number) => json(status, { error: { code: status, message: `API key not valid: ${KEY}`, status: 'INVALID_ARGUMENT',
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } });
for (const status of [400, 401, 403]) {
  test(`Gemini: ${status} (key/permission) stops with ai_auth_failed and is never retried`, async () => {
    const { instance, calls, sleeps } = engine([status === 400 ? keyInvalid(400) : json(status, { error: { code: status, message: `denied ${KEY}`, status: 'PERMISSION_DENIED' } })]);
    const error = await rejectsWith(instance.classify({ c1: 'hola' }), 'ai_auth_failed');
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.ok(!error.message.includes(KEY) && !String(error.stack).includes(KEY) && !JSON.stringify(error).includes(KEY));
  });
}

test('Gemini: a 5xx is retried once and then succeeds', async () => {
  const { instance, calls } = engine([json(503, { error: { code: 503 } }), ok({ c1: 'ai_spam' })]);
  assert.deepEqual(await instance.classify({ c1: 'gana dinero' }), { c1: 'ai_spam' });
  assert.equal(calls.length, 2);
});

test('Gemini: two 5xx, network errors or timeouts end in ai_unavailable after exactly one retry', async () => {
  const fiveXX = engine([json(500, {}), json(502, {})]);
  await rejectsWith(fiveXX.instance.classify({ c1: 'x' }), 'ai_unavailable');
  assert.equal(fiveXX.calls.length, 2);

  const network = engine([new TypeError(`fetch failed for key=${KEY}`), new TypeError('fetch failed')]);
  const error = await rejectsWith(network.instance.classify({ c1: 'x' }), 'ai_unavailable');
  assert.equal(network.calls.length, 2);
  assert.ok(!error.message.includes(KEY) && !String(error.stack).includes(KEY));

  const hang = (call: number) => () => new Promise<Response>((_resolve, reject) => {
    const signal = timeout.calls[call]!.init.signal!;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const timeout = engine([() => hang(0)(), () => hang(1)()], { timeoutMs: 5 });
  await rejectsWith(timeout.instance.classify({ c1: 'x' }), 'ai_unavailable');
  assert.equal(timeout.calls.length, 2);
});

test('Gemini: malformed, blocked, non-object or oversized output fails with ai_invalid_output (never retried)', async () => {
  const cases: Response[] = [
    json(200, { candidates: [{ content: { parts: [{ text: 'not json at all' }] } }] }),
    json(200, { promptFeedback: { blockReason: 'SAFETY' } }),
    json(200, { candidates: [{ content: { parts: [{ text: '["ai_insult"]' }] } }] }),
    new Response('x'.repeat(300 * 1024), { status: 200 }),
    new Response('<html>', { status: 200 }),
  ];
  for (const response of cases) {
    const { instance, calls } = engine([response]);
    await rejectsWith(instance.classify({ c1: 'x' }), 'ai_invalid_output');
    assert.equal(calls.length, 1);
  }
});

test('sanitizeAiResult: unknown ids, unknown categories and non-string values are ignored and counted as invalid output', async () => {
  const { sanitizeAiResult } = await import('../src/services/moderation-ai-engine.ts');
  const result = sanitizeAiResult(['c1', 'c2', 'c3', 'c4'], {
    c1: 'ai_insult', c2: 'neutral', c3: 'very_bad', c4: 7, c99: 'ai_spam', __proto__: 'ai_hate',
  } as unknown as Record<string, string>);
  assert.deepEqual(result.categories, { c1: 'ai_insult', c2: 'neutral' });
  assert.equal(result.invalid, 3);
  assert.deepEqual(sanitizeAiResult(['c1'], {}).categories, {});
});

test('(a) a 400 that is not about the key maps to ai_request_rejected (no retry)', async () => {
  for (const response of [
    json(400, { error: { code: 400, message: 'Invalid JSON payload received.', status: 'INVALID_ARGUMENT' } }),
    json(400, { error: { code: 400, status: 'FAILED_PRECONDITION', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'OTHER' }] } }),
    new Response('not json', { status: 400 }),
  ]) {
    const { instance, calls, sleeps } = engine([response]);
    await rejectsWith(instance.classify({ c1: 'x' }), 'ai_request_rejected');
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});
