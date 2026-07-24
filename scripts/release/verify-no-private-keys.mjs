/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * BUILD/CI GUARD — fail if any PRIVATE signing-key material is present under a
 * shippable path (Teardown C2). The license signing keys mint EVERY license; one
 * accidental bundling into the DMG = a total entitlement bypass that can only be
 * undone by rotating the trust root (which breaks all issued licenses). PUBLIC
 * keys are explicitly allowed (they MUST ship — the client verifies against them).
 *
 * Flags: (a) any file named `*signing*.key` (our private-key naming), and
 * (b) any file containing a `-----BEGIN … PRIVATE KEY-----` header. A
 * `-----BEGIN PUBLIC KEY-----` PEM does NOT match → public keys pass.
 *
 * Pure + injectable for tests; CLI scans the dirs passed as argv.
 */

import fs from 'node:fs';
import path from 'node:path';

export const PRIVATE_KEY_HEADER = /-----BEGIN (?:OPENSSH |EC |RSA |DSA |ENCRYPTED )?PRIVATE KEY-----/;
// F-10 (Kimi 1.819 audit): a PEM renamed to license.txt/keys.dat must not
// evade the guard. Text-extension files are only flagged when the header sits
// at the START of the file — real PEMs begin with it; docs merely quote it
// inline. Keeps npm-doc false positives out while closing the rename evasion.
export const PRIVATE_KEY_HEADER_AT_START =
  /^\s*(?:\uFEFF)?-----BEGIN (?:OPENSSH |EC |RSA |DSA |ENCRYPTED )?PRIVATE KEY-----/;
export const TEXT_SCAN_EXTENSIONS = new Set(['.txt', '.dat']);
const TEXT_SCAN_MAX_BYTES = 32 * 1024;
export const PRIVATE_KEY_FILENAME = /signing.*\.key$/i;
// Content-scan ONLY real key-file types. Docs/source (npm's config.html, man
// pages, .js) merely MENTION "BEGIN PRIVATE KEY" and must not trip the guard —
// an actually-shipped private key is a .key/.pem/.p8/.der (or extensionless).
export const KEY_FILE_EXTENSIONS = new Set(['.key', '.pem', '.p8', '.pk8', '.der', '.asc', '']);

function walk(dir, out, deps) {
  let entries;
  try {
    entries = deps.readdir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, deps);
    else out.push(p);
  }
  return out;
}

/**
 * Scan the given roots; return an array of { file, reason } findings. A non-empty
 * array means a private key would ship → the build must fail.
 */
export function scanForPrivateKeys(roots, deps = {}) {
  const readdir = deps.readdir || ((d) => fs.readdirSync(d, { withFileTypes: true }));
  const statSize = deps.statSize || ((f) => fs.statSync(f).size);
  const readText = deps.readText || ((f) => fs.readFileSync(f, 'latin1'));
  const findings = [];
  for (const root of roots) {
    for (const f of walk(root, [], { readdir })) {
      if (PRIVATE_KEY_FILENAME.test(path.basename(f))) {
        findings.push({ file: f, reason: 'private signing-key filename' });
        continue;
      }
      // Second tier (F-10): small .txt/.dat files whose FIRST bytes are a PEM
      // header. A renamed private key starts with the header; documentation
      // quoting it inline does not match.
      if (TEXT_SCAN_EXTENSIONS.has(path.extname(f).toLowerCase())) {
        let textSize;
        try {
          textSize = statSize(f);
        } catch {
          continue;
        }
        if (textSize > TEXT_SCAN_MAX_BYTES) continue;
        let textHead;
        try {
          textHead = readText(f);
        } catch {
          continue;
        }
        if (PRIVATE_KEY_HEADER_AT_START.test(textHead)) {
          findings.push({ file: f, reason: 'PRIVATE KEY material (renamed text file)' });
        }
        continue;
      }
      // Only content-scan real key-file types (skips docs/source that merely
      // mention the header → no false positives on bundled npm/node trees).
      if (!KEY_FILE_EXTENSIONS.has(path.extname(f).toLowerCase())) continue;
      let size;
      try {
        size = statSize(f);
      } catch {
        continue;
      }
      if (size > 2_000_000) continue; // skip large binaries; keys are tiny
      let text;
      try {
        text = readText(f);
      } catch {
        continue;
      }
      if (PRIVATE_KEY_HEADER.test(text)) findings.push({ file: f, reason: 'PRIVATE KEY material' });
    }
  }
  return findings;
}

// CLI: `node verify-no-private-keys.mjs <dir...>` → exit 1 if any private key found.
if (import.meta.url === `file://${process.argv[1]}`) {
  const roots = process.argv.slice(2).filter((r) => {
    try {
      return fs.existsSync(r);
    } catch {
      return false;
    }
  });
  if (roots.length === 0) {
    console.error('verify-no-private-keys: no existing paths given');
    process.exit(2);
  }
  const findings = scanForPrivateKeys(roots);
  if (findings.length > 0) {
    console.error(`✗ PRIVATE KEY material under shippable paths (${findings.length}) — build BLOCKED:`);
    for (const x of findings) console.error(`  - ${x.file}  (${x.reason})`);
    process.exit(1);
  }
  console.log(`✓ no private-key material under: ${roots.join(', ')}`);
}
