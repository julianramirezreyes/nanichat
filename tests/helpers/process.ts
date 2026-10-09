import { spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

/**
 * Stops a spawned test process and everything it started, then waits (bounded) for it to exit.
 * POSIX: sends `signal` (SIGTERM lets the server run its own graceful shutdown).
 * Windows: signals are not delivered (kill() is TerminateProcess on the direct child only), so any grandchild
 * (e.g. a framework worker) would survive holding the inherited stdout/stderr pipes and keep the test runner's
 * file process alive. `taskkill /T /F` terminates the whole tree instead.
 * Finally the parent-side pipes are destroyed so no stray handle keeps the event loop alive.
 */
export async function stopProcessTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM', waitMs = 3000): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    if (process.platform === 'win32' && child.pid !== undefined) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10_000 });
    } else {
      child.kill(signal);
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, waitMs).unref())]);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}
