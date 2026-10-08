/** Client-side helpers for the optional public reply. Server-side validation (src/services/public-reply.ts) is authoritative. */

export type PublicReplyDto = {
  state: string | null;
  text: string | null;
  attempts?: number;
  nextAt?: string | null;
  safeErrorCode?: string | null;
  replyId?: string | null;
  preview?: boolean;
};

export const PUBLIC_REPLY_SAMPLE_USERNAME = 'cliente_ejemplo';
const SAMPLE_KEYWORD = 'guía';
const VARIABLE = /\{\{([^{}]*)\}\}/gu;

/** One variant per non-empty line, trimmed. */
export function parseVariantLines(text: string): string[] {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

export function variantCountLabel(count: number): string {
  return `${count} ${count === 1 ? 'variante' : 'variantes'}`;
}

function renderSample(template: string): string | null {
  let valid = true;
  const text = template.replace(VARIABLE, (_whole, name: string) => {
    if (name === 'username') return PUBLIC_REPLY_SAMPLE_USERNAME;
    if (name === 'keyword') return SAMPLE_KEYWORD;
    valid = false;
    return '';
  });
  return valid && !/\{\{|\}\}/u.test(text) && text.trim() ? text.trim() : null;
}

/** Up to two distinct rendered examples picked with `rng` (variants with unsupported variables are ignored). */
export function previewExamples(variants: string[], rng: () => number = Math.random): string[] {
  const rendered = [...new Set(variants.map(renderSample).filter((text): text is string => text !== null))];
  const examples: string[] = [];
  while (rendered.length && examples.length < 2) {
    const index = Math.min(rendered.length - 1, Math.floor(Math.max(0, rng()) * rendered.length));
    examples.push(rendered.splice(index, 1)[0]!);
  }
  return examples;
}

const STATE_LABELS: Record<string, string> = {
  PENDING: 'Pendiente', SENDING: 'Enviando', SENT: 'Publicada', FAILED: 'Falló',
  UNKNOWN_OUTCOME: 'Resultado desconocido', SKIPPED: 'Omitida', EXPIRED: 'Expirada',
};

export function publicReplyStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

const ERROR_HINTS: Record<string, string> = {
  public_reply_permission_denied: 'Falta el permiso para responder comentarios en esta conexión',
  public_reply_rate_limited: 'Meta limitó temporalmente las respuestas; se reintentó con espera',
  public_reply_window_elapsed: 'Pasaron más de 24 horas desde el mensaje privado',
  public_reply_disabled: 'La respuesta pública se desactivó en la automatización',
  automation_unavailable: 'La automatización se pausó, archivó o perdió la autorización real',
  comment_not_owned: 'El comentario no pertenece a esta cuenta',
  process_interrupted_after_intent: 'El proceso se interrumpió durante la publicación',
};

export function publicReplyErrorHint(code?: string | null): string | undefined {
  return code ? ERROR_HINTS[code] : undefined;
}

/** Text shown in the queue 'Ver' panel; null when the item has no public reply at all. */
export function describePublicReply(item: { state: string; publicReply?: PublicReplyDto | null }):
  { label: string; text: string | null; hint?: string; canRetry: boolean } | null {
  const reply = item.publicReply;
  if (!reply || (!reply.state && !reply.text)) return null;
  if (!reply.state) {
    return { label: 'WOULD_REPLY_PUBLIC · No se publicó (modo prueba)', text: reply.text, canRetry: false };
  }
  const hint = publicReplyErrorHint(reply.safeErrorCode)
    ?? (reply.state === 'UNKNOWN_OUTCOME' ? 'Revise manualmente en Instagram; nunca se reintenta.' : undefined);
  return {
    label: `Respuesta pública · ${publicReplyStateLabel(reply.state)}`,
    text: reply.text,
    ...(hint ? { hint } : {}),
    canRetry: reply.state === 'FAILED',
  };
}
