import { rmSync } from 'node:fs';

/**
 * Removes a test temp directory. On Windows a file that was just closed (SQLite db/WAL, lock files) can stay
 * briefly locked by the OS or an antivirus scanner, so removal retries with a short delay instead of failing
 * with EPERM/EBUSY. Close every database, server and handle BEFORE calling this: retries do not release handles.
 */
export function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * Collects cleanups for a node:test context and runs them in REVERSE registration order (LIFO), like a defer
 * stack. node:test runs `context.after` hooks in registration order (FIFO), so registering the temp-dir removal
 * first and `database.close()` later removes the directory while the database is still open (EPERM on Windows).
 */
export function cleanupStack(context: { after(fn: () => void | Promise<void>): void }): (cleanup: () => void | Promise<void>) => void {
  const cleanups: Array<() => void | Promise<void>> = [];
  context.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Multiple test cleanups failed');
  });
  return (cleanup) => { cleanups.push(cleanup); };
}
