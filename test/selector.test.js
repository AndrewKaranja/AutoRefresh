import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeIdent,
  isStableId,
  isUnstableClassName,
  selectorQuality,
  stableClasses,
} from '../src/lib/selector.js';

test('generated class names are rejected', () => {
  // These all change on the site's next deploy. A selector built on one
  // works today and silently matches nothing on Thursday -- at which point
  // the monitor reports "no change" forever and looks broken.
  for (const cls of [
    'css-1a2b3c',
    'css-x7f9a2',
    'jsx-1234567890',
    'Button_root__a1b2c',
    'tw-a1b2c3d4',
    'sc-bdVaJa1f2e3d',
    '_3xKp9a2b41',
    'item-9f8e7d6c',
    'grid-12345',
  ]) {
    assert.ok(isUnstableClassName(cls), `${cls} should be rejected`);
  }
});

test('hand-authored class names are kept', () => {
  for (const cls of [
    'price',
    'product-title',
    'stock_status',
    'btn-primary',
    'nav',
    'col-md-6',
    'is-active',
    'header__inner',
  ]) {
    assert.equal(isUnstableClassName(cls), false, `${cls} should be kept`);
  }
});

test('empty and missing class names are treated as unusable', () => {
  assert.ok(isUnstableClassName(''));
  // @ts-expect-error -- classList entries can be undefined when the picker
  // walks an element mid-mutation.
  assert.ok(isUnstableClassName(undefined));
});

test('framework-generated ids are rejected', () => {
  for (const id of [':r3:', 'ember1234', 'radix-:r0:', 'headlessui-menu-button-3', '123start', 'yui_3_1']) {
    assert.equal(isStableId(id), false, `${id} should be rejected`);
  }
});

test('authored ids are accepted', () => {
  for (const id of ['main', 'product-price', 'search_results', 'app']) {
    assert.ok(isStableId(id), `${id} should be accepted`);
  }
});

test('stableClasses filters and caps', () => {
  assert.deepEqual(stableClasses(['css-1a2b3c', 'price', 'jsx-999999', 'bold']), ['price', 'bold']);
  assert.deepEqual(stableClasses(['a', 'b', 'c', 'd']), ['a', 'b'], 'capped at two');
  assert.deepEqual(stableClasses(['css-1a2b3c']), []);
});

test('escapeIdent handles characters that would break a selector', () => {
  assert.equal(escapeIdent('plain'), 'plain');
  assert.equal(escapeIdent('with-dash'), 'with-dash');
  assert.equal(escapeIdent('has:colon'), 'has\\:colon');
  assert.equal(escapeIdent('has.dot'), 'has\\.dot');
  assert.equal(escapeIdent('1leading'), '\\1leading');
});

test('selector quality grading', () => {
  assert.equal(selectorQuality({ matchCount: 2, usedId: true, usedStableAttr: true, depth: 1 }), 'weak');
  assert.equal(selectorQuality({ matchCount: 1, usedId: true, usedStableAttr: false, depth: 4 }), 'strong');
  assert.equal(selectorQuality({ matchCount: 1, usedId: false, usedStableAttr: true, depth: 5 }), 'strong');
  assert.equal(selectorQuality({ matchCount: 1, usedId: false, usedStableAttr: false, depth: 2 }), 'ok');
  assert.equal(selectorQuality({ matchCount: 1, usedId: false, usedStableAttr: false, depth: 5 }), 'weak');
});
