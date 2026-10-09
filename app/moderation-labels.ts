/** Pure presentation helpers for the Moderation tab (no React, unit tested). */

export const MODERATION_CATEGORY_LABELS: Record<string, string> = {
  blocked_term: 'Palabra prohibida',
  spam_link: 'Enlace',
  spam_phone: 'Teléfono',
  spam_mentions: 'Menciones masivas',
  spam_emoji: 'Emojis repetidos',
  ai_insult: 'Insulto o acoso',
  ai_hate: 'Odio o discriminación',
  ai_spam: 'Spam o estafa',
  ai_complaint: 'Queja legítima',
};

/** Shown on every `ai_complaint` flag: it is never auto-hidden. */
export const AI_COMPLAINT_HINT = 'Queja legítima: conviene responder, no ocultar';

export const AI_PRIVACY_NOTICE = 'Con la API gratuita, Google puede usar el contenido enviado para mejorar sus productos. Los comentarios de sus clientes saldrán de este equipo. Para que nada salga del equipo use el modelo local.';

/** Auto-hide checkboxes. `ai_complaint` is deliberately absent (src/services/moderation.ts AUTO_HIDE_CATEGORIES). */
export const AUTO_HIDE_OPTIONS: ReadonlyArray<{ value: string; label: string; ai: boolean }> = [
  { value: 'blocked_term', label: 'Palabras prohibidas', ai: false },
  { value: 'spam_link', label: 'Enlaces', ai: false },
  { value: 'spam_phone', label: 'Teléfonos', ai: false },
  { value: 'spam_mentions', label: 'Menciones', ai: false },
  { value: 'spam_emoji', label: 'Emojis', ai: false },
  { value: 'ai_insult', label: 'Insultos (IA)', ai: true },
  { value: 'ai_hate', label: 'Odio (IA)', ai: true },
  { value: 'ai_spam', label: 'Spam o estafa (IA)', ai: true },
];

export const AI_WINDOW_LABELS: Record<string, string> = { '24h': '24 h', '3d': '3 días', '7d': '7 días', '30d': '30 días' };

export const AI_ERROR_LABELS: Record<string, string> = {
  ai_disabled: 'Active la revisión con IA para usar este botón.',
  ai_key_missing: 'Guarde una API key de Gemini antes de revisar.',
  ai_key_invalid: 'La API key no tiene un formato válido.',
  ai_model_invalid: 'Ese modelo no está disponible.',
  ai_engine_unavailable: 'El modelo local todavía no está disponible.',
  ai_job_running: 'Ya hay una revisión en curso para esta cuenta.',
  ai_job_not_running: 'No hay ninguna revisión en curso.',
  ai_rate_limited: 'Gemini alcanzó el límite de uso gratuito. Espere unos minutos y vuelva a intentarlo.',
  ai_auth_failed: 'Gemini rechazó la API key. Revísela o genere una nueva.',
  ai_request_rejected: 'Gemini rechazó la solicitud. Pruebe con otro modelo.',
  ai_unavailable: 'Gemini no respondió. Inténtelo más tarde.',
  ai_invalid_output: 'Gemini respondió algo que no se pudo leer.',
  ai_engine_error: 'La revisión se detuvo por un error inesperado.',
  ai_interrupted: 'La revisión se interrumpió porque la aplicación se reinició.',
  moderation_ai_unavailable: 'La revisión con IA no está disponible.',
};

export type AiProgressView = { chunksDone: number; chunksTotal: number; commentsSent: number; flagged: number; invalidOutput: number; chunksFailed?: number; commentsTotal?: number; truncated?: boolean };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Lote 3 de 10 · 120 comentarios enviados · 7 marcados" */
export function aiProgressText(progress: AiProgressView): string {
  return `Lote ${progress.chunksDone} de ${progress.chunksTotal} · ${plural(progress.commentsSent, 'comentario enviado', 'comentarios enviados')} · ${plural(progress.flagged, 'marcado', 'marcados')}`;
}

export function aiProgressPercent(progress: { chunksDone: number; chunksTotal: number }): number {
  if (!progress.chunksTotal) return 0;
  return Math.min(100, Math.round((progress.chunksDone / progress.chunksTotal) * 100));
}

/** One summary line for a finished job. */
export function aiJobSummary(job: { state: string; errorCode?: string; progress: AiProgressView }): string {
  const { progress } = job;
  const parts = [
    progress.truncated && progress.commentsTotal ? `${progress.commentsSent} de ${progress.commentsTotal} comentarios revisados (máximo por revisión)` : plural(progress.commentsSent, 'comentario revisado', 'comentarios revisados'),
    plural(progress.flagged, 'marcado', 'marcados'),
  ];
  if (progress.chunksFailed) parts.push(plural(progress.chunksFailed, 'lote sin respuesta', 'lotes sin respuesta'));
  if (progress.invalidOutput) parts.push(plural(progress.invalidOutput, 'respuesta ignorada', 'respuestas ignoradas'));
  const lead = job.state === 'completed' ? 'Revisión terminada' : job.state === 'stopped' ? 'Revisión detenida' : 'Revisión fallida';
  const reason = job.errorCode ? ` ${AI_ERROR_LABELS[job.errorCode] ?? ''}`.trimEnd() : '';
  return `${lead}: ${parts.join(' · ')}.${reason}`;
}

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
