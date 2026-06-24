/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COMMAND_EVE_ONBOARDING_STEP_MARKER,
  EVE_STRATEGY_SKILL_IDS,
  commandEveOnboardingSkillMarkdown,
  commandEveOnboardingStepScreenHtml,
  copyBundledStrategySkills,
  eveSelectedLanguageDirective,
  resolveBundledSkillsDir,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@/process/commandEve/runtimeBootstrapCore';
import { buildCommandEvePromptProof } from '@/process/commandEve/ollamaOpenAiShim';
import {
  COMMAND_EVE_ASSISTANT_RULE_DE,
  COMMAND_EVE_ASSISTANT_RULE_EN,
} from '@/process/commandEve/assistantBootstrapCore';

// =========================================================================
// EVE SOUL-WIRING self-detection gate (founder-self-detection-standard).
//
// The whole point of this slice is that the running Hermes agent reads EVE's
// REAL identity (SOUL.md) and runs with the learning loop ON — not the prior
// 5-line stub with the loop killed (reasoning_effort:none, creation_nudge:0,
// no memory/curator). The founder-self-detection-standard says a failure the
// system FAILS TO SELF-DETECT is worse than the bug. So these tests are the
// regression TRIPWIRE: if the soul silently drifts back to a thin stub, or any
// learning switch silently flips off, the build MUST break here and be VISIBLE.
//
// EVE_SOUL_MARKDOWN and writeHermesRuntimeFiles are module-private (not
// exported), and the full bootstrap is an async side-effecting flow, so for the
// soul-text + config-emission assertions we read the SOURCE literal directly —
// the same fail-closed, un-mockable invariant pattern the marketing-gate test
// uses (commandEveChatMarketingGate.test.ts). The skill-copy / resolver / shim
// assertions exercise the real EXPORTED functions against fixtures.
// =========================================================================

const RUNTIME_BOOTSTRAP_SOURCE_PATH = path.resolve(
  __dirname,
  '../../../packages/desktop/src/process/commandEve/runtimeBootstrapCore.ts'
);

const stripComments = (source: string): string =>
  source
    // block comments
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // line comments (keep "://" intact so http(s) URLs survive)
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const RUNTIME_SOURCE_RAW = fs.readFileSync(RUNTIME_BOOTSTRAP_SOURCE_PATH, 'utf8');
const RUNTIME_SOURCE_CODE = stripComments(RUNTIME_SOURCE_RAW);

// Extract the EVE_SOUL_MARKDOWN template-literal body so we assert on the soul
// PROSE, not on comments that merely mention these phrases.
const extractSoulMarkdown = (raw: string): string => {
  const marker = 'const EVE_SOUL_MARKDOWN = `';
  const start = raw.indexOf(marker);
  expect(start, 'EVE_SOUL_MARKDOWN literal must exist in runtimeBootstrapCore.ts').toBeGreaterThan(-1);
  const bodyStart = start + marker.length;
  const end = raw.indexOf('`;', bodyStart);
  expect(end, 'EVE_SOUL_MARKDOWN literal must be terminated').toBeGreaterThan(bodyStart);
  return raw.slice(bodyStart, end);
};

const SOUL_MARKDOWN = extractSoulMarkdown(RUNTIME_SOURCE_RAW);

describe('EVE soul-wiring: SOUL.md self-detection tripwire', () => {
  it('is the SLIM Nous-shape soul (voice-only), not the old overloaded file', () => {
    // Nous guide: SOUL.md is voice/identity only; ops belong in skills/AGENTS. The
    // redesign slimmed it from ~9k chars / 12 sections to a focused ~5k. Guard BOTH
    // ends: substantial (not the 5-line stub) AND not re-overloaded.
    expect(SOUL_MARKDOWN.length).toBeGreaterThan(2500);
    expect(SOUL_MARKDOWN.length, 'SOUL.md must stay slim/voice-only — put ops in skills, not here').toBeLessThan(7500);
    expect((SOUL_MARKDOWN.match(/^## /gm) || []).length).toBeGreaterThanOrEqual(6);
  });

  it('moved the OPERATIONAL bulk OUT (no toolbelt catalog, onboarding audit, method, or env recital)', () => {
    // The audit-on-a-greeting bug came from operational instructions sitting in the
    // always-on slot-#1 identity. They now live in skills; the SOUL must not carry them.
    expect(SOUL_MARKDOWN).not.toMatch(/^## Toolbelt/m);
    expect(SOUL_MARKDOWN).not.toMatch(/## Onboarding the operator/i);
    expect(SOUL_MARKDOWN).not.toMatch(/## Operating environment/i);
    expect(SOUL_MARKDOWN).not.toMatch(/VISION .* VERSIONS .* MILESTONES/);
  });

  it('carries The Operator identity + who-she-is-for-the-operator + the 14-day north star', () => {
    expect(SOUL_MARKDOWN).toContain('# EVE SOUL');
    expect(SOUL_MARKDOWN).toContain('The Operator');
    expect(SOUL_MARKDOWN).toContain('JARVIS for making money');
    expect(SOUL_MARKDOWN).toMatch(/chief-of-staff|Chief of Staff/i);
    expect(SOUL_MARKDOWN).toContain('go offline for 14 days');
    expect(SOUL_MARKDOWN).toMatch(/operator is the brand/i);
  });

  it('is a directive character FRAME, not a recitable script', () => {
    expect(SOUL_MARKDOWN).toMatch(/never recite, quote, paraphrase, or read this/i);
    expect(SOUL_MARKDOWN).toMatch(/in your OWN natural words/i);
    expect(SOUL_MARKDOWN).not.toMatch(/^I am \*\*EVE/m);
  });

  it('carries the THREE register modes + the no-audit-on-a-greeting fix (the register keystone)', () => {
    // The structural fix for "audits a casual greeting": modes, Confidant as the
    // default for smalltalk, and an explicit ban on auditing a greeting.
    expect(SOUL_MARKDOWN).toMatch(/How you show up/i);
    expect(SOUL_MARKDOWN).toMatch(/\bConfidant\b/);
    expect(SOUL_MARKDOWN).toMatch(/\bChallenger\b/);
    expect(SOUL_MARKDOWN).toMatch(/Operator-coach/i);
    expect(SOUL_MARKDOWN).toMatch(/NEVER answer smalltalk with a status report[\s\S]*menu/i);
  });

  it('carries the Avoid / forbidden-voice list (anti-hype, anti-over-structuring)', () => {
    expect(SOUL_MARKDOWN).toMatch(/## Avoid/);
    expect(SOUL_MARKDOWN).toContain('leverage');
    expect(SOUL_MARKDOWN).toMatch(/claim[\s\S]*evidence[\s\S]*move on/i);
    expect(SOUL_MARKDOWN).toMatch(/no numbered menu unless/i);
  });

  it('carries a sharp, falsifiable worldview (not generic filler)', () => {
    const beliefs = [
      'Simplicity is strategy',
      'Growth by subtraction',
      'Plumbing before water',
      'ONE bottleneck',
      'the operator is the bottleneck',
    ];
    expect(beliefs.filter((b) => SOUL_MARKDOWN.includes(b)).length).toBeGreaterThanOrEqual(3);
  });

  it('carries the boundaries: invisible delivery + per-client isolation + never-move-money + secrets', () => {
    expect(SOUL_MARKDOWN).toMatch(/invisible[ -]delivery/i);
    expect(SOUL_MARKDOWN).toMatch(/per-client isolation/i);
    expect(SOUL_MARKDOWN).toMatch(/never move money/i);
    expect(SOUL_MARKDOWN).toMatch(/raw secrets/i);
  });

  it('carries the self-learning memory line (USER.md / MEMORY.md, skill-on-repeat, honesty)', () => {
    expect(SOUL_MARKDOWN).toMatch(/How you learn/i);
    expect(SOUL_MARKDOWN).toContain('USER.md');
    expect(SOUL_MARKDOWN).toContain('MEMORY.md');
    expect(SOUL_MARKDOWN).toMatch(/turn it into a skill/i);
    expect(SOUL_MARKDOWN).toMatch(/never claim it before it has run/i);
  });

  it('makes the honesty wall the DEFINING trait (configured-not-proven; no reasoning over-claim)', () => {
    expect(SOUL_MARKDOWN).toMatch(/honesty wall/i);
    expect(SOUL_MARKDOWN).toMatch(/the trait that defines you/i);
    expect(SOUL_MARKDOWN).toContain('configured, not yet proven');
    expect(SOUL_MARKDOWN).toMatch(/FACT \/ INFERENCE \/ HYPOTHESIS/);
    expect(SOUL_MARKDOWN).not.toMatch(/reasoning is on/i);
    expect(SOUL_MARKDOWN).toMatch(/under-claim than oversell/i);
  });
});
describe('EVE soul-wiring: config.yaml emission self-detection (the loop-is-ON proof)', () => {
  // Assert on the emitted config array source (comments stripped) so a mention
  // inside a comment can never satisfy the gate.
  it('emits reasoning_effort that is NOT "none"', () => {
    // The agent: block must use the tier-keyed variable, never the literal none.
    expect(RUNTIME_SOURCE_CODE).toContain('`  reasoning_effort: ${reasoningEffort}`');
    expect(RUNTIME_SOURCE_CODE).not.toContain("'  reasoning_effort: none'");
    expect(RUNTIME_SOURCE_CODE).not.toContain('`  reasoning_effort: none`');
    // The default the founder single-tenant build ships must still THINK.
    expect(RUNTIME_SOURCE_CODE).toMatch(
      /DEFAULT_COMMAND_EVE_REASONING_EFFORT[^=]*=\s*'(low|medium|high|xhigh)'/
    );
  });

  it('emits the creation_nudge_interval as the tier-keyed variable (not a hard 0 kill-switch)', () => {
    expect(RUNTIME_SOURCE_CODE).toContain('`  creation_nudge_interval: ${creationNudgeInterval}`');
    expect(RUNTIME_SOURCE_CODE).not.toContain("'  creation_nudge_interval: 0'");
  });

  it('ships the self-improvement loop ON: the DEFAULT creation_nudge_interval is > 0', () => {
    // The exact no-op the adversarial verify caught: the emission used the variable,
    // but the variable's DEFAULT was 0 -> the loop shipped OFF (the original defect).
    // creation_nudge_interval IS read on the ACP chat lane (AIAgent.__init__ ->
    // init_agent -> agent._skill_nudge_interval, agent_init.py:1190-1193; spawned in
    // conversation_loop.py:831,4553), so a 0 default = the soul lies. Lock it > 0.
    const m = RUNTIME_SOURCE_CODE.match(
      /DEFAULT_COMMAND_EVE_CREATION_NUDGE_INTERVAL\s*=\s*(\d+)/
    );
    expect(m, 'DEFAULT_COMMAND_EVE_CREATION_NUDGE_INTERVAL must be a numeric literal').not.toBeNull();
    expect(Number(m![1]), 'the self-improvement loop must ship ON (interval > 0)').toBeGreaterThan(0);
  });

  it('emits the memory block ON (memory_enabled + user_profile_enabled + nudge_interval)', () => {
    expect(RUNTIME_SOURCE_CODE).toContain("'memory:'");
    expect(RUNTIME_SOURCE_CODE).toContain("'  memory_enabled: true'");
    expect(RUNTIME_SOURCE_CODE).toContain("'  user_profile_enabled: true'");
    expect(RUNTIME_SOURCE_CODE).toContain("'  nudge_interval: 10'");
  });

  it('emits curator ON (the self-optimize half of the loop)', () => {
    expect(RUNTIME_SOURCE_CODE).toContain("'curator:'");
    expect(RUNTIME_SOURCE_CODE).toContain("'  enabled: true'");
  });

  it('emits kanban auto_decompose ON (vision->versions->milestones->child)', () => {
    expect(RUNTIME_SOURCE_CODE).toContain("'  auto_decompose: true'");
    expect(RUNTIME_SOURCE_CODE).not.toContain("'  auto_decompose: false'");
  });

  it('writes the composed soul to SOUL.md (not a stub literal)', () => {
    expect(RUNTIME_SOURCE_CODE).toMatch(/['"]SOUL\.md['"]\),\s*EVE_SOUL_MARKDOWN/);
  });
});

describe('EVE soul-wiring: bundled strategy skills copy (real, additive, fail-closed)', () => {
  const makeFixture = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-soul-bundle-'));
    const bundledSkillsDir = path.join(root, 'bundled-skills');
    fs.mkdirSync(bundledSkillsDir, { recursive: true });
    // 14 single-folder skills.
    for (const id of EVE_STRATEGY_SKILL_IDS) {
      if (id === 'marketing-outbound') continue;
      const dir = path.join(bundledSkillsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${id}\nReal strategy skill content for ${id}.\n`);
    }
    // marketing-outbound is a BUNDLE: no top-level SKILL.md, nested sub-skills.
    const moRoot = path.join(bundledSkillsDir, 'marketing-outbound');
    const sub1 = path.join(moRoot, 'icp-definer');
    const sub2 = path.join(moRoot, 'copywriting-linkedin-dm');
    fs.mkdirSync(sub1, { recursive: true });
    fs.mkdirSync(sub2, { recursive: true });
    fs.writeFileSync(path.join(sub1, 'SKILL.md'), '# icp-definer\nnested sub-skill\n');
    fs.writeFileSync(path.join(sub2, 'SKILL.md'), '# copywriting-linkedin-dm\nnested sub-skill\n');

    const paths = resolveCommandEveRuntimeBootstrapPaths(path.join(root, 'userData'));
    return { root, bundledSkillsDir, paths };
  };

  it('lands all 15 allowlisted strategy skills with real (non-stub) content', () => {
    const { root, bundledSkillsDir, paths } = makeFixture();
    try {
      const failures = copyBundledStrategySkills(paths, bundledSkillsDir);
      expect(failures).toEqual([]);
      for (const id of EVE_STRATEGY_SKILL_IDS) {
        if (id === 'marketing-outbound') continue;
        const dest = path.join(paths.managedSkillsRoot, id, 'SKILL.md');
        expect(fs.existsSync(dest), `${id}/SKILL.md must land`).toBe(true);
        expect(fs.readFileSync(dest, 'utf8')).toContain(`Real strategy skill content for ${id}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('copies marketing-outbound whole-tree (nested sub-skill SKILL.md files travel)', () => {
    const { root, bundledSkillsDir, paths } = makeFixture();
    try {
      copyBundledStrategySkills(paths, bundledSkillsDir);
      const moDest = path.join(paths.managedSkillsRoot, 'marketing-outbound');
      expect(fs.existsSync(path.join(moDest, 'icp-definer', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(moDest, 'copywriting-linkedin-dm', 'SKILL.md'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('FAILS CLOSED with a visible failure when an allowlisted skill is missing (no silent stub)', () => {
    const { root, bundledSkillsDir, paths } = makeFixture();
    try {
      // Remove one strategy skill from the snapshot — the founder-self-detection
      // case: a silent miss must BREAK and be VISIBLE, not fall back to a stub.
      fs.rmSync(path.join(bundledSkillsDir, 'pre-mortem'), { recursive: true, force: true });
      const failures = copyBundledStrategySkills(paths, bundledSkillsDir);
      expect(failures).toContain('capabilities.bundled_skill_missing:pre-mortem');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('no-ops (no failures) when no bundled-skills dir is resolved (bare env, snapshot-less)', () => {
    const { root, paths } = makeFixture();
    try {
      expect(copyBundledStrategySkills(paths, '')).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('EVE soul-wiring: resolveBundledSkillsDir resolution order', () => {
  it('prefers COMMAND_EVE_SKILLS_DIR env, then resourcesPath, then cwd/resources', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-soul-resolve-'));
    try {
      const envDir = path.join(root, 'env-skills');
      const resourcesDir = path.join(root, 'res');
      fs.mkdirSync(envDir, { recursive: true });
      fs.mkdirSync(path.join(resourcesDir, 'bundled-skills'), { recursive: true });

      // env wins when present.
      expect(resolveBundledSkillsDir({ COMMAND_EVE_SKILLS_DIR: envDir }, resourcesDir)).toBe(envDir);
      // resourcesPath wins when env absent.
      expect(resolveBundledSkillsDir({}, resourcesDir)).toBe(path.join(resourcesDir, 'bundled-skills'));
      // empty string when neither env, resourcesPath, nor cwd/resources exists.
      const nonexistentResources = path.join(root, 'nope');
      const result = resolveBundledSkillsDir({}, nonexistentResources);
      // cwd/resources/bundled-skills IS committed in this repo, so the dev
      // fallback legitimately resolves; assert it never returns the missing path.
      expect(result).not.toBe(path.join(nonexistentResources, 'bundled-skills'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('EVE soul-wiring: prompt-proof shim covers the soul (self-detection stays green)', () => {
  it('classifies the new SOUL text as marker "eve_soul" (not "none")', () => {
    const proof = buildCommandEvePromptProof({
      messages: [
        { role: 'system', content: SOUL_MARKDOWN },
        { role: 'user', content: 'where are we?' },
      ],
    });
    expect(proof.marker).toBe('eve_soul');
    expect(proof.ok).toBe(true);
  });

  it('still classifies the internal EVE Operating Rule (the rule resource still stacks)', () => {
    const proof = buildCommandEvePromptProof({
      messages: [{ role: 'system', content: COMMAND_EVE_ASSISTANT_RULE_EN }],
    });
    expect(proof.marker).toBe('eve_operating_rule');
    expect(proof.ok).toBe(true);
  });

  it('marks "none" only when no EVE identity is present', () => {
    const proof = buildCommandEvePromptProof({
      messages: [{ role: 'user', content: 'hello there' }],
    });
    expect(proof.marker).toBe('none');
    expect(proof.ok).toBe(false);
  });
});

describe('EVE soul-wiring: internal Operating Rule reconciled to defer to SOUL.md', () => {
  it('scopes the rule as the internal layer that defers to the soul (DE + EN)', () => {
    // Reconcile invariant: the internal orchestration rule must NOT present a
    // second competing identity — it explicitly defers to SOUL.md and yields on
    // conflict. It must NOT itself carry the soul's identity cues, so the
    // prompt-proof can still distinguish the rule resource from the soul.
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toContain('SOUL.md');
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toMatch(/identity[\s\S]*live[\s\S]*soul/i);
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toMatch(/when they conflict, SOUL\.md wins/i);
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).not.toContain('The Operator');
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toContain('SOUL.md');
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toMatch(/gewinnt SOUL\.md/i);
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).not.toContain('The Operator');
  });

  it('keeps the load-bearing "# EVE Operating Rule" heading (shim marker contract)', () => {
    expect(COMMAND_EVE_ASSISTANT_RULE_EN.startsWith('# EVE Operating Rule')).toBe(true);
    expect(COMMAND_EVE_ASSISTANT_RULE_DE.startsWith('# EVE Operating Rule')).toBe(true);
  });

  it('preserves the no-secrets / gate boundaries (consumers + existing invariants unbroken)', () => {
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toContain('You do not set Plane items to Done');
    expect(COMMAND_EVE_ASSISTANT_RULE_EN).toContain('raw tokens');
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toContain('Du setzt keine Plane-Items auf Done');
    expect(COMMAND_EVE_ASSISTANT_RULE_DE).toContain('Passwoertern');
  });
});

// =========================================================================
// Guided Onboarding SLICE S1 self-detection gate.
//
// S1 adds (a) an APP-OWNED config-awareness onboarding skill emitted into the
// managed skills dir the agent reads, and (b) a directive SOUL posture block.
// These tripwires break VISIBLY if the skill drifts into asking for a secret, if
// it is wrongly added to the length-15-asserted strategy allowlist, or if the
// SOUL posture loses its honesty/cloud-default/no-secret guards.
// =========================================================================

describe('EVE onboarding S1: app-owned config-awareness skill (separate from the strategy allowlist)', () => {
  const SKILL_MD = commandEveOnboardingSkillMarkdown();

  it('is its own app-owned skill, NOT in EVE_STRATEGY_SKILL_IDS (allowlist stays at 15)', () => {
    expect(EVE_STRATEGY_SKILL_IDS).toHaveLength(15);
    expect(EVE_STRATEGY_SKILL_IDS as readonly string[]).not.toContain('eve-onboarding-awareness');
  });

  it('carries a valid SKILL.md frontmatter naming the app-owned skill id', () => {
    expect(SKILL_MD.startsWith('---\nname: eve-onboarding-awareness\n')).toBe(true);
    expect(SKILL_MD).toMatch(/^description: /m);
  });

  it('teaches EVE to read her status SILENTLY and surface it only when relevant', () => {
    expect(SKILL_MD).toContain('command-eve.onboarding-status');
    expect(SKILL_MD).toMatch(/Read it SILENTLY/i);
    expect(SKILL_MD).toMatch(/surface[\s\S]*only when the operator asks/i);
    expect(SKILL_MD).toMatch(/casual greeting[\s\S]*brief, warm/i);
  });

  it('defaults the operator to the cloud lane and treats local as opt-in', () => {
    expect(SKILL_MD).toMatch(/EVE Standard \(cloud\) is the default/i);
    expect(SKILL_MD).toMatch(/opt-in alternate/i);
  });

  it('maps the local block reason codes to plain steps, never a terminal command', () => {
    for (const code of ['OLLAMA_MISSING', 'MODEL_NOT_FETCHED', 'MODEL_PULL_FAILED', 'BLOCKED_RAM', 'BLOCKED_DISK', 'PYTHON_UNSUPPORTED']) {
      expect(SKILL_MD, `reason code ${code} must be mapped`).toContain(code);
    }
    expect(SKILL_MD).toMatch(/never (?:paste|hand them) a brew/i);
  });

  it('forbids ever asking for an API key/secret', () => {
    expect(SKILL_MD).toMatch(/never ask for/i);
    expect(SKILL_MD).toContain('API key');
    expect(SKILL_MD).toMatch(/paste the CEVE license/i);
  });

  it('keeps the honesty wall for this lane (no seed-learning / connector claim)', () => {
    expect(SKILL_MD).toMatch(/FACT \/ INFERENCE \/ HYPOTHESIS/);
    expect(SKILL_MD).toMatch(/not built/i);
  });
});

describe('EVE onboarding S1: posture lives in the SKILL (conditional), NOT the always-on SOUL', () => {
  const SKILL_MD = commandEveOnboardingSkillMarkdown();

  it('the onboarding audit is OUT of the SOUL (it moved to the conditional skill)', () => {
    // 2026-06-24 redesign: keeping the onboarding posture in slot #1 made EVE audit
    // every greeting. It now lives ONLY in the eve-onboarding-awareness skill, fired
    // when relevant — never baked into the always-on identity.
    expect(SOUL_MARKDOWN).not.toMatch(/## Onboarding the operator/i);
    expect(SOUL_MARKDOWN).not.toMatch(/Read it BEFORE you greet/i);
    expect(SOUL_MARKDOWN).not.toMatch(/Default them to the cloud/i);
  });

  it('the SKILL carries the posture CONDITIONALLY (read silently, surface only when relevant)', () => {
    expect(SKILL_MD).toMatch(/Read silently — surface only when relevant/i);
    expect(SKILL_MD).toMatch(/Read it SILENTLY/i);
    expect(SKILL_MD).toMatch(/NEVER a status report, an audit, a challenge, or a numbered menu/i);
  });
});

// =========================================================================
// Guided Onboarding SLICE S3 self-detection gate.
//
// S3 gives EVE the onboarding.html authoring surface (taught in the app-owned
// skill) plus ONE canonical, SAFE Ollama-install step-screen template, surfaced
// via the proven preview-click chain. These tripwires break VISIBLY if the
// template ever grows a <script>, a form, a pasted terminal command, or loses its
// generated-step marker / cloud fallback — i.e. if the "static instructions, no
// secret, no command, click-the-link-yourself" contract silently drifts.
// =========================================================================

describe('EVE onboarding S3: skill teaches authoring a safe onboarding.html step-screen', () => {
  const SKILL_MD = commandEveOnboardingSkillMarkdown();

  it('teaches writing onboarding.html surfaced via the preview chain', () => {
    expect(SKILL_MD).toMatch(/## Author a step-screen as onboarding\.html/);
    expect(SKILL_MD).toContain('onboarding.html');
    expect(SKILL_MD).toMatch(/preview chain/i);
  });

  it('requires the generated-step marker and forbids embedding a terminal command', () => {
    expect(SKILL_MD).toContain('<!-- eve-onboarding-step -->');
    expect(SKILL_MD).toMatch(/never embed a brew\/pip\/terminal command/i);
  });

  it('keeps the no-script / no-secret / cloud-fallback authoring contract', () => {
    expect(SKILL_MD).toMatch(/no external scripts/i);
    expect(SKILL_MD).toMatch(/in der Cloud weiterarbeiten/);
    expect(SKILL_MD).toMatch(/does not install anything|does not mean a stage is fixed/i);
  });
});

describe('EVE onboarding S3: canonical Ollama-install step-screen template', () => {
  const HTML = commandEveOnboardingStepScreenHtml();

  it('starts with the generated-step marker so the auto-open bonus can recognise it', () => {
    expect(HTML.startsWith(COMMAND_EVE_ONBOARDING_STEP_MARKER)).toBe(true);
    expect(COMMAND_EVE_ONBOARDING_STEP_MARKER).toBe('<!-- eve-onboarding-step -->');
  });

  it('is a well-formed standalone HTML document', () => {
    expect(HTML).toMatch(/<!doctype html>/i);
    expect(HTML).toContain('<html lang="de">');
    expect(HTML).toContain('</html>');
  });

  it('links to the Ollama download for the operator to click themselves (no command to paste)', () => {
    expect(HTML).toContain('https://ollama.com/download');
    expect(HTML).toMatch(/rel="noopener noreferrer"/);
    // No pasted terminal command / package-manager invocation in the page.
    expect(HTML).not.toMatch(/brew\s+install/i);
    expect(HTML).not.toMatch(/\bpip\s+install/i);
    expect(HTML).not.toMatch(/ollama\s+(?:pull|run)/i);
  });

  it('carries NO script and NO password/key-collecting form (static instructions only)', () => {
    expect(HTML).not.toMatch(/<script/i);
    expect(HTML).not.toMatch(/<form/i);
    expect(HTML).not.toMatch(/type=["']password["']/i);
    expect(HTML).not.toMatch(/api[\s_-]?key/i);
  });

  it('keeps the warm cloud fallback (local is optional, cloud runs immediately)', () => {
    expect(HTML).toMatch(/in der Cloud weiterarbeiten/);
    expect(HTML).toMatch(/EVE Standard l[äa]uft sofort/i);
  });
});

describe('EVE soul: setting-driven language directive (appended at bootstrap)', () => {
  it('appends a German default directive for a German UI locale', () => {
    const d = eveSelectedLanguageDirective('de-DE');
    expect(d).toMatch(/selected language/i);
    expect(d).toMatch(/German \(Deutsch\)/);
    expect(d).toMatch(/default to it/i);
  });

  it('appends an English directive for a non-German UI locale', () => {
    expect(eveSelectedLanguageDirective('en-US')).toMatch(/\*\*English\*\*/);
    // a non-DE/EN locale still maps to English (EVE's supported pair)
    expect(eveSelectedLanguageDirective('tr-TR')).toMatch(/\*\*English\*\*/);
  });

  it('emits NOTHING for an empty/unknown locale (mirror-only, the prior behavior)', () => {
    expect(eveSelectedLanguageDirective('')).toBe('');
    expect(eveSelectedLanguageDirective(undefined as unknown as string)).toBe('');
  });

  it('also tells EVE to follow a mid-session language switch, and never to announce the rule', () => {
    const d = eveSelectedLanguageDirective('de-DE');
    expect(d).toMatch(/follow them/i);
    expect(d).toMatch(/[Nn]ever announce or explain this rule/);
  });
});
