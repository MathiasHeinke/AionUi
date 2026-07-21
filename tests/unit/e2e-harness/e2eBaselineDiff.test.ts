/**
 * Self-test for scripts/e2e-baseline-diff.mjs (Command EVE 1.818 C4 harness
 * finding 4).
 *
 * Proves two directions against the pinned 38-failure baseline:
 *   1. A fresh failure list containing only pinned names PASSES (exit 0).
 *   2. The detector FIRES on any NEW failure: a synthetic failing name is
 *      added to the "new" list fixture, the comparator must exit 1 and name
 *      it — then the synthetic name is removed with the temp dir (it never
 *      touches the pinned baseline).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..');
const COMPARATOR = path.join(REPO_ROOT, 'scripts', 'e2e-baseline-diff.mjs');
const BASELINE = path.join(REPO_ROOT, 'tests', 'e2e', 'baselines', 'g6r-step-03-failed-56d036cd.txt');

const SYNTHETIC_NEW_FAILURE = 'e2e-synthetic-c4-probe.e2e.ts >> C4 detector self-test >> synthetic new failure';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-baseline-diff-test-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readBaselineNames(): string[] {
  return fs
    .readFileSync(BASELINE, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function writeNewList(names: string[]): string {
  const filePath = path.join(tmpDir, `new-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(filePath, `${names.join('\n')}\n`, 'utf8');
  return filePath;
}

function runComparator(newFile: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [COMPARATOR, '--new', newFile], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('e2e-baseline-diff comparator', () => {
  it('the pinned baseline contains exactly the 38 triaged 1.817 failures', () => {
    const names = readBaselineNames();
    expect(names).toHaveLength(38);
    expect(new Set(names).size).toBe(38);
    expect(names.every((name) => name.includes(' >> '))).toBe(true);
  });

  it('passes when the new failure list equals the pinned baseline', () => {
    const { status, output } = runComparator(writeNewList(readBaselineNames()));
    expect(status).toBe(0);
    expect(output).toContain('PASS');
    expect(output).not.toContain('NEW FAILURES');
  });

  it('passes when the new list is a strict subset (resolved failures are informational)', () => {
    const subset = readBaselineNames().slice(0, 5);
    const { status, output } = runComparator(writeNewList(subset));
    expect(status).toBe(0);
    expect(output).toContain('resolved since baseline: 33');
  });

  it('passes with an empty new list (all baseline failures resolved)', () => {
    const { status, output } = runComparator(writeNewList([]));
    expect(status).toBe(0);
    expect(output).toContain('resolved since baseline: 38');
  });

  it('FAILS the run when a synthetic NEW failure is added to the new list (detector fires)', () => {
    // Temporarily add a synthetic failing name to the "new" list — this is the
    // detector proof. The name lives only in this temp fixture and is removed
    // with the temp dir; the pinned baseline is never modified.
    const withSynthetic = [...readBaselineNames().slice(0, 3), SYNTHETIC_NEW_FAILURE];
    const { status, output } = runComparator(writeNewList(withSynthetic));

    expect(status).toBe(1);
    expect(output).toContain('NEW FAILURES not in baseline (1)');
    expect(output).toContain(SYNTHETIC_NEW_FAILURE);
    expect(output).toContain('FAIL');

    // Sanity after removal: the same list without the synthetic name passes.
    const withoutSynthetic = readBaselineNames().slice(0, 3);
    const rerun = runComparator(writeNewList(withoutSynthetic));
    expect(rerun.status).toBe(0);
  });

  it('exits 2 on usage errors (missing --new)', () => {
    const result = spawnSync(process.execPath, [COMPARATOR], { encoding: 'utf8', cwd: REPO_ROOT });
    expect(result.status).toBe(2);
  });
});
