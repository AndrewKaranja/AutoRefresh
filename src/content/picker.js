/**
 * Element picker: click a region of the page to watch it for changes.
 *
 * Injected on demand from a popup click, so activeTab covers it and no host
 * permission is needed just to choose a region.
 *
 * Like agent.js this is a single import-free file; the selector heuristics it
 * shares with lib/selector.js are duplicated below and checked by
 * scripts/validate-manifest.mjs.
 *
 * THE TRAP THIS FILE IS BUILT AROUND: injecting the picker closes the popup.
 * There is no popup left to return a value to, so the result is sent to the
 * service worker, which parks it in a draft that the popup re-reads next time
 * it opens.
 */
(function () {
  'use strict';

  if (window.__autoRefreshPicker) return;
  window.__autoRefreshPicker = true;

  var MSG_PICKER_RESULT = 'PICKER_RESULT'; // mirror:MSG.PICKER_RESULT
  var MSG_PICKER_CANCELLED = 'PICKER_CANCELLED'; // mirror:MSG.PICKER_CANCELLED

  // mirror:STABLE_ATTRS
  var STABLE_ATTRS = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-qa',
    'data-cy',
    'itemprop',
    'aria-label',
    'name',
    'role',
  ];

  /**
   * mirror:isUnstableClassName
   *
   * Hashed class names from CSS Modules, emotion, styled-components and
   * Tailwind's JIT change on the site's next deploy. A selector built on one
   * works today and matches nothing on Thursday, at which point the monitor
   * reports "no change" forever and looks broken.
   */
  function isUnstableClassName(cls) {
    if (!cls) return true;
    if (/[-_][0-9a-f]{5,}$/i.test(cls)) return true;
    if (/^[a-z]{0,4}[-_]?[0-9a-f]{6,}$/i.test(cls)) return true;
    if (/\d{4,}/.test(cls)) return true;
    if (/^(css|sc|jsx|tw|chakra|mui|ant)-[0-9a-z]{4,}$/i.test(cls)) return true;
    if (/^_[a-z0-9]{4,}$/i.test(cls) && /\d/.test(cls)) return true;
    return false;
  }

  // mirror:isStableId
  function isStableId(id) {
    if (!id) return false;
    if (/^[0-9]/.test(id)) return false;
    if (/^:.*:$/.test(id)) return false;
    if (/^(ember|ext-gen|yui|aria-|radix-|headlessui-)/i.test(id)) return false;
    if (isUnstableClassName(id)) return false;
    return true;
  }

  // mirror:escapeIdent
  function escapeIdent(ident) {
    return String(ident).replace(/([^\w-]|^(?=\d)|^-(?=\d))/g, '\\$1');
  }

  // -------------------------------------------------------------------------
  // Selector generation
  // -------------------------------------------------------------------------

  function stepFor(el) {
    var tag = el.tagName.toLowerCase();

    if (el.id && isStableId(el.id)) {
      return { text: '#' + escapeIdent(el.id), unique: true, strong: true };
    }

    for (var i = 0; i < STABLE_ATTRS.length; i++) {
      var attr = STABLE_ATTRS[i];
      var value = el.getAttribute && el.getAttribute(attr);
      if (value && value.length < 80) {
        return {
          text: tag + '[' + attr + '="' + value.replace(/"/g, '\\"') + '"]',
          unique: false,
          strong: true,
        };
      }
    }

    var classes = [];
    if (el.classList) {
      for (var j = 0; j < el.classList.length && classes.length < 2; j++) {
        if (!isUnstableClassName(el.classList[j])) classes.push(el.classList[j]);
      }
    }
    if (classes.length) {
      return { text: tag + '.' + classes.map(escapeIdent).join('.'), unique: false, strong: false };
    }

    // Last resort: position among same-tag siblings.
    var index = 1;
    var sib = el;
    while ((sib = sib.previousElementSibling)) {
      if (sib.tagName === el.tagName) index++;
    }
    return { text: tag + ':nth-of-type(' + index + ')', unique: false, strong: false };
  }

  function buildSelector(el) {
    var steps = [];
    var node = el;
    var depth = 0;
    var usedStrong = false;

    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 5) {
      var step = stepFor(node);
      steps.unshift(step.text);
      if (step.strong) usedStrong = true;

      var candidate = steps.join(' > ');
      if (step.unique || countMatches(candidate) === 1) {
        return { selector: candidate, depth: depth + 1, strong: usedStrong };
      }

      node = node.parentElement;
      depth++;
    }

    var fallback = steps.join(' > ');
    return { selector: fallback, depth: depth, strong: usedStrong };
  }

  function countMatches(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch (e) {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  var overlay = document.createElement('div');
  overlay.className = 'arf-picker-overlay';

  var highlight = document.createElement('div');
  highlight.className = 'arf-picker-highlight';

  var label = document.createElement('div');
  label.className = 'arf-picker-label';

  var hint = document.createElement('div');
  hint.className = 'arf-picker-hint';
  hint.innerHTML = 'Click the part of the page to watch · <kbd>Esc</kbd> to cancel';

  var host = document.documentElement;
  host.appendChild(overlay);
  host.appendChild(highlight);
  host.appendChild(label);
  host.appendChild(hint);

  var currentTarget = null;
  var currentSelector = null;

  function elementUnder(x, y) {
    // The overlay swallows pointer events so the cursor never reaches the
    // page; hide it for the duration of the hit test.
    overlay.style.pointerEvents = 'none';
    var el = document.elementFromPoint(x, y);
    overlay.style.pointerEvents = 'auto';
    if (!el || el === overlay || el === highlight || el === label || el === hint) return null;
    return el;
  }

  function onMove(event) {
    var el = elementUnder(event.clientX, event.clientY);
    if (!el || el === currentTarget) return;
    currentTarget = el;

    var rect = el.getBoundingClientRect();
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';

    var built = buildSelector(el);
    currentSelector = built.selector;
    var matches = countMatches(built.selector);

    var quality = matches !== 1 ? 'weak' : built.strong ? 'strong' : built.depth <= 3 ? 'ok' : 'weak';
    var note =
      matches === 1
        ? quality === 'strong'
          ? 'stable'
          : quality === 'ok'
            ? 'ok'
            : 'may break on redesign'
        : 'matches ' + matches + ' elements';

    label.innerHTML =
      '<b>' +
      escapeHtml(built.selector) +
      '</b> · <span class="' +
      (quality === 'weak' ? 'arf-weak' : '') +
      '">' +
      escapeHtml(note) +
      '</span>';

    // Keep the label on screen: flip it below the element when there is no
    // room above, and clamp it horizontally.
    var top = rect.top - 30;
    if (top < 4) top = Math.min(rect.bottom + 8, window.innerHeight - 34);
    label.style.top = top + 'px';
    label.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 240)) + 'px';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function finish(message) {
    cleanup();
    try {
      chrome.runtime.sendMessage(message);
    } catch (e) {
      /* extension reloaded */
    }
  }

  function onClick(event) {
    // Capture phase with both guards: the page must never see this click, or
    // picking a region of a link would navigate away from the page you are
    // trying to watch.
    event.preventDefault();
    event.stopPropagation();

    var el = currentTarget;
    if (!el) return finish({ type: MSG_PICKER_CANCELLED });

    var text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    finish({ type: MSG_PICKER_RESULT, selector: currentSelector, textAnchor: text });
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish({ type: MSG_PICKER_CANCELLED });
    }
  }

  function cleanup() {
    window.__autoRefreshPicker = false;
    overlay.removeEventListener('mousemove', onMove, true);
    overlay.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    [overlay, highlight, label, hint].forEach(function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
  }

  overlay.addEventListener('mousemove', onMove, true);
  overlay.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
})();
