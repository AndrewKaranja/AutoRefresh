// @ts-check
/**
 * ============================================================================
 * THE THREE INVARIANTS
 * ============================================================================
 *
 * A. SINGLE ALARM. Every running job has exactly one outstanding alarm named
 *    `arf:<jobId>`. In ALARM mode it is the timer. In PAGE mode it is a stall
 *    watchdog. One reconciliation path, one rebuild path, one class of leak.
 *
 * B. MODE IS DERIVED, NEVER STORED. `mode` is recomputed from the interval's
 *    *lower bound* on every arm and never trusted when read back. A randomized
 *    20-90s job therefore stays on one timing mechanism for its whole life
 *    instead of thrashing between two.
 *
 * C. RELOAD CORRELATION. Any reload we initiate writes `job.pending`
 *    BEFORE calling the Chrome API; the next handshake consumes it. This is
 *    the only thing distinguishing our reload from the user pressing F5, and
 *    therefore the only reason the reload counter and stop conditions are
 *    honest.
 *
 * ---------------------------------------------------------------------------
 * THE CONSEQUENCE WORTH READING TWICE
 *
 * PAGE mode does NOT call location.reload(). The content script's timer fires,
 * it messages the worker, and the worker calls chrome.tabs.reload. Two
 * reasons, both decisive:
 *
 *   1. It deletes the "reload destroys the content script mid-message" race
 *      outright -- the reload is initiated from a context that is not being
 *      torn down by it.
 *   2. location.reload(true) has been a no-op since forceReload left the spec.
 *      A hard reload is reachable only through
 *      chrome.tabs.reload(tabId, {bypassCache:true}), so the worker has to be
 *      the one doing it regardless.
 *
 * Content script owns timing. Service worker owns execution.
 * ============================================================================
 */

import {
  ALARM_PREFIX,
  DIRTY_FORM_POSTPONE_MS,
  DIRTY_FORM_PROBE_MS,
  MAX_CONSECUTIVE_STALLS,
  MSG,
  PAUSE_REASON,
  PENDING_TTL_MS,
  RELOAD_METHOD,
  STATS_FLUSH_MS,
  STATUS,
  WATCHDOG_GRACE_MS,
} from '../lib/constants.js';
import { alarmDelayMs, deriveMode, drawInterval, stopConditionMet, toAlarmMinutes } from '../lib/interval.js';
import { scopeMatches } from '../lib/scope.js';
import { publicView } from '../lib/schema.js';
import { bumpStats } from '../lib/storage.js';
import * as badge from './badge.js';
import { deleteJob, getJob, listJobs, saveJob, withJobLock } from './jobs.js';

/** @typedef {import('../lib/schema.js').Job} Job */

// ---------------------------------------------------------------------------
// Rehydration
// ---------------------------------------------------------------------------

/**
 * The ONLY module-level state in the worker, and it holds no truth -- just a
 * promise so rehydration runs once per worker lifetime rather than once per
 * event. Globals reset when Chrome tears the worker down, which is exactly the
 * moment we want this to run again.
 *
 * @type {Promise<void>|null}
 */
let rehydrating = null;

/** @returns {Promise<void>} */
export function ensureRehydrated() {
  if (!rehydrating) rehydrating = doRehydrate();
  return rehydrating;
}

/**
 * Reconciles storage against reality: drop jobs whose tab is gone, create
 * alarms that should exist, clear alarms that shouldn't, repaint badges.
 *
 * Runs on onStartup and onInstalled, but crucially also on the first event of
 * any worker lifetime -- because the worker is just as likely to be woken by
 * an alarm or a message after a crash as it is to get a tidy startup event.
 *
 * @returns {Promise<void>}
 */
async function doRehydrate() {
  const [jobs, tabs, alarms] = await Promise.all([
    listJobs(),
    chrome.tabs.query({}),
    chrome.alarms.getAll(),
  ]);

  const liveTabIds = new Set(tabs.map((t) => t.id));
  /** @type {Set<string>} */
  const liveJobIds = new Set();

  for (const job of jobs) {
    if (!liveTabIds.has(job.tabId)) {
      // After a browser restart every tab id is new, so this drops the whole
      // previous session. That is correct, not a bug: persistence of *intent*
      // is the job of site rules, not of resurrecting stale instances.
      await deleteJob(job.tabId);
      continue;
    }

    liveJobIds.add(job.id);

    if (job.status === STATUS.RUNNING) {
      const has = alarms.some((a) => a.name === alarmName(job.id));
      if (!has) await arm(job);
      else await badge.update(job.tabId, job);
    } else {
      await badge.update(job.tabId, job);
    }
  }

  // Orphaned alarms outlive their jobs whenever the worker died between
  // deleting a job and clearing its alarm. Left alone they wake the worker
  // forever for a job that no longer exists.
  for (const alarm of alarms) {
    if (!alarm.name.startsWith(ALARM_PREFIX)) continue;
    if (!liveJobIds.has(alarm.name.slice(ALARM_PREFIX.length))) {
      await chrome.alarms.clear(alarm.name);
    }
  }
}

/** @param {string} jobId @returns {string} */
function alarmName(jobId) {
  return ALARM_PREFIX + jobId;
}

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

/**
 * The single place a job is ever (re)armed. Everything else routes here.
 *
 * One-shot alarms, recreated each cycle, rather than `periodInMinutes`.
 * Alarms are browser-level and survive worker termination either way, and a
 * randomized interval needs a fresh draw per cycle -- so periodic alarms would
 * buy nothing and cost the randomization feature.
 *
 * @param {Job} job
 * @returns {Promise<Job>}
 */
export async function arm(job) {
  const mode = deriveMode(job); // Invariant B: derived here, every time.
  const eff = drawInterval(job);

  job.mode = mode;
  job.effectiveIntervalMs = eff;
  job.status = STATUS.RUNNING;
  job.pauseReason = null;
  job.nextFireAt = Date.now() + (mode === 'alarm' ? alarmDelayMs(mode, eff) : eff);

  await saveJob(job);

  await chrome.alarms.clear(alarmName(job.id));
  // toAlarmMinutes throws below 30s rather than letting Chrome silently
  // ignore it -- see the comment there. If this ever throws in development,
  // the bug it caught would have been invisible in production.
  await chrome.alarms.create(alarmName(job.id), {
    delayInMinutes: toAlarmMinutes(alarmDelayMs(mode, eff)),
  });

  await badge.update(job.tabId, job);
  return job;
}

// ---------------------------------------------------------------------------
// Alarm handling
// ---------------------------------------------------------------------------

/**
 * @param {chrome.alarms.Alarm} alarm
 * @returns {Promise<void>}
 */
export async function onAlarm(alarm) {
  if (!alarm.name.startsWith(ALARM_PREFIX)) return;
  await ensureRehydrated();

  const jobId = alarm.name.slice(ALARM_PREFIX.length);
  const job = (await listJobs()).find((j) => j.id === jobId);

  if (!job || job.status !== STATUS.RUNNING) {
    // Includes the recycled-tab-id case: the alarm carries a job id, so a new
    // job in a reused tab id can never be driven by a dead job's alarm.
    await chrome.alarms.clear(alarm.name);
    return;
  }

  if (deriveMode(job) === 'page' && job.nextFireAt > Date.now() - WATCHDOG_GRACE_MS) {
    // The watchdog beat a healthy page timer to it. Re-arm, don't double-fire.
    await arm(job);
    return;
  }

  await fire(job, deriveMode(job) === 'page' ? 'watchdog' : 'primary');
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

/**
 * Performs one reload.
 *
 * @param {Job} job
 * @param {'primary'|'watchdog'|'page-timer'|'manual'} reason
 * @returns {Promise<void>}
 */
export async function fire(job, reason) {
  const tab = await getTab(job.tabId);
  if (!tab) {
    await destroy(job.tabId, job.id);
    return;
  }

  if (reason === 'watchdog') {
    job.consecutiveStalls += 1;
    if (job.consecutiveStalls >= MAX_CONSECUTIVE_STALLS) {
      await pause(job, PAUSE_REASON.PAGE_NOT_RESPONDING);
      return;
    }
  }

  if (job.pauseWhenDiscarded && tab.discarded) {
    await pause(job, PAUSE_REASON.DISCARDED);
    return;
  }

  const stop = stopConditionMet(job);
  if (stop) {
    await pause(job, stop);
    return;
  }

  // A page holding unsaved form input will raise "Leave site?" and hang the
  // job on a modal forever. There is no API to suppress it, so we ask the
  // agent and step aside if the answer is yes. Note the fail-OPEN default: if
  // the agent does not answer in time we reload anyway, because an
  // auto-refresher that stops refreshing is a worse failure than a lost draft
  // on a page the user chose to auto-refresh.
  if (job.skipIfDirtyForm) {
    const dirty = await askAgent(job.tabId, { type: MSG.IS_DIRTY }, DIRTY_FORM_PROBE_MS);
    if (dirty === true) {
      await postpone(job, DIRTY_FORM_POSTPONE_MS);
      return;
    }
  }

  // Invariant C: the marker is written BEFORE the reload, because the
  // handshake that consumes it can arrive before this function's next line
  // would have run.
  job.pending = { nonce: crypto.randomUUID(), at: Date.now(), method: job.reloadMethod };
  await saveJob(job);

  try {
    switch (job.reloadMethod) {
      case RELOAD_METHOD.HARD:
        await chrome.tabs.reload(job.tabId, { bypassCache: true });
        break;
      case RELOAD_METHOD.NAVIGATE:
        // Re-navigating as a fresh GET is the only clean escape from
        // "Confirm Form Resubmission" on a POST result page.
        await chrome.tabs.update(job.tabId, { url: job.url });
        break;
      default:
        await chrome.tabs.reload(job.tabId);
    }
  } catch {
    await destroy(job.tabId, job.id);
    return;
  }

  // Re-arm as a stall watchdog. If the handshake never arrives -- a PDF, a
  // chrome:// page, a net error, a CSP-blocked injection, a discarded tab --
  // this is what stops the job hanging silently forever.
  await chrome.alarms.clear(alarmName(job.id));
  await chrome.alarms.create(alarmName(job.id), {
    delayInMinutes: toAlarmMinutes(alarmDelayMs('page', job.effectiveIntervalMs)),
  });
}

/**
 * Pushes the next fire out without counting a cycle.
 *
 * @param {Job} job
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function postpone(job, ms) {
  job.nextFireAt = Date.now() + ms;
  await saveJob(job);
  await chrome.alarms.clear(alarmName(job.id));
  await chrome.alarms.create(alarmName(job.id), { delayInMinutes: toAlarmMinutes(Math.max(30_000, ms)) });
}

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

/**
 * Called by the agent on every fresh document. This is the single re-arm
 * point, and the only place `reloadCount` ever moves.
 *
 * The handshake is not optional plumbing: a content script cannot learn its
 * own tab id without asking the worker, so this round-trip has to happen
 * anyway. Making it the re-arm point costs nothing extra.
 *
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<Object>}
 */
export async function onAgentReady(tabId, url) {
  await ensureRehydrated();

  return withJobLock(async () => {
    const job = await getJob(tabId);
    if (!job) return { job: null };

    if (job.status === STATUS.STOPPED) return { job: null };

    if (!scopeMatches(job.scope, url)) {
      // Pause, never delete. The user may well come back, and silently losing
      // their configuration because they clicked a link is the behaviour that
      // makes people uninstall these extensions.
      job.status = STATUS.PAUSED;
      job.pauseReason = PAUSE_REASON.NAVIGATED_AWAY;
      job.pending = null;
      await saveJob(job);
      await chrome.alarms.clear(alarmName(job.id));
      await badge.update(tabId, job);
      return { job: publicView(job) };
    }

    // Back in scope after wandering off: resume without being asked.
    const wasAway = job.status === STATUS.PAUSED && job.pauseReason === PAUSE_REASON.NAVIGATED_AWAY;

    if (job.pending && Date.now() - job.pending.at < PENDING_TTL_MS) {
      job.reloadCount += 1;
      countReload();
    }
    // else: the user navigated or pressed F5. Keep the job, don't count it.
    job.pending = null;
    job.consecutiveStalls = 0;
    job.url = url;

    if (job.status === STATUS.PAUSED && !wasAway) {
      // Paused for some other reason -- stay paused, but acknowledge the agent
      // so it does not keep retrying.
      await saveJob(job);
      await badge.update(tabId, job);
      return { job: publicView(job) };
    }

    const stop = stopConditionMet(job);
    if (stop) {
      job.status = STATUS.PAUSED;
      job.pauseReason = stop;
      await saveJob(job);
      await chrome.alarms.clear(alarmName(job.id));
      await badge.update(tabId, job);
      return { job: publicView(job) };
    }

    await arm(job);

    return {
      job: publicView(job),
      // Only page mode gets a timer; alarm-mode agents just sit there.
      armPageMs: job.mode === 'page' ? job.effectiveIntervalMs : null,
      waitForLoad: job.waitForLoad,
      scroll: job.scrollRestore,
      monitor: job.monitor.enabled
        ? { selector: job.monitor.selector, settleMs: job.monitor.settleMs, liveWatch: job.monitor.liveWatch }
        : null,
    };
  });
}

/**
 * The page timer elapsed. Idempotent via the pending marker, so an agent that
 * retries after a timeout cannot double-reload.
 *
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function onPageTimer(tabId) {
  await ensureRehydrated();
  const job = await getJob(tabId);
  if (!job || job.status !== STATUS.RUNNING) return;
  if (job.pending && Date.now() - job.pending.at < PENDING_TTL_MS) return; // already firing
  await fire(job, 'page-timer');
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * @param {Job} job
 * @returns {Promise<Job>}
 */
export async function start(job) {
  return arm(job);
}

/**
 * @param {Job} job
 * @param {string} reason
 * @returns {Promise<void>}
 */
export async function pause(job, reason) {
  job.status = STATUS.PAUSED;
  job.pauseReason = reason;
  job.pending = null;
  job.nextFireAt = 0;
  await saveJob(job);
  await chrome.alarms.clear(alarmName(job.id));
  await badge.update(job.tabId, job);
}

/**
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function resume(tabId) {
  const job = await getJob(tabId);
  if (!job) return;
  job.consecutiveStalls = 0;
  // Resuming a finished job restarts its allowance, otherwise the stop
  // condition fires again immediately and "Resume" looks broken.
  if (job.pauseReason === PAUSE_REASON.MAX_RELOADS) job.reloadCount = 0;
  if (job.pauseReason === PAUSE_REASON.DEADLINE) job.stopAt = null;
  await arm(job);
}

/**
 * Full teardown: record, alarm and badge.
 *
 * @param {number} tabId
 * @param {string} [jobId]
 * @returns {Promise<void>}
 */
export async function destroy(tabId, jobId) {
  const id = jobId || (await getJob(tabId))?.id;
  await deleteJob(tabId);
  if (id) await chrome.alarms.clear(alarmName(id));
  await badge.clear(tabId);
}

/**
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function stopJob(tabId) {
  await ensureRehydrated();
  await destroy(tabId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {number} tabId
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
export async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

/**
 * Sends a message to a tab's agent with a deadline.
 *
 * chrome.tabs.sendMessage rejects promptly when no receiver exists, but a page
 * that is mid-navigation can leave it hanging -- and `fire()` cannot block on
 * a form probe indefinitely. Hence the race.
 *
 * @param {number} tabId
 * @param {Object} message
 * @param {number} timeoutMs
 * @returns {Promise<any>} undefined on timeout or no listener
 */
export function askAgent(tabId, message, timeoutMs) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message).catch(() => undefined),
    new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]);
}

// --- lifetime counters -------------------------------------------------------
// storage.local has no write quota, but a 1-second job would still mean a disk
// write every second forever. Accumulate and flush in batches; losing a few
// counts to worker death costs a cosmetic total, not correctness.

let pendingReloads = 0;
let lastFlush = 0;

function countReload() {
  pendingReloads += 1;
  const now = Date.now();
  if (pendingReloads >= 10 || now - lastFlush > STATS_FLUSH_MS) {
    const n = pendingReloads;
    pendingReloads = 0;
    lastFlush = now;
    void bumpStats({ reloads: n });
  }
}

/** @param {number} n */
export function countChanges(n = 1) {
  void bumpStats({ changes: n });
}
