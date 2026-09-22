import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  badgeText,
  formatBadgeCount,
  formatCountdown,
  formatInterval,
  formatTimeAgo,
  prettyUrl,
} from '../src/lib/format.js';

test('intervals read the way a preset chip needs them to', () => {
  assert.equal(formatInterval(5_000), '5s');
  assert.equal(formatInterval(30_000), '30s');
  assert.equal(formatInterval(60_000), '1m');
  assert.equal(formatInterval(90_000), '1m 30s');
  assert.equal(formatInterval(300_000), '5m');
  assert.equal(formatInterval(3_600_000), '1h');
  assert.equal(formatInterval(5_400_000), '1h 30m');
  assert.equal(formatInterval(0), '—');
  assert.equal(formatInterval(NaN), '—');
});

test('countdowns never show negative time when an alarm runs late', () => {
  assert.equal(formatCountdown(23_000), '0:23');
  assert.equal(formatCountdown(725_000), '12:05');
  assert.equal(formatCountdown(3_764_000), '1:02:44');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-5_000), '0:00', 'clamped, not negative');
});

test('badge text stays within the four characters Chrome will show', () => {
  assert.equal(formatBadgeCount(0), '');
  assert.equal(formatBadgeCount(7), '7');
  assert.equal(formatBadgeCount(999), '999');
  assert.equal(formatBadgeCount(1_000), '1k');
  assert.equal(formatBadgeCount(12_400), '12k');
  assert.equal(formatBadgeCount(1_000_000), '99k+');

  for (const n of [0, 1, 999, 1000, 99_999, 100_000, 5_000_000]) {
    assert.ok(formatBadgeCount(n).length <= 4, `"${formatBadgeCount(n)}" too long`);
  }
});

test('prettyUrl drops the scheme and truncates', () => {
  assert.equal(prettyUrl('https://example.com/'), 'example.com');
  assert.equal(prettyUrl('https://example.com/a/b'), 'example.com/a/b');
  assert.ok(prettyUrl(`https://example.com/${'x'.repeat(200)}`, 30).length <= 30);
  assert.equal(prettyUrl('not a url', 30), 'not a url');
});

test('formatTimeAgo', () => {
  const now = Date.now();
  assert.equal(formatTimeAgo(null), 'never');
  assert.equal(formatTimeAgo(now - 5_000), 'just now');
  assert.equal(formatTimeAgo(now - 300_000), '5m ago');
  assert.equal(formatTimeAgo(now - 7_200_000), '2h ago');
  assert.equal(formatTimeAgo(now - 3 * 86_400_000), '3d ago');
});

test('a running job ALWAYS has a visible badge', () => {
  // Regression: formatBadgeCount returns '' for zero, and passing that to
  // setBadgeText cleared the badge — so a freshly started job looked exactly
  // like a stopped one. "Is it running?" must never be unanswerable.
  assert.equal(badgeText({ running: true, reloadCount: 0 }), '0');
  assert.equal(badgeText({ running: true, reloadCount: 1 }), '1');
  assert.equal(badgeText({ running: true, reloadCount: 4200 }), '4k');

  for (const reloadCount of [0, 1, 999, 1000, 250_000]) {
    const text = badgeText({ running: true, reloadCount });
    assert.notEqual(text, '', `running with ${reloadCount} reloads showed no badge`);
    assert.ok(text.length <= 4);
  }
});

test('badge distinguishes waiting, alerted and stopped from plain running', () => {
  assert.equal(badgeText({ running: true, waiting: true, reloadCount: 7 }), '…');
  assert.equal(badgeText({ running: true, alerted: true, reloadCount: 7 }), '!');
  assert.equal(badgeText({ running: false, reloadCount: 7 }), '❚❚');
  // Alert wins over waiting: a detected change is the more urgent fact.
  assert.equal(badgeText({ running: true, alerted: true, waiting: true }), '!');
});
