/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE — EVE-learned skill listing (1.2.18, Req 2 "skills EVE creates when
 * it learns").
 *
 * When EVE proposes + saves a new skill (SkillSuggestCard → POST
 * /api/cron/jobs/{job_id}/skill), the SKILL.md lands in a PER-CRON-JOB directory
 * `{cronSkillsDir}/{job_id}/SKILL.md` (initStorage). It is READ IN PLACE by the
 * cron runtime, so it appears in NEITHER the backend `/api/skills` listing nor the
 * renderer "Meine Skills" dir. This core makes those learned skills VISIBLE
 * (read-only) on the unified Settings→Fähigkeiten surface WITHOUT moving the file
 * (moving it would orphan the scheduled job's skill — see plan R3).
 *
 * It is a pure scan of the cron-skills root: one card per `{job_id}/SKILL.md`,
 * with name/description parsed from the YAML frontmatter (falling back to the
 * job_id when absent). fs + path only; the root is injected so it is node-testable.
 */

import fs from 'node:fs';
import path from 'node:path';

import { COMMAND_EVE_SKILL_FILE } from './skillContentCore';

export interface LearnedSkillCard {
  /** The cron job id that owns this learned skill (its directory name). */
  job_id: string;
  /** Frontmatter `name:` or the job_id when absent. */
  name: string;
  /** Frontmatter `description:` or '' when absent. */
  description: string;
  /** Absolute path to the SKILL.md (for click-to-read via skillContentCore). */
  path: string;
  /** Discriminator for the unified surface's source badge ("Von EVE gelernt"). */
  source: 'learned';
}

/**
 * Extract a single scalar field from a leading YAML frontmatter block
 * (`---\n…\n---`). Tolerant: quoted or unquoted value, first match wins. Returns
 * '' when the field is absent. Intentionally tiny — no YAML dependency, and the
 * frontmatter we write is flat key: value.
 */
function readFrontmatterField(markdown: string, field: string): string {
  if (typeof markdown !== 'string' || markdown.length === 0) return '';
  // Only look inside a leading frontmatter block.
  const fm = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  const block = fm ? fm[1] : '';
  if (!block) return '';
  const line = block.split('\n').find((l) => l.trim().toLowerCase().startsWith(`${field}:`.toLowerCase()));
  if (!line) return '';
  let value = line.slice(line.indexOf(':') + 1).trim();
  // Strip surrounding quotes.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

/**
 * List the EVE-learned skills under `cronSkillsDir`. Each immediate subdirectory
 * holding a SKILL.md becomes one card. Missing/unreadable dirs ⇒ []. Never throws
 * (a broken single entry is skipped, not fatal).
 */
export function listLearnedSkills(cronSkillsDir: string): LearnedSkillCard[] {
  if (typeof cronSkillsDir !== 'string' || cronSkillsDir.length === 0) return [];
  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(cronSkillsDir)) return [];
    entries = fs.readdirSync(cronSkillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const cards: LearnedSkillCard[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobId = entry.name;
    const skillFile = path.join(cronSkillsDir, jobId, COMMAND_EVE_SKILL_FILE);
    let markdown = '';
    try {
      if (!fs.existsSync(skillFile)) continue;
      markdown = fs.readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    const name = readFrontmatterField(markdown, 'name') || jobId;
    const description = readFrontmatterField(markdown, 'description');
    cards.push({ job_id: jobId, name, description, path: skillFile, source: 'learned' });
  }
  // Stable order for a deterministic UI + testable output.
  cards.sort((a, b) => a.job_id.localeCompare(b.job_id));
  return cards;
}
