// @ts-check
/**
 * Site access, requested one origin at a time and only when something
 * genuinely needs the page.
 *
 * The whole point: a plain refresh needs NO host permission at all.
 * chrome.tabs.reload works without one, and `tabs` alone is enough to read a
 * tab's url and title. So the extension installs with zero scary warnings --
 * where every competitor asks for "read and change all your data on all
 * websites" up front -- and only prompts when the user turns on something
 * that has to touch the page:
 *
 *   - intervals under 30s (the timer has to live in the page)
 *   - scroll-position restore
 *   - page-change monitoring
 *
 * The prompt then lands at the exact moment the user clicked Start on that
 * site, which is both the most understandable context and the highest-grant
 * one.
 *
 * NOTE: chrome.permissions.request() must be called from a user gesture in an
 * extension page, so the *asking* lives in popup.js. This module only checks
 * and acts on what was granted.
 */

import { originPattern } from '../lib/scope.js';

const AGENT_FILE = 'content/agent.js';
const SCRIPT_ID_PREFIX = 'arf-agent-';

/**
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function hasOriginAccess(url) {
  const pattern = originPattern(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * Does this job configuration need to run code in the page?
 *
 * @param {{intervalMs: number, randomize: {enabled: boolean, minMs: number}, scrollRestore: {enabled: boolean}, monitor: {enabled: boolean}}} job
 * @returns {boolean}
 */
export function needsPageAccess(job) {
  const low = job.randomize?.enabled ? job.randomize.minMs : job.intervalMs;
  if (low < 30_000) return true;
  if (job.scrollRestore?.enabled) return true;
  if (job.monitor?.enabled) return true;
  return false;
}

/**
 * @param {string} origin e.g. "https://example.com"
 * @returns {string}
 */
function scriptIdFor(origin) {
  return SCRIPT_ID_PREFIX + origin.replace(/[^a-z0-9]/gi, '_');
}

/**
 * Registers the agent for an origin we hold permission for.
 *
 * document_start matters: scroll restore has to run before the browser paints
 * its own scroll position, and a script arriving at document_idle is already
 * too late to do that without a visible jump.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function registerAgentFor(url) {
  const pattern = originPattern(url);
  if (!pattern) return false;
  if (!(await hasOriginAccess(url))) return false;

  const id = scriptIdFor(new URL(url).origin);

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (existing.length > 0) return true;
  } catch {
    /* getRegisteredContentScripts throws on an unknown id in some versions */
  }

  try {
    await chrome.scripting.registerContentScripts([
      {
        id,
        matches: [pattern],
        js: [AGENT_FILE],
        runAt: 'document_start',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
    return true;
  } catch (err) {
    // Duplicate id from a concurrent registration is benign.
    if (String(err).includes('Duplicate script ID')) return true;
    console.warn('[AutoRefresh] registerContentScripts failed', err);
    return false;
  }
}

/**
 * Drops every registration whose permission has since been revoked.
 *
 * Chrome keeps dynamic registrations across restarts, so a user who revokes
 * access in chrome://extensions would otherwise leave a registration pointing
 * at an origin we can no longer touch.
 *
 * @returns {Promise<void>}
 */
export async function reconcileRegistrations() {
  let registered = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts();
  } catch {
    return;
  }

  /** @type {string[]} */
  const stale = [];
  for (const script of registered) {
    if (!script.id?.startsWith(SCRIPT_ID_PREFIX)) continue;
    const origins = script.matches || [];
    const ok = origins.length > 0 && (await chrome.permissions.contains({ origins }).catch(() => false));
    if (!ok) stale.push(script.id);
  }

  if (stale.length) {
    await chrome.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
  }
}

/**
 * Injects the agent right now, without a registration.
 *
 * This is the activeTab path. activeTab grants access to the tab the user
 * invoked us on and, per Chrome's docs, keeps it across same-domain
 * navigation -- which a reload is. Since a job's scope defaults to the same
 * origin, the grant and the job have the same boundary.
 *
 * It is still best-effort: the grant is revoked on cross-domain navigation and
 * never applies to restricted pages, so a failure here is expected and simply
 * means the job runs in basic mode.
 *
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
export async function injectAgentNow(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [AGENT_FILE],
      injectImmediately: true,
    });
    return true;
  } catch {
    return false;
  }
}
