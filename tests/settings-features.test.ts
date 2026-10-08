import assert from 'node:assert/strict';
import test from 'node:test';
import { DISABLED_FEATURES, ENV_IMPORT_DISABLED_HINT, legacyPanelAccounts, parseFeatures } from '../app/settings-features.ts';

test('features default to disabled for anything that is not an explicit true', () => {
  assert.deepEqual(parseFeatures(undefined), DISABLED_FEATURES);
  assert.deepEqual(parseFeatures({ envImport: 'yes', legacyInterlock: 1 }), DISABLED_FEATURES);
  assert.deepEqual(parseFeatures({ envImport: true, legacyInterlock: false }), { envImport: true, legacyInterlock: false });
});

test('the legacy panel lists every account only when the interlock is configured, otherwise only legacy-held accounts', () => {
  const accounts = [
    { accountId: 'a', sendHoldReason: null },
    { accountId: 'b', sendHoldReason: 'legacy_historical_rejection' },
    { accountId: 'c', sendHoldReason: 'other_reason' },
  ];
  assert.deepEqual(legacyPanelAccounts({ envImport: false, legacyInterlock: true }, accounts).map((item) => item.accountId), ['a', 'b', 'c']);
  assert.deepEqual(legacyPanelAccounts(DISABLED_FEATURES, accounts).map((item) => item.accountId), ['b']);
  const unheld: Array<{ accountId: string; sendHoldReason?: string | null }> = [{ accountId: 'a' }];
  assert.deepEqual(legacyPanelAccounts(DISABLED_FEATURES, unheld), []);
});

test('the disabled .env import hint names the variable that enables it', () => {
  assert.match(ENV_IMPORT_DISABLED_HINT, /SOCIAL_DESK_IMPORT_ENV_PATH/);
  assert.match(ENV_IMPORT_DISABLED_HINT, /desactivad/i);
});
