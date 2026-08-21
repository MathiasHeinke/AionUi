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
  EVE_STRATEGY_SKILL_IDS,
  copyBundledStrategySkills,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@/process/commandEve/runtimeBootstrapCore';

// =========================================================================
// RPT-2 — client-report bundled skill (the in-seat client-deliverable generator).
//
// These tripwires break VISIBLY if the skill drifts from its load-bearing
// invariants: (a) it is actually bundled (in the allowlist + lands in the seat
// hermesHome via copyBundledStrategySkills); (b) it is well-formed (valid
// frontmatter + a template); (c) it is seat-fenced (active-seat-only read,
// refuse-if-no-seat); (d) it is honest (no fabricated KPIs, no "learns" claim,
// operator brand only, never names the engine).
// =========================================================================

// The committed source-of-truth snapshot copied into the app at fetch time.
const CLIENT_REPORT_DIR = path.join(process.cwd(), 'resources', 'bundled-skills', 'client-report');
const SKILL_MD = fs.readFileSync(path.join(CLIENT_REPORT_DIR, 'SKILL.md'), 'utf8');
const TEMPLATE_MD = fs.readFileSync(path.join(CLIENT_REPORT_DIR, 'report-template.md'), 'utf8');

describe('RPT-2 client-report skill: bundled into the allowlist', () => {
  it('is in EVE_STRATEGY_SKILL_IDS (so copyBundledStrategySkills copies it)', () => {
    expect(EVE_STRATEGY_SKILL_IDS as readonly string[]).toContain('client-report');
  });

  it('makes the bundled allowlist 43, including the chief-of-staff loop and production skills', () => {
    // 37 -> 38 with eve-chief-of-staff-orchestration (MAT-1751); 38 -> 39 with the
    // vendored third-party `copywriting` skill (1.820.1); 39 -> 41 with the
    // vendored `seo` + `seo-aeo-best-practices` skills (1.820.2, MAT-1769);
    // 41 -> 42 with the app-owned `office-studio` skill (1.823.0, MAT-1624);
    // 42 -> 43 with the general `editorial-pdf-design` skill (1.823.6).
    expect(EVE_STRATEGY_SKILL_IDS).toHaveLength(43);
    expect(EVE_STRATEGY_SKILL_IDS as readonly string[]).toContain('eve-chief-of-staff-orchestration');
  });

  it('lands client-report/SKILL.md + report-template.md in the seat managedSkillsRoot', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-client-report-'));
    try {
      const paths = resolveCommandEveRuntimeBootstrapPaths(root);
      const failures = copyBundledStrategySkills(paths, path.join(process.cwd(), 'resources', 'bundled-skills'));
      // The real snapshot must satisfy the bundle copy with zero missing-skill failures.
      expect(failures).not.toContain('capabilities.bundled_skill_missing:client-report');
      const destSkill = path.join(paths.managedSkillsRoot, 'client-report', 'SKILL.md');
      const destTemplate = path.join(paths.managedSkillsRoot, 'client-report', 'report-template.md');
      expect(fs.existsSync(destSkill), 'client-report/SKILL.md must land in the seat hermesHome').toBe(true);
      expect(fs.existsSync(destTemplate), 'report-template.md must travel with the skill').toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('RPT-2 client-report skill: well-formed', () => {
  it('opens with valid frontmatter naming the skill id', () => {
    expect(SKILL_MD.startsWith('---\nname: client-report\n')).toBe(true);
    expect(SKILL_MD).toMatch(/^description: /m);
  });

  it('ships a fill-in template with the report sections and brand slots', () => {
    expect(TEMPLATE_MD).toContain('## Executive summary');
    expect(TEMPLATE_MD).toContain('## Recommendations');
    expect(TEMPLATE_MD).toContain('## Next steps');
    expect(TEMPLATE_MD).toMatch(/\{\{OPERATOR_NAME\}\}/);
    expect(TEMPLATE_MD).toMatch(/\{\{CLIENT_NAME\}\}/);
  });
});

describe('RPT-2 client-report skill: seat-fenced (active seat only)', () => {
  it('instructs reading ONLY the active seat and forbids cross-seat / global reads', () => {
    expect(SKILL_MD).toMatch(/active seat/i);
    expect(SKILL_MD).toMatch(/Never read across seats/i);
    expect(SKILL_MD).toMatch(/global\/operator-wide profile|operator-wide profile/i);
  });

  it('refuses to emit when it cannot confirm one real client seat', () => {
    expect(SKILL_MD).toMatch(/Refuse to emit/i);
    expect(SKILL_MD).toMatch(/do \*\*not\*\* fabricate a client and do not emit a report|do not emit a report/i);
  });
});

describe('RPT-2 client-report skill: honesty wall', () => {
  it('forbids fabricated KPIs (numbers must be traceable or marked unknown)', () => {
    expect(SKILL_MD).toMatch(/Never fabricate a number/i);
    expect(SKILL_MD).toMatch(/traceable to a seat artifact/i);
    expect(SKILL_MD).toMatch(/unknown/);
  });

  it('makes no "learns"/remembers-beyond-disk claim (assemble, do not invent)', () => {
    expect(SKILL_MD).toMatch(/Assemble, do not invent/i);
    expect(SKILL_MD).toMatch(/do \*\*not\*\* "learn"|do not "learn"/i);
  });

  it('carries operator brand only and never names the underlying engine', () => {
    expect(SKILL_MD).toMatch(/OPERATOR's brand only/i);
    expect(SKILL_MD).toMatch(/Never name the underlying engine/i);
    expect(SKILL_MD).toMatch(/must not mention Command EVE, EVE, Hermes/);
  });

  it('does not auto-deliver — it produces a single artifact for review + export', () => {
    expect(SKILL_MD).toMatch(/single report artifact/i);
    expect(SKILL_MD).toMatch(/not auto-delivery/i);
  });
});
