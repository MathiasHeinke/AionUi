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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMAND_EVE_CAPABILITY_PACK,
  EVE_STRATEGY_SKILL_IDS as RUNTIME_STRATEGY_SKILL_IDS,
} from '@/process/commandEve/runtimeBootstrapCore';
import { EVE_STRATEGY_SKILL_IDS as STAGED_STRATEGY_SKILL_IDS } from '../../../scripts/fetch-bundled-skills.mjs';

const SKILL_PATH = path.resolve(__dirname, '../../../resources/bundled-skills/ai-coding-delegation/SKILL.md');
const skillBody = () => fs.readFileSync(SKILL_PATH, 'utf8');
const aiCodingSkill = () => DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((s) => s.id === 'ai-coding-delegation');

const EXPLICIT_ONLY_SKILL_IDS = [
  'ai-coding-delegation',
  'human-design-profile',
  'local-vision-qa',
  'plaud-recording-ingest',
  'skill-authoring',
  'legal-enforcement-dach',
] as const;

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

  it('never teaches permission bypass, raw API credential injection or worker-owned child fleets', () => {
    const body = skillBody();
    expect(body).not.toContain('--dangerously-skip-permissions');
    expect(body).not.toMatch(/ANTHROPIC_API_KEY\s*=/);
    expect(body).not.toMatch(/use sub-agents|may spawn sub-agents/i);
    expect(body).toMatch(/at most two tmux coding workers/i);
    expect(body).toMatch(/never let either worker create\s+children/i);
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

  it('keeps sensitive or high-impact skills gated and explicit-invocation-only', () => {
    for (const id of EXPLICIT_ONLY_SKILL_IDS) {
      const catalog = DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((skill) => skill.id === id);
      expect(catalog?.default_state, id).toBe('gated');
      const body = fs.readFileSync(path.resolve(__dirname, `../../../resources/bundled-skills/${id}/SKILL.md`), 'utf8');
      expect(body, id).toMatch(/^disable_model_invocation:\s*true$/m);
    }
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
