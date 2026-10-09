/**
 * Follow gate resource attachment (one media by public HTTPS URL): presentation helpers without side effects. The
 * server validates strictly (https, no credentials, no local/private hosts, follow gate required).
 */

export type AttachmentKindValue = '' | 'image' | 'audio' | 'video' | 'file';

export const ATTACHMENT_OPTIONS: ReadonlyArray<{ value: AttachmentKindValue; label: string }> = [
  { value: '', label: 'Sin adjunto' },
  { value: 'image', label: 'Imagen' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
  { value: 'file', label: 'PDF' },
];

export const ATTACHMENT_LABEL = 'Adjunto del recurso (opcional)';
export const ATTACHMENT_HELP = 'Enlace HTTPS público y directo al archivo (al abrirlo debe descargarse o verse el archivo, no una página). '
  + 'Los enlaces para compartir de Google Drive o Dropbox no sirven: use un enlace de descarga directa. Meta descarga el archivo desde sus servidores; '
  + 'esta aplicación no lo descarga ni lo aloja. Formatos según Meta: imagen png o jpeg (hasta 8 MB); audio aac, m4a, wav o mp4; '
  + 'video mp4, ogg, avi, mov o webm; PDF (hasta 25 MB cada uno). Se envía como un mensaje aparte, justo antes del texto con los botones.';
export const ATTACHMENT_BUTTON_TIP = 'Consejo: el botón de «Pedir primero que me sigan» también sirve simplemente como «Toca para recibir tu audio/PDF»: '
  + 'escriba el «Mensaje previo» y el título del botón en ese sentido.';

const KIND_NAMES: Record<string, { badge: string; article: string }> = {
  image: { badge: 'imagen', article: 'una imagen' },
  audio: { badge: 'audio', article: 'un audio' },
  video: { badge: 'video', article: 'un video' },
  file: { badge: 'PDF', article: 'un PDF' },
};

/** Card badge, e.g. «Adjunto: audio»; null without an attachment. */
export function attachmentBadge(kind: string | undefined | null): string | null {
  const name = kind ? KIND_NAMES[kind] : undefined;
  return name ? `Adjunto: ${name.badge}` : null;
}

/** Request fields for POST/PUT /api/automations. With the gate off nothing is sent (a stored draft is kept). */
export function attachmentRequestFields(gateEnabled: boolean, kind: string, url: string): { resourceAttachmentKind?: string; resourceAttachmentUrl?: string } {
  if (!gateEnabled) return {};
  return kind ? { resourceAttachmentKind: kind, resourceAttachmentUrl: url.trim() } : { resourceAttachmentKind: '', resourceAttachmentUrl: '' };
}

function parse(url: string): URL | null {
  try { return new URL(url.trim()); } catch { return null; }
}

/** Non-blocking warnings: undocumented formats and share pages that are not direct downloads. */
export function attachmentWarnings(kind: string, url: string): string[] {
  const parsed = parse(url);
  if (!kind || !parsed) return [];
  const warnings: string[] = [];
  const path = parsed.pathname.toLowerCase();
  if (kind === 'audio' && path.endsWith('.mp3')) warnings.push('Meta documenta aac, m4a, wav y mp4; mp3 no está documentado.');
  if (kind === 'image' && path.endsWith('.gif')) warnings.push('Meta documenta png y jpeg para imágenes; gif no está documentado.');
  const host = parsed.hostname.toLowerCase();
  const share = (host === 'drive.google.com' && !parsed.pathname.startsWith('/uc')) || host === 'docs.google.com'
    || ((host === 'dropbox.com' || host.endsWith('.dropbox.com')) && parsed.searchParams.get('dl') !== '1' && parsed.searchParams.get('raw') !== '1');
  if (share) warnings.push('Parece un enlace para compartir, no de descarga directa: Meta podría no poder descargar el archivo.');
  return warnings;
}

/** Short display of an attachment URL: host and file name (never the whole query). */
export function describeAttachment(_kind: string, url: string): string {
  const parsed = parse(url);
  if (!parsed) return url.slice(0, 60);
  const file = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).at(-1) ?? '');
  return file ? `${parsed.hostname} · ${file}` : parsed.hostname;
}

/** First follow-up line of the two-message preview. */
export function attachmentPreviewLine(kind: string, url: string): string {
  return `Mensaje 1: se enviaría ${KIND_NAMES[kind]?.article ?? 'un adjunto'} (${describeAttachment(kind, url)})`;
}

const PART_STATES: Record<string, string> = {
  pending: 'Pendiente', sending: 'Enviando', rejected: 'Rechazado por Meta', accepted: 'Aceptado por Meta',
  skipped: 'Omitido', ambiguous: 'Resultado desconocido',
};

export function attachmentPartStateLabel(state: string): string {
  return PART_STATES[state] ?? state;
}

const ERROR_HINTS: Record<string, string> = {
  attachment_failed: 'Meta rechazó el adjunto; se envió solo el texto.',
  attachment_state_inconsistent: 'Estado del adjunto inconsistente: revise en Instagram qué llegó. Nunca se reintenta.',
};

export function attachmentErrorHint(code: string | null | undefined): string | null {
  return code ? ERROR_HINTS[code] ?? null : null;
}

/** Spanish label of the API code `attachment_retired` (the attachment is retired together with the follow gate). */
export const ATTACHMENT_RETIRED_LABEL = 'Esta opción está desactivada: Meta no permite entregar el adjunto después del toque del botón con esta aplicación. '
  + 'Para entregar un audio o un video, ponlo en tu página y enlázalo con un botón de enlace.';

/** Spanish labels of the API validation codes. */
export const ATTACHMENT_ERROR_LABELS: Record<string, string> = {
  attachment_retired: ATTACHMENT_RETIRED_LABEL,
  attachment_invalid: 'Revise el «Adjunto del recurso»: elija Imagen, Audio, Video o PDF (o «Sin adjunto» con la URL vacía).',
  attachment_url_invalid: 'La URL del adjunto debe ser un enlace HTTPS público y directo (sin usuario ni contraseña, sin localhost, direcciones IP ni nombres de red local), de hasta 2048 caracteres.',
  attachment_requires_follow_gate: 'El adjunto solo se envía después del botón: active «Pedir primero que me sigan» para usarlo.',
};
