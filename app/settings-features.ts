/** Optional server features, reported by GET /api/settings/features. Both are opt-in through environment variables. */
export type Features = { envImport: boolean; legacyInterlock: boolean };

export const DISABLED_FEATURES: Features = { envImport: false, legacyInterlock: false };

export const ENV_IMPORT_DISABLED_HINT = 'Importación desactivada. Para usarla, defina la variable SOCIAL_DESK_IMPORT_ENV_PATH con la ruta del archivo .env y reinicie la aplicación.';

/** Anything other than an explicit `true` keeps a feature disabled. */
export function parseFeatures(value: unknown): Features {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { envImport: record.envImport === true, legacyInterlock: record.legacyInterlock === true };
}

/**
 * Accounts shown in the "Retención heredada" panel: all of them when the legacy interlock is configured; otherwise
 * only accounts still held by an earlier legacy configuration, so that hold can be reviewed and acknowledged.
 */
export function legacyPanelAccounts<T extends { sendHoldReason?: string | null }>(features: Features, accounts: T[]): T[] {
  if (features.legacyInterlock) return accounts;
  return accounts.filter((account) => account.sendHoldReason?.startsWith('legacy_'));
}
