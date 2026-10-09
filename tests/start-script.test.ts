import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeTempDir } from './helpers/tmp.ts';

test('npm scripts use no shell-specific syntax so they run the same on Windows, macOS and Linux', () => {
  const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(command, /^\s*[A-Z_][A-Z0-9_]*=/u, `${name} sets an environment variable with Unix syntax`);
    assert.doesNotMatch(command, /\$\(|`|&&|\|\||;|\benv\s/u, `${name} relies on shell features`);
  }
  assert.equal(scripts.start, 'node scripts/start.mjs');
});

test('the test script puts every node option before the file pattern (options after it are silently ignored)', () => {
  const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
  const words = scripts.test!.trim().split(/\s+/u);
  const pattern = words.indexOf('tests/*.test.ts');
  assert.equal(pattern, words.length - 1, 'the file pattern must be the last argument');
  for (const option of ['--test', '--test-timeout=120000', '--test-force-exit']) {
    assert.ok(words.indexOf(option) > -1 && words.indexOf(option) < pattern, `${option} must precede the file pattern`);
  }
});

test('the portable start script sets NODE_ENV=production before loading the TypeScript entry point', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'social-start-script-'));
  context.after(() => removeTempDir(directory));
  const entry = join(directory, 'entry.ts');
  // A static import is evaluated before the entry body: it must already observe production mode.
  writeFileSync(join(directory, 'observer.ts'), `export const observedMode: string | undefined = process.env.NODE_ENV;\n`);
  // Import cycles between TypeScript modules exist in the application (e.g. services importing each other).
  writeFileSync(join(directory, 'cycle-a.ts'), `import { b } from './cycle-b.ts';\nexport const a = (): string => 'a' + b();\n`);
  writeFileSync(join(directory, 'cycle-b.ts'), `import { a } from './cycle-a.ts';\nexport const b = (): string => typeof a === 'function' ? 'b' : '?';\n`);
  writeFileSync(entry, `import { observedMode } from './observer.ts';\nimport { a } from './cycle-a.ts';\nconst mode: string = String(observedMode);\nconsole.log('mode=' + mode + ' cycle=' + a());\n`);
  const result = spawnSync(process.execPath, ['scripts/start.mjs', entry], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'development' }, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mode=production cycle=ab/u);
});

test('tsx is a runtime dependency because the production start script loads it (npm ci --omit=dev must keep it)', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  };
  assert.ok(manifest.dependencies?.tsx, 'tsx must be listed in dependencies');
  assert.equal(manifest.devDependencies?.tsx, undefined, 'tsx must not also be a devDependency');
  assert.match(readFileSync('scripts/start.mjs', 'utf8'), /import\('tsx\//u);
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
    packages: Record<string, { dev?: boolean; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
  };
  assert.equal(lock.packages['']?.dependencies?.tsx, manifest.dependencies.tsx, 'package-lock.json must match package.json');
  assert.notEqual(lock.packages['node_modules/tsx']?.dev, true, 'the lockfile must not mark tsx as dev-only');
});

test('the Next.js config is plain JavaScript so the production runtime never needs the native SWC binary', () => {
  // A next.config.ts is transpiled with SWC on every start; without the binary Next.js downloads it from the network.
  // The Windows installer omits SWC (about 100 MB) and must start offline.
  assert.equal(existsSync('next.config.ts'), false, 'next.config.ts must not exist');
  assert.equal(existsSync('next.config.mjs'), true, 'next.config.mjs must exist');
});
