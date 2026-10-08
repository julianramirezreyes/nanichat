import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { acquireApplicationLock } from '../src/core/application-lock.ts';

test('application ownership rejects a second process and recovers only after its owner dies', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'social-app-owner-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));

  const script = `import { acquireApplicationLock } from './src/core/application-lock.ts';\n` +
    `const lock = acquireApplicationLock(${JSON.stringify(directory)});\n` +
    `console.log('owner-ready');\nsetInterval(() => {}, 1000);`;
  const owner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, 'exit');
      owner.kill('SIGKILL');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    }
  });

  let output = '';
  owner.stdout.setEncoding('utf8');
  owner.stdout.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 5000;
  while (!output.includes('owner-ready') && owner.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(output, /owner-ready/);
  assert.throws(() => acquireApplicationLock(directory), /already running|ownership/i);

  const exited = once(owner, 'exit');
  owner.kill('SIGKILL');
  await exited;
  const recovered = acquireApplicationLock(directory);
  assert.equal(recovered.owned, true);
  recovered.release();
});
