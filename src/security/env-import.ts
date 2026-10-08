import { readFileSync } from 'node:fs';

const MAX_ENV_BYTES = 64 * 1024;
const INSTAGRAM_TOKEN_KEYS = ['INSTAGRAM_ACCESS_TOKEN', 'IG_ACCESS_TOKEN'] as const;
const FACEBOOK_TOKEN_KEYS = ['FACEBOOK_USER_ACCESS_TOKEN', 'FB_USER_ACCESS_TOKEN'] as const;

export type ImportedMetaEnvironment = {
  loginKind: 'instagram_login' | 'facebook_login';
  accessToken: string;
  appId?: string;
  graphVersion: string;
  name: string;
};

export function readImportedEnvironment(filePath: string): ImportedMetaEnvironment {
  const contents = readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(contents, 'utf8') > MAX_ENV_BYTES) throw new TypeError('Environment file exceeds the import limit');
  return parseImportedEnvironment(contents);
}

export function parseImportedEnvironment(contents: string): ImportedMetaEnvironment {
  if (Buffer.byteLength(contents, 'utf8') > MAX_ENV_BYTES) throw new TypeError('Environment text exceeds the import limit');
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    const key = match[1]!;
    if (!ALLOWED_KEYS.has(key)) continue;
    if (values.has(key)) throw new TypeError('Environment file contains duplicate allowlisted keys');
    values.set(key, unquote(match[2]!));
  }
  const loginKindValue = values.get('META_LOGIN_KIND') ?? 'instagram_login';
  if (loginKindValue !== 'instagram_login' && loginKindValue !== 'facebook_login') {
    throw new TypeError('Environment file specifies an unsupported login kind');
  }
  const keys = loginKindValue === 'instagram_login' ? INSTAGRAM_TOKEN_KEYS : FACEBOOK_TOKEN_KEYS;
  const candidates = keys.map((key) => values.get(key)).filter((value): value is string => Boolean(value?.trim()));
  if (candidates.length !== 1) throw new TypeError('Environment file has a missing or ambiguous token for its selected login kind');
  const graphVersion = values.get('GRAPH_API_VERSION') ?? 'v26.0';
  if (!/^v\d+\.\d+$/u.test(graphVersion)) throw new TypeError('Environment file contains an invalid Graph version');
  const appId = values.get('META_APP_ID') ?? values.get('INSTAGRAM_APP_ID');
  const name = values.get('IG_USERNAME') ?? values.get('INSTAGRAM_USERNAME') ?? 'Imported Meta connection';
  return {
    loginKind: loginKindValue,
    accessToken: candidates[0]!,
    ...(appId ? { appId } : {}),
    graphVersion,
    name: name.trim() || 'Imported Meta connection',
  };
}

const ALLOWED_KEYS = new Set([
  'META_LOGIN_KIND', 'INSTAGRAM_ACCESS_TOKEN', 'IG_ACCESS_TOKEN', 'FACEBOOK_USER_ACCESS_TOKEN',
  'FB_USER_ACCESS_TOKEN', 'META_APP_ID', 'INSTAGRAM_APP_ID', 'GRAPH_API_VERSION', 'IG_USERNAME', 'INSTAGRAM_USERNAME',
]);

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1);
  return trimmed;
}
