/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE — EVE-AUTHORED skill listing (v1.6, "der User soll SEHEN, dass EVE
 * sich erweitert hat").
 *
 * EVE writes her OWN skills (via the Hermes skill_manage / curator loop) into the
 * per-seat Hermes DEFAULT skills dir `{hermesHome}/skills/` — separate from the
 * app-owned bundle, which lives in `{hermesHome}/skills-command-eve`
 * (managedSkillsRoot). So the honest provenance signal is the LOCATION: anything
 * under `{hermesHome}/skills/` was authored by EVE in the field, not shipped by
 * the app. (Belt-and-suspenders: we still exclude any dir whose id matches an
 * app-owned skill, in case a build ever seeds a default there.)
 *
 * The scan is recursive over ONE level of optional category dirs (EVE files them
 * as `operations/<id>/`, `marketing/<id>/`, or a bare `<id>/`), one card per
 * SKILL.md, name/description from the YAML frontmatter, plus the file mtime so the
 * renderer can show an honest "neu"-marker (same mtime signal the v1.6 handover
 * note uses — no new persistence). Pure fs+path; the root + app-owned id set are
 * injected so it is node-testable. Never throws (a broken entry is skipped).
 */

import fs from 'node:fs';
import path from 'node:path';

import { COMMAND_EVE_SKILL_FILE } from './skillContentCore';

/** The per-seat Hermes default skills dir, relative to hermesHome. */
export const COMMAND_EVE_AUTHORED_SKILLS_DIR = 'skills';

export interface AuthoredSkillCard {
  /** Stable id — the skill's directory name (category-qualified when nested). */
  id: string;
  /** Frontmatter `name:` or the id when absent. */
  name: string;
  /** Frontmatter `description:` or '' when absent. */
  description: string;
  /** Absolute path to the SKILL.md (for click-to-read via skillContentCore). */
  path: string;
  /** SKILL.md mtime in ms — the honest "when did EVE add this" signal. */
  authored_at_ms: number;
  /** Discriminator for the source badge ("Von EVE erstellt"). */
  source: 'authored';
}

/** Tiny tolerant frontmatter scalar reader (mirrors learnedSkillsCore). */
function readFrontmatterField(markdown: string, field: string): string {
  if (typeof markdown !== 'string' || markdown.length === 0) return '';
  const fm = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(\n|$)/);
  const block = fm ? fm[1] : '';
  if (!block) return '';
  const line = block.split('\n').find((l) => l.trim().toLowerCase().startsWith(`${field}:`.toLowerCase()));
  if (!line) return '';
  let value = line.slice(line.indexOf(':') + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

/** Read one SKILL.md into a card, or null when unreadable/absent. */
function cardFromSkillFile(skillFile: string, id: string): AuthoredSkillCard | null {
  let markdown = '';
  let mtimeMs = 0;
  try {
    if (!fs.existsSync(skillFile)) return null;
    markdown = fs.readFileSync(skillFile, 'utf8');
    mtimeMs = fs.statSync(skillFile).mtimeMs;
  } catch {
    return null;
  }
  return {
    id,
    name: readFrontmatterField(markdown, 'name') || id,
    description: readFrontmatterField(markdown, 'description'),
    path: skillFile,
    authored_at_ms: mtimeMs,
    source: 'authored',
  };
}

/**
 * List the EVE-authored skills under `authoredSkillsDir` ({hermesHome}/skills).
 * Handles both a bare `<id>/SKILL.md` and one level of category nesting
 * `<category>/<id>/SKILL.md`. `appOwnedIds` (dir names the app itself ships) are
 * excluded as a safety net. Missing/unreadable dir ⇒ []. Never throws.
 */
export function listAuthoredSkills(
  authoredSkillsDir: string,
  appOwnedIds: ReadonlySet<string> = new Set()
): AuthoredSkillCard[] {
  if (typeof authoredSkillsDir !== 'string' || authoredSkillsDir.length === 0) return [];
  let top: fs.Dirent[];
  try {
    if (!fs.existsSync(authoredSkillsDir)) return [];
    top = fs.readdirSync(authoredSkillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const cards: AuthoredSkillCard[] = [];
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    // Hidden helper dirs (e.g. `.hub` index cache) are never skills.
    if (entry.name.startsWith('.')) continue;
    if (appOwnedIds.has(entry.name)) continue;

    const dir = path.join(authoredSkillsDir, entry.name);
    // (a) bare skill dir: <id>/SKILL.md
    const direct = cardFromSkillFile(path.join(dir, COMMAND_EVE_SKILL_FILE), entry.name);
    if (direct) {
      cards.push(direct);
      continue;
    }
    // (b) category dir: <category>/<id>/SKILL.md (one level down)
    let inner: fs.Dirent[];
    try {
      inner = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of inner) {
      if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
      const id = `${entry.name}/${sub.name}`;
      if (appOwnedIds.has(sub.name) || appOwnedIds.has(id)) continue;
      const card = cardFromSkillFile(path.join(dir, sub.name, COMMAND_EVE_SKILL_FILE), id);
      if (card) cards.push(card);
    }
  }
  cards.sort((a, b) => a.id.localeCompare(b.id));
  return cards;
}
