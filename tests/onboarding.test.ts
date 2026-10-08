import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveOnboarding } from '../app/onboarding.ts';

const base = { connections: [], accounts: [], automations: [], monitoringEnabled: false };
const states = (input: Parameters<typeof deriveOnboarding>[0]) => deriveOnboarding(input).steps.map((step) => step.state);

test('empty installation: first step is current, the rest pending', () => {
  const result = deriveOnboarding(base);
  assert.deepEqual(result.steps.map((s) => s.id), ['connect', 'account', 'automation', 'monitor']);
  assert.deepEqual(states(base), ['current', 'pending', 'pending', 'pending']);
  assert.equal(result.allDone, false);
  assert.deepEqual(result.steps.map((s) => s.target), ['connections', 'connections', 'automations', 'monitor']);
});

test('an unvalidated connection does not complete step 1', () => {
  assert.deepEqual(states({ ...base, connections: [{ status: 'unvalidated' }] }), ['current', 'pending', 'pending', 'pending']);
});

test('a valid connection completes step 1 and makes the account step current', () => {
  assert.deepEqual(states({ ...base, connections: [{ status: 'valid' }] }), ['done', 'current', 'pending', 'pending']);
});

test('a selected account completes step 2', () => {
  assert.deepEqual(states({ ...base, connections: [{ status: 'valid' }], accounts: [{}] }), ['done', 'done', 'current', 'pending']);
});

test('an account without a valid connection still counts as connected (imported history)', () => {
  assert.deepEqual(states({ ...base, accounts: [{}] }), ['done', 'done', 'current', 'pending']);
});

test('archived automations do not count; any active or paused one does', () => {
  const withAccount = { ...base, connections: [{ status: 'valid' }], accounts: [{}] };
  assert.deepEqual(states({ ...withAccount, automations: [{ status: 'archived' }] }), ['done', 'done', 'current', 'pending']);
  assert.deepEqual(states({ ...withAccount, automations: [{ status: 'paused' }] }), ['done', 'done', 'done', 'current']);
});

test('all steps done when monitoring is running', () => {
  const result = deriveOnboarding({ connections: [{ status: 'valid' }], accounts: [{}], automations: [{ status: 'enabled' }], monitoringEnabled: true });
  assert.deepEqual(result.steps.map((s) => s.state), ['done', 'done', 'done', 'done']);
  assert.equal(result.allDone, true);
});

test('exactly one step is current while not all done', () => {
  const result = deriveOnboarding({ ...base, connections: [{ status: 'valid' }] });
  assert.equal(result.steps.filter((s) => s.state === 'current').length, 1);
});

test('showOnboarding stays visible when the filter is the only account (auto-selected) but hides for a deliberate one among several', async () => {
  const { showOnboarding } = await import('../app/onboarding.ts');
  assert.equal(showOnboarding({ allDone: false, filter: 'all', accountCount: 3 }), true);
  assert.equal(showOnboarding({ allDone: false, filter: 'a1', accountCount: 1 }), true);
  assert.equal(showOnboarding({ allDone: false, filter: 'a1', accountCount: 3 }), false);
  assert.equal(showOnboarding({ allDone: true, filter: 'all', accountCount: 1 }), false);
});
