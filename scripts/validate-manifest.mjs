#!/usr/bin/env node
/**
 * Pre-flight checks. Each one targets a bug this extension has actually
 * shipped, and each has been verified by reintroducing that bug.
 *
 *   1. EXACT-CASE path existence. v1.0.2 referenced "icon.png" in its manifest
 *      while the file on disk was "icon.PNG". Windows and macOS filesystems
 *      are case-insensitive, so it worked perfectly when loaded unpacked --
 *      and the published CRX stores the literal name, where lookup IS
 *      case-sensitive. The result was a published extension with no icons.
 *      A plain fs.existsSync() would not have caught it; this reads the
 *      directory and compares names byte for byte.
 *
 *   2. MIRROR DRIFT. content/agent.js and content/picker.js cannot import
 *      lib/, because content scripts are not ES modules. They duplicate a few
 *      values, tagged `// mirror:<name>`. This resolves each tag against the
 *      real source and fails if they have diverged -- cheaper than adding a
 *      bundler for two files.
 *
 *   3. UNRESOLVED IMPORTS. v1.0.2's popup called a `restoreRefreshInterval()`
 *      that was defined nowhere. Chrome only reports that at runtime, where it
 *      aborts the rest of the handler -- so the Start button was simply never
 *      wired up, with no visible error unless you had the console open.
 *
 * Run: node scripts/validate-manifest.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const warnings = [];

// ---------------------------------------------------------------------------
// 1. Every manifest-referenced path exists, with exactly the case written.
// ---------------------------------------------------------------------------

const manifestPath = join(SRC, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('FAIL: src/manifest.json not found');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

/**
 * Walks the manifest for anything that looks like a packaged file path.
 * @param {unknown} node
 * @param {string} path
 * @returns {string[]}
 */
function collectPaths(node, path = '') {
  /** @type {string[]} */
  const found = [];
  if (typeof node === 'string') {
    if (/\.(js|css|html|png|jpg|jpeg|svg|mp3|ogg|wav|json)$/i.test(node) && !node.includes('://')) {
      found.push(node);
    }
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => found.push(...collectPaths(v, `${path}[${i}]`)));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) found.push(...collectPaths(v, `${path}.${k}`));
  }
  return found;
}

/**
 * Case-sensitive existence check, performed one path segment at a time
 * against the real directory listing.
 *
 * @param {string} relative
 * @returns {string|null} the actual on-disk spelling if it differs, else null
 */
function caseSensitiveResolve(relative) {
  const parts = relative.replace(/^\/+/, '').split(posix.sep).filter(Boolean);
  let dir = SRC;
  const rebuilt = [];

  for (const part of parts) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return `<missing directory ${rebuilt.join('/')}>`;
    }

    if (entries.includes(part)) {
      rebuilt.push(part);
      dir = join(dir, part);
      continue;
    }

    const insensitive = entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (insensitive) {
      rebuilt.push(insensitive);
      return rebuilt.join('/'); // found, but the case is wrong
    }
    return '<missing>';
  }

  return null; // exact match all the way down
}

const manifestPaths = [...new Set(collectPaths(manifest))];
for (const p of manifestPaths) {
  const actual = caseSensitiveResolve(p);
  if (actual === '<missing>' || actual?.startsWith('<missing')) {
    errors.push(`manifest references "${p}" but no such file exists in src/`);
  } else if (actual !== null) {
    errors.push(
      `manifest references "${p}" but the file on disk is "${actual}". ` +
        'This works unpacked on Windows/macOS and breaks once packed.',
    );
  }
}

// Same check for paths referenced from HTML and from the background modules.
const htmlFiles = ['popup/popup.html', 'options/options.html', 'offscreen/audio.html'];
for (const rel of htmlFiles) {
  const file = join(SRC, rel);
  if (!existsSync(file)) {
    errors.push(`missing ${rel}`);
    continue;
  }
  const html = readFileSync(file, 'utf8');
  const base = posix.dirname(rel);
  for (const m of html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) {
    const ref = m[1];
    if (/^(https?:|data:|mailto:|#)/.test(ref)) continue;
    const joined = posix.normalize(posix.join(base, ref));
    const actual = caseSensitiveResolve(joined);
    if (actual === '<missing>' || actual?.startsWith('<missing')) {
      errors.push(`${rel} references "${ref}" which does not exist (resolved: ${joined})`);
    } else if (actual !== null) {
      errors.push(`${rel} references "${ref}" but the file on disk is "${actual}" (case mismatch)`);
    }
  }
}

// Files the code injects by name rather than through the manifest.
for (const rel of ['content/agent.js', 'content/picker.js', 'content/picker.css']) {
  const actual = caseSensitiveResolve(rel);
  if (actual !== null) errors.push(`injected file "${rel}" missing or miscased (found: ${actual})`);
}

// ---------------------------------------------------------------------------
// 2. Mirrored constants still agree with lib/.
// ---------------------------------------------------------------------------

const constantsSrc = readFileSync(join(SRC, 'lib/constants.js'), 'utf8');
const selectorSrc = readFileSync(join(SRC, 'lib/selector.js'), 'utf8');

/**
 * Pulls `export const NAME = <literal>;` out of a module.
 * @param {string} source
 * @param {string} name
 * @returns {string|null}
 */
function exportedConst(source, name) {
  const re = new RegExp(`export const ${name}\\s*=\\s*([^;]+);`);
  const m = re.exec(source);
  return m ? normalise(m[1]) : null;
}

/**
 * Pulls one key out of the exported MSG object.
 * @param {string} key
 * @returns {string|null}
 */
function msgValue(key) {
  const block = /export const MSG = \{([\s\S]*?)\n\};/.exec(constantsSrc);
  if (!block) return null;
  const m = new RegExp(`\\b${key}:\\s*'([^']+)'`).exec(block[1]);
  return m ? m[1] : null;
}

/**
 * Pulls a named function body out of a module, for comparing heuristics.
 * @param {string} source
 * @param {string} name
 * @returns {string|null}
 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return normalise(source.slice(open + 1, i));
    }
  }
  return null;
}

/**
 * Strips comments and collapses whitespace so two spellings of the same code
 * compare equal. Numeric separators are removed too: lib/ writes `200_000`
 * for readability while the mirrors write `200000`, and those are the same
 * number -- flagging them would train you to ignore the check.
 *
 * @param {string} s
 * @returns {string}
 */
function normalise(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\d[\d_]*\d/g, (n) => n.replace(/_/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} file
 * @returns {{name: string, value: string, line: number}[]}
 */
function mirrorTags(file) {
  const source = readFileSync(join(SRC, file), 'utf8');
  const lines = source.split('\n');
  /** @type {{name: string, value: string, line: number}[]} */
  const tags = [];

  lines.forEach((line, i) => {
    const m = /\/\/\s*mirror:([A-Za-z0-9_.]+)\s*$/.exec(line);
    if (!m) return;
    const name = m[1];

    // `var X = <literal>; // mirror:NAME`
    const assign = /^\s*(?:var|const|let)\s+\w+\s*=\s*([^;]+);/.exec(line);
    if (assign) {
      tags.push({ name, value: normalise(assign[1]), line: i + 1 });
      return;
    }

    // A tag on its own line refers to the declaration that follows.
    const rest = lines.slice(i + 1).join('\n');
    const arr = /^\s*(?:var|const|let)\s+\w+\s*=\s*(\[[\s\S]*?\]);/.exec(rest);
    if (arr) {
      tags.push({ name, value: normalise(arr[1]), line: i + 1 });
      return;
    }
    const fn = /^\s*function\s+(\w+)\s*\(/.exec(rest);
    if (fn) {
      tags.push({ name, value: functionBody(rest, fn[1]) ?? '<unparsed>', line: i + 1 });
      return;
    }

    warnings.push(`${file}:${i + 1} mirror tag "${name}" is not attached to a declaration`);
  });

  return tags;
}

/**
 * @param {string} name
 * @returns {string|null}
 */
function truthFor(name) {
  if (name.startsWith('MSG.')) {
    const v = msgValue(name.slice(4));
    return v === null ? null : `'${v}'`;
  }
  return (
    exportedConst(constantsSrc, name) ??
    exportedConst(selectorSrc, name) ??
    functionBody(selectorSrc, name)
  );
}

for (const file of ['content/agent.js', 'content/picker.js']) {
  for (const tag of mirrorTags(file)) {
    const truth = truthFor(tag.name);
    if (truth === null) {
      errors.push(`${file}:${tag.line} mirrors "${tag.name}", which no longer exists in lib/`);
    } else if (truth !== tag.value) {
      errors.push(
        `${file}:${tag.line} mirror drift for "${tag.name}"\n` +
          `    lib/ has:   ${truth}\n` +
          `    mirror has: ${tag.value}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Every named import resolves to a real export.
//
// This is the check that most directly targets what went wrong in v1.0.2,
// where the popup called a `restoreRefreshInterval()` that was defined
// nowhere. Chrome only surfaces that at runtime, at which point it aborts the
// rest of the handler and the UI silently never finishes wiring itself up.
// ---------------------------------------------------------------------------

/**
 * @param {string} dir
 * @param {string} prefix
 * @returns {string[]}
 */
function jsModules(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...jsModules(abs, rel));
    else if (entry.endsWith('.js')) out.push(rel);
  }
  return out;
}

// Classic scripts, not modules: they legitimately have no exports.
const CLASSIC = new Set([
  'content/agent.js',
  'content/picker.js',
  'offscreen/audio.js',
  'lib/theme.js',
]);

/** @type {Map<string, Set<string>>} */
const exportsByFile = new Map();

for (const rel of jsModules(SRC)) {
  if (CLASSIC.has(rel)) continue;
  const source = readFileSync(join(SRC, rel), 'utf8');
  /** @type {Set<string>} */
  const names = new Set();

  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s+(?:const|let|var|class)\s+(\w+)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/^export\s+default\b/m.test(source)) names.add('default');

  exportsByFile.set(rel, names);
}

for (const rel of exportsByFile.keys()) {
  const source = readFileSync(join(SRC, rel), 'utf8');
  const dir = posix.dirname(rel);

  for (const m of source.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)';/gm)) {
    const [, clause, spec] = m;
    if (!spec.startsWith('.')) continue;

    const target = posix.normalize(posix.join(dir, spec));
    if (!exportsByFile.has(target)) {
      errors.push(`${rel} imports from "${spec}", which is not a module in src/`);
      continue;
    }

    // Namespace imports (`import * as x`) pull everything; nothing to check.
    if (/^\*\s+as\s+\w+$/.test(clause.trim())) continue;

    const braces = /\{([\s\S]*)\}/.exec(clause);
    if (!braces) continue;

    const available = /** @type {Set<string>} */ (exportsByFile.get(target));
    for (const part of braces[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (!name) continue;
      if (!available.has(name)) {
        errors.push(`${rel} imports { ${name} } from "${spec}", which does not export it`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Cheap manifest sanity checks.
// ---------------------------------------------------------------------------

if (manifest.manifest_version !== 3) errors.push('manifest_version must be 3');
if (manifest.background && !manifest.background.type) {
  errors.push('background.type must be "module" — sw.js uses ES imports');
}
if (manifest.content_scripts) {
  errors.push(
    'a static content_scripts block re-introduces an implicit host permission ' +
      'and the "read and change all your data" install warning; register dynamically instead',
  );
}
if (manifest.permissions?.includes('webNavigation')) {
  errors.push('webNavigation is declared but unused — Web Store reviewers flag this');
}
for (const required of ['storage', 'alarms', 'tabs', 'scripting']) {
  if (!manifest.permissions?.includes(required)) errors.push(`missing required permission: ${required}`);
}
if (!manifest.default_locale) errors.push('default_locale is required when using __MSG_ placeholders');

// Every __MSG_key__ used in the manifest must exist in the default locale.
const localePath = join(SRC, '_locales', manifest.default_locale || 'en', 'messages.json');
if (!existsSync(localePath)) {
  errors.push(`missing ${localePath.replace(ROOT, '.')}`);
} else {
  const messages = JSON.parse(readFileSync(localePath, 'utf8'));
  for (const m of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) {
    if (!messages[m[1]]) errors.push(`manifest uses __MSG_${m[1]}__ but the locale has no such key`);
  }
}

// ---------------------------------------------------------------------------

for (const w of warnings) console.warn(`warn: ${w}`);

if (errors.length > 0) {
  console.error(`\n${errors.length} problem${errors.length === 1 ? '' : 's'} found:\n`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ manifest, ${manifestPaths.length} asset paths, mirrors and locale all check out`);
