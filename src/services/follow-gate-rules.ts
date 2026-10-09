/**
 * Follow gate (honor system): pure rules shared by the provider, the engine and the queue. The gate never verifies
 * that the user follows the account (Meta answers "User consent is required" for the profile check); a tap on the
 * gate button simply releases the resource message.
 */

/**
 * CENTRAL SWITCH — the follow gate and its resource attachment are RETIRED (2026-10-09). With this polling-only app,
 * Meta rejects the follow-up send after the tap (HTTP 403, code 10, subcode 2534022 "This message is sent outside of
 * allowed window"), so a person who taps the button receives nothing. While this is false: the API rejects gate and
 * attachment requests (follow_gate_retired / attachment_retired), enqueue ignores stored gate/attachment rows, queued
 * gate payloads are SKIPPED, open sessions are CANCELLED without any Meta call, and the UI hides the options. The engine
 * stays in the code, dormant. Do NOT flip it without webhook-based tap handling and a live verification.
 */
export const FOLLOW_GATE_AVAILABLE = false;

/** Effective switch. `override` exists ONLY for tests (services take it as an option); production never passes it. */
export function followGateAvailable(override?: boolean): boolean {
  return override ?? FOLLOW_GATE_AVAILABLE;
}

/** Safe code of everything turned off by the retirement (API 400, skipped queue items, cancelled sessions). */
export const FOLLOW_GATE_RETIRED_CODE = 'follow_gate_retired';

const MINUTE = 60_000;
/** First conversation poll after the gate message was accepted. */
export const GATE_FIRST_POLL_MS = 20_000;
/** Without a tap the session expires this long after the gate message (no resource is ever sent). */
export const GATE_TAP_EXPIRY_MS = 7 * 24 * 60 * MINUTE;
/** Meta's messaging window: the resource can only be sent within 24 h after the user's message (the tap). */
export const GATE_RESOURCE_WINDOW_MS = 24 * 60 * MINUTE;
/** Sessions processed per scheduler tick (sequentially). */
export const GATE_MAX_SESSIONS_PER_TICK = 10;
/** Minimum spacing between consecutive Meta calls made by the gate engine. */
export const GATE_SPACING_MS = 500;
/**
 * Minimum time between the two follow-ups of a session with an attachment (the media, then the text + buttons), so
 * they are not fired back to back. Meta does not document an ordering guarantee between consecutive messages.
 */
export const GATE_PART_SPACING_MS = 1000;
/** Maximum resource send attempts (per part for sessions with an attachment); only provider throttling is retried. */
export const GATE_MAX_SEND_ATTEMPTS = 3;
/** Maximum message detail reads per poll. */
export const GATE_MAX_DETAIL_CALLS = 5;
/** A poll error never changes state; the next poll waits at least this long. */
export const GATE_POLL_ERROR_MIN_DELAY_MS = 2 * MINUTE;

/**
 * Comparison form of a message text and the button title: NFC, lowercase, trimmed, inner spaces collapsed and
 * leading/trailing characters that are not letters or numbers (punctuation, symbols, emoji) removed.
 */
export function normalizeTapText(value: string): string {
  return value.normalize('NFC')
    .toLocaleLowerCase('und')
    .replace(/[\s ]+/gu, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
}

/** Delay until the next poll: every 30 s for the first 10 minutes, every 2 minutes up to 2 hours, then every 10 minutes. */
export function nextGatePollDelay(gateSentAtMs: number, nowMs: number): number {
  const elapsed = nowMs - gateSentAtMs;
  if (elapsed < 10 * MINUTE) return 30_000;
  if (elapsed < 120 * MINUTE) return 2 * MINUTE;
  return 10 * MINUTE;
}

/** Opaque Instagram-scoped id (IGSID): bounded, simple charset. */
export function safeIgsid(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : undefined;
}
