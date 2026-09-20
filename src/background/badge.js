// @ts-check
/**
 * The toolbar icon, badge and tooltip.
 *
 * Everything here is set with an explicit `tabId`, which means Chrome swaps
 * the right state in as the user changes tabs and we never listen for
 * tabs.onActivated or windows.onFocusChanged at all. Two fewer listeners, two
 * fewer ways for the badge to drift out of sync with reality.
 */

import { COLOR, PAUSE_REASON, STATUS } from '../lib/constants.js';
import { formatBadgeCount, formatInterval } from '../lib/format.js';

/** @typedef {import('../lib/schema.js').Job} Job */

const IDLE_ICONS = {
  16: '/assets/icons/icon-16.png',
  32: '/assets/icons/icon-32.png',
  48: '/assets/icons/icon-48.png',
  128: '/assets/icons/icon-128.png',
};

const ACTIVE_ICONS = {
  16: '/assets/icons/icon-active-16.png',
  32: '/assets/icons/icon-active-32.png',
  48: '/assets/icons/icon-active-48.png',
  128: '/assets/icons/icon-active-128.png',
};

/**
 * Every call here is best-effort. A tab can close between the decision to
 * update its badge and the call itself, and Chrome rejects with "No tab with
 * id" -- which is noise, not a fault.
 *
 * @param {() => Promise<unknown>} fn
 */
async function quiet(fn) {
  try {
    await fn();
  } catch {
    /* tab went away mid-update */
  }
}

/**
 * @param {number} tabId
 * @param {Job|null} job
 * @returns {Promise<void>}
 */
export async function update(tabId, job) {
  if (!job || job.status === STATUS.STOPPED) return clear(tabId);

  const running = job.status === STATUS.RUNNING;
  const alerted = job.monitor.enabled && job.monitor.onMatch.badge && job.monitor.changeCount > 0;

  await quiet(() => chrome.action.setIcon({ tabId, path: running ? ACTIVE_ICONS : IDLE_ICONS }));

  let text;
  let color;
  if (alerted) {
    text = '!';
    color = COLOR.ALERT;
  } else if (running) {
    text = formatBadgeCount(job.reloadCount);
    color = COLOR.ACTIVE;
  } else {
    text = '❚❚';
    color = COLOR.IDLE;
  }

  await quiet(() => chrome.action.setBadgeText({ tabId, text }));
  await quiet(() => chrome.action.setBadgeBackgroundColor({ tabId, color }));
  await quiet(() => chrome.action.setTitle({ tabId, title: tooltip(job) }));
}

/**
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function clear(tabId) {
  await quiet(() => chrome.action.setBadgeText({ tabId, text: '' }));
  await quiet(() => chrome.action.setIcon({ tabId, path: IDLE_ICONS }));
  await quiet(() => chrome.action.setTitle({ tabId, title: 'Auto Refresh' }));
}

/**
 * @param {Job} job
 * @returns {string}
 */
function tooltip(job) {
  const every = job.randomize.enabled
    ? `${formatInterval(job.randomize.minMs)}–${formatInterval(job.randomize.maxMs)}`
    : formatInterval(job.intervalMs);

  if (job.status === STATUS.RUNNING) {
    const parts = [`Auto Refresh — every ${every}`, `${job.reloadCount} reloads`];
    if (job.reloadMethod === 'hard') parts.push('hard reload');
    if (job.monitor.enabled) parts.push('watching for changes');
    return parts.join(' · ');
  }

  return `Auto Refresh — ${pauseLabel(job.pauseReason)}`;
}

/**
 * @param {string|null} reason
 * @returns {string}
 */
export function pauseLabel(reason) {
  switch (reason) {
    case PAUSE_REASON.NAVIGATED_AWAY:
      return 'paused, you navigated away';
    case PAUSE_REASON.MAX_RELOADS:
      return 'finished, reload limit reached';
    case PAUSE_REASON.DEADLINE:
      return 'finished, time limit reached';
    case PAUSE_REASON.KEYWORD_MATCH:
      return 'stopped, the page changed';
    case PAUSE_REASON.PAGE_NOT_RESPONDING:
      return 'paused, the page stopped responding';
    case PAUSE_REASON.NO_PERMISSION:
      return 'paused, site access was revoked';
    case PAUSE_REASON.DIRTY_FORM:
      return 'waiting, unsaved text in a form';
    case PAUSE_REASON.DISCARDED:
      return 'paused, Chrome unloaded this tab';
    default:
      return 'paused';
  }
}
