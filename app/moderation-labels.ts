/** Pure presentation helpers for the Moderation tab (no React, unit tested). */

export const MODERATION_CATEGORY_LABELS: Record<string, string> = {
  blocked_term: 'Palabra prohibida',
  spam_link: 'Enlace',
  spam_phone: 'Teléfono',
  spam_mentions: 'Menciones masivas',
  spam_emoji: 'Emojis repetidos',
};

export const MODERATION_STATE_LABELS: Record<string, string> = {
  PENDING: 'Pendiente',
  DISMISSED: 'Descartado',
  SIMULATED: 'Simulado',
  HIDE_INTENT: 'Ocultando…',
  HIDDEN: 'Oculto',
  UNHIDE_INTENT: 'Mostrando…',
  VISIBLE: 'Visible',
  DELETE_INTENT: 'Borrando…',
  DELETED: 'Borrado',
  FAILED: 'Fallido',
  UNKNOWN_OUTCOME: 'Por revisar',
};

export function categoryLabel(category: string): string {
  return Object.hasOwn(MODERATION_CATEGORY_LABELS, category) ? MODERATION_CATEGORY_LABELS[category]! : category;
}

export function stateLabel(state: string): string {
  return Object.hasOwn(MODERATION_STATE_LABELS, state) ? MODERATION_STATE_LABELS[state]! : state;
}

/** The API returns `reasons` as an array of strings; anything else renders as empty instead of throwing. */
export function reasonsText(reasons: unknown): string {
  if (!Array.isArray(reasons)) return '';
  return reasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0).join(', ');
}

/**
 * Source states for each action. Mirrors the service tables (src/services/moderation.ts VALID_TRANSITIONS and the
 * dismiss state lists); a test keeps both in sync so the UI never offers an action the API would refuse with 409.
 */
export const ACTION_STATES = {
  hide: ['PENDING', 'VISIBLE', 'FAILED', 'SIMULATED'],
  unhide: ['HIDDEN', 'FAILED'],
  delete: ['PENDING', 'HIDDEN', 'VISIBLE', 'FAILED', 'SIMULATED'],
  dismiss: ['PENDING', 'FAILED', 'SIMULATED', 'UNKNOWN_OUTCOME'],
  bulkDismiss: ['PENDING', 'FAILED', 'SIMULATED'],
} as const satisfies Record<string, readonly string[]>;

export type ModerationUiAction = 'hide' | 'unhide' | 'delete' | 'dismiss';

const has = (list: readonly string[], state: string) => list.includes(state);

export function availableActions(state: string): Record<ModerationUiAction, boolean> {
  return {
    hide: has(ACTION_STATES.hide, state),
    unhide: has(ACTION_STATES.unhide, state),
    delete: has(ACTION_STATES.delete, state),
    dismiss: has(ACTION_STATES.dismiss, state),
  };
}

/** A bulk button is shown when at least one selected flag accepts the action (bulk dismiss excludes UNKNOWN_OUTCOME). */
export function bulkAllowed(action: ModerationUiAction, states: readonly string[]): boolean {
  const allowed = action === 'dismiss' ? ACTION_STATES.bulkDismiss : ACTION_STATES[action];
  return states.some((state) => has(allowed, state));
}

export type BulkResultView = { flagId: string; state: string; safeErrorCode?: string; error?: string };

const OUTCOME_WORDS: Array<[string, string, string]> = [
  // key, singular, plural
  ['HIDDEN', 'ocultado', 'ocultados'],
  ['VISIBLE', 'mostrado', 'mostrados'],
  ['DELETED', 'borrado', 'borrados'],
  ['DISMISSED', 'descartado', 'descartados'],
  ['SIMULATED', 'simulado', 'simulados'],
  ['FAILED', 'falló', 'fallaron'],
  ['UNKNOWN_OUTCOME', 'por revisar', 'por revisar'],
  ['invalid_state', 'sin cambios', 'sin cambios'],
  ['not_attempted', 'no intentado', 'no intentados'],
  ['rejected', 'rechazado', 'rechazados'],
];

/** "3 ocultados, 1 sin cambios" from the bulk endpoint results. */
export function bulkSummary(results: readonly BulkResultView[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    const key = result.error === 'invalid_state' || result.error === 'not_attempted' ? result.error
      : result.error ? 'rejected'
        : result.state;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = OUTCOME_WORDS
    .filter(([key]) => counts.has(key))
    .map(([key, one, many]) => `${counts.get(key)} ${counts.get(key) === 1 ? one : many}`);
  return parts.length ? parts.join(', ') : 'Sin cambios';
}
