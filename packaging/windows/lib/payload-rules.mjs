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
 */
export function isPrunedFromNodeModules(relativePath) {
  const parts = relativePath.split(sep);
  const [first, second] = parts;
  if (first === '@next' && second?.startsWith('swc-')) return true;
  if (first === 'sharp' || first === '@img') return true;
  if (first === 'next' && second === 'dist' && parts[2] === 'docs') return true;
  const name = parts.at(-1) ?? '';
  if (KEEP_FILE.test(name)) return false;
  return PRUNED_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));
}
