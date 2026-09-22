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
 * TWO TRAPS THIS FILE IS BUILT AROUND
 *
 * 1. Injecting the picker closes the popup. There is no popup left to return a
 *    value to, so the result is sent to the service worker, which parks it in
 *    a draft the popup re-reads next time it opens.
 *
 * 2. Hit testing cannot toggle pointer-events. The overlay sits under the
 *    cursor, so the hovered element has to be found by point -- but
 *    `overlay.style.pointerEvents = 'none'` is a NORMAL inline declaration and
 *    loses to the `!important` rule in picker.css. The toggle silently did
 *    nothing, elementFromPoint kept returning the overlay, and the highlight
 *    never moved. elementsFromPoint() (plural) sidesteps the whole problem by
 *    returning the full stack, so we can just skip our own nodes.
 */
(function () {
  'use strict';

  // Re-entrancy: tear down any previous picker rather than bailing out.
  //
  // A plain `if (active) return;` guard strands the feature the moment a
  // previous run ends without reaching cleanup() -- a soft navigation, an
  // extension reload, the user dismissing the popup mid-pick. The flag stays
  // true, every later click injects a script that immediately returns, and the
  // button looks broken with nothing in the console to explain it.
  if (typeof window.__autoRefreshPickerCleanup === 'function') {
    try {
      window.__autoRefreshPickerCleanup();
    } catch (e) {
      /* previous instance was already half gone */
    }
  }

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

    return { selector: steps.join(' > '), depth: depth, strong: usedStrong };
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
  hint.innerHTML =
    'Click to watch this region' +
    '<span class="arf-sep">|</span><kbd>&uarr;</kbd><kbd>&darr;</kbd> wider / narrower' +
    '<span class="arf-sep">|</span><kbd>Esc</kbd> cancel';

  // Corner ticks make the exact bounds readable over any background.
  var corners = [];
  for (var c = 0; c < 4; c++) {
    var corner = document.createElement('div');
    corner.className = 'arf-picker-corner';
    corners.push(corner);
  }

  var host = document.documentElement;
  host.appendChild(overlay);
  host.appendChild(highlight);
  corners.forEach(function (node) {
    host.appendChild(node);
  });
  host.appendChild(label);
  host.appendChild(hint);

  var ownNodes = [overlay, highlight, label, hint].concat(corners);

  var currentTarget = null;
  var currentSelector = null;
  var lastPoint = { x: -1, y: -1 };

  /**
   * The topmost page element at a point, skipping our own chrome.
   *
   * elementsFromPoint returns the whole stack, so no pointer-events juggling
   * is needed -- which is what the old implementation got wrong.
   */
  function elementUnder(x, y) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      var el = stack[i];
      if (ownNodes.indexOf(el) !== -1) continue;
      if (el === document.documentElement) continue;
      return el;
    }
    return null;
  }

  function setTarget(el) {
    if (!el || el === currentTarget) return;
    currentTarget = el;
    paint();
  }

  function paint() {
    var el = currentTarget;
    if (!el) return;

    var rect = el.getBoundingClientRect();
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';

    var positions = [
      [rect.left, rect.top],
      [rect.right, rect.top],
      [rect.left, rect.bottom],
      [rect.right, rect.bottom],
    ];
    corners.forEach(function (node, i) {
      node.style.left = positions[i][0] - 4 + 'px';
      node.style.top = positions[i][1] - 4 + 'px';
    });

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

    var size = Math.round(rect.width) + ' x ' + Math.round(rect.height);
    var preview = (el.innerText || '').replace(/\s+/g, ' ').trim();

    label.innerHTML =
      '<span class="arf-sel">' +
      escapeHtml(built.selector) +
      '</span>' +
      '<span class="arf-dim"> &middot; ' +
      escapeHtml(size) +
      ' &middot; </span>' +
      '<span class="' +
      (quality === 'weak' ? 'arf-warn' : 'arf-good') +
      '">' +
      escapeHtml(note) +
      '</span>' +
      (preview
        ? '<span class="arf-preview">' + escapeHtml(preview.slice(0, 120)) + '</span>'
        : '<span class="arf-preview arf-warn">no visible text in this region</span>');

    positionLabel(rect);
  }

  /** Keeps the label on screen and out of the way of the selection. */
  function positionLabel(rect) {
    // Measure rather than guess: the old code assumed a fixed 240px width and
    // clipped the label on wide selectors.
    var lw = label.offsetWidth;
    var lh = label.offsetHeight;

    var top = rect.top - lh - 6;
    if (top < 4) top = rect.bottom + 6;
    if (top + lh > window.innerHeight - 4) top = Math.max(4, window.innerHeight - lh - 4);

    var left = rect.left;
    if (left + lw > window.innerWidth - 4) left = window.innerWidth - lw - 4;
    if (left < 4) left = 4;

    label.style.top = top + 'px';
    label.style.left = left + 'px';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  function onMove(event) {
    lastPoint.x = event.clientX;
    lastPoint.y = event.clientY;
    setTarget(elementUnder(event.clientX, event.clientY));
  }

  /**
   * Arrow keys walk the DOM, which is how you actually land on the region you
   * want. Hovering alone gives you whatever leaf happens to be under the
   * cursor -- usually a <span> inside the thing you meant to select -- and
   * there is no way to say "no, the container around that".
   */
  function widen() {
    if (!currentTarget) return;
    var parent = currentTarget.parentElement;
    if (parent && parent !== document.documentElement) setTarget(parent);
  }

  function narrow() {
    if (!currentTarget) return;
    // Prefer the child still under the cursor, so narrowing follows the mouse
    // rather than jumping to an unrelated first child.
    var children = currentTarget.children;
    if (!children || children.length === 0) return;

    for (var i = 0; i < children.length; i++) {
      var rect = children[i].getBoundingClientRect();
      if (
        rect.width > 0 &&
        rect.height > 0 &&
        lastPoint.x >= rect.left &&
        lastPoint.x <= rect.right &&
        lastPoint.y >= rect.top &&
        lastPoint.y <= rect.bottom
      ) {
        setTarget(children[i]);
        return;
      }
    }

    for (var j = 0; j < children.length; j++) {
      var r = children[j].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setTarget(children[j]);
        return;
      }
    }
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

    if (!currentTarget) return finish({ type: MSG_PICKER_CANCELLED });

    var text = (currentTarget.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    finish({ type: MSG_PICKER_RESULT, selector: currentSelector, textAnchor: text });
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish({ type: MSG_PICKER_CANCELLED });
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      widen();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      narrow();
      return;
    }
    if (event.key === 'Enter' && currentTarget) {
      event.preventDefault();
      event.stopPropagation();
      var text = (currentTarget.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      finish({ type: MSG_PICKER_RESULT, selector: currentSelector, textAnchor: text });
    }
  }

  // The selection is anchored to viewport coordinates, so it has to be
  // repainted when the page moves under it.
  function onScrollOrResize() {
    if (currentTarget) paint();
  }

  function cleanup() {
    window.__autoRefreshPickerCleanup = null;
    overlay.removeEventListener('mousemove', onMove, true);
    overlay.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize, true);
    ownNodes.forEach(function (node) {
      if (node.parentNode) node.parentNode.removeChild(node);
    });
  }

  window.__autoRefreshPickerCleanup = cleanup;

  overlay.addEventListener('mousemove', onMove, true);
  overlay.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize, true);

  // Leaving the page mid-pick must not strand the overlay or the flag.
  window.addEventListener('pagehide', cleanup, { once: true });

  // Show something immediately rather than waiting for the first mouse move,
  // so the picker never looks inert on open.
  var initial = elementUnder(window.innerWidth / 2, window.innerHeight / 3);
  if (initial) {
    lastPoint.x = window.innerWidth / 2;
    lastPoint.y = window.innerHeight / 3;
    setTarget(initial);
  }
})();
