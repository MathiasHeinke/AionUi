import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..');
const COMPARATOR = path.join(REPO_ROOT, 'scripts', 'e2e-baseline-diff.mjs');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const HISTORICAL_BASELINE = path.join(REPO_ROOT, 'tests', 'e2e', 'baselines', 'g6r-step-03-failed-56d036cd.txt');
const RETIRED_FAILURES = path.join(REPO_ROOT, 'tests', 'e2e', 'baselines', 'command-eve-1818-retired-failures.txt');
const CANDIDATE_SHA = 'a'.repeat(40);
const PINNED_FAILURE = 'fixture.e2e.ts >> pinned failure';
const NEW_FAILURE = 'fixture.e2e.ts >> synthetic new failure';
const APPROVED_SKIP = 'fixture.e2e.ts >> approved environment skip';

type TestOutcome = 'expected' | 'unexpected' | 'flaky' | 'skipped';
type ResultStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

type FixtureTest = {
  title: string;
  outcome?: TestOutcome;
  expectedStatus?: ResultStatus;
  resultStatus?: ResultStatus;
  omitResults?: boolean;
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-baseline-diff-test-'));
let fixtureSequence = 0;

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readRoster(filePath: string): string[] {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function makeReport(tests: FixtureTest[]) {
  const outcomes = { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
  const specs = tests.map((fixture) => {
    const outcome = fixture.outcome ?? 'expected';
    const expectedStatus = fixture.expectedStatus ?? (outcome === 'skipped' ? 'skipped' : 'passed');
    const resultStatus = fixture.resultStatus ?? (outcome === 'unexpected' ? 'failed' : expectedStatus);
    outcomes[outcome] += 1;
    return {
      title: fixture.title,
      ok: outcome !== 'unexpected',
      file: 'tests/e2e/fixture.e2e.ts',
      line: 1,
      column: 1,
      tests: [
        {
          timeout: 30_000,
          annotations: [],
          expectedStatus,
          projectId: 'electron',
          projectName: 'electron',
          results: fixture.omitResults
            ? []
            : [
                {
                  workerIndex: 0,
                  parallelIndex: 0,
                  status: resultStatus,
                  duration: 1,
                  errors: [],
                  stdout: [],
                  stderr: [],
                },
              ],
          status: outcome,
        },
      ],
    };
  });
  return {
    config: { projects: [{ id: 'electron', name: 'electron' }] },
    suites: [
      {
        title: 'fixture.e2e.ts',
        file: 'tests/e2e/fixture.e2e.ts',
        line: 1,
        column: 1,
        specs,
        suites: [],
      },
    ],
    errors: [],
    stats: {
      startTime: '2026-07-22T00:00:00.000Z',
      duration: 1,
      ...outcomes,
    },
  };
}

function makeMetadata(report: ReturnType<typeof makeReport>, overrides: Record<string, unknown> = {}) {
  const specs = report.suites.reduce((total, suite) => total + suite.specs.length, 0);
  return {
    schema_version: 'command-eve-playwright-run/v1',
    candidate_sha: CANDIDATE_SHA,
    run_status: 'completed',
    playwright_status: report.stats.unexpected > 0 ? 'failed' : 'passed',
    playwright_exit_code: report.stats.unexpected > 0 ? 1 : 0,
    completed_at: '2026-07-22T00:00:01.000Z',
    counts: {
      expected: report.stats.expected,
      unexpected: report.stats.unexpected,
      flaky: report.stats.flaky,
      skipped: report.stats.skipped,
      projects: report.config.projects.length,
      specs,
      tests: specs,
    },
    ...overrides,
  };
}

function writeFixture(name: string, value: string | object): string {
  fixtureSequence += 1;
  const filePath = path.join(tmpDir, `${String(fixtureSequence).padStart(3, '0')}-${name}`);
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
  return filePath;
}

function runComparator({
  report,
  metadata = makeMetadata(report),
  baseline = [PINNED_FAILURE],
  approvedSkips = [],
  retiredFailures = [],
}: {
  report: ReturnType<typeof makeReport>;
  metadata?: object;
  baseline?: string[];
  approvedSkips?: string[];
  retiredFailures?: string[];
}) {
  const reportPath = writeFixture('report.json', report);
  const metadataPath = writeFixture('metadata.json', metadata);
  const baselinePath = writeFixture('baseline.txt', baseline.join('\n'));
  const approvedSkipsPath = writeFixture('approved-skips.txt', approvedSkips.join('\n'));
  const retiredFailuresPath = writeFixture('retired-failures.txt', retiredFailures.join('\n'));
  const result = spawnSync(
    process.execPath,
    [
      COMPARATOR,
      '--report',
      reportPath,
      '--run-metadata',
      metadataPath,
      '--candidate-sha',
      CANDIDATE_SHA,
      '--baseline',
      baselinePath,
      '--approved-skips',
      approvedSkipsPath,
      '--retired-failures',
      retiredFailuresPath,
      '--json',
    ],
    { encoding: 'utf8', cwd: REPO_ROOT }
  );
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    receipt: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

describe('e2e-baseline-diff comparator', () => {
  it('preserves the 38 historical failures and explicitly retires modernized green specs', () => {
    const historical = readRoster(HISTORICAL_BASELINE);
    const retired = readRoster(RETIRED_FAILURES);
    expect(historical).toHaveLength(38);
    expect(retired.length).toBeGreaterThan(0);
    expect(retired.every((title) => historical.includes(title))).toBe(true);
  });

  it('accepts a complete report with no new failures', () => {
    const result = runComparator({ report: makeReport([{ title: 'healthy test' }]) });
    expect(result.status).toBe(0);
    expect(result.receipt.status).toBe('PASS');
    expect(result.receipt.new_failures).toEqual([]);
  });

  it("accepts Playwright's explicit empty identity for one anonymous default project", () => {
    const report = makeReport([{ title: 'healthy test' }]);
    report.config.projects[0] = { id: '', name: '' };
    report.suites[0].specs[0].tests[0].projectId = '';
    report.suites[0].specs[0].tests[0].projectName = '';
    const result = runComparator({ report, metadata: makeMetadata(report) });
    expect(result.status).toBe(0);
    expect(result.receipt.status).toBe('PASS');
    expect(result.receipt.counts).toMatchObject({ projects: 1, specs: 1, tests: 1 });
  });

  it('blocks an empty test project id when more than one project is configured', () => {
    const report = makeReport([{ title: 'healthy test' }]);
    report.config.projects[0] = { id: '', name: '' };
    report.config.projects.push({ id: 'electron', name: 'electron' });
    report.suites[0].specs[0].tests[0].projectId = '';
    report.suites[0].specs[0].tests[0].projectName = '';
    const result = runComparator({ report, metadata: makeMetadata(report) });
    expect(result.status).toBe(3);
    expect(result.receipt.status).toBe('BLOCKED_REPORT_MALFORMED');
  });

  it('blocks a missing projectId property even for one anonymous default project', () => {
    const report = makeReport([{ title: 'healthy test' }]);
    report.config.projects[0] = { id: '', name: '' };
    report.suites[0].specs[0].tests[0].projectName = '';
    delete (report.suites[0].specs[0].tests[0] as Partial<(typeof report.suites)[0]['specs'][0]['tests'][0]>).projectId;
    const result = runComparator({ report, metadata: makeMetadata(report) });
    expect(result.status).toBe(3);
    expect(result.receipt.status).toBe('BLOCKED_REPORT_MALFORMED');
  });

  it('blocks a test that references an unknown project id', () => {
    const report = makeReport([{ title: 'healthy test' }]);
    report.suites[0].specs[0].tests[0].projectId = 'unknown-project';
    report.suites[0].specs[0].tests[0].projectName = 'unknown-project';
    const result = runComparator({ report, metadata: makeMetadata(report) });
    expect(result.status).toBe(8);
    expect(result.receipt.status).toBe('BLOCKED_COUNT_MISMATCH');
    expect(result.receipt.errors).toContain('test references unknown Playwright project id: unknown-project');
  });

  it('accepts a complete report whose only failure is effectively pinned', () => {
    const result = runComparator({
      report: makeReport([{ title: 'pinned failure', outcome: 'unexpected' }]),
    });
    expect(result.status).toBe(0);
    expect(result.receipt.status).toBe('PASS');
  });

  it('blocks a new failure and names it in the receipt', () => {
    const result = runComparator({
      report: makeReport([{ title: 'synthetic new failure', outcome: 'unexpected' }]),
    });
    expect(result.status).toBe(1);
    expect(result.receipt.status).toBe('BLOCKED_NEW_FAILURES');
    expect(result.receipt.new_failures).toEqual([NEW_FAILURE]);
  });

  it('does not let the historical baseline mask a retired failure regression', () => {
    const result = runComparator({
      report: makeReport([{ title: 'pinned failure', outcome: 'unexpected' }]),
      retiredFailures: [PINNED_FAILURE],
    });
    expect(result.status).toBe(1);
    expect(result.receipt.retired_regressions).toEqual([PINNED_FAILURE]);
  });

  it('blocks an unapproved skip even when Playwright marks it expected', () => {
    const result = runComparator({
      report: makeReport([{ title: 'approved environment skip', outcome: 'skipped' }]),
    });
    expect(result.status).toBe(7);
    expect(result.receipt.status).toBe('BLOCKED_UNEXPECTED_SKIP');
    expect(result.receipt.unexpected_skips).toEqual([APPROVED_SKIP]);
  });

  it('accepts only the exact canonical skip title in the approved roster', () => {
    const result = runComparator({
      report: makeReport([{ title: 'approved environment skip', outcome: 'skipped', omitResults: true }]),
      approvedSkips: [APPROVED_SKIP],
    });
    expect(result.status).toBe(0);
    expect(result.receipt.approved_skips).toEqual([APPROVED_SKIP]);
  });

  it('does not report an approved skipped baseline failure as resolved', () => {
    const result = runComparator({
      report: makeReport([{ title: 'pinned failure', outcome: 'skipped', omitResults: true }]),
      approvedSkips: [PINNED_FAILURE],
    });
    expect(result.status).toBe(0);
    expect(result.receipt.resolved_failures).toEqual([]);
    expect(result.receipt.baseline_skips).toEqual([PINNED_FAILURE]);
    expect(result.receipt.detail).toContain('0 baseline failure(s) resolved');
  });

  it('blocks an empty Playwright report instead of treating all failures as resolved', () => {
    const report = makeReport([]);
    report.config.projects = [];
    report.suites = [];
    const result = runComparator({ report, metadata: makeMetadata(report) });
    expect(result.status).toBe(3);
    expect(result.receipt.status).toBe('BLOCKED_REPORT_MALFORMED');
  });

  it('blocks a truncated test result with no terminal result', () => {
    const result = runComparator({ report: makeReport([{ title: 'truncated test', omitResults: true }]) });
    expect(result.status).toBe(6);
    expect(result.receipt.status).toBe('BLOCKED_RUN_INCOMPLETE');
  });

  it('blocks cancelled post-run metadata', () => {
    const report = makeReport([{ title: 'healthy test' }]);
    const result = runComparator({
      report,
      metadata: makeMetadata(report, { run_status: 'cancelled', playwright_status: 'interrupted' }),
    });
    expect(result.status).toBe(6);
    expect(result.receipt.status).toBe('BLOCKED_RUN_INCOMPLETE');
  });

  it('blocks metadata that does not prove when the run completed', () => {
    const report = makeReport([{ title: 'healthy test' }]);
    const metadata = makeMetadata(report);
    delete (metadata as Partial<typeof metadata>).completed_at;
    const result = runComparator({ report, metadata });
    expect(result.status).toBe(4);
    expect(result.receipt.status).toBe('BLOCKED_RUN_METADATA');
  });

  it('blocks a candidate SHA mismatch', () => {
    const report = makeReport([{ title: 'healthy test' }]);
    const result = runComparator({
      report,
      metadata: makeMetadata(report, { candidate_sha: 'b'.repeat(40) }),
    });
    expect(result.status).toBe(5);
    expect(result.receipt.status).toBe('BLOCKED_CANDIDATE_SHA');
  });

  it('blocks report and metadata count drift', () => {
    const report = makeReport([{ title: 'healthy test' }]);
    const metadata = makeMetadata(report);
    metadata.counts.tests = 2;
    const result = runComparator({ report, metadata });
    expect(result.status).toBe(8);
    expect(result.receipt.status).toBe('BLOCKED_COUNT_MISMATCH');
  });

  it('blocks malformed JSON at the CLI boundary', () => {
    const result = spawnSync(
      process.execPath,
      [
        COMPARATOR,
        '--report',
        writeFixture('malformed-report.json', '{'),
        '--run-metadata',
        writeFixture('metadata.json', {}),
        '--candidate-sha',
        CANDIDATE_SHA,
      ],
      { encoding: 'utf8', cwd: REPO_ROOT }
    );
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('BLOCKED_REPORT_MALFORMED');
  });

  it('rejects the obsolete failure-list-only CLI contract', () => {
    const result = spawnSync(process.execPath, [COMPARATOR, '--new', '-'], {
      encoding: 'utf8',
      input: '',
      cwd: REPO_ROOT,
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain('unknown argument: --new');
  });

  it('rejects Playwright selection passthrough so the release runner cannot execute a partial suite', () => {
    const result = spawnSync(process.execPath, [COMPARATOR, '--run-playwright', '--', '--grep', 'one test'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Playwright passthrough arguments are forbidden for the full-E2E release gate'
    );
  });

  it('wires the committed-candidate runner into the package E2E surface', () => {
    const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
    expect(packageJson.scripts['test:e2e:baseline']).toContain('e2e-baseline-diff.mjs');
    expect(packageJson.scripts['test:e2e:baseline']).toContain('--run-playwright');
  });
});
