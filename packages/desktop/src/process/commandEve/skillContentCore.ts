/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE — read-only SKILL.md body reader (1.2.18, Req 2 "click-to-read").
 *
 * The unified Settings→Fähigkeiten surface lets the operator OPEN a skill and READ
 * its SKILL.md (read-only, no editing yet). The bundled/builtin skill CORPUS is
 * owned by the aioncore BACKEND BINARY (crates/aionui-app/assets/builtin-skills/)
 * and is NOT a path the Electron main process can edit — so this is deliberately a
 * MAIN-PROCESS IPC reader over the on-disk skill roots the desktop itself manages:
 *   - user/custom skills      ({cacheRoot}/skills)
 *   - EVE-learned skills       ({cacheRoot}/cron-skills/{job_id})
 *   - managed strategy skills  ({hermesHome}/skills-command-eve/{id})  ← bundled
 *     strategy/operator/reasoning skills are COPIED here at bootstrap, so their
 *     real SKILL.md body is on disk and readable without touching the binary.
 * Pure backend-only builtins (never copied to a managed root) are read by the
 * renderer via the EXISTING `/api/skills/builtin-skill` backend endpoint instead.
 *
 * SECURITY — path-traversal guard. The renderer may pass an explicit `skillPath`
 * or a `skillName`. Both are constrained to the allowed roots by LEXICAL
 * containment (path.resolve + a root-prefix check) and the resolved file's
 * basename MUST be `SKILL.md`. A `../../etc/passwd`-style escape can never satisfy
 * lexical containment, so it is rejected. We intentionally do NOT realpath the
 * target: custom skills are imported as SYMLINKS pointing at the user's own skill
 * folder, so following the link is legitimate (the user authorized that import) —
 * the guard defends against a crafted REQUEST escaping the roots, not against the
 * user reading a skill they themselves imported.
 *
 * PURITY: fs + path only; the roots are injected, so the resolver is node-testable
 * with a temp dir (see skillContentCore.test.ts) and seat-scoping stays the
 * caller's concern.
 */

import fs from 'node:fs';
import path from 'node:path';

export const COMMAND_EVE_SKILL_FILE = 'SKILL.md';

export type ReadSkillContentReason =
  | 'INVALID_INPUT'
  | 'PATH_DENIED'
  | 'NOT_FOUND'
  | 'READ_FAILED';

export interface ReadSkillContentArgs {
  /** Allowed on-disk skills roots (user, cron, managed). Absolute paths. */
  rootDirs: string[];
  /**
   * Explicit path to a SKILL.md (or its containing skill dir). Validated to live
   * under one of `rootDirs` by lexical containment; basename must be SKILL.md.
   */
  skillPath?: string;
  /**
   * OR resolve `{root}/{skillName}/SKILL.md` across the roots (first existing
   * wins). The name is sanitized — any path separator / `..` is rejected.
   */
  skillName?: string;
}

export interface ReadSkillContentResult {
  ok: boolean;
  /** Read-only marker so the renderer can never mistake this for an editor. */
  read_only: true;
  markdown?: string;
  /** The resolved SKILL.md path actually read (for display / debugging). */
  path?: string;
  reason_code?: ReadSkillContentReason;
}

function deny(reason_code: ReadSkillContentReason): ReadSkillContentResult {
  return { ok: false, read_only: true, reason_code };
}

/** Lexical containment: is `candidate` inside `root` (no `..` escape)? */
function isLexicallyUnder(candidate: string, root: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  if (c === r) return true;
  return c.startsWith(r + path.sep);
}

/** A skill name is one path segment — never a separator or a `..` traversal. */
function isSafeSkillName(name: string): boolean {
  if (typeof name !== 'string' || name.trim().length === 0) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('\0')) return false;
  return true;
}

function readMarkdownAt(skillFile: string): ReadSkillContentResult {
  try {
    if (!fs.existsSync(skillFile)) return deny('NOT_FOUND');
    const markdown = fs.readFileSync(skillFile, 'utf8');
    return { ok: true, read_only: true, markdown, path: skillFile };
  } catch {
    return deny('READ_FAILED');
  }
}

/**
 * Read a SKILL.md body from one of the allowed roots, read-only + traversal-safe.
 *
 * Resolution:
 *   - `skillPath` given: resolve it; if it is a directory, append SKILL.md; the
 *     final basename MUST be SKILL.md; it MUST be lexically under a root.
 *   - else `skillName` given: try `{root}/{name}/SKILL.md` for each root in order;
 *     the first existing file wins.
 *   - neither: INVALID_INPUT.
 */
export function readSkillContent(args: ReadSkillContentArgs): ReadSkillContentResult {
  const roots = Array.isArray(args?.rootDirs)
    ? args.rootDirs.filter((r) => typeof r === 'string' && r.length > 0).map((r) => path.resolve(r))
    : [];
  if (roots.length === 0) return deny('INVALID_INPUT');

  // (a) explicit path branch.
  if (typeof args.skillPath === 'string' && args.skillPath.trim().length > 0) {
    let target = path.resolve(args.skillPath.trim());
    // A directory target ⇒ read its SKILL.md.
    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        target = path.join(target, COMMAND_EVE_SKILL_FILE);
      }
    } catch {
      // stat failed — fall through; existsSync in readMarkdownAt handles NOT_FOUND.
    }
    if (path.basename(target) !== COMMAND_EVE_SKILL_FILE) return deny('PATH_DENIED');
    if (!roots.some((root) => isLexicallyUnder(target, root))) return deny('PATH_DENIED');
    return readMarkdownAt(target);
  }

  // (b) name branch.
  if (typeof args.skillName === 'string' && args.skillName.trim().length > 0) {
    const name = args.skillName.trim();
    if (!isSafeSkillName(name)) return deny('INVALID_INPUT');
    for (const root of roots) {
      const candidate = path.join(root, name, COMMAND_EVE_SKILL_FILE);
      // Defense in depth: the joined path must still be under the root.
      if (!isLexicallyUnder(candidate, root)) continue;
      if (fs.existsSync(candidate)) return readMarkdownAt(candidate);
    }
    return deny('NOT_FOUND');
  }

  return deny('INVALID_INPUT');
}
