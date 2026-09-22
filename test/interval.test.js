import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  alarmDelayMs,
  clamp,
  deriveMode,
  drawInterval,
  lowerBound,
  stopConditionMet,
  toAlarmMinutes,
} from '../src/lib/interval.js';
import { ALARM_MIN_MS, MIN_INTERVAL_MS } from '../src/lib/constants.js';

const fixed = (n) => ({ intervalMs: n, randomize: { enabled: false, minMs: n, maxMs: n } });
const range = (lo, hi) => ({ intervalMs: lo, randomize: { enabled: true, minMs: lo, maxMs: hi } });

test('mode is derived from the lower bound, not the current draw', () => {
  assert.equal(deriveMode(fixed(60_000)), 'alarm');
  assert.equal(deriveMode(fixed(30_000)), 'alarm', '30s exactly is reachable by alarms');
  assert.equal(deriveMode(fixed(29_999)), 'page');
  assert.equal(deriveMode(fixed(5_000)), 'page');
});

test('a randomized range spanning the threshold stays in one mode for its whole life', () => {
  // This is Invariant B. If mode were derived from each draw, a 20-90s job
  // would flip between the page timer and the alarm timer cycle to cycle.
  const job = range(20_000, 90_000);
  assert.equal(lowerBound(job), 20_000);
  assert.equal(deriveMode(job), 'page');

  for (let i = 0; i < 200; i++) {
    assert.equal(deriveMode(job), 'page', 'mode must not depend on the draw');
  }
});

test('reversed randomize bounds are tolerated', () => {
  const job = range(90_000, 20_000);
  assert.equal(lowerBound(job), 20_000);
  assert.equal(drawInterval(job, () => 0), 20_000);
  assert.equal(drawInterval(job, () => 1), 90_000);
});

test('draws land inside the requested range', () => {
  const job = range(10_000, 40_000);
  for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
    const ms = drawInterval(job, () => r);
    assert.ok(ms >= 10_000 && ms <= 40_000, `${ms} outside [10000, 40000]`);
  }
});

test('a non-randomized job always draws its interval', () => {
  assert.equal(drawInterval(fixed(45_000), () => 0.5), 45_000);
});

test('alarm mode uses the interval; page mode pushes the watchdog well past it', () => {
  assert.equal(alarmDelayMs('alarm', 60_000), 60_000);
  assert.equal(alarmDelayMs('alarm', 10_000), ALARM_MIN_MS, 'never below the floor');

  // The watchdog must not beat a healthy page timer to the punch.
  const eff = 5_000;
  assert.ok(alarmDelayMs('page', eff) > eff * 2, 'watchdog fires well after the page timer');
});

test('toAlarmMinutes refuses delays Chrome would silently ignore when packed', () => {
  // The whole point: unpacked Chrome honours sub-30s alarms, packed Chrome
  // does not. Failing loudly in development is the only way to catch it.
  assert.throws(() => toAlarmMinutes(29_999), RangeError);
  assert.throws(() => toAlarmMinutes(1_000), RangeError);
  assert.throws(() => toAlarmMinutes(0), RangeError);
  assert.throws(() => toAlarmMinutes(NaN), RangeError);

  assert.equal(toAlarmMinutes(30_000), 0.5);
  assert.equal(toAlarmMinutes(60_000), 1);
});

test('every alarm delay the scheduler can produce is legal', () => {
  // Guards the pairing of alarmDelayMs and toAlarmMinutes: if either changes
  // so they disagree, this catches it before Chrome silently drops the alarm.
  /** @type {('alarm'|'page')[]} */
  const modes = ['alarm', 'page'];
  for (const eff of [1_000, 5_000, 29_999, 30_000, 60_000, 3_600_000]) {
    for (const mode of modes) {
      assert.doesNotThrow(() => toAlarmMinutes(alarmDelayMs(mode, eff)), `${mode} @ ${eff}ms`);
    }
  }
});

test('clamp keeps intervals inside the supported window', () => {
  assert.equal(clamp(0), MIN_INTERVAL_MS);
  assert.equal(clamp(-5), MIN_INTERVAL_MS);
  assert.equal(clamp(NaN), 30_000, 'a garbage value falls back to the default');
  assert.equal(clamp(500), MIN_INTERVAL_MS, 'sub-second is not achievable in a background tab');
  assert.equal(clamp(999_999_999), 24 * 60 * 60 * 1000);
});

test('stop conditions', () => {
  assert.equal(stopConditionMet({ reloadCount: 5, maxReloads: 0, stopAt: null }), null);
  assert.equal(stopConditionMet({ reloadCount: 3, maxReloads: 3, stopAt: null }), 'max-reloads');
  assert.equal(stopConditionMet({ reloadCount: 2, maxReloads: 3, stopAt: null }), null);

  const now = 1_000_000;
  assert.equal(stopConditionMet({ reloadCount: 0, maxReloads: 0, stopAt: now - 1 }, now), 'deadline');
  assert.equal(stopConditionMet({ reloadCount: 0, maxReloads: 0, stopAt: now + 1 }, now), null);
});

test('maxReloads of N stops at exactly N', () => {
  const job = { reloadCount: 0, maxReloads: 3, stopAt: null };
  let fired = 0;
  while (!stopConditionMet(job) && fired < 100) {
    fired++;
    job.reloadCount++;
  }
  assert.equal(fired, 3);
});

test('an alarm-mode job re-arms at its own interval, not the page watchdog', () => {
  // Regression: fire() re-armed every job with the page-mode watchdog formula
  // (2x + 30s) regardless of mode. A 30s refresh therefore ran at 90s whenever
  // the post-reload handshake was late or never arrived — which reads to a
  // user as "it sometimes just doesn't refresh".
  const eff = 30_000;
  assert.equal(alarmDelayMs('alarm', eff), eff);
  assert.notEqual(alarmDelayMs('page', eff), eff);

  for (const ms of [30_000, 60_000, 300_000]) {
    assert.equal(alarmDelayMs('alarm', ms), ms, 'alarm mode must keep its cadence');
  }
});

test('the page watchdog always sits behind the page timer', () => {
  // If the watchdog could fire first it would double-reload every cycle.
  for (const eff of [1_000, 5_000, 15_000, 29_999]) {
    assert.ok(
      alarmDelayMs('page', eff) > eff,
      `watchdog for ${eff}ms would beat the page timer`,
    );
  }
});
