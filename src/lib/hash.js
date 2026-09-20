// @ts-check
/**
 * FNV-1a, run twice with different offset bases and concatenated into a
 * 64-bit hex digest.
 *
 * Deliberately not crypto.subtle.digest, for two reasons. It is async, which
 * would drag a promise through the sampling path for no benefit; and we only
 * need to answer "did this text change?", which is not a cryptographic
 * question. Math.imul keeps this in integer space and fast enough to hash a
 * 200KB document without a measurable pause.
 *
 * (The other half of the reason applies if this ever moves back into the
 * content script: crypto.subtle is unavailable there on http:// origins,
 * because they are not secure contexts. That failure would pass every test
 * run against an https:// page and only surface in the wild.)
 */

/**
 * @param {string} str
 * @param {number} seed
 * @returns {number} unsigned 32-bit
 */
function fnv1a32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, in 32-bit space
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * @param {string} str
 * @returns {string} 16-char lowercase hex
 */
export function hashText(str) {
  const a = fnv1a32(str, 0x811c9dc5);
  const b = fnv1a32(str, 0x1000193);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * Short, filesystem- and storage-key-safe digest of a URL. Used to key monitor
 * snapshots in storage.local without putting raw URLs in key names.
 *
 * @param {string} url
 * @returns {string}
 */
export function hashUrl(url) {
  return hashText(url);
}
