#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateProductionAudit } from './production-audit-core.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_LEDGER = join(REPO_ROOT, 'docs', 'security', 'production-advisory-exceptions.json');
const RUNTIME_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const EXCLUDED_DIRECTORIES = new Set(['dist', 'fixtures', 'node_modules', 'out', 'tests']);

function parseArgs(argv) {
  const options = { auditJson: undefined, ledger: DEFAULT_LEDGER, now: undefined, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--audit-json') options.auditJson = argv[++index];
    else if (arg === '--ledger') options.ledger = argv[++index];
    else if (arg === '--now') options.now = argv[++index];
    else if (arg === '--help') {
      console.log(
        'Usage: node scripts/security/production-audit-gate.mjs [--audit-json FILE] [--ledger FILE] [--now ISO] [--json]'
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  // F-15 (Kimi 1.819 audit): --audit-json/--ledger/--now can substitute the
  // audit input, the ledger, or the clock. They exist for the gate's own unit
  // tests; a release/CI invocation must never be able to weaken the gate by
  // passing them. Fail closed unless the explicit test-hook env var is set.
  const testHooksEnabled = process.env.COMMAND_EVE_AUDIT_GATE_TEST_HOOKS === '1';
  if (!testHooksEnabled && (options.auditJson !== undefined || options.ledger !== DEFAULT_LEDGER || options.now !== undefined)) {
    throw new Error(
      'production-audit-gate: --audit-json/--ledger/--now are test-only hooks; set COMMAND_EVE_AUDIT_GATE_TEST_HOOKS=1 to enable them'
    );
  }
  if (!options.ledger) throw new Error('--ledger requires a path');
  if (argv.includes('--audit-json') && !options.auditJson) throw new Error('--audit-json requires a path');
  if (argv.includes('--now') && !options.now) throw new Error('--now requires an ISO timestamp');
  return options;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${path}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function runBunAudit() {
  // Bun 1.3 has no --production flag for `bun audit`; passing it was silently
  // ignored and made the recorded scope misleading. Audit the complete lockfile
  // and keep production reachability decisions in the reviewed exception ledger.
  const result = spawnSync('bun', ['audit', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) throw new Error(`bun audit failed to start: ${result.error.message}`);
  if (result.signal) throw new Error(`bun audit terminated by ${result.signal}`);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`bun audit exited ${result.status}: ${String(result.stderr).trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`bun audit returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function walkRuntimeFiles(directory, files = []) {
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    const metadata = statSync(absolute);
    if (metadata.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry)) walkRuntimeFiles(absolute, files);
    } else if (RUNTIME_EXTENSIONS.has(extname(entry))) files.push(absolute);
  }
  return files;
}

function collectRuntimeImportHits(ledger) {
  // F-09 (Kimi 1.819 audit): this is a first-party substring TRIPWIRE over
  // packages/** source, not a module-graph reachability proof. It can be
  // evaded by computed specifiers (import('@hono/' + 'node-server')) and it
  // intentionally excludes node_modules/resources. It exists to catch the
  // realistic regression — a developer wiring the excepted package into
  // product source — not to prove non-reachability. The ledger wording must
  // not claim more than this.
  const specifiers = new Set(
    (ledger.exceptions || []).flatMap((entry) => entry?.reachability?.requiredAbsentRuntimeImports || [])
  );
  const hits = Object.fromEntries([...specifiers].map((specifier) => [specifier, []]));
  if (specifiers.size === 0) return hits;

  for (const file of walkRuntimeFiles(join(REPO_ROOT, 'packages'))) {
    const content = readFileSync(file, 'utf8');
    for (const specifier of specifiers) {
      if (content.includes(specifier)) hits[specifier].push(relative(REPO_ROOT, file));
    }
  }
  return hits;
}

function printHuman(receipt) {
  console.log(
    `[production-audit] ${receipt.status}: ${receipt.advisoryCount} current advisories, ${receipt.acceptedExceptionCount} reviewed exceptions`
  );
  for (const item of receipt.accepted) {
    console.log(`[production-audit] ACCEPTED ${item.severity} ${item.advisoryId} ${item.package}`);
  }
  for (const error of receipt.errors) console.error(`[production-audit] ${error}`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  const ledgerPath = resolve(REPO_ROOT, options.ledger);
  const ledger = readJson(ledgerPath, 'Exception ledger');
  const auditReport = options.auditJson
    ? readJson(resolve(REPO_ROOT, options.auditJson), 'Audit report')
    : runBunAudit();
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now is not a valid ISO timestamp: ${options.now}`);

  const receipt = evaluateProductionAudit({
    auditReport,
    ledger,
    now,
    runtimeImportHits: collectRuntimeImportHits(ledger),
  });
  if (options.json) console.log(JSON.stringify(receipt, null, 2));
  else printHuman(receipt);
  process.exit(receipt.status === 'PASS' ? 0 : 1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[production-audit] FAIL: ${message}`);
  process.exit(1);
}
