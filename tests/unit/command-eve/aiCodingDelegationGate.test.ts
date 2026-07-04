/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Codex C2 (1.6.0 CRITICAL): the bundled `ai-coding-delegation` skill drove an
 * external coding CLI with `--dangerously-skip-permissions` AND was wired as an
 * always-on (`default_state: 'active'`) capability — EVE could run a file-touching
 * worker on any seat with no per-action approval, violating Human-Gates and
 * secret/env isolation. This locks the hardened posture:
 *   1. the capability is GATED, not active;
 *   2. the shipped SKILL.md teaches NO skip-permissions launch and NO
 *      auto-accepting of a permission prompt.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_EVE_CAPABILITY_PACK } from '@/process/commandEve/runtimeBootstrapCore';

const SKILL_PATH = path.resolve(
  __dirname,
  '../../../resources/bundled-skills/ai-coding-delegation/SKILL.md'
);

const aiCodingSkill = () =>
  DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((s) => s.id === 'ai-coding-delegation');

describe('ai-coding-delegation — C2 permission-bypass hardening', () => {
  it('is a GATED capability, never an always-on default', () => {
    const skill = aiCodingSkill();
    expect(skill).toBeDefined();
    expect(skill?.default_state).toBe('gated');
    expect(skill?.default_state).not.toBe('active');
  });

  it('the shipped SKILL.md teaches NO --dangerously-skip-permissions launch', () => {
    const body = fs.readFileSync(SKILL_PATH, 'utf8');
    expect(body).not.toContain('--dangerously-skip-permissions');
  });

  it('the shipped SKILL.md does NOT instruct auto-accepting a permission prompt', () => {
    const body = fs.readFileSync(SKILL_PATH, 'utf8');
    // The old bypass row told EVE the safe option was "WRONG for automation" and to
    // arrow Down past it. That guidance must be gone.
    expect(body).not.toContain('WRONG for automation');
    expect(body).not.toMatch(/Bypass-permissions warning/i);
    // The hardened text names the Human-Gate explicitly.
    expect(body).toMatch(/Human-Gate/);
  });
});

function DEFAULT_COMMAND_COMMAND_EVE_ID_LOOKUP() {
  return DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((s) => s.id === 'ai-coding-delegation');
}
