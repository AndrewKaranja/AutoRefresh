// @ts-check
/**
 * Normalisation and diffing for page-change detection.
 *
 * The agent ships raw `innerText` to the service worker and everything below
 * happens here, in one place, on pure strings. That keeps the whole comparison
 * pipeline unit-testable and means the content script stays a thin,
 * import-free file.
 *
 * `normalize()` is where monitoring lives or dies. Without the ignore-regex
 * step, a page carrying a clock, a relative timestamp ("3 minutes ago"), a
 * CSRF token or a rotating ad slot reports a change on literally every reload,
 * and the feature becomes noise the user turns off.
 */

import { MONITOR_TEXT_CAP } from './constants.js';

/**
 * @param {string} raw
 * @param {string|null} [ignoreRegex] User-authored; may be invalid, in which
 *                                    case it is skipped rather than throwing
 *                                    and breaking the whole sample.
 * @returns {string}
 */
export function normalize(raw, ignoreRegex = null) {
  let text = (raw || '').slice(0, MONITOR_TEXT_CAP);

  if (ignoreRegex) {
    const re = safeRegExp(ignoreRegex, 'g');
    if (re) text = text.replace(re, '');
  }

  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ​]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Compiles a user-supplied pattern, returning null instead of throwing.
 *
 * @param {string} source
 * @param {string} [flags]
 * @returns {RegExp|null}
 */
export function safeRegExp(source, flags = '') {
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/**
 * A short human-readable summary of what appeared, for the notification body.
 *
 * Line-set difference rather than a real diff algorithm: it is O(n), it needs
 * no dependency, and "what showed up that wasn't there before" is exactly the
 * question a restock or status-page watcher is asking.
 *
 * @param {string} before
 * @param {string} after
 * @param {number} [maxChars]
 * @returns {string}
 */
export function diffSnippet(before, after, maxChars = 200) {
  const prior = new Set(before.split('\n'));
  const added = [];

  for (const line of after.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || prior.has(line)) continue;
    added.push(trimmed);
    if (added.join(' · ').length >= maxChars) break;
  }

  if (added.length === 0) {
    // Text was removed rather than added. Say so instead of showing nothing.
    const now = new Set(after.split('\n'));
    const removed = before
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !now.has(l));
    if (removed.length === 0) return '';
    return truncate(`Removed: ${removed.join(' · ')}`, maxChars);
  }

  return truncate(added.join(' · '), maxChars);
}

/**
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function truncate(s, max) {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * The anchor stored alongside a picked selector. If the selector later stops
 * matching -- a redeploy renamed a class, the page restructured -- we can look
 * for this text instead and tell the user their watched region moved, rather
 * than reporting "no change" forever and quietly being useless.
 *
 * @param {string} text
 * @returns {string}
 */
export function textAnchor(text) {
  return normalize(text).slice(0, 60);
}
