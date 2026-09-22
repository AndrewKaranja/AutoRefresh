/**
 * The page agent.
 *
 * SINGLE FILE, ZERO IMPORTS -- and it has to stay that way. Content scripts
 * cannot be ES modules, in a static entry or via scripting.executeScript. The
 * `await import(chrome.runtime.getURL(...))` workaround would mean exposing
 * lib/ through web_accessible_resources and taking an async gap at
 * document_start, which is precisely the moment scroll restore cannot afford
 * one.
 *
 * So the handful of values it shares with lib/constants.js are duplicated
 * below, each tagged `mirror:`. scripts/validate-manifest.mjs reads both files
 * and fails the build if they drift, which is cheaper than a bundler for one
 * file.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO: reload the page.
 *
 * When the page timer elapses it messages the worker and the worker calls
 * chrome.tabs.reload. Doing it here with location.reload() would (a) race the
 * message it just sent against its own document teardown and (b) be incapable
 * of a hard reload, since location.reload(true) stopped bypassing the cache
 * when forceReload left the spec.
 *
 * The one exception is the fail-open path below, where the worker is
 * unreachable and a plain reload beats not refreshing at all.
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  // Both a registered content script and an activeTab executeScript can land
  // in the same document. The isolated world is shared between them, so this
  // flag is enough to keep one agent per document.
  if (window.__autoRefreshAgent) return;
  window.__autoRefreshAgent = true;

  var MSG_CS_READY = 'CS_READY'; // mirror:MSG.CS_READY
  var MSG_RELOAD_NOW = 'RELOAD_NOW'; // mirror:MSG.RELOAD_NOW
  var MSG_MONITOR_SAMPLE = 'MONITOR_SAMPLE'; // mirror:MSG.MONITOR_SAMPLE
  var MSG_IS_DIRTY = 'IS_DIRTY'; // mirror:MSG.IS_DIRTY
  var MONITOR_TEXT_CAP = 200000; // mirror:MONITOR_TEXT_CAP
  var MONITOR_SETTLE_MS = 1500; // mirror:MONITOR_SETTLE_MS
  var LIVE_WATCH_MAX_BATCHES = 50; // mirror:LIVE_WATCH_MAX_BATCHES
  var LIVE_WATCH_WINDOW_MS = 5000; // mirror:LIVE_WATCH_WINDOW_MS
  var LIVE_WATCH_DEBOUNCE_MS = 500; // mirror:LIVE_WATCH_DEBOUNCE_MS

  var SCROLL_KEY = '__autoRefreshScroll';

  var timer = null;
  var observer = null;
  var directives = null;

  // -------------------------------------------------------------------------
  // Scroll position
  // -------------------------------------------------------------------------

  // Chrome restores scroll itself on reload, and its idea of where you were
  // is based on the pre-reload document. On a page whose content shifts
  // between loads that lands in the wrong place, so we take over completely.
  try {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  } catch (e) {
    /* some embedded contexts disallow this */
  }

  function rememberScroll() {
    try {
      sessionStorage.setItem(
        SCROLL_KEY,
        JSON.stringify({ x: window.scrollX, y: window.scrollY, at: Date.now() }),
      );
    } catch (e) {
      /* storage disabled or full */
    }
  }

  function restoreScroll() {
    // sessionStorage survives a reload within the same tab and origin, and
    // reading it is synchronous -- so the position is available immediately,
    // rather than after a round-trip to the worker that the first paint would
    // beat.
    var saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null');
    } catch (e) {
      return;
    }
    if (!saved || (!saved.x && !saved.y)) return;
    if (Date.now() - saved.at > 5 * 60 * 1000) return; // stale, probably a fresh visit

    var attempts = 0;
    // Content loads in stages, so a single scrollTo at load time usually lands
    // short. Re-apply for a few frames until the position sticks.
    function apply() {
      window.scrollTo(saved.x, saved.y);
      if (++attempts < 12 && Math.abs(window.scrollY - saved.y) > 2) {
        requestAnimationFrame(apply);
      }
    }
    apply();
  }

  // -------------------------------------------------------------------------
  // Dirty-form detection
  // -------------------------------------------------------------------------

  // Track real typing rather than inferring it.
  //
  // The obvious implementation -- compare every field's value against its
  // defaultValue -- is hopelessly over-eager. Any site whose JavaScript
  // prefills a search box, sets a <select> after load, or renders a
  // contenteditable looks permanently dirty. The job then postpones on every
  // single fire and NEVER reloads, while still reporting itself as running.
  // That is far worse than occasionally interrupting a draft: it is a
  // refresher that silently does nothing.
  //
  // A trusted input event is the browser telling us a human typed. Scripted
  // value assignment does not produce one, so this cannot false-positive on
  // page setup.
  var userTyped = false;

  function markTyped(event) {
    if (!event || !event.isTrusted) return;
    var el = event.target;
    if (!el) return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
      userTyped = true;
    }
  }

  document.addEventListener('input', markTyped, true);
  document.addEventListener('beforeinput', markTyped, true);

  function isDirty() {
    if (!userTyped) return false;

    // They typed at some point -- but if the field has since been cleared or
    // submitted there is nothing left to protect, so the job should resume.
    try {
      var fields = document.querySelectorAll('input, textarea, [contenteditable="true"]');
      for (var i = 0; i < fields.length; i++) {
        var el = fields[i];
        var type = (el.type || '').toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') continue;

        if (el.isContentEditable) {
          if ((el.textContent || '').trim().length > 0) return true;
        } else if ((el.value || '').length > 0) {
          return true;
        }
      }
    } catch (e) {
      return false;
    }

    userTyped = false; // nothing left in any field; stop holding the job up
    return false;
  }

  // -------------------------------------------------------------------------
  // Monitoring
  // -------------------------------------------------------------------------

  function extractText(selector) {
    var el = selector ? document.querySelector(selector) : document.body;
    if (!el) return { text: '', selectorMissing: !!selector };
    // innerText, not textContent: it honours visibility, so hidden templates
    // and display:none scaffolding do not register as page content.
    return { text: (el.innerText || '').slice(0, MONITOR_TEXT_CAP), selectorMissing: false };
  }

  function sample(monitor) {
    var result = extractText(monitor.selector);
    send({
      type: MSG_MONITOR_SAMPLE,
      sample: { text: result.text, url: location.href, selectorMissing: result.selectorMissing },
    });
  }

  function scheduleSample(monitor) {
    var settle = monitor.settleMs || MONITOR_SETTLE_MS;
    var run = function () {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(function () {
          sample(monitor);
        }, { timeout: 1000 });
      } else {
        sample(monitor);
      }
    };
    // Wait for the page to settle before sampling: lazy images, late XHR and
    // skeleton placeholders all resolve after load, and sampling too early
    // reports a "change" on every single reload.
    setTimeout(run, settle);
  }

  function startLiveWatch(monitor) {
    if (!monitor.liveWatch || !monitor.selector) return;
    var target = document.querySelector(monitor.selector);
    if (!target) return;

    var debounce = null;
    var batches = 0;
    var windowStart = Date.now();

    observer = new MutationObserver(function () {
      // Circuit breaker. A chat widget, a carousel or an ad slot inside the
      // watched region will fire continuously; without this it would pin a CPU
      // core for as long as the tab is open.
      var now = Date.now();
      if (now - windowStart > LIVE_WATCH_WINDOW_MS) {
        batches = 0;
        windowStart = now;
      }
      if (++batches > LIVE_WATCH_MAX_BATCHES) {
        observer.disconnect();
        observer = null;
        console.info('[AutoRefresh] live watch disabled: region changes too frequently');
        return;
      }

      clearTimeout(debounce);
      debounce = setTimeout(function () {
        sample(monitor);
      }, LIVE_WATCH_DEBOUNCE_MS);
    });

    observer.observe(target, { childList: true, subtree: true, characterData: true });
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message);
    } catch (e) {
      // Extension reloaded or updated out from under this document.
      return Promise.reject(e);
    }
  }

  function armPageTimer(ms) {
    clearTimeout(timer);
    timer = setTimeout(function () {
      // The worker performs the reload. sendMessage wakes it if it has been
      // torn down, which costs tens of milliseconds.
      send({ type: MSG_RELOAD_NOW }).catch(function () {
        // Fail OPEN. If the worker cannot be reached at all, a plain reload is
        // strictly better than an auto-refresher that has silently stopped
        // refreshing -- the user loses the hard-reload flag, not the feature.
        location.reload();
      });
    }, ms);
  }

  function applyDirectives(reply) {
    if (!reply || !reply.ok || !reply.job) return;
    directives = reply;

    if (reply.scroll && reply.scroll.enabled) {
      if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', restoreScroll, { once: true });
      } else {
        restoreScroll();
      }
      window.addEventListener('scroll', throttled(rememberScroll, 250), { passive: true });
      window.addEventListener('beforeunload', rememberScroll);
    }

    if (reply.monitor) {
      onLoad(function () {
        scheduleSample(reply.monitor);
        startLiveWatch(reply.monitor);
      });
    }

    if (typeof reply.armPageMs === 'number' && reply.armPageMs > 0) {
      if (reply.waitForLoad) {
        // Measure from document-ready rather than fire-to-fire. Measuring
        // between fires means a page that takes longer to load than the
        // interval gets reloaded before it has finished rendering -- the
        // classic complaint about naive auto-refreshers.
        onLoad(function () {
          armPageTimer(reply.armPageMs);
        });
      } else {
        armPageTimer(reply.armPageMs);
      }
    }
  }

  function onLoad(fn) {
    if (document.readyState === 'complete') fn();
    else window.addEventListener('load', fn, { once: true });
  }

  function throttled(fn, ms) {
    var last = 0;
    var pending = null;
    return function () {
      var now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn();
      } else if (!pending) {
        pending = setTimeout(function () {
          pending = null;
          last = Date.now();
          fn();
        }, ms - (now - last));
      }
    };
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message) return undefined;

    if (message.type === MSG_IS_DIRTY) {
      sendResponse(isDirty());
      return undefined;
    }

    return undefined;
  });

  window.addEventListener('pagehide', function () {
    clearTimeout(timer);
    if (observer) observer.disconnect();
  });

  // The handshake. A content script cannot learn its own tab id without
  // asking, so this round-trip has to happen regardless -- which is why the
  // worker also uses it as the single re-arm point.
  send({ type: MSG_CS_READY, url: location.href })
    .then(applyDirectives)
    .catch(function () {
      /* no worker yet, or this page is not being refreshed */
    });
})();
