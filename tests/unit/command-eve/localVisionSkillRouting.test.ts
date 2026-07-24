/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('local-vision-qa activation boundary', () => {
  it('cannot activate for an ordinary image or PPTX request and never permits a silent model download', () => {
    const skill = fs.readFileSync(path.resolve('resources/bundled-skills/local-vision-qa/SKILL.md'), 'utf8');
    expect(skill).toContain('Never trigger for routine image/PPTX analysis');
    expect(skill).toContain('“analysiere dieses Bild”\n  is **not** permission');
    expect(skill).toContain('explain the exact download size and trade-off once');
    expect(skill).toMatch(/wait for\s+an explicit yes/);
    expect(skill).toContain('managed presentation/vision lane');
  });
});
