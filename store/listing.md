# Chrome Web Store submission

Everything the Developer Dashboard asks for, ready to paste. Keep this in sync
with `src/manifest.json` — reviewers cross-check the justifications against the
permissions actually declared, and a mismatch is a rejection.

Dashboard → your item → **Privacy practices**.

---

## 1. Single purpose

> Auto Refresh automatically reloads web pages that the user chooses, on an
> interval the user sets, and optionally alerts them when the content of a
> reloaded page changes.

## 2. Permission justifications

One field per permission. Each is well under the 1000-character limit.

### `alarms`

> Schedules the page reloads the user asked for, at intervals of 30 seconds or
> longer. Chrome shuts down a Manifest V3 service worker when it is idle, which
> cancels any setTimeout or setInterval it was holding, so chrome.alarms is the
> only timer that can reliably survive long enough to perform a scheduled
> reload. Alarms are used solely to drive the user's own refresh schedule.

### `tabs`

> Reads the URL and title of the specific tab the user chose to auto-refresh.
> The URL is needed to reload the correct tab, to show the user which tab is
> being refreshed, to detect when they have navigated away from the site they
> started refreshing so the extension can pause instead of reloading an
> unrelated page, and to match against auto-refresh rules the user created
> themselves. Tab URLs are stored only in memory on the user's own device and
> are never transmitted anywhere.

### `scripting`

> Injects the extension's refresh agent into pages where the user has
> explicitly enabled a feature that requires it. The agent provides three
> things that cannot be done from the service worker: timing for intervals
> shorter than 30 seconds (below the chrome.alarms minimum), restoring the
> user's scroll position after a reload, and reading the text of a
> user-selected page region to detect whether it changed. It is injected only
> on sites the user has granted access to, and only when one of those features
> is switched on.

### `notifications`

> Displays a desktop notification when a page the user chose to monitor has
> changed since its last reload — for example a stock level, a build status or
> a queue position. Notifications are opt-in per refresh job and are off unless
> the user enables change monitoring. They are also used for a "Test
> notification" button in settings, because Windows Focus Assist can suppress
> notifications silently and users need a way to check.

### `offscreen`

> Plays the alert sound when a monitored page changes. Manifest V3 service
> workers have no DOM and therefore cannot construct an Audio element, so an
> offscreen document with the AUDIO_PLAYBACK reason is the only supported way
> to play a sound. The offscreen document does nothing else: it receives a
> message naming a bundled sound file and plays it. It is created only when a
> sound is actually needed and Chrome closes it automatically afterwards.

### `storage`

> Stores the user's own settings on their device: refresh intervals, interval
> presets, per-site auto-refresh rules, sound and notification preferences,
> theme, and the state of currently running refresh jobs. Nothing stored here
> leaves the device. Site rules and preferences use chrome.storage.sync so they
> follow the user's own Chrome profile; that syncing is handled by the user's
> Google account, not by any server of ours.

### `activeTab`

> Lets the user click on a region of the page currently in front of them to
> choose what the extension should watch for changes. This is a one-time,
> user-initiated action started from the extension's popup, and it applies only
> to the tab the user invoked the extension on.

### Host permissions (`<all_urls>`, optional)

> Declared as optional_host_permissions and never granted at install. The
> extension requests access to a single site at a time, at runtime, and only
> when the user switches on a feature that must read that page: refresh
> intervals shorter than 30 seconds, restoring scroll position, or monitoring
> the page for changes. Basic refreshing requires no host access at all and is
> what the extension does by default. If the user declines, the extension
> continues to work in that basic mode. Page text is read locally only to
> compute a change hash; page content is never transmitted or stored beyond
> that hash and a short local snapshot used to describe what changed.

## 3. Remote code

Select **No, I am not using remote code.**

> All code is contained in the uploaded package. The extension loads no remote
> scripts, uses no eval or new Function, and makes no network requests.

## 4. Data usage

Tick **nothing** in the data-collection list, then confirm all three
certifications:

- [x] I do not sell or transfer user data to third parties, outside of approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

The extension collects no user data of any kind, so no category applies. Do not
tick "Website content" — that category is for data **collected**, meaning sent
off the device. Reading page text locally to compare it against the previous
load and then discarding it is not collection, and the privacy policy says so
explicitly.

## 5. Privacy policy URL

```
https://andrewkaranja.github.io/AutoRefresh/privacy.html
```

Requires GitHub Pages to be switched on — see `../README.md` under
"Publishing", or the steps below.

1. GitHub → repository **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `master`, folder: **`/docs`**, then **Save**
4. Wait for the first deploy, then open the URL above and confirm it loads
   before pasting it into the dashboard

`docs/.nojekyll` is present so the HTML is served exactly as written, with no
Jekyll build step to go wrong.

---

## Listing copy

**Name:** Auto Refresh

**Short description** (132 characters max — this is 112):

> Auto-reload any tab on your schedule. Hard refresh, random intervals, scroll memory and free page-change alerts.

**Category:** Workflow & Planning

**Detailed description:**

```
Reload any tab on your schedule — and find out when the page actually changed.

FEATURES
• Interval presets from 5 seconds to 1 hour, plus any custom interval up to 24 hours
• Random intervals — vary the timing on each reload so the pattern looks less automated
• Hard reload that genuinely bypasses the cache
• Re-open URL mode, which avoids the "Confirm Form Resubmission" dialog on POST result pages
• Scroll memory — come back to where you were, without the jump
• Page-change alerts: click to pick a region of the page, get a notification and a sound when it changes
• Ignore-regex to hide clocks, timestamps and rotating ads that would otherwise count as a change
• Stop after a set number of reloads, or at a deadline
• Site rules: "always refresh this site", which restarts jobs by itself after a browser restart
• Keyboard shortcuts, a live reload counter on the toolbar icon, and dark mode

PAGE-CHANGE ALERTS ARE FREE
Watching a page for changes, keyword alerts and sound notifications are paid features in the most-installed alternative. Here they are free, and they always will be.

IT PAUSES INSTEAD OF GUESSING
Navigate away from the site you were refreshing and Auto Refresh pauses with a one-click resume, rather than either stopping for good or — worse — starting to hammer whatever page you moved to.

INSTALLS WITH NO PERMISSION WARNINGS
Reloading a tab doesn't require permission to read it, so basic refreshing needs no site access at all. Auto Refresh asks for one site at a time, at the moment you turn on a feature that genuinely has to read the page.

NO DATA COLLECTION
Nothing is collected, transmitted or sold. No analytics, no telemetry, no remote code, no server. The extension is open source and MIT licensed: github.com/AndrewKaranja/AutoRefresh

KNOWN LIMITS, STATED UP FRONT
• Intervals below 1 second aren't offered — Chrome throttles timers in background tabs to about one per second, so faster would only work while the tab is in front.
• A page with unsaved text in a form triggers Chrome's "Leave site?" dialog. Auto Refresh detects this and waits rather than fighting it.
• Very short intervals can get you rate-limited by a site. Random intervals help.
```

---

## Pre-submission checklist

- [ ] `npm run build` passes (validate + tests + pack)
- [ ] Loaded the freshly built `dist/auto-refresh-<version>.zip` and smoke-tested
      — **especially the packed-only behaviour**, since sub-30s alarms are
      honoured unpacked and silently dropped once packed
- [ ] Version bumped **before** building. The Web Store refuses an upload whose
      version already exists, so a re-upload always needs a new number — you
      cannot patch a published version in place
- [ ] GitHub Pages is live and the privacy URL actually loads
- [ ] Screenshots in `store/` are current (1280×800 or 640×400)
- [ ] Version bumped in `src/manifest.json` **and** `package.json`
- [ ] `CHANGELOG.md` updated
- [ ] Staged rollout percentage chosen deliberately. A cautious 10% is right
      for a feature release — but a release that *fixes* a fault in the
      currently-published build should go out at 100%, since holding it back
      leaves most users on the broken version
