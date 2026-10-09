/**
 * Follow gate (honor system): presentation helpers without side effects. Server-side validation is authoritative.
 * RETIRED (2026-10-09): the form no longer offers the gate; these helpers remain for the dormant code and to keep
 * historical sessions readable in «Cola e historial».
 */

/** Spanish label of the API code `follow_gate_retired`. */
export const FOLLOW_GATE_RETIRED_LABEL = 'Esta opción está desactivada: Meta no permite entregar el recurso después del toque del botón con esta aplicación.';
/** One neutral line near the URL buttons of the form (no feature promises). */
export const MEDIA_LINK_TIP = 'Para entregar un audio o un video, ponlo en tu página y enlázalo con un botón de enlace.';

/** The «Seguimiento» block of a queue item is shown only for a historical session, never for a bare payload snapshot. */
export function showFollowGateDetail(item: { followGate?: unknown; payload?: unknown }): boolean {
  return Boolean(item.followGate);
}

export const FOLLOW_GATE_DEFAULT_TITLE = 'Ya te sigo';
export const FOLLOW_GATE_DEFAULT_MESSAGE = '¡Hola {{username}}! Antes de enviarte el recurso, sígueme y luego toca el botón 👇';
export const FOLLOW_GATE_LABEL = 'Pedir primero que me sigan (sin comprobación)';
export const FOLLOW_GATE_BADGE = 'Pide seguir (sin comprobar)';
export const FOLLOW_GATE_NOTE = 'Meta no permite comprobar si la persona te sigue. El botón entrega el recurso al tocarlo, aunque no te siga. El mensaje del recurso es la «Respuesta» con sus botones URL de esta misma automatización.';
export const FOLLOW_GATE_TITLE_MAX = 20;
export const FOLLOW_GATE_MESSAGE_MAX = 640;

const SAMPLE_USERNAME = 'cliente_ejemplo';
const SAMPLE_KEYWORD = 'guía';
const VARIABLE = /\{\{([^{}]*)\}\}/gu;

/** Request fields for POST/PUT /api/automations (trimmed; an empty title falls back to the default). */
export function followGateRequestFields(enabled: boolean, message: string, buttonTitle: string): {
  followGateEnabled: boolean; followGateMessage: string; followGateButtonTitle: string;
} {
  return { followGateEnabled: enabled, followGateMessage: message.trim(), followGateButtonTitle: buttonTitle.trim() || FOLLOW_GATE_DEFAULT_TITLE };
}

const STATE_LABELS: Record<string, string> = {
  AWAITING_TAP: 'Esperando toque', RESOURCE_SENDING: 'Enviando recurso', COMPLETED: 'Recurso enviado', EXPIRED: 'Expirado',
  CANCELLED: 'Cancelado', FAILED: 'Falló', UNKNOWN_OUTCOME: 'Resultado desconocido',
};

/** Spanish state of a session; a recorded tap waiting for its send is shown as such. */
export function followGateStateLabel(state: string, tapAt?: string | null): string {
  if (state === 'AWAITING_TAP' && tapAt) return 'Toque recibido · enviando recurso';
  return STATE_LABELS[state] ?? state;
}

const EVENT_LABELS: Record<string, string> = {
  session_created: 'Mensaje con botón enviado', tap_detected: 'Toque detectado', resource_intent_recorded: 'Intención de envío registrada',
  resource_accepted: 'Recurso aceptado por Meta', resource_rejected: 'Meta rechazó el recurso', resource_ambiguous: 'Resultado desconocido del envío',
  expired: 'Expirado', cancelled: 'Cancelado', poll_error: 'Error al leer la conversación',
};

export function followGateEventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

const ERROR_HINTS: Record<string, string> = {
  igsid_unknown: 'No se conoce el identificador de la persona: no se puede leer su conversación. No se enviará el recurso.',
  automation_inactive: 'La automatización se pausó, archivó o perdió el permiso real antes del envío.',
  gate_no_tap_7d: 'La persona no tocó el botón en 7 días.',
  resource_window_elapsed: 'Pasaron más de 24 horas desde el toque: Meta ya no permite enviar el recurso.',
  process_interrupted_after_intent: 'La aplicación se detuvo durante el envío: revise en Instagram si llegó. Nunca se reintenta.',
  tap_already_used: 'Ese mensaje ya se usó como toque de otra sesión; se sigue esperando.',
  meta_4: 'Meta limitó temporalmente las consultas; se reintenta más tarde.',
  meta_10: 'Meta rechazó el envío (código 10). Con esta aplicación ocurre al enviar el recurso después del toque: Meta lo considera fuera de la ventana permitida.',
  follow_gate_retired: 'Función retirada: «Pedir primero que me sigan» se desactivó porque Meta no permite entregar el recurso después del toque del botón con esta aplicación. No se envía nada más.',
};

export function followGateErrorHint(code: string | null | undefined): string | null {
  return code ? ERROR_HINTS[code] ?? null : null;
}

function renderSample(template: string): string {
  return template.replace(VARIABLE, (whole, name: string) => name === 'username' ? SAMPLE_USERNAME : name === 'keyword' ? SAMPLE_KEYWORD
    : name === 'account' ? 'tu_cuenta' : name === 'media' ? 'la publicación' : name === 'comment' ? 'quiero la guía' : whole).trim();
}

/** Two-step preview with sample values: message 1 (gate + button) and message 2 (resource sent after the tap). */
export function followGatePreview(message: string, buttonTitle: string, replyText: string, buttons: Array<{ title: string; url: string }>): {
  first: { text: string; buttonTitle: string }; second: { text: string; buttons: Array<{ title: string; url: string }> };
} {
  return {
    first: { text: renderSample(message), buttonTitle: buttonTitle.trim() || FOLLOW_GATE_DEFAULT_TITLE },
    second: { text: renderSample(replyText), buttons: buttons.filter((button) => button.title.trim() && button.url.trim()) },
  };
}
