import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampInterval, defaultMonitor, makeJob, mergeJob, publicView } from '../src/lib/schema.js';
import { MIN_INTERVAL_MS } from '../src/lib/constants.js';

const tab = {
  id: 7,
  windowId: 1,
  url: 'https://example.com/dash?a=1',
  title: 'Dashboard',
  favIconUrl: 'https://example.com/f.ico',
};

test('a new job gets a complete, usable shape', () => {
  const job = makeJob({ tab, intervalMs: 45_000 });

  assert.equal(job.tabId, 7);
  assert.equal(job.origin, 'https://example.com');
  assert.equal(job.intervalMs, 45_000);
  assert.equal(job.status, 'running');
  assert.deepEqual(job.scope, { mode: 'origin', value: 'https://example.com' });
  assert.equal(job.pending, null);
  assert.equal(job.reloadCount, 0);
  assert.match(job.id, /^j_/);
});

test('a job on an unparseable url still gets built', () => {
  const job = makeJob({ tab: { ...tab, url: 'about:blank' }, intervalMs: 30_000 });
  assert.equal(job.origin, '');
  assert.equal(job.scope.value, '');
});

test('partial overrides do not blow away nested defaults', () => {
  // This is how the popup actually calls it: monitor arrives with four keys.
  const job = makeJob({
    tab,
    intervalMs: 10_000,
    overrides: { monitor: { enabled: true, selector: '#price' } },
  });

  assert.equal(job.monitor.enabled, true);
  assert.equal(job.monitor.selector, '#price');
  assert.equal(job.monitor.settleMs, defaultMonitor().settleMs, 'default survived');
  assert.equal(job.monitor.changeCount, 0, 'default survived');
  assert.deepEqual(job.monitor.onMatch, defaultMonitor().onMatch, 'defaults survived');
});

test('mergeJob preserves monitor bookkeeping across a settings tweak', () => {
  // The bug this guards: a shallow assign would drop lastHash and changeCount,
  // so the next sample would look like a first sample and no change would ever
  // be reported again.
  const job = makeJob({ tab, intervalMs: 30_000, overrides: { monitor: { enabled: true, selector: '#p' } } });
  job.monitor.lastHash = 'abc123';
  job.monitor.changeCount = 4;
  job.reloadCount = 12;

  const merged = mergeJob(job, {
    intervalMs: 60_000,
    monitor: { enabled: true, selector: '#p', ignoreRegex: null, onMatch: { sound: false } },
  });

  assert.equal(merged.intervalMs, 60_000);
  assert.equal(merged.monitor.lastHash, 'abc123', 'fingerprint kept');
  assert.equal(merged.monitor.changeCount, 4, 'history kept');
  assert.equal(merged.reloadCount, 12, 'untouched fields kept');
  assert.equal(merged.monitor.onMatch.sound, false, 'the edit applied');
  assert.equal(merged.monitor.onMatch.notify, true, 'sibling flags kept');
});

test('changing the watched region invalidates the fingerprint', () => {
  // Comparing a new region against the old region's hash would report a bogus
  // change on the very next load.
  const job = makeJob({ tab, intervalMs: 30_000, overrides: { monitor: { enabled: true, selector: '#a' } } });
  job.monitor.lastHash = 'abc123';

  assert.equal(mergeJob(job, { monitor: { selector: '#b' } }).monitor.lastHash, null);
  assert.equal(mergeJob(job, { monitor: { ignoreRegex: '\\d+' } }).monitor.lastHash, null);

  // ...but an unrelated edit must not reset it, or every tweak costs a cycle.
  assert.equal(mergeJob(job, { monitor: { onMatch: { stop: true } } }).monitor.lastHash, 'abc123');
  assert.equal(mergeJob(job, { intervalMs: 5_000 }).monitor.lastHash, 'abc123');
});

test('mergeJob deep-merges randomize, scrollRestore and scope', () => {
  const job = makeJob({ tab, intervalMs: 30_000 });
  const merged = mergeJob(job, { randomize: { enabled: true } });

  assert.equal(merged.randomize.enabled, true);
  assert.equal(typeof merged.randomize.minMs, 'number', 'bounds survived');
  assert.equal(typeof merged.randomize.maxMs, 'number');

  assert.equal(mergeJob(job, { scrollRestore: { enabled: false } }).scrollRestore.selector, null);
  assert.equal(mergeJob(job, { scope: { mode: 'any' } }).scope.value, 'https://example.com');
});

test('publicView withholds the reload nonce from the UI', () => {
  const job = makeJob({ tab, intervalMs: 30_000 });
  job.pending = { nonce: 'secret', at: Date.now(), method: 'soft' };

  const view = publicView(job);
  assert.equal('pending' in view, false);
  assert.equal('consecutiveStalls' in view, false);
  assert.equal(view.tabId, 7);
  assert.equal(view.intervalMs, 30_000);
});

test('clampInterval is applied on construction', () => {
  assert.equal(makeJob({ tab, intervalMs: 10 }).intervalMs, MIN_INTERVAL_MS);
  assert.equal(clampInterval(-1), MIN_INTERVAL_MS);
});
