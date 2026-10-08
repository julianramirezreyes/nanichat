import { normalizeMatchText } from './automations.ts';

/** Maximum number of rotating public reply variants per automation. */
export const PUBLIC_REPLY_MAX_VARIANTS = 50;
/** Maximum length of one variant template (after trimming). */
export const PUBLIC_REPLY_MAX_VARIANT_LENGTH = 300;
/** Maximum combined length of all variant templates of one automation. */
export const PUBLIC_REPLY_MAX_TOTAL_LENGTH = 10_000;
/** Number of most recent variants (per account) that are avoided when more variants than this exist. */
export const PUBLIC_REPLY_RECENT_WINDOW = 3;
/** Minimum spacing between public reply intents (tracked separately from private send spacing). */
export const PUBLIC_REPLY_SPACING_MS = 20_000;
/** A public reply is only attempted within this window after the accepted private reply. */
export const PUBLIC_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Maximum public attempts for provably unsent (rate-limited) failures before FAILED. */
export const PUBLIC_REPLY_MAX_ATTEMPTS = 3;
/** Rendered public reply text bound (template max plus variable expansion). */
export const PUBLIC_REPLY_MAX_RENDERED_LENGTH = 1000;

const VARIABLE = /\{\{([^{}]*)\}\}/gu;
const ALLOWED_VARIABLES = new Set(['username', 'keyword']);

/**
 * Validates the rotating public reply variants. Returns the trimmed list in the given order or throws a TypeError.
 * Never coerces: the value must be an array of strings. Rules: at most 50, each 1-300 characters after trimming,
 * distinct after normalization (case, accents, spacing), only `{{username}}` and `{{keyword}}` variables, no URLs,
 * and no literal @mentions other than `@{{username}}` (mass mentions look like spam).
 */
export function validatePublicReplyVariants(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('Public reply variants must be a list');
  if (value.length > PUBLIC_REPLY_MAX_VARIANTS) throw new TypeError('Too many public reply variants');
  const result: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of value) {
    if (typeof entry !== 'string') throw new TypeError('Public reply variants must be text');
    const variant = entry.trim();
    if (!variant || variant.length > PUBLIC_REPLY_MAX_VARIANT_LENGTH) throw new TypeError('Public reply variant is empty or too long');
    assertVariantTemplate(variant);
    const normalized = normalizeMatchText(variant);
    if (seen.has(normalized)) throw new TypeError('Public reply variants must be distinct');
    seen.add(normalized);
    total += variant.length;
    if (total > PUBLIC_REPLY_MAX_TOTAL_LENGTH) throw new TypeError('Public reply variants are too long in total');
    result.push(variant);
  }
  return result;
}

function assertVariantTemplate(variant: string): void {
  for (const match of variant.matchAll(VARIABLE)) {
    if (!ALLOWED_VARIABLES.has(match[1]!)) throw new TypeError('Unsupported public reply variable');
  }
  const withoutVariables = variant.replace(VARIABLE, '');
  if (/\{\{|\}\}/u.test(withoutVariables)) throw new TypeError('Malformed public reply variable');
  if (/https?:\/\/|www\./iu.test(variant)) throw new TypeError('Public reply variants cannot contain links');
  // Only a literal @{{username}} mention is allowed; any other @handle is rejected.
  if (/@(?!\{\{username\}\})/u.test(variant)) throw new TypeError('Public reply variants can only mention @{{username}}');
}

/** Renders a variant template; only username and keyword are substituted. */
export function renderPublicReply(template: string, variables: { username: string; keyword: string }): string {
  const text = template.replace(VARIABLE, (_whole, name: string) => {
    if (name === 'username') return variables.username;
    if (name === 'keyword') return variables.keyword;
    throw new TypeError('Unsupported public reply variable');
  });
  if (/\{\{|\}\}/u.test(text)) throw new TypeError('Malformed public reply variable');
  if (!text.trim() || text.length > PUBLIC_REPLY_MAX_RENDERED_LENGTH) throw new TypeError('Public reply is empty or too long');
  return text.trim();
}

/**
 * Picks one variant. `recent` holds previously used variant templates for the account, most recent first.
 * With more than PUBLIC_REPLY_RECENT_WINDOW variants, the last PUBLIC_REPLY_RECENT_WINDOW used are avoided; otherwise
 * only the immediately previous one is (a single variant necessarily repeats). Comparison is normalized.
 * `rng` returns a number in [0, 1) and is injectable for deterministic tests.
 */
export function selectPublicReplyVariant(variants: string[], recent: string[], rng: () => number = Math.random): string {
  if (!variants.length) throw new TypeError('At least one public reply variant is required');
  const window = variants.length > PUBLIC_REPLY_RECENT_WINDOW ? PUBLIC_REPLY_RECENT_WINDOW : 1;
  const avoid = new Set(recent.slice(0, window).map(normalizeMatchText));
  const candidates = variants.filter((variant) => !avoid.has(normalizeMatchText(variant)));
  const pool = candidates.length ? candidates : variants;
  const raw = rng();
  const unit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999) : 0;
  return pool[Math.floor(unit * pool.length)]!;
}

/** Parses a stored variants JSON column defensively (invalid stored data means "no variants"). */
export function storedPublicReplyVariants(json: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(json ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '') : [];
  } catch {
    return [];
  }
}
