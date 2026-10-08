import { mediaLabel, type MediaLabelInput } from './media-label';

/** Select value for "Todas las publicaciones (general)"; never a real media ID (those are numeric provider IDs). */
export const GENERAL_MEDIA_OPTION = '__general__';

export type AutomationTarget = { scope: 'account'; mediaId: null } | { scope: 'media'; mediaId: string };

/** Maps the "Publicación" select value to the API payload fields (`scope` + `mediaId`). */
export function automationTargetPayload(selection: string): AutomationTarget {
  return selection === GENERAL_MEDIA_OPTION ? { scope: 'account', mediaId: null } : { scope: 'media', mediaId: selection };
}

/** Short Spanish label of what an automation targets: "Todas las publicaciones" or the publication label. */
export function automationTargetLabel(row: { scope?: string; mediaId: string | null }, media: Array<MediaLabelInput & { accountId?: string }>): string {
  if (row.scope === 'account' || row.mediaId === null) return 'Todas las publicaciones';
  const item = media.find((candidate) => candidate.mediaId === row.mediaId);
  return mediaLabel(item ?? { mediaId: row.mediaId });
}
