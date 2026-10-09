import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_CHUNK_SIZE, LOCAL_CONTEXT_SIZE, LOCAL_IDLE_UNLOAD_MS, LocalAiRuntime, localResponseSchema, localThreads, type LlamaModuleLike,
} from '../src/services/moderation-ai-local.ts';
import { ModerationAiError, sanitizeAiResult } from '../src/services/moderation-ai-engine.ts';
import { AI_CATEGORIES, SYSTEM_INSTRUCTION, buildUserPrompt } from '../src/services/moderation-ai-prompt.ts';

type Recorded = {
  getLlama: unknown[]; loadModel: unknown[]; createContext: unknown[]; schemas: unknown[]; sessions: unknown[];
  prompts: Array<{ text: string; options: any }>; disposed: string[];
};

/** Fake node-llama-cpp module: records every call; `answer` decides what the "model" emits. */
function fakeLlama(answer: (prompt: string) => string = () => '{}') {
  const recorded: Recorded = { getLlama: [], loadModel: [], createContext: [], schemas: [], sessions: [], prompts: [], disposed: [] };
  const module: LlamaModuleLike = {
    async getLlama(options) {
      recorded.getLlama.push(options);
      return {
        async loadModel(options) {
          recorded.loadModel.push(options);
          return {
            async createContext(options) {
              recorded.createContext.push(options);
              return {
                getSequence: () => ({ dispose: () => { recorded.disposed.push('sequence'); } }),
                async dispose() { recorded.disposed.push('context'); },
              };
            },
            async dispose() { recorded.disposed.push('model'); },
          };
        },
        async createGrammarForJsonSchema(schema) {
          recorded.schemas.push(schema);
          return { schema };
        },
        async dispose() { recorded.disposed.push('llama'); },
      };
    },
    LlamaChatSession: class {
      constructor(options: unknown) { recorded.sessions.push(options); }
      async prompt(text: string, options: unknown) { recorded.prompts.push({ text, options }); return answer(text); }
      dispose() { recorded.disposed.push('session'); }
    },
  };
  return { module, recorded };
}

test('local engine: constants, thread count and a JSON schema built from the 5 categories', () => {
  assert.equal(LOCAL_CHUNK_SIZE, 10);
  assert.equal(LOCAL_CONTEXT_SIZE, 4096);
  assert.equal(LOCAL_IDLE_UNLOAD_MS, 5 * 60_000);
  // About one thread per physical core: on an SMT/hybrid laptop (16 logical CPUs) 15 threads measured 51.5 s per chunk
  // against 13.4 s with 8 (oversubscription). Never more than parallelism - 1, never less than 1.
  assert.equal(localThreads(16), 8);
  assert.equal(localThreads(8), 4);
  assert.equal(localThreads(4), 2);
  assert.equal(localThreads(3), 2);
  assert.equal(localThreads(2), 1);
  assert.equal(localThreads(1), 1);
  assert.equal(localThreads(0), 1);
  assert.deepEqual(localResponseSchema(['c1', 'c2']), {
    type: 'object',
    properties: { c1: { enum: [...AI_CATEGORIES] }, c2: { enum: [...AI_CATEGORIES] } },
    required: ['c1', 'c2'],
    additionalProperties: false,
  });
  assert.deepEqual([...AI_CATEGORIES].sort(), ['ai_complaint', 'ai_hate', 'ai_insult', 'ai_spam', 'neutral']);
});

test('local engine: lazy import failure becomes ai_local_unavailable, logged without secrets or paths', async () => {
  const logs: string[] = [];
  let imports = 0;
  const runtime = new LocalAiRuntime({
    resolveModelPath: () => '/home/someone/data/models/m.gguf',
    importer: async () => { imports++; throw new Error('Cannot load /home/someone/app/node_modules/x.node: Bearer abc123'); },
    log: (message) => logs.push(message),
  });
  assert.equal(imports, 0, 'nothing is imported until the first classification');
  const engine = runtime.engine('qwen2.5-1.5b');
  await assert.rejects(engine.classify({ c1: 'hola' }), (error: unknown) => error instanceof ModerationAiError && error.code === 'ai_local_unavailable');
  assert.equal(imports, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /ai_local_unavailable/u);
  assert.doesNotMatch(logs[0]!, /abc123|\/home\/someone/u);
});

test('local engine: loads the GGUF once on CPU without building, same prompt module, grammar constrains the output', async () => {
  const fake = fakeLlama(() => JSON.stringify({ c1: 'ai_insult', c2: 'neutral' }));
  const runtime = new LocalAiRuntime({ resolveModelPath: (id) => `/models/${id}.gguf`, importer: async () => fake.module, threads: 3 });
  const engine = runtime.engine('qwen2.5-1.5b');
  assert.equal(engine.chunkSize, LOCAL_CHUNK_SIZE);
  assert.equal(engine.spacingMs, 0, 'no spacing between local chunks');
  const batch = { c1: 'eres un idiota', c2: '¿Cuánto cuesta?' };
  assert.deepEqual(await engine.classify(batch), { c1: 'ai_insult', c2: 'neutral' });
  assert.deepEqual(await engine.classify({ c1: 'otra' }), { c1: 'ai_insult', c2: 'neutral' });
  assert.equal(fake.recorded.getLlama.length, 1, 'the runtime and the model load once');
  assert.equal(fake.recorded.loadModel.length, 1);
  assert.deepEqual(fake.recorded.getLlama[0], { gpu: false, build: 'never', logLevel: 'error', maxThreads: 3 });
  assert.deepEqual(fake.recorded.loadModel[0], { modelPath: '/models/qwen2.5-1.5b.gguf', gpuLayers: 0 });
  assert.deepEqual(fake.recorded.createContext[0], { contextSize: LOCAL_CONTEXT_SIZE, threads: 3 });
  assert.deepEqual(fake.recorded.schemas[0], localResponseSchema(['c1', 'c2']));
  assert.equal((fake.recorded.sessions[0] as any).systemPrompt, SYSTEM_INSTRUCTION);
  assert.equal(fake.recorded.prompts[0]!.text, buildUserPrompt(batch));
  const options = fake.recorded.prompts[0]!.options;
  assert.deepEqual(options.grammar, { schema: localResponseSchema(['c1', 'c2']) });
  assert.equal(options.temperature, 0);
  assert.ok(options.maxTokens > 0 && options.maxTokens <= 512);
  assert.deepEqual(options.budgets, { thoughtTokens: 0 });
  // Each chunk gets a fresh session and sequence, disposed afterwards (no history leaks between chunks).
  assert.equal(fake.recorded.sessions.length, 2);
  assert.equal(fake.recorded.disposed.filter((item) => item === 'session').length, 2);
  assert.equal(fake.recorded.disposed.filter((item) => item === 'sequence').length, 2);
  // Unknown aliases or categories are dropped and counted by the shared sanitizer.
  const raw = await engine.classify({ c1: 'x' });
  assert.deepEqual(sanitizeAiResult(['c1'], { ...raw, c9: 'ai_spam', c1: 'rude' }), { categories: {}, invalid: 3 });
  await runtime.unload();
});

test('local engine: non-JSON output is ai_invalid_output; a load failure (bad file) is ai_local_unavailable', async () => {
  const fake = fakeLlama(() => 'not json');
  const runtime = new LocalAiRuntime({ resolveModelPath: () => '/m.gguf', importer: async () => fake.module, log: () => undefined });
  await assert.rejects(runtime.engine('qwen2.5-1.5b').classify({ c1: 'x' }), (error: unknown) => error instanceof ModerationAiError && error.code === 'ai_invalid_output');
  const array = new LocalAiRuntime({ resolveModelPath: () => '/m.gguf', importer: async () => fakeLlama(() => '["neutral"]').module });
  await assert.rejects(array.engine('qwen2.5-1.5b').classify({ c1: 'x' }), (error: unknown) => error instanceof ModerationAiError && error.code === 'ai_invalid_output');
  const broken = fakeLlama();
  const module = { ...broken.module, async getLlama() { return { ...(await broken.module.getLlama({})), async loadModel() { throw new Error('bad gguf at /secret/path'); } }; } };
  const logs: string[] = [];
  const failing = new LocalAiRuntime({ resolveModelPath: () => '/m.gguf', importer: async () => module as LlamaModuleLike, log: (message) => logs.push(message) });
  await assert.rejects(failing.engine('qwen2.5-1.5b').classify({ c1: 'x' }), (error: unknown) => error instanceof ModerationAiError && error.code === 'ai_local_unavailable');
  assert.doesNotMatch(logs.join('\n'), /\/secret\/path/u);
});

test('local engine: unloads after 5 min idle (fake timers), reloads on demand, switching model reloads', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fake = fakeLlama(() => '{"c1":"neutral"}');
  const runtime = new LocalAiRuntime({ resolveModelPath: (id) => `/models/${id}.gguf`, importer: async () => fake.module });
  await runtime.engine('qwen2.5-1.5b').classify({ c1: 'a' });
  assert.equal(runtime.loadedModel, 'qwen2.5-1.5b');
  t.mock.timers.tick(LOCAL_IDLE_UNLOAD_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.loadedModel, 'qwen2.5-1.5b', 'still loaded before 5 min');
  await runtime.engine('qwen2.5-1.5b').classify({ c1: 'b' });
  t.mock.timers.tick(LOCAL_IDLE_UNLOAD_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.loadedModel, 'qwen2.5-1.5b', 'every use restarts the idle timer');
  t.mock.timers.tick(1);
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.loadedModel, null);
  assert.ok(fake.recorded.disposed.includes('model') && fake.recorded.disposed.includes('context'));
  await runtime.engine('qwen3-4b').classify({ c1: 'c' });
  assert.equal(runtime.loadedModel, 'qwen3-4b');
  assert.equal(fake.recorded.loadModel.length, 2);
  await runtime.engine('qwen2.5-1.5b').classify({ c1: 'd' });
  assert.equal(fake.recorded.loadModel.length, 3, 'a different model replaces the loaded one');
  await runtime.unload();
  assert.equal(runtime.loadedModel, null);
});

test('local engine: classifications are serialized (one context sequence) and an aborted signal stops the prompt', async () => {
  let active = 0;
  let maxActive = 0;
  const fake = fakeLlama();
  fake.module.LlamaChatSession = class {
    async prompt(_text: string, options: any) {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      if (options.signal?.aborted) throw new Error('AbortError');
      return '{"c1":"neutral"}';
    }
    dispose() {}
  } as never;
  const runtime = new LocalAiRuntime({ resolveModelPath: () => '/m.gguf', importer: async () => fake.module });
  const engine = runtime.engine('qwen2.5-1.5b');
  await Promise.all([engine.classify({ c1: 'a' }), engine.classify({ c1: 'b' }), engine.classify({ c1: 'c' })]);
  assert.equal(maxActive, 1);
  const controller = new AbortController();
  const pending = engine.classify({ c1: 'd' }, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof ModerationAiError && error.code === 'ai_unavailable');
  await runtime.unload();
});
