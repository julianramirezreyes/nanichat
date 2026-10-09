#!/usr/bin/env node
// Downloads the official portable Node.js runtime for Windows x64, verifies its SHA-256 against the official
// SHASUMS256.txt and extracts node.exe (plus LICENSE) into dist/node-win-x64/.
//
// Usage: node packaging/windows/fetch-node.mjs
// Env:   PORTABLE_NODE_VERSION  optional override (default: the package.json engines.node minimum, e.g. 24.21.0)
//
// Extraction uses a small pure-Node ZIP reader (lib/zip.mjs) instead of Expand-Archive or tar: it behaves the same
// on Windows and Linux (so it is tested locally), extracts only the two files the installer needs (npm and corepack
// are left out, ~30 MB less) and checks every file's size and CRC-32 after the archive's SHA-256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedSha256, resolvePortableNodeVersion } from './lib/node-release.mjs';
import { extractEntry, readZipEntries } from './lib/zip.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cacheDir = join(repoRoot, 'dist', 'cache');
const outputDir = join(repoRoot, 'dist', 'node-win-x64');
const BASE_URL = 'https://nodejs.org/dist';

function log(message) {
  process.stdout.write(`[fetch-node] ${message}\n`);
}

async function download(url, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= attempts) throw new Error(`Download failed after ${attempts} attempts: ${url}: ${error.message}`);
      log(`attempt ${attempt} failed for ${url} (${error.message}); retrying...`);
      await new Promise((done) => setTimeout(done, 5_000 * attempt));
    }
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const version = resolvePortableNodeVersion(manifest, process.env);
  const folder = `node-v${version}-win-x64`;
  const zipName = `${folder}.zip`;
  log(`portable Node.js version: ${version}`);

  const shasums = (await download(`${BASE_URL}/v${version}/SHASUMS256.txt`)).toString('utf8');
  const expected = expectedSha256(shasums, zipName);
  log(`expected SHA-256 of ${zipName}: ${expected}`);

  mkdirSync(cacheDir, { recursive: true });
  const cachedZip = join(cacheDir, zipName);
  let zip = existsSync(cachedZip) ? readFileSync(cachedZip) : undefined;
  if (zip && sha256(zip) !== expected) {
    log('cached archive does not match the official checksum; downloading again');
    zip = undefined;
  }
  if (!zip) {
    zip = await download(`${BASE_URL}/v${version}/${zipName}`);
    writeFileSync(cachedZip, zip);
  }
  const actual = sha256(zip);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${zipName}: expected ${expected}, got ${actual}. Refusing to use it.`);
  }
  log(`SHA-256 verified (${(zip.length / 1048576).toFixed(1)} MB archive)`);

  const entries = readZipEntries(zip);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  for (const file of ['node.exe', 'LICENSE']) {
    const entry = entries.find((candidate) => candidate.name === `${folder}/${file}`);
    if (!entry) throw new Error(`${folder}/${file} not found inside ${zipName}`);
    const data = extractEntry(zip, entry);
    writeFileSync(join(outputDir, file), data);
    log(`extracted ${file} (${(data.length / 1048576).toFixed(1)} MB, CRC-32 ok)`);
  }
  writeFileSync(join(outputDir, 'NODE_VERSION.txt'), `${version}\n`);
  log(`done: ${outputDir}`);
}

main().catch((error) => {
  process.stderr.write(`[fetch-node] ERROR: ${error.stack ?? error}\n`);
  process.exit(1);
});
