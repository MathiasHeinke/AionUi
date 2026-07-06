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
 * The refined posture (founder 2026-07-06) is NOT "forbid skip-permissions" — that
 * is permission-fatigue paranoia. It is the HG-3.5 model: EVE is the discerning gate
 * (judges each action, escalates the consequential to the operator), the operator
 * chooses the autonomy level (supervised default; autonomous = explicit opt-in,
 * scope-bounded), and a set of inviolable hard floors always escalate. This test
 * locks THAT posture: the rubber-stamp anti-pattern can never return, and the
 * governance model must be present. It is a gate for the RIGHT invariants, not a
 * blanket string ban.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_EVE_CAPABILITY_PACK } from '@/process/commandEve/runtimeBootstrapCore';

const SKILL_PATH = path.resolve(__dirname, '../../../resources/bundled-skills/ai-coding-delegation/SKILL.md');
const skillBody = () => fs.readFileSync(SKILL_PATH, 'utf8');
const aiCodingSkill = () => DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((s) => s.id === 'ai-coding-delegation');

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

  it('keeps the inviolable hard floors and the operator opt-in for autonomy', () => {
    const body = skillBody();
    expect(body).toMatch(/hard floor/i);
    expect(body).toMatch(/publish|deploy|production/i);
    expect(body).toMatch(/secret|credential/i);
    expect(body).toMatch(/another client('|’)?s? seat|another seat/i);
    expect(body).toMatch(/opt-in|autonomy level/i);
    expect(body).toMatch(/scope-bound|disposable|throwaway/i);
  });

  it('any literal skip-permissions flag stays gated behind opt-in + scope (never the default launch)', () => {
    const body = skillBody();
    if (body.includes('--dangerously-skip-permissions')) {
      // If the raw flag is spelled out, the doc MUST surround it with the opt-in + scope guardrails.
      expect(body).toMatch(/opt-in/i);
      expect(body).toMatch(/scope-bound|disposable/i);
    }
    // The default one-shot launch recipe must be the supervised one (no skip flag on it).
    const oneShot = body.slice(body.indexOf('### One-shot delegation'), body.indexOf('### Multi-turn dialog'));
    expect(oneShot).not.toContain('--dangerously-skip-permissions');
  });
});
