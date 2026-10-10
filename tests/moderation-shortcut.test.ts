import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as labels from '../app/moderation-labels.ts';

const base: labels.ShortcutInput = {
  key: 'h', repeat: false, modifier: false, typing: false, dialogOpen: false,
  accountFilter: 'acc1', selectedId: 'f1', visibleIds: ['f1', 'f2'], state: 'PENDING', busy: false, narrow: false, sheetOpen: false,
};

test('shortcut: H hides and D dismisses the explicitly selected visible flag', () => {
  assert.equal(labels.shouldHandleShortcut(base), 'hide');
  assert.equal(labels.shouldHandleShortcut({ ...base, key: 'H' }), 'hide');
  assert.equal(labels.shouldHandleShortcut({ ...base, key: 'd' }), 'dismiss');
  assert.equal(labels.shouldHandleShortcut({ ...base, key: 'x' }), null);
});

test('shortcut: never acts without an explicit selection, on "all accounts" or on a flag that left the list', () => {
  assert.equal(labels.shouldHandleShortcut({ ...base, selectedId: '' }), null);
  assert.equal(labels.shouldHandleShortcut({ ...base, accountFilter: 'all' }), null);
  assert.equal(labels.shouldHandleShortcut({ ...base, visibleIds: ['f2'] }), null);
});

test('shortcut: ignores typing, dialogs, modifiers, key repeat and a row with an action in flight', () => {
  for (const change of [{ typing: true }, { dialogOpen: true }, { modifier: true }, { repeat: true }, { busy: true }]) {
    assert.equal(labels.shouldHandleShortcut({ ...base, ...change }), null, JSON.stringify(change));
  }
});

test('shortcut: on narrow screens it only acts while the detail sheet is open', () => {
  assert.equal(labels.shouldHandleShortcut({ ...base, narrow: true, sheetOpen: false }), null);
  assert.equal(labels.shouldHandleShortcut({ ...base, narrow: true, sheetOpen: true }), 'hide');
});

test('shortcut: only actions the flag state allows', () => {
  assert.equal(labels.shouldHandleShortcut({ ...base, state: 'HIDDEN' }), null);
  assert.equal(labels.shouldHandleShortcut({ ...base, key: 'd', state: 'DELETED' }), null);
  assert.equal(labels.shouldHandleShortcut({ ...base, key: 'd', state: 'UNKNOWN_OUTCOME' }), 'dismiss');
});

test('page: the keyboard listener goes through shouldHandleShortcut', () => {
  const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /shouldHandleShortcut\(/);
});
