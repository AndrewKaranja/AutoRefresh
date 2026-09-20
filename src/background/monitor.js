// @ts-check
/**
 * Page-change detection.
 *
 * The reframe that makes this tractable: with auto-refresh running, the
 * document is destroyed and rebuilt every cycle. So this is a CROSS-RELOAD
 * DIFF, not a live-mutation problem. v1 had an unconditional MutationObserver
 * on `document` with {childList, subtree} running on every page on the web,
 * firing a storage read per batch -- the worst possible shape for a question
 * that is really "is this text different from last time?".
 *
 * The agent ships raw innerText here and every decision happens in this
 * process: normalise, hash, compare, diff. That keeps the content script thin
 * and import-free, and it keeps the whole pipeline unit-testable on plain
 * strings.
 */

import { PAUSE_REASON } from '../lib/constants.js';
import { hashText, hashUrl } from '../lib/hash.js';
import { diffSnippet, normalize } from '../lib/text.js';
import { getMonitorSnapshot, setMonitorSnapshot } from '../lib/storage.js';
import { notify, playSound, tabNotificationId } from './alerts.js';
import * as badge from './badge.js';
import { getJob, saveJob, withJobLock } from './jobs.js';
import { countChanges, pause } from './scheduler.js';
import { prettyUrl } from '../lib/format.js';

/**
 * Handles one sample from the agent.
 *
 * @param {number} tabId
 * @param {{text: string, url: string, selectorMissing?: boolean}} sample
 * @returns {Promise<void>}
 */
export async function onSample(tabId, sample) {
  const job = await withJobLock(async () => {
    const j = await getJob(tabId);
    if (!j || !j.monitor.enabled) return null;

    const text = normalize(sample.text, j.monitor.ignoreRegex);
    const hash = hashText(text);
    const first = j.monitor.lastHash === null;
    const changed = !first && hash !== j.monitor.lastHash;

    j.monitor.lastHash = hash;
    if (changed) {
      j.monitor.changeCount += 1;
      j.monitor.lastChangeAt = Date.now();
    }
    await saveJob(j);

    // Stash the normalised text so the *next* change can describe itself.
    // Keyed by a hash of the URL rather than the URL, so local storage never
    // holds a readable list of what the user watches.
    const key = hashUrl(sample.url || j.url);
    const previous = changed ? await getMonitorSnapshot(key) : null;
    await setMonitorSnapshot(key, text);

    return changed ? { job: j, snippet: diffSnippet(previous?.text || '', text) } : null;
  });

  if (!job) {
    // Not a change -- but a selector that stopped matching is worth saying out
    // loud, because the alternative is reporting "no change" forever while the
    // user believes it is working.
    if (sample.selectorMissing) await warnSelectorLost(tabId);
    return;
  }

  await fireAlert(job.job, job.snippet);
}

/**
 * @param {import('../lib/schema.js').Job} job
 * @param {string} snippet
 * @returns {Promise<void>}
 */
async function fireAlert(job, snippet) {
  const actions = job.monitor.onMatch;
  countChanges(1);

  if (actions.sound) await playSound();

  if (actions.notify) {
    // A stable per-tab id means repeated changes replace the previous alert
    // instead of stacking a tower of notifications, and a click can find the
    // right tab without the worker holding a map that would not survive
    // termination.
    const created = /** @type {Promise<string>} */ (
      /** @type {any} */ (chrome.notifications.create(tabNotificationId(job.tabId), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('assets/icons/icon-128.png'),
        title: chrome.i18n.getMessage('notifChangedTitle') || 'Page changed',
        message: snippet || prettyUrl(job.url),
        contextMessage: prettyUrl(job.url),
        priority: 2,
        requireInteraction: false,
      }))
    );
    await Promise.resolve(created).catch(() =>
      notify({ title: 'Page changed', message: snippet || prettyUrl(job.url) }),
    );
  }

  if (actions.focusTab) {
    try {
      await chrome.tabs.update(job.tabId, { active: true });
      await chrome.windows.update(job.windowId, { focused: true });
    } catch {
      /* tab or window gone */
    }
  }

  if (actions.stop) {
    await pause(job, PAUSE_REASON.KEYWORD_MATCH);
  } else if (actions.badge) {
    await badge.update(job.tabId, job);
  }
}

/**
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function warnSelectorLost(tabId) {
  const job = await getJob(tabId);
  if (!job || !job.monitor.enabled) return;

  await notify({
    title: 'Watched region not found',
    message:
      'The part of the page you chose to watch has moved or been renamed. ' +
      'Open Auto Refresh and pick it again.',
    contextMessage: prettyUrl(job.url),
  });
}
