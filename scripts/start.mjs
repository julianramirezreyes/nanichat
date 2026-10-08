// Portable production start (Windows PowerShell/cmd, macOS, Linux): `npm start` or `node scripts/start.mjs`.
// NODE_ENV must be set before Next.js or any application module is loaded, which shell syntax such as
// `NODE_ENV=production tsx server.ts` only provides on Unix shells. The TypeScript entry is then loaded in this
// same process through tsx's programmatic API, so the application lock records this process and SIGINT/SIGTERM
// reach the server's own shutdown handlers directly.
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV = 'production';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const entry = process.argv[2] ? resolve(process.argv[2]) : resolve(projectRoot, 'server.ts');

// Same hooks as `node --import tsx`: .ts files in this (CommonJS-typed) package are loaded through require, so the
// CommonJS hook is needed too; the ESM hook alone fails on import cycles (ERR_REQUIRE_CYCLE_MODULE).
const { register: registerCommonJs } = await import('tsx/cjs/api');
const { register: registerEsm } = await import('tsx/esm/api');
registerCommonJs();
registerEsm();
await import(pathToFileURL(entry).href);
