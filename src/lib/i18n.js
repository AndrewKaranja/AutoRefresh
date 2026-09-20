// @ts-check
/**
 * Declarative i18n for extension pages.
 *
 * Markup carries `data-i18n="msgKey"` (or `data-i18n-attr="placeholder:msgKey"`)
 * and this walks the document once on load. Keeps HTML readable and makes
 * adding a locale a pure translation task -- no code changes, no rebuild.
 */

/**
 * @param {string} key
 * @param {string[]} [subs]
 * @returns {string}
 */
export function t(key, subs) {
  const msg = chrome.i18n.getMessage(key, subs);
  // A missing key returns '' from Chrome, which renders as a blank label and
  // is maddening to track down. Surface the key instead.
  return msg || key;
}

/**
 * @param {ParentNode} [root]
 * @returns {void}
 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  }

  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    // "placeholder:jobIntervalPlaceholder, title:jobIntervalTitle"
    const spec = el.getAttribute('data-i18n-attr') || '';
    for (const pair of spec.split(',')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }

  document.documentElement.lang = chrome.i18n.getUILanguage();
}
