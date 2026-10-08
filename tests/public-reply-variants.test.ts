import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLIC_REPLY_MAX_VARIANTS,
  PUBLIC_REPLY_MAX_VARIANT_LENGTH,
  PUBLIC_REPLY_RECENT_WINDOW,
  PUBLIC_REPLY_SPACING_MS,
  PUBLIC_REPLY_WINDOW_MS,
  renderPublicReply,
  selectPublicReplyVariant,
  validatePublicReplyVariants,
} from '../src/services/public-reply.ts';
import {
  describePublicReply,
  parseVariantLines,
  previewExamples,
  publicReplyErrorHint,
  publicReplyStateLabel,
  variantCountLabel,
} from '../app/public-reply.ts';

test('public reply constants match the documented limits', () => {
  assert.equal(PUBLIC_REPLY_MAX_VARIANTS, 50);
  assert.equal(PUBLIC_REPLY_MAX_VARIANT_LENGTH, 300);
  assert.equal(PUBLIC_REPLY_RECENT_WINDOW, 3);
  assert.equal(PUBLIC_REPLY_SPACING_MS, 20_000);
  assert.equal(PUBLIC_REPLY_WINDOW_MS, 24 * 60 * 60 * 1000);
});

test('variant validation trims, keeps order and accepts the allowed variables and a literal @{{username}}', () => {
  assert.deepEqual(validatePublicReplyVariants(['  ¡Listo @{{username}}! Te escribí por DM  ', 'Revisa tu bandeja, {{username}} ({{keyword}})']),
    ['¡Listo @{{username}}! Te escribí por DM', 'Revisa tu bandeja, {{username}} ({{keyword}})']);
  assert.deepEqual(validatePublicReplyVariants([]), []);
});

test('variant validation rejects invalid shapes and contents without coercion', () => {
  const invalid: unknown[] = [
    'not an array', null, [1], [''], ['   '], ['x'.repeat(PUBLIC_REPLY_MAX_VARIANT_LENGTH + 1)],
    Array.from({ length: PUBLIC_REPLY_MAX_VARIANTS + 1 }, (_, index) => `Variante ${index}`),
    ['Hola', ' hola '], ['Hola', 'HÓLA'], ['Hola {{comment}}'], ['Hola {{account}}'], ['Hola {{ username }}'], ['Hola {{username}'],
    ['Mira https://example.com'], ['Mira www.example.com'], ['Gracias @otra_cuenta'], ['Hola }}'],
  ];
  for (const value of invalid) assert.throws(() => validatePublicReplyVariants(value), TypeError, JSON.stringify(value)?.slice(0, 80));
});

test('variant validation bounds the total size', () => {
  const big = Array.from({ length: PUBLIC_REPLY_MAX_VARIANTS }, (_, index) => `${index} ${'x'.repeat(250)}`);
  assert.throws(() => validatePublicReplyVariants(big), TypeError);
});

test('rendering replaces only username and keyword', () => {
  assert.equal(renderPublicReply('¡Listo @{{username}}! Info de {{keyword}}', { username: 'ana', keyword: 'guía' }), '¡Listo @ana! Info de guía');
  assert.throws(() => renderPublicReply('Hola {{comment}}', { username: 'a', keyword: 'b' }), TypeError);
});

test('selection avoids the last three variants when more than three exist (injectable rng)', () => {
  const variants = ['A', 'B', 'C', 'D', 'E'];
  assert.equal(selectPublicReplyVariant(variants, [], () => 0), 'A');
  assert.equal(selectPublicReplyVariant(variants, ['A', 'B', 'C'], () => 0), 'D');
  assert.equal(selectPublicReplyVariant(variants, ['A', 'B', 'C'], () => 0.99), 'E');
  // Only the most recent three matter.
  assert.equal(selectPublicReplyVariant(variants, ['B', 'C', 'D', 'A'], () => 0), 'A');
  // Recent entries are compared after normalization.
  assert.equal(selectPublicReplyVariant(variants, ['a', ' b ', 'c'], () => 0), 'D');
});

test('selection with three or fewer variants only avoids the immediately previous one; a single variant always repeats', () => {
  assert.equal(selectPublicReplyVariant(['A', 'B'], ['A'], () => 0), 'B');
  assert.equal(selectPublicReplyVariant(['A', 'B'], ['B', 'A'], () => 0), 'A');
  assert.equal(selectPublicReplyVariant(['A', 'B', 'C'], ['C', 'B'], () => 0), 'A');
  assert.equal(selectPublicReplyVariant(['A'], ['A', 'A'], () => 0.5), 'A');
  assert.throws(() => selectPublicReplyVariant([], [], () => 0), TypeError);
});

test('a long deterministic run never repeats within the recent window', () => {
  const variants = Array.from({ length: 8 }, (_, index) => `V${index}`);
  let seed = 7;
  const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const history: string[] = [];
  for (let index = 0; index < 200; index++) {
    const choice = selectPublicReplyVariant(variants, [...history].reverse(), rng);
    assert.equal(history.slice(-3).includes(choice), false);
    history.push(choice);
  }
  assert.ok(new Set(history).size >= 6);
});

test('UI helpers: parse lines, count label and two rendered preview examples', () => {
  assert.deepEqual(parseVariantLines(' Uno \n\n Dos @{{username}}\r\n  '), ['Uno', 'Dos @{{username}}']);
  assert.equal(variantCountLabel(0), '0 variantes');
  assert.equal(variantCountLabel(1), '1 variante');
  assert.equal(variantCountLabel(12), '12 variantes');
  const examples = previewExamples(['Hola @{{username}}', 'Listo {{username}}, revisa {{keyword}}', 'Tres'], () => 0);
  assert.equal(examples.length, 2);
  assert.notEqual(examples[0], examples[1]);
  assert.ok(examples.every((example) => !example.includes('{{')));
  assert.ok(examples.some((example) => example.includes('@')));
  assert.deepEqual(previewExamples(['Solo @{{username}}'], () => 0).length, 1);
  assert.deepEqual(previewExamples([], () => 0), []);
  assert.deepEqual(previewExamples(['Hola {{comment}}'], () => 0), []);
});

test('UI helpers: Spanish state labels, permission hint and retry eligibility', () => {
  assert.equal(publicReplyStateLabel('PENDING'), 'Pendiente');
  assert.equal(publicReplyStateLabel('SENDING'), 'Enviando');
  assert.equal(publicReplyStateLabel('SENT'), 'Publicada');
  assert.equal(publicReplyStateLabel('FAILED'), 'Falló');
  assert.equal(publicReplyStateLabel('UNKNOWN_OUTCOME'), 'Resultado desconocido');
  assert.equal(publicReplyStateLabel('SKIPPED'), 'Omitida');
  assert.equal(publicReplyStateLabel('EXPIRED'), 'Expirada');
  assert.equal(publicReplyErrorHint('public_reply_permission_denied'), 'Falta el permiso para responder comentarios en esta conexión');
  assert.equal(describePublicReply({ state: 'SIMULATED', publicReply: { state: null, text: 'Hola @ana', preview: true } })?.label,
    'WOULD_REPLY_PUBLIC · No se publicó (modo prueba)');
  assert.equal(describePublicReply({ state: 'SENT', publicReply: { state: 'FAILED', text: 'x', safeErrorCode: 'public_reply_permission_denied' } })?.canRetry, true);
  assert.equal(describePublicReply({ state: 'SENT', publicReply: { state: 'UNKNOWN_OUTCOME', text: 'x' } })?.canRetry, false);
  assert.equal(describePublicReply({ state: 'SENT', publicReply: null }), null);
});
