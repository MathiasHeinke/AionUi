/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVE_STRATEGY_SKILL_IDS as RUNTIME_SKILL_IDS } from '@/process/commandEve/runtimeBootstrapCore';
import {
  EVE_STRATEGY_SKILL_IDS as STAGED_SKILL_IDS,
  findForbiddenSkillContent,
  findRuntimeInstallInstructions,
  findSkillHygieneFailures,
} from '../../../scripts/fetch-bundled-skills.mjs';

const skillPath = path.resolve(process.cwd(), 'resources/bundled-skills/office-studio/SKILL.md');
const skill = fs.readFileSync(skillPath, 'utf8');

describe('office-studio Hermes skill', () => {
  it('ships through the runtime and staged bundle allowlists', () => {
    expect(RUNTIME_SKILL_IDS as readonly string[]).toContain('office-studio');
    expect(STAGED_SKILL_IDS).toEqual([...RUNTIME_SKILL_IDS]);
  });

  it('has hygienic trigger metadata and stays runtime-invisible', () => {
    expect(skill.startsWith('---\nname: office-studio\n')).toBe(true);
    expect(findSkillHygieneFailures({ skillId: 'office-studio', text: skill })).toEqual([]);
    expect(findRuntimeInstallInstructions(skill)).toEqual([]);
    expect(findForbiddenSkillContent(skill)).toEqual([]);
  });

  it('binds Word and Excel to the signed non-destructive artifact workflow', () => {
    expect(skill).toContain('mode=word');
    expect(skill).toContain('mode=excel');
    expect(skill).toContain('python-docx');
    expect(skill).toContain('openpyxl');
    expect(skill).toContain('XlsxWriter');
    expect(skill).toMatch(/never overwrite the source/i);
    expect(skill).toMatch(/existing artifact\/file lane/i);
  });
});
