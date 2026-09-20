# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] — unreleased

A complete rewrite. v1.0.2 carried an MV3 manifest but MV2-era code, and was
broken at runtime in roughly eight places — the popup buttons never
initialised and no interval longer than about 30 seconds ever fired.

### Fixed

- **The Start and Stop buttons never worked.** `getStatus` referenced
  `currentInterval`, a `const` scoped to a different branch of the same
  `if`/`else if` chain. The resulting `ReferenceError` meant `sendResponse`
  was never called, so the popup's callback received `undefined` and threw
  while reading `.isRunning` — before any click handler was attached.
- **No interval above ~30 seconds ever fired.** Timing was a self-rescheduling
  `setTimeout` chain inside the service worker. Chrome terminates the worker
  after about 30 seconds of idle, taking the timer with it. Replaced with
  `chrome.alarms` plus a content-script timer for sub-30s intervals.
- **The notification sound could never play.** `new Audio()` in a service
  worker throws — MV3 workers have no DOM. Now routed through an offscreen
  document.
- **The title-dot indicator always threw.** It used
  `chrome.tabs.executeScript` with a code string; the API was removed in MV3
  and string injection is banned outright. Replaced with a per-tab badge.
- **`restoreRefreshInterval()` was called but never defined anywhere**,
  aborting the rest of the popup's load handler.
- **`updateUI()` could not see the buttons it referenced** — it was declared at
  module top level while `startButton` and `stopButton` were `const`s inside a
  `DOMContentLoaded` callback.
- **The "Monitor page for changes" checkbox did nothing.** It had no event
  listener, so the `monitorChangesEnabled` key it was supposed to write was
  never written, and the content script's guard on that key was permanently
  false. The entire feature was inert.
- **A `MutationObserver` ran on every page on the web**, watching
  `document` with `{childList, subtree}` from load, with no debounce, issuing a
  `chrome.storage.sync` read per mutation batch.
- **Per-tab state leaked for the life of the session** — there was no
  `tabs.onRemoved` cleanup.
- **The published extension shipped without icons.** The manifest referenced
  `icon.png` while the file was `icon.PNG`; that works unpacked on a
  case-insensitive filesystem and fails once packed. `npm run validate` now
  checks every manifest path against the real directory listing, byte for byte.
- Dead code removed: an unreachable `chrome.action.onClicked` handler (a popup
  was configured), a `showNotificationDot()` that was never called, and a
  content-script message listener nothing ever sent to.

### Added

- Interval presets from 5s to 1h, plus a custom field.
- Randomized interval ranges.
- Hard reload (true cache bypass) and a re-open-URL mode that avoids
  "Confirm Form Resubmission" on POST result pages.
- Scroll-position memory across reloads.
- Page-change monitoring with a click-to-select element picker, an
  ignore-regex for volatile content, a "what changed" snippet in the
  notification, desktop notifications and sound. Free.
- Site rules with auto-start — the honest answer to surviving a browser
  restart, since every tab id changes.
- Stop conditions: maximum reload count and absolute deadline.
- Dirty-form detection, so a reload doesn't strand you on "Leave site?".
- Per-tab badge with live reload count and a distinct icon for running tabs.
- Keyboard shortcuts: `Alt+Shift+R` toggle, `Alt+Shift+N` refresh now.
- Options page: active jobs, site rules, settings, and a permission-rationale
  table.
- Dark mode, and `_locales` scaffolding so translation needs no code changes.
- Test suite (`node --test`, no dependencies) over the pure logic, and a
  validator that catches manifest case mismatches and content-script constant
  drift.

### Changed

- **Navigating away now pauses instead of guessing.** Jobs are keyed by tab but
  carry a scope, defaulting to the origin. In scope: keep going, including
  through trailing-slash redirects and SPA query rewrites. Out of scope: pause
  with "you navigated away" and a one-click resume — rather than stopping
  permanently or, worse, refreshing whatever you navigated to.
- **Permissions restructured so install shows no warnings.** Dropped the static
  `content_scripts` block on `<all_urls>` (an implicit host permission, and the
  source of "read and change all your data on all websites") in favour of
  `optional_host_permissions` requested per-origin at runtime, only when a
  feature actually needs to read the page. Removed the unused `webNavigation`
  permission. Added `alarms`, `scripting` and `offscreen`.
- Interval is now measured from document-ready rather than fire-to-fire, so a
  page slower than its interval is no longer reloaded mid-render.
- New icon set, drawn as primitives and tuned per size so the 16px toolbar
  icon stays legible.
- Repository restructured: `src/` is the package, store artwork moved to
  `store/` and can no longer end up inside the zip.
- Added the MIT `LICENSE` file the README had been claiming since 2023.

### Migration

Nothing to migrate. All v1 state lived in service-worker globals, and the one
`chrome.storage.sync` key it read was never written by anything. On update the
dead key is removed and defaults are written.

## [1.0.2] — 2023-04

Initial published release.
