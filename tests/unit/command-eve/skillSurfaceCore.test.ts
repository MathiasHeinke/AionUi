/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.2.18 — unit tests for the unified-skill-surface main-process cores:
 *   - skillContentCore.readSkillContent (click-to-read, traversal-guarded)
 *   - learnedSkillsCore.listLearnedSkills (EVE-learned cron-skill scan)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSkillContent } from '@/process/commandEve/skillContentCore';
import { listLearnedSkills } from '@/process/commandEve/learnedSkillsCore';

let root: string;
let userSkills: string;
let cronSkills: string;
let managed: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-skill-surface-'));
  userSkills = path.join(root, 'skills');
  cronSkills = path.join(root, 'cron-skills');
  managed = path.join(root, 'skills-command-eve');
  for (const d of [userSkills, cronSkills, managed]) fs.mkdirSync(d, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function writeSkill(dir: string, name: string, body: string): string {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const file = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

describe('skillContentCore.readSkillContent — click-to-read', () => {
  it('reads a managed strategy skill by name', () => {
    writeSkill(managed, 'eve-doctrine', '---\nname: eve-doctrine\n---\n# Doctrine body');
    const res = readSkillContent({ rootDirs: [userSkills, cronSkills, managed], skillName: 'eve-doctrine' });
    expect(res.ok).toBe(true);
    expect(res.read_only).toBe(true);
    expect(res.markdown).toContain('# Doctrine body');
    expect(res.path?.endsWith('SKILL.md')).toBe(true);
  });

  it('reads a custom skill by explicit path (and accepts a dir, appending SKILL.md)', () => {
    const file = writeSkill(userSkills, 'my-custom', '# Custom');
    // by file path
    expect(readSkillContent({ rootDirs: [userSkills], skillPath: file }).markdown).toContain('# Custom');
    // by directory path
    const byDir = readSkillContent({ rootDirs: [userSkills], skillPath: path.dirname(file) });
    expect(byDir.ok).toBe(true);
    expect(byDir.markdown).toContain('# Custom');
  });

  it('SECURITY: rejects a path-traversal escape with PATH_DENIED', () => {
    const res = readSkillContent({
      rootDirs: [userSkills],
      skillPath: path.join(userSkills, '..', '..', 'etc', 'passwd'),
    });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe('PATH_DENIED');
  });

  it('SECURITY: rejects a non-SKILL.md basename even inside a root', () => {
    const secret = path.join(userSkills, 'secret.txt');
    fs.writeFileSync(secret, 'top secret', 'utf8');
    const res = readSkillContent({ rootDirs: [userSkills], skillPath: secret });
    expect(res.ok).toBe(false);
    expect(res.reason_code).toBe('PATH_DENIED');
  });

  it('SECURITY: rejects a skillName containing a separator/traversal', () => {
    expect(readSkillContent({ rootDirs: [userSkills], skillName: '../escape' }).reason_code).toBe('INVALID_INPUT');
    expect(readSkillContent({ rootDirs: [userSkills], skillName: 'a/b' }).reason_code).toBe('INVALID_INPUT');
    expect(readSkillContent({ rootDirs: [userSkills], skillName: '..' }).reason_code).toBe('INVALID_INPUT');
  });

  it('returns NOT_FOUND for an unknown name and INVALID_INPUT with no roots/selector', () => {
    expect(readSkillContent({ rootDirs: [userSkills], skillName: 'nope' }).reason_code).toBe('NOT_FOUND');
    expect(readSkillContent({ rootDirs: [], skillName: 'x' }).reason_code).toBe('INVALID_INPUT');
    expect(readSkillContent({ rootDirs: [userSkills] }).reason_code).toBe('INVALID_INPUT');
  });
});

describe('learnedSkillsCore.listLearnedSkills — EVE-learned scan', () => {
  it('lists one card per {job_id}/SKILL.md with parsed frontmatter', () => {
    writeSkill(cronSkills, 'job-aaa', '---\nname: "Wettbewerbsanalyse"\ndescription: gelernt aus Lauf\n---\n# body');
    writeSkill(cronSkills, 'job-bbb', '---\nname: Reporting\n---\n# body');
    const cards = listLearnedSkills(cronSkills);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      job_id: 'job-aaa',
      name: 'Wettbewerbsanalyse',
      description: 'gelernt aus Lauf',
      source: 'learned',
    });
    // missing description ⇒ ''
    expect(cards[1]).toMatchObject({ job_id: 'job-bbb', name: 'Reporting', description: '' });
    expect(cards[1].path.endsWith(path.join('job-bbb', 'SKILL.md'))).toBe(true);
  });

  it('falls back to job_id when frontmatter name is absent', () => {
    writeSkill(cronSkills, 'job-noname', '# just a body, no frontmatter');
    const cards = listLearnedSkills(cronSkills);
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe('job-noname');
  });

  it('skips dirs without SKILL.md and returns [] for a missing root', () => {
    fs.mkdirSync(path.join(cronSkills, 'empty-job'), { recursive: true });
    expect(listLearnedSkills(cronSkills)).toHaveLength(0);
    expect(listLearnedSkills(path.join(root, 'does-not-exist'))).toEqual([]);
  });
});
