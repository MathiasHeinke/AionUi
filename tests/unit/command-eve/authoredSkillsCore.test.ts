/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.6 — EVE-authored skill listing. Pins the honest-provenance contract: a
 * SKILL.md under {hermesHome}/skills is EVE's own field skill; app-owned ids are
 * excluded; category nesting (operations/<id>) works; mtime feeds the "neu"
 * signal; a broken entry never throws.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAuthoredSkills } from '@/process/commandEve/authoredSkillsCore';

let root = '';

function writeSkill(rel: string, frontmatter: Record<string, string>, body = 'Body.'): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, `---\n${fm}\n---\n\n${body}\n`);
  return file;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-authored-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listAuthoredSkills', () => {
  it('lists a bare skill dir with name + description from frontmatter', () => {
    writeSkill('skill-authoring', { name: 'skill-authoring', description: 'EVE baut Skills' });
    const cards = listAuthoredSkills(root);
    expect(cards).toHaveLength(1);
    expect(cards[0].id).toBe('skill-authoring');
    expect(cards[0].name).toBe('skill-authoring');
    expect(cards[0].description).toBe('EVE baut Skills');
    expect(cards[0].source).toBe('authored');
    expect(cards[0].authored_at_ms).toBeGreaterThan(0);
  });

  it('handles one level of category nesting (operations/<id>)', () => {
    writeSkill('operations/ai-coding-delegation', { name: 'ai-coding-delegation', description: 'Delegation' });
    writeSkill('marketing/lead-magnet-pdf', { name: 'lead-magnet-pdf', description: 'PDF' });
    const cards = listAuthoredSkills(root);
    expect(cards.map((c) => c.id)).toEqual(['marketing/lead-magnet-pdf', 'operations/ai-coding-delegation']);
  });

  it('excludes app-owned ids (safety net — those are the bundle, not EVE)', () => {
    writeSkill('eve-doctrine', { name: 'eve-doctrine', description: 'app' });
    writeSkill('operations/model-uncensoring', { name: 'model-uncensoring', description: 'field' });
    const appOwned = new Set(['eve-doctrine']);
    const cards = listAuthoredSkills(root, appOwned);
    expect(cards.map((c) => c.id)).toEqual(['operations/model-uncensoring']);
  });

  it('skips hidden helper dirs like .hub', () => {
    fs.mkdirSync(path.join(root, '.hub', 'index-cache'), { recursive: true });
    fs.writeFileSync(path.join(root, '.hub', 'index-cache', 'hermes-index.json'), '{}');
    writeSkill('legal/legal-enforcement-dach', { name: 'legal-enforcement-dach', description: 'x' });
    const cards = listAuthoredSkills(root);
    expect(cards.map((c) => c.id)).toEqual(['legal/legal-enforcement-dach']);
  });

  it('falls back to the id when name frontmatter is absent, empty description ok', () => {
    writeSkill('claude-code-tmux-delegation', { title: 'x' });
    const cards = listAuthoredSkills(root);
    expect(cards[0].id).toBe('claude-code-tmux-delegation');
    expect(cards[0].name).toBe('claude-code-tmux-delegation');
    expect(cards[0].description).toBe('');
  });

  it('a missing dir returns [] and never throws', () => {
    expect(listAuthoredSkills(path.join(root, 'nope'))).toEqual([]);
    expect(listAuthoredSkills('')).toEqual([]);
  });

  it('a category dir with no SKILL.md inside contributes nothing', () => {
    fs.mkdirSync(path.join(root, 'operations', 'empty-dir'), { recursive: true });
    writeSkill('operations/real-one', { name: 'real-one', description: 'y' });
    const cards = listAuthoredSkills(root);
    expect(cards.map((c) => c.id)).toEqual(['operations/real-one']);
  });
});
