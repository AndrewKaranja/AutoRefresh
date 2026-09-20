// @ts-check
/**
 * Storage access, split three ways on purpose:
 *
 *   session - live job records. In-memory and cleared on browser restart,
 *             which is exactly the lifecycle a tabId-keyed record should have
 *             (every tab id is new after a restart anyway). It survives
 *             service-worker termination because it lives in browser memory,
 *             not worker memory. Bonus: the URLs you are refreshing never
 *             touch disk.
 *   sync    - rules, settings. Small, cross-device, rarely written. Hard caps
 *             at 120 writes/min and 1800/hr, so nothing per-reload goes here.
 *   local   - counters and monitor snapshots. No rate limit. A per-reload
 *             counter written to sync would exhaust the hourly quota in about
 *             half an hour.
 */

import { defaultSettings } from './schema.js';
import { MONITOR_HISTORY_MAX, MONITOR_PREFIX } from './constants.js';

const SETTINGS_KEY = 'settings';
const RULES_KEY = 'rules';
const STATS_KEY = 'stats';
const DRAFT_KEY = 'draft';

/** @returns {Promise<import('./schema.js').Settings>} */
export async function getSettings() {
  const got = await chrome.storage.sync.get(SETTINGS_KEY);
  return { ...defaultSettings(), ...(got[SETTINGS_KEY] || {}) };
}

/**
 * @param {Partial<import('./schema.js').Settings>} patch
 * @returns {Promise<import('./schema.js').Settings>}
 */
export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
  return next;
}

/** @returns {Promise<import('./schema.js').Rule[]>} */
export async function getRules() {
  const got = await chrome.storage.sync.get(RULES_KEY);
  const rules = got[RULES_KEY];
  return Array.isArray(rules) ? rules : [];
}

/**
 * @param {import('./schema.js').Rule[]} rules
 * @returns {Promise<void>}
 */
export async function setRules(rules) {
  await chrome.storage.sync.set({ [RULES_KEY]: rules });
}

/**
 * Lifetime counters. Batched by the caller -- see STATS_FLUSH_MS -- so that a
 * 1-second job does not issue a storage write per second.
 *
 * @returns {Promise<{totalReloads: number, totalChanges: number, since: number}>}
 */
export async function getStats() {
  const got = await chrome.storage.local.get(STATS_KEY);
  return { totalReloads: 0, totalChanges: 0, since: Date.now(), ...(got[STATS_KEY] || {}) };
}

/**
 * @param {{reloads?: number, changes?: number}} delta
 * @returns {Promise<void>}
 */
export async function bumpStats({ reloads = 0, changes = 0 }) {
  if (!reloads && !changes) return;
  const stats = await getStats();
  stats.totalReloads += reloads;
  stats.totalChanges += changes;
  await chrome.storage.local.set({ [STATS_KEY]: stats });
}

/**
 * The popup is destroyed the instant the element picker is injected, so the
 * half-configured job it was holding has to live somewhere else until the
 * popup is reopened. That is this.
 *
 * @returns {Promise<Object|null>}
 */
export async function getDraft() {
  const got = await chrome.storage.session.get(DRAFT_KEY);
  return got[DRAFT_KEY] || null;
}

/**
 * @param {Object|null} draft
 * @returns {Promise<void>}
 */
export async function setDraft(draft) {
  if (draft === null) await chrome.storage.session.remove(DRAFT_KEY);
  else await chrome.storage.session.set({ [DRAFT_KEY]: draft });
}

/**
 * Previous normalised page text for a monitored URL, used to build the
 * "what changed" snippet.
 *
 * @param {string} urlHash
 * @returns {Promise<{text: string, at: number}|null>}
 */
export async function getMonitorSnapshot(urlHash) {
  const key = MONITOR_PREFIX + urlHash;
  const got = await chrome.storage.local.get(key);
  return got[key] || null;
}

/**
 * Writes a snapshot and evicts the oldest entries past the cap. Unbounded
 * growth here would be a slow leak of page text into local storage.
 *
 * @param {string} urlHash
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function setMonitorSnapshot(urlHash, text) {
  const key = MONITOR_PREFIX + urlHash;
  await chrome.storage.local.set({ [key]: { text, at: Date.now() } });

  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k]) => k.startsWith(MONITOR_PREFIX))
    .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));

  if (entries.length > MONITOR_HISTORY_MAX) {
    await chrome.storage.local.remove(entries.slice(MONITOR_HISTORY_MAX).map(([k]) => k));
  }
}
