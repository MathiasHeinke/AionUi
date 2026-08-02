/**
 * THE UPDATER MUST BE MANUAL, AND UNTIL NOW ONLY A COMMENT SAID SO.
 *
 * The approved-copy manifest's entire value rests on ONE property: a human runs the
 * updater, reads the resulting verbatim diff, and approves it. THE DIFF IS THE REVIEW.
 *
 * If the updater is ever invoked by CI, a build, a test run, a package script or a git
 * hook, that property inverts completely. The manifest would then be regenerated from
 * whatever the surfaces currently say, immediately before being compared against
 * themselves, and the gate would pass by construction — for every sentence, forever,
 * including one nobody has ever read. The boundary would approve itself. That is not a
 * weakened gate; it is theatre with a green tick, and it is strictly worse than no gate,
 * because a green tick gets believed.
 *
 * scripts/approved-copy/update.mjs carries a comment saying CI must never run it. A
 * comment is a wish. THIS FILE IS THE ENFORCEMENT: it walks every automation surface in
 * the repository — every workflow, every composite action, every package script, every
 * git hook, the pre-commit config, the justfile, the Makefile, every script and every
 * other test — and FAILS CLOSED if the updater is reachable from any of them.
 *
 * COMMENTS ARE STRIPPED BEFORE MATCHING, deliberately. A build script that documents "do
 * not wire scripts/approved-copy/update.mjs into CI" is describing the rule, not breaking
 * it, and a gate that reddened on its own documentation would be switched off by whoever
 * hit it first. What is scanned is what actually EXECUTES.
 *
 * THIS GATE ALSO REFUSES TO BE SATISFIED BY ABSENCE. If the updater were renamed or
 * deleted, a token scan would find nothing and go green while the manifest quietly became
 * unmaintainable — or worse, regenerable by some new second updater. So the shape of the
 * mechanism itself is pinned: the updater exists at its declared path, it is the ONLY file
 * that writes the manifest, and the gate that reads the manifest does not import it.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const rel = (f: string): string => path.relative(REPO_ROOT, f).split(path.sep).join('/');

const UPDATER = 'scripts/approved-copy/update.mjs';
const CORE = 'scripts/approved-copy/core.mjs';
const GATE = 'tests/unit/approved-copy/localeCopyManifest.test.ts';
const SAFEGUARD = 'tests/unit/approved-copy/updaterIsManualOnly.test.ts';
/**
 * The THIRD gate that reads the shared mechanism: the zero-cost claim rules moved into
 * core.mjs when a second surface — hardcoded .ts copy — turned out to carry the same claim
 * class the locale manifest deliberately does not cover. It imports the ANALYSIS library,
 * never the updater, and the row below asserts exactly that, so widening this allowlist by
 * one file does not widen what the safeguard actually protects.
 */
const CLAIM_GATE = 'tests/unit/approved-copy/hardcodedZeroCostClaims.test.ts';

/**
 * THE MECHANISM'S OWN FILES. These four are the only places in the repository allowed to
 * name the approved-copy tooling: two are the tooling, two are the gates that read the
 * manifest and police the tooling. Each is asserted to exist, so a rename cannot silently
 * drop a file out of the scan by dropping it out of the allowlist.
 */
const OWN_FILES = [UPDATER, CORE, GATE, SAFEGUARD, CLAIM_GATE];

/**
 * WHAT COUNTS AS AN AUTOMATION SURFACE — anything that can cause code to run without a
 * human typing the command. Discovered, never hand-listed, so a workflow added tomorrow is
 * covered with no edit here.
 */
function discoverAutomationSurfaces(): string[] {
  const found: string[] = [];
  const walk = (dir: string, keep: RegExp): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, keep);
      else if (keep.test(entry.name)) found.push(full);
    }
  };
  walk(path.join(REPO_ROOT, '.github'), /\.(ya?ml)$/);
  walk(path.join(REPO_ROOT, '.husky'), /.*/);
  walk(path.join(REPO_ROOT, 'scripts'), /\.(mjs|cjs|js|ts|sh|bash|json|ya?ml)$/);
  walk(path.join(REPO_ROOT, 'tests'), /\.(mjs|cjs|js|ts|tsx|sh|json)$/);
  for (const file of ['package.json', 'justfile', 'Makefile', '.pre-commit-config.yaml', 'vitest.config.ts']) {
    const full = path.join(REPO_ROOT, file);
    if (existsSync(full) && statSync(full).isFile()) found.push(full);
  }
  return [...new Set(found)].toSorted();
}

const SURFACES = discoverAutomationSurfaces().filter((f) => !OWN_FILES.includes(rel(f)));

/** Strip comments so DOCUMENTING the rule is never mistaken for BREAKING it. */
function executableOnly(file: string, text: string): string {
  if (/\.(ts|tsx|mjs|cjs|js)$/.test(file)) {
    return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  }
  if (/\.(ya?ml)$/.test(file) || /(^|\/)(justfile|Makefile)$/.test(file) || /\.(sh|bash)$/.test(file)) {
    return text.replace(/(^|\s)#[^\n]*/g, '$1');
  }
  if (/\.husky\//.test(file)) return text.replace(/(^|\s)#[^\n]*/g, '$1');
  return text; // json has no comments
}

/**
 * ANY mention of the approved-copy tooling in executable content is a violation. Not just
 * `node scripts/approved-copy/update.mjs`: a glob (`scripts/approved-copy/*.mjs`), an
 * import, a `bun run` of a package script that wraps it, or a bare directory reference all
 * end with the updater running. The token is the directory name, so every one of those
 * shapes is a single, unarguable hit.
 */
const APPROVED_COPY_REFERENCE = /approved-copy/i;

type Violation = { file: string; line: number; text: string };

function scanForAutoWiring(): Violation[] {
  const violations: Violation[] = [];
  for (const file of SURFACES) {
    const source = executableOnly(rel(file), readFileSync(file, 'utf8'));
    source.split('\n').forEach((line, i) => {
      if (APPROVED_COPY_REFERENCE.test(line)) violations.push({ file: rel(file), line: i + 1, text: line.trim() });
    });
  }
  return violations;
}

describe('THE UPDATER IS MANUAL — enforced, not asserted in a comment', () => {
  it('the automation walk is really scanning something (it cannot silently empty out)', () => {
    expect(
      SURFACES.length,
      `only ${SURFACES.length} automation surfaces discovered — the walk is broken`
    ).toBeGreaterThan(200);
    // Named surfaces, not only a count: a count still passes when the walk stops reaching
    // the one place that matters. These are the CI entry points, the pre-push gate, the
    // hook config and the package manifest.
    for (const required of [
      '.github/workflows/pr-checks.yml',
      '.github/workflows/build-and-release.yml',
      '.pre-commit-config.yaml',
      'justfile',
      'Makefile',
      'package.json',
      'vitest.config.ts',
    ]) {
      expect(
        SURFACES.map(rel),
        `${required} is no longer in the automation scan — the safeguard stopped watching it`
      ).toContain(required);
    }
  });

  it('NO allowlisted GATE reaches the updater — the allowlist buys access to the LIBRARY only', () => {
    // The token scan cannot tell `core.mjs` (pure analysis) from `update.mjs` (the thing
    // that rewrites the manifest), so every file added to OWN_FILES gets both. This row
    // puts the distinction back: a gate may READ the mechanism, never RUN it.
    // Scoped to the file this allowlist was widened FOR. The other two legitimately name
    // the updater in executable content — GATE carries its own allowlist array of the
    // mechanism's paths, SAFEGUARD is that mechanism's police — and pretending otherwise
    // would be an assertion written to pass rather than to hold.
    const source = executableOnly(CLAIM_GATE, readFileSync(path.join(REPO_ROOT, CLAIM_GATE), 'utf8'));
    expect(source, `${CLAIM_GATE} names the updater in executable content`).not.toMatch(/update\.mjs/);
    expect(source, `${CLAIM_GATE} no longer reads the shared analysis library`).toMatch(/core\.mjs/);
  });

  it('the mechanism files exist exactly where the allowlist says they do', () => {
    // A rename must not quietly empty the allowlist AND the token scan at the same time.
    for (const own of OWN_FILES) {
      expect(existsSync(path.join(REPO_ROOT, own)), `${own} does not exist — the safeguard is guarding nothing`).toBe(
        true
      );
    }
  });

  it('NO workflow, build, test, package script or git hook can reach the updater', () => {
    const violations = scanForAutoWiring();
    expect(
      violations.map((v) => `${v.file}:${v.line}  ${v.text}`),
      `${violations.length} automation surface reference(s) to the approved-copy tooling.\n\n` +
        'If the updater runs automatically, the manifest is regenerated from whatever the ' +
        'surfaces currently say and then compared against itself. It would pass for every ' +
        'sentence forever, including one no human has read. The review boundary would ' +
        'approve itself.\n\n' +
        'Run it BY HAND — `node scripts/approved-copy/update.mjs` — and get the diff ' +
        `reviewed.\n${violations.map((v) => `${v.file}:${v.line}  ${v.text}`).join('\n')}`
    ).toEqual([]);
  });

  it('no package script — including every lifecycle hook — invokes it', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const offenders = Object.entries(scripts)
      .filter(([, cmd]) => APPROVED_COPY_REFERENCE.test(cmd))
      .map(([name, cmd]) => `${name}: ${cmd}`);
    expect(offenders, `a package script invokes the updater:\n${offenders.join('\n')}`).toEqual([]);
    // The lifecycle names are asserted BY NAME as well, because these run without anyone
    // asking: `bun install` alone fires prepare and postinstall.
    for (const lifecycle of ['prepare', 'postinstall', 'preinstall', 'pretest', 'test', 'posttest', 'prepublishOnly']) {
      expect(scripts[lifecycle] ?? '', `the ${lifecycle} lifecycle script invokes the updater`).not.toMatch(
        APPROVED_COPY_REFERENCE
      );
    }
    // …and the committed test entry point is still the plain runner, so the suite that
    // executes the gate cannot also be the thing that regenerates its input.
    expect(scripts.test, 'the `test` script is no longer the plain vitest runner').toBe('vitest run');
  });

  it('the updater is the ONLY thing that can write the manifest, and the gate never imports it', () => {
    const dir = path.join(REPO_ROOT, 'scripts/approved-copy');
    const files = readdirSync(dir).toSorted();
    expect(
      files,
      'a third file appeared beside the approved-copy tooling — a second updater is a second boundary'
    ).toEqual(['core.mjs', 'update.mjs']);
    const updaterSource = readFileSync(path.join(REPO_ROOT, UPDATER), 'utf8');
    const coreSource = readFileSync(path.join(REPO_ROOT, CORE), 'utf8');
    expect(updaterSource, 'the updater no longer writes the manifest').toMatch(/writeFileSync\(MANIFEST_PATH/);
    expect(coreSource, 'the shared core writes files — the read half must stay read-only').not.toMatch(/writeFileSync/);
    // The gate reads the manifest from disk and imports the CORE only. If it ever imported
    // the updater, importing it would execute it, and the gate would rewrite its own input.
    const gateSource = readFileSync(path.join(REPO_ROOT, GATE), 'utf8');
    expect(gateSource, 'the gate imports the updater — running the suite would rewrite the manifest').not.toMatch(
      /from\s+['"][^'"]*approved-copy\/update\.mjs['"]/
    );
    expect(gateSource, 'the gate no longer imports the shared core').toMatch(
      /from\s+['"][^'"]*approved-copy\/core\.mjs['"]/
    );
  });
});
