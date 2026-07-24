#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  EGRESS_KEYSTONE_VERIFIER_VERSION,
  evaluateEgressKeystoneReport,
} from './verify-egress-keystone-report-core.mjs';
import { RELEASE_GATE_AGGREGATOR_VERSION, runReleaseGates } from './release-gate-aggregator-core.mjs';
import { evaluateMacUpdateFeed } from './verify-mac-update-feed-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOTARIZATION_GATE = path.join(HERE, 'verify-notarization-stapled.mjs');
const FIRST_RUN_BUNDLE_GATE = path.join(HERE, 'verify-command-eve-first-run-bundle.mjs');

function parseArgs(argv) {
  const args = { egressJsonReport: '', dmg: '', outDir: '', metadata: '', app: '', userData: '', json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--egress-json-report') args.egressJsonReport = argv[++index] || '';
    else if (arg === '--dmg') args.dmg = argv[++index] || '';
    else if (arg === '--out-dir') args.outDir = argv[++index] || '';
    else if (arg === '--metadata') args.metadata = argv[++index] || '';
    else if (arg === '--app') args.app = argv[++index] || '';
    else if (arg === '--user-data') args.userData = argv[++index] || '';
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  node scripts/release/release-gate-aggregator.mjs \\
    --egress-json-report <playwright-report.json> \\
    --dmg <path-to.dmg> \\
    [--out-dir <release-out-dir>] \\
    [--metadata <latest-*-mac.yml>] \\
    --app <electron-builder/Command EVE.app> \\
    --user-data <fresh-packaged-run-userData> \\
    [--json]

Runs the REQUIRED, fail-closed release gates and blocks the release unless every
one passes:
  - egress-keystone     (Command EVE egress-boundary Playwright proof)
  - notarization-stapled (DMG stapler-valid + accepted by Gatekeeper/spctl)
  - mac-update-feed      (latest-*-mac.yml points to the final DMG/ZIP hashes)
  - first-run-bundle     (C9: fresh packaged run receipt ↔ version binding,
                          identity chain, onboarding skill byte-identity)

A non-stapled or spctl-rejected DMG, a missing/failed/skipped egress proof, or a
stale updater metadata fails the whole gate closed. The first-run-bundle gate
requires one real cold launch of the packaged app with a clean --user-data
directory before the aggregate can pass.`;
}

// Runner for the egress-keystone gate: reads the Playwright JSON report and
// runs the same pure evaluator the standalone gate CLI uses. A missing or
// unparseable report fails closed.
function makeEgressKeystoneRunner(jsonReportPath) {
  return () => {
    if (!jsonReportPath) {
      return {
        version: EGRESS_KEYSTONE_VERIFIER_VERSION,
        status: 'BLOCKED_REPORT_MALFORMED',
        detail: '--egress-json-report is required',
      };
    }
    if (!fs.existsSync(jsonReportPath)) {
      return {
        version: EGRESS_KEYSTONE_VERIFIER_VERSION,
        status: 'BLOCKED_REPORT_MALFORMED',
        detail: `--egress-json-report not found: ${jsonReportPath}`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(jsonReportPath, 'utf8'));
    } catch (error) {
      return {
        version: EGRESS_KEYSTONE_VERIFIER_VERSION,
        status: 'BLOCKED_REPORT_MALFORMED',
        detail: `Cannot parse Playwright JSON report: ${error.message}`,
      };
    }
    return {
      version: EGRESS_KEYSTONE_VERIFIER_VERSION,
      ...evaluateEgressKeystoneReport(parsed, { requirePassed: true }),
    };
  };
}

// Runner for the notarization-stapled gate: spawns the Batch-1 gate CLI so it
// does the real xcrun/spctl assessment (and fails closed off-darwin / on a
// non-stapled DMG). We parse its --json output back into the aggregator's
// gate-result shape. A non-zero exit or unparseable output is fail-closed.
function makeNotarizationStapledRunner(dmgPath) {
  return () => {
    if (!dmgPath) {
      return { status: 'BLOCKED_ARTIFACT_MISSING', detail: '--dmg is required' };
    }
    const run = spawnSync(process.execPath, [NOTARIZATION_GATE, '--dmg', dmgPath, '--json'], {
      encoding: 'utf8',
    });
    if (run.error) {
      return {
        status: 'BLOCKED_CHECK_ERROR',
        detail: `notarization gate could not run: ${run.error.message}`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(run.stdout || '');
    } catch {
      return {
        status: 'BLOCKED_CHECK_ERROR',
        detail: `notarization gate produced unparseable output (exit ${run.status})`,
        exit_code: run.status,
      };
    }
    // Trust the gate's own status, but never let a zero-ish status leak through:
    // if the child exited non-zero, force a block regardless of parsed status.
    if (run.status !== 0 && parsed.status === 'PASS') {
      return {
        status: 'BLOCKED_CHECK_ERROR',
        detail: `notarization gate reported PASS but exited ${run.status}; failing closed`,
        exit_code: run.status,
      };
    }
    return parsed;
  };
}

function makeMacUpdateFeedRunner({ dmgPath, outDir, metadataPath }) {
  return () =>
    evaluateMacUpdateFeed({
      dmgPath,
      outDir: outDir || undefined,
      metadataPath: metadataPath || undefined,
    });
}

// Runner for the first-run-bundle (C9) gate: spawns the standalone verifier so
// the real receipt/identity/skill checks run against an actual fresh packaged
// launch. Missing inputs, a non-zero exit or unparseable output fail closed,
// and a PASS claim from a non-zero child exit is forced back to BLOCKED.
function makeFirstRunBundleRunner({ appPath, userDataPath }) {
  return () => {
    if (!appPath || !userDataPath) {
      return {
        status: 'BLOCKED_INPUT',
        detail: '--app and --user-data are required for the first-run-bundle gate',
      };
    }
    const run = spawnSync(
      process.execPath,
      [FIRST_RUN_BUNDLE_GATE, '--app', appPath, '--user-data', userDataPath, '--json'],
      { encoding: 'utf8' }
    );
    if (run.error) {
      return {
        status: 'BLOCKED_CHECK_ERROR',
        detail: `first-run-bundle gate could not run: ${run.error.message}`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(run.stdout || '');
    } catch {
      return {
        status: 'BLOCKED_CHECK_ERROR',
        detail: `first-run-bundle gate produced unparseable output (exit ${run.status})`,
        exit_code: run.status,
      };
    }
    if (run.status !== 0 && parsed.status === 'PASS') {
      return {
        status: 'BLOCKED_CHECK_ERROR',
        detail: `first-run-bundle gate reported PASS but exited ${run.status}; failing closed`,
        exit_code: run.status,
      };
    }
    return parsed;
  };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status}: ${result.detail}`);
  for (const gate of result.gates || []) {
    console.log(`- ${gate.ok ? 'PASS' : 'BLOCK'} ${gate.id}: ${gate.status} :: ${gate.detail}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const result = await runReleaseGates({
    egressKeystone: makeEgressKeystoneRunner(args.egressJsonReport),
    notarizationStapled: makeNotarizationStapledRunner(args.dmg),
    macUpdateFeed: makeMacUpdateFeedRunner({
      dmgPath: args.dmg,
      outDir: args.outDir,
      metadataPath: args.metadata,
    }),
    firstRunBundle: makeFirstRunBundleRunner({
      appPath: args.app,
      userDataPath: args.userData,
    }),
  });
  result.aggregator_version = RELEASE_GATE_AGGREGATOR_VERSION;
  printResult(result, args.json);
  process.exitCode = result.exit_code;
}

main().catch((error) => {
  console.error(`release-gate-aggregator failed: ${error.message}`);
  process.exitCode = 6;
});
