/**
 * Offscreen audio player.
 *
 * Classic script, not a module: this document has exactly one job and no
 * imports, and chrome.runtime is the only extensions API available here.
 *
 * Messages are filtered on `target === 'offscreen'` because this document
 * shares the runtime message bus with the popup, the options page and every
 * content script -- without the guard it would react to traffic meant for
 * someone else.
 */
(function () {
  'use strict';

  var current = null;

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.target !== 'offscreen') return;

    var file = message.file || 'chime.mp3';
    var volume = typeof message.volume === 'number' ? message.volume : 0.7;

    try {
      // Stop any still-playing sound first. Rapid page changes would otherwise
      // stack overlapping audio elements into a mess.
      if (current) {
        current.pause();
        current.currentTime = 0;
      }

      current = new Audio(chrome.runtime.getURL('assets/sounds/' + file));
      current.volume = Math.min(1, Math.max(0, volume));
      var played = current.play();
      if (played && typeof played.catch === 'function') {
        played.catch(function (err) {
          console.warn('[AutoRefresh] audio play rejected', err);
        });
      }
    } catch (err) {
      console.warn('[AutoRefresh] audio failed', err);
    }
  });
})();
