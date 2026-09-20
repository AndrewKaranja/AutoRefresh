import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffSnippet, normalize, safeRegExp, textAnchor, truncate } from '../src/lib/text.js';
import { hashText, hashUrl } from '../src/lib/hash.js';

test('normalize collapses the whitespace noise that differs between loads', () => {
  assert.equal(normalize('  a   b  \n\n\n c  '), 'a b\nc');
  assert.equal(normalize('a\r\nb'), 'a\nb');
  assert.equal(normalize('a ​b'), 'a b', 'nbsp and zero-width join as one space');
});

test('the ignore-regex is what makes monitoring usable', () => {
  // THE headline case. A page with a clock in it changes on every single
  // reload; without this step the feature is pure noise and gets switched off.
  const clock = /\d{1,2}:\d{2}:\d{2}/.source;

  const a = normalize('Orders: 14\nLast updated 09:41:03', clock);
  const b = normalize('Orders: 14\nLast updated 09:41:58', clock);
  assert.equal(hashText(a), hashText(b), 'a ticking clock must not register as a change');

  // ...while a real change still does.
  const c = normalize('Orders: 15\nLast updated 09:42:10', clock);
  assert.notEqual(hashText(a), hashText(c));
});

test('an invalid ignore-regex is skipped rather than breaking the whole sample', () => {
  const out = normalize('hello world', '([unclosed');
  assert.equal(out, 'hello world');
  assert.equal(safeRegExp('([unclosed'), null);
});

test('normalize caps enormous documents', () => {
  const huge = 'x'.repeat(500_000);
  assert.ok(normalize(huge).length <= 200_000);
});

test('hashing is stable, order-sensitive and well distributed', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('acb'));
  assert.notEqual(hashText('abc'), hashText('abd'));
  assert.equal(hashText('').length, 16, 'fixed-width hex digest');
  assert.match(hashText('anything'), /^[0-9a-f]{16}$/);

  // No collisions across a reasonable spread of realistic inputs.
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(hashText(`Item ${i} in stock at store ${i % 7}`));
  assert.equal(seen.size, 5000);
});

test('hashUrl keeps readable URLs out of storage keys', () => {
  const h = hashUrl('https://example.com/secret-dashboard');
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.ok(!h.includes('example'));
});

test('diffSnippet reports what appeared', () => {
  const before = 'Status: pending\nOwner: sam';
  const after = 'Status: shipped\nOwner: sam\nTracking: ABC123';
  const snippet = diffSnippet(before, after);
  assert.ok(snippet.includes('Tracking: ABC123'));
  assert.ok(snippet.includes('Status: shipped'));
  assert.ok(!snippet.includes('Owner'), 'unchanged lines are not noise');
});

test('diffSnippet reports removals too', () => {
  // The in-stock case: what matters is that "Out of stock" DISAPPEARED.
  const before = 'Blue widget\nOut of stock';
  const after = 'Blue widget';
  const snippet = diffSnippet(before, after);
  assert.match(snippet, /^Removed: /);
  assert.ok(snippet.includes('Out of stock'));
});

test('diffSnippet is empty when nothing moved', () => {
  assert.equal(diffSnippet('same', 'same'), '');
});

test('diffSnippet respects its length budget', () => {
  const after = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  assert.ok(diffSnippet('', after, 120).length <= 120);
});

test('truncate', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdefghij', 5), 'abcd…');
  assert.ok(truncate('x'.repeat(100), 20).length <= 20);
});

test('textAnchor is short and normalised', () => {
  const anchor = textAnchor('  The   quick\n\nbrown fox jumps over the lazy dog and keeps going forever  ');
  assert.ok(anchor.length <= 60);
  assert.ok(anchor.startsWith('The quick'));
});
