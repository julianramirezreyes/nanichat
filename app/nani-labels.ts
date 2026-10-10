/** Pure presentation helpers for Nani, the mascot (no React, unit tested). Everything derives from real app data. */

export type NaniState = 'sleep' | 'awake' | 'alert' | 'happy';

/**
 * alert = an account has a sync problem (always), or monitoring is on and something needs the operator;
 * sleep = monitoring off; awake otherwise.
 */
export function naniState(input: { monitoringEnabled: boolean; pendingFlags: number; reviewItems: number; accountProblems?: number }): Exclude<NaniState, 'happy'> {
  if ((input.accountProblems ?? 0) > 0) return 'alert';
  if (!input.monitoringEnabled) return 'sleep';
  return input.pendingFlags > 0 || input.reviewItems > 0 ? 'alert' : 'awake';
}

const NANI_LABELS: Record<NaniState, string> = {
  sleep: 'Nani está dormida: el monitoreo está apagado',
  awake: 'Nani está despierta: el monitoreo está encendido',
  alert: 'Nani te avisa: hay algo por revisar',
  happy: 'Nani está contenta: la acción salió bien',
};
export function naniLabel(state: NaniState): string { return NANI_LABELS[state]; }

type AutomationLike = { status: string; scope?: string; mediaId?: string | null; keywords?: Array<{ phrase: string }> };

/** Posts claimed by enabled automations; an enabled general (account-wide) automation watches every post. */
export function watchedPosts(rows: readonly AutomationLike[]): { all: boolean; count: number } {
  const enabled = rows.filter((row) => row.status === 'enabled');
  const media = new Set(enabled.filter((row) => row.scope !== 'account' && row.mediaId).map((row) => row.mediaId));
  return { all: enabled.some((row) => row.scope === 'account'), count: media.size };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Accounts whose last scan stopped with an error code; a scan the operator cancelled is not a problem. */
export function accountProblems(accounts: ReadonlyArray<{ username: string; last_error?: string | null }>): Array<{ username: string; error: string }> {
  return accounts.filter((account) => account.last_error && account.last_error !== 'scan_cancelled').map((account) => ({ username: account.username, error: account.last_error! }));
}

const ACCOUNT_ERROR_LABELS: Record<string, string> = {
  meta_rate_limited: 'Instagram me pidió esperar un rato antes de seguir leyendo',
  meta_timeout: 'Instagram tardó demasiado en responder',
  meta_network_error: 'No pude conectarme con Instagram',
  meta_permission_denied: 'El token no tiene permiso para leer comentarios',
  meta_invalid_identity: 'El token ya no corresponde a esta cuenta',
  account_scan_failed: 'No pude terminar de leer los comentarios',
};

/** Plain-language explanation of a scan stop code; never shows the raw code to the user. */
export function accountErrorLabel(code: string): string {
  return ACCOUNT_ERROR_LABELS[code] ?? 'No pude leer los comentarios. Revisa la conexión';
}

const COVERAGE_LABELS: Record<string, string> = { complete: 'revisión completa', incomplete: 'revisión incompleta', running: 'revisando ahora', cancelled: 'revisión cancelada' };

/** Plain-language label for the latest scan status. */
export function coverageLabel(status: string | null | undefined): string {
  return status ? COVERAGE_LABELS[status] ?? '' : '';
}

/** First-person hero sentence. `accent` is highlighted; `target` is where the alert button goes. */
export function heroCopy(input: { state: NaniState; watch: { all: boolean; count: number }; pendingFlags: number; reviewItems: number; problem?: { username: string; error: string } | null }): { lead: string; accent: string; tail: string; target: 'moderation' | 'queue' | 'connections' | null } {
  if (input.problem) return { lead: '', accent: `@${input.problem.username}`, tail: ` necesita atención: ${accountErrorLabel(input.problem.error)}.`, target: 'connections' };
  if (input.state === 'sleep') return { lead: 'Estoy dormida. ', accent: 'Despiértame', tail: ' y respondo por ti.', target: null };
  if (input.state === 'alert') {
    if (input.pendingFlags > 0) return { lead: 'Hay ', accent: plural(input.pendingFlags, 'comentario', 'comentarios'), tail: ' que debes revisar.', target: 'moderation' };
    return { lead: 'Hay ', accent: plural(input.reviewItems, 'envío', 'envíos'), tail: ' que debes revisar.', target: 'queue' };
  }
  return { lead: 'Estoy atenta a ', accent: input.watch.all ? 'todas tus publicaciones' : plural(input.watch.count, 'publicación', 'publicaciones'), tail: '.', target: null };
}

const fold = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/** Unique keyword phrases of enabled automations (case/accent-insensitive), in order of appearance. */
export function enabledKeywords(rows: readonly AutomationLike[]): string[] {
  const seen = new Set<string>(); const out: string[] = [];
  for (const row of rows) {
    if (row.status !== 'enabled') continue;
    for (const { phrase } of row.keywords ?? []) {
      const key = fold(phrase.trim());
      if (key && !seen.has(key)) { seen.add(key); out.push(phrase.trim()); }
    }
  }
  return out;
}

/** First keyword found in a comment (case/accent-insensitive); the slices keep the original text. */
export function findKeyword(text: string, keywords: readonly string[]): { before: string; match: string; after: string; keyword: string } | null {
  if (!text) return null;
  // NFD folding keeps one base letter per character for Spanish text, so indexes map back to the original string.
  const folded = Array.from(text).map((char) => fold(char) || char).join('');
  if (folded.length !== text.length) return null;
  let best: { index: number; keyword: string } | null = null;
  for (const keyword of keywords) {
    const needle = fold(keyword);
    if (!needle) continue;
    const index = folded.indexOf(needle);
    if (index >= 0 && (!best || index < best.index)) best = { index, keyword };
  }
  if (!best) return null;
  const end = best.index + fold(best.keyword).length;
  return { before: text.slice(0, best.index), match: text.slice(best.index, end), after: text.slice(end), keyword: best.keyword };
}

type QueueLike = { id: string; commentUsername?: string | null; commentText?: string; state: string; payload?: { text?: string } | null; createdAt: string };
export type FlowEntry = { id: string; username: string | null; text: string; reply: string | null; state: string; match: ReturnType<typeof findKeyword> };

/** Live flow rows from real queue items (already newest first): comment, matched keyword and the frozen reply text. */
export function flowEntries(items: readonly QueueLike[], keywords: readonly string[], limit: number): FlowEntry[] {
  return items.slice(0, limit).map((item) => {
    const text = item.commentText ?? '';
    return { id: item.id, username: item.commentUsername ?? null, text, reply: item.payload?.text ?? null, state: item.state, match: findKeyword(text, keywords) };
  });
}
