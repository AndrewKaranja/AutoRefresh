// @ts-check
/**
 * The DOM-free half of selector generation.
 *
 * content/picker.js walks the live DOM (it has to -- it runs under the user's
 * cursor), but every decision that can be made from plain strings lives here
 * so it can be tested without a browser. The picker mirrors the two small
 * pieces it needs inline and scripts/validate-manifest.mjs asserts they still
 * agree with this file.
 */

/**
 * Class names that will not survive the site's next deploy.
 *
 * CSS Modules, emotion, styled-components and Tailwind's JIT all emit hashed
 * class names. A selector built on one works perfectly today and silently
 * matches nothing after the site ships on Thursday -- at which point the
 * monitor reports "no change" forever and the user concludes the feature is
 * broken. Rejecting them up front costs one regex.
 *
 * Matches: `css-1a2b3c`, `sc-bdVaJa`(no), `_3xKp9`, `jsx-1234567890`,
 *          `Button_root__a1b2c`, `tw-a1b2c3d4`.
 *
 * @param {string} cls
 * @returns {boolean}
 */
export function isUnstableClassName(cls) {
  if (!cls) return true;
  // A trailing or whole-token hex run, or a long digit run: both are the
  // signature of generated names rather than authored ones.
  if (/[-_][0-9a-f]{5,}$/i.test(cls)) return true;
  if (/^[a-z]{0,4}[-_]?[0-9a-f]{6,}$/i.test(cls)) return true;
  if (/\d{4,}/.test(cls)) return true;
  // emotion's `css-<hash>` and styled-components' `sc-<hash>`
  if (/^(css|sc|jsx|tw|chakra|mui|ant)-[0-9a-z]{4,}$/i.test(cls)) return true;
  // CSS Modules' default localIdentName, e.g. `_3xKp9` or `_1a2B3c`. The hash
  // alphabet is base64-ish rather than hex, so the rules above miss it.
  // Leading-underscore class names are rare in authored CSS, and the cost of
  // a false positive here is only that the picker walks up to a parent --
  // whereas a false negative is a monitor that silently stops working after
  // the site's next deploy.
  if (/^_[a-z0-9]{4,}$/i.test(cls) && /\d/.test(cls)) return true;
  return false;
}

/**
 * Attributes worth building a selector on, most stable first. Test hooks and
 * ARIA/semantic attributes outlive both class names and DOM position.
 */
export const STABLE_ATTRS = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'data-cy',
  'itemprop',
  'aria-label',
  'name',
  'role',
];

/**
 * CSS identifier escaping. CSS.escape exists in browsers but not in Node, and
 * the picker needs identical behaviour in both so the tests mean something.
 *
 * @param {string} ident
 * @returns {string}
 */
export function escapeIdent(ident) {
  return String(ident).replace(/([^\w-]|^(?=\d)|^-(?=\d))/g, '\\$1');
}

/**
 * Is this id usable as a selector on its own? Framework-generated ids
 * (`:r3:` from React 18's useId, `ember1234`, raw digits) are as volatile as
 * hashed classes.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isStableId(id) {
  if (!id) return false;
  if (/^[0-9]/.test(id)) return false;
  if (/^:.*:$/.test(id)) return false; // React useId
  if (/^(ember|ext-gen|yui|aria-|radix-|headlessui-)/i.test(id)) return false;
  if (isUnstableClassName(id)) return false;
  return true;
}

/**
 * Picks the class names from an element worth keeping, in source order.
 *
 * @param {string[]} classes
 * @param {number} [max]
 * @returns {string[]}
 */
export function stableClasses(classes, max = 2) {
  return classes.filter((c) => c && !isUnstableClassName(c)).slice(0, max);
}

/**
 * Joins a walked ancestor chain into a selector string.
 *
 * @param {string[]} steps Outermost first.
 * @returns {string}
 */
export function joinSteps(steps) {
  return steps.join(' > ');
}

/**
 * How much to trust a generated selector, for the label shown in the picker.
 *
 * @param {{matchCount: number, usedId: boolean, usedStableAttr: boolean, depth: number}} info
 * @returns {'strong'|'ok'|'weak'}
 */
export function selectorQuality({ matchCount, usedId, usedStableAttr, depth }) {
  if (matchCount !== 1) return 'weak';
  if (usedId || usedStableAttr) return 'strong';
  if (depth <= 3) return 'ok';
  return 'weak';
}
