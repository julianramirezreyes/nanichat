import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('npm scripts use no shell-specific syntax so they run the same on Windows, macOS and Linux', () => {
  const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts;
  for (const [name, command] of Object.entries(scripts)) {
    assert.doesNotMatch(command, /^\s*[A-Z_][A-Z0-9_]*=/u, `${name} sets an environment variable with Unix syntax`);
    assert.doesNotMatch(command, /\$\(|`|&&|\|\||;|\benv\s/u, `${name} relies on shell features`);
  }
  assert.equal(scripts.start, 'node scripts/start.mjs');
});

test('the portable start script sets NODE_ENV=production before loading the TypeScript entry point', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'social-start-script-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
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
