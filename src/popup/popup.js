// @ts-check
/**
 * Popup controller.
 *
 * Structural note, since this is where v1 fell over: every element reference
 * and every handler lives inside one `init()` scope. v1 had a top-level
 * `updateUI()` reaching for `const`s declared inside a DOMContentLoaded
 * callback, and a call to a `restoreRefreshInterval()` that was never defined
 * anywhere -- two ReferenceErrors that between them meant the Start button was
 * never wired up at all.
 *
 * The other thing to know: chrome.permissions.request() has to be called
 * directly from a user gesture in an extension page. It cannot be proxied
 * through the service worker. That is why the permission flow lives here and
 * not in permissions.js.
 */

import { MIN_INTERVAL_MS, MSG, PAUSE_REASON, WARN_INTERVAL_MS } from '../lib/constants.js';
import { formatCountdown, formatInterval, prettyUrl } from '../lib/format.js';
import { applyI18n, t } from '../lib/i18n.js';
import { originPattern } from '../lib/scope.js';

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

init().catch((err) => console.error('[AutoRefresh] popup init failed', err));

async function init() {
  applyI18n();

  // --- element handles ----------------------------------------------------
  const els = {
    favicon: /** @type {HTMLImageElement} */ ($('favicon')),
    tabTitle: $('tabTitle'),
    tabUrl: $('tabUrl'),
    statusPill: $('statusPill'),
    restricted: $('restrictedNotice'),
    pausedNotice: $('pausedNotice'),
    pausedText: $('pausedText'),
    resumeHere: $('resumeHere'),
    main: $('main'),
    chips: $('chips'),
    custom: /** @type {HTMLInputElement} */ ($('customInterval')),
    fastWarning: $('fastWarning'),
    permPrompt: $('permPrompt'),
    permGrant: $('permGrant'),
    permSkip: $('permSkip'),
    primary: /** @type {HTMLButtonElement} */ ($('primary')),
    reloadNow: /** @type {HTMLButtonElement} */ ($('reloadNow')),
    live: $('live'),
    reloadCount: $('reloadCount'),
    countdown: $('countdown'),
    advanced: /** @type {HTMLDetailsElement} */ ($('advanced')),
    randomize: /** @type {HTMLInputElement} */ ($('randomize')),
    randomRow: $('randomRow'),
    randomMin: /** @type {HTMLInputElement} */ ($('randomMin')),
    randomMax: /** @type {HTMLInputElement} */ ($('randomMax')),
    reloadMethod: /** @type {HTMLSelectElement} */ ($('reloadMethod')),
    scopeMode: /** @type {HTMLSelectElement} */ ($('scopeMode')),
    maxReloads: /** @type {HTMLInputElement} */ ($('maxReloads')),
    scrollRestore: /** @type {HTMLInputElement} */ ($('scrollRestore')),
    skipDirtyForm: /** @type {HTMLInputElement} */ ($('skipDirtyForm')),
    monitorEnabled: /** @type {HTMLInputElement} */ ($('monitorEnabled')),
    monitorBody: $('monitorBody'),
    monitorRegion: $('monitorRegion'),
    pickRegion: $('pickRegion'),
    ignoreRegex: /** @type {HTMLInputElement} */ ($('ignoreRegex')),
    onNotify: /** @type {HTMLInputElement} */ ($('onNotify')),
    onSound: /** @type {HTMLInputElement} */ ($('onSound')),
    onStop: /** @type {HTMLInputElement} */ ($('onStop')),
    onFocus: /** @type {HTMLInputElement} */ ($('onFocus')),
    activeCount: $('activeCount'),
    alwaysRefresh: $('alwaysRefresh'),
    openOptions: $('openOptions'),
  };

  // --- state --------------------------------------------------------------
  let state = await send({ type: MSG.GET_STATE });
  let selectedMs = state.job?.intervalMs ?? state.settings?.defaultIntervalMs ?? 30_000;
  /** @type {number|null} */
  let countdownTimer = null;
  let pendingStart = false;

  // The element picker destroys this popup when it injects. Whatever was
  // half-configured comes back through the draft.
  if (state.draft?.monitor) {
    els.monitorEnabled.checked = true;
    if (state.draft.monitor.selector) {
      els.monitorRegion.textContent = state.draft.monitor.selector;
      els.monitorRegion.title = state.draft.monitor.selector;
    }
    await send({ type: MSG.SET_DRAFT, draft: null });
  }

  buildChips(state.settings?.presets || []);
  els.advanced.open = Boolean(state.settings?.advancedOpen);
  render();

  // --- rendering ----------------------------------------------------------

  function buildChips(/** @type {number[]} */ presets) {
    els.chips.replaceChildren();
    for (const ms of presets) {
      const btn = document.createElement('button');
      btn.className = 'chip';
      btn.type = 'button';
      btn.textContent = formatInterval(ms);
      btn.setAttribute('aria-pressed', String(ms === selectedMs));
      btn.addEventListener('click', () => {
        selectedMs = ms;
        els.custom.value = String(Math.round(ms / 1000));
        syncChips();
        renderWarnings();
      });
      els.chips.appendChild(btn);
    }
  }

  function syncChips() {
    for (const chip of els.chips.querySelectorAll('.chip')) {
      chip.setAttribute('aria-pressed', String(chip.textContent === formatInterval(selectedMs)));
    }
  }

  function render() {
    const { job, tab, restricted } = state;

    els.tabTitle.textContent = tab?.title || '—';
    els.tabUrl.textContent = tab?.url ? prettyUrl(tab.url) : '';
    if (tab?.favIconUrl) els.favicon.src = tab.favIconUrl;

    if (restricted) {
      els.restricted.hidden = false;
      els.main.hidden = true;
      return;
    }
    els.restricted.hidden = true;
    els.main.hidden = false;

    const running = job?.status === 'running';
    const paused = job?.status === 'paused';

    els.statusPill.dataset.state = running ? 'running' : paused ? 'paused' : 'off';
    els.statusPill.textContent = running
      ? t('statusRunning')
      : paused
        ? t('statusPaused')
        : t('statusOff');

    els.primary.textContent = running ? t('popupStop') : t('popupStart');
    els.primary.className = running ? 'btn btn-danger' : 'btn btn-primary';

    // "Paused — you navigated away" is worth a dedicated affordance: it is the
    // one pause the user can undo in a single click, and every competitor
    // either deletes the job here or keeps hammering the new page.
    const away = paused && job.pauseReason === PAUSE_REASON.NAVIGATED_AWAY;
    els.pausedNotice.hidden = !paused;
    if (paused) {
      els.pausedText.textContent = pauseMessage(job.pauseReason);
      els.resumeHere.hidden = !away && job.pauseReason !== PAUSE_REASON.USER;
    }

    els.live.hidden = !job;
    if (job) {
      els.reloadCount.textContent = String(job.reloadCount);
      startCountdown(job);
    } else {
      stopCountdown();
    }

    if (job) {
      selectedMs = job.intervalMs;
      els.randomize.checked = job.randomize.enabled;
      els.randomMin.value = String(Math.round(job.randomize.minMs / 1000));
      els.randomMax.value = String(Math.round(job.randomize.maxMs / 1000));
      els.reloadMethod.value = job.reloadMethod;
      els.scopeMode.value = job.scope.mode;
      els.maxReloads.value = String(job.maxReloads);
      els.scrollRestore.checked = job.scrollRestore.enabled;
      els.skipDirtyForm.checked = job.skipIfDirtyForm;
      els.monitorEnabled.checked = job.monitor.enabled;
      els.ignoreRegex.value = job.monitor.ignoreRegex || '';
      els.onNotify.checked = job.monitor.onMatch.notify;
      els.onSound.checked = job.monitor.onMatch.sound;
      els.onStop.checked = job.monitor.onMatch.stop;
      els.onFocus.checked = job.monitor.onMatch.focusTab;
      if (job.monitor.selector) {
        els.monitorRegion.textContent = job.monitor.selector;
        els.monitorRegion.title = job.monitor.selector;
      }
    }

    els.custom.value = String(Math.round(selectedMs / 1000));
    els.randomRow.hidden = !els.randomize.checked;
    els.monitorBody.hidden = !els.monitorEnabled.checked;
    syncChips();
    renderWarnings();

    const n = state.activeCount || 0;
    els.activeCount.innerHTML = `<span class="dot"></span>${n} active`;
  }

  function renderWarnings() {
    els.fastWarning.hidden = selectedMs >= WARN_INTERVAL_MS;
  }

  function pauseMessage(/** @type {string} */ reason) {
    switch (reason) {
      case PAUSE_REASON.NAVIGATED_AWAY:
        return t('pauseNavigatedAway');
      case PAUSE_REASON.MAX_RELOADS:
        return t('pauseMaxReloads');
      case PAUSE_REASON.DEADLINE:
        return t('pauseDeadline');
      case PAUSE_REASON.KEYWORD_MATCH:
        return t('pauseKeywordMatch');
      case PAUSE_REASON.PAGE_NOT_RESPONDING:
        return t('pausePageNotResponding');
      case PAUSE_REASON.NO_PERMISSION:
        return t('pauseNoPermission');
      case PAUSE_REASON.DISCARDED:
        return t('pauseDiscarded');
      default:
        return t('pauseUser');
    }
  }

  function startCountdown(/** @type {any} */ job) {
    stopCountdown();
    if (job.status !== 'running' || !job.nextFireAt) {
      els.countdown.textContent = '—';
      return;
    }
    const tick = () => {
      els.countdown.textContent = formatCountdown(job.nextFireAt - Date.now());
    };
    tick();
    countdownTimer = window.setInterval(tick, 500);
  }

  function stopCountdown() {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  window.addEventListener('pagehide', stopCountdown);

  // --- reading the form ---------------------------------------------------

  function collect() {
    const seconds = Number(els.custom.value);
    const intervalMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : selectedMs;

    return {
      intervalMs: Math.max(MIN_INTERVAL_MS, intervalMs),
      randomize: {
        enabled: els.randomize.checked,
        minMs: Math.max(MIN_INTERVAL_MS, Number(els.randomMin.value) * 1000 || intervalMs),
        maxMs: Math.max(MIN_INTERVAL_MS, Number(els.randomMax.value) * 1000 || intervalMs),
      },
      reloadMethod: els.reloadMethod.value,
      scope: {
        mode: els.scopeMode.value,
        value:
          els.scopeMode.value === 'exact'
            ? state.tab?.url || ''
            : els.scopeMode.value === 'origin'
              ? originOf(state.tab?.url || '')
              : '',
      },
      maxReloads: Math.max(0, Number(els.maxReloads.value) || 0),
      scrollRestore: { enabled: els.scrollRestore.checked, selector: null },
      skipIfDirtyForm: els.skipDirtyForm.checked,
      monitor: {
        enabled: els.monitorEnabled.checked,
        selector:
          els.monitorRegion.textContent === t('monitorWholePage')
            ? null
            : els.monitorRegion.textContent,
        ignoreRegex: els.ignoreRegex.value.trim() || null,
        onMatch: {
          notify: els.onNotify.checked,
          sound: els.onSound.checked,
          stop: els.onStop.checked,
          focusTab: els.onFocus.checked,
          badge: true,
        },
      },
    };
  }

  function originOf(/** @type {string} */ url) {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  /**
   * Does this configuration need to run code in the page? Mirrors
   * needsPageAccess() in background/permissions.js -- checked here so the
   * permission prompt can be raised while the user's click is still live.
   */
  function needsAccess(/** @type {any} */ cfg) {
    const low = cfg.randomize.enabled ? cfg.randomize.minMs : cfg.intervalMs;
    return low < 30_000 || cfg.scrollRestore.enabled || cfg.monitor.enabled;
  }

  // --- actions ------------------------------------------------------------

  async function refreshState() {
    state = await send({ type: MSG.GET_STATE });
    render();
  }

  els.primary.addEventListener('click', async () => {
    if (state.job?.status === 'running') {
      await send({ type: MSG.STOP_JOB, tabId: state.tab?.id });
      await refreshState();
      return;
    }

    const cfg = collect();

    // The gesture is alive right now, which is the only moment
    // chrome.permissions.request() will work. Ask before starting, not after.
    if (needsAccess(cfg) && !state.hasAccess && state.tab?.url) {
      pendingStart = true;
      els.permPrompt.hidden = false;
      return;
    }

    await startJob(cfg);
  });

  async function startJob(/** @type {any} */ cfg) {
    await send({ type: MSG.START_JOB, tabId: state.tab?.id, job: cfg });
    await refreshState();
  }

  els.permGrant.addEventListener('click', async () => {
    const pattern = originPattern(state.tab?.url || '');
    if (!pattern) return;

    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [pattern] });
    } catch (err) {
      console.warn('[AutoRefresh] permission request failed', err);
    }

    els.permPrompt.hidden = true;
    if (granted) await send({ type: MSG.REQUEST_ORIGIN_ACCESS, url: state.tab.url });

    if (pendingStart) {
      pendingStart = false;
      const cfg = collect();
      if (!granted) {
        // Denied: fall back to what basic mode can actually deliver, and say
        // so, rather than starting a job that silently does less than asked.
        cfg.intervalMs = Math.max(30_000, cfg.intervalMs);
        cfg.randomize.minMs = Math.max(30_000, cfg.randomize.minMs);
        cfg.randomize.maxMs = Math.max(30_000, cfg.randomize.maxMs);
        cfg.scrollRestore.enabled = false;
        cfg.monitor.enabled = false;
      }
      await startJob(cfg);
    } else {
      await refreshState();
    }
  });

  els.permSkip.addEventListener('click', async () => {
    els.permPrompt.hidden = true;
    if (!pendingStart) return;
    pendingStart = false;

    const cfg = collect();
    cfg.intervalMs = Math.max(30_000, cfg.intervalMs);
    cfg.randomize.minMs = Math.max(30_000, cfg.randomize.minMs);
    cfg.randomize.maxMs = Math.max(30_000, cfg.randomize.maxMs);
    cfg.scrollRestore.enabled = false;
    cfg.monitor.enabled = false;
    await startJob(cfg);
  });

  els.reloadNow.addEventListener('click', async () => {
    await send({ type: MSG.RELOAD_ONCE, tabId: state.tab?.id });
    window.close();
  });

  els.resumeHere.addEventListener('click', async () => {
    await send({ type: MSG.RESUME_JOB, tabId: state.tab?.id });
    await refreshState();
  });

  els.pickRegion.addEventListener('click', async () => {
    // This closes the popup. The picker sends its result to the worker, which
    // parks it in a draft we pick up on reopen.
    await send({ type: MSG.PICK_ELEMENT, tabId: state.tab?.id, draft: { monitor: collect().monitor } });
    window.close();
  });

  els.alwaysRefresh.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!state.tab?.url) return;
    const u = new URL(state.tab.url);
    const cfg = collect();
    await send({
      type: MSG.SAVE_RULE,
      rule: {
        id: `r_${crypto.randomUUID()}`,
        enabled: true,
        pattern: `${u.protocol}//${u.hostname}/*`,
        matchKind: 'matchPattern',
        priority: 0,
        autoStart: true,
        onlyOncePerTab: true,
        settings: cfg,
        createdAt: Date.now(),
      },
    });
    els.alwaysRefresh.textContent = '✓ Rule saved';
  });

  els.activeCount.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());

  // --- live form wiring ---------------------------------------------------

  els.custom.addEventListener('input', () => {
    const seconds = Number(els.custom.value);
    if (Number.isFinite(seconds) && seconds > 0) selectedMs = seconds * 1000;
    syncChips();
    renderWarnings();
  });

  els.randomize.addEventListener('change', () => {
    els.randomRow.hidden = !els.randomize.checked;
  });

  els.monitorEnabled.addEventListener('change', () => {
    els.monitorBody.hidden = !els.monitorEnabled.checked;
  });

  els.advanced.addEventListener('toggle', () => {
    void send({ type: MSG.SET_SETTINGS, patch: { advancedOpen: els.advanced.open } });
  });

  // Changing a control while a job is running applies immediately -- having to
  // stop and restart to change the interval is a small, constant annoyance.
  for (const el of [
    els.reloadMethod,
    els.scopeMode,
    els.maxReloads,
    els.scrollRestore,
    els.skipDirtyForm,
    els.ignoreRegex,
    els.onNotify,
    els.onSound,
    els.onStop,
    els.onFocus,
  ]) {
    el.addEventListener('change', async () => {
      if (state.job?.status !== 'running') return;
      await send({ type: MSG.UPDATE_JOB, tabId: state.tab?.id, job: collect() });
      await refreshState();
    });
  }
}
