// @ts-check
/** Display formatting shared by the popup and the options page. */

/**
 * "45s", "5m", "1h 30m" -- compact enough for a preset chip.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * Countdown form: "0:23", "12:05", "1:02:44". Clamps at zero rather than
 * showing negative time when an alarm runs late.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Badge text has room for about four characters. Past 999 reloads the exact
 * number stops mattering, so switch to a magnitude.
 *
 * @param {number} n
 * @returns {string}
 */
export function formatBadgeCount(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return String(n);
  if (n < 100_000) return `${Math.floor(n / 1000)}k`;
  return '99k+';
}

/**
 * @param {string} url
 * @param {number} [max]
 * @returns {string}
 */
export function prettyUrl(url, max = 42) {
  try {
    const u = new URL(url);
    const s = `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch {
    return url.length > max ? `${url.slice(0, max - 1)}…` : url;
  }
}

/**
 * @param {number|null} ts
 * @returns {string}
 */
export function formatTimeAgo(ts) {
  if (!ts) return 'never';
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
