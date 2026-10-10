import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nani from '../app/nani-labels.ts';
import * as labels from '../app/moderation-labels.ts';

test('naniState: monitoring off sleeps; on is awake unless something needs the operator', () => {
  assert.equal(nani.naniState({ monitoringEnabled: false, pendingFlags: 9, reviewItems: 9 }), 'sleep');
  assert.equal(nani.naniState({ monitoringEnabled: true, pendingFlags: 0, reviewItems: 0 }), 'awake');
  assert.equal(nani.naniState({ monitoringEnabled: true, pendingFlags: 2, reviewItems: 0 }), 'alert');
  assert.equal(nani.naniState({ monitoringEnabled: true, pendingFlags: 0, reviewItems: 1 }), 'alert');
});

test('naniState: an account with a sync problem raises an alert even with monitoring off', () => {
  assert.equal(nani.naniState({ monitoringEnabled: false, pendingFlags: 0, reviewItems: 0, accountProblems: 1 }), 'alert');
  assert.equal(nani.naniState({ monitoringEnabled: true, pendingFlags: 0, reviewItems: 0, accountProblems: 1 }), 'alert');
  assert.equal(nani.naniState({ monitoringEnabled: true, pendingFlags: 0, reviewItems: 0, accountProblems: 0 }), 'awake');
});

test('accountProblems: accounts whose last scan stopped with an error code (a cancelled scan is not a problem)', () => {
  assert.deepEqual(nani.accountProblems([
    { username: 'uno', last_error: 'meta_rate_limited' }, { username: 'dos', last_error: null },
    { username: 'tres', last_error: 'scan_cancelled' }, { username: 'cuatro' },
  ]), [{ username: 'uno', error: 'meta_rate_limited' }]);
});

test('heroCopy names the account with a problem first and points to Conexiones', () => {
  assert.deepEqual(nani.heroCopy({ state: 'alert', watch: { all: false, count: 3 }, pendingFlags: 5, reviewItems: 2, problem: { username: 'uno', error: 'meta_rate_limited' } }),
    { lead: '', accent: '@uno', tail: ' necesita atención: Instagram me pidió esperar un rato antes de seguir leyendo.', target: 'connections' });
});

test('naniLabel describes every state in Spanish', () => {
  assert.equal(nani.naniLabel('sleep'), 'Nani está dormida: el monitoreo está apagado');
  for (const state of ['awake', 'alert', 'happy'] as const) assert.match(nani.naniLabel(state), /^Nani /);
});

test('watchedPosts: distinct media of enabled automations; an enabled general automation watches every post', () => {
  const rows = [
    { status: 'enabled', scope: 'media', mediaId: 'm1' }, { status: 'enabled', scope: 'media', mediaId: 'm1' },
    { status: 'enabled', scope: 'media', mediaId: 'm2' }, { status: 'paused', scope: 'media', mediaId: 'm3' },
  ];
  assert.deepEqual(nani.watchedPosts(rows), { all: false, count: 2 });
  assert.deepEqual(nani.watchedPosts([...rows, { status: 'enabled', scope: 'account', mediaId: null }]), { all: true, count: 2 });
  assert.deepEqual(nani.watchedPosts([]), { all: false, count: 0 });
});

test('heroCopy follows the state with real numbers', () => {
  assert.deepEqual(nani.heroCopy({ state: 'sleep', watch: { all: false, count: 3 }, pendingFlags: 0, reviewItems: 0 }), { lead: 'Estoy dormida. ', accent: 'Despiértame', tail: ' y respondo por ti.', target: null });
  assert.deepEqual(nani.heroCopy({ state: 'awake', watch: { all: false, count: 3 }, pendingFlags: 0, reviewItems: 0 }), { lead: 'Estoy atenta a ', accent: '3 publicaciones', tail: '.', target: null });
  assert.deepEqual(nani.heroCopy({ state: 'awake', watch: { all: false, count: 1 }, pendingFlags: 0, reviewItems: 0 }).accent, '1 publicación');
  assert.deepEqual(nani.heroCopy({ state: 'awake', watch: { all: true, count: 1 }, pendingFlags: 0, reviewItems: 0 }).accent, 'todas tus publicaciones');
  assert.deepEqual(nani.heroCopy({ state: 'alert', watch: { all: false, count: 3 }, pendingFlags: 5, reviewItems: 2 }), { lead: 'Hay ', accent: '5 comentarios', tail: ' que debes revisar.', target: 'moderation' });
  assert.deepEqual(nani.heroCopy({ state: 'alert', watch: { all: false, count: 3 }, pendingFlags: 1, reviewItems: 0 }).accent, '1 comentario');
  assert.deepEqual(nani.heroCopy({ state: 'alert', watch: { all: false, count: 3 }, pendingFlags: 0, reviewItems: 2 }), { lead: 'Hay ', accent: '2 envíos', tail: ' que debes revisar.', target: 'queue' });
});

test('enabledKeywords: unique phrases of enabled automations, in order', () => {
  assert.deepEqual(nani.enabledKeywords([
    { status: 'enabled', keywords: [{ phrase: 'guia' }, { phrase: 'ebook' }] },
    { status: 'paused', keywords: [{ phrase: 'oculto' }] },
    { status: 'enabled', keywords: [{ phrase: 'Guia' }, { phrase: 'precio' }] },
  ]), ['guia', 'ebook', 'precio']);
});

test('findKeyword: case and accent insensitive, returns the original slice', () => {
  assert.deepEqual(nani.findKeyword('Quiero la GUÍA porfa', ['ebook', 'guia']), { before: 'Quiero la ', match: 'GUÍA', after: ' porfa', keyword: 'guia' });
  assert.equal(nani.findKeyword('jajaja', ['guia']), null);
  assert.equal(nani.findKeyword('', ['guia']), null);
  assert.equal(nani.findKeyword('guia', []), null);
});

test('flowEntries: newest items with comment, reply text and state; never invents data', () => {
  const entries = nani.flowEntries([
    { id: 'a', commentUsername: 'ana', commentText: 'guia porfa', state: 'SENT', payload: { text: 'Hola ana' }, createdAt: '2026-10-02' },
    { id: 'b', commentUsername: null, commentText: undefined, state: 'SIMULATED', payload: {}, createdAt: '2026-10-01' },
  ], ['guia'], 6);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { id: 'a', username: 'ana', text: 'guia porfa', reply: 'Hola ana', state: 'SENT', match: { before: '', match: 'guia', after: ' porfa', keyword: 'guia' } });
  assert.deepEqual(entries[1], { id: 'b', username: null, text: '', reply: null, state: 'SIMULATED', match: null });
  assert.equal(nani.flowEntries(Array.from({ length: 10 }, (_, i) => ({ id: String(i), state: 'SENT', createdAt: '' })), [], 6).length, 6);
});

const deck: labels.ShortcutInput = {
  key: 'ArrowLeft', repeat: false, modifier: false, typing: false, dialogOpen: false,
  accountFilter: 'acc1', selectedId: 'f1', visibleIds: ['f1'], state: 'PENDING', busy: false, narrow: false, sheetOpen: false,
  mode: 'deck', deckActive: true,
};

test('deck shortcuts: ← hides and → dismisses the top card only while the deck is focused or hovered', () => {
  assert.equal(labels.shouldHandleShortcut(deck), 'hide');
  assert.equal(labels.shouldHandleShortcut({ ...deck, key: 'ArrowRight' }), 'dismiss');
  assert.equal(labels.shouldHandleShortcut({ ...deck, deckActive: false }), null);
  assert.equal(labels.shouldHandleShortcut({ ...deck, key: 'h' }), null, 'H/D belong to the list view');
  assert.equal(labels.shouldHandleShortcut({ ...deck, narrow: true, sheetOpen: false }), 'hide', 'the deck has no sheet');
  for (const change of [{ typing: true }, { dialogOpen: true }, { repeat: true }, { busy: true }, { accountFilter: 'all' }, { selectedId: '' }, { modifier: true }]) {
    assert.equal(labels.shouldHandleShortcut({ ...deck, ...change }), null, JSON.stringify(change));
  }
});

test('list shortcuts ignore arrows', () => {
  assert.equal(labels.shouldHandleShortcut({ ...deck, mode: 'list', key: 'ArrowLeft' }), null);
});

test('accountErrorLabel / coverageLabel: plain Spanish instead of raw codes', () => {
  assert.equal(nani.accountErrorLabel('meta_rate_limited'), 'Instagram me pidió esperar un rato antes de seguir leyendo');
  assert.equal(nani.accountErrorLabel('meta_timeout'), 'Instagram tardó demasiado en responder');
  assert.equal(nani.accountErrorLabel('meta_network_error'), 'No pude conectarme con Instagram');
  assert.match(nani.accountErrorLabel('meta_something_new'), /No pude leer los comentarios/);
  assert.doesNotMatch(nani.accountErrorLabel('meta_something_new'), /meta_/);
  assert.equal(nani.coverageLabel('complete'), 'revisión completa');
  assert.equal(nani.coverageLabel('incomplete'), 'revisión incompleta');
  assert.equal(nani.coverageLabel('running'), 'revisando ahora');
  assert.equal(nani.coverageLabel('cancelled'), 'revisión cancelada');
  assert.equal(nani.coverageLabel(undefined), '');
  const copy = nani.heroCopy({ state: 'alert', watch: { all: false, count: 1 }, pendingFlags: 0, reviewItems: 0, problem: { username: 'tu_cuenta', error: 'meta_rate_limited' } });
  assert.doesNotMatch(copy.tail, /meta_/);
});
