#!/usr/bin/env node
/**
 * fetch-bundled-skills.mjs — Bundled EVE strategy skills (build-time stage + verify).
 *
 * Copies the REAL EVE strategy SKILL.md trees out of the Company.OS skills dir
 * (the canonical authoring home, /.claude/skills) into a committed snapshot at
 *
 *   resources/bundled-skills/<skill-id>/SKILL.md
 *   resources/bundled-skills/marketing-outbound/<sub>/SKILL.md   (the bundle)
 *
 * electron-builder then maps `resources/bundled-skills` -> `bundled-skills` via
 * `extraResources`, landing it at `Contents/Resources/bundled-skills/` OUTSIDE the
 * asar (the bundled CPython/Hermes agent reads SKILL.md files via os.walk, not
 * Electron fs). At first run the runtime bootstrapper copies these trees into the
 * writable managedSkillsRoot so `skills.external_dirs` serves the real method
 * content to the running Hermes agent (replacing the boilerplate onboarding stubs).
 *
 * WHY a committed snapshot (vendor) and not fetch-at-build-only (like python):
 *   The app repo must build hermetically WITHOUT the Company.OS checkout present
 *   (CI, a fresh clone, a contributor box). So we COMMIT the snapshot and treat
 *   the cross-repo copy as an idempotent, env-gated REFRESH:
 *     - source present  -> refresh the snapshot from canonical, then verify.
 *     - source absent   -> trust the committed snapshot, then verify.
 *   Either way we FAIL-CLOSED (non-zero exit) if any allowlisted skill is missing
 *   from BOTH source and snapshot — a silent gap is the founder-self-detection
 *   failure mode (a skill the running agent thinks it has but doesn't).
 *
 * The skills are small markdown (~120 KB total), cross-platform, and pure text —
 * no signing/notarize concern (unlike Resources/python). So unlike
 * fetch-bundled-python this runs UNCONDITIONALLY for every platform.
 *
 * Source override:
 *   COMMAND_EVE_SKILLS_SRC=/abs/path/to/.claude/skills node scripts/fetch-bundled-skills.mjs
 *   (default: /Users/mathiasheinke/Developer/Company.OS/.claude/skills)
 *
 * The pure logic (allowlist, copy/skip decision, fail-closed verify) is exported
 * for unit testing; side effects (fs) run only when invoked directly.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// ALLOWLIST — the curated EVE strategy skill set.
// ---------------------------------------------------------------------------
// EXPLICIT allowlist (never glob .claude/skills — gitnexus and other dev/IDE
// skills must NOT travel into the shipped app). 15 single-folder skills with one
// SKILL.md each, PLUS marketing-outbound which is a BUNDLE (no top-level
// SKILL.md; 17 nested sub-skill dirs each with their own SKILL.md).
//
// `bundle: true` changes the verify rule: a single skill must land its own
// <id>/SKILL.md; a bundle must land at least one NESTED **/SKILL.md (Hermes'
// os.walk discovers every nested SKILL.md — FACT wheel agent/skill_utils.py:632-645).
export const EVE_STRATEGY_SKILLS = Object.freeze([
  { id: 'eve-doctrine' },
  { id: 'plan-system' },
  { id: 'pre-mortem' },
  { id: 'business-diagnostic' },
  { id: 'icp-persona-panel' },
  { id: 'decision-brief' },
  { id: 'deep-research' },
  { id: 'gtm-strategy' },
  { id: 'customer-discovery' },
  { id: 'business-architecture' },
  { id: 'hiring' },
  { id: 'option-tournament' },
  { id: 'landing-copy' },
  { id: 'human-design-profile' },
  { id: 'marketing-outbound', bundle: true },
  // blog-writer: a REAL executable long-form/blog skill (replaces the fake "blog-department"
  // prompt label). On-voice (USER.md), SEO-aware, claim-safe, never publishes.
  { id: 'blog-writer' },
  // founder-voice: captures the operator's writing voice into USER.md so on-voice content sounds like them.
  { id: 'founder-voice' },
  // client-report: in-seat generator of the operator's client-facing report deliverable
  // (single-folder skill: SKILL.md + report-template.md).
  { id: 'client-report' },
  // Operator content / ops / CRM skills built in Company.OS (2026-06-29). User-facing
  // (never founder-ops): a content operating system, a video→content engine, the
  // human-gated publishing lane, a local kanban work-ledger, the first-run voice
  // interview, and a local client-pipeline CRM. Each is a single-folder skill (one SKILL.md).
  { id: 'content-machine' },
  { id: 'video-first-content-engine' },
  { id: 'blog-publishing-lane' },
  { id: 'local-kanban-ledger' },
  { id: 'voice-first-run' },
  { id: 'crm-department' },
  // Reasoning skills (2026-06-30): the invocable challenger + the divergent idea generator.
  // challenge-engine = the deliberate devil's-advocate/red-team tool the operator fires at a
  // SPECIFIC claim (pairs with pre-mortem, which assumes failure). brainstorm-divergent = the
  // upstream wide-field idea generator that FEEDS option-tournament (which only selects from a
  // bounded fork). Like the 6 operator skills, both also live in the capability pack as
  // 'active' department capabilities, so the real bundled SKILL.md lands over the stub.
  { id: 'challenge-engine' },
  { id: 'brainstorm-divergent' },
  // local-vision-qa (2026-07-03): HARVESTED FROM AN EVE-AUTHORED FIELD SKILL —
  // she hit a 502 (active model has no image endpoint) during client-PDF QA,
  // pulled minicpm-v:8b herself, calibrated it empirically and documented the
  // craft; this is her method hardened (opt-in ~5.5GB download only after an
  // explicit operator yes; images never leave the Mac — DSGVO-green).
  // ⚠ OPEN GATE before marketing claims: verify the minicpm-v model license
  // for commercial bundling contexts; the skill already prefers the installed
  // bundled Gemma model when it accepts image input.
  { id: 'local-vision-qa' },
  // 4 weitere EVE-authored Feld-Skills geerntet (2026-07-03, Founder-Go), jeweils
  // gehärtet vor Public (Details: docs/strategy/command-eve-eve-authored-skills-harvest-2026-07-03.md):
  // ai-coding-delegation (tmux-Subscription-Lane, composes mit delegate_task; ToS-Caveat),
  // lead-magnet-pdf (real-data-only + Voice-Guard-Pflicht), skill-authoring (Curator-GUARD:
  // kein Guardrail-/PII-/ToS-Bypass, Human-Gate; unlock-als-Feature explizit erlaubt),
  // legal-enforcement-dach (ENTWURF-only, PII-Redaktions-Bypass ENTFERNT, Anwalt-zeichnet-
  // Human-Gate, „kein Rechtsrat"-Disclaimer).
  { id: 'ai-coding-delegation' },
  { id: 'lead-magnet-pdf' },
  { id: 'skill-authoring' },
  { id: 'legal-enforcement-dach' },
]);

/** Just the ids, for callers that want the flat allowlist. */
export const EVE_STRATEGY_SKILL_IDS = Object.freeze(EVE_STRATEGY_SKILLS.map((s) => s.id));

export const DEFAULT_SKILLS_SRC = '/Users/mathiasheinke/Developer/Company.OS/.claude/skills';
export const COMMAND_EVE_SKILLS_SRC_ENV = 'COMMAND_EVE_SKILLS_SRC';

// ---------------------------------------------------------------------------
// PURE LOGIC (exported for unit tests; no fs side effects)
// ---------------------------------------------------------------------------

/**
 * Decide, for ONE allowlisted skill, where the build should source it from.
 * Pure: given whether the canonical source and the committed snapshot exist,
 * pick the action. FAIL-CLOSED when neither exists.
 *
 * Returns { action, reason }:
 *   - 'refresh'   source exists -> copy source over the snapshot (keep in sync).
 *   - 'keep'      source absent, snapshot exists -> trust the committed snapshot.
 *   - 'missing'   neither exists -> caller must FAIL (non-zero exit).
 */
export function decideSkillSource({ sourceExists, snapshotExists }) {
  if (sourceExists) return { action: 'refresh', reason: 'canonical source present — refreshing snapshot' };
  if (snapshotExists) return { action: 'keep', reason: 'source absent — trusting committed snapshot' };
  return {
    action: 'missing',
    reason: 'allowlisted skill missing from BOTH canonical source and committed snapshot — fail-closed',
  };
}

/**
 * The fail-closed verify decision for a staged skill, given what landed in the
 * snapshot. Pure.
 *
 *   single skill: requires <dir>/SKILL.md to be a non-empty file.
 *   bundle:       requires >= 1 nested **\/SKILL.md.
 *
 * Returns { ok, reason }.
 */
export function decideVerify({ bundle, hasOwnSkillMd, nestedSkillMdCount }) {
  if (bundle) {
    if ((nestedSkillMdCount || 0) >= 1) return { ok: true, reason: `bundle has ${nestedSkillMdCount} nested SKILL.md` };
    return { ok: false, reason: 'bundle has no nested SKILL.md' };
  }
  if (hasOwnSkillMd) return { ok: true, reason: 'SKILL.md present' };
  return { ok: false, reason: 'missing SKILL.md' };
}

/**
 * Fail-closed CONTENT gate (2026-07-06). A bundled skill must never teach the
 * permission RUBBER-STAMP anti-pattern — blindly accepting / clicking past a
 * coding worker's permission or bypass warning (the Codex C2 finding). This runs at
 * BUILD time, on what actually LANDED after the source-refresh: the suite test
 * (aiCodingDelegationGate) checks the committed snapshot, but the build refreshes
 * the snapshot FROM the canonical source, so if that source ever reverts to the
 * dangerous framing the build itself must REFUSE to ship it (that exact gap shipped
 * once — hardened commit, but the build re-pulled a dangerous source). Note this
 * forbids the blind rubber-stamp, NOT the legitimate operator-opt-in autonomy mode.
 * Pure: returns the list of forbidden pattern ids found in `text`.
 */
export const FORBIDDEN_SKILL_CONTENT = [
  { id: 'wrong-for-automation', re: /WRONG for automation/i },
  { id: 'bypass-permissions-warning-row', re: /Bypass-permissions warning/i },
  { id: 'auto-accept-permission-warning', re: /arrow\s+\**Down\**\s+to the accept option/i },
];

export function findForbiddenSkillContent(text) {
  return FORBIDDEN_SKILL_CONTENT.filter((f) => f.re.test(String(text || ''))).map((f) => f.id);
}

export const SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION = Object.freeze([
  'lead-magnet-pdf',
  'legal-enforcement-dach',
  'human-design-profile',
  'voice-first-run',
]);

export const SKILL_IDS_REQUIRING_LINKED_FILES = Object.freeze(['content-machine', 'blog-writer']);

function leadingFrontmatter(text) {
  const body = String(text || '');
  if (!body.startsWith('---\n')) return '';
  const end = body.indexOf('\n---', 4);
  return end === -1 ? '' : body.slice(4, end);
}

function frontmatterScalar(frontmatter, key) {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'im');
  const match = frontmatter.match(re);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

function frontmatterLinkedFiles(frontmatter) {
  const linkedFiles = [];
  const lines = String(frontmatter || '').split('\n');
  let inLinkedFiles = false;
  for (const line of lines) {
    const keyMatch = line.match(/^linked_files:\s*(.*)$/);
    if (keyMatch) {
      inLinkedFiles = true;
      const inline = keyMatch[1].trim();
      if (inline) linkedFiles.push(inline.replace(/^['"]|['"]$/g, ''));
      continue;
    }

    if (!inLinkedFiles) continue;
    const itemMatch = line.match(/^\s*-\s*(.+)$/);
    if (itemMatch) {
      linkedFiles.push(itemMatch[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    if (line.trim() && !/^\s/.test(line)) {
      inLinkedFiles = false;
    }
  }
  return linkedFiles.filter(Boolean);
}

export function findSkillHygieneFailures({ skillId, text }) {
  const failures = [];
  const frontmatter = leadingFrontmatter(text);
  if (!frontmatter) {
    return ['missing_frontmatter'];
  }

  const name = frontmatterScalar(frontmatter, 'name');
  const description = frontmatterScalar(frontmatter, 'description');
  if (!name) failures.push('frontmatter_missing_name');
  if (!description) failures.push('frontmatter_missing_description');
  if (
    description &&
    !/\b(use when|when to use|when the user|when the operator|use for|trigger|nutze|verwende)\b/i.test(description)
  ) {
    failures.push('description_missing_trigger');
  }
  if (skillId !== 'eve-doctrine' && /\bFor Command EVE\b/i.test(description)) {
    failures.push('description_embeds_eve_doctrine');
  }

  if (skillId !== 'eve-doctrine' && /^## (?:For Command EVE|Hard [Rr]ules \(EVE [Dd]octrine\))$/m.test(String(text || ''))) {
    failures.push('duplicate_eve_doctrine_section');
  }

  if (SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION.includes(skillId)) {
    const disableModelInvocation = frontmatterScalar(frontmatter, 'disable_model_invocation').toLowerCase();
    if (disableModelInvocation !== 'true') {
      failures.push('disable_model_invocation_missing');
    }
  }

  if (SKILL_IDS_REQUIRING_LINKED_FILES.includes(skillId) && frontmatterLinkedFiles(frontmatter).length === 0) {
    failures.push('linked_files_missing');
  }

  return failures;
}

function isSafeRelativeSkillLink(linkedFile) {
  if (!linkedFile || path.isAbsolute(linkedFile)) return false;
  return !linkedFile.split(/[\\/]+/).includes('..');
}

// ---------------------------------------------------------------------------
// fs helpers (side-effecting; small + dependency-free)
// ---------------------------------------------------------------------------

/** True iff `p` exists and is a non-empty regular file. */
function isNonEmptyFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** Count nested SKILL.md files under `dir` (recursive). 0 if dir missing. */
function countNestedSkillMd(dir) {
  let count = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      count += countNestedSkillMd(full);
    } else if (ent.isFile() && ent.name === 'SKILL.md' && isNonEmptyFile(full)) {
      count += 1;
    }
  }
  return count;
}

/** Collect every SKILL.md path under `dir` (recursive) — for the content gate. */
function collectSkillMdPaths(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectSkillMdPaths(full));
    else if (ent.isFile() && ent.name === 'SKILL.md') out.push(full);
  }
  return out;
}

/** Recursively copy a directory tree (markdown only; preserves layout). */
function copyTree(srcDir, destDir) {
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, ent.name);
    const to = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      copyTree(from, to);
    } else if (ent.isFile()) {
      fs.copyFileSync(from, to);
    }
    // symlinks / other entry types are intentionally skipped — skills are pure files.
  }
}

// ---------------------------------------------------------------------------
// CLI / side-effecting runner
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'resources', 'bundled-skills');

function log(...args) {
  console.log('[fetch-bundled-skills]', ...args);
}

/**
 * Stage every allowlisted skill into the snapshot dir, refreshing from the
 * canonical source when present, otherwise trusting the committed snapshot, and
 * verifying each landed correctly. Returns a list of failure strings (empty when
 * all OK). Pure-ish: takes the source root + snapshot root so tests can drive it
 * against fixtures.
 */
export function stageBundledSkills({ srcRoot, snapshotRoot, skills = EVE_STRATEGY_SKILLS }) {
  const failures = [];
  fs.mkdirSync(snapshotRoot, { recursive: true });

  for (const skill of skills) {
    const srcDir = path.join(srcRoot, skill.id);
    const destDir = path.join(snapshotRoot, skill.id);
    const sourceExists = (() => {
      try {
        return fs.statSync(srcDir).isDirectory();
      } catch {
        return false;
      }
    })();
    const snapshotExists = (() => {
      try {
        return fs.statSync(destDir).isDirectory();
      } catch {
        return false;
      }
    })();

    const decision = decideSkillSource({ sourceExists, snapshotExists });
    if (decision.action === 'missing') {
      failures.push(`bundled_skill_missing:${skill.id}`);
      log(`MISSING ${skill.id} — ${decision.reason}`);
      continue;
    }
    if (decision.action === 'refresh') {
      copyTree(srcDir, destDir);
      log(`refreshed ${skill.id} from source`);
    } else {
      log(`kept committed snapshot for ${skill.id}`);
    }

    // FAIL-CLOSED verify of what actually landed.
    const verify = decideVerify({
      bundle: Boolean(skill.bundle),
      hasOwnSkillMd: isNonEmptyFile(path.join(destDir, 'SKILL.md')),
      nestedSkillMdCount: countNestedSkillMd(destDir),
    });
    if (!verify.ok) {
      failures.push(`bundled_skill_invalid:${skill.id}`);
      log(`INVALID ${skill.id} — ${verify.reason}`);
    }

    // FAIL-CLOSED content gate: no landed SKILL.md may teach the permission rubber-stamp.
    for (const mdPath of collectSkillMdPaths(destDir)) {
      let text = '';
      try {
        text = fs.readFileSync(mdPath, 'utf8');
      } catch {
        continue;
      }
      const forbidden = findForbiddenSkillContent(text);
      if (forbidden.length) {
        failures.push(`bundled_skill_forbidden_content:${skill.id}:${forbidden.join(',')}`);
        log(`FORBIDDEN CONTENT ${skill.id} — ${forbidden.join(', ')} in ${path.relative(snapshotRoot, mdPath)}`);
      }
      const hygiene = findSkillHygieneFailures({ skillId: skill.id, text });
      if (hygiene.length) {
        failures.push(`bundled_skill_hygiene:${skill.id}:${hygiene.join(',')}`);
        log(`HYGIENE ${skill.id} — ${hygiene.join(', ')} in ${path.relative(snapshotRoot, mdPath)}`);
      }

      const linkedFiles = frontmatterLinkedFiles(leadingFrontmatter(text));
      for (const linkedFile of linkedFiles) {
        if (!isSafeRelativeSkillLink(linkedFile)) {
          failures.push(`bundled_skill_linked_file_invalid:${skill.id}:${linkedFile}`);
          log(`LINKED FILE INVALID ${skill.id} — ${linkedFile} in ${path.relative(snapshotRoot, mdPath)}`);
          continue;
        }
        if (!isNonEmptyFile(path.join(path.dirname(mdPath), linkedFile))) {
          failures.push(`bundled_skill_linked_file_missing:${skill.id}:${linkedFile}`);
          log(`LINKED FILE MISSING ${skill.id} — ${linkedFile} in ${path.relative(snapshotRoot, mdPath)}`);
        }
      }
    }
  }
  return failures;
}

function main() {
  const srcRoot = compactEnv(process.env[COMMAND_EVE_SKILLS_SRC_ENV]) || DEFAULT_SKILLS_SRC;
  log(`source=${srcRoot}`);
  log(`snapshot=${path.relative(REPO_ROOT, SNAPSHOT_DIR)}`);

  const failures = stageBundledSkills({ srcRoot, snapshotRoot: SNAPSHOT_DIR });
  if (failures.length) {
    console.error(
      `[fetch-bundled-skills] FAIL-CLOSED: ${failures.length} skill(s) missing/invalid:\n  ` +
        failures.join('\n  ') +
        `\n  Source: ${srcRoot}\n  A strategy skill the running agent expects is absent from both ` +
        `the canonical source and the committed snapshot — refusing to ship a silent gap.`
    );
    process.exitCode = 2;
    return;
  }
  log(`done. ${EVE_STRATEGY_SKILL_IDS.length} skills staged + verified.`);
}

function compactEnv(value) {
  return String(value ?? '').trim();
}

// Run only when invoked directly (so tests can import the pure logic).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error('[fetch-bundled-skills] ERROR:', error?.message || error);
    process.exitCode = 1;
  }
}
