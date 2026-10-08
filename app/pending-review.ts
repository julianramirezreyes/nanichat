export type ReplyButton = { title: string; url: string };
export type PendingItem = {
  accountId: string; commentId: string; automationId: string; automationName: string; scope?: 'media' | 'account';
  mediaId: string; mediaCaption?: string | null; mediaType?: string | null; mediaPublishedAt?: string | null; username: string;
  commentText: string; commentCreatedAt: string | null; matchedKeywords: string[]; analyzedAt: string | null;
  previewText: string | null; previewButtons: ReplyButton[];
};
export type PendingPage = { items: PendingItem[]; total: number; lastAnalyzedAt: string | null; limit: number; offset: number };

/**
 * Picks the automation to process with: keeps a still-valid current choice, otherwise auto-selects
 * only when exactly one enabled automation exists for the account. Never guesses between several.
 */
export function autoPickAutomation(rows: Array<{ automationId: string; accountId: string; status: string }>, accountId: string, current: string): string {
  if (!accountId) return '';
  const enabled = rows.filter((row) => row.accountId === accountId && row.status === 'enabled');
  if (current && enabled.some((row) => row.automationId === current)) return current;
  return enabled.length === 1 ? enabled[0]!.automationId : '';
}

/** Describes the message of a queue item; simulated items are explicitly marked as not sent. */
export function describeQueuePayload(item: { state: string; payload?: { text?: string; buttons?: ReplyButton[] } }): { label: string; text: string; buttons: ReplyButton[] } {
  const label = item.state === 'SIMULATED' ? 'WOULD_SEND · No se envió (modo prueba)'
    : item.state === 'SENT' ? 'Mensaje enviado'
      : item.state === 'QUEUED' ? 'Mensaje pendiente de envío' : 'Mensaje intentado';
  return { label, text: item.payload?.text ?? '', buttons: item.payload?.buttons ?? [] };
}
