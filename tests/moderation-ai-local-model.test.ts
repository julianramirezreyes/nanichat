import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DISK_MARGIN_BYTES, LOCAL_DEFAULT_MODEL, LOCAL_MODELS, LocalModelError, LocalModelManager, isAllowedDownloadHost,
  type LocalModelSpec,
} from '../src/services/moderation-ai-local-model.ts';

const BYTES = Buffer.from('GGUF-fake-model-bytes-0123456789-abcdefghijklmnopqrstuvwxyz');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const ORIGIN_URL = 'https://huggingface.co/Org/Repo-GGUF/resolve/0123456789abcdef0123456789abcdef01234567/tiny.gguf';
const CDN_URL = 'https://cas-bridge.xethub.hf.co/xet-bridge/tiny?sig=x';

function spec(overrides: Partial<LocalModelSpec> = {}): LocalModelSpec {
  return { id: 'qwen2.5-1.5b', label: 'Tiny', fileName: 'tiny.gguf', url: ORIGIN_URL, sizeBytes: BYTES.length, sha256: sha(BYTES), ...overrides };
}

function bodyOf(data: Buffer, pieces = 4): ReadableStream<Uint8Array> {
  const size = Math.ceil(data.length / pieces);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.length) return controller.close();
      controller.enqueue(new Uint8Array(data.subarray(offset, offset + size)));
      offset += size;
    },
  });
}

type Call = { url: string; range: string | null; redirect: string | undefined };

/** Fake fetch: the origin redirects to the CDN, which serves the bytes (honouring Range). */
function fakeFetch(options: { data?: Buffer; redirectTo?: string; ignoreRange?: boolean; hang?: boolean } = {}) {
  const calls: Call[] = [];
  const data = options.data ?? BYTES;
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, range: headers.get('range'), redirect: init?.redirect });
    if (url === ORIGIN_URL) return new Response(null, { status: 302, headers: { location: options.redirectTo ?? CDN_URL } });
    if (options.hang) {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) return reject(new Error('aborted'));
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    const range = headers.get('range');
    const match = range && !options.ignoreRange ? /^bytes=(\d+)-$/u.exec(range) : null;
    if (match) {
      const start = Number(match[1]);
      return new Response(bodyOf(data.subarray(start)), {
        status: 206, headers: { 'content-range': `bytes ${start}-${data.length - 1}/${data.length}`, 'content-length': String(data.length - start) },
      });
    }
    return new Response(bodyOf(data), { status: 200, headers: { 'content-length': String(data.length) } });
  }) as typeof fetch;
  return { fetcher, calls };
}

const plentyOfDisk = async () => ({ bavail: 10_000_000, bsize: 4096 });

async function withDir(fn: (dir: string) => unknown | Promise<unknown>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mod-ai-models-'));
  try { await fn(join(dir, 'models')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function manager(modelsDir: string, fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof LocalModelManager>[0]> = {}) {
  return new LocalModelManager({ modelsDir, fetcher, statfs: plentyOfDisk, catalog: [spec(), spec({ id: 'qwen3-4b', fileName: 'big.gguf' })], ...extra });
}

test('catalog: official Qwen GGUF files pinned to a commit, with exact size and SHA-256', () => {
  assert.equal(LOCAL_DEFAULT_MODEL, 'qwen2.5-1.5b');
  assert.deepEqual(LOCAL_MODELS.map((model) => model.id), ['qwen2.5-1.5b', 'qwen3-4b']);
  for (const model of LOCAL_MODELS) {
    assert.match(model.url, /^https:\/\/huggingface\.co\/Qwen\/[A-Za-z0-9.-]+-GGUF\/resolve\/[0-9a-f]{40}\/[A-Za-z0-9._-]+\.gguf$/u, model.id);
    assert.ok(model.url.endsWith(`/${model.fileName}`));
    assert.match(model.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(Number.isSafeInteger(model.sizeBytes) && model.sizeBytes > 500_000_000);
  }
  const small = LOCAL_MODELS[0]!;
  assert.equal(small.sizeBytes, 1117320736);
  assert.equal(small.sha256, '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e');
  assert.equal(DISK_MARGIN_BYTES, 500 * 1024 * 1024);
});

test('redirect allowlist: only https huggingface.co, *.hf.co and cdn-lfs*.huggingface.co', () => {
  for (const url of [ORIGIN_URL, CDN_URL, 'https://cdn-lfs.hf.co/x', 'https://cdn-lfs-us-1.huggingface.co/x', 'https://cdn-lfs.huggingface.co/x']) {
    assert.equal(isAllowedDownloadHost(new URL(url)), true, url);
  }
  for (const url of ['http://huggingface.co/x', 'https://evil.com/x', 'https://huggingface.co.evil.com/x', 'https://hf.co.evil.com/x',
    'https://evilhf.co/x', 'https://cdn.huggingface.co/x', 'https://user:pw@huggingface.co/x', 'https://huggingface.co:8443/x']) {
    assert.equal(isAllowedDownloadHost(new URL(url)), false, url);
  }
});

test('download: follows the allowed redirect, streams to .part, verifies size + SHA-256 and renames atomically', async () => {
  await withDir(async (modelsDir) => {
    const fake = fakeFetch();
    const models = manager(modelsDir, fake.fetcher);
    assert.equal(models.isInstalled('qwen2.5-1.5b'), false);
    const started = await models.startDownload('qwen2.5-1.5b');
    assert.equal(started.download?.state, 'running');
    await models.waitForIdle();
    const status = models.status();
    assert.deepEqual(status.download, { model: 'qwen2.5-1.5b', state: 'completed', receivedBytes: BYTES.length, totalBytes: BYTES.length });
    assert.deepEqual(readFileSync(join(modelsDir, 'tiny.gguf')), BYTES);
    assert.equal(existsSync(join(modelsDir, 'tiny.gguf.part')), false);
    assert.equal(models.isInstalled('qwen2.5-1.5b'), true);
    assert.equal(status.models.find((model) => model.id === 'qwen2.5-1.5b')?.installed, true);
    assert.equal(status.models.find((model) => model.id === 'qwen3-4b')?.installed, false);
    assert.deepEqual(fake.calls.map((call) => call.url), [ORIGIN_URL, CDN_URL]);
    assert.ok(fake.calls.every((call) => call.redirect === 'manual'), 'redirects are followed by hand, never automatically');
    assert.equal(models.modelPath('qwen2.5-1.5b'), join(modelsDir, 'tiny.gguf'));
  });
});

test('download: checksum mismatch deletes the .part and reports checksum_mismatch; wrong size too', async () => {
  await withDir(async (modelsDir) => {
    const tampered = Buffer.from(BYTES);
    tampered[3] = 0x21;
    const models = manager(modelsDir, fakeFetch({ data: tampered }).fetcher);
    await models.startDownload('qwen2.5-1.5b');
    await models.waitForIdle();
    assert.equal(models.status().download?.state, 'failed');
    assert.equal(models.status().download?.errorCode, 'checksum_mismatch');
    assert.equal(existsSync(join(modelsDir, 'tiny.gguf.part')), false);
    assert.equal(existsSync(join(modelsDir, 'tiny.gguf')), false);
    const longer = manager(modelsDir, fakeFetch({ data: Buffer.concat([BYTES, Buffer.from('extra')]) }).fetcher);
    await longer.startDownload('qwen2.5-1.5b');
    await longer.waitForIdle();
    assert.equal(longer.status().download?.errorCode, 'checksum_mismatch');
    assert.equal(existsSync(join(modelsDir, 'tiny.gguf.part')), false);
  });
});

test('download: a redirect to a host outside the allowlist (or to http) is rejected', async () => {
  for (const redirectTo of ['https://evil.example.com/tiny.gguf', 'http://cdn-lfs.hf.co/tiny.gguf']) {
    await withDir(async (modelsDir) => {
      const fake = fakeFetch({ redirectTo });
      const models = manager(modelsDir, fake.fetcher);
      await models.startDownload('qwen2.5-1.5b');
      await models.waitForIdle();
      assert.equal(models.status().download?.state, 'failed');
      assert.equal(models.status().download?.errorCode, 'download_host_rejected');
      assert.deepEqual(fake.calls.map((call) => call.url), [ORIGIN_URL], 'the rejected host is never contacted');
    });
  }
});

test('download: resumes an existing .part with Range and still verifies the whole file', async () => {
  await withDir(async (modelsDir) => {
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, 'tiny.gguf.part'), BYTES.subarray(0, 20));
    const fake = fakeFetch();
    const models = manager(modelsDir, fake.fetcher);
    assert.equal(models.status().models[0]!.partialBytes, 20);
    await models.startDownload('qwen2.5-1.5b');
    await models.waitForIdle();
    assert.equal(models.status().download?.state, 'completed');
    assert.deepEqual(fake.calls.map((call) => call.range), ['bytes=20-', 'bytes=20-']);
    assert.deepEqual(readFileSync(join(modelsDir, 'tiny.gguf')), BYTES);
    // A server that ignores Range (200) restarts the file from zero instead of appending twice.
    rmSync(join(modelsDir, 'tiny.gguf'));
    writeFileSync(join(modelsDir, 'tiny.gguf.part'), BYTES.subarray(0, 20));
    const ignoring = manager(modelsDir, fakeFetch({ ignoreRange: true }).fetcher);
    await ignoring.startDownload('qwen2.5-1.5b');
    await ignoring.waitForIdle();
    assert.equal(ignoring.status().download?.state, 'completed');
    assert.deepEqual(readFileSync(join(modelsDir, 'tiny.gguf')), BYTES);
  });
});

test('download: cancel stops it, keeps the .part for resume and reports cancelled', async () => {
  await withDir(async (modelsDir) => {
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, 'tiny.gguf.part'), BYTES.subarray(0, 10));
    const models = manager(modelsDir, fakeFetch({ hang: true }).fetcher);
    await models.startDownload('qwen2.5-1.5b');
    const cancelled = models.cancel();
    await models.waitForIdle();
    assert.equal(models.status().download?.state, 'cancelled');
    assert.equal(cancelled.download?.model, 'qwen2.5-1.5b');
    assert.equal(statSync(join(modelsDir, 'tiny.gguf.part')).size, 10);
    assert.throws(() => models.cancel(), (error: any) => error instanceof LocalModelError && error.code === 'download_not_running' && error.status === 409);
  });
});

test('download: insufficient disk (size + 500 MB) is refused before any request', async () => {
  await withDir(async (modelsDir) => {
    const fake = fakeFetch();
    const needed = BYTES.length + DISK_MARGIN_BYTES;
    const models = manager(modelsDir, fake.fetcher, { statfs: async () => ({ bavail: needed - 1, bsize: 1 }) });
    await assert.rejects(models.startDownload('qwen2.5-1.5b'), (error: any) => error.code === 'insufficient_disk' && error.status === 409);
    assert.deepEqual(fake.calls, []);
    assert.equal(models.status().download, undefined);
    const enough = manager(modelsDir, fake.fetcher, { statfs: async () => ({ bavail: BigInt(needed), bsize: 1n }) });
    await enough.startDownload('qwen2.5-1.5b');
    await enough.waitForIdle();
    assert.equal(enough.status().download?.state, 'completed');
  });
});

test('download: one at a time (409 download_running), strict model ids, already installed is a no-op error', async () => {
  await withDir(async (modelsDir) => {
    const models = manager(modelsDir, fakeFetch({ hang: true }).fetcher);
    for (const model of ['qwen2.5-7b', '', 42, null, '../x']) {
      await assert.rejects(models.startDownload(model), (error: any) => error.code === 'invalid_request' && error.status === 400, String(model));
    }
    await models.startDownload('qwen2.5-1.5b');
    await assert.rejects(models.startDownload('qwen3-4b'), (error: any) => error.code === 'download_running' && error.status === 409);
    models.cancel();
    await models.waitForIdle();
  });
  await withDir(async (modelsDir) => {
    const models = manager(modelsDir, fakeFetch().fetcher);
    await models.startDownload('qwen2.5-1.5b');
    await models.waitForIdle();
    await assert.rejects(models.startDownload('qwen2.5-1.5b'), (error: any) => error.code === 'model_installed' && error.status === 409);
  });
});

test('download: a stalled response times out with download_timeout; a network error is download_failed', async () => {
  await withDir(async (modelsDir) => {
    const models = manager(modelsDir, fakeFetch({ hang: true }).fetcher, { headersTimeoutMs: 20 });
    await models.startDownload('qwen2.5-1.5b');
    await models.waitForIdle();
    assert.equal(models.status().download?.errorCode, 'download_timeout');
    const broken = manager(modelsDir, (async () => { throw new Error('getaddrinfo ENOTFOUND secret-host'); }) as typeof fetch);
    await broken.startDownload('qwen2.5-1.5b');
    await broken.waitForIdle();
    assert.equal(broken.status().download?.errorCode, 'download_failed');
    assert.doesNotMatch(JSON.stringify(broken.status()), /ENOTFOUND|secret-host/u);
    const notFound = manager(modelsDir, (async () => new Response('nope', { status: 404 })) as typeof fetch);
    await notFound.startDownload('qwen2.5-1.5b');
    await notFound.waitForIdle();
    assert.equal(notFound.status().download?.errorCode, 'download_http_error');
  });
});

test('boot: a download recorded as running becomes cancelled and its .part stays for resume', async () => {
  await withDir(async (modelsDir) => {
    const first = manager(modelsDir, fakeFetch({ hang: true }).fetcher);
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, 'tiny.gguf.part'), BYTES.subarray(0, 7));
    await first.startDownload('qwen2.5-1.5b');
    // Simulated crash: a new manager reads the persisted state.
    const rebooted = manager(modelsDir, fakeFetch().fetcher);
    rebooted.recoverInterrupted();
    assert.equal(rebooted.status().download?.state, 'cancelled');
    assert.equal(rebooted.status().download?.model, 'qwen2.5-1.5b');
    assert.equal(statSync(join(modelsDir, 'tiny.gguf.part')).size, 7);
    first.cancel();
    await first.waitForIdle();
  });
});

test('delete requires confirmed === true, removes the model and its .part, refuses while that model downloads', async () => {
  await withDir(async (modelsDir) => {
    const models = manager(modelsDir, fakeFetch().fetcher);
    await models.startDownload('qwen2.5-1.5b');
    await models.waitForIdle();
    for (const confirmed of [undefined, false, 'true', 1]) {
      await assert.rejects(models.delete('qwen2.5-1.5b', confirmed), /confirmation_required/u);
    }
    assert.equal(models.isInstalled('qwen2.5-1.5b'), true);
    await assert.rejects(models.delete('nope', true), (error: any) => error.code === 'invalid_request');
    await models.delete('qwen2.5-1.5b', true);
    assert.equal(models.isInstalled('qwen2.5-1.5b'), false);
    assert.equal(existsSync(join(modelsDir, 'tiny.gguf')), false);
    const hanging = manager(modelsDir, fakeFetch({ hang: true }).fetcher);
    await hanging.startDownload('qwen2.5-1.5b');
    await assert.rejects(hanging.delete('qwen2.5-1.5b', true), (error: any) => error.code === 'download_running' && error.status === 409);
    hanging.cancel();
    await hanging.waitForIdle();
    await hanging.delete('qwen2.5-1.5b', true);
    assert.equal(existsSync(join(modelsDir, 'tiny.gguf.part')), false);
  });
});

test('status: a file of the wrong size is not installed; the status DTO has only allowed fields', async () => {
  await withDir(async (modelsDir) => {
    mkdirSync(modelsDir, { recursive: true });
    writeFileSync(join(modelsDir, 'tiny.gguf'), BYTES.subarray(0, 5));
    const models = manager(modelsDir, fakeFetch().fetcher);
    assert.equal(models.isInstalled('qwen2.5-1.5b'), false);
    const entry = models.status().models[0]!;
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'installed', 'label', 'partialBytes', 'sizeBytes']);
    assert.doesNotMatch(JSON.stringify(models.status()), new RegExp(modelsDir.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&'), 'u'), 'no local paths');
  });
});
