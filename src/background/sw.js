// @ts-check
/**
 * Service worker entry point.
 *
 * This file does ONE thing: register every event listener synchronously at top
 * level. Chrome needs to see them during the worker's initial evaluation, and
 * a listener registered inside a promise callback or an async function simply
 * will not be found when the event fires -- which looks exactly like "the
 * feature randomly stopped working".
 *
 * All real logic lives in the sibling modules. Every handler starts with
 * `await ensureRehydrated()` (directly or via the router) because the worker
 * is torn down constantly and may be woken by any event, not just onStartup.
 */

import { MSG, PAUSE_REASON, STATUS } from '../lib/constants.js';
import { defaultSettings } from '../lib/schema.js';
import { isRestrictedUrl, originOf } from '../lib/scope.js';
import { getPendingStart, setPendingStart, setSettings } from '../lib/storage.js';
import { tabIdFromNotification } from './alerts.js';
import * as badge from './badge.js';
import { getJob, listJobs, rekeyJob } from './jobs.js';
import { attachAgentIfNeeded, installRouter } from './messaging.js';
import { hasOriginAccess, injectAgentNow, reconcileRegistrations } from './permissions.js';
import {
  destroy,
  ensureRehydrated,
  fire,
  onAgentReady,
  onAlarm,
  pause,
  resume,
  startForTab,
} from './scheduler.js';

installRouter();

// ---------------------------------------------------------------------------
// Install / startup
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await setSettings(defaultSettings());
  } else if (details.reason === 'update') {
    // v1 kept everything in worker globals and never wrote the one sync key it
    // read, so there is genuinely nothing to migrate -- just a dead key to
    // sweep up and defaults to establish.
    await chrome.storage.sync.remove('monitorChangesEnabled').catch(() => {});
    await setSettings({});
  }
  await reconcileRegistrations();
  await ensureRehydrated();
});

chrome.runtime.onStartup.addListener(async () => {
  await reconcileRegistrations();
  await ensureRehydrated();
});

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener((alarm) => {
  void onAlarm(alarm);
});

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // v1 never did this, so every closed tab leaked a timer handle and a status
  // flag for the life of the browser session.
  await ensureRehydrated();
  await destroy(tabId);
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  // Prerender and back/forward-cache swaps hand the same page a brand new tab
  // id. Without rekeying, the job is stranded under an id nothing references
  // and its alarm fires forever against a tab that no longer exists.
  await ensureRehydrated();
  const job = await rekeyJob(removedTabId, addedTabId);
  if (job) {
    await badge.clear(removedTabId);
    await badge.update(addedTabId, job);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // onUpdated has no event filters (that is webNavigation, which this
  // extension deliberately does not request) and fires several times per
  // navigation. Filter here or the job gets re-armed three or four times a
  // load.
  if (changeInfo.status !== 'complete') return;
  if (!tab.url || isRestrictedUrl(tab.url)) return;

  await ensureRehydrated();
  const job = await getJob(tabId);
  if (!job) return;

  // In basic mode there is no agent to send the handshake, so this stands in
  // for it. Both paths are idempotent -- whichever arrives first consumes the
  // pending marker, so a reload is counted exactly once either way.
  await onAgentReady(tabId, tab.url);

  // Best-effort activeTab injection for jobs that want page features but have
  // no registered content script. Harmless when one is already running.
  if (job.status === STATUS.RUNNING) {
    const needsAgent = job.mode === 'page' || job.scrollRestore.enabled || job.monitor.enabled;
    if (needsAgent && !(await hasOriginAccess(tab.url))) {
      await injectAgentNow(tabId);
    }
  }
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  await ensureRehydrated();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || isRestrictedUrl(tab.url)) return;

  const job = await getJob(tab.id);

  if (command === 'toggle-refresh') {
    if (!job) {
      // No job yet: the shortcut cannot open the popup to ask for settings, so
      // start one on the stored default.
      await chrome.runtime.sendMessage({ type: MSG.START_JOB, tabId: tab.id }).catch(() => {});
      return;
    }
    if (job.status === STATUS.RUNNING) await pause(job, PAUSE_REASON.USER);
    else await resume(tab.id);
    return;
  }

  if (command === 'reload-now') {
    if (job) await fire(job, 'manual');
    else await chrome.tabs.reload(tab.id);
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const tabId = tabIdFromNotification(notificationId);
  if (tabId === null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* tab closed since the alert */
  }
  await Promise.resolve(chrome.notifications.clear(notificationId)).catch(() => {});
});

// ---------------------------------------------------------------------------
// Permission changes
// ---------------------------------------------------------------------------

chrome.permissions.onRemoved.addListener(async () => {
  // Revoking access in chrome://extensions must not leave jobs quietly
  // pretending to watch a page they can no longer read.
  await ensureRehydrated();
  await reconcileRegistrations();

  for (const job of await listJobs()) {
    if (job.status !== STATUS.RUNNING) continue;
    const needsAgent = job.mode === 'page' || job.scrollRestore.enabled || job.monitor.enabled;
    if (needsAgent && !(await hasOriginAccess(job.url))) {
      await pause(job, PAUSE_REASON.NO_PERMISSION);
    }
  }
});

chrome.permissions.onAdded.addListener(async () => {
  await ensureRehydrated();

  // Finish a start that was waiting on this grant.
  //
  // chrome.permissions.request() closes the popup that called it -- Chrome
  // replaces it with its own confirmation dialog -- so the popup code after
  // the await never runs. Without this the user grants permission, nothing
  // happens, and they have to reopen the popup and press Start again. The
  // popup records its intent before asking; this is where it gets honoured.
  const pending = await getPendingStart();
  if (pending) {
    await setPendingStart(null);
    try {
      if (await hasOriginAccess(pending.url)) {
        const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
        // Only if the tab is still on the page they asked about -- granting
        // access should not start a job on whatever they browsed to since.
        if (tab && tab.url && originOf(tab.url) === originOf(pending.url)) {
          const job = await startForTab(pending.tabId, pending.job || {});
          await attachAgentIfNeeded(job);
        }
      }
    } catch (err) {
      console.warn('[AutoRefresh] could not start after permission grant', err);
    }
  }

  for (const job of await listJobs()) {
    if (job.status === STATUS.PAUSED && job.pauseReason === PAUSE_REASON.NO_PERMISSION) {
      if (await hasOriginAccess(job.url)) await resume(job.tabId);
    }
  }
});
