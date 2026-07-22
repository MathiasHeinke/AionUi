#!/usr/bin/env node
/**
 * Fail-closed Command EVE full-E2E baseline gate.
 *
 * The gate accepts only a complete Playwright JSON report whose post-run
 * metadata matches the release candidate and whose unexpected test titles add
 * no failures beyond the pinned 1.817 baseline. A failure-name list alone is
 * deliberately insufficient release evidence.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_BASELINE_DIFF_VERSION = 'e2e-baseline-diff/v1';
export const E2E_RUN_METADATA_SCHEMA_VERSION = 'command-eve-playwright-run/v1';

export const E2E_BASELINE_STATUS_EXIT_CODES = {
  PASS: 0,
  BLOCKED_NEW_FAILURES: 1,
  BLOCKED_INPUT: 2,
  BLOCKED_REPORT_MALFORMED: 3,
  BLOCKED_RUN_METADATA: 4,
  BLOCKED_CANDIDATE_SHA: 5,
  BLOCKED_RUN_INCOMPLETE: 6,
  BLOCKED_UNEXPECTED_SKIP: 7,
  BLOCKED_COUNT_MISMATCH: 8,
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BASELINE = path.resolve(
  SCRIPT_DIR,
  '..',
  'tests',
  'e2e',
  'baselines',
  'g6r-step-03-failed-56d036cd.txt'
);
export const DEFAULT_APPROVED_SKIPS = path.resolve(
  SCRIPT_DIR,
  '..',
  'tests',
  'e2e',
  'baselines',
  'command-eve-1818-approved-skips.txt'
);
export const DEFAULT_RETIRED_FAILURES = path.resolve(
  SCRIPT_DIR,
  '..',
  'tests',
  'e2e',
  'baselines',
  'command-eve-1818-retired-failures.txt'
);

const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_EVIDENCE_DIR = path.resolve(REPO_ROOT, 'test-results', 'command-eve-e2e-baseline');

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const OUTCOMES = ['expected', 'unexpected', 'flaky', 'skipped'];
const RESULT_STATUSES = ['passed', 'failed', 'timedOut', 'skipped', 'interrupted'];
const ANONYMOUS_DEFAULT_PROJECT_ID = Symbol('playwright anonymous default project');
const REQUIRED_METADATA_COUNTS = ['expected', 'unexpected', 'flaky', 'skipped', 'projects', 'specs', 'tests'];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function makeResult(status, detail, extra = {}) {
  return {
    version: E2E_BASELINE_DIFF_VERSION,
    status,
    exit_code: E2E_BASELINE_STATUS_EXIT_CODES[status] ?? E2E_BASELINE_STATUS_EXIT_CODES.BLOCKED_INPUT,
    ok: status === 'PASS',
    detail,
    new_failures: [],
    resolved_failures: [],
    ...extra,
  };
}

/** Parse the pinned baseline: one canonical Playwright title per line. */
export function parseFailureList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function diffAgainstBaseline(baselineEntries, failingTitles) {
  const baselineSet = new Set(baselineEntries);
  const failingSet = new Set(failingTitles);
  return {
    newFailures: [...failingSet].filter((title) => !baselineSet.has(title)).sort(),
    resolved: [...baselineSet].filter((title) => !failingSet.has(title)).sort(),
  };
}

function validateTitleRoster(entries, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(entries)) return `${label} is not an array`;
  if (!allowEmpty && entries.length === 0) return `${label} is empty`;
  if (new Set(entries).size !== entries.length) return `${label} contains duplicate titles`;
  if (entries.some((title) => typeof title !== 'string' || !title.includes(' >> '))) {
    return `${label} contains a malformed canonical title`;
  }
  return '';
}

function normalizeSpecFile(file) {
  let normalized = String(file || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
  const absoluteMarker = '/tests/e2e/';
  const absoluteIndex = normalized.lastIndexOf(absoluteMarker);
  if (absoluteIndex >= 0) normalized = normalized.slice(absoluteIndex + absoluteMarker.length);
  if (normalized.startsWith('tests/e2e/')) normalized = normalized.slice('tests/e2e/'.length);
  return normalized;
}

function canonicalTitle(file, suiteTitles, specTitle) {
  return [normalizeSpecFile(file), ...suiteTitles, String(specTitle || '').trim()].filter(Boolean).join(' >> ');
}

function isAnonymousDefaultProject(projects) {
  if (!Array.isArray(projects) || projects.length !== 1) return false;
  const project = asObject(projects[0]);
  return (
    Boolean(project) &&
    Object.prototype.hasOwnProperty.call(project, 'id') &&
    Object.prototype.hasOwnProperty.call(project, 'name') &&
    String(project.id) === '' &&
    String(project.name) === ''
  );
}

function collectSuiteInventory(suite, suiteTitles, inventory, isFileSuite, allowAnonymousDefaultProject) {
  const suiteObject = asObject(suite);
  if (!suiteObject) {
    inventory.structuralErrors.push('suite entry is not an object');
    return;
  }
  if (!Array.isArray(suiteObject.specs)) {
    inventory.structuralErrors.push('suite.specs is not an array');
    return;
  }

  let nestedTitles = suiteTitles;
  if (!isFileSuite) {
    const title = String(suiteObject.title || '').trim();
    if (!title) inventory.structuralErrors.push('nested suite title is missing');
    else nestedTitles = [...suiteTitles, title];
  }

  for (const spec of suiteObject.specs) {
    const specObject = asObject(spec);
    if (!specObject) {
      inventory.structuralErrors.push('spec entry is not an object');
      continue;
    }
    inventory.specCount += 1;
    const file = normalizeSpecFile(specObject.file || suiteObject.file);
    const title = canonicalTitle(file, nestedTitles, specObject.title);
    if (!file || !String(specObject.title || '').trim() || !title.includes(' >> ')) {
      inventory.structuralErrors.push('spec is missing a canonical file/title path');
    }
    if (!Array.isArray(specObject.tests) || specObject.tests.length === 0) {
      inventory.incompleteErrors.push(`spec has no test results: ${title || '<unknown>'}`);
      continue;
    }

    let specHasUnexpected = false;
    for (const test of specObject.tests) {
      const testObject = asObject(test);
      if (!testObject) {
        inventory.structuralErrors.push(`test entry is not an object: ${title || '<unknown>'}`);
        continue;
      }
      inventory.testCount += 1;
      const outcome = String(testObject.status || '');
      if (!OUTCOMES.includes(outcome)) {
        inventory.structuralErrors.push(`test has invalid outcome "${outcome || '<missing>'}": ${title}`);
        continue;
      }
      inventory.outcomes[outcome] += 1;

      const hasProjectId = Object.prototype.hasOwnProperty.call(testObject, 'projectId');
      const hasProjectName = Object.prototype.hasOwnProperty.call(testObject, 'projectName');
      const projectId = String(testObject.projectId || '');
      const projectName = String(testObject.projectName || '');
      if (projectId) {
        inventory.testProjectIds.add(projectId);
      } else if (allowAnonymousDefaultProject && hasProjectId && hasProjectName && !projectName) {
        inventory.testProjectIds.add(ANONYMOUS_DEFAULT_PROJECT_ID);
      } else {
        inventory.structuralErrors.push(`test is missing projectId: ${title}`);
      }

      const expectedStatus = String(testObject.expectedStatus || '');
      if (!RESULT_STATUSES.includes(expectedStatus)) {
        inventory.structuralErrors.push(`test has invalid expectedStatus "${expectedStatus || '<missing>'}": ${title}`);
      }

      if (!Array.isArray(testObject.results)) {
        inventory.incompleteErrors.push(`test results are not an array: ${title}`);
      } else if (testObject.results.length === 0 && outcome !== 'skipped') {
        inventory.incompleteErrors.push(`test has no terminal result: ${title}`);
      } else {
        for (const result of testObject.results) {
          const resultObject = asObject(result);
          const resultStatus = String(resultObject?.status || '');
          if (!resultObject || !RESULT_STATUSES.includes(resultStatus)) {
            inventory.incompleteErrors.push(`test has an invalid result status: ${title}`);
            continue;
          }
          if (resultStatus === 'interrupted') inventory.interruptedTitles.add(title);
        }
      }

      if (outcome === 'unexpected') {
        specHasUnexpected = true;
        inventory.failureTitles.add(title);
      }
      if (outcome === 'skipped') inventory.skippedTitles.add(title);
    }

    if (typeof specObject.ok !== 'boolean') {
      inventory.structuralErrors.push(`spec.ok is missing: ${title}`);
    } else if (specObject.ok === specHasUnexpected) {
      inventory.countErrors.push(`spec.ok disagrees with final test outcomes: ${title}`);
    }
  }

  if (suiteObject.suites != null && !Array.isArray(suiteObject.suites)) {
    inventory.structuralErrors.push('suite.suites is not an array');
    return;
  }
  for (const child of suiteObject.suites || []) {
    collectSuiteInventory(child, nestedTitles, inventory, false, allowAnonymousDefaultProject);
  }
}

function extractInventory(report) {
  const inventory = {
    specCount: 0,
    testCount: 0,
    outcomes: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
    failureTitles: new Set(),
    skippedTitles: new Set(),
    interruptedTitles: new Set(),
    testProjectIds: new Set(),
    structuralErrors: [],
    incompleteErrors: [],
    countErrors: [],
  };
  const allowAnonymousDefaultProject = isAnonymousDefaultProject(report.config?.projects);
  for (const suite of report.suites) {
    collectSuiteInventory(suite, [], inventory, true, allowAnonymousDefaultProject);
  }
  return inventory;
}

function validateRunMetadata(metadata) {
  const metadataObject = asObject(metadata);
  if (!metadataObject) return 'run metadata is not an object';
  if (metadataObject.schema_version !== E2E_RUN_METADATA_SCHEMA_VERSION) {
    return `run metadata schema_version must be ${E2E_RUN_METADATA_SCHEMA_VERSION}`;
  }
  if (!SHA_PATTERN.test(String(metadataObject.candidate_sha || ''))) {
    return 'run metadata candidate_sha must be a full 40-character Git SHA';
  }
  if (!['completed', 'cancelled', 'incomplete'].includes(metadataObject.run_status)) {
    return 'run metadata run_status must be completed, cancelled, or incomplete';
  }
  if (!['passed', 'failed', 'timedout', 'interrupted'].includes(metadataObject.playwright_status)) {
    return 'run metadata playwright_status must be passed, failed, timedout, or interrupted';
  }
  if (!Number.isInteger(metadataObject.playwright_exit_code) || metadataObject.playwright_exit_code < 0) {
    return 'run metadata playwright_exit_code must be a non-negative integer';
  }
  if (Number.isNaN(Date.parse(String(metadataObject.completed_at || '')))) {
    return 'run metadata completed_at must be an ISO-8601 timestamp';
  }
  const counts = asObject(metadataObject.counts);
  if (!counts) return 'run metadata counts is not an object';
  for (const key of REQUIRED_METADATA_COUNTS) {
    if (!Number.isInteger(counts[key]) || counts[key] < 0) {
      return `run metadata counts.${key} must be a non-negative integer`;
    }
  }
  return '';
}

function validateReportShape(report) {
  const reportObject = asObject(report);
  if (!reportObject) return 'Playwright JSON report is not an object';
  if (!asObject(reportObject.config) || !Array.isArray(reportObject.config.projects)) {
    return 'Playwright JSON report config.projects is missing';
  }
  if (!Array.isArray(reportObject.suites)) return 'Playwright JSON report suites is missing';
  if (!Array.isArray(reportObject.errors)) return 'Playwright JSON report errors is missing';
  const stats = asObject(reportObject.stats);
  if (!stats) return 'Playwright JSON report stats is missing';
  if (Number.isNaN(Date.parse(String(stats.startTime || '')))) {
    return 'Playwright JSON report stats.startTime is invalid';
  }
  if (typeof stats.duration !== 'number' || !Number.isFinite(stats.duration) || stats.duration < 0) {
    return 'Playwright JSON report stats.duration is invalid';
  }
  for (const outcome of OUTCOMES) {
    if (!Number.isInteger(stats[outcome]) || stats[outcome] < 0) {
      return `Playwright JSON report stats.${outcome} is invalid`;
    }
  }
  return '';
}

function validateProjects(projects, inventory) {
  const ids = new Set();
  const errors = [];
  const allowAnonymousDefaultProject = isAnonymousDefaultProject(projects);
  for (const project of projects) {
    const projectObject = asObject(project);
    const id = String(projectObject?.id || '');
    if (allowAnonymousDefaultProject) ids.add(ANONYMOUS_DEFAULT_PROJECT_ID);
    else if (!projectObject || !id) errors.push('Playwright project is missing an id');
    else if (ids.has(id)) errors.push(`duplicate Playwright project id: ${id}`);
    else ids.add(id);
  }
  for (const projectId of inventory.testProjectIds) {
    if (!ids.has(projectId)) errors.push(`test references unknown Playwright project id: ${String(projectId)}`);
  }
  for (const projectId of ids) {
    if (!inventory.testProjectIds.has(projectId)) {
      errors.push(`Playwright project has no reported tests: ${String(projectId)}`);
    }
  }
  return errors;
}

export function evaluateE2EBaselineReport(
  report,
  metadata,
  baselineEntries,
  { candidateSha, approvedSkips = [], retiredFailures = [] } = {}
) {
  const metadataError = validateRunMetadata(metadata);
  if (metadataError) return makeResult('BLOCKED_RUN_METADATA', metadataError);

  if (!SHA_PATTERN.test(String(candidateSha || ''))) {
    return makeResult('BLOCKED_CANDIDATE_SHA', 'expected candidate SHA must be a full 40-character Git SHA');
  }
  if (metadata.candidate_sha.toLowerCase() !== candidateSha.toLowerCase()) {
    return makeResult(
      'BLOCKED_CANDIDATE_SHA',
      `run metadata candidate SHA ${metadata.candidate_sha} does not match expected candidate SHA ${candidateSha}`
    );
  }

  if (metadata.run_status !== 'completed') {
    return makeResult('BLOCKED_RUN_INCOMPLETE', `Playwright run status is ${metadata.run_status}, not completed`);
  }
  if (['timedout', 'interrupted'].includes(metadata.playwright_status)) {
    return makeResult(
      'BLOCKED_RUN_INCOMPLETE',
      `Playwright terminal status is ${metadata.playwright_status}, not a completed passed/failed run`
    );
  }

  const reportError = validateReportShape(report);
  if (reportError) return makeResult('BLOCKED_REPORT_MALFORMED', reportError);
  if (report.config.projects.length === 0 || report.suites.length === 0) {
    return makeResult('BLOCKED_REPORT_MALFORMED', 'Playwright JSON report is empty');
  }
  const reportFinishedAt = Date.parse(report.stats.startTime) + report.stats.duration;
  if (Date.parse(metadata.completed_at) < reportFinishedAt) {
    return makeResult('BLOCKED_RUN_METADATA', 'run metadata completed_at predates the Playwright report completion');
  }

  const baseline = Array.isArray(baselineEntries) ? baselineEntries : [];
  const baselineError = validateTitleRoster(baseline, 'failure baseline');
  if (baselineError) return makeResult('BLOCKED_INPUT', baselineError);
  const approvedSkipsError = validateTitleRoster(approvedSkips, 'approved skip roster', { allowEmpty: true });
  if (approvedSkipsError) return makeResult('BLOCKED_INPUT', approvedSkipsError);
  const retiredFailuresError = validateTitleRoster(retiredFailures, 'retired failure roster', {
    allowEmpty: true,
  });
  if (retiredFailuresError) return makeResult('BLOCKED_INPUT', retiredFailuresError);

  const inventory = extractInventory(report);
  if (inventory.structuralErrors.length > 0) {
    return makeResult('BLOCKED_REPORT_MALFORMED', inventory.structuralErrors[0], {
      errors: inventory.structuralErrors,
    });
  }
  if (inventory.specCount === 0 || inventory.testCount === 0) {
    return makeResult('BLOCKED_REPORT_MALFORMED', 'Playwright JSON report contains no specs/tests');
  }
  if (report.errors.length > 0) {
    return makeResult('BLOCKED_RUN_INCOMPLETE', 'Playwright JSON report contains global run errors', {
      errors: report.errors,
    });
  }
  if (inventory.incompleteErrors.length > 0 || inventory.interruptedTitles.size > 0) {
    return makeResult('BLOCKED_RUN_INCOMPLETE', inventory.incompleteErrors[0] || 'Playwright run was interrupted', {
      errors: inventory.incompleteErrors,
      interrupted_tests: [...inventory.interruptedTitles].sort(),
    });
  }

  const projectErrors = validateProjects(report.config.projects, inventory);
  const countErrors = [...inventory.countErrors, ...projectErrors];
  for (const outcome of OUTCOMES) {
    if (report.stats[outcome] !== inventory.outcomes[outcome]) {
      countErrors.push(`report stats.${outcome}=${report.stats[outcome]} but extracted ${inventory.outcomes[outcome]}`);
    }
    if (metadata.counts[outcome] !== report.stats[outcome]) {
      countErrors.push(
        `run metadata counts.${outcome}=${metadata.counts[outcome]} but report has ${report.stats[outcome]}`
      );
    }
  }
  const actualCounts = {
    projects: report.config.projects.length,
    specs: inventory.specCount,
    tests: inventory.testCount,
  };
  for (const key of ['projects', 'specs', 'tests']) {
    if (metadata.counts[key] !== actualCounts[key]) {
      countErrors.push(`run metadata counts.${key}=${metadata.counts[key]} but report has ${actualCounts[key]}`);
    }
  }
  const outcomeTotal = OUTCOMES.reduce((total, outcome) => total + report.stats[outcome], 0);
  if (outcomeTotal !== inventory.testCount) {
    countErrors.push(`Playwright outcome total ${outcomeTotal} does not match ${inventory.testCount} tests`);
  }
  if (countErrors.length > 0) {
    return makeResult('BLOCKED_COUNT_MISMATCH', countErrors[0], {
      errors: countErrors,
      counts: { ...inventory.outcomes, ...actualCounts },
    });
  }

  const expectedPlaywrightStatus = report.stats.unexpected > 0 ? 'failed' : 'passed';
  const expectedExitCode = expectedPlaywrightStatus === 'passed' ? 0 : 1;
  if (metadata.playwright_status !== expectedPlaywrightStatus || metadata.playwright_exit_code !== expectedExitCode) {
    return makeResult(
      'BLOCKED_RUN_INCOMPLETE',
      `run metadata terminal result ${metadata.playwright_status}/${metadata.playwright_exit_code} is inconsistent with report ${expectedPlaywrightStatus}/${expectedExitCode}`
    );
  }

  const approvedSkipSet = new Set(approvedSkips);
  const unapprovedSkips = [...inventory.skippedTitles].filter((title) => !approvedSkipSet.has(title)).sort();
  if (unapprovedSkips.length > 0) {
    return makeResult(
      'BLOCKED_UNEXPECTED_SKIP',
      `${unapprovedSkips.length} skipped test(s) are not in the approved skip roster`,
      { unexpected_skips: unapprovedSkips, counts: { ...inventory.outcomes, ...actualCounts } }
    );
  }

  const failingTitles = [...inventory.failureTitles].sort();
  const retiredFailureSet = new Set(retiredFailures);
  const effectiveBaseline = baseline.filter((title) => !retiredFailureSet.has(title));
  const { newFailures, resolved } = diffAgainstBaseline(effectiveBaseline, failingTitles);
  const retiredRegressions = failingTitles.filter((title) => retiredFailureSet.has(title));
  const resolvedApprovedSkips = approvedSkips.filter((title) => !inventory.skippedTitles.has(title)).sort();
  const evidence = {
    candidate_sha: candidateSha.toLowerCase(),
    counts: { ...inventory.outcomes, ...actualCounts },
    failing_tests: failingTitles,
    new_failures: newFailures,
    resolved_failures: resolved,
    approved_skips: [...inventory.skippedTitles].sort(),
    resolved_approved_skips: resolvedApprovedSkips,
    baseline_failures: baseline.length,
    effective_baseline_failures: effectiveBaseline.length,
    retired_regressions: retiredRegressions,
  };
  if (newFailures.length > 0) {
    return makeResult(
      'BLOCKED_NEW_FAILURES',
      `${newFailures.length} new failure(s) are not pinned in the baseline`,
      evidence
    );
  }
  return makeResult(
    'PASS',
    `Completed Playwright report accepted; ${resolved.length} baseline failure(s) resolved`,
    evidence
  );
}

function usage() {
  return `Usage:
  node scripts/e2e-baseline-diff.mjs \\
    --report <playwright-report.json> \\
    --run-metadata <run-metadata.json> \\
    --candidate-sha <40-character-git-sha> \\
    [--baseline <failure-baseline.txt>] \\
    [--approved-skips <approved-skips.txt>] \\
    [--retired-failures <retired-failures.txt>] \\
    [--json]

  node scripts/e2e-baseline-diff.mjs --run-playwright \\
    [--candidate-sha <40-character-git-sha>] \\
    [--evidence-dir <directory>] \\
    [--baseline <failure-baseline.txt>] \\
    [--approved-skips <approved-skips.txt>] \\
    [--retired-failures <retired-failures.txt>]

The run metadata sidecar must follow ${E2E_RUN_METADATA_SCHEMA_VERSION} and be
written only after Playwright exits. The runner refuses a dirty worktree so the
candidate SHA cannot misrepresent the tested source. The release runner accepts
no Playwright passthrough arguments: grep, project, shard, positional spec, and
similar selection flags would make a partial run look complete. See
tests/e2e/README.md.`;
}

function parseArgs(argv) {
  const args = {
    report: '',
    runMetadata: '',
    candidateSha: '',
    baseline: DEFAULT_BASELINE,
    approvedSkips: DEFAULT_APPROVED_SKIPS,
    retiredFailures: DEFAULT_RETIRED_FAILURES,
    runPlaywright: false,
    evidenceDir: DEFAULT_EVIDENCE_DIR,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      throw new Error('Playwright passthrough arguments are forbidden for the full-E2E release gate');
    }
    if (arg === '--report') args.report = argv[++index] || '';
    else if (arg === '--run-metadata') args.runMetadata = argv[++index] || '';
    else if (arg === '--candidate-sha') args.candidateSha = argv[++index] || '';
    else if (arg === '--baseline') args.baseline = argv[++index] || '';
    else if (arg === '--approved-skips') args.approvedSkips = argv[++index] || '';
    else if (arg === '--retired-failures') args.retiredFailures = argv[++index] || '';
    else if (arg === '--run-playwright') args.runPlaywright = true;
    else if (arg === '--evidence-dir') args.evidenceDir = argv[++index] || '';
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (args.runPlaywright && (args.report || args.runMetadata)) {
    throw new Error('--run-playwright cannot be combined with --report or --run-metadata');
  }
  if (!args.runPlaywright && !args.report) throw new Error('--report is required');
  if (!args.runPlaywright && !args.runMetadata) throw new Error('--run-metadata is required');
  if (!args.runPlaywright && !args.candidateSha) throw new Error('--candidate-sha is required');
  if (!args.baseline) throw new Error('--baseline requires a value');
  if (!args.approvedSkips) throw new Error('--approved-skips requires a value');
  if (!args.retiredFailures) throw new Error('--retired-failures requires a value');
  if (args.runPlaywright && !args.evidenceDir) throw new Error('--evidence-dir requires a value');
  return args;
}

function parseJsonFile(filePath, label, status) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { error: makeResult(status, `cannot read ${label} ${filePath}: ${error.message}`) };
  }
  if (!text.trim()) return { error: makeResult(status, `${label} is empty: ${filePath}`) };
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: makeResult(status, `cannot parse ${label} ${filePath}: ${error.message}`) };
  }
}

function readTitleRoster(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { error: makeResult('BLOCKED_INPUT', `cannot read ${label} ${filePath}: ${error.message}`) };
  }
  return { value: parseFailureList(text) };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`${result.status}: ${result.detail}`);
  if (result.counts) {
    const counts = result.counts;
    console.log(
      `run: ${counts.tests} test(s), ${counts.specs} spec(s), ${counts.projects} project(s); ` +
        `${counts.expected} expected, ${counts.unexpected} unexpected, ${counts.flaky} flaky, ${counts.skipped} skipped`
    );
  }
  if (result.resolved_failures?.length > 0) {
    console.log(`resolved since baseline (${result.resolved_failures.length}):`);
    for (const title of result.resolved_failures) console.log(`  - ${title}`);
  }
  if (result.new_failures?.length > 0) {
    console.log(`NEW FAILURES not in baseline (${result.new_failures.length}):`);
    for (const title of result.new_failures) console.log(`  + ${title}`);
  }
  console.log(`e2e-baseline-diff: ${result.ok ? 'PASS' : 'BLOCK'}`);
}

function runGit(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return {
      error: result.error?.message || result.stderr?.trim() || `git ${args.join(' ')} exited ${result.status}`,
    };
  }
  return { value: result.stdout.trim() };
}

function resolveCleanCandidateSha(explicitCandidateSha) {
  const head = runGit(['rev-parse', 'HEAD']);
  if (head.error) {
    return { error: makeResult('BLOCKED_CANDIDATE_SHA', `cannot resolve candidate HEAD: ${head.error}`) };
  }
  const candidateSha = explicitCandidateSha || head.value;
  if (!SHA_PATTERN.test(candidateSha)) {
    return { error: makeResult('BLOCKED_CANDIDATE_SHA', 'candidate SHA must be a full 40-character Git SHA') };
  }
  if (candidateSha.toLowerCase() !== head.value.toLowerCase()) {
    return {
      error: makeResult(
        'BLOCKED_CANDIDATE_SHA',
        `candidate SHA ${candidateSha} does not match worktree HEAD ${head.value}`
      ),
    };
  }
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.error) {
    return { error: makeResult('BLOCKED_CANDIDATE_SHA', `cannot verify clean worktree: ${status.error}`) };
  }
  if (status.value) {
    return {
      error: makeResult(
        'BLOCKED_CANDIDATE_SHA',
        'worktree is dirty; commit the exact release candidate before producing E2E baseline evidence',
        { dirty_paths: status.value.split(/\r?\n/) }
      ),
    };
  }
  return { value: candidateSha.toLowerCase() };
}

function buildPostRunMetadata(report, candidateSha, playwrightRun) {
  const reportObject = asObject(report);
  const stats = asObject(reportObject?.stats);
  const hasSuites = Array.isArray(reportObject?.suites);
  const hasProjects = Array.isArray(reportObject?.config?.projects);
  const inventory = hasSuites ? extractInventory(reportObject) : null;
  const exitCode = Number.isInteger(playwrightRun.status) && playwrightRun.status >= 0 ? playwrightRun.status : 255;
  const completed = playwrightRun.signal == null && [0, 1].includes(exitCode);
  const playwrightStatus =
    exitCode === 0 ? 'passed' : exitCode === 1 ? 'failed' : playwrightRun.signal ? 'interrupted' : 'timedout';
  return {
    schema_version: E2E_RUN_METADATA_SCHEMA_VERSION,
    candidate_sha: candidateSha,
    run_status: completed ? 'completed' : 'incomplete',
    playwright_status: playwrightStatus,
    playwright_exit_code: exitCode,
    completed_at: new Date().toISOString(),
    counts: {
      expected: Number.isInteger(stats?.expected) ? stats.expected : 0,
      unexpected: Number.isInteger(stats?.unexpected) ? stats.unexpected : 0,
      flaky: Number.isInteger(stats?.flaky) ? stats.flaky : 0,
      skipped: Number.isInteger(stats?.skipped) ? stats.skipped : 0,
      projects: hasProjects ? reportObject.config.projects.length : 0,
      specs: inventory?.specCount ?? 0,
      tests: inventory?.testCount ?? 0,
    },
  };
}

function runPlaywrightAndGate(args) {
  const candidate = resolveCleanCandidateSha(args.candidateSha);
  if (candidate.error) {
    printResult(candidate.error, args.json);
    return candidate.error.exit_code;
  }

  const playwrightCli = path.resolve(REPO_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!fs.existsSync(playwrightCli)) {
    const result = makeResult('BLOCKED_INPUT', `Playwright CLI is missing: ${playwrightCli}`);
    printResult(result, args.json);
    return result.exit_code;
  }

  const evidenceDir = path.resolve(REPO_ROOT, args.evidenceDir);
  const runId = `${candidate.value.slice(0, 12)}-${Date.now()}`;
  const reportPath = path.join(evidenceDir, `playwright-report-${runId}.json`);
  const metadataPath = path.join(evidenceDir, `run-metadata-${runId}.json`);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const playwrightRun = spawnSync(
    process.execPath,
    [playwrightCli, 'test', '--config', 'playwright.config.ts', '--reporter=json'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath },
      stdio: 'inherit',
    }
  );

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    // The direct gate below owns the malformed/missing-report verdict.
  }
  const metadata = buildPostRunMetadata(report, candidate.value, playwrightRun);
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  const logEvidencePath = args.json ? console.error : console.log;
  logEvidencePath(`Playwright JSON evidence: ${reportPath}`);
  logEvidencePath(`Post-run metadata: ${metadataPath}`);

  return runCli([
    '--report',
    reportPath,
    '--run-metadata',
    metadataPath,
    '--candidate-sha',
    candidate.value,
    '--baseline',
    args.baseline,
    '--approved-skips',
    args.approvedSkips,
    '--retired-failures',
    args.retiredFailures,
    ...(args.json ? ['--json'] : []),
  ]);
}

export function runCli(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const result = makeResult('BLOCKED_INPUT', error.message);
    console.error(usage());
    printResult(result, argv.includes('--json'));
    return result.exit_code;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.runPlaywright) return runPlaywrightAndGate(args);

  const report = parseJsonFile(args.report, 'Playwright JSON report', 'BLOCKED_REPORT_MALFORMED');
  if (report.error) {
    printResult(report.error, args.json);
    return report.error.exit_code;
  }
  const metadata = parseJsonFile(args.runMetadata, 'run metadata', 'BLOCKED_RUN_METADATA');
  if (metadata.error) {
    printResult(metadata.error, args.json);
    return metadata.error.exit_code;
  }

  const baseline = readTitleRoster(args.baseline, 'failure baseline');
  if (baseline.error) {
    printResult(baseline.error, args.json);
    return baseline.error.exit_code;
  }
  const approvedSkips = readTitleRoster(args.approvedSkips, 'approved skip roster');
  if (approvedSkips.error) {
    printResult(approvedSkips.error, args.json);
    return approvedSkips.error.exit_code;
  }
  const mandatoryRetiredFailures = readTitleRoster(DEFAULT_RETIRED_FAILURES, 'mandatory retired failure roster');
  if (mandatoryRetiredFailures.error) {
    printResult(mandatoryRetiredFailures.error, args.json);
    return mandatoryRetiredFailures.error.exit_code;
  }
  let requestedRetiredFailures = mandatoryRetiredFailures;
  if (path.resolve(args.retiredFailures) !== path.resolve(DEFAULT_RETIRED_FAILURES)) {
    requestedRetiredFailures = readTitleRoster(args.retiredFailures, 'retired failure roster');
    if (requestedRetiredFailures.error) {
      printResult(requestedRetiredFailures.error, args.json);
      return requestedRetiredFailures.error.exit_code;
    }
  }
  const retiredFailures = [...new Set([...mandatoryRetiredFailures.value, ...requestedRetiredFailures.value])];

  const result = evaluateE2EBaselineReport(report.value, metadata.value, baseline.value, {
    candidateSha: args.candidateSha,
    approvedSkips: approvedSkips.value,
    retiredFailures,
  });
  printResult(result, args.json);
  return result.exit_code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = runCli();
}
