export type MediaLabelInput = { mediaId: string; caption?: string | null; mediaType?: string | null; publishedAt?: string | null };

const TYPE_LABELS: Record<string, string> = { VIDEO: 'Reel/Video', IMAGE: 'Foto', CAROUSEL_ALBUM: 'Carrusel' };

export function mediaTypeLabel(type?: string | null): string | null {
  return type && Object.hasOwn(TYPE_LABELS, type) ? TYPE_LABELS[type]! : null;
}

export function shortCaption(caption: string | null | undefined, max = 80): string | null {
  const flat = (caption ?? '').replace(/\s+/gu, ' ').trim();
  if (!flat) return null;
  const points = Array.from(flat);
  return points.length > max ? `${points.slice(0, max).join('').trimEnd()}…` : flat;
}

export function shortId(mediaId: string): string {
  return mediaId.length > 6 ? `…${mediaId.slice(-6)}` : mediaId;
}

/** "fecha · tipo · texto corto" for selects; legacy rows without caption read "Sin texto · <id corto>". */
export function mediaLabel(item: MediaLabelInput, captionMax = 50): string {
  const parts: string[] = [];
  if (item.publishedAt) parts.push(item.publishedAt.slice(0, 10));
  const type = mediaTypeLabel(item.mediaType);
  if (type) parts.push(type);
  const caption = shortCaption(item.caption, captionMax);
  parts.push(caption ?? `Sin texto · ${shortId(item.mediaId)}`);
  return parts.join(' · ');
}
