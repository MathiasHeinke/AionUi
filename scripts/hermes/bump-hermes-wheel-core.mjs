/**
 * Hermes wheel bump — the version flip as a COMMAND, not a craft.
 *
 * 0.16→0.17 was done by hand across four commits and no script; this module
 * makes the third flip (0.17→0.20) and every one after it mechanical:
 * take a target version + the wheel file, compute the SHA-256 OURSELVES
 * (never copy one in), rewrite every known carrier consistently, swap the
 * bundled wheel file, and VERIFY that no old-version residue remains.
 *
 * Design rules, each learned the expensive way elsewhere in this repo:
 *  - The current version/sha are PARSED from runtimeBootstrapCore.ts, never
 *    passed in — the pin is the single source of truth for "old".
 *  - Every carrier has an EXPECTED occurrence count. A mismatch aborts loudly:
 *    silently skipping a moved line would be worse than any error (the exact
 *    failure mode that made green gates lie before).
 *  - Wheel filename is a load-bearing contract: the runtime resolves the
 *    bundled wheel BY NAME (`hermesWheelFileName` →
 *    `hermes_agent-<version>-py3-none-any.whl`), and electron-builder packs
 *    the whole `resources/bundled-hermes` directory — so the packaging half of
 *    the flip is the FILE swap, not a yml text edit.
 *  - `--dry-run` plans and verifies expectations but writes nothing.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const HERMES_PIN_FILE = 'packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts';
export const BUNDLED_HERMES_DIR = 'resources/bundled-hermes';

/**
 * Every file that carries the Hermes version string, with the count of
 * occurrences we EXPECT today. Measured, not guessed — the counts are pinned
 * so that a moved or deleted site aborts the bump instead of half-applying.
 * (docs/ deliberately excluded: prose history keeps its old numbers.)
 */
export const HERMES_VERSION_SITES = [
  { file: HERMES_PIN_FILE, count: 3 },
  { file: 'tests/unit/command-eve/runtimeBootstrapCore.test.ts', count: 20 },
  { file: 'tests/unit/command-eve/windows/windowsRuntimeBootstrapCore.test.ts', count: 10 },
  { file: 'tests/unit/command-eve/windows/windowsPhaseALifecycleCore.test.ts', count: 3 },
  { file: 'tests/unit/command-eve/localRuntimeStatusCore.test.ts', count: 2 },
  { file: 'tests/unit/command-eve/aiCodingDelegationGate.test.ts', count: 2 },
  { file: 'tests/unit/command-eve/hermesAuxiliaryCompatibility.test.ts', count: 1 },
  { file: 'tests/unit/command-eve/eveChiefOfStaffSkill.test.ts', count: 1 },
  { file: 'tests/unit/command-eve/bundledHermesApprovalTimeout.test.ts', count: 1 },
  { file: 'scripts/release/verify-soul-wired.sh', count: 1 },
  { file: 'public/command-eve-runtime-bootstrap.json', count: 1 },
  { file: 'packages/desktop/src/process/commandEve/paidOperationRegistryCore.ts', count: 1 },
];

/** Files carrying the committed wheel SHA-256 pin. */
export const HERMES_WHEEL_SHA_SITES = [
  { file: HERMES_PIN_FILE, count: 1 },
  { file: 'scripts/release/verify-packaged-command-eve-resources.mjs', count: 1 },
  { file: 'tests/e2e/helpers/nativeKanbanReadiness.ts', count: 1 },
  { file: 'tests/unit/command-eve/hermesAuxiliaryCompatibility.test.ts', count: 1 },
];

export function wheelFileNameForVersion(version) {
  return `hermes_agent-${version}-py3-none-any.whl`;
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/** Parse the CURRENT pins out of runtimeBootstrapCore.ts — the one source of "old". */
export function readCurrentHermesPin(repoRoot) {
  const pinPath = path.join(repoRoot, HERMES_PIN_FILE);
  const source = fs.readFileSync(pinPath, 'utf8');
  const versionMatch = source.match(/const DEFAULT_HERMES_VERSION = '([^']+)';/);
  const shaMatch = source.match(/COMMAND_EVE_BUNDLED_HERMES_WHEEL_SHA256 =\s*'([0-9a-f]{64})';/);
  if (!versionMatch) throw new Error(`ABORT: DEFAULT_HERMES_VERSION pin not found in ${HERMES_PIN_FILE}`);
  if (!shaMatch) throw new Error(`ABORT: COMMAND_EVE_BUNDLED_HERMES_WHEEL_SHA256 pin not found in ${HERMES_PIN_FILE}`);
  return { version: versionMatch[1], sha256: shaMatch[1] };
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/**
 * Build the full bump plan, fail-closed. Throws with an ABORT message when a
 * precondition or an expected site count does not hold; returns the plan
 * (sites, sha, wheel actions) when everything lines up.
 */
export function planHermesWheelBump({
  repoRoot,
  targetVersion,
  wheelPath,
  versionSites,
  shaSites,
  allowSameVersionRepin = false,
}) {
  const sites = versionSites || HERMES_VERSION_SITES;
  const shaCarrierSites = shaSites || HERMES_WHEEL_SHA_SITES;
  if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
    throw new Error(`ABORT: target version '${targetVersion}' is not a plain X.Y.Z version`);
  }
  if (!fs.existsSync(wheelPath) || !fs.statSync(wheelPath).isFile()) {
    throw new Error(`ABORT: wheel file not found: ${wheelPath}`);
  }
  const expectedWheelName = wheelFileNameForVersion(targetVersion);
  if (path.basename(wheelPath) !== expectedWheelName) {
    throw new Error(
      `ABORT: wheel is named '${path.basename(wheelPath)}' but the runtime resolves the bundled wheel BY NAME — it must be '${expectedWheelName}'`
    );
  }
  const current = readCurrentHermesPin(repoRoot);
  const sameVersionRepin = current.version === targetVersion;
  if (sameVersionRepin && !allowSameVersionRepin) {
    throw new Error(`ABORT: repo already pins Hermes ${targetVersion}; nothing to bump`);
  }
  const newSha256 = sha256File(wheelPath);

  const problems = [];
  const versionEdits = [];
  for (const site of sites) {
    const filePath = path.join(repoRoot, site.file);
    if (!fs.existsSync(filePath)) {
      problems.push(`missing site: ${site.file}`);
      continue;
    }
    const found = countOccurrences(fs.readFileSync(filePath, 'utf8'), current.version);
    if (found !== site.count) {
      problems.push(`site drift: ${site.file} carries '${current.version}' ${found}x, expected ${site.count}x`);
      continue;
    }
    if (!sameVersionRepin) versionEdits.push({ file: site.file, replacements: found });
  }
  const shaEdits = [];
  for (const site of shaCarrierSites) {
    const filePath = path.join(repoRoot, site.file);
    if (!fs.existsSync(filePath)) {
      problems.push(`missing sha site: ${site.file}`);
      continue;
    }
    const found = countOccurrences(fs.readFileSync(filePath, 'utf8'), current.sha256);
    if (found !== site.count) {
      problems.push(`sha site drift: ${site.file} carries the old wheel sha ${found}x, expected ${site.count}x`);
      continue;
    }
    shaEdits.push({ file: site.file, replacements: found });
  }
  const oldWheelPath = path.join(repoRoot, BUNDLED_HERMES_DIR, wheelFileNameForVersion(current.version));
  const newWheelPath = path.join(repoRoot, BUNDLED_HERMES_DIR, expectedWheelName);
  if (!fs.existsSync(oldWheelPath)) {
    problems.push(`missing bundled wheel for the CURRENT pin: ${path.relative(repoRoot, oldWheelPath)}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `ABORT — the repo does not look like the manifest expects; nothing was changed:\n  - ${problems.join('\n  - ')}`
    );
  }
  return {
    repoRoot,
    oldVersion: current.version,
    oldSha256: current.sha256,
    targetVersion,
    newSha256,
    sameVersionRepin,
    versionEdits,
    shaEdits,
    wheel: { copyFrom: wheelPath, copyTo: newWheelPath, removeOld: oldWheelPath },
  };
}

/**
 * Apply (or, with dryRun, only report) the plan, then VERIFY. Verification is
 * part of the apply, not a courtesy: it re-reads every carrier and scans the
 * live scope for `hermes_agent-<old>` / `hermes-agent==<old>` residue.
 */
export function applyHermesWheelBump(plan, { dryRun }) {
  const actions = [];
  if (plan.sameVersionRepin) actions.push(`preserve Hermes version '${plan.targetVersion}'`);
  for (const edit of [...plan.versionEdits]) {
    actions.push(`replace ${edit.replacements}x '${plan.oldVersion}' -> '${plan.targetVersion}' in ${edit.file}`);
  }
  for (const edit of [...plan.shaEdits]) {
    actions.push(`replace ${edit.replacements}x old wheel sha -> ${plan.newSha256} in ${edit.file}`);
  }
  actions.push(
    `${plan.sameVersionRepin ? 'replace reviewed wheel bytes at' : 'copy wheel ->'} ${path.relative(plan.repoRoot, plan.wheel.copyTo)}`
  );
  if (plan.wheel.removeOld !== plan.wheel.copyTo) {
    actions.push(`remove old wheel ${path.relative(plan.repoRoot, plan.wheel.removeOld)}`);
  }
  if (dryRun) {
    return { dryRun: true, actions, verified: false };
  }

  for (const edit of plan.versionEdits) {
    const filePath = path.join(plan.repoRoot, edit.file);
    const next = fs.readFileSync(filePath, 'utf8').split(plan.oldVersion).join(plan.targetVersion);
    fs.writeFileSync(filePath, next);
  }
  for (const edit of plan.shaEdits) {
    const filePath = path.join(plan.repoRoot, edit.file);
    const next = fs.readFileSync(filePath, 'utf8').split(plan.oldSha256).join(plan.newSha256);
    fs.writeFileSync(filePath, next);
  }
  fs.copyFileSync(plan.wheel.copyFrom, plan.wheel.copyTo);
  if (fs.existsSync(plan.wheel.removeOld) && plan.wheel.removeOld !== plan.wheel.copyTo) {
    fs.rmSync(plan.wheel.removeOld);
  }

  const residue = verifyNoOldVersionResidue(plan);
  if (residue.length > 0) {
    throw new Error(
      `BUMP APPLIED BUT VERIFICATION FAILED — fix by hand before committing:\n  - ${residue.join('\n  - ')}`
    );
  }
  return { dryRun: false, actions, verified: true };
}

/** Re-read every carrier + scan the live scope; returns human-readable residue findings. */
export function verifyNoOldVersionResidue(plan) {
  const findings = [];
  for (const edit of [...plan.versionEdits, ...plan.shaEdits]) {
    const content = fs.readFileSync(path.join(plan.repoRoot, edit.file), 'utf8');
    if (!plan.sameVersionRepin && content.includes(plan.oldVersion)) {
      findings.push(`old version still present in ${edit.file}`);
    }
    if (content.includes(plan.oldSha256)) findings.push(`old wheel sha still present in ${edit.file}`);
  }
  const pin = readCurrentHermesPin(plan.repoRoot);
  if (pin.version !== plan.targetVersion)
    findings.push(`DEFAULT_HERMES_VERSION is '${pin.version}', expected '${plan.targetVersion}'`);
  if (pin.sha256 !== plan.newSha256)
    findings.push('COMMAND_EVE_BUNDLED_HERMES_WHEEL_SHA256 does not match the computed wheel sha');
  // Hermes-specific residue scan over the LIVE scope (docs/ excluded on
  // purpose — history keeps its numbers). A bare repo-wide grep for the old
  // X.Y.Z would false-positive on unrelated dependency versions, so the scan
  // is anchored to the hermes package spellings.
  const needles = plan.sameVersionRepin ? [] : [`hermes_agent-${plan.oldVersion}`, `hermes-agent==${plan.oldVersion}`];
  for (const scopeDir of ['packages', 'tests', 'scripts', 'public', BUNDLED_HERMES_DIR]) {
    scanTree(path.join(plan.repoRoot, scopeDir), (filePath) => {
      const relative = path.relative(plan.repoRoot, filePath);
      for (const needle of needles) {
        if (path.basename(filePath).includes(needle)) findings.push(`old wheel file still present: ${relative}`);
      }
      if (!/\.(ts|tsx|mjs|js|json|sh|yml|yaml)$/.test(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      for (const needle of needles) {
        if (content.includes(needle)) findings.push(`'${needle}' still referenced in ${relative}`);
      }
    });
  }
  if (!fs.existsSync(plan.wheel.copyTo)) findings.push('new bundled wheel missing after copy');
  return findings;
}

function scanTree(root, visit) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (path.basename(current) === 'node_modules') continue;
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    } else if (stat.isFile()) {
      visit(current);
    }
  }
}
