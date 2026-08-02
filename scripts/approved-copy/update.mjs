#!/usr/bin/env node
// REGENERATE THE APPROVED-COPY MANIFEST — the deliberate half of the review boundary.
//
// Run this AFTER changing locale copy, then READ THE DIFF. The diff is the review: it
// shows, verbatim, every string added, changed or removed on every covered locale
// surface. A human approving a copy change is approving that diff.
//
// NOTHING AUTOMATED MAY EVER RUN THIS. Not CI, not a build, not `bunx vitest run`, not a
// package script, not a git hook. If this script ran in any of those, the boundary would
// approve itself and the gate would be theatre — the failure mode of every
// self-certifying gate this project has already retired.
//
// THAT IS NOT LEFT TO THIS COMMENT. tests/unit/approved-copy/updaterIsManualOnly.test.ts
// scans every workflow, every package script, every hook and every script in the repo and
// FAILS CLOSED if this file is reachable from any of them.
//
//   node scripts/approved-copy/update.mjs           rewrite the manifest
//   node scripts/approved-copy/update.mjs --check   print what WOULD change, write nothing
//
// --check exits 1 when the manifest is out of date, so a human can use it as a fast local
// answer to "did I forget to update the manifest?". It is a HUMAN convenience: wiring even
// --check into automation is caught by the same test, because a reviewer who never sees
// the diff has not reviewed anything.

import { readFileSync, writeFileSync } from 'node:fs';
import { MANIFEST_PATH, observeContract, serialiseManifest } from './core.mjs';

const check = process.argv.includes('--check');
const next = serialiseManifest(observeContract());

let current = '';
try {
  current = readFileSync(MANIFEST_PATH, 'utf8');
} catch {
  current = '';
}

if (current === next) {
  console.log('approved-copy manifest is up to date.');
  process.exit(0);
}

const lines = (s) => new Set(s.split('\n').filter((l) => l.startsWith('copy\t') || l.startsWith('surface\t')));
const before = lines(current);
const after = lines(next);
const added = [...after].filter((l) => !before.has(l));
const removed = [...before].filter((l) => !after.has(l));

console.log(`approved-copy manifest: +${added.length} / -${removed.length} record(s)`);
for (const l of removed.slice(0, 40)) console.log(`  - ${l}`);
for (const l of added.slice(0, 40)) console.log(`  + ${l}`);
if (added.length + removed.length > 80) console.log('  … (truncated; read the git diff)');

if (check) {
  console.error('FAIL: the approved-copy manifest is out of date. Run: node scripts/approved-copy/update.mjs');
  process.exit(1);
}

writeFileSync(MANIFEST_PATH, next);
console.log(`wrote ${MANIFEST_PATH}`);
console.log('NOW READ THE DIFF. Approving a copy change means approving these lines.');
