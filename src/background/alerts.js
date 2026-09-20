// @ts-check
/**
 * Sound and desktop notifications.
 *
 * Audio is the fiddly half. A Manifest V3 service worker has no DOM, so
 * `new Audio()` throws -- this is exactly what broke v1's notification sound.
 * The replacement is an offscreen document, which brings three sharp edges:
 *
 *   1. Only ONE offscreen document may exist per extension. Two alerts firing
 *      milliseconds apart will race on createDocument unless creation is
 *      funnelled through a single shared promise.
 *   2. An AUDIO_PLAYBACK document closes itself after 30 seconds of silence.
 *      So "we created it earlier" is never a safe assumption -- every send has
 *      to be prepared to recreate and retry.
 *   3. chrome.offscreen.hasDocument() only exists in Chrome 150+, so it has to
 *      be feature-detected with a createDocument try/catch as the fallback.
 */

import { MSG } from '../lib/constants.js';
import { getSettings } from '../lib/storage.js';
import { truncate } from '../lib/text.js';

const OFFSCREEN_URL = 'offscreen/audio.html';

/** @type {Promise<void>|null} */
let creating = null;

/**
 * @returns {Promise<boolean>}
 */
async function hasDocument() {
  if (typeof chrome.offscreen?.hasDocument === 'function') {
    try {
      return await chrome.offscreen.hasDocument();
    } catch {
      /* fall through */
    }
  }
  // Pre-150 fallback: ask the runtime which of our contexts are alive.
  try {
    const contexts = await /** @type {Promise<{contextType: string}[]>} */ (
      /** @type {any} */ (chrome.runtime).getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
    );
    return contexts.length > 0;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<void>}
 */
async function ensureDocument() {
  if (await hasDocument()) return;

  // Funnel concurrent callers through one creation. Without this, two alerts
  // 200ms apart both see "no document" and the second throws.
  if (creating) return creating;

  creating = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Play the alert sound when a watched page changes.',
      });
    } catch (err) {
      // Lost the race with another creation -- that is a success for us.
      if (!String(err).includes('Only a single offscreen')) throw err;
    } finally {
      creating = null;
    }
  })();

  return creating;
}

/**
 * @param {string} [file]
 * @returns {Promise<void>}
 */
export async function playSound(file) {
  const settings = await getSettings();
  if (!settings.soundEnabled) return;

  const payload = {
    type: MSG.TEST_SOUND,
    target: 'offscreen',
    file: file || settings.soundFile,
    volume: settings.soundVolume,
  };

  try {
    await ensureDocument();
    await chrome.runtime.sendMessage(payload);
  } catch {
    // The document very likely auto-closed between ensureDocument() and the
    // send (the 30-second silence timer). Recreate once and retry.
    try {
      await ensureDocument();
      await chrome.runtime.sendMessage(payload);
    } catch (err) {
      console.warn('[AutoRefresh] could not play alert sound', err);
    }
  }
}

/**
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.contextMessage]
 * @param {boolean} [opts.force] Bypass the user's notifications setting (used
 *                               by the explicit "Test notification" button).
 * @returns {Promise<string|null>}
 */
export async function notify({ title, message, contextMessage, force = false }) {
  if (!force) {
    const settings = await getSettings();
    if (!settings.notificationsEnabled) return null;
  }

  try {
    // The bundled @types/chrome still models create() as callback-only, so it
    // is declared to return void. In MV3 it returns a promise.
    return await /** @type {Promise<string>} */ (
      /** @type {any} */ (chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('assets/icons/icon-128.png'),
        title,
        message: truncate(message || '', 250),
        contextMessage,
        priority: 1,
      }))
    );
  } catch (err) {
    console.warn('[AutoRefresh] notification failed', err);
    return null;
  }
}

/**
 * Notification ids carry the tab they belong to, so clicking one can focus
 * the right tab without keeping a map in worker memory that would not survive
 * termination.
 *
 * @param {number} tabId
 * @returns {string}
 */
export function tabNotificationId(tabId) {
  return `arf-tab-${tabId}`;
}

/**
 * @param {string} notificationId
 * @returns {number|null}
 */
export function tabIdFromNotification(notificationId) {
  const m = /^arf-tab-(\d+)$/.exec(notificationId);
  return m ? Number(m[1]) : null;
}
