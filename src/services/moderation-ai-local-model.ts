import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open, statfs as fsStatfs } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Local AI models (moderation PR 3): catalog of pinned GGUF files and a single global download manager.
 *
 * Files live in `<LOCAL_SOCIAL_DATA_DIR>/models/` (never inside the app folder, so they survive a reinstall). A download
 * streams to `<file>.part` with bounded memory, follows redirects by hand (https and Hugging Face hosts only), resumes a
 * `.part` with Range, verifies the exact size and SHA-256 and only then renames the file atomically. No secrets are
 * involved; errors become safe codes (never the provider's text, never local paths).
 */
export type LocalModelSpec = {
  id: string;
  label: string;
  fileName: string;
  url: string;
  sizeBytes: number;
  sha256: string;
};

/**
 * Official Qwen GGUF builds, pinned to a repository commit. Sources: https://huggingface.co/api/models/<repo>/tree/main
 * (`size` and `lfs.oid` = SHA-256). Both are Apache-2.0. Qwen2.5-3B is NOT offered: its license is the non-commercial
 * "Qwen Research License"; Qwen3-4B (Apache-2.0) is the larger option instead.
 */
export const LOCAL_MODELS: readonly LocalModelSpec[] = Object.freeze([
  {
    id: 'qwen2.5-1.5b',
    label: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
    fileName: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sizeBytes: 1117320736,
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
  },
  {
    id: 'qwen3-4b',
    label: 'Qwen3 4B (Q4_K_M)',
    fileName: 'Qwen3-4B-Q4_K_M.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q4_K_M.gguf',
    sizeBytes: 2497280256,
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  },
]);

export const LOCAL_DEFAULT_MODEL = 'qwen2.5-1.5b';
export const DISK_MARGIN_BYTES = 500 * 1024 * 1024;
export const DOWNLOAD_HEADERS_TIMEOUT_MS = 30_000;
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const STATE_FILE = 'download-state.json';

export function isLocalModelId(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_MODELS.some((model) => model.id === value);
}

/** https on the default port, no credentials, and a Hugging Face host: huggingface.co, *.hf.co or cdn-lfs*.huggingface.co. */
export function isAllowedDownloadHost(url: URL): boolean {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return host === 'huggingface.co' || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.hf\.co$/u.test(host) || /^cdn-lfs[a-z0-9-]*\.huggingface\.co$/u.test(host);
}

export type DownloadState = 'running' | 'completed' | 'failed' | 'cancelled';
export type DownloadErrorCode = 'checksum_mismatch' | 'download_host_rejected' | 'download_timeout' | 'download_failed'
  | 'download_http_error' | 'insufficient_disk' | 'download_write_failed';

export type DownloadDto = { model: string; state: DownloadState; receivedBytes: number; totalBytes: number; errorCode?: DownloadErrorCode };
export type LocalModelEntryDto = { id: string; label: string; sizeBytes: number; installed: boolean; partialBytes: number };
export type LocalModelStatusDto = { models: LocalModelEntryDto[]; download?: DownloadDto };

export class LocalModelError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = 'LocalModelError';
  }
}

class DownloadFailure extends Error {
  constructor(readonly code: DownloadErrorCode) {
    super(code);
  }
}

type StatfsResult = { bavail: number | bigint; bsize: number | bigint };

export type LocalModelManagerOptions = {
  modelsDir: string;
  fetcher?: typeof fetch;
  statfs?: (path: string) => Promise<StatfsResult>;
  catalog?: readonly LocalModelSpec[];
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
};

type Active = { model: string; controller: AbortController; done: Promise<void>; cancelled: boolean };

export class LocalModelManager {
  readonly modelsDir: string;
  private readonly fetcher: typeof fetch;
  private readonly statfs: (path: string) => Promise<StatfsResult>;
  private readonly catalog: readonly LocalModelSpec[];
  private readonly headersTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private active: Active | null = null;
  private starting = false;
  private download: DownloadDto | undefined;

  constructor(options: LocalModelManagerOptions) {
    this.modelsDir = options.modelsDir;
    this.fetcher = options.fetcher ?? fetch;
    this.statfs = options.statfs ?? ((path) => fsStatfs(path));
    this.catalog = options.catalog ?? LOCAL_MODELS;
    this.headersTimeoutMs = options.headersTimeoutMs ?? DOWNLOAD_HEADERS_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
    this.download = this.readState();
  }

  private spec(id: unknown): LocalModelSpec {
    const spec = typeof id === 'string' ? this.catalog.find((model) => model.id === id) : undefined;
    if (!spec) throw new LocalModelError(400, 'invalid_request');
    return spec;
  }

  modelPath(id: string): string {
    return join(this.modelsDir, this.spec(id).fileName);
  }

  private partPath(spec: LocalModelSpec): string {
    return join(this.modelsDir, `${spec.fileName}.part`);
  }

  /** Installed = the final file exists with the exact expected size (its SHA-256 was verified before the rename). */
  isInstalled(id: string): boolean {
    const spec = this.catalog.find((model) => model.id === id);
    if (!spec) return false;
    return fileSize(join(this.modelsDir, spec.fileName)) === spec.sizeBytes;
  }

  status(): LocalModelStatusDto {
    const models = this.catalog.map((spec) => ({
      id: spec.id,
      label: spec.label,
      sizeBytes: spec.sizeBytes,
      installed: this.isInstalled(spec.id),
      partialBytes: fileSize(this.partPath(spec)) ?? 0,
    }));
    return this.download ? { models, download: { ...this.download } } : { models };
  }

  async startDownload(model: unknown): Promise<LocalModelStatusDto> {
    const spec = this.spec(model);
    if (this.active || this.starting) throw new LocalModelError(409, 'download_running');
    if (this.isInstalled(spec.id)) throw new LocalModelError(409, 'model_installed');
    this.starting = true;
    try {
      mkdirSync(this.modelsDir, { recursive: true });
      const partial = fileSize(this.partPath(spec)) ?? 0;
      const remaining = Math.max(0, spec.sizeBytes - partial);
      const disk = await this.statfs(this.modelsDir);
      const free = BigInt(disk.bavail) * BigInt(disk.bsize);
      if (free < BigInt(remaining + DISK_MARGIN_BYTES)) throw new LocalModelError(409, 'insufficient_disk');
      const controller = new AbortController();
      this.setDownload({ model: spec.id, state: 'running', receivedBytes: partial, totalBytes: spec.sizeBytes });
      const active: Active = { model: spec.id, controller, cancelled: false, done: Promise.resolve() };
      active.done = this.run(spec, active).finally(() => { if (this.active === active) this.active = null; });
      this.active = active;
    } finally {
      this.starting = false;
    }
    return this.status();
  }

  cancel(): LocalModelStatusDto {
    if (!this.active) throw new LocalModelError(409, 'download_not_running');
    this.active.cancelled = true;
    this.active.controller.abort();
    return this.status();
  }

  async delete(model: unknown, confirmed: unknown): Promise<LocalModelStatusDto> {
    const spec = this.spec(model);
    if (confirmed !== true) throw new Error('confirmation_required');
    if (this.active?.model === spec.id) throw new LocalModelError(409, 'download_running');
    rmSync(join(this.modelsDir, spec.fileName), { force: true });
    rmSync(this.partPath(spec), { force: true });
    if (this.download?.model === spec.id && this.download.state !== 'running') this.setDownload(undefined);
    return this.status();
  }

  /** Resolves when no download is running (used by tests and shutdown). */
  async waitForIdle(): Promise<void> {
    await this.active?.done;
  }

  /** Boot: a download cannot survive a restart; a persisted 'running' becomes 'cancelled' (the .part stays for resume). */
  recoverInterrupted(): void {
    if (this.download?.state === 'running' && !this.active) {
      const spec = this.catalog.find((model) => model.id === this.download!.model);
      const received = spec ? fileSize(this.partPath(spec)) ?? 0 : this.download.receivedBytes;
      this.setDownload({ ...this.download, state: 'cancelled', receivedBytes: received });
    }
  }

  // ---------- Internals ----------

  private setDownload(next: DownloadDto | undefined): void {
    this.download = next;
    try {
      mkdirSync(this.modelsDir, { recursive: true });
      const file = join(this.modelsDir, STATE_FILE);
      if (next) writeFileSync(file, JSON.stringify(next));
      else rmSync(file, { force: true });
    } catch {
      // The state file is a convenience for the boot recovery; the download itself does not depend on it.
    }
  }

  private readState(): DownloadDto | undefined {
    try {
      const raw = JSON.parse(readFileSync(join(this.modelsDir, STATE_FILE), 'utf8')) as Partial<DownloadDto>;
      const states: DownloadState[] = ['running', 'completed', 'failed', 'cancelled'];
      if (typeof raw.model !== 'string' || !this.catalog.some((model) => model.id === raw.model) || !states.includes(raw.state as DownloadState)) return undefined;
      return {
        model: raw.model, state: raw.state as DownloadState,
        receivedBytes: Number.isSafeInteger(raw.receivedBytes) ? raw.receivedBytes! : 0,
        totalBytes: Number.isSafeInteger(raw.totalBytes) ? raw.totalBytes! : 0,
        ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode as DownloadErrorCode } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async run(spec: LocalModelSpec, active: Active): Promise<void> {
    const part = this.partPath(spec);
    const progress = (receivedBytes: number) => {
      if (this.download?.model === spec.id && this.download.state === 'running') this.download = { ...this.download, receivedBytes };
    };
    try {
      await this.transfer(spec, part, active, progress);
      const final = join(this.modelsDir, spec.fileName);
      renameSync(part, final);
      this.setDownload({ model: spec.id, state: 'completed', receivedBytes: spec.sizeBytes, totalBytes: spec.sizeBytes });
    } catch (error) {
      const received = fileSize(part) ?? 0;
      if (active.cancelled) {
        this.setDownload({ model: spec.id, state: 'cancelled', receivedBytes: received, totalBytes: spec.sizeBytes });
        return;
      }
      const code: DownloadErrorCode = error instanceof DownloadFailure ? error.code : 'download_failed';
      if (code === 'checksum_mismatch') rmSync(part, { force: true });
      this.setDownload({ model: spec.id, state: 'failed', receivedBytes: fileSize(part) ?? 0, totalBytes: spec.sizeBytes, errorCode: code });
    }
  }

  /** Writes the verified file to `part`; throws DownloadFailure (or anything on cancel). */
  private async transfer(spec: LocalModelSpec, part: string, active: Active, progress: (bytes: number) => void): Promise<void> {
    let offset = fileSize(part) ?? 0;
    if (offset > spec.sizeBytes) { rmSync(part, { force: true }); offset = 0; }
    const hash = createHash('sha256');
    if (offset > 0) await hashFile(part, hash);
    if (offset < spec.sizeBytes) {
      const response = await this.request(spec.url, offset, active);
      let append = false;
      if (response.status === 206 && offset > 0 && contentRangeStart(response.headers.get('content-range')) === offset) append = true;
      else if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw new DownloadFailure('download_http_error'); }
      let hashToUse = hash;
      if (!append) { hashToUse = createHash('sha256'); offset = 0; }
      await this.writeBody(response, part, append, offset, spec, hashToUse, active, progress);
      if (hashToUse.digest('hex') !== spec.sha256) throw new DownloadFailure('checksum_mismatch');
      return;
    }
    if (hash.digest('hex') !== spec.sha256) throw new DownloadFailure('checksum_mismatch');
  }

  /** GET with Range (when resuming), following up to 5 redirects by hand, each one checked against the allowlist. */
  private async request(url: string, offset: number, active: Active): Promise<Response> {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isAllowedDownloadHost(current)) throw new DownloadFailure('download_host_rejected');
      if (active.cancelled) throw new Error('cancelled');
      const timer = setTimeout(() => { active.controller.abort(); }, this.headersTimeoutMs);
      let response: Response;
      try {
        response = await this.fetcher(current.href, {
          method: 'GET', redirect: 'manual', signal: active.controller.signal,
          headers: offset > 0 ? { range: `bytes=${offset}-` } : {},
        });
      } catch {
        if (active.cancelled) throw new Error('cancelled');
        throw new DownloadFailure(active.controller.signal.aborted ? 'download_timeout' : 'download_failed');
      } finally {
        clearTimeout(timer);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get('location');
        if (!location) throw new DownloadFailure('download_http_error');
        try { current = new URL(location, current); } catch { throw new DownloadFailure('download_host_rejected'); }
        continue;
      }
      return response;
    }
    throw new DownloadFailure('download_failed');
  }

  private async writeBody(response: Response, part: string, append: boolean, offset: number, spec: LocalModelSpec,
    hash: ReturnType<typeof createHash>, active: Active, progress: (bytes: number) => void): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new DownloadFailure('download_failed');
    let handle;
    try {
      handle = await open(part, append ? 'a' : 'w');
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new DownloadFailure('download_write_failed');
    }
    let received = offset;
    let idleTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { timedOut = true; active.controller.abort(); void reader.cancel().catch(() => undefined); }, this.idleTimeoutMs);
    };
    try {
      armIdle();
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          if (active.cancelled) throw new Error('cancelled');
          throw new DownloadFailure(timedOut ? 'download_timeout' : 'download_failed');
        }
        if (active.cancelled) throw new Error('cancelled');
        if (timedOut) throw new DownloadFailure('download_timeout');
        if (chunk.done) break;
        armIdle();
        received += chunk.value.byteLength;
        if (received > spec.sizeBytes) throw new DownloadFailure('checksum_mismatch');
        try {
          await handle.write(chunk.value);
        } catch (error) {
          throw new DownloadFailure((error as NodeJS.ErrnoException)?.code === 'ENOSPC' ? 'insufficient_disk' : 'download_write_failed');
        }
        hash.update(chunk.value);
        progress(received);
      }
      if (received !== spec.sizeBytes) throw new DownloadFailure('checksum_mismatch');
      await handle.sync();
    } finally {
      clearTimeout(idleTimer);
      await handle.close().catch(() => undefined);
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }
}

function fileSize(path: string): number | undefined {
  try {
    return existsSync(path) ? statSync(path).size : undefined;
  } catch {
    return undefined;
  }
}

function contentRangeStart(header: string | null): number | undefined {
  const match = header ? /^bytes (\d+)-\d+\/(?:\d+|\*)$/u.exec(header.trim()) : null;
  return match ? Number(match[1]) : undefined;
}

async function hashFile(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}
