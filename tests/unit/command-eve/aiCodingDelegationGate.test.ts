/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ai-coding-delegation — permission-GOVERNANCE posture (Codex C2, refined 2026-07-06).
 *
 * The original C2 finding: the bundled skill drove a coding CLI with
 * `--dangerously-skip-permissions` AND told EVE the safe option was "WRONG for
 * automation" and to arrow Down past the warning — a blind gate-OFF, on any seat.
 *
 * 1.819 curator hardening: this bundled chat skill is now the supervised tmux
 * lane only. Broader autonomous work belongs to the native scoped delegation
 * runtime. The public skill must neither disable permissions nor teach raw API
 * credential injection or unbounded child fleets.
 *
 * MAT-1751 correction 11: this suite itself carried a false model. It demanded the
 * `disable_model_invocation` frontmatter key from every catalog-gated skill, including
 * 'plaud-recording-ingest', and that assertion had failed for the whole workstream while
 * being written off as "a known pre-existing failure". It was not a defect to route
 * around — the TEST was wrong, on two counts, and the two lists are now separate:
 *   * CATALOG_GATED_SKILL_IDS      -> `default_state: 'gated'`, the control that is REAL
 *   * SKILL_IDS_REQUIRING_...      -> the frontmatter key, a REPO-ONLY curation contract
 * See the three tests marked (MAT-1751 correction 11b/11c/11d).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMAND_EVE_CAPABILITY_PACK,
  EVE_STRATEGY_SKILL_IDS as RUNTIME_STRATEGY_SKILL_IDS,
} from '@/process/commandEve/runtimeBootstrapCore';
import {
  EVE_STRATEGY_SKILL_IDS as STAGED_STRATEGY_SKILL_IDS,
  SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION,
} from '../../../scripts/fetch-bundled-skills.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKILL_PATH = path.join(REPO_ROOT, 'resources/bundled-skills/ai-coding-delegation/SKILL.md');
const skillBody = () => fs.readFileSync(SKILL_PATH, 'utf8');
const bundledSkillBody = (id: string) =>
  fs.readFileSync(path.join(REPO_ROOT, `resources/bundled-skills/${id}/SKILL.md`), 'utf8');
const aiCodingSkill = () => DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((s) => s.id === 'ai-coding-delegation');
const catalogEntry = (id: string) => DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((skill) => skill.id === id);

/**
 * CATALOG GATING — the protection that is actually REAL.
 *
 * Every id here must carry `default_state: 'gated'` in the capability catalog. That is a
 * product-side switch the runtime genuinely honours, and it is what keeps a sensitive or
 * high-impact skill off by default.
 *
 * This list is deliberately NOT the same list as the frontmatter-key list below. It used to
 * be, and that conflation is what made this suite assert a falsehood about PLAUD for the
 * whole of MAT-1751 — see the two tests marked (MAT-1751 correction 11) further down.
 */
const CATALOG_GATED_SKILL_IDS = [
  'ai-coding-delegation',
  'human-design-profile',
  'local-vision-qa',
  'plaud-recording-ingest',
  'skill-authoring',
  'legal-enforcement-dach',
] as const;

/**
 * Counts occurrences of a literal string across every Python module inside the bundled
 * Hermes wheel — the runtime that actually loads these SKILL.md files at run time.
 */
const hermesWheelOccurrences = (needle: string): number => {
  const whl = path.join(REPO_ROOT, 'resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl');
  expect(fs.existsSync(whl), 'the bundled Hermes 0.17 wheel must be present for this proof').toBe(true);
  const sources = execFileSync('unzip', ['-p', whl, '*.py'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return sources.split(needle).length - 1;
};

describe('ai-coding-delegation — permission-governance posture', () => {
  it('is a GATED capability, never an always-on default', () => {
    const skill = aiCodingSkill();
    expect(skill).toBeDefined();
    expect(skill?.default_state).toBe('gated');
    expect(skill?.default_state).not.toBe('active');
  });

  it('never teaches the rubber-stamp anti-pattern (blindly accepting a permission/bypass warning)', () => {
    const body = skillBody();
    expect(body).not.toContain('WRONG for automation');
    expect(body).not.toMatch(/Bypass-permissions warning/i);
    // "arrow Down to the accept option" style auto-clicking of a permission/bypass warning.
    expect(body).not.toMatch(/arrow\s+\**Down\**\s+to the accept option/i);
  });

  it('encodes the EVE-as-judging-gate model (HG-3.5), not a gate-off', () => {
    const body = skillBody();
    expect(body).toMatch(/EVE is the gate/i);
    expect(body).toMatch(/HG-3\.5/);
    expect(body).toMatch(/escalat/i);
    expect(body).toMatch(/injection|goal drift/i);
    // The doc must name the anti-pattern explicitly so the posture is unmistakable.
    expect(body).toMatch(/rubber-stamp/i);
  });

  it('keeps the inviolable hard floors and routes autonomy to the native runtime', () => {
    const body = skillBody();
    expect(body).toMatch(/hard floor/i);
    expect(body).toMatch(/publish|deploy|production/i);
    expect(body).toMatch(/secret|credential/i);
    expect(body).toMatch(/another client('|’)?s? seat|another seat/i);
    expect(body).toMatch(/native scoped delegation runtime/i);
    expect(body).toMatch(/capacity/i);
  });

  it('never teaches permission bypass, raw API credential injection or an unbounded fleet', () => {
    const body = skillBody();
    expect(body).not.toContain('--dangerously-skip-permissions');
    expect(body).not.toMatch(/ANTHROPIC_API_KEY\s*=/);
    expect(body).not.toMatch(/use sub-agents|may spawn sub-agents/i);
    expect(body).toMatch(/at most two tmux coding workers/i);
  });

  it('gates child coordination on GOVERNANCE, not a blanket ban (MAT-1751)', () => {
    // The blanket "never let either worker create children of its own" contradicted the
    // orchestration doctrine: a GOVERNED CEO lane coordinating bounded workers is the
    // doctrine. The replacement must be conditional, and must still fence the ungoverned case.
    const body = skillBody();
    expect(body).not.toMatch(/never let (either|any) worker create\s+children/i);
    expect(body).not.toMatch(/[Dd]o not ask the worker to spawn sub-agents/);
    expect(body).toMatch(/may coordinate children depends on whether it is governed/i);
    expect(body).toMatch(/declared scope/i);
    expect(body).toMatch(/declared budget/i);
    expect(body).toMatch(/capacity check/i);
    // The ungoverned case is still fenced.
    expect(body).toMatch(/ungoverned[\s\S]{0,220}never creates children of its own/i);
  });

  it('never orders an unconditional teardown — the session is an asset kept to a real boundary', () => {
    // Baseline 891d126b said "Then always tear down the session:" after every task, which
    // threw away the repo context the operator just paid for. No unconditional form survives.
    const body = skillBody();
    expect(body).not.toMatch(/always tear down/i);
    expect(body).not.toMatch(/then always (tear|clean|kill)/i);
    expect(body).not.toMatch(/^## Verify, then clean up$/m);
    expect(body).toMatch(/Keep it while the workstream is live/i);
    expect(body).toMatch(/real boundary/i);
    expect(body).toMatch(/Finishing one task is not a\s+boundary/i);
  });
});

describe('Command EVE 1.819 skill curation', () => {
  it('keeps the public capability artifact byte-for-byte equivalent to the runtime pack', () => {
    const publicPack = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../public/command-eve-capabilities.json'), 'utf8')
    );
    expect(publicPack).toEqual(DEFAULT_COMMAND_EVE_CAPABILITY_PACK);
  });

  it('keeps the build allowlist, runtime copy allowlist and capability catalog in lockstep', () => {
    expect(STAGED_STRATEGY_SKILL_IDS).toEqual([...RUNTIME_STRATEGY_SKILL_IDS]);
    const catalog = new Map(DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.map((skill) => [skill.id, skill]));
    expect(new Set(DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.map((skill) => skill.id)).size).toBe(
      DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.length
    );
    for (const id of RUNTIME_STRATEGY_SKILL_IDS) {
      const skill = catalog.get(id);
      expect(skill, `${id} must have a user-facing catalog card`).toBeDefined();
      expect(skill?.name.trim(), `${id} must have a readable name`).not.toBe(id);
      expect(skill?.source.trim(), `${id} must name its provenance`).not.toBe('');
    }
  });

  it('quarantines the unreviewed outbound bundle and removes stale prompt-only labels', () => {
    expect(RUNTIME_STRATEGY_SKILL_IDS).not.toContain('marketing-outbound');
    expect(STAGED_STRATEGY_SKILL_IDS).not.toContain('marketing-outbound');
    const catalogIds = DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.map((skill) => skill.id);
    expect(catalogIds).not.toContain('marketing-outbound');
    expect(catalogIds).not.toContain('blog-department');
    expect(catalogIds).not.toContain('department-pack-creator');
  });

  it('keeps sensitive or high-impact skills GATED in the catalog', () => {
    // Gating is the real protection and it is asserted for every sensitive skill,
    // PLAUD included. It is a catalog switch — nothing about frontmatter.
    for (const id of CATALOG_GATED_SKILL_IDS) {
      expect(catalogEntry(id)?.default_state, id).toBe('gated');
    }
  });

  it('requires the disable_model_invocation frontmatter key ONLY where curation declares it (MAT-1751 correction 11b)', () => {
    // WAS WRONG until MAT-1751: this loop ran over the catalog-gated list above and demanded
    // `disable_model_invocation: true` from all six, including 'plaud-recording-ingest'. That
    // assertion failed for this entire workstream and was repeatedly excused as "a known
    // pre-existing failure". It was not pre-existing — the TEST's model was wrong:
    //
    //   a. PLAUD was handed off under a contract requiring STANDARD Agent Skills frontmatter.
    //      A bespoke key would break the contract it was handed off under — which is why
    //      plaudRecordingIngestSkill.test.ts:68 asserts the exact OPPOSITE
    //      (`expect(skill).not.toContain('disable_model_invocation:')`). Two tests in this
    //      repo demanded contradictory things; only one of them can be right, and the
    //      handed-off contract wins.
    //   b. The key is not a runtime control at all — see the next test.
    //
    // The single source of truth is the curation list the build gate actually enforces
    // (scripts/fetch-bundled-skills.mjs). Asserting against the exported constant instead of
    // a hand-copied local array is what stops this drifting apart again.
    expect(SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION).not.toContain('plaud-recording-ingest');
    expect(SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION.length).toBeGreaterThan(0);
    for (const id of SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION) {
      expect(bundledSkillBody(id), id).toMatch(/^disable_model_invocation:\s*true$/m);
    }
  });

  it('keeps PLAUD catalog-gated while it carries STANDARD Agent Skills frontmatter (MAT-1751 correction 11c)', () => {
    // Pins the protection that GENUINELY exists, rather than merely no longer contradicting it.
    // PLAUD is gated in BOTH the runtime pack and the published artifact, and its frontmatter
    // stays standard: name + description only, no bespoke Command-EVE keys.
    expect(catalogEntry('plaud-recording-ingest')?.default_state).toBe('gated');
    const published = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'public/command-eve-capabilities.json'), 'utf8')
    ) as { skills: Array<{ id: string; default_state: string }> };
    expect(published.skills.find((skill) => skill.id === 'plaud-recording-ingest')?.default_state).toBe('gated');

    const frontmatter = bundledSkillBody('plaud-recording-ingest').split(/^---$/m)[1] ?? '';
    expect(frontmatter.trim()).not.toBe('');
    expect(frontmatter).toMatch(/^name:\s*plaud-recording-ingest$/m);
    expect(frontmatter).toMatch(/^description:\s*\S/m);
    expect(frontmatter).not.toMatch(/disable_model_invocation/);
    expect(frontmatter).not.toMatch(/linked_files/);
    // Standard keys only — the top-level key set must not grow bespoke entries.
    const topLevelKeys = frontmatter
      .split('\n')
      .map((line) => /^([a-z_][a-z0-9_-]*):/i.exec(line)?.[1])
      .filter((key): key is string => Boolean(key));
    expect(topLevelKeys.sort()).toEqual(['description', 'name']);
  });

  it('records that disable_model_invocation is a REPO-ONLY curation key, never a Hermes runtime control (MAT-1751 correction 11d)', () => {
    // FACT, executed against resources/bundled-hermes/hermes_agent-0.20.0-py3-none-any.whl —
    // the runtime that actually loads these SKILL.md files: the string
    // `disable_model_invocation` occurs ZERO times in the entire wheel. Hermes 0.17 parses
    // frontmatter (parse_frontmatter) and honours `name`, `description`, `platforms`,
    // `environments` and `metadata.hermes.*` (agent/skill_utils.py) — it never reads this key.
    //
    // So the key controls NOTHING at run time. It is a repo-side curation contract, enforced
    // only by the build gate in scripts/fetch-bundled-skills.mjs. Asserting it as if it were
    // a runtime control — which this suite did for PLAUD — teaches every future reader that
    // the key does something it does not do. The control that DOES exist is catalog gating,
    // pinned in the test above.
    expect(hermesWheelOccurrences('disable_model_invocation')).toBe(0);
    // Positive controls: the scan really does read the wheel's Python sources, so the zero
    // above is evidence of absence and not evidence of a silently broken scan.
    expect(hermesWheelOccurrences('parse_frontmatter')).toBeGreaterThan(0);
    expect(hermesWheelOccurrences('get_disabled_skill_names')).toBeGreaterThan(0);

    // And the key's only enforcement point lives in the repo's own build gate.
    const gate = fs.readFileSync(path.join(REPO_ROOT, 'scripts/fetch-bundled-skills.mjs'), 'utf8');
    expect(gate).toMatch(/disable_model_invocation_missing/);
  });

  it('leaves the managed visual direction workflow active without enabling local-model fallback', () => {
    const visualDirection = DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find(
      (skill) => skill.id === 'visual-direction-gate'
    );
    const localVision = DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((skill) => skill.id === 'local-vision-qa');
    const presentationStudio = DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find(
      (skill) => skill.id === 'presentation-studio'
    );
    expect(visualDirection?.default_state).toBe('active');
    expect(presentationStudio?.default_state).toBe('active');
    expect(localVision?.default_state).toBe('gated');
  });
});
