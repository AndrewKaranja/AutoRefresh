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
    waitingNotice: $('waitingNotice'),
    errorNotice: $('errorNotice'),
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
  buildChips(state.settings?.presets || []);
  els.advanced.open = Boolean(state.settings?.advancedOpen);
  render();

  // Applied AFTER render(), not before: render() writes every control from the
  // stored job, so a draft applied first was silently overwritten and the
  // region you had just picked vanished.
  await applyPickedRegion();
  await resumeInterruptedStart();

  /**
   * Picks up the region chosen by the element picker.
   *
   * Injecting the picker destroys this popup, so the result cannot be returned
   * to the caller. The picker messages the service worker, which parks it in a
   * draft; this is where that draft comes home.
   */
  async function applyPickedRegion() {
    const selector = state.draft?.monitor?.selector;
    if (!selector) return;

    els.monitorEnabled.checked = true;
    els.monitorBody.hidden = false;
    els.monitorRegion.textContent = selector;
    els.monitorRegion.title = selector;
    els.advanced.open = true;

    await send({ type: MSG.SET_DRAFT, draft: null });
    state.draft = null;

    // If a job is already running, apply it now. Otherwise the user picks a
    // region, sees it listed, and nothing watches it until they think to press
    // Start again.
    if (state.job?.status === 'running') {
      await send({ type: MSG.UPDATE_JOB, tabId: state.tab?.id, job: collect() });
      await refreshState();
      els.monitorRegion.textContent = selector;
      els.monitorRegion.title = selector;
    }
  }

  /**
   * Completes a start that was interrupted by the permission dialog.
   *
   * Granting is handled by the service worker via permissions.onAdded, but
   * DENYING fires no event at all -- so if this popup was destroyed by the
   * dialog and the user said no, the parked intent would simply rot and the
   * click would have achieved nothing. Reopening the popup finishes the job
   * the only way that is still possible: in basic mode.
   */
  async function resumeInterruptedStart() {
    const pending = state.pendingStart;
    if (!pending || pending.tabId !== state.tab?.id) return;

    await send({ type: MSG.SET_PENDING_START, pending: null });
    state.pendingStart = null;

    // The worker already handled the granted case; a job here means it won.
    if (state.job) return;

    const cfg = { ...pending.job };
    await startJob(state.hasAccess ? cfg : downgrade(cfg));
    if (!state.hasAccess) {
      els.errorNotice.hidden = false;
      els.errorNotice.className = 'notice info section';
      els.errorNotice.textContent = t('permDeniedNote');
    }
  }

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

    // Status pill, primary button and the paused notice are all painted by
    // renderLive(), so the 1s poll and a full render can never disagree.
    // ("Paused — you navigated away" gets a one-click resume there: it is the
    // one pause the user can undo instantly, and it is where competitors
    // either drop the job or start hammering the page you moved to.)
    renderLive();

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

  /**
   * The parts that change on their own while the popup sits open: reload
   * count, countdown, status pill, and any "held up" explanation.
   *
   * Kept separate from render() on purpose -- a full re-render would write
   * every form control from the stored job, yanking values out from under
   * someone mid-edit. This touches only read-only text.
   */
  function renderLive() {
    const job = state.job;

    els.live.hidden = !job;
    if (!job) {
      stopCountdown();
      els.waitingNotice.hidden = true;
      els.pausedNotice.hidden = true;
      els.statusPill.dataset.state = 'off';
      els.statusPill.textContent = t('statusOff');
      els.primary.textContent = t('popupStart');
      els.primary.className = 'btn btn-primary';
      return;
    }

    els.reloadCount.textContent = String(job.reloadCount);

    const running = job.status === 'running';
    const paused = job.status === 'paused';

    els.statusPill.dataset.state = running ? 'running' : paused ? 'paused' : 'off';
    els.statusPill.textContent = running
      ? t('statusRunning')
      : paused
        ? t('statusPaused')
        : t('statusOff');

    // A job can pause itself while the popup sits open -- it hits a reload
    // limit, or the user navigates the tab away. The button has to follow, or
    // it offers to Stop something that already stopped.
    els.primary.textContent = running ? t('popupStop') : t('popupStart');
    els.primary.className = running ? 'btn btn-danger' : 'btn btn-primary';

    els.pausedNotice.hidden = !paused;
    if (paused) {
      els.pausedText.textContent = pauseMessage(job.pauseReason);
      const away = job.pauseReason === PAUSE_REASON.NAVIGATED_AWAY;
      els.resumeHere.hidden = !away && job.pauseReason !== PAUSE_REASON.USER;
    }

    // A job that keeps deferring looks exactly like a broken one -- status
    // says running, counter never moves. Say what is actually happening.
    if (running && job.waitingReason) {
      els.waitingNotice.hidden = false;
      els.waitingNotice.textContent = pauseMessage(job.waitingReason);
    } else {
      els.waitingNotice.hidden = true;
    }

    startCountdown(job);
  }

  /**
   * @param {unknown} err
   */
  function showError(err) {
    els.errorNotice.hidden = false;
    els.errorNotice.className = 'notice error section';
    els.errorNotice.textContent = String(
      /** @type {any} */ (err)?.message || err || 'Something went wrong.',
    );
    console.error('[AutoRefresh]', err);
  }

  function clearError() {
    els.errorNotice.hidden = true;
    // The same element doubles as an informational notice, so reset the tone.
    els.errorNotice.className = 'notice error section';
  }

  /**
   * Wraps a click handler so a rejected promise becomes a visible message
   * rather than an unhandled rejection in a console nobody has open. An action
   * that silently does nothing is the single most confusing failure mode a
   * popup can have.
   *
   * @param {() => Promise<void>} fn
   * @returns {() => void}
   */
  function guarded(fn) {
    return () => {
      clearError();
      fn().catch(showError);
    };
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

  /** Pulls only the volatile fields, for the 1s poll. */
  async function refreshLive() {
    const next = await send({ type: MSG.GET_STATE });
    state.job = next.job;
    state.activeCount = next.activeCount;
    renderLive();
    els.activeCount.innerHTML = `<span class="dot"></span>${next.activeCount || 0} active`;
  }

  // Poll while the popup is open so the reload counter and countdown reflect
  // reality. Without this the popup shows whatever was true when it opened,
  // the countdown runs to 0:00 and sits there, and a job that is working
  // looks stuck.
  const livePoll = window.setInterval(() => {
    refreshLive().catch(() => {
      /* transient; the next tick will catch up */
    });
  }, 1000);
  window.addEventListener('pagehide', () => clearInterval(livePoll));

  els.primary.addEventListener(
    'click',
    guarded(async () => {
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
        // Make it unmissable. Previously the prompt could appear below the
        // fold with the Start button unchanged, so pressing Start looked like
        // it had simply done nothing.
        els.permPrompt.scrollIntoView({ block: 'nearest' });
        /** @type {HTMLButtonElement} */ (els.permGrant).focus();
        els.primary.disabled = true;
        return;
      }

      await startJob(cfg);
    }),
  );

  async function startJob(/** @type {any} */ cfg) {
    await send({ type: MSG.START_JOB, tabId: state.tab?.id, job: cfg });
    await refreshState();
  }

  /** Trims a config down to what basic mode can honestly deliver. */
  function downgrade(/** @type {any} */ cfg) {
    cfg.intervalMs = Math.max(30_000, cfg.intervalMs);
    cfg.randomize.minMs = Math.max(30_000, cfg.randomize.minMs);
    cfg.randomize.maxMs = Math.max(30_000, cfg.randomize.maxMs);
    cfg.scrollRestore.enabled = false;
    cfg.monitor.enabled = false;
    return cfg;
  }

  els.permGrant.addEventListener(
    'click',
    guarded(async () => {
      const pattern = originPattern(state.tab?.url || '');
      els.primary.disabled = false;
      if (!pattern) {
        els.permPrompt.hidden = true;
        return;
      }

      // Record the intent BEFORE asking.
      //
      // chrome.permissions.request() closes this popup: Chrome puts its own
      // confirmation dialog up and tears the popup down with it, so the
      // promise below may never resolve and nothing after it would ever run.
      // That is why granting appeared to do nothing and Start had to be
      // pressed a second time. With the intent parked in the worker,
      // permissions.onAdded finishes the job whether or not this context
      // survives -- and if it does survive, the code below completes normally
      // and clears the record.
      if (pendingStart) {
        await send({
          type: MSG.SET_PENDING_START,
          pending: { tabId: state.tab.id, url: state.tab.url, job: collect() },
        });
      }

      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [pattern] });
      } catch (err) {
        console.warn('[AutoRefresh] permission request failed', err);
      }

      els.permPrompt.hidden = true;
      if (granted) await send({ type: MSG.REQUEST_ORIGIN_ACCESS, url: state.tab.url });

      if (!pendingStart) {
        // Granted mid-run: push whatever setting the user had just switched
        // on, which was held back pending this answer.
        if (granted && state.job?.status === 'running') {
          await send({ type: MSG.UPDATE_JOB, tabId: state.tab?.id, job: collect() });
        }
        await refreshState();
        return;
      }
      pendingStart = false;

      // Still alive, so finish here and drop the parked intent -- otherwise
      // the worker would start the job a second time.
      await send({ type: MSG.SET_PENDING_START, pending: null });

      // Denied: start anyway with what basic mode can deliver, and say so,
      // rather than leaving the click with nothing to show for it.
      const cfg = collect();
      await startJob(granted ? cfg : downgrade(cfg));
      if (!granted) {
        els.errorNotice.hidden = false;
        els.errorNotice.className = 'notice info section';
        els.errorNotice.textContent = t('permDeniedNote');
      }
    }),
  );

  els.permSkip.addEventListener(
    'click',
    guarded(async () => {
      els.permPrompt.hidden = true;
      els.primary.disabled = false;
      await send({ type: MSG.SET_PENDING_START, pending: null });
      if (!pendingStart) {
        // Declined a mid-run upgrade: re-render so the control they toggled
        // snaps back to what the job is actually doing.
        await refreshState();
        return;
      }
      pendingStart = false;
      await startJob(downgrade(collect()));
    }),
  );

  els.reloadNow.addEventListener(
    'click',
    guarded(async () => {
      await send({ type: MSG.RELOAD_ONCE, tabId: state.tab?.id });
      window.close();
    }),
  );

  els.resumeHere.addEventListener(
    'click',
    guarded(async () => {
      await send({ type: MSG.RESUME_JOB, tabId: state.tab?.id });
      await refreshState();
    }),
  );

  els.pickRegion.addEventListener(
    'click',
    guarded(async () => {
      const tabId = state.tab?.id;
      if (typeof tabId !== 'number') throw new Error('No page to pick from.');

      // Park the half-configured job first: injecting the picker destroys this
      // popup, so there is nothing left to return a value to. The picker sends
      // its result to the worker, which holds it in the draft we read on open.
      await send({ type: MSG.SET_DRAFT, draft: { tabId, monitor: collect().monitor } });

      // Injected from HERE rather than from the service worker, because the
      // activeTab grant that makes this legal without host permissions comes
      // from the user's click on the action -- and this handler is the closest
      // point to that gesture. Doing it via a message round-trip added a hop
      // for no benefit, and any failure vanished into a rejected promise.
      try {
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/picker.css'] });
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/picker.js'] });
      } catch (err) {
        await send({ type: MSG.SET_DRAFT, draft: null });
        throw new Error(
          `Can't open the picker on this page. ${String(/** @type {any} */ (err)?.message || err)}`,
        );
      }

      window.close();
    }),
  );

  els.alwaysRefresh.addEventListener(
    'click',
    guarded(async () => {
      if (!state.tab?.url) return;
      const u = new URL(state.tab.url);
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
          settings: collect(),
          createdAt: Date.now(),
        },
      });
      els.alwaysRefresh.textContent = '✓ Rule saved';
    }),
  );

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
    el.addEventListener(
      'change',
      guarded(async () => {
        if (state.job?.status !== 'running') return;

        // Turning on a page feature mid-run needs the same access Start would
        // have asked for. Without this the setting appears to apply and then
        // quietly does nothing.
        const cfg = collect();
        if (needsAccess(cfg) && !state.hasAccess && state.tab?.url) {
          pendingStart = false;
          els.permPrompt.hidden = false;
          els.permPrompt.scrollIntoView({ block: 'nearest' });
          /** @type {HTMLButtonElement} */ (els.permGrant).focus();
          return;
        }

        await send({ type: MSG.UPDATE_JOB, tabId: state.tab?.id, job: cfg });
        await refreshState();
      }),
    );
  }
}
