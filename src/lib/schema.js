// @ts-check
/**
 * The data contract. Every other module type-checks against these typedefs
 * under `checkJs`, which is the cheap half of what a TypeScript build would
 * buy -- and the half that would have caught both of the ReferenceErrors that
 * left v1.0.2 non-functional.
 */

import {
  MIN_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MONITOR_SETTLE_MS,
  RELOAD_METHOD,
  SCHEMA_VERSION,
  SCOPE_MODE,
  STATUS,
} from './constants.js';
import { originOf } from './scope.js';

/**
 * @typedef {Object} Randomize
 * @property {boolean} enabled
 * @property {number} minMs  Lower bound of the draw. Also decides alarm-vs-page
 *                           mode, so a 20-90s range stays in page mode for its
 *                           whole life instead of flip-flopping per cycle.
 * @property {number} maxMs
 */

/**
 * @typedef {Object} ScrollRestore
 * @property {boolean} enabled
 * @property {string|null} selector  Scroll container, or null for the window.
 */

/**
 * @typedef {Object} MonitorMatchActions
 * @property {boolean} notify
 * @property {boolean} sound
 * @property {boolean} stop
 * @property {boolean} focusTab
 * @property {boolean} badge
 */

/**
 * @typedef {Object} Monitor
 * @property {boolean} enabled
 * @property {string|null} selector    Watched region; null means document.body.
 * @property {string|null} textAnchor  First ~60 chars of the region at pick
 *                                     time. If the selector later matches
 *                                     nothing we re-find by this and tell the
 *                                     user their region moved, rather than
 *                                     silently reporting "no change" forever.
 * @property {string|null} ignoreRegex Stripped before hashing. This is what
 *                                     makes monitoring usable on pages with
 *                                     clocks, relative timestamps or rotating
 *                                     ads -- without it every reload is a
 *                                     false positive.
 * @property {number} settleMs
 * @property {boolean} liveWatch
 * @property {string|null} lastHash
 * @property {number|null} lastChangeAt
 * @property {number} changeCount
 * @property {MonitorMatchActions} onMatch
 */

/**
 * @typedef {Object} Scope
 * @property {'origin'|'exact'|'prefix'|'any'} mode
 * @property {string} value
 */

/**
 * @typedef {Object} PendingReload
 * @property {string} nonce
 * @property {number} at
 * @property {string} method
 */

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {number} tabId
 * @property {number} windowId
 * @property {number} createdAt
 * @property {string} origin
 * @property {string} url
 * @property {string} title
 * @property {string} favIconUrl
 * @property {'running'|'paused'|'stopped'} status
 * @property {string|null} pauseReason
 * @property {number} intervalMs
 * @property {Randomize} randomize
 * @property {'alarm'|'page'} mode          Derived on every arm; never trusted
 *                                          when read back from storage.
 * @property {boolean} waitForLoad
 * @property {number} effectiveIntervalMs   The draw used for the current cycle.
 * @property {number} nextFireAt            Advisory only, for the countdown UI.
 * @property {'soft'|'hard'|'navigate'} reloadMethod
 * @property {ScrollRestore} scrollRestore
 * @property {number} reloadCount
 * @property {number} maxReloads            0 = unlimited.
 * @property {number|null} stopAt           Absolute epoch-ms deadline.
 * @property {boolean} skipIfDirtyForm
 * @property {boolean} pauseWhenDiscarded
 * @property {number} consecutiveStalls
 * @property {Scope} scope
 * @property {Monitor} monitor
 * @property {PendingReload|null} pending
 * @property {string|null} ruleId
 * @property {number} schemaVersion
 */

/**
 * A partial job update, which is what every caller actually sends.
 *
 * `Partial<Job>` is not enough: the popup submits `monitor` as
 * `{enabled, selector, ignoreRegex, onMatch}` with `onMatch` itself partial.
 * Spelling the nesting out here is what lets mergeJob() be type-checked
 * rather than taking `any` and hoping.
 *
 * @typedef {Partial<Omit<Job, 'randomize'|'scrollRestore'|'scope'|'monitor'>> & {
 *   randomize?: Partial<Randomize>,
 *   scrollRestore?: Partial<ScrollRestore>,
 *   scope?: Partial<Scope>,
 *   monitor?: Partial<Omit<Monitor, 'onMatch'>> & { onMatch?: Partial<MonitorMatchActions> }
 * }} JobPatch
 */

/**
 * The parts of a tab a job is built from. Narrower than chrome.tabs.Tab on
 * purpose -- these five fields are all that is read, so callers (and tests)
 * need not fabricate the other nine.
 *
 * @typedef {Object} TabSeed
 * @property {number} [id]
 * @property {number} [windowId]
 * @property {string} [url]
 * @property {string} [title]
 * @property {string} [favIconUrl]
 */

/**
 * @typedef {Object} Rule
 * @property {string} id
 * @property {boolean} enabled
 * @property {string} pattern
 * @property {'matchPattern'|'glob'|'regex'} matchKind
 * @property {number} priority
 * @property {boolean} autoStart
 * @property {boolean} onlyOncePerTab
 * @property {Partial<Job>} settings
 * @property {number} createdAt
 */

/**
 * @typedef {Object} Settings
 * @property {'auto'|'light'|'dark'} theme
 * @property {number} defaultIntervalMs
 * @property {number[]} presets
 * @property {boolean} soundEnabled
 * @property {number} soundVolume
 * @property {string} soundFile
 * @property {boolean} notificationsEnabled
 * @property {boolean} advancedOpen
 * @property {number} schemaVersion
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    theme: 'auto',
    defaultIntervalMs: 30_000,
    presets: [5_000, 10_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000],
    soundEnabled: true,
    soundVolume: 0.7,
    soundFile: 'chime.mp3',
    notificationsEnabled: true,
    advancedOpen: false,
    schemaVersion: SCHEMA_VERSION,
  };
}

/** @returns {Monitor} */
export function defaultMonitor() {
  return {
    enabled: false,
    selector: null,
    textAnchor: null,
    ignoreRegex: null,
    settleMs: MONITOR_SETTLE_MS,
    liveWatch: false,
    lastHash: null,
    lastChangeAt: null,
    changeCount: 0,
    onMatch: { notify: true, sound: true, stop: false, focusTab: false, badge: true },
  };
}

/**
 * Builds a complete job from a partial spec. Every optional field gets a
 * concrete default here so that no other module has to guard for `undefined`.
 *
 * @param {Object} spec
 * @param {TabSeed} spec.tab
 * @param {number} spec.intervalMs
 * @param {JobPatch} [spec.overrides]
 * @returns {Job}
 */
export function makeJob({ tab, intervalMs, overrides = {} }) {
  const url = tab.url || '';
  // originOf() returns null for both unparseable URLs and opaque origins, so
  // neither can produce a scope value that accidentally matches something else.
  const origin = originOf(url) || '';

  /** @type {Job} */
  const job = {
    id: `j_${crypto.randomUUID()}`,
    tabId: /** @type {number} */ (tab.id),
    // chrome.windows.WINDOW_ID_NONE. Only reached for a tab with no window,
    // which the callers already filter out; a real number keeps every
    // downstream windows.update() call type-safe.
    windowId: tab.windowId ?? -1,
    createdAt: Date.now(),
    origin,
    url,
    title: tab.title || url,
    favIconUrl: tab.favIconUrl || '',

    status: STATUS.RUNNING,
    pauseReason: null,

    intervalMs: clampInterval(intervalMs),
    randomize: { enabled: false, minMs: clampInterval(intervalMs), maxMs: clampInterval(intervalMs) },
    mode: 'alarm',
    waitForLoad: true,
    effectiveIntervalMs: clampInterval(intervalMs),
    nextFireAt: 0,

    reloadMethod: RELOAD_METHOD.SOFT,
    scrollRestore: { enabled: true, selector: null },

    reloadCount: 0,
    maxReloads: 0,
    stopAt: null,
    skipIfDirtyForm: true,
    pauseWhenDiscarded: false,
    consecutiveStalls: 0,

    scope: { mode: SCOPE_MODE.ORIGIN, value: origin },
    monitor: defaultMonitor(),

    pending: null,
    ruleId: null,
    schemaVersion: SCHEMA_VERSION,
  };

  return mergeJob(job, overrides);
}

/**
 * Applies a partial job patch without losing nested state.
 *
 * A plain `Object.assign` or spread is shallow, and the popup only ever sends
 * the nested fields it owns -- `monitor` arrives as
 * `{enabled, selector, ignoreRegex, onMatch}` with no `lastHash`,
 * `changeCount` or `settleMs`. Assigning that over the real monitor would wipe
 * the change-detection state on every settings tweak, so the next sample would
 * look like a first sample and no change would ever be reported again.
 *
 * @param {Job} base
 * @param {JobPatch} patch
 * @returns {Job}
 */
export function mergeJob(base, patch) {
  // Each nested object is reconciled first, so the final assembly below is a
  // complete Job rather than something that only becomes complete after a
  // series of patch-ups.
  /** @type {Monitor} */
  const monitor = {
    ...base.monitor,
    ...patch.monitor,
    onMatch: { ...base.monitor.onMatch, ...patch.monitor?.onMatch },
  };

  // Changing WHAT is watched invalidates the stored fingerprint: comparing a
  // new region against the old region's hash would report a bogus change on
  // the very next load. Changing anything else must NOT reset it, or every
  // settings tweak costs the user a spurious alert.
  const regionChanged =
    patch.monitor?.selector !== undefined && patch.monitor.selector !== base.monitor.selector;
  const filterChanged =
    patch.monitor?.ignoreRegex !== undefined && patch.monitor.ignoreRegex !== base.monitor.ignoreRegex;
  if (regionChanged || filterChanged) monitor.lastHash = null;

  return {
    ...base,
    ...patch,
    randomize: { ...base.randomize, ...patch.randomize },
    scrollRestore: { ...base.scrollRestore, ...patch.scrollRestore },
    scope: { ...base.scope, ...patch.scope },
    monitor,
  };
}

/** @param {number} ms @returns {number} */
export function clampInterval(ms) {
  if (!Number.isFinite(ms)) return 30_000;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(ms)));
}

/**
 * The subset of a job that is safe and useful to hand to the UI. Keeps the
 * reload nonce and other internals out of message payloads.
 *
 * @param {Job} job
 * @returns {Object}
 */
export function publicView(job) {
  return {
    id: job.id,
    tabId: job.tabId,
    windowId: job.windowId,
    url: job.url,
    title: job.title,
    favIconUrl: job.favIconUrl,
    origin: job.origin,
    status: job.status,
    pauseReason: job.pauseReason,
    intervalMs: job.intervalMs,
    randomize: job.randomize,
    mode: job.mode,
    effectiveIntervalMs: job.effectiveIntervalMs,
    nextFireAt: job.nextFireAt,
    reloadMethod: job.reloadMethod,
    scrollRestore: job.scrollRestore,
    reloadCount: job.reloadCount,
    maxReloads: job.maxReloads,
    stopAt: job.stopAt,
    skipIfDirtyForm: job.skipIfDirtyForm,
    pauseWhenDiscarded: job.pauseWhenDiscarded,
    scope: job.scope,
    monitor: {
      enabled: job.monitor.enabled,
      selector: job.monitor.selector,
      ignoreRegex: job.monitor.ignoreRegex,
      liveWatch: job.monitor.liveWatch,
      changeCount: job.monitor.changeCount,
      lastChangeAt: job.monitor.lastChangeAt,
      onMatch: job.monitor.onMatch,
    },
    ruleId: job.ruleId,
  };
}
