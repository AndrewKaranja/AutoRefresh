// @ts-check
/**
 * Scope matching: does this URL still belong to this job?
 *
 * The question matters more than it looks. Rivals get it wrong in one of two
 * directions, and both are bad:
 *
 *   - Stop on *any* URL change, and a dashboard that redirects /x -> /x/ or an
 *     SPA that rewrites ?page=2 kills the job instantly.
 *   - Keep on *any* URL change, and navigating to your inbox means the
 *     extension starts hammering your inbox. This is the single most-reported
 *     complaint about the category.
 *
 * So the job is keyed by tab but carries a scope, defaulting to origin. Out of
 * scope pauses; it never deletes. Navigate back and it resumes.
 */

import { SCOPE_MODE } from './constants.js';

/**
 * @param {{mode: string, value: string}} scope
 * @param {string} url
 * @returns {boolean}
 */
export function scopeMatches(scope, url) {
  if (!scope) return false;
  if (scope.mode === SCOPE_MODE.ANY) return true;
  if (!url) return false;

  switch (scope.mode) {
    case SCOPE_MODE.EXACT:
      return stripHash(url) === stripHash(scope.value);

    case SCOPE_MODE.PREFIX:
      return stripHash(url).startsWith(stripHash(scope.value));

    case SCOPE_MODE.ORIGIN:
    default: {
      const origin = originOf(url);
      return origin !== null && origin === scope.value;
    }
  }
}

/**
 * The fragment never triggers a server round-trip, so two URLs differing only
 * after the `#` are the same page for our purposes.
 *
 * @param {string} url
 * @returns {string}
 */
export function stripHash(url) {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * @param {string} url
 * @returns {string|null}
 */
export function originOf(url) {
  try {
    const origin = new URL(url).origin;
    // Opaque origins (about:, data:, blob: in some cases) serialise to the
    // literal string "null". Returning that would make every opaque-origin URL
    // compare equal to every other one, so a job scoped to about:blank would
    // consider a data: URL in scope. Fail closed instead.
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Pages we can never drive: no content script attaches, and reloading them is
 * either impossible or pointless.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source|file|data|blob|chrome-untrusted|moz-extension):/i.test(
    url,
  );
}

/**
 * The host permission pattern covering a URL's origin, e.g.
 * `https://example.com/*`. Used for runtime permission requests, which are
 * always per-origin so the user is never asked for more than the site in
 * front of them.
 *
 * @param {string} url
 * @returns {string|null}
 */
export function originPattern(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Converts a user-authored rule pattern into a RegExp.
 *
 * `glob` is the forgiving everyday form (`*` matches anything). `matchPattern`
 * follows Chrome's own match-pattern grammar so rule text can be pasted
 * straight from the permissions UI. `regex` is escape-hatch for power users
 * and is the only kind that can throw -- callers must handle that.
 *
 * @param {string} pattern
 * @param {'matchPattern'|'glob'|'regex'} kind
 * @returns {RegExp}
 */
export function patternToRegExp(pattern, kind) {
  if (kind === 'regex') return new RegExp(pattern);

  if (kind === 'matchPattern') {
    const m = /^(\*|https?|file|ftp):\/\/(\*|\*\.[^/*]+|[^/*]*)(\/.*)$/.exec(pattern);
    if (!m) throw new SyntaxError(`invalid match pattern: ${pattern}`);
    const [, scheme, host, path] = m;

    const schemeRe = scheme === '*' ? 'https?' : escapeRe(scheme);
    let hostRe;
    if (host === '*') hostRe = '[^/]+';
    else if (host.startsWith('*.')) hostRe = `(?:[^/]+\\.)?${escapeRe(host.slice(2))}`;
    else hostRe = escapeRe(host);

    const pathRe = escapeRe(path).replace(/\\\*/g, '.*');
    return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
  }

  // glob
  return new RegExp(`^${escapeRe(pattern).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`);
}

/** @param {string} s @returns {string} */
export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
