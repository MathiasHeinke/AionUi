#!/usr/bin/env node
/**
 * fetch-bundled-skills.mjs — Bundled EVE strategy skills (build-time stage + verify).
 *
 * Copies the REAL EVE strategy SKILL.md trees out of the Company.OS skills dir
 * (the canonical authoring home, /.claude/skills) into a committed snapshot at
 *
 *   resources/bundled-skills/<skill-id>/SKILL.md
 *   resources/bundled-skills/<skill-id>/SKILL.md
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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// ALLOWLIST — the curated EVE strategy skill set.
// ---------------------------------------------------------------------------
// EXPLICIT allowlist (never glob .claude/skills — gitnexus and other dev/IDE
// skills must NOT travel into the shipped app). The curated set is made of
// single-folder skills with one executable SKILL.md plus any nested assets.
// The historical marketing-outbound bundle deliberately stays OUT of this
// allowlist until its DACH outreach/legal posture has been independently
// remediated. A `gated` catalog label is not an execution boundary because
// Hermes recursively discovers nested SKILL.md files.
//
// `bundle: true` changes the verify rule: a single skill must land its own
// <id>/SKILL.md; a bundle must land at least one NESTED **/SKILL.md (Hermes'
// os.walk discovers every nested SKILL.md — FACT wheel agent/skill_utils.py:632-645).
export const PLAUD_REQUIRED_FILES = Object.freeze([
  'references/processing-contract.md',
  'references/command-eve-integration.md',
  'references/official-plaud-adapters.md',
  'references/project-and-tool-routing.md',
  'scripts/plaud-download-audio.mjs',
  'scripts/plaud-ingest-guard.mjs',
  'scripts/plaud-local-transcribe.mjs',
  'scripts/plaud-project-publish.mjs',
]);

// ---------------------------------------------------------------------------
// copywriting — the first VENDORED third-party skill in the bundle.
// ---------------------------------------------------------------------------
// Unlike every other allowlisted id, this tree is NOT authored in Company.OS: it is
// a byte-identical copy of an upstream MIT skill, pinned to one commit. So "the
// file is present" is not a strong enough gate — the whole value of a vendored
// dependency is that it is the reviewed bytes and NOT a local edit that drifted in
// unreviewed. `pinnedSha256` therefore fails closed on ALTERED as well as MISSING,
// which plain `requiredFiles` (existence only) cannot do.
//
// Provenance is duplicated in the shipped PROVENANCE.md next to the files; the two
// must agree, and copywritingSkillSnapshot.test.ts asserts that they do.
export const COPYWRITING_UPSTREAM = Object.freeze({
  registry_slug: 'coreyhaines31/marketingskills@copywriting',
  github_repo: 'coreyhaines31/marketingskills',
  commit: '7868cb9251fad80a73d26e488a5ad5f6c4a9f335',
  version: '2.0.1',
  license: 'MIT',
  retrieved: '2026-08-01',
});

/** sha256 of every vendored upstream file, at COPYWRITING_UPSTREAM.commit. */
export const COPYWRITING_PINNED_SHA256 = Object.freeze({
  'SKILL.md': 'ecdaabca28863d1472f79ba637842fdf4ac2fd9acc92b215ab7f152e757b2a33',
  'references/natural-transitions.md': '4ff23f8943af2f65b072f26f1c53ce55f19cc26d7be211c11cae8e34b43e859f',
  'references/copy-frameworks.md': 'f387b6ed4b510efa9f0d3c459f4898971c8b0176e8c34185040cb264eca50186',
  'evals/evals.json': '1cd7c27538b91d46c2b2cd007f2064922a4874ece1f2851b4bd844fe6f78a3e6',
  LICENSE: 'b70d71e24e40fce5da8f4b6f9cd862096a048e433db7f3c8cac5e348e6d34591',
});

// Every pinned upstream file plus the repo-authored provenance record. PROVENANCE.md
// is required but NOT digest-pinned: it is ours to update on a version bump, and
// pinning it would only pin it to itself.
export const COPYWRITING_REQUIRED_FILES = Object.freeze([...Object.keys(COPYWRITING_PINNED_SHA256), 'PROVENANCE.md']);

// ---------------------------------------------------------------------------
// seo + seo-aeo-best-practices (1.820.2, MAT-1769) — the second wave of VENDORED
// third-party skills, under exactly the copywriting contract: byte-identical
// upstream copies, digest-pinned so the build fails closed on ALTERED as well as
// MISSING. Neither upstream tree ships a LICENCE TEXT file: seo declares
// `license: MIT` in its SKILL.md frontmatter (the declaration is recorded in
// PROVENANCE.md — we do not write our own licence file for someone else's
// claim); seo-aeo-best-practices has NO licence marker at all, so its licence is
// UNDECLARED/unknown and its PROVENANCE.md says exactly that instead of
// fabricating one. Provenance is duplicated in the shipped PROVENANCE.md next to
// the files; the two must agree, and seoSkillSnapshot.test.ts asserts that they
// do.
//
// REFRESH SOURCING: the canonical authoring home is Company.OS `.claude/skills`
// (both skills were added there 2026-08-03). A refresh must point
// COMMAND_EVE_SKILLS_SRC at a Company.OS checkout that CONTAINS them — when the
// default root below predates their landing, refresh mode simply keeps the
// committed snapshot for these ids (fail-safe, never a silent edit). Release
// builds always run snapshot mode (scripts/build-with-builder.js) and never
// consult an external root, so the shipped bytes are always the committed,
// digest-pinned ones.
export const SEO_UPSTREAM = Object.freeze({
  source_path: '${HOME}/.codex/skills/seo',
  author: 'web-quality-skills',
  version: '1.0',
  license: 'MIT (frontmatter-declared; no licence text file exists upstream)',
  retrieved: '2026-08-03',
});

/** sha256 of every vendored upstream file, at SEO_UPSTREAM.retrieved. */
export const SEO_PINNED_SHA256 = Object.freeze({
  'SKILL.md': 'a06ca86d0b0cc75982ee10651bd7398c0242a13d91d3b4c8eae0bf1360d18b92',
});

export const SEO_REQUIRED_FILES = Object.freeze([...Object.keys(SEO_PINNED_SHA256), 'PROVENANCE.md']);

export const SEO_AEO_UPSTREAM = Object.freeze({
  source_path: '${HOME}/.agents/skills/seo-aeo-best-practices',
  license: 'undeclared (no LICENSE file and no licence frontmatter upstream)',
  retrieved: '2026-08-03',
});

/** sha256 of every vendored upstream file, at SEO_AEO_UPSTREAM.retrieved. */
export const SEO_AEO_PINNED_SHA256 = Object.freeze({
  'SKILL.md': '21d5865242c9939ee524ec0cc396c3098ccd7eac846ca9e043789beef22c9c25',
  'references/aeo-considerations.md': 'b9f7c5eca66a0b3594e57b648838f3e01c8daf39d69dfd542bc14199bc3ccd74',
  'references/eeat-principles.md': '7ff154f8f26df3a597f9f5f72751eda28f19f9064b8126b3c6cfb298fb700b22',
  'references/structured-data.md': 'e61b75e85c4ad34caaa13a0dcf9e9f391ca609d0099db9419860734b5da78949',
  'references/technical-seo.md': '0f35171b8d423125143f10c9ec07a7fd46f7096e1da443b5fa00b8717b20d069',
});

export const SEO_AEO_REQUIRED_FILES = Object.freeze([...Object.keys(SEO_AEO_PINNED_SHA256), 'PROVENANCE.md']);

export const EVE_STRATEGY_SKILLS = Object.freeze([
  { id: 'eve-doctrine' },
  // eve-chief-of-staff-orchestration (MAT-1751): the standing HG-3.5 Chief-of-Staff
  // operating loop that sits beside eve-doctrine — intent translation, CEO lane
  // selection (authenticated CLI by capability, else a budgeted router CEO),
  // ONE named resumable session, the two-phase state proof, governed worker
  // coordination, the Fable-5/gpt-5.6-sol audit policy, the BLOCKED_AUTH /
  // BLOCKED_CAPABILITY / RUNTIME_ERROR taxonomy, and a single decision card back to
  // the founder. Deliberately NOT in SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION
  // below: the seat is permanent, not explicit-invocation-only.
  { id: 'eve-chief-of-staff-orchestration' },
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
  // premium-website-builder: end-to-end local website production with a
  // locked visual thesis, poster-first media, responsive QA and an explicit
  // Human Gate before any public deploy.
  { id: 'premium-website-builder' },
  { id: 'human-design-profile' },
  // blog-writer: a REAL executable long-form/blog skill (replaces the fake "blog-department"
  // prompt label). On-voice (USER.md), SEO-aware, claim-safe, never publishes.
  { id: 'blog-writer' },
  // founder-voice: captures the operator's writing voice into USER.md so on-voice content sounds like them.
  { id: 'founder-voice' },
  // Author production pack (2026-07-20): intent-safe genre routing, the focused
  // essay craft lane and the complete book build/publishing tree. book-publishing
  // is a single skill with nested references/templates, so the normal whole-tree
  // copy preserves its production assets while SKILL.md remains the executable root.
  { id: 'autor-studio' },
  { id: 'essay-writer' },
  { id: 'book-publishing' },
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
  // Skill-owned visual selection: three real image directions in chat, an
  // explicit 1/2/3 choice, then a locked editable artifact build. The Desktop
  // supplies only the managed image capability; it does not hardcode this flow.
  { id: 'visual-direction-gate' },
  // Consumer-safe PowerPoint analysis and production wrapper. It composes the
  // visual-direction gate with EVE's app-managed Office engine and full-deck QA;
  // the operator never sees an OfficeCLI/Ollama/install prompt.
  { id: 'presentation-studio' },
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
  // PLAUD is the first adapter in EVE's general conversation-ingest lane. The
  // bundled tree includes the official-CLI download boundary, local-first data
  // route contract and a fail-closed capability/auth guard.
  { id: 'plaud-recording-ingest', requiredFiles: PLAUD_REQUIRED_FILES },
  // copywriting (1.820.1): vendored third-party conversion-copywriting method,
  // MIT, pinned to one upstream commit and shipped UNCHANGED — see
  // COPYWRITING_UPSTREAM above and the shipped PROVENANCE.md. Text only: no
  // scripts, no executables, no network calls, no product/billing logic.
  {
    id: 'copywriting',
    requiredFiles: COPYWRITING_REQUIRED_FILES,
    pinnedSha256: COPYWRITING_PINNED_SHA256,
  },
  // seo + seo-aeo-best-practices (1.820.2, MAT-1769): two more VENDORED
  // third-party skills under the same byte-identical, digest-pinned contract —
  // see SEO_UPSTREAM / SEO_AEO_UPSTREAM above and the shipped PROVENANCE.md
  // files. Text only: no scripts, no executables, no product/billing logic.
  {
    id: 'seo',
    requiredFiles: SEO_REQUIRED_FILES,
    pinnedSha256: SEO_PINNED_SHA256,
  },
  {
    id: 'seo-aeo-best-practices',
    requiredFiles: SEO_AEO_REQUIRED_FILES,
    pinnedSha256: SEO_AEO_PINNED_SHA256,
  },
]);

/** Just the ids, for callers that want the flat allowlist. */
export const EVE_STRATEGY_SKILL_IDS = Object.freeze(EVE_STRATEGY_SKILLS.map((s) => s.id));

export const DEFAULT_SKILLS_SRC = '/Users/mathiasheinke/Developer/Company.OS/.claude/skills';
export const COMMAND_EVE_SKILLS_SRC_ENV = 'COMMAND_EVE_SKILLS_SRC';
export const COMMAND_EVE_SKILLS_MODE_ENV = 'COMMAND_EVE_SKILLS_MODE';
export const AUTHOR_PRODUCTION_SKILL_IDS = Object.freeze(['autor-studio', 'essay-writer', 'book-publishing']);
export const AUTHOR_PRODUCTION_EXPECTED_FILE_COUNT = 32;
export const AUTHOR_PRODUCTION_EXPECTED_AGGREGATE_SHA256 =
  'bb7ef89f78588dfc056711ec5d763d0e8f49b07e2b38cb316b6a4787cfd442c4';

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
 * Release builds are snapshot-only so an unrelated local Company.OS checkout
 * can never rewrite the reviewed payload. Refresh remains an explicit developer
 * action and may use either a declared source root or the historical default.
 */
export function resolveSkillStageSource({ mode, explicitSourceRoot = '', defaultSourceRoot = DEFAULT_SKILLS_SRC }) {
  const normalizedMode = String(mode || 'refresh')
    .trim()
    .toLowerCase();
  if (normalizedMode === 'snapshot') return { ok: true, mode: 'snapshot', srcRoot: null };
  if (normalizedMode === 'refresh') {
    return {
      ok: true,
      mode: 'refresh',
      srcRoot: String(explicitSourceRoot || defaultSourceRoot).trim(),
    };
  }
  return { ok: false, mode: normalizedMode, srcRoot: null };
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
  { id: 'dangerously-skip-permissions', re: /--dangerously-skip-permissions/i },
  {
    id: 'raw-api-key-assignment',
    re: /\b(?:ANTHROPIC|OPENROUTER|OPENAI|XAI)_API_KEY\s*=/i,
  },
];

export function findForbiddenSkillContent(text) {
  return FORBIDDEN_SKILL_CONTENT.filter((f) => f.re.test(String(text || ''))).map((f) => f.id);
}

export const FORBIDDEN_USER_FACING_CONTENT = [
  { id: 'yolo-copy', re: /\bYOLO\b/i },
  { id: 'dangerously-skip-permissions-copy', re: /--dangerously-skip-permissions/i },
  { id: 'skip-permissions-copy', re: /\bskip\b[\s\w-]{0,80}\bpermissions?\b/i },
  { id: 'bypass-permissions-copy', re: /\bbypass\b[\s\w-]{0,80}\bpermissions?\b/i },
  { id: 'no-sandbox-copy', re: /\bno\s+sandbox\b/i },
];

function collectJsonStringValues(value, prefix = '') {
  if (typeof value === 'string') return [{ path: prefix || '$', text: value }];
  if (Array.isArray(value))
    return value.flatMap((entry, index) => collectJsonStringValues(entry, `${prefix}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) =>
      collectJsonStringValues(entry, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [];
}

export function findForbiddenUserFacingJsonContent(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(String(jsonText || '{}'));
  } catch {
    return [{ path: '$', ids: ['json_parse_failed'] }];
  }

  return collectJsonStringValues(parsed)
    .map((entry) => ({
      path: entry.path,
      ids: FORBIDDEN_USER_FACING_CONTENT.filter((f) => f.re.test(entry.text)).map((f) => f.id),
    }))
    .filter((entry) => entry.ids.length > 0);
}

export const SKILL_IDS_REQUIRING_DISABLE_MODEL_INVOCATION = Object.freeze([
  'ai-coding-delegation',
  'lead-magnet-pdf',
  'legal-enforcement-dach',
  'human-design-profile',
  'local-vision-qa',
  'skill-authoring',
  'voice-first-run',
]);

export const SKILL_IDS_REQUIRING_LINKED_FILES = Object.freeze(['content-machine', 'blog-writer']);

export const SKILL_IDS_REQUIRING_RUNTIME_INVISIBILITY = Object.freeze([
  'eve-doctrine',
  'presentation-studio',
  'lead-magnet-pdf',
  'autor-studio',
  'essay-writer',
  'book-publishing',
  'legal-enforcement-dach',
]);

// Vendored byte-identical skills must NOT be edited to satisfy a LOCAL style
// rule. seo-aeo-best-practices' upstream description reads "Use this skill when
// implementing page SEO, …" — a real trigger phrase the agent routes on, but not
// one of the exact strings the description_missing_trigger check recognises.
// Exempt exactly that one check for exactly that id; every other hygiene rule
// (frontmatter, name, no embedded doctrine, …) still applies in full.
export const VENDORED_SKILL_HYGIENE_EXEMPTIONS = Object.freeze({
  'seo-aeo-best-practices': Object.freeze(['description_missing_trigger']),
});

export function findRuntimeInstallInstructions(text) {
  const patterns = [
    { id: 'runtime-pip-install', re: /\b(?:python\s+-m\s+pip|pip|uv\s+pip)\s+install\b/i },
    { id: 'runtime-brew-install', re: /\bbrew\s+install\b/i },
    { id: 'runtime-npm-install', re: /\b(?:npm|pnpm|bun|yarn)\s+install\b/i },
  ];
  const negation = /\b(?:never|do not|does not|must not|nicht|niemals|kein(?:e|en|er|es)?|ohne)\b/i;
  const failures = new Set();
  for (const paragraph of String(text || '').split(/\n\s*\n/)) {
    const normalized = paragraph.replace(/[*_`]/g, ' ');
    if (negation.test(normalized)) continue;
    for (const pattern of patterns) {
      if (pattern.re.test(normalized)) failures.add(pattern.id);
    }
  }
  return [...failures];
}

function leadingFrontmatter(text) {
  const body = String(text || '');
  if (!body.startsWith('---\n')) return '';
  const end = body.indexOf('\n---', 4);
  return end === -1 ? '' : body.slice(4, end);
}

function frontmatterScalar(frontmatter, key) {
  const lines = String(frontmatter || '').split('\n');
  const keyPattern = new RegExp(`^${key}:\\s*(.*)$`, 'i');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(keyPattern);
    if (!match) continue;

    const inline = match[1].trim();
    if (!/^[>|][+-]?$/.test(inline)) {
      return inline.replace(/^['"]|['"]$/g, '');
    }

    const block = [];
    for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
      const line = lines[blockIndex];
      if (line.trim() && !/^\s/.test(line)) break;
      block.push(line.trim());
    }
    return inline.startsWith('>') ? block.join(' ').trim() : block.join('\n').trim();
  }
  return '';
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

  if (
    skillId !== 'eve-doctrine' &&
    /^## (?:For Command EVE|Hard [Rr]ules \(EVE [Dd]octrine\))$/m.test(String(text || ''))
  ) {
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

  if (SKILL_IDS_REQUIRING_RUNTIME_INVISIBILITY.includes(skillId)) {
    failures.push(...findRuntimeInstallInstructions(text));
  }

  const exemptions = VENDORED_SKILL_HYGIENE_EXEMPTIONS[skillId] ?? [];
  return failures.filter((failure) => !exemptions.includes(failure));
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

function collectJsonPaths(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectJsonPaths(full));
    else if (ent.isFile() && ent.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function collectManifestFiles(root, relativeRoot, reasonCodes) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    reasonCodes.push('author_production_manifest_root_missing');
    return out;
  }
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = path.join(root, entry.name);
    const relativePath = path.posix.join(relativeRoot, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectManifestFiles(fullPath, relativePath, reasonCodes));
      continue;
    }
    if (!entry.isFile()) {
      reasonCodes.push('author_production_manifest_non_file');
      continue;
    }
    const content = fs.readFileSync(fullPath);
    out.push({
      path: relativePath,
      sha256: createHash('sha256').update(content).digest('hex'),
      bytes: content.byteLength,
    });
  }
  return out;
}

/** Bind the shipped Author Studio payload to the independently reviewed source manifest. */
export function verifyAuthorProductionSkillManifest(snapshotRoot) {
  const reasonCodes = [];
  const files = AUTHOR_PRODUCTION_SKILL_IDS.flatMap((skillId) =>
    collectManifestFiles(path.join(snapshotRoot, skillId), skillId, reasonCodes)
  ).toSorted((left, right) => left.path.localeCompare(right.path));
  const manifestText = files.map((file) => `${file.sha256}  ${file.bytes}  ${file.path}`).join('\n') + '\n';
  const aggregateSha256 = createHash('sha256').update(manifestText).digest('hex');
  if (files.length !== AUTHOR_PRODUCTION_EXPECTED_FILE_COUNT) {
    reasonCodes.push('author_production_manifest_file_count_mismatch');
  }
  if (aggregateSha256 !== AUTHOR_PRODUCTION_EXPECTED_AGGREGATE_SHA256) {
    reasonCodes.push('author_production_manifest_hash_mismatch');
  }
  return {
    ok: reasonCodes.length === 0,
    reason_codes: [...new Set(reasonCodes)].toSorted(),
    file_count: files.length,
    aggregate_sha256: aggregateSha256,
  };
}

export function scanForbiddenLocaleContent(localeRoot) {
  const failures = [];
  for (const jsonPath of collectJsonPaths(localeRoot)) {
    let text = '';
    try {
      text = fs.readFileSync(jsonPath, 'utf8');
    } catch {
      continue;
    }
    const forbidden = findForbiddenUserFacingJsonContent(text);
    for (const entry of forbidden) {
      failures.push(`${path.relative(localeRoot, jsonPath)}:${entry.path}:${entry.ids.join(',')}`);
    }
  }
  return failures;
}

/**
 * Fail-closed integrity check for a VENDORED skill: every pinned path must exist
 * AND hash to the pinned sha256. `requiredFiles` only proves presence, which lets an
 * altered vendored file ship silently — the exact failure a pinned third-party
 * dependency exists to prevent. Pure-ish (reads `root`); returns reason strings.
 *
 *   bundled_skill_pinned_file_missing:<id>:<relPath>
 *   bundled_skill_pinned_file_altered:<id>:<relPath>
 */
export function verifyPinnedSkillFiles({ skillId, root, pinnedSha256 }) {
  const failures = [];
  for (const [relativePath, expected] of Object.entries(pinnedSha256 ?? {})) {
    if (!isSafeRelativeSkillLink(relativePath)) {
      failures.push(`bundled_skill_pinned_file_invalid:${skillId}:${relativePath}`);
      continue;
    }
    const fullPath = path.join(root, relativePath);
    if (!isNonEmptyFile(fullPath)) {
      failures.push(`bundled_skill_pinned_file_missing:${skillId}:${relativePath}`);
      continue;
    }
    const actual = createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
    if (actual !== expected) {
      failures.push(`bundled_skill_pinned_file_altered:${skillId}:${relativePath}`);
    }
  }
  return failures;
}

/** Synchronize a directory tree without making the live snapshot disappear. */
function copyTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const sourceEntries = fs.readdirSync(srcDir, { withFileTypes: true });
  const sourceNames = new Set();

  for (const ent of sourceEntries) {
    if (!ent.isDirectory() && !ent.isFile()) continue;
    sourceNames.add(ent.name);
    const from = path.join(srcDir, ent.name);
    const to = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      try {
        if (!fs.statSync(to).isDirectory()) fs.rmSync(to, { recursive: true, force: true });
      } catch {
        // Missing destination is created by the recursive call.
      }
      copyTree(from, to);
    } else if (ent.isFile()) {
      try {
        if (!fs.statSync(to).isFile()) fs.rmSync(to, { recursive: true, force: true });
      } catch {
        // Missing destination is replaced below.
      }
      const stagedFile = `${to}.command-eve-stage-${process.pid}`;
      fs.copyFileSync(from, stagedFile);
      try {
        fs.renameSync(stagedFile, to);
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
        fs.rmSync(to, { recursive: true, force: true });
        fs.renameSync(stagedFile, to);
      } finally {
        fs.rmSync(stagedFile, { force: true });
      }
    }
  }

  for (const ent of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!sourceNames.has(ent.name)) {
      fs.rmSync(path.join(destDir, ent.name), { recursive: true, force: true });
    }
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
    const srcDir = srcRoot ? path.join(srcRoot, skill.id) : null;
    const destDir = path.join(snapshotRoot, skill.id);
    const sourceExists = (() => {
      if (!srcDir) return false;
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
      if (!srcDir) throw new Error(`refresh source unexpectedly missing for ${skill.id}`);
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

    for (const requiredFile of skill.requiredFiles ?? []) {
      if (!isSafeRelativeSkillLink(requiredFile)) {
        failures.push(`bundled_skill_required_file_invalid:${skill.id}:${requiredFile}`);
        log(`REQUIRED FILE INVALID ${skill.id} — ${requiredFile}`);
        continue;
      }
      if (!isNonEmptyFile(path.join(destDir, requiredFile))) {
        failures.push(`bundled_skill_required_file_missing:${skill.id}:${requiredFile}`);
        log(`REQUIRED FILE MISSING ${skill.id} — ${requiredFile}`);
      }
    }

    // FAIL-CLOSED integrity gate for VENDORED skills: missing OR altered both fail.
    for (const failure of verifyPinnedSkillFiles({
      skillId: skill.id,
      root: destDir,
      pinnedSha256: skill.pinnedSha256,
    })) {
      failures.push(failure);
      log(
        `PINNED FILE ${failure.startsWith('bundled_skill_pinned_file_altered') ? 'ALTERED' : 'MISSING/INVALID'} ${failure}`
      );
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
  const source = resolveSkillStageSource({
    mode: compactEnv(process.env[COMMAND_EVE_SKILLS_MODE_ENV]),
    explicitSourceRoot: compactEnv(process.env[COMMAND_EVE_SKILLS_SRC_ENV]),
  });
  if (!source.ok) {
    console.error(
      `[fetch-bundled-skills] FAIL-CLOSED: ${COMMAND_EVE_SKILLS_MODE_ENV} must be refresh or snapshot, got ${source.mode || '<empty>'}`
    );
    process.exitCode = 2;
    return;
  }
  const srcRoot = source.srcRoot;
  const localeRoot = path.join(REPO_ROOT, 'packages', 'desktop', 'src', 'renderer', 'services', 'i18n', 'locales');
  const sourceLabel = source.mode === 'snapshot' ? '<committed-snapshot-only>' : srcRoot;
  log(`source=${sourceLabel}`);
  log(`snapshot=${path.relative(REPO_ROOT, SNAPSHOT_DIR)}`);

  const failures = stageBundledSkills({ srcRoot, snapshotRoot: SNAPSHOT_DIR });
  const authorManifest = verifyAuthorProductionSkillManifest(SNAPSHOT_DIR);
  if (!authorManifest.ok) {
    failures.push(...authorManifest.reason_codes);
    log(
      `AUTHOR MANIFEST INVALID — files=${authorManifest.file_count} aggregate=${authorManifest.aggregate_sha256} reasons=${authorManifest.reason_codes.join(',')}`
    );
  } else {
    log(
      `author-manifest=${authorManifest.aggregate_sha256} files=${authorManifest.file_count} (pinned committed snapshot)`
    );
  }
  for (const failure of scanForbiddenLocaleContent(localeRoot)) {
    failures.push(`locale_forbidden_content:${failure}`);
    log(`FORBIDDEN LOCALE CONTENT — ${failure}`);
  }
  if (failures.length) {
    console.error(
      `[fetch-bundled-skills] FAIL-CLOSED: ${failures.length} skill(s) missing/invalid:\n  ` +
        failures.join('\n  ') +
        `\n  Source: ${sourceLabel}\n  A strategy skill the running agent expects is absent from both ` +
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
