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
  ai_engine_unavailable: 'El modelo local no está disponible en esta instalación.',
  ai_model_missing: 'Descargue el modelo local antes de usarlo.',
  ai_local_unavailable: 'El modelo local no pudo cargarse en este equipo (memoria insuficiente o archivo dañado). Pruebe con el modelo más pequeño o vuelva a descargarlo.',
  model_in_use: 'Ese modelo se está usando en una revisión. Deténgala antes de borrarlo.',
  model_installed: 'Ese modelo ya está instalado.',
  download_running: 'Ya hay una descarga en curso. Espere a que termine o cancélela.',
  download_not_running: 'No hay ninguna descarga en curso.',
  insufficient_disk: 'No hay espacio suficiente en el disco: se necesita el tamaño del modelo más 500 MB libres.',
  checksum_mismatch: 'El archivo descargado no coincide con el original y se borró. Vuelva a descargarlo.',
  download_host_rejected: 'La descarga intentó ir a un servidor no permitido y se detuvo.',
  download_timeout: 'La descarga dejó de avanzar. Vuelva a intentarlo: continuará donde quedó.',
  download_failed: 'No se pudo conectar para descargar el modelo. Revise la conexión a internet.',
  download_http_error: 'El servidor de descarga respondió con un error. Inténtelo más tarde.',
  download_write_failed: 'No se pudo guardar el archivo en el disco.',
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

// ---------- Local model (moderation PR 3) ----------

export const AI_LOCAL_PRIVACY_NOTE = 'Todo se procesa en este equipo; ningún comentario sale de él.';
export const AI_LOCAL_RESOURCE_NOTE = 'Mientras revisa, el modelo local usa memoria (RAM) y procesador: el equipo puede ir más lento durante la revisión.';

/** Card text per local model id (src/services/moderation-ai-local-model.ts LOCAL_MODELS). */
export const LOCAL_MODEL_INFO: Record<string, { title: string; detail: string }> = {
  'qwen2.5-1.5b': { title: 'Qwen2.5 1.5B', detail: 'Rápido · ~1 GB · recomendado para 8 GB de RAM' },
  'qwen3-4b': { title: 'Qwen3 4B', detail: 'Más preciso · ~2,5 GB · 16 GB de RAM recomendados' },
};

export type LocalModelEntryView = { id: string; installed: boolean; partialBytes: number; sizeBytes: number };
export type DownloadView = { model: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; receivedBytes: number; totalBytes: number; errorCode?: string };
export type LocalModelCardState = {
  kind: 'installed' | 'downloading' | 'idle' | 'failed' | 'cancelled';
  canDownload: boolean;
  canCancel: boolean;
  canDelete: boolean;
  downloadLabel: 'Descargar' | 'Reanudar descarga';
  percent?: number;
  progressText?: string;
  message?: string;
};

const MB = 1_000_000;

function percentOf(received: number, total: number): number {
  if (!(total > 0) || !(received > 0)) return 0;
  return Math.min(100, Math.floor((received / total) * 100));
}

/** "500 MB de 1117 MB (44 %)" */
export function downloadProgressText(progress: { receivedBytes: number; totalBytes: number }): string {
  const received = Math.floor((progress.receivedBytes || 0) / MB);
  const total = Math.round((progress.totalBytes || 0) / MB);
  return `${received} MB de ${total} MB (${percentOf(progress.receivedBytes, progress.totalBytes)} %)`;
}

/**
 * What a model card shows. Never throws: a missing download (null/undefined), a download of another model, unknown
 * states or error codes all map to a safe card. Only one download runs at a time, so a card cannot start while
 * another model downloads.
 */
export function localModelCardState(entry: LocalModelEntryView, download: DownloadView | null | undefined): LocalModelCardState {
  const busy = download?.state === 'running';
  const own = download && download.model === entry.id ? download : undefined;
  const downloadLabel = entry.partialBytes > 0 ? 'Reanudar descarga' : 'Descargar';
  if (own?.state === 'running') {
    return {
      kind: 'downloading', canDownload: false, canCancel: true, canDelete: false, downloadLabel,
      percent: percentOf(own.receivedBytes, own.totalBytes), progressText: downloadProgressText(own),
    };
  }
  if (entry.installed) return { kind: 'installed', canDownload: false, canCancel: false, canDelete: true, downloadLabel };
  if (own?.state === 'failed') {
    return {
      kind: 'failed', canDownload: !busy, canCancel: false, canDelete: entry.partialBytes > 0, downloadLabel,
      message: (own.errorCode && AI_ERROR_LABELS[own.errorCode]) || 'La descarga falló. Vuelva a intentarlo.',
    };
  }
  if (own?.state === 'cancelled') {
    return {
      kind: 'cancelled', canDownload: !busy, canCancel: false, canDelete: entry.partialBytes > 0, downloadLabel,
      message: entry.partialBytes > 0 ? `Descarga cancelada: ${downloadProgressText({ receivedBytes: entry.partialBytes, totalBytes: entry.sizeBytes })}.` : 'Descarga cancelada.',
    };
  }
  return { kind: 'idle', canDownload: !busy, canCancel: false, canDelete: false, downloadLabel };
}

/**
 * Whether "Revisar comentarios negativos" can run, and the hint shown when it cannot. While "Modelo local" is only
 * picked (no local model saved yet), the saved engine (maybe Gemini) must never run from this button.
 */
export function aiReviewGate(input: { savedEngine: string; localPicked: boolean; hasApiKey: boolean; localModelInstalled: boolean; running: boolean }): { canReview: boolean; hint: string } {
  if (input.localPicked) return { canReview: false, hint: 'Descargue un modelo y pulse «Usar este modelo» para revisar.' };
  if (input.savedEngine === 'local') {
    return input.localModelInstalled ? { canReview: !input.running, hint: '' } : { canReview: false, hint: 'Descargue el modelo local antes de revisar.' };
  }
  if (input.savedEngine === 'gemini') {
    return input.hasApiKey ? { canReview: !input.running, hint: '' } : { canReview: false, hint: 'Guarde una API key de Gemini antes de revisar.' };
  }
  return { canReview: false, hint: 'Active la revisión con IA para usar este botón.' };
}
