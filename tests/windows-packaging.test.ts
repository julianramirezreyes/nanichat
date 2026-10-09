// Pure helpers of the Windows installer build (packaging/windows). The PowerShell launcher, the Inno Setup script
// and the real Windows run are verified by the GitHub Actions workflow (.github/workflows/windows-installer.yml).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import test from 'node:test';

type ZipEntry = { name: string; method: number; crc32: number; compressedSize: number; size: number; isDirectory: boolean };
type ZipModule = {
  readZipEntries(zip: Buffer): ZipEntry[];
  extractEntry(zip: Buffer, entry: ZipEntry): Buffer;
};
type ReleaseModule = {
  nodeVersionFromEngines(range: string | undefined): string;
  resolvePortableNodeVersion(manifest: { engines?: { node?: string } }, env: Record<string, string | undefined>): string;
  expectedSha256(shasums: string, fileName: string): string;
};
type IconModule = { createIco(sizes: readonly number[]): Buffer };
type RulesModule = {
  APP_ENTRIES: readonly string[];
  isExcludedFromNextBuild(relativePath: string): boolean;
  isPrunedFromNodeModules(relativePath: string): boolean;
};

// Variable specifiers keep these plain .mjs modules (run by node on the CI runner) out of the TypeScript program.
async function load<T>(relativePath: string): Promise<T> {
  return import(pathToFileURL(resolve(relativePath)).href) as Promise<T>;
}

/** Builds a small ZIP archive in memory (stored and deflated entries) in the layout the official Node.js zip uses. */
function buildZip(files: Array<{ name: string; data: Buffer; deflate: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const body = file.deflate ? deflateRawSync(file.data) : file.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(file.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(file.deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(file.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('the ZIP reader lists and extracts stored and deflated entries, verifying size and CRC-32', async () => {
  const { readZipEntries, extractEntry } = await load<ZipModule>('packaging/windows/lib/zip.mjs');
  const executable = Buffer.from('MZ fake node.exe '.repeat(2000));
  const license = Buffer.from('license text');
  const zip = buildZip([
    { name: 'node-v24.21.0-win-x64/', data: Buffer.alloc(0), deflate: false },
    { name: 'node-v24.21.0-win-x64/node.exe', data: executable, deflate: true },
    { name: 'node-v24.21.0-win-x64/LICENSE', data: license, deflate: false },
  ]);
  const entries = readZipEntries(zip);
  assert.deepEqual(entries.map((entry) => [entry.name, entry.isDirectory]), [
    ['node-v24.21.0-win-x64/', true], ['node-v24.21.0-win-x64/node.exe', false], ['node-v24.21.0-win-x64/LICENSE', false],
  ]);
  assert.deepEqual(extractEntry(zip, entries[1]!), executable);
  assert.deepEqual(extractEntry(zip, entries[2]!), license);
});

test('the ZIP reader rejects corrupted data instead of writing a broken runtime', async () => {
  const { readZipEntries, extractEntry } = await load<ZipModule>('packaging/windows/lib/zip.mjs');
  const data = Buffer.from('payload that will be corrupted');
  const zip = buildZip([{ name: 'a/node.exe', data, deflate: false }]);
  const entry = readZipEntries(zip)[0]!;
  const corrupted = Buffer.from(zip);
  corrupted[30 + 'a/node.exe'.length] ^= 0xff;
  assert.throws(() => extractEntry(corrupted, entry), /CRC-32 mismatch/u);
  assert.throws(() => readZipEntries(Buffer.from('not a zip file at all, definitely not')), /end of central directory/u);
});

test('the portable Node.js version comes from package.json engines unless explicitly overridden', async () => {
  const { nodeVersionFromEngines, resolvePortableNodeVersion } = await load<ReleaseModule>('packaging/windows/lib/node-release.mjs');
  assert.equal(nodeVersionFromEngines('>=24.21.0'), '24.21.0');
  assert.equal(nodeVersionFromEngines(' >= 24.21.3 '), '24.21.3');
  assert.throws(() => nodeVersionFromEngines('^24'), /engines\.node/u);
  assert.throws(() => nodeVersionFromEngines(undefined), /engines\.node/u);
  const manifest = { engines: { node: '>=24.21.0' } };
  assert.equal(resolvePortableNodeVersion(manifest, {}), '24.21.0');
  assert.equal(resolvePortableNodeVersion(manifest, { PORTABLE_NODE_VERSION: 'v24.22.1' }), '24.22.1');
  assert.throws(() => resolvePortableNodeVersion(manifest, { PORTABLE_NODE_VERSION: '24.1.0' }), /older than/u);
  assert.throws(() => resolvePortableNodeVersion(manifest, { PORTABLE_NODE_VERSION: 'latest' }), /PORTABLE_NODE_VERSION/u);
});

test('the expected SHA-256 is read from the exact file line of SHASUMS256.txt', async () => {
  const { expectedSha256 } = await load<ReleaseModule>('packaging/windows/lib/node-release.mjs');
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  const shasums = `${a}  node-v24.21.0-win-x64.7z\n${b}  node-v24.21.0-win-x64.zip\n${a}  node-v24.21.0-win-x64.zip.extra\n`;
  assert.equal(expectedSha256(shasums, 'node-v24.21.0-win-x64.zip'), b);
  assert.throws(() => expectedSha256(shasums, 'node-v24.21.0-win-arm64.zip'), /not listed/u);
  assert.throws(() => expectedSha256(`${b}  x.zip\n${a}  x.zip\n`, 'x.zip'), /more than once/u);
});

test('the payload keeps only runtime files: no build cache, traces, SWC, sharp or source maps', async () => {
  const { APP_ENTRIES, isExcludedFromNextBuild, isPrunedFromNodeModules } = await load<RulesModule>('packaging/windows/lib/payload-rules.mjs');
  for (const required of ['.next', 'scripts', 'server.ts', 'src', 'next.config.mjs', 'package.json', 'package-lock.json']) {
    assert.ok(APP_ENTRIES.includes(required), `${required} is part of the app payload`);
  }
  for (const forbidden of ['data', 'tests', 'docs', '.git', 'node_modules', '.env', 'next.config.ts']) {
    assert.equal(APP_ENTRIES.includes(forbidden), false, `${forbidden} is never copied`);
  }
  for (const excluded of ['cache', join('cache', 'images', 'x'), 'trace', 'trace-build', 'dev', join('dev', 'x.js')]) {
    assert.equal(isExcludedFromNextBuild(excluded), true, excluded);
  }
  for (const kept of ['BUILD_ID', join('server', 'app', 'page.js'), join('static', 'chunks', 'a.js'), 'routes-manifest.json']) {
    assert.equal(isExcludedFromNextBuild(kept), false, kept);
  }
  for (const pruned of [
    join('@next', 'swc-win32-x64-msvc'), join('@next', 'swc-linux-x64-gnu', 'next-swc.node'), 'sharp', join('@img', 'sharp-win32-x64'),
    join('next', 'dist', 'server', 'next.js.map'), join('next', 'dist', 'docs'), join('react', 'README.md'), join('tsx', 'dist', 'index.d.ts'),
  ]) {
    assert.equal(isPrunedFromNodeModules(pruned), true, pruned);
  }
  for (const kept of [
    join('next', 'dist', 'server', 'next.js'), join('tsx', 'dist', 'esm', 'api', 'index.mjs'), join('@esbuild', 'win32-x64', 'esbuild.exe'),
    join('@next', 'env', 'dist', 'index.js'), join('react', 'LICENSE'), join('next', 'package.json'),
  ]) {
    assert.equal(isPrunedFromNodeModules(kept), false, kept);
  }
});

test('the generated application icon is a valid multi-size ICO with 32-bit images', async () => {
  const { createIco } = await load<IconModule>('packaging/windows/lib/icon.mjs');
  const sizes = [16, 32, 48, 256];
  const ico = createIco(sizes);
  assert.equal(ico.readUInt16LE(0), 0, 'reserved');
  assert.equal(ico.readUInt16LE(2), 1, 'type 1 = icon');
  assert.equal(ico.readUInt16LE(4), sizes.length);
  sizes.forEach((size, index) => {
    const directory = 6 + index * 16;
    assert.equal(ico.readUInt8(directory), size === 256 ? 0 : size, 'width (0 means 256)');
    assert.equal(ico.readUInt16LE(directory + 6), 32, 'bits per pixel');
    const length = ico.readUInt32LE(directory + 8);
    const offset = ico.readUInt32LE(directory + 12);
    assert.ok(offset + length <= ico.length, 'image inside the file');
    assert.equal(ico.readUInt32LE(offset), 40, 'BITMAPINFOHEADER');
    assert.equal(ico.readInt32LE(offset + 4), size);
    assert.equal(ico.readInt32LE(offset + 8), size * 2, 'height counts the AND mask');
    const maskRow = Math.ceil(size / 32) * 4;
    assert.equal(length, 40 + size * size * 4 + maskRow * size);
  });
  // Opaque corners are transparent (rounded square), the center is opaque.
  const offset = ico.readUInt32LE(6 + 1 * 16 + 12);
  const alphaAt = (x: number, y: number): number => ico.readUInt8(offset + 40 + ((31 - y) * 32 + x) * 4 + 3);
  assert.equal(alphaAt(0, 0), 0);
  assert.equal(alphaAt(16, 16), 255);
});

test('Windows scripts with Spanish text are UTF-8 with BOM (Windows PowerShell 5.1 reads BOM-less files as ANSI)', () => {
  for (const file of ['launcher/launch.ps1', 'launcher/stop.ps1', 'test/smoke.ps1', 'SocialDesk.iss']) {
    const bytes = readFileSync(join('packaging', 'windows', file));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${file} starts with a UTF-8 BOM`);
  }
});

test('the installer never deletes user data and keeps a fixed AppId for in-place upgrades', () => {
  const script = readFileSync(join('packaging', 'windows', 'SocialDesk.iss'), 'utf8');
  assert.match(script, /^AppId=\{\{6F1E2D3C-4B5A-4E69-8D7C-1A2B3C4D5E6F\}$/mu);
  assert.match(script, /^PrivilegesRequired=lowest$/mu);
  const section = /\[UninstallDelete\]([\s\S]*?)\n\[/u.exec(script)?.[1] ?? '';
  const uninstallDelete = section.split('\n').filter((line) => line.startsWith('Type:')).join('\n');
  assert.ok(uninstallDelete.length > 0, '[UninstallDelete] section found');
  assert.doesNotMatch(uninstallDelete, /SocialDesk\\data|SocialDesk\\logs|Name: "\{localappdata\}\\SocialDesk"/u);
  assert.doesNotMatch(uninstallDelete, /filesandordirs; Name: "\{app\}"/u, 'never a recursive delete of the whole install folder');
  assert.doesNotMatch(script, /DelTree/u, 'no recursive deletes from [Code]');
});
