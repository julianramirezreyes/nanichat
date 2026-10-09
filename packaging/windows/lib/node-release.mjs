// Which portable Node.js runtime the Windows installer ships, and how its official checksum is looked up.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

/** `>=24.21.0` -> `24.21.0`. Only a plain minimum is accepted so the shipped runtime is unambiguous. */
export function nodeVersionFromEngines(range) {
  const match = /^\s*>=\s*(\d+\.\d+\.\d+)\s*$/u.exec(range ?? '');
  if (!match) throw new Error(`package.json engines.node must be a plain minimum like ">=24.21.0" (found ${JSON.stringify(range)})`);
  return match[1];
}

/** PORTABLE_NODE_VERSION (optional, e.g. 24.22.1 or v24.22.1) overrides the engines minimum but never goes below it. */
export function resolvePortableNodeVersion(manifest, env) {
  const minimum = nodeVersionFromEngines(manifest.engines?.node);
  const override = env.PORTABLE_NODE_VERSION?.trim().replace(/^v/u, '');
  if (!override) return minimum;
  if (!SEMVER.test(override)) throw new Error(`PORTABLE_NODE_VERSION must look like 24.21.0 (found ${JSON.stringify(env.PORTABLE_NODE_VERSION)})`);
  if (compareVersions(override, minimum) < 0) {
    throw new Error(`PORTABLE_NODE_VERSION ${override} is older than the engines minimum ${minimum}`);
  }
  return override;
}

/** Returns the lowercase SHA-256 listed for exactly `fileName` in a Node.js SHASUMS256.txt. */
export function expectedSha256(shasums, fileName) {
  const matches = shasums.split(/\r?\n/u)
    .map((line) => /^([0-9a-f]{64})\s+\*?(\S+)\s*$/iu.exec(line))
    .filter((match) => match && match[2] === fileName);
  if (matches.length === 0) throw new Error(`${fileName} is not listed in SHASUMS256.txt`);
  if (matches.length > 1) throw new Error(`${fileName} appears more than once in SHASUMS256.txt`);
  return matches[0][1].toLowerCase();
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
