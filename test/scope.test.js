import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isRestrictedUrl,
  originOf,
  originPattern,
  patternToRegExp,
  scopeMatches,
  stripHash,
} from '../src/lib/scope.js';

const origin = (value) => ({ mode: 'origin', value });

test('origin scope survives the navigations that should not stop a job', () => {
  const s = origin('https://example.com');

  // A trailing-slash redirect. Killing the job here is the bug that makes
  // rivals stop on dashboards that normalise their URLs.
  assert.ok(scopeMatches(s, 'https://example.com/x'));
  assert.ok(scopeMatches(s, 'https://example.com/x/'));

  // An SPA rewriting the query string.
  assert.ok(scopeMatches(s, 'https://example.com/list?page=2'));

  // A fragment change never hits the server at all.
  assert.ok(scopeMatches(s, 'https://example.com/list#section-4'));
});

test('origin scope stops a job that wandered somewhere else', () => {
  const s = origin('https://example.com');

  // The behaviour that matters most: navigating to your inbox must NOT mean
  // the extension starts hammering your inbox.
  assert.equal(scopeMatches(s, 'https://mail.google.com/'), false);

  // A subdomain is a different origin.
  assert.equal(scopeMatches(s, 'https://app.example.com/'), false);

  // So is a scheme change.
  assert.equal(scopeMatches(s, 'http://example.com/'), false);

  // And a port.
  assert.equal(scopeMatches(s, 'https://example.com:8443/'), false);
});

test('exact scope ignores only the fragment', () => {
  const s = { mode: 'exact', value: 'https://example.com/a?b=1' };
  assert.ok(scopeMatches(s, 'https://example.com/a?b=1'));
  assert.ok(scopeMatches(s, 'https://example.com/a?b=1#top'));
  assert.equal(scopeMatches(s, 'https://example.com/a?b=2'), false);
  assert.equal(scopeMatches(s, 'https://example.com/a'), false);
});

test('prefix and any scopes', () => {
  assert.ok(scopeMatches({ mode: 'prefix', value: 'https://example.com/docs' }, 'https://example.com/docs/x'));
  assert.equal(scopeMatches({ mode: 'prefix', value: 'https://example.com/docs' }, 'https://example.com/d'), false);

  assert.ok(scopeMatches({ mode: 'any', value: '' }, 'https://anything.example/'));
  assert.ok(scopeMatches({ mode: 'any', value: '' }, ''), 'any matches even an empty url');
});

test('malformed input never throws', () => {
  assert.equal(scopeMatches(origin('https://example.com'), 'not a url'), false);
  assert.equal(scopeMatches(origin('https://example.com'), ''), false);
  // @ts-expect-error -- deliberately passing null; a job read back from
  // storage during an upgrade could be missing its scope entirely.
  assert.equal(scopeMatches(null, 'https://example.com'), false);
  assert.equal(originOf('garbage'), null);
});

test('stripHash', () => {
  assert.equal(stripHash('https://a.com/b#c'), 'https://a.com/b');
  assert.equal(stripHash('https://a.com/b'), 'https://a.com/b');
  assert.equal(stripHash('#'), '');
});

test('restricted urls are the ones no extension can drive', () => {
  for (const url of [
    'chrome://extensions',
    'chrome-extension://abc/page.html',
    'about:blank',
    'devtools://devtools/bundled/x.html',
    'view-source:https://example.com',
    'file:///C:/tmp/x.html',
    'data:text/html,hi',
    '',
  ]) {
    assert.ok(isRestrictedUrl(url), `${url} should be restricted`);
  }

  assert.equal(isRestrictedUrl('https://example.com'), false);
  assert.equal(isRestrictedUrl('http://localhost:3000/'), false);
});

test('originPattern produces a requestable host permission', () => {
  assert.equal(originPattern('https://example.com/a/b?c=1'), 'https://example.com/*');
  assert.equal(originPattern('http://localhost:3000/x'), 'http://localhost/*');
  assert.equal(originPattern('chrome://extensions'), null, 'not requestable');
  assert.equal(originPattern('garbage'), null);
});

test('match patterns follow Chrome grammar', () => {
  const re = patternToRegExp('https://*.example.com/dashboard*', 'matchPattern');
  assert.ok(re.test('https://example.com/dashboard'));
  assert.ok(re.test('https://app.example.com/dashboard/x'));
  assert.equal(re.test('https://example.com/other'), false);
  assert.equal(re.test('https://notexample.com/dashboard'), false);

  const any = patternToRegExp('https://example.com/*', 'matchPattern');
  assert.ok(any.test('https://example.com/'));
  assert.ok(any.test('https://example.com/deep/path'));
  assert.equal(any.test('https://other.com/'), false);

  assert.throws(() => patternToRegExp('not-a-pattern', 'matchPattern'), SyntaxError);
});

test('a dot in a pattern is literal, not a wildcard', () => {
  // Without escaping, "example.com" would also match "examplexcom".
  const re = patternToRegExp('https://example.com/*', 'matchPattern');
  assert.equal(re.test('https://examplexcom/'), false);
});

test('glob patterns', () => {
  const re = patternToRegExp('https://example.com/*/edit', 'glob');
  assert.ok(re.test('https://example.com/123/edit'));
  assert.equal(re.test('https://example.com/123/view'), false);
});

test('opaque origins never match each other', () => {
  // new URL('about:blank').origin is the STRING "null", not a throw. Treating
  // that as a real origin would put every opaque-origin URL in the same scope.
  assert.equal(originOf('about:blank'), null);
  assert.equal(originOf('data:text/html,hi'), null);
  assert.equal(scopeMatches({ mode: 'origin', value: 'null' }, 'about:blank'), false);
  assert.equal(scopeMatches({ mode: 'origin', value: '' }, 'data:text/html,hi'), false);
});
