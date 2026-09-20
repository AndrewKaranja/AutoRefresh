// @ts-check
/**
 * Job records: CRUD over storage.session, serialised.
 *
 * Two things stop concurrent writes from losing data, and both are needed:
 *
 *   1. One storage key per job (`job:<tabId>`), never a single `jobs` blob.
 *      Two jobs can then never clobber each other no matter the interleaving.
 *   2. A promise-chain mutex around read-modify-write of the *same* job. An
 *      alarm firing and a CS_READY handshake arriving at the same instant is
 *      not hypothetical -- it happens on every fast job -- and without this the
 *      two get/set pairs interleave and a reload count silently vanishes.
 */

import { JOB_PREFIX, STATUS } from '../lib/constants.js';

/** @typedef {import('../lib/schema.js').Job} Job */

/**
 * Serialises all job mutations. Deliberately one global chain rather than a
 * per-job lock: job writes are sub-millisecond, contention is rare, and a
 * single chain cannot deadlock or leak entries for dead tabs.
 *
 * `q.then(fn, fn)` -- passing fn as both handlers -- keeps the chain alive
 * after a rejection instead of poisoning every subsequent write.
 *
 * @type {Promise<any>}
 */
let queue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withJobLock(fn) {
  const run = () => fn();
  queue = queue.then(run, run);
  return queue;
}

/** @param {number} tabId @returns {string} */
export function jobKey(tabId) {
  return JOB_PREFIX + tabId;
}

/**
 * @param {number} tabId
 * @returns {Promise<Job|null>}
 */
export async function getJob(tabId) {
  const key = jobKey(tabId);
  const got = await chrome.storage.session.get(key);
  return got[key] || null;
}

/**
 * @param {Job} job
 * @returns {Promise<void>}
 */
export async function saveJob(job) {
  await chrome.storage.session.set({ [jobKey(job.tabId)]: job });
}

/**
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function deleteJob(tabId) {
  await chrome.storage.session.remove(jobKey(tabId));
}

/**
 * @returns {Promise<Job[]>}
 */
export async function listJobs() {
  const all = await chrome.storage.session.get(null);
  /** @type {Job[]} */
  const jobs = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(JOB_PREFIX) && v && typeof v === 'object') jobs.push(v);
  }
  return jobs;
}

/**
 * @returns {Promise<Job[]>}
 */
export async function listRunningJobs() {
  return (await listJobs()).filter((j) => j.status === STATUS.RUNNING);
}

/**
 * Moves a job to a new tab id.
 *
 * tabs.onReplaced fires when Chrome swaps in a prerendered or back/forward-
 * cached tab, which gives the same page a brand new tab id. Without rekeying,
 * the job is stranded under an id nothing will ever reference again and its
 * alarm fires forever against a dead tab.
 *
 * @param {number} fromTabId
 * @param {number} toTabId
 * @returns {Promise<Job|null>}
 */
export async function rekeyJob(fromTabId, toTabId) {
  const job = await getJob(fromTabId);
  if (!job) return null;
  await deleteJob(fromTabId);
  job.tabId = toTabId;
  await saveJob(job);
  return job;
}

/**
 * Read-modify-write under the lock. The mutator may return false to abort the
 * write, which keeps "look at the job, decide nothing needs doing" from
 * costing a storage round-trip.
 *
 * @param {number} tabId
 * @param {(job: Job) => boolean|void|Promise<boolean|void>} mutate
 * @returns {Promise<Job|null>}
 */
export function updateJob(tabId, mutate) {
  return withJobLock(async () => {
    const job = await getJob(tabId);
    if (!job) return null;
    const result = await mutate(job);
    if (result === false) return job;
    await saveJob(job);
    return job;
  });
}
