// What the Windows payload copies from the repository and what it prunes from the production node_modules.
// Paths are relative and use the platform separator (node:path), so the same rules work on Windows and Linux.
import { sep } from 'node:path';

/** Repository entries the runtime needs (`node scripts/start.mjs` -> server.ts through tsx -> Next.js + .next). */
export const APP_ENTRIES = Object.freeze([
  '.next',
  'app',
  'scripts',
  'src',
  'server.ts',
  'next.config.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
]);

const NEXT_BUILD_EXCLUDED = new Set(['cache', 'dev', 'trace', 'trace-build']);

/** `.next` entries that only serve builds or development: the build cache, dev output and build traces. */
export function isExcludedFromNextBuild(relativePath) {
  return NEXT_BUILD_EXCLUDED.has(relativePath.split(sep)[0]);
}

const KEEP_FILE = /^(licen[cs]e|notice|copying)/iu;
const PRUNED_SUFFIXES = ['.map', '.d.ts', '.d.mts', '.d.cts', '.md', '.markdown'];

/**
 * Production node_modules entries the packaged app never loads:
 * - @next/swc-*: the native compiler is only used to build and to transpile a TypeScript next.config (the app uses
 *   next.config.mjs, see tests/start-script.test.ts); about 100 MB.
 * - sharp and @img/*: only used by next/image optimization, which the app does not use.
 * - next/dist/docs, source maps, type declarations and Markdown docs (license files are always kept).
 * - Local AI (node-llama-cpp): every @node-llama-cpp/* prebuilt except the CPU one for win-x64 (npm installs all the
 *   variants whose os/cpu match: CUDA ~175/368 MB, Vulkan ~103 MB and win-arm64, which also declares x64); the app runs
 *   CPU only. Also the llama.cpp source bundle (`llama/gitRelease.bundle`, ~34 MB), only used to compile from source,
 *   which the app never does (getLlama build: 'never').
 * - typescript and @typescript/*: an optional peer of node-llama-cpp makes npm flag the dev compiler `devOptional`, so
 *   `npm ci --omit=dev` installs it; the runtime never uses it.
 */
export const LLAMA_PREBUILT_KEPT = 'win-x64';

export function isPrunedFromNodeModules(relativePath) {
  const parts = relativePath.split(sep);
  const [first, second] = parts;
  if (first === '@next' && second?.startsWith('swc-')) return true;
  if (first === '@node-llama-cpp' && second !== undefined && second !== LLAMA_PREBUILT_KEPT) return true;
  if (first === 'node-llama-cpp' && second === 'llama' && parts[2] === 'gitRelease.bundle') return true;
  if (first === 'typescript' || first === '@typescript') return true;
  if (first === 'sharp' || first === '@img') return true;
  if (first === 'next' && second === 'dist' && parts[2] === 'docs') return true;
  const name = parts.at(-1) ?? '';
  if (KEEP_FILE.test(name)) return false;
  return PRUNED_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));
}
