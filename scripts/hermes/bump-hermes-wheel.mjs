#!/usr/bin/env node

/**
 * CLI for the Hermes wheel bump. See bump-hermes-wheel-core.mjs for the rules.
 *
 * Usage:
 *   node scripts/hermes/bump-hermes-wheel.mjs \
 *     --version 0.20.0 \
 *     --wheel /path/to/hermes_agent-0.20.0-py3-none-any.whl \
 *     [--repin] \
 *     [--dry-run]
 *
 * The SHA-256 is computed FROM THE WHEEL FILE — it is deliberately not an
 * argument, so a wrong hash can never be copied in. --dry-run prints the full
 * plan (including the computed sha) and writes nothing. Any manifest drift —
 * a carrier file missing, an occurrence count off — aborts before the first
 * write; a verification failure AFTER writing exits non-zero and says so.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyHermesWheelBump, planHermesWheelBump } from './bump-hermes-wheel-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function parseArgs(argv) {
  const args = { version: '', wheel: '', repin: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--version' || arg === '-v') args.version = argv[++index] || '';
    else if (arg === '--wheel' || arg === '-w') args.wheel = argv[++index] || '';
    else if (arg === '--repin') args.repin = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/hermes/bump-hermes-wheel.mjs --version <X.Y.Z> --wheel <hermes_agent-X.Y.Z-py3-none-any.whl> [--repin] [--dry-run]

Flips every Hermes version carrier + the committed wheel SHA-256 pin, swaps the
bundled wheel under resources/bundled-hermes/, and verifies no old-version
residue remains. --repin explicitly permits replacing reviewed wheel bytes at
the already-pinned version without rewriting version carriers. Aborts loudly
on any manifest drift. --dry-run plans only.`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.version || !args.wheel) {
    console.log(usage());
    process.exit(args.help ? 0 : 2);
  }
  const plan = planHermesWheelBump({
    repoRoot: REPO_ROOT,
    targetVersion: args.version,
    wheelPath: path.resolve(args.wheel),
    allowSameVersionRepin: args.repin,
  });
  console.log(
    `Hermes bump plan: ${plan.oldVersion} -> ${plan.targetVersion}${plan.sameVersionRepin ? ' (same-version repin)' : ''}`
  );
  console.log(`  wheel sha256 (computed): ${plan.newSha256}`);
  const result = applyHermesWheelBump(plan, { dryRun: args.dryRun });
  for (const action of result.actions) {
    console.log(`  ${result.dryRun ? '[dry-run] would ' : ''}${action}`);
  }
  if (result.dryRun) {
    console.log('DRY RUN — nothing written. Re-run without --dry-run to apply.');
    return;
  }
  console.log('APPLIED and VERIFIED: no old-version residue in the live scope.');
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
