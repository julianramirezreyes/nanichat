import type { AttachmentKind, ResourceAttachment } from '../core/domain.ts';

/**
 * Follow gate resource attachment (one media by public HTTPS URL, sent as its own follow-up message before the text).
 * Meta downloads the file from its own servers, so the URL must be publicly reachable over HTTPS; this app never
 * fetches it. Formats/sizes are Meta's (image png/jpeg 8 MB; audio aac/m4a/wav/mp4, video mp4/ogg/avi/mov/webm and
 * file pdf 25 MB) and are NOT checked here.
 */
export const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['image', 'audio', 'video', 'file'];
export const ATTACHMENT_URL_MAX = 2048;

/** Names that can never be reached by Meta's servers (local, private or reserved suffixes). */
const PRIVATE_SUFFIXES = ['localhost', 'local', 'lan', 'home', 'internal', 'intranet', 'corp', 'arpa', 'test', 'invalid'];

export class ResourceAttachmentError extends TypeError {
  constructor(readonly code: 'attachment_invalid' | 'attachment_url_invalid' | 'attachment_requires_follow_gate', message: string) {
    super(message);
  }
}

export function isAttachmentKind(value: unknown): value is AttachmentKind {
  return typeof value === 'string' && (ATTACHMENT_KINDS as readonly string[]).includes(value);
}

/**
 * True for an absolute `https:` URL of at most 2048 characters, without user/password, whose hostname is a public-looking
 * DNS name: not an IP literal (IPv4 in any WHATWG-normalized form, or IPv6), not single-label, not localhost/.local/
 * .lan/.internal or other private/reserved suffixes. No whitespace or control characters are accepted.
 */
export function isPublicHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value || value.length > ATTACHMENT_URL_MAX || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  if (!host || host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/u.test(host)) return false;
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => !label)) return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Strict validation of the optional attachment. Omitted fields keep `current`; nothing is coerced. A kind requires a
 * valid URL, a URL requires a kind, and an attachment provided in this request requires the follow gate (attachments
 * only exist in follow-up messages). A stored attachment is kept as a draft while the gate is off.
 */
export function validateResourceAttachment(
  input: { kind?: unknown; url?: unknown },
  followGateEnabled: boolean,
  current: { kind: string; url: string } = { kind: '', url: '' },
): { kind: AttachmentKind | ''; url: string } {
  if (input.kind !== undefined && input.kind !== '' && !isAttachmentKind(input.kind)) {
    throw new ResourceAttachmentError('attachment_invalid', 'Attachment kind must be image, audio, video or file');
  }
  if (input.url !== undefined && typeof input.url !== 'string') throw new ResourceAttachmentError('attachment_url_invalid', 'Attachment URL must be text');
  const kind = (input.kind === undefined ? current.kind : input.kind) as string;
  const url = input.url === undefined ? (input.kind === undefined ? current.url : '') : (input.url as string).trim();
  if (kind === '') {
    if (url) throw new ResourceAttachmentError('attachment_invalid', 'An attachment URL requires an attachment kind');
    return { kind: '', url: '' };
  }
  if (!isAttachmentKind(kind)) throw new ResourceAttachmentError('attachment_invalid', 'Attachment kind must be image, audio, video or file');
  if (!isPublicHttpsUrl(url)) throw new ResourceAttachmentError('attachment_url_invalid', 'Attachment URL must be a public HTTPS URL');
  if (input.kind !== undefined && !followGateEnabled) {
    throw new ResourceAttachmentError('attachment_requires_follow_gate', 'An attachment is only sent after the follow gate button');
  }
  return { kind, url };
}

/** Defensive read of a stored attachment: anything invalid is treated as "no attachment". */
export function storedResourceAttachment(kind: unknown, url: unknown): ResourceAttachment | null {
  return isAttachmentKind(kind) && isPublicHttpsUrl(url) ? { kind, url: url as string } : null;
}
