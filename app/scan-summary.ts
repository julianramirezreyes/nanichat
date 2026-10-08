export type ScanProgressDto = { mediaDone: number; mediaTotal: number; pagesRead: number; commentsSeen: number; currentStartedAt?: string };

function thousands(value: number): string {
  return String(Math.max(0, Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/gu, '.');
}

export function progressText(progress: ScanProgressDto): string {
  if (progress.mediaTotal <= 0) return 'Preparando análisis…';
  const current = Math.min(progress.mediaDone + 1, progress.mediaTotal);
  const comments = progress.commentsSeen === 1 ? 'comentario leído' : 'comentarios leídos';
  return `Publicación ${current} de ${progress.mediaTotal} · ${thousands(progress.commentsSeen)} ${comments}`;
}

export function progressPercent(progress: ScanProgressDto): number {
  if (progress.mediaTotal <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((progress.mediaDone / progress.mediaTotal) * 100)));
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

export type ScanSummary = {
  commentsRead: number; eligible: number; expired: number; replies: number; review: number; ownerReplied: number; incompleteReports: number; failedAccounts: number;
};

/** Summarizes a finished backlog job result using only existing report fields. */
export function summarizeScan(result: unknown): ScanSummary {
  const summary: ScanSummary = { commentsRead: 0, eligible: 0, expired: 0, replies: 0, review: 0, ownerReplied: 0, incompleteReports: 0, failedAccounts: 0 };
  if (!Array.isArray(result)) return summary;
  for (const entry of result as any[]) {
    if (entry?.status === 'error') summary.failedAccounts++;
    const scan = entry?.result;
    if (!scan) continue;
    summary.expired += Number(scan.expiredCount) || 0;
    for (const report of scan.reports ?? []) {
      summary.commentsRead += Number(report.commentsSeen) || 0;
      if (report.status === 'incomplete') summary.incompleteReports++;
      for (const candidate of report.candidates ?? []) {
        if (candidate.eligible) summary.eligible++;
        else if (candidate.reason === 'reply_thread') summary.replies++;
        else if (candidate.reason === 'owner_replied') { summary.review++; summary.ownerReplied++; }
        else if (candidate.reason !== 'expired' && candidate.reason !== 'no_keyword_match') summary.review++;
      }
    }
  }
  return summary;
}

const REASON_LABELS: Record<string, string> = {
  owner_replied: 'Ya respondido por la cuenta',
};

/** Spanish label for a classification reason code; unknown codes are returned unchanged. */
export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}
