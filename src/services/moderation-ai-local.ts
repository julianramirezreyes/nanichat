import { availableParallelism } from 'node:os';
import { redactSecrets } from '../security/redact.ts';
import { ModerationAiError, type ModerationAiEngine } from './moderation-ai-engine.ts';
import { AI_CATEGORIES, SYSTEM_INSTRUCTION, buildUserPrompt } from './moderation-ai-prompt.ts';

/**
 * Local AI engine (moderation PR 3): runs a GGUF model inside this process with node-llama-cpp, CPU only. Nothing leaves
 * the machine. node-llama-cpp is imported lazily (dynamic import) so the app starts even when the native binary cannot
 * load; that failure, like a broken model file, becomes `ai_local_unavailable` and the reason goes to the log, redacted.
 *
 * One model stays loaded while it is used and is unloaded after LOCAL_IDLE_UNLOAD_MS without use. Classifications are
 * serialized (one context sequence), each in a fresh chat session so no history leaks between chunks. The output is
 * constrained by a JSON-schema grammar: an object with exactly the chunk keys, each one of the five categories.
 */
export const LOCAL_CHUNK_SIZE = 10;
export const LOCAL_CONTEXT_SIZE = 4096;
export const LOCAL_IDLE_UNLOAD_MS = 5 * 60_000;
/** ~12 tokens per entry ("c10": "ai_complaint",) for at most LOCAL_CHUNK_SIZE entries, with margin. */
export const LOCAL_MAX_OUTPUT_TOKENS = 256;

/**
 * About one thread per physical core (half the logical CPUs), never more than parallelism - 1. llama.cpp slows down
 * badly when oversubscribed: on a 16-thread hybrid laptop, 15 threads took 51.5 s per chunk and 8 threads 13.4 s.
 */
export function localThreads(parallelism: number = availableParallelism()): number {
  const logical = Math.max(0, Math.floor(parallelism));
  return Math.max(1, Math.min(logical - 1, Math.ceil(logical / 2)));
}

export function localResponseSchema(keys: readonly string[]) {
  const properties: Record<string, { enum: string[] }> = {};
  for (const key of keys) properties[key] = { enum: [...AI_CATEGORIES] };
  return { type: 'object' as const, properties, required: [...keys], additionalProperties: false };
}

// Minimal structural view of the node-llama-cpp API used here (keeps tests free of the native module).
type Disposable = { dispose(): unknown };
type ContextLike = Disposable & { getSequence(): Disposable };
type ModelLike = Disposable & { createContext(options: { contextSize: number; threads: number }): Promise<ContextLike> };
type LlamaLike = Disposable & {
  loadModel(options: { modelPath: string; gpuLayers: number }): Promise<ModelLike>;
  createGrammarForJsonSchema(schema: ReturnType<typeof localResponseSchema>): Promise<unknown>;
};
type SessionLike = Disposable & { prompt(text: string, options: Record<string, unknown>): Promise<string> };
export type LlamaModuleLike = {
  getLlama(options: Record<string, unknown>): Promise<LlamaLike>;
  LlamaChatSession: new (options: { contextSequence: unknown; systemPrompt: string }) => SessionLike;
};

export type LocalAiRuntimeOptions = {
  /** Absolute path of an installed model file (from LocalModelManager.modelPath). */
  resolveModelPath(modelId: string): string;
  importer?: () => Promise<LlamaModuleLike>;
  threads?: number;
  idleMs?: number;
  log?: (message: string) => void;
};

type Loaded = { modelId: string; module: LlamaModuleLike; llama: LlamaLike; model: ModelLike; context: ContextLike };

class LoadFailure extends Error {}

const defaultImporter = async () => (await import('node-llama-cpp')) as unknown as LlamaModuleLike;

/** Error text for the log: no tokens, no absolute paths (they can contain the user name). */
export function redactReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).replace(/(?:[A-Za-z]:)?[\\/][^\s'"`]+/gu, '[path]').slice(0, 300);
}

export class LocalAiRuntime {
  private loaded: Loaded | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly importer: () => Promise<LlamaModuleLike>;
  private readonly threads: number;
  private readonly idleMs: number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: LocalAiRuntimeOptions) {
    this.importer = options.importer ?? defaultImporter;
    this.threads = options.threads ?? localThreads();
    this.idleMs = options.idleMs ?? LOCAL_IDLE_UNLOAD_MS;
    this.log = options.log ?? ((message) => console.error(message));
  }

  get loadedModel(): string | null {
    return this.loaded?.modelId ?? null;
  }

  engine(modelId: string): ModerationAiEngine {
    return {
      chunkSize: LOCAL_CHUNK_SIZE,
      spacingMs: 0,
      classify: (batch, signal) => this.serialize(() => this.classify(modelId, batch, signal)),
    };
  }

  /** Frees the model and the runtime (idle timer, model deletion, shutdown). Waits for a running classification. */
  async unload(): Promise<void> {
    await this.serialize(() => this.release());
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async classify(modelId: string, batch: Record<string, string>, signal?: AbortSignal): Promise<Record<string, string>> {
    if (signal?.aborted) throw new ModerationAiError('ai_unavailable');
    clearTimeout(this.idleTimer);
    let loaded: Loaded;
    try {
      loaded = await this.load(modelId);
    } catch (error) {
      this.log(`[moderation-ai] ai_local_unavailable (${error instanceof LoadFailure ? error.message : 'load'}): ${redactReason(error instanceof LoadFailure ? error.cause : error)}`);
      await this.release();
      throw new ModerationAiError('ai_local_unavailable');
    }
    const keys = Object.keys(batch);
    let text: string;
    const sequence = loaded.context.getSequence();
    const session = new loaded.module.LlamaChatSession({ contextSequence: sequence, systemPrompt: SYSTEM_INSTRUCTION });
    try {
      const grammar = await loaded.llama.createGrammarForJsonSchema(localResponseSchema(keys));
      text = await session.prompt(buildUserPrompt(batch), {
        grammar,
        temperature: 0,
        maxTokens: LOCAL_MAX_OUTPUT_TOKENS,
        // Reasoning models (Qwen3) must answer directly: the grammar only allows the JSON object.
        budgets: { thoughtTokens: 0 },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw new ModerationAiError('ai_unavailable');
      this.log(`[moderation-ai] local generation failed: ${redactReason(error)}`);
      throw new ModerationAiError('ai_unavailable');
    } finally {
      try { session.dispose(); } catch { /* already disposed */ }
      try { sequence.dispose(); } catch { /* already disposed */ }
      this.armIdle();
    }
    let output: unknown;
    try { output = JSON.parse(text); } catch { throw new ModerationAiError('ai_invalid_output'); }
    if (!output || typeof output !== 'object' || Array.isArray(output)) throw new ModerationAiError('ai_invalid_output');
    return output as Record<string, string>;
  }

  private async load(modelId: string): Promise<Loaded> {
    if (this.loaded?.modelId === modelId) return this.loaded;
    await this.release();
    let module: LlamaModuleLike;
    try { module = await this.importer(); } catch (error) { throw new LoadFailure('import', { cause: error }); }
    let llama: LlamaLike;
    try {
      llama = await module.getLlama({ gpu: false, build: 'never', logLevel: 'error', maxThreads: this.threads });
    } catch (error) { throw new LoadFailure('runtime', { cause: error }); }
    try {
      const model = await llama.loadModel({ modelPath: this.options.resolveModelPath(modelId), gpuLayers: 0 });
      try {
        const context = await model.createContext({ contextSize: LOCAL_CONTEXT_SIZE, threads: this.threads });
        this.loaded = { modelId, module, llama, model, context };
        return this.loaded;
      } catch (error) {
        await Promise.resolve(model.dispose()).catch(() => undefined);
        throw new LoadFailure('context', { cause: error });
      }
    } catch (error) {
      await Promise.resolve(llama.dispose()).catch(() => undefined);
      throw error instanceof LoadFailure ? error : new LoadFailure('model', { cause: error });
    }
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.unload(); }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private async release(): Promise<void> {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const loaded = this.loaded;
    this.loaded = null;
    if (!loaded) return;
    for (const item of [loaded.context, loaded.model, loaded.llama]) {
      await Promise.resolve(item.dispose()).catch(() => undefined);
    }
  }
}
