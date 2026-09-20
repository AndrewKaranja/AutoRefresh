// @ts-check
/**
 * Site rules: "always refresh this site".
 *
 * This is the honest answer to persistence across a browser restart. Job
 * records are keyed by tab id and tab ids are all new after a restart, so
 * resurrecting instances is meaningless -- what survives is the user's
 * *intent*, expressed as a URL pattern, and rules are where that lives.
 */

import { SCHEMA_VERSION, STATUS } from '../lib/constants.js';
import { makeJob } from '../lib/schema.js';
import { isRestrictedUrl, patternToRegExp } from '../lib/scope.js';
import { getRules } from '../lib/storage.js';
import { getJob, saveJob } from './jobs.js';
import { hasOriginAccess } from './permissions.js';
import { arm } from './scheduler.js';

/** @typedef {import('../lib/schema.js').Rule} Rule */

/**
 * Highest-priority enabled rule matching this URL, or null.
 *
 * An invalid user-authored pattern is skipped rather than thrown: one bad
 * regex in the options page should not stop every other rule from working.
 *
 * @param {string} url
 * @param {Rule[]} [rules]
 * @returns {Promise<Rule|null>}
 */
export async function matchRule(url, rules) {
  if (isRestrictedUrl(url)) return null;
  const all = rules || (await getRules());

  /** @type {Rule|null} */
  let best = null;
  for (const rule of all) {
    if (!rule.enabled) continue;
    let re;
    try {
      re = patternToRegExp(rule.pattern, rule.matchKind);
    } catch {
      continue;
    }
    if (!re.test(url)) continue;
    if (!best || rule.priority > best.priority) best = rule;
  }
  return best;
}

/**
 * Creates a job from a matching rule, if one applies and the tab has none.
 *
 * Called from the agent handshake, so it only ever runs on a page we can
 * already see -- which means a rule can never silently start a job on a site
 * the user has not granted access to.
 *
 * @param {chrome.tabs.Tab} tab
 * @param {string} url
 * @returns {Promise<Object|null>}
 */
export async function maybeAutoStart(tab, url) {
  if (typeof tab.id !== 'number') return null;
  if (await getJob(tab.id)) return null;

  const rule = await matchRule(url);
  if (!rule || !rule.autoStart) return null;

  // A rule needing in-page features on an origin we have lost access to would
  // start a job that silently cannot do what the rule asks. Start it anyway,
  // but in basic mode -- the popup surfaces the downgrade.
  const granted = await hasOriginAccess(url);

  const job = makeJob({
    tab: { ...tab, url },
    intervalMs: rule.settings.intervalMs ?? 30_000,
    overrides: {
      ...rule.settings,
      tabId: tab.id,
      url,
      ruleId: rule.id,
      status: STATUS.RUNNING,
      schemaVersion: SCHEMA_VERSION,
    },
  });

  if (!granted) {
    job.scrollRestore = { ...job.scrollRestore, enabled: false };
    job.monitor = { ...job.monitor, enabled: false };
    if (job.intervalMs < 30_000) job.intervalMs = 30_000;
    if (job.randomize.enabled && job.randomize.minMs < 30_000) {
      job.randomize = { ...job.randomize, minMs: 30_000 };
    }
  }

  await saveJob(job);
  await arm(job);
  return job;
}
