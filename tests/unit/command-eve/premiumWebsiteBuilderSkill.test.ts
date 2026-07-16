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
  DEFAULT_COMMAND_EVE_CAPABILITY_PACK,
  EVE_STRATEGY_SKILL_IDS,
  copyBundledStrategySkills,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@/process/commandEve/runtimeBootstrapCore';
import {
  COMMAND_EVE_ASSISTANT_SKILL_DE,
  COMMAND_EVE_ASSISTANT_SKILL_EN,
  COMMAND_EVE_ASSISTANT_SKILL_FOUNDER_DE,
  COMMAND_EVE_ASSISTANT_SKILL_FOUNDER_EN,
} from '@/process/commandEve/assistantBootstrapCore';

const SKILL_ID = 'premium-website-builder';
const SKILL_DIR = path.resolve(process.cwd(), 'resources', 'bundled-skills', SKILL_ID);
const SKILL_MD_PATH = path.join(SKILL_DIR, 'SKILL.md');
const LINKED_FILES = [
  'references/art-direction.md',
  'references/poster-first-lazy-video.md',
  'references/responsive-interaction.md',
  'references/quality-gates.md',
] as const;

const readSkill = (): string => fs.readFileSync(SKILL_MD_PATH, 'utf8');

describe('premium-website-builder bundled capability', () => {
  it('is allowlisted and active in the runtime and public capability packs', () => {
    expect(EVE_STRATEGY_SKILL_IDS as readonly string[]).toContain(SKILL_ID);
    expect(DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((skill) => skill.id === SKILL_ID)?.default_state).toBe(
      'active'
    );

    const publicPack = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'public', 'command-eve-capabilities.json'), 'utf8')
    ) as { skills?: Array<{ id?: string; default_state?: string }> };
    expect(publicPack.skills?.find((skill) => skill.id === SKILL_ID)?.default_state).toBe('active');
    expect(COMMAND_EVE_ASSISTANT_SKILL_DE).toContain(SKILL_ID);
    expect(COMMAND_EVE_ASSISTANT_SKILL_EN).toContain(SKILL_ID);
    expect(COMMAND_EVE_ASSISTANT_SKILL_FOUNDER_DE).toContain(SKILL_ID);
    expect(COMMAND_EVE_ASSISTANT_SKILL_FOUNDER_EN).toContain(SKILL_ID);
  });

  it('ships every required reference with the committed snapshot', () => {
    const body = readSkill();
    expect(body.startsWith(`---\nname: ${SKILL_ID}\n`)).toBe(true);
    for (const linkedFile of LINKED_FILES) {
      expect(body).toContain(`\`${linkedFile}\``);
      expect(fs.statSync(path.join(SKILL_DIR, linkedFile)).size).toBeGreaterThan(0);
    }
  });

  it('encodes the poster-first lazy video and safe fallback contract', () => {
    const body = readSkill();
    const mediaReference = fs.readFileSync(path.join(SKILL_DIR, 'references/poster-first-lazy-video.md'), 'utf8');

    expect(body).toMatch(/Figma is optional/i);
    expect(body).toMatch(/initial DOM contains neither `video\.src` nor a `<source src>`/i);
    expect(body).toMatch(/reduced motion[\s\S]*data saver/i);
    expect(body).toContain('BLOCKED_CAPABILITY');
    expect(body).toMatch(/Vite with React/i);
    expect(body).toMatch(/persistent local preview process/i);
    expect(body).toMatch(/Public deployment[\s\S]*require explicit approval/i);
    expect(mediaReference).toContain('preload="none"');
    expect(mediaReference).toContain('requestIdleCallback');
    expect(mediaReference).toContain('prefers-reduced-motion: reduce');
    expect(mediaReference).toContain('visibilitychange');
    expect(mediaReference).toContain('video.addEventListener("playing"');
    expect(mediaReference).toContain('video.querySelectorAll("source[data-hero-source]")');
    expect(mediaReference).toContain('video.load()');
    expect(mediaReference).toContain('sessionStorage.setItem');
    expect(mediaReference).toMatch(/const shouldPlay = \(\) =>/);
    expect(mediaReference).toMatch(/same neutral anchor state/i);
    expect(mediaReference).toMatch(/zero video bytes/i);
    expect(mediaReference).toMatch(/same main gesture[\s\S]*roughly once per minute/i);
  });

  it('copies the complete skill tree into a seat managed skills root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-premium-website-'));
    try {
      const paths = resolveCommandEveRuntimeBootstrapPaths(root);
      const failures = copyBundledStrategySkills(paths, path.resolve(process.cwd(), 'resources', 'bundled-skills'));
      expect(failures).not.toContain(`capabilities.bundled_skill_missing:${SKILL_ID}`);
      expect(fs.readFileSync(path.join(paths.managedSkillsRoot, SKILL_ID, 'SKILL.md'), 'utf8')).toContain(
        '# Premium Website Builder'
      );
      for (const linkedFile of LINKED_FILES) {
        expect(fs.existsSync(path.join(paths.managedSkillsRoot, SKILL_ID, linkedFile))).toBe(true);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
