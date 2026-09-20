// @ts-check
/**
 * Shared constants. Imported by the service worker, the popup and the options
 * page as an ES module.
 *
 * NOTE: content/agent.js cannot import this file -- content scripts are not
 * modules -- so it duplicates the handful of values it needs inside a block
 * marked `AGENT-MIRROR`. scripts/validate-manifest.mjs asserts the two copies
 * still agree, so drift fails the build rather than shipping.
 */

/**
 * Chrome refuses alarms shorter than 30s in *packed* extensions (it warns and
 * silently ignores the request). Unpacked builds have no floor at all, which
 * is precisely why this is a named constant guarded by an assertion rather
 * than a number sprinkled through the scheduler: the bug it prevents is
 * invisible during normal development and only appears once published.
 */
export const ALARM_MIN_MS = 30_000;

/**
 * Below this, the alarm API cannot drive the loop, so timing moves into the
 * page and the alarm is demoted to a stall watchdog. Same number as
 * ALARM_MIN_MS, but a distinct idea -- keep them separate.
 */
export const PAGE_MODE_THRESHOLD_MS = 30_000;

/**
 * Hidden tabs clamp timers to roughly 1/second, so anything faster is a
 * promise we could only keep in the foreground. The UI refuses to go lower.
 */
export const MIN_INTERVAL_MS = 1_000;

/** Intervals below this get a "you may get rate-limited or blocked" warning. */
export const WARN_INTERVAL_MS = 5_000;

export const MAX_INTERVAL_MS = 24 * 60 * 60 * 1_000;

/**
 * How long a `job.pending` reload marker stays valid. If the handshake takes
 * longer than this, we assume the navigation was the user's, not ours, and
 * decline to count it. Generous, because a slow page on a slow link is still
 * our reload.
 */
export const PENDING_TTL_MS = 90_000;

/**
 * In PAGE mode the alarm is a watchdog. If it fires but the page timer is
 * still on schedule (within this grace window), just re-arm instead of
 * double-firing a reload.
 */
export const WATCHDOG_GRACE_MS = 5_000;

/** Extra headroom added to the watchdog alarm on top of the interval. */
export const WATCHDOG_SLACK_MS = 30_000;

/** Consecutive watchdog fires with no handshake before the job gives up. */
export const MAX_CONSECUTIVE_STALLS = 3;

/** How long `fire()` waits for the agent to answer the dirty-form probe. */
export const DIRTY_FORM_PROBE_MS = 300;

/** How long a reload is deferred when the page has unsaved form input. */
export const DIRTY_FORM_POSTPONE_MS = 15_000;

/** Alarm name prefix. The job id is appended, never the tab id -- tab ids get
 *  recycled by Chrome and would resurrect a dead job's alarm. */
export const ALARM_PREFIX = 'arf:';

/** storage.session key prefix for live job records. */
export const JOB_PREFIX = 'job:';

/** storage.local key prefix for monitor text snapshots. */
export const MONITOR_PREFIX = 'mon:';

/** Cap on retained monitor snapshots (LRU). */
export const MONITOR_HISTORY_MAX = 200;

/** Longest page text we will hash, to bound work on enormous documents. */
export const MONITOR_TEXT_CAP = 200_000;

/** Default settle delay before sampling page text after load. */
export const MONITOR_SETTLE_MS = 1_500;

/** Live-watch circuit breaker: disconnect above this many batches per window. */
export const LIVE_WATCH_MAX_BATCHES = 50;
export const LIVE_WATCH_WINDOW_MS = 5_000;
export const LIVE_WATCH_DEBOUNCE_MS = 500;

/** Lifetime counters are batched to storage.local at most this often. */
export const STATS_FLUSH_MS = 30_000;

export const SCHEMA_VERSION = 2;

/** Interval presets offered in the popup, in ms. */
export const PRESETS = [5_000, 10_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000];

/** Message types on the runtime channel. One router, one vocabulary. */
export const MSG = {
  // content script -> service worker
  CS_READY: 'CS_READY',
  RELOAD_NOW: 'RELOAD_NOW',
  MONITOR_SAMPLE: 'MONITOR_SAMPLE',
  PICKER_RESULT: 'PICKER_RESULT',
  PICKER_CANCELLED: 'PICKER_CANCELLED',
  // service worker -> content script
  IS_DIRTY: 'IS_DIRTY',
  APPLY: 'APPLY',
  START_PICKER: 'START_PICKER',
  // ui -> service worker
  GET_STATE: 'GET_STATE',
  START_JOB: 'START_JOB',
  STOP_JOB: 'STOP_JOB',
  PAUSE_JOB: 'PAUSE_JOB',
  RESUME_JOB: 'RESUME_JOB',
  UPDATE_JOB: 'UPDATE_JOB',
  RELOAD_ONCE: 'RELOAD_ONCE',
  LIST_JOBS: 'LIST_JOBS',
  PICK_ELEMENT: 'PICK_ELEMENT',
  GET_DRAFT: 'GET_DRAFT',
  SET_DRAFT: 'SET_DRAFT',
  GET_SETTINGS: 'GET_SETTINGS',
  SET_SETTINGS: 'SET_SETTINGS',
  LIST_RULES: 'LIST_RULES',
  SAVE_RULE: 'SAVE_RULE',
  DELETE_RULE: 'DELETE_RULE',
  TEST_SOUND: 'TEST_SOUND',
  TEST_NOTIFICATION: 'TEST_NOTIFICATION',
  REQUEST_ORIGIN_ACCESS: 'REQUEST_ORIGIN_ACCESS',
  // service worker -> ui broadcast
  STATE_CHANGED: 'STATE_CHANGED',
};

// The `/** @type {const} */` casts below are the JSDoc equivalent of TypeScript's
// `as const`. Without them these read as plain `string`, and assigning
// STATUS.RUNNING to a field typed 'running'|'paused'|'stopped' fails to
// type-check -- which would make the Job typedef decorative rather than useful.

/** Why a job is not currently running. Surfaced verbatim in the UI. */
export const PAUSE_REASON = /** @type {const} */ ({
  USER: 'user',
  NAVIGATED_AWAY: 'navigated-away',
  ACTIVITY: 'activity',
  DIRTY_FORM: 'dirty-form',
  MAX_RELOADS: 'max-reloads',
  DEADLINE: 'deadline',
  KEYWORD_MATCH: 'keyword-match',
  PAGE_NOT_RESPONDING: 'page-not-responding',
  NO_PERMISSION: 'no-permission',
  DISCARDED: 'discarded',
});

export const RELOAD_METHOD = /** @type {const} */ ({
  SOFT: 'soft',
  HARD: 'hard',
  NAVIGATE: 'navigate',
});

export const SCOPE_MODE = /** @type {const} */ ({
  ORIGIN: 'origin',
  EXACT: 'exact',
  PREFIX: 'prefix',
  ANY: 'any',
});

export const STATUS = /** @type {const} */ ({
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
});

/** Colors mirrored from assets/icons + popup.css, used for badge tinting. */
export const COLOR = { ACTIVE: '#F59E0B', IDLE: '#0EA5C4', ALERT: '#DC2626' };
