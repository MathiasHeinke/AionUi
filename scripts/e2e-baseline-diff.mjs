#!/usr/bin/env node
/**
 * Diff a fresh E2E failure list against the pinned Command EVE baseline
 * (1.818 C4 harness finding 4).
 *
 * The baseline pins the 38 known failures of the 1.817 full e2e run
 * (206 passed / 38 failed, 0 product regressions after triage). Any failure
 * in a fresh run that is NOT pinned in the baseline is a NEW failure and
 * fails this comparator (exit 1) — regressions become visible immediately
 * instead of hiding inside a known-failing total.
 *
 * Input format (both files): one full Playwright test name per line,
 *   <spec path> >> <describe> [<describe>...] >> <test>
 * Lines starting with # and blank lines are ignored.
 *
 * Usage:
 *   node scripts/e2e-baseline-diff.mjs --new <failures.txt>
 *   node scripts/e2e-baseline-diff.mjs --new - < failures.txt   (stdin)
 *   node scripts/e2e-baseline-diff.mjs --baseline <file> --new <failures.txt>
 *
 * Exit codes:
 *   0 — no new failures (resolved/pinned sets may differ; that is reported
 *       but not fatal)
 *   1 — NEW failures detected (listed on stdout)
 *   2 — usage or IO error
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = path.resolve(SCRIPT_DIR, '..', 'tests', 'e2e', 'baselines', 'g6r-step-03-failed-56d036cd.txt');

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error(
    'usage: node scripts/e2e-baseline-diff.mjs --new <failures.txt|-> [--baseline <file>]'
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { baseline: DEFAULT_BASELINE, newFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline') {
      args.baseline = argv[++i];
    } else if (arg === '--new') {
      args.newFile = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  if (!args.baseline) usage('--baseline requires a value');
  if (!args.newFile) usage('--new is required');
  return args;
}

/** Read a failure list: one test name per line, # comments and blanks ignored. */
export function parseFailureList(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function readInput(filePath) {
  if (filePath === '-') {
    return fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function diffAgainstBaseline(baselineEntries, newEntries) {
  const baselineSet = new Set(baselineEntries);
  const newSet = new Set(newEntries);
  const seen = new Set();
  const newFailures = newEntries.filter((name) => {
    if (baselineSet.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const resolved = baselineEntries.filter((name) => !newSet.has(name));
  return { newFailures, resolved };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let baselineText;
  let newText;
  try {
    baselineText = readInput(args.baseline);
  } catch (error) {
    usage(`cannot read baseline ${args.baseline}: ${error.message}`);
  }
  try {
    newText = readInput(args.newFile);
  } catch (error) {
    usage(`cannot read new failure list ${args.newFile}: ${error.message}`);
  }

  const baselineEntries = parseFailureList(baselineText);
  const newEntries = parseFailureList(newText);
  const { newFailures, resolved } = diffAgainstBaseline(baselineEntries, newEntries);

  console.log(`baseline: ${baselineEntries.length} pinned failure(s) — ${args.baseline}`);
  console.log(`new run:  ${newEntries.length} failure(s)`);

  if (resolved.length > 0) {
    console.log(`resolved since baseline: ${resolved.length} (informational)`);
  }

  if (newFailures.length > 0) {
    console.log(`\nNEW FAILURES not in baseline (${newFailures.length}):`);
    for (const name of newFailures) {
      console.log(`  + ${name}`);
    }
    console.log('\ne2e-baseline-diff: FAIL — new failures detected');
    process.exit(1);
  }

  console.log('\ne2e-baseline-diff: PASS — no new failures vs baseline');
  process.exit(0);
}

// Run as CLI only (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
