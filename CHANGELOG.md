# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] — unreleased

Reliability fixes found in testing of the 2.0.0 rewrite. Several of these made
the extension report itself as running while never actually reloading.

### Fixed

- **Jobs could report "Running" and never reload at all.** The unsaved-form
  check compared every field's value against its `defaultValue`, so any site
  whose JavaScript prefills a search box, sets a `<select>` after load, or
  renders a `contenteditable` looked permanently dirty. The job then deferred
  on every single fire, forever, while the status said running and the counter
  sat at zero. Dirty state is now tracked from trusted `input`/`beforeinput`
  events — actual typing — and clears once the field is empty again.
- **The reload counter stayed at zero and the badge was blank.** Two causes:
  the deferral above meant no reload ever completed, and `formatBadgeCount`
  returns `''` for zero, which cleared the badge entirely — so a freshly
  started job was visually identical to a stopped one.
- **Alarm-mode jobs drifted onto a 90-second cadence.** After each reload,
  `fire()` re-armed using the page-mode watchdog formula (`2× + 30s`)
  regardless of mode, so a 30-second refresh ran at 90 seconds whenever the
  post-reload handshake was late or never arrived.
- **Waking the worker by alarm re-armed the job underneath the handler.** A
  one-shot alarm disappears from `getAll()` the moment it fires, so rehydration
  saw "no alarm", re-armed the job, and then had that overwritten moments
  later. Since waking-by-alarm is the normal path, this cost reloads routinely.
- **A missed handshake blocked fast jobs for 90 seconds.** The page timer used
  the full reload-correlation TTL for de-duplication. Those are different
  questions and now use different windows.
- **"Pick region" did nothing.** Three separate faults: a re-entrancy flag that
  stayed set if a previous run ended without reaching cleanup, leaving the
  button permanently inert; injection failures disappearing into a rejected
  promise with no user-visible message; and the picked selector being applied
  before `render()`, which promptly overwrote it from the stored job.
- **A transient reload failure deleted the job** instead of retrying.
- Popup actions that threw failed silently. Every handler now reports errors
  in the UI rather than only to a console nobody has open.

### Changed

- **Scroll memory is now off by default.** It runs in the page, so it needs
  host access — which meant the very first click of Start raised a permission
  prompt for a feature the user had not asked for. A plain refresh now starts
  immediately with no prompt; enabling scroll memory asks in context.
- **The popup updates live while open.** Reload count, countdown, status pill
  and the Start/Stop button now poll once a second, so a job that pauses or
  reloads while you are watching is reflected immediately instead of showing
  whatever was true when the popup opened.
- **Deferrals are now visible.** A job holding off because of unsaved form text
  shows `…` on the badge and says so in the popup, instead of being
  indistinguishable from a broken one.
- The element picker is injected from the popup rather than via the service
  worker, keeping it adjacent to the user gesture that authorises it.

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
