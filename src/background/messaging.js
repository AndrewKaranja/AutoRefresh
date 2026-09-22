// @ts-check
/**
 * The single message router. One vocabulary (MSG), one switch, one place to
 * look when a message goes missing.
 *
 * Chrome's onMessage does not understand a returned promise -- that is a
 * Firefox extension. The listener must return literal `true` synchronously to
 * keep the response port open, then call sendResponse later. Getting this
 * subtly wrong is how "the popup never initialises" bugs happen, so the
 * plumbing is written once, here, and never repeated.
 */

import { MSG, PAUSE_REASON, STATUS } from '../lib/constants.js';
import { mergeJob, publicView } from '../lib/schema.js';
import { isRestrictedUrl, originPattern } from '../lib/scope.js';
import {
  getDraft,
  getPendingStart,
  getRules,
  getSettings,
  getStats,
  setDraft,
  setPendingStart,
  setRules,
  setSettings,
} from '../lib/storage.js';
import { notify, playSound } from './alerts.js';
import * as badge from './badge.js';
import { getJob, listJobs, updateJob } from './jobs.js';
import { onSample } from './monitor.js';
import { hasOriginAccess, injectAgentNow, needsPageAccess, registerAgentFor } from './permissions.js';
import { maybeAutoStart } from './rules.js';
import {
  arm,
  destroy,
  ensureRehydrated,
  fire,
  getTab,
  onAgentReady,
  onPageTimer,
  pause,
  resume,
  startForTab,
} from './scheduler.js';

/**
 * Registers the router. Called synchronously at worker top level.
 *
 * @returns {void}
 */
export function installRouter() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // The offscreen audio document shares this bus; its traffic is not ours.
    if (!message || message.target === 'offscreen') return undefined;

    handle(message, sender)
      .then((result) => sendResponse({ ok: true, ...(result || {}) }))
      .catch((err) => {
        console.error('[AutoRefresh]', message?.type, err);
        sendResponse({ ok: false, error: String(err?.message || err) });
      });

    return true; // keep the port open for the async response
  });
}

/**
 * Gives a job an in-page agent, but only if it actually needs one.
 *
 * A plain alarm-mode refresh does not, and injecting anyway would put our
 * script on a page for no reason.
 *
 * @param {import('../lib/schema.js').Job} job
 * @returns {Promise<void>}
 */
export async function attachAgentIfNeeded(job) {
  if (!needsPageAccess(job)) return;
  // Registration covers FUTURE loads of this origin and does nothing for the
  // document already open, so the current page is injected directly too.
  // Under activeTab alone the inject may fail, which is fine -- the job then
  // simply runs in basic mode.
  if (await hasOriginAccess(job.url)) await registerAgentFor(job.url);
  await injectAgentNow(job.tabId);
}

/**
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<Object|void>}
 */
async function handle(message, sender) {
  await ensureRehydrated();
  const senderTabId = sender.tab?.id;

  switch (message.type) {
    // --- from the page agent ------------------------------------------------

    case MSG.CS_READY: {
      if (typeof senderTabId !== 'number') return { job: null };
      const result = await onAgentReady(senderTabId, message.url || sender.tab?.url || '');
      if (result.job) return result;

      // No job for this tab -- but a site rule might say there should be.
      const tab = sender.tab;
      if (tab) {
        const started = await maybeAutoStart(tab, message.url || tab.url || '');
        if (started) {
          return {
            job: publicView(started),
            armPageMs: started.mode === 'page' ? started.effectiveIntervalMs : null,
            waitForLoad: started.waitForLoad,
            scroll: started.scrollRestore,
            monitor: null,
          };
        }
      }
      return { job: null };
    }

    case MSG.RELOAD_NOW: {
      if (typeof senderTabId === 'number') await onPageTimer(senderTabId);
      return;
    }

    case MSG.MONITOR_SAMPLE: {
      if (typeof senderTabId === 'number') await onSample(senderTabId, message.sample || {});
      return;
    }

    case MSG.PICKER_RESULT: {
      // The popup was destroyed the moment the picker was injected, so the
      // result goes into a draft that the popup re-reads when it reopens.
      const draft = (await getDraft()) || {};
      await setDraft({
        ...draft,
        tabId: senderTabId ?? draft.tabId,
        monitor: {
          ...(draft.monitor || {}),
          enabled: true,
          selector: message.selector || null,
          textAnchor: message.textAnchor || null,
        },
      });
      return;
    }

    case MSG.PICKER_CANCELLED:
      return;

    // --- from the popup / options page --------------------------------------

    case MSG.GET_STATE: {
      const tabId = message.tabId ?? (await activeTabId());
      if (typeof tabId !== 'number') return { job: null, tab: null };

      const tab = await getTab(tabId);
      const job = await getJob(tabId);
      const url = tab?.url || '';

      return {
        job: job ? publicView(job) : null,
        tab: tab ? { id: tab.id, url, title: tab.title, favIconUrl: tab.favIconUrl } : null,
        restricted: isRestrictedUrl(url),
        hasAccess: url ? await hasOriginAccess(url) : false,
        settings: await getSettings(),
        draft: await getDraft(),
        pendingStart: await getPendingStart(),
        activeCount: (await listJobs()).filter((j) => j.status === STATUS.RUNNING).length,
      };
    }

    case MSG.START_JOB: {
      const tabId = message.tabId ?? (await activeTabId());
      if (typeof tabId !== 'number') throw new Error('no tab');
      const job = await startForTab(tabId, message.job || {});
      await attachAgentIfNeeded(job);
      return { job: publicView(job) };
    }

    case MSG.SET_PENDING_START: {
      // Written by the popup immediately BEFORE it calls
      // chrome.permissions.request(), because that call closes the popup and
      // destroys the code that would otherwise have started the job.
      await setPendingStart(message.pending ?? null);
      return;
    }

    case MSG.UPDATE_JOB: {
      const tabId = message.tabId ?? (await activeTabId());
      if (typeof tabId !== 'number') throw new Error('no tab');
      const job = await updateJob(tabId, (j) => {
        Object.assign(j, mergeJob(j, message.job || {}));
      });
      if (job && job.status === STATUS.RUNNING) await arm(job);
      else if (job) await badge.update(tabId, job);
      return { job: job ? publicView(job) : null };
    }

    case MSG.STOP_JOB: {
      const tabId = message.tabId ?? (await activeTabId());
      if (typeof tabId === 'number') await destroy(tabId);
      return;
    }

    case MSG.PAUSE_JOB: {
      const tabId = message.tabId ?? (await activeTabId());
      const job = typeof tabId === 'number' ? await getJob(tabId) : null;
      if (job) await pause(job, PAUSE_REASON.USER);
      return { job: job ? publicView(job) : null };
    }

    case MSG.RESUME_JOB: {
      const tabId = message.tabId ?? (await activeTabId());
      if (typeof tabId === 'number') await resume(tabId);
      const job = typeof tabId === 'number' ? await getJob(tabId) : null;
      return { job: job ? publicView(job) : null };
    }

    case MSG.RELOAD_ONCE: {
      const tabId = message.tabId ?? (await activeTabId());
      if (typeof tabId !== 'number') return;
      const job = await getJob(tabId);
      if (job) await fire(job, 'manual');
      else await chrome.tabs.reload(tabId);
      return;
    }

    case MSG.LIST_JOBS: {
      const jobs = await listJobs();
      return { jobs: jobs.map(publicView), stats: await getStats() };
    }

    // NOTE: there is deliberately no PICK_ELEMENT case. The popup injects the
    // picker itself, because the activeTab grant that makes the injection
    // legal without host permissions comes from the user's click on the
    // action -- and routing it through here added a message hop that only
    // served to swallow the failure.

    case MSG.GET_DRAFT:
      return { draft: await getDraft() };

    case MSG.SET_DRAFT:
      await setDraft(message.draft ?? null);
      return;

    // --- settings and rules -------------------------------------------------

    case MSG.GET_SETTINGS:
      return { settings: await getSettings(), stats: await getStats() };

    case MSG.SET_SETTINGS:
      return { settings: await setSettings(message.patch || {}) };

    case MSG.LIST_RULES:
      return { rules: await getRules() };

    case MSG.SAVE_RULE: {
      const rules = await getRules();
      const i = rules.findIndex((r) => r.id === message.rule.id);
      if (i >= 0) rules[i] = message.rule;
      else rules.push(message.rule);
      await setRules(rules);
      return { rules };
    }

    case MSG.DELETE_RULE: {
      const rules = (await getRules()).filter((r) => r.id !== message.id);
      await setRules(rules);
      return { rules };
    }

    case MSG.REQUEST_ORIGIN_ACCESS: {
      // The request itself happens in the popup (it needs the user gesture);
      // this is the follow-up that makes the grant useful.
      const url = message.url;
      if (!url || !originPattern(url)) return { granted: false };
      const granted = await hasOriginAccess(url);
      if (granted) await registerAgentFor(url);
      return { granted };
    }

    case MSG.TEST_SOUND:
      await playSound(message.file);
      return;

    case MSG.TEST_NOTIFICATION:
      await notify({
        title: chrome.i18n.getMessage('notifTestTitle') || 'Notifications are working',
        message: chrome.i18n.getMessage('notifTestBody') || '',
        force: true,
      });
      return;

    default:
      throw new Error(`unknown message type: ${message.type}`);
  }
}

/** @returns {Promise<number|undefined>} */
async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}
