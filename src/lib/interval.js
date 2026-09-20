// @ts-check
/**
 * Interval maths: how long until the next reload, and which timer drives it.
 *
 * Pure functions with no chrome.* access, so test/interval.test.js can cover
 * the whole decision space in milliseconds.
 */

import {
  ALARM_MIN_MS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  PAGE_MODE_THRESHOLD_MS,
  WATCHDOG_SLACK_MS,
} from './constants.js';

/**
 * The shortest interval this job can ever draw.
 *
 * Mode is decided from the *lower* bound, not the mean or the current draw.
 * A 20-90s randomized job that switched modes per draw would thrash between
 * two different timing mechanisms mid-flight; pinning to the lower bound keeps
 * one job on one mechanism for its whole life.
 *
 * @param {{intervalMs: number, randomize: {enabled: boolean, minMs: number, maxMs: number}}} job
 * @returns {number}
 */
export function lowerBound(job) {
  if (job.randomize?.enabled) {
    return Math.max(MIN_INTERVAL_MS, Math.min(job.randomize.minMs, job.randomize.maxMs));
  }
  return Math.max(MIN_INTERVAL_MS, job.intervalMs);
}

/**
 * Which timer drives this job. Derived, never stored -- see Invariant B.
 *
 * @param {{intervalMs: number, randomize: {enabled: boolean, minMs: number, maxMs: number}}} job
 * @returns {'alarm'|'page'}
 */
export function deriveMode(job) {
  return lowerBound(job) < PAGE_MODE_THRESHOLD_MS ? 'page' : 'alarm';
}

/**
 * Draws the interval for one cycle. Randomized jobs get a fresh uniform draw
 * each time, which is why the scheduler uses one-shot alarms rather than
 * `periodInMinutes`.
 *
 * @param {{intervalMs: number, randomize: {enabled: boolean, minMs: number, maxMs: number}}} job
 * @param {() => number} [rand] Injectable for deterministic tests.
 * @returns {number}
 */
export function drawInterval(job, rand = Math.random) {
  if (!job.randomize?.enabled) {
    return clamp(job.intervalMs);
  }
  const lo = clamp(Math.min(job.randomize.minMs, job.randomize.maxMs));
  const hi = clamp(Math.max(job.randomize.minMs, job.randomize.maxMs));
  if (hi <= lo) return lo;
  return Math.round(lo + rand() * (hi - lo));
}

/**
 * The delay to hand chrome.alarms for this cycle.
 *
 * In alarm mode it is the timer itself. In page mode the page owns timing and
 * this is only a stall watchdog, so it sits well past the expected reload --
 * far enough that a healthy page always beats it to the punch.
 *
 * @param {'alarm'|'page'} mode
 * @param {number} effectiveMs
 * @returns {number}
 */
export function alarmDelayMs(mode, effectiveMs) {
  if (mode === 'alarm') return Math.max(ALARM_MIN_MS, effectiveMs);
  return Math.max(ALARM_MIN_MS, effectiveMs * 2 + WATCHDOG_SLACK_MS);
}

/**
 * chrome.alarms takes minutes. It also silently ignores anything under 0.5 in
 * a packed extension while honouring it unpacked -- so this throws rather than
 * letting a sub-minimum delay through. The failure is loud in development,
 * where it is cheap, instead of invisible in production, where it is not.
 *
 * @param {number} ms
 * @returns {number}
 */
export function toAlarmMinutes(ms) {
  const minutes = ms / 60_000;
  if (!(minutes >= ALARM_MIN_MS / 60_000)) {
    throw new RangeError(
      `alarm delay ${ms}ms is below the ${ALARM_MIN_MS}ms floor; ` +
        'packed Chrome would silently ignore it (unpacked would not)',
    );
  }
  return minutes;
}

/** @param {number} ms @returns {number} */
export function clamp(ms) {
  if (!Number.isFinite(ms)) return 30_000;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

/**
 * Whether a job has hit a terminal condition, and which one.
 *
 * @param {{reloadCount: number, maxReloads: number, stopAt: number|null}} job
 * @param {number} [now]
 * @returns {null|'max-reloads'|'deadline'}
 */
export function stopConditionMet(job, now = Date.now()) {
  if (job.maxReloads > 0 && job.reloadCount >= job.maxReloads) return 'max-reloads';
  if (job.stopAt !== null && now >= job.stopAt) return 'deadline';
  return null;
}
