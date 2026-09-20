/**
 * Theme bootstrap. Loaded as a CLASSIC script in <head>, before the
 * stylesheet, so `data-theme` is on <html> before first paint.
 *
 * It cannot be a module: modules are deferred, which would guarantee a flash
 * of the wrong theme on every popup open. It also cannot be inline -- the
 * extension-page CSP forbids inline script. A synchronous external classic
 * script in <head> is the only combination that satisfies both.
 *
 * chrome.storage is async, so a dark-mode user still gets one possible frame
 * of light. We narrow that by preferring the last value cached in
 * localStorage, which is synchronous, and reconciling afterwards.
 */
(function () {
  'use strict';

  var CACHE_KEY = 'arf.theme';
  var root = document.documentElement;

  function apply(theme) {
    if (theme === 'light' || theme === 'dark') {
      root.setAttribute('data-theme', theme);
    } else {
      // 'auto': let prefers-color-scheme decide, per the CSS.
      root.removeAttribute('data-theme');
    }
  }

  var cached = null;
  try {
    cached = localStorage.getItem(CACHE_KEY);
  } catch (e) {
    // Private mode or a locked-down profile. Not worth failing over.
  }
  apply(cached || 'auto');

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.get('settings', function (got) {
      var theme = (got && got.settings && got.settings.theme) || 'auto';
      if (theme !== cached) {
        apply(theme);
        try {
          localStorage.setItem(CACHE_KEY, theme);
        } catch (e) {
          /* ignore */
        }
      }
    });
  }
})();
