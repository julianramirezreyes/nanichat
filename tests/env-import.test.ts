import assert from 'node:assert/strict';
import test from 'node:test';
import { parseImportedEnvironment } from '../src/security/env-import.ts';

test('environment import parser reads only allowlisted literal values and never evaluates shell syntax', () => {
  const imported = parseImportedEnvironment(`
    INSTAGRAM_ACCESS_TOKEN="safe-token-value"
    META_APP_ID=app-123
    GRAPH_API_VERSION=v26.0
    IG_USERNAME=brand
    IG_SECRET=$(touch /tmp/should-not-exist)
  `);
  assert.equal(imported.accessToken, 'safe-token-value');
  assert.equal(imported.appId, 'app-123');
  assert.equal(imported.graphVersion, 'v26.0');
  assert.equal(imported.name, 'brand');
  assert.equal(JSON.stringify(imported).includes('ignore-me'), false);
  assert.throws(() => parseImportedEnvironment('INSTAGRAM_ACCESS_TOKEN=one\nIG_ACCESS_TOKEN=two'), /ambiguous/i);
});
