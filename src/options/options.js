// @ts-check
/**
 * Options page controller.
 *
 * Deliberately one file rather than a views/ directory: the four panels are a
 * few dozen lines each, and splitting them would add imports and indirection
 * without removing any complexity.
 */

import { MSG } from '../lib/constants.js';
import { formatInterval, formatTimeAgo, prettyUrl } from '../lib/format.js';
import { applyI18n } from '../lib/i18n.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * @param {Object} message
 * @returns {Promise<any>}
 */
async function send(message) {
  const reply = await chrome.runtime.sendMessage(message);
  if (reply && reply.ok === false) throw new Error(reply.error || 'request failed');
  return reply || {};
}

init().catch((err) => console.error('[AutoRefresh] options init failed', err));

async function init() {
  applyI18n();
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  // --- tabs ---------------------------------------------------------------
  const tabs = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('.tab')]);

  function selectPanel(/** @type {string} */ name) {
    for (const tab of tabs) {
      const on = tab.dataset.panel === name;
      tab.setAttribute('aria-selected', String(on));
      $(`panel-${tab.dataset.panel}`).hidden = !on;
    }
    location.hash = name;
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectPanel(/** @type {string} */ (tab.dataset.panel)));
  }

  // Arrow-key navigation, which is what a tablist is expected to do.
  document.querySelector('.tabs')?.addEventListener('keydown', (e) => {
    const key = /** @type {KeyboardEvent} */ (e).key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    const next = (i + (key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    selectPanel(/** @type {string} */ (tabs[next].dataset.panel));
    tabs[next].focus();
  });

  if (location.hash) selectPanel(location.hash.slice(1));

  // --- jobs ---------------------------------------------------------------
  await renderJobs();
  // The panel is a live view of what is running, so keep it current while open.
  const jobsTimer = setInterval(renderJobs, 2000);
  window.addEventListener('pagehide', () => clearInterval(jobsTimer));

  async function renderJobs() {
    const { jobs = [], stats } = await send({ type: MSG.LIST_JOBS });
    $('statReloads').textContent = String(stats?.totalReloads ?? 0);
    $('statChanges').textContent = String(stats?.totalChanges ?? 0);

    const list = $('jobList');
    if (jobs.length === 0) {
      list.innerHTML = '<div class="empty" data-i18n="optNoJobs">Nothing is refreshing right now.</div>';
      applyI18n(list);
      return;
    }

    list.replaceChildren();
    for (const job of jobs) {
      const card = document.createElement('div');
      card.className = 'card card-row';

      const every = job.randomize.enabled
        ? `${formatInterval(job.randomize.minMs)}–${formatInterval(job.randomize.maxMs)}`
        : formatInterval(job.intervalMs);

      const bits = [`every ${every}`, `${job.reloadCount} reloads`];
      if (job.reloadMethod === 'hard') bits.push('hard reload');
      if (job.monitor.enabled) {
        bits.push(
          job.monitor.changeCount > 0
            ? `${job.monitor.changeCount} changes, last ${formatTimeAgo(job.monitor.lastChangeAt)}`
            : 'watching',
        );
      }

      const meta = document.createElement('div');
      meta.className = 'grow';
      const h2 = document.createElement('h2');
      h2.textContent = job.title || prettyUrl(job.url);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = bits.join(' · ');
      meta.append(h2, sub);

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset.state = job.status;
      badge.textContent = job.status;

      const focus = button('Show', 'btn-secondary', async () => {
        try {
          await chrome.tabs.update(job.tabId, { active: true });
          await chrome.windows.update(job.windowId, { focused: true });
        } catch {
          await renderJobs(); // the tab is gone; refresh the list
        }
      });

      const stop = button('Stop', 'btn-danger', async () => {
        await send({ type: MSG.STOP_JOB, tabId: job.tabId });
        await renderJobs();
      });

      card.append(meta, badge, focus, stop);
      list.appendChild(card);
    }
  }

  // --- rules --------------------------------------------------------------
  await renderRules();

  $('addRule').addEventListener('click', async () => {
    const pattern = prompt(
      'Match pattern for the sites to auto-refresh:\n\nExamples:\n  https://example.com/*\n  https://*.example.com/dashboard*',
      'https://example.com/*',
    );
    if (!pattern) return;

    const seconds = Number(prompt('Refresh every how many seconds?', '60'));
    if (!Number.isFinite(seconds) || seconds <= 0) return;

    await send({
      type: MSG.SAVE_RULE,
      rule: {
        id: `r_${crypto.randomUUID()}`,
        enabled: true,
        pattern,
        matchKind: 'matchPattern',
        priority: 0,
        autoStart: true,
        onlyOncePerTab: true,
        settings: { intervalMs: seconds * 1000 },
        createdAt: Date.now(),
      },
    });
    await renderRules();
  });

  async function renderRules() {
    const { rules = [] } = await send({ type: MSG.LIST_RULES });
    const list = $('ruleList');

    if (rules.length === 0) {
      list.innerHTML = '<div class="empty" data-i18n="optNoRules">No site rules yet.</div>';
      applyI18n(list);
      return;
    }

    list.replaceChildren();
    for (const rule of rules) {
      const card = document.createElement('div');
      card.className = 'card card-row';

      const meta = document.createElement('div');
      meta.className = 'grow';
      const code = document.createElement('code');
      code.textContent = rule.pattern;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = `every ${formatInterval(rule.settings.intervalMs || 30_000)}${
        rule.autoStart ? ' · starts automatically' : ''
      }`;
      meta.append(code, sub);

      const toggle = document.createElement('label');
      toggle.className = 'switch';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = rule.enabled;
      cb.addEventListener('change', async () => {
        await send({ type: MSG.SAVE_RULE, rule: { ...rule, enabled: cb.checked } });
      });
      toggle.appendChild(cb);

      // A rule that needs page access on an origin we cannot read would
      // quietly do less than it says, so offer the grant right here.
      const grant = button('Grant access', 'btn-secondary', async () => {
        const origins = [rule.pattern];
        try {
          const ok = await chrome.permissions.request({ origins });
          if (ok) await send({ type: MSG.REQUEST_ORIGIN_ACCESS, url: rule.pattern.replace('*', '') });
        } catch (err) {
          console.warn('[AutoRefresh] rule permission request failed', err);
        }
        await renderRules();
      });
      try {
        if (await chrome.permissions.contains({ origins: [rule.pattern] })) grant.hidden = true;
      } catch {
        grant.hidden = true; // not a requestable pattern (regex/glob rules)
      }

      const del = button('Delete', 'btn-danger', async () => {
        await send({ type: MSG.DELETE_RULE, id: rule.id });
        await renderRules();
      });

      card.append(meta, toggle, grant, del);
      list.appendChild(card);
    }
  }

  // --- settings -----------------------------------------------------------
  const { settings } = await send({ type: MSG.GET_SETTINGS });

  const theme = /** @type {HTMLSelectElement} */ ($('theme'));
  const defaultInterval = /** @type {HTMLInputElement} */ ($('defaultInterval'));
  const soundEnabled = /** @type {HTMLInputElement} */ ($('soundEnabled'));
  const soundVolume = /** @type {HTMLInputElement} */ ($('soundVolume'));
  const notificationsEnabled = /** @type {HTMLInputElement} */ ($('notificationsEnabled'));

  theme.value = settings.theme;
  defaultInterval.value = String(Math.round(settings.defaultIntervalMs / 1000));
  soundEnabled.checked = settings.soundEnabled;
  soundVolume.value = String(Math.round(settings.soundVolume * 100));
  notificationsEnabled.checked = settings.notificationsEnabled;

  theme.addEventListener('change', async () => {
    await send({ type: MSG.SET_SETTINGS, patch: { theme: theme.value } });
    // Apply immediately, and update the synchronous cache theme.js reads on
    // the next page open so there is no flash.
    if (theme.value === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme.value);
    try {
      localStorage.setItem('arf.theme', theme.value);
    } catch {
      /* ignore */
    }
  });

  defaultInterval.addEventListener('change', () => {
    const seconds = Math.max(1, Number(defaultInterval.value) || 30);
    defaultInterval.value = String(seconds);
    void send({ type: MSG.SET_SETTINGS, patch: { defaultIntervalMs: seconds * 1000 } });
  });

  soundEnabled.addEventListener('change', () =>
    send({ type: MSG.SET_SETTINGS, patch: { soundEnabled: soundEnabled.checked } }),
  );

  soundVolume.addEventListener('change', () =>
    send({ type: MSG.SET_SETTINGS, patch: { soundVolume: Number(soundVolume.value) / 100 } }),
  );

  notificationsEnabled.addEventListener('change', () =>
    send({ type: MSG.SET_SETTINGS, patch: { notificationsEnabled: notificationsEnabled.checked } }),
  );

  $('testSound').addEventListener('click', () => send({ type: MSG.TEST_SOUND }));
  $('testNotification').addEventListener('click', () => send({ type: MSG.TEST_NOTIFICATION }));

  // --- site access --------------------------------------------------------
  const grantAll = /** @type {HTMLButtonElement} */ ($('grantAll'));

  async function renderAccess() {
    const all = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
    grantAll.textContent = all ? 'Access granted to all sites' : 'Grant access to all sites';
    grantAll.disabled = all;
  }
  await renderAccess();

  grantAll.addEventListener('click', async () => {
    try {
      await chrome.permissions.request({ origins: ['<all_urls>'] });
    } catch (err) {
      console.warn('[AutoRefresh] grant-all failed', err);
    }
    await renderAccess();
  });

  // --- helper -------------------------------------------------------------
  /**
   * @param {string} text
   * @param {string} cls
   * @param {() => void|Promise<void>} onClick
   * @returns {HTMLButtonElement}
   */
  function button(text, cls, onClick) {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = text;
    b.addEventListener('click', () => void onClick());
    return b;
  }
}
