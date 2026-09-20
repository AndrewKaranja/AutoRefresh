# Auto Refresh

A Chrome extension that reloads tabs on your schedule — and tells you when the page actually changed.

Manifest V3, no build step, no dependencies at runtime, no data collection.

---

## Features

| | |
|---|---|
| **Interval presets + custom** | 5s to 24h, one tap from the popup |
| **Random intervals** | Draw uniformly from a range, so the pattern looks less automated |
| **Hard reload** | True cache bypass via `chrome.tabs.reload({bypassCache:true})` |
| **Re-open URL** | Re-navigates as a GET — the clean escape from "Confirm Form Resubmission" |
| **Scroll memory** | Returns to where you were, without the jump |
| **Page-change alerts** | Pick a region, get a notification and a sound when it changes. Free — the competitor that paywalls this charges for it |
| **Ignore-regex** | Strip clocks, timestamps and rotating ads so they don't count as changes |
| **Stop conditions** | Stop after N reloads, or at a deadline |
| **Site rules** | "Always refresh this site" — survives a browser restart |
| **Smart scoping** | Navigating away *pauses*, it doesn't delete your job and it doesn't start hammering the new page |
| **Form protection** | Detects unsaved input and waits rather than triggering "Leave site?" |
| **Per-tab badge** | Live reload count and a distinct icon for tabs that are refreshing |
| **Keyboard shortcuts** | `Alt+Shift+R` toggle, `Alt+Shift+N` refresh now |
| **Dark mode** | Follows the system, or force it |

**Installs with zero permission warnings.** A basic refresh needs no site access at all; see [Permissions](#permissions).

---

## Install

**From the Web Store:** search for "Auto Refresh", or use the listing link on the repository page.

**From source:**

```bash
git clone https://github.com/AndrewKaranja/AutoRefresh.git
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select the **`src/`** directory — not the repository root. `src/` is the extension; everything else is tooling, tests and store artwork.

> ⚠️ **Testing trap:** unpacked Chrome honours `chrome.alarms` delays below 30 seconds. Packed Chrome silently ignores them. Anything depending on alarm timing must be confirmed in a packed build — see [Verifying](#verifying).

---

## Architecture

Three invariants hold the whole design together. They are restated at the top of `src/background/scheduler.js`.

**A — Single alarm.** Every running job has exactly one outstanding alarm, `arf:<jobId>`. In alarm mode it is the timer; in page mode it is a stall watchdog. One reconciliation path, one class of leak. The name carries the *job* id, never the tab id, so a recycled tab id can never be driven by a dead job's alarm.

**B — Mode is derived, never stored.** `mode = lowerBound(interval) < 30s ? 'page' : 'alarm'`, recomputed on every arm. Using the *lower* bound means a randomized 20–90s job stays on one timing mechanism for its whole life instead of thrashing between two.

**C — Reload correlation.** Every reload we initiate writes `job.pending = {nonce, at, method}` *before* calling the Chrome API. The next handshake consumes it. This is the only thing separating our reload from you pressing F5 — and therefore the only reason the reload counter and stop conditions are honest.

### The hybrid scheduler

`chrome.alarms` cannot go below 30 seconds in a packed extension. So:

```
interval ≥ 30s   →  ALARM MODE   service worker alarm drives the reload
interval < 30s   →  PAGE MODE    content-script timer drives it,
                                 alarm demoted to a stall watchdog
```

**Page mode never calls `location.reload()`.** The content script's timer fires, it messages the worker, and the worker calls `chrome.tabs.reload`. Two reasons, both decisive:

1. It deletes the "reload destroys the content script mid-message" race — the reload is initiated from a context that is not being torn down by it.
2. `location.reload(true)` has been a no-op since `forceReload` left the spec. A hard reload is reachable *only* through `chrome.tabs.reload(tabId, {bypassCache:true})`.

> **Content script owns timing. Service worker owns execution.**

### Where state lives

| Store | Holds | Why |
|---|---|---|
| `storage.session` | Live jobs, keyed `job:<tabId>` | In-memory, cleared on restart — exactly the lifecycle a tab-id-keyed record should have. Survives worker termination because it is browser memory, not worker memory. The URLs you refresh never touch disk. |
| `storage.sync` | Rules, settings | Small, cross-device, rarely written. Quota is 120 writes/min, 1800/hr. |
| `storage.local` | Counters, monitor snapshots | No rate limit. A per-reload counter in `sync` would exhaust the hourly quota in about half an hour. |

The worker keeps **no authoritative state in globals** — they vanish every time Chrome tears it down. The only module-level variable is a rehydration promise.

### Jobs do not survive a browser restart — on purpose

Every tab id is new after a restart, so resurrecting job *instances* would be meaningless. What survives is your *intent*, expressed as a **site rule**. Create one with "Always refresh this site" in the popup footer.

---

## Permissions

The design goal was zero install-time warnings, and it is met: `chrome.tabs.reload` needs no host permission, and `tabs` alone is enough to read a tab's URL and title. **A refresh of 30 seconds or slower works with no site access whatsoever.**

Access is requested at runtime, one origin at a time, only when you enable something that must read the page — sub-30s intervals, scroll memory, or change monitoring. The prompt appears the moment you click Start on that site. Decline it and the job runs in basic mode with an inline note, rather than failing.

| Permission | What it is for |
|---|---|
| `storage` | Saves intervals, rules and current state on this device |
| `alarms` | Schedules reloads ≥30s. The only reliable timer an MV3 worker has, since Chrome shuts the worker down when idle |
| `tabs` | Reads the URL and title of the tab you chose, to reload the right one and match your rules |
| `scripting` | Injects the refresh agent into pages you explicitly enabled |
| `activeTab` | Lets you point at a region to watch, using only the tab you invoked from |
| `notifications` | Desktop alert when a watched page changes. Opt-in per job |
| `offscreen` | Plays the alert sound — MV3 workers have no DOM and cannot play audio |
| `<all_urls>` | **Optional.** Requested at runtime, per site, never at install |

There is no static `content_scripts` block in the manifest. That block is an implicit host permission and is precisely what produces *"Read and change all your data on all websites"* at install time.

---

## Privacy

Nothing is collected, transmitted or sold. No analytics, no telemetry, no remote code. All of this is verifiable in the source:

- Tabs being refreshed live in `chrome.storage.session` — memory only, never written to disk.
- Rules and settings live in `chrome.storage.sync`, which syncs through *your* Google account, not through any server of ours.
- Monitoring hashes the watched text locally (FNV-1a) to compare against the previous load. Page content is never transmitted.

Full policy: [andrewkaranja.github.io/AutoRefresh/privacy.html](https://andrewkaranja.github.io/AutoRefresh/privacy.html) (source in [`docs/`](docs/)).

---

## Publishing

All the Web Store submission text — per-permission justifications, data-usage answers, single-purpose statement and listing copy — lives in [`store/listing.md`](store/listing.md), kept in the repo so it doesn't have to be re-derived at each release. Reviewers cross-check those justifications against `src/manifest.json`, so change both together.

The privacy policy is served by GitHub Pages from `docs/`. To enable it: **Settings → Pages → Deploy from a branch → `master` / `/docs`**. `docs/.nojekyll` means the HTML is served exactly as written, with no Jekyll build to go wrong. Confirm the URL loads before pasting it into the dashboard.

---

## Development

```bash
npm run validate    # manifest, exact-case asset paths, mirror drift, locale keys
npm test            # 56 unit tests over the pure logic in src/lib/
npm run pack        # dist/auto-refresh-<version>.zip, from an explicit allowlist
npm run icons       # regenerate the icon set (Windows, no dependencies)
npm run build       # validate && test && pack
npm run typecheck   # optional; needs `npm install` for @types/chrome
```

No build step. The folder you load unpacked **is** the source.

### Three guards worth knowing about

Each targets a bug this extension actually shipped, and each has been verified by reintroducing that bug and confirming the check fails.

**Exact-case path checking.** v1.0.2 referenced `icon.png` in its manifest while the file on disk was `icon.PNG`. Windows and macOS filesystems are case-insensitive, so it worked perfectly unpacked — and the published CRX stores the literal name, where lookup *is* case-sensitive. The result was a published extension with no icons. `validate-manifest.mjs` reads directory listings and compares names byte for byte, so this can't ship again.

**Mirror-drift checking.** `content/agent.js` and `content/picker.js` cannot import from `lib/` — content scripts are not ES modules, and the `await import(getURL(...))` workaround costs an async gap at `document_start` that scroll restore cannot afford. They duplicate a few values, each tagged `// mirror:<name>`. The validator resolves every tag against the real source and fails on divergence. Cheaper than a bundler for two files.

**Import resolution.** v1.0.2's popup called a `restoreRefreshInterval()` that was defined nowhere. Chrome reports that only at runtime, where it aborts the rest of the handler — so the Start button was simply never wired up, with no visible symptom unless you had the console open. The validator now checks every named import against the target module's actual exports.

### Layout

```
src/                     THE PACKAGE — nothing else ships
  background/            service worker, ES modules
    sw.js                top-level listener registration ONLY
    scheduler.js         the three invariants live here
    jobs.js              storage.session CRUD + write mutex
    monitor.js  rules.js  messaging.js  badge.js  alerts.js  permissions.js
  content/               single-file, import-free page scripts
  lib/                   pure, testable, shared by worker and pages
  popup/  options/  offscreen/  assets/  _locales/
scripts/                 validate, pack, icon generation
test/                    node --test, zero dependencies
store/                   screenshots and promo art — NEVER packed
```

---

## Verifying

The unit tests cover the bug-dense pure logic. Everything else needs a browser, and this is the matrix worth running before a release:

1. **The worker really dies.** Start a 60s job, then stop the worker in `chrome://serviceworker-internals`, wait 60s+, confirm the reload still fires. ⚠️ Close DevTools first — having it open on the worker prevents idle termination in several Chrome versions and masks exactly the bug class that broke v1.
2. **Nothing leaks.** Close a tab mid-job; `chrome.storage.session` has no orphan `job:*` and `chrome.alarms.getAll()` no orphan `arf:*`.
3. **Packed behaviour.** Sub-30s alarms are honoured unpacked and silently dropped packed. Keep an unlisted Web Store listing to install from — it's the only way to test this continuously.
4. **The nonce works.** Press F5 manually: the reload count must *not* move. Let the job fire: it must.
5. **Hard reload is real.** Network panel shows `200`, not `200 (from disk cache)`.
6. **Scope.** Navigate off-origin → pauses with "you navigated away". Navigate back → resumes by itself.
7. **Monitoring has no false positives.** Point it at a page with a live clock, cover the clock with the ignore-regex, and confirm zero alerts across many reloads. This is the acceptance test that matters.
8. **Offscreen audio.** Fire two alerts 200ms apart (must not throw "Only a single offscreen document"), then wait 40s past the 30s auto-close and fire again (recreate-and-retry path).

---

## Known limits

- **Sub-second intervals are not offered.** Chrome throttles timers in hidden tabs to about one per second, so anything faster would only hold while the tab is in front. Promising it would be dishonest.
- **`beforeunload` wins.** A page with unsaved form text shows Chrome's "Leave site?" dialog and no API can suppress it. Auto Refresh detects dirty forms and waits 15s instead of fighting it — and fails *open* if the page doesn't answer within 300ms, because an auto-refresher that has silently stopped refreshing is the worse failure.
- **Jobs don't survive a browser restart.** By design; use a site rule.
- **Very short intervals can get you rate-limited or blocked.** Random intervals help. Below 5 seconds, be careful.
- **Windows Focus Assist silently suppresses notifications.** Use the Test notification button in Settings to check.

---

## Contributing

Issues and pull requests welcome at [github.com/AndrewKaranja/AutoRefresh](https://github.com/AndrewKaranja/AutoRefresh). Please run `npm run build` before opening a PR.

## License

MIT — see [LICENSE](LICENSE).

If this saves you some time, you can [buy me a coffee](https://www.buymeacoffee.com/andrewkaranja).
