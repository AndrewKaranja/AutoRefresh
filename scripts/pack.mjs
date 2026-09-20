#!/usr/bin/env node
/**
 * Builds dist/auto-refresh-<version>.zip for the Chrome Web Store.
 *
 * TWO DELIBERATE CHOICES:
 *
 * 1. ALLOWLIST, NEVER DENYLIST. The package is built from an explicit list of
 *    directories and extensions. With a denylist, every new file added to the
 *    repo is included by default and someone has to remember to exclude it --
 *    which is how v1 ended up shipping 600KB of Web Store screenshots inside
 *    the extension. Here, store art and node_modules cannot leak in even if
 *    someone moves them into src/.
 *
 * 2. NO DEPENDENCY. The zip is written with node's own zlib, so `npm install`
 *    is not a prerequisite for cutting a release.
 *
 * Run: node scripts/pack.mjs
 */

import { deflateRawSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

/** Directories whose contents ship, and the extensions allowed within each. */
const ALLOW = [
  { dir: '.', exts: ['.json'], shallow: true }, // manifest.json only
  { dir: 'background', exts: ['.js'] },
  { dir: 'content', exts: ['.js', '.css'] },
  { dir: 'lib', exts: ['.js', '.css'] },
  { dir: 'offscreen', exts: ['.js', '.html'] },
  { dir: 'popup', exts: ['.js', '.css', '.html'] },
  { dir: 'options', exts: ['.js', '.css', '.html'] },
  { dir: 'assets', exts: ['.png', '.mp3', '.ogg', '.wav', '.svg'] },
  { dir: '_locales', exts: ['.json'] },
];

/**
 * @param {string} dir absolute
 * @param {string[]} exts
 * @param {boolean} shallow
 * @param {string} prefix relative
 * @returns {string[]} relative paths
 */
function walk(dir, exts, shallow, prefix) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const st = statSync(abs);

    if (st.isDirectory()) {
      if (!shallow) out.push(...walk(abs, exts, false, rel));
      continue;
    }
    if (exts.some((e) => entry.toLowerCase().endsWith(e))) out.push(rel);
  }
  return out;
}

/** @type {string[]} */
const files = [];
for (const rule of ALLOW) {
  const abs = rule.dir === '.' ? SRC : join(SRC, rule.dir);
  const prefix = rule.dir === '.' ? '' : rule.dir;
  try {
    files.push(...walk(abs, rule.exts, Boolean(rule.shallow), prefix));
  } catch {
    // An optional directory that does not exist yet is not an error.
  }
}

if (!files.includes('manifest.json')) {
  console.error('FAIL: manifest.json is not in the package');
  process.exit(1);
}

// --- minimal zip writer ------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** @param {Buffer} buf @returns {number} */
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * MS-DOS date/time. Fixed to a constant timestamp so an unchanged source tree
 * produces a byte-identical zip -- handy when checking what actually changed
 * between two uploads.
 */
const DOS_TIME = 0;
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1;

/** @type {Buffer[]} */
const localParts = [];
/** @type {Buffer[]} */
const centralParts = [];
let offset = 0;
let rawTotal = 0;

for (const rel of files) {
  const data = readFileSync(join(SRC, rel));
  const name = Buffer.from(rel, 'utf8');
  const crc = crc32(data);
  const deflated = deflateRawSync(data, { level: 9 });
  // Fall back to stored if deflate made it bigger (tiny files, already-
  // compressed PNGs).
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;

  rawTotal += data.length;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, name, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);

  offset += local.length + name.length + body.length;
}

const centralBuf = Buffer.concat(centralParts);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...localParts, centralBuf, eocd]);

const { version } = JSON.parse(readFileSync(join(SRC, 'manifest.json'), 'utf8'));
mkdirSync(DIST, { recursive: true });
const out = join(DIST, `auto-refresh-${version}.zip`);
writeFileSync(out, zip);

console.log(`Packed ${files.length} files (${(rawTotal / 1024).toFixed(0)} KB source)`);
for (const f of files) console.log(`  ${f}`);
console.log(`\n-> dist/auto-refresh-${version}.zip (${(zip.length / 1024).toFixed(0)} KB)`);
