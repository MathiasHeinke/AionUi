/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * seo + seo-aeo-best-practices — the SNAPSHOT VERIFIER for the second wave of
 * VENDORED third-party skills (Command EVE 1.820.2, MAT-1769).
 *
 * Same contract as copywritingSkillSnapshot.test.ts: these trees are not
 * authored here, they are byte-identical copies of upstream sources, so the
 * interesting failure is not a missing file — it is a file that is still there
 * and no longer the reviewed bytes. Presence checks are structurally blind to
 * that, so this suite pins the sha256 of every upstream file and holds BOTH
 * trees to the same digests:
 *
 *   Company.OS  .claude/skills/seo{,-aeo-best-practices}/   (canonical authoring home)
 *   AionUI      resources/bundled-skills/seo{,-aeo-best-practices}/  (committed snapshot)
 *
 * The digests live in scripts/fetch-bundled-skills.mjs (SEO_PINNED_SHA256 /
 * SEO_AEO_PINNED_SHA256), the same constants the BUILD gate enforces — so this
 * suite and the build cannot drift apart into two different opinions about what
 * "unchanged" means.
 *
 * Licence posture (recorded, never fabricated): seo declares `license: MIT` in
 * its SKILL.md frontmatter but ships NO licence text file anywhere upstream, so
 * there is nothing verbatim to vendor — PROVENANCE.md is the licence record.
 * seo-aeo-best-practices declares NO licence at all; its PROVENANCE.md states
 * that explicitly instead of inventing one.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_COMMAND_EVE_CAPABILITY_PACK, EVE_STRATEGY_SKILL_IDS } from '@/process/commandEve/runtimeBootstrapCore';
import {
  DEFAULT_SKILLS_SRC,
  EVE_STRATEGY_SKILLS,
  SEO_AEO_PINNED_SHA256,
  SEO_AEO_REQUIRED_FILES,
  SEO_AEO_UPSTREAM,
  SEO_PINNED_SHA256,
  SEO_REQUIRED_FILES,
  SEO_UPSTREAM,
  VENDORED_SKILL_HYGIENE_EXEMPTIONS,
  findForbiddenSkillContent,
  findSkillHygieneFailures,
  verifyPinnedSkillFiles,
} from '../../../scripts/fetch-bundled-skills.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const treeFiles = (root: string): string[] =>
  fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .toSorted();

type VendoredSkillSpec = {
  id: string;
  pinnedSha256: Record<string, string>;
  requiredFiles: readonly string[];
  upstream: Record<string, string>;
  expectedTree: string[];
  /** Needles the provenance record MUST carry beyond the per-file digests. */
  provenanceNeedles: string[];
  /** What the user-facing capability card's source must attest. */
  capabilitySource: RegExp;
};

const SKILLS: VendoredSkillSpec[] = [
  {
    id: 'seo',
    pinnedSha256: SEO_PINNED_SHA256 as Record<string, string>,
    requiredFiles: SEO_REQUIRED_FILES,
    upstream: SEO_UPSTREAM,
    expectedTree: ['PROVENANCE.md', 'SKILL.md'],
    provenanceNeedles: [
      // Portable form (Grok review MINOR 13): host-local paths are recorded
      // as ${HOME}-relative so the public repo carries no machine path.
      '${HOME}/.codex/skills/seo',
      'web-quality-skills',
      '1.0',
      'MIT',
      '2026-08-03',
      // The record must document WHY there is no vendored LICENSE file.
      'frontmatter',
    ],
    capabilitySource: /MIT/,
  },
  {
    id: 'seo-aeo-best-practices',
    pinnedSha256: SEO_AEO_PINNED_SHA256 as Record<string, string>,
    requiredFiles: SEO_AEO_REQUIRED_FILES,
    upstream: SEO_AEO_UPSTREAM,
    expectedTree: [
      'PROVENANCE.md',
      'SKILL.md',
      'references/aeo-considerations.md',
      'references/eeat-principles.md',
      'references/structured-data.md',
      'references/technical-seo.md',
    ],
    provenanceNeedles: [
      '${HOME}/.agents/skills/seo-aeo-best-practices',
      '2026-08-03',
      // The licence gap must be NAMED, not papered over.
      'UNDECLARED',
    ],
    capabilitySource: /undeclared/i,
  },
];

/**
 * The Company.OS canonical tree, when this machine has a checkout that carries
 * these skills. Deliberately ABSENT on CI, a fresh clone and every operator box
 * — the committed snapshot is what ships. Resolution mirrors the build script:
 * the explicit COMMAND_EVE_SKILLS_SRC override first, then the historical
 * default root. (For the 1.820.2 capture the canonical tree is the Company.OS
 * worktree whose .claude/skills gained these skills on 2026-08-03; point
 * COMMAND_EVE_SKILLS_SRC at such a checkout to run the cross-check locally.)
 */
const canonicalRoot = (skillId: string): string | null => {
  const candidates = [process.env.COMMAND_EVE_SKILLS_SRC?.trim(), DEFAULT_SKILLS_SRC as string]
    .filter((root): root is string => Boolean(root))
    .map((root) => path.join(root, skillId));
  return (
    candidates.find((candidate) => {
      try {
        return fs.statSync(path.join(candidate, 'SKILL.md')).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
};

describe.each(SKILLS)('$id snapshot: the shipped bytes are the pinned upstream bytes', (skill) => {
  const snapshotRoot = path.join(REPO_ROOT, 'resources/bundled-skills', skill.id);
  const pinnedPaths = Object.keys(skill.pinnedSha256);

  it('hashes every pinned upstream file to its recorded sha256', () => {
    // Per-file, not an aggregate: an aggregate tells you SOMETHING moved,
    // this tells you WHICH file and is the thing a reviewer can act on.
    const actual = Object.fromEntries(pinnedPaths.map((rel) => [rel, sha256(path.join(snapshotRoot, rel))]));
    expect(actual).toEqual(skill.pinnedSha256);
    // And the shared gate agrees (same constant the build enforces).
    expect(
      verifyPinnedSkillFiles({
        skillId: skill.id,
        root: snapshotRoot,
        pinnedSha256: skill.pinnedSha256,
      })
    ).toEqual([]);
  });

  it('ships exactly the vendored tree — upstream files plus the provenance record, no wrapper', () => {
    expect(treeFiles(snapshotRoot)).toEqual(skill.expectedTree);
    // No wrapper file was needed: the upstream SKILL.md satisfies the
    // bundled-skill hygiene gate as shipped. seo-aeo-best-practices reaches that
    // via ONE exactly-scoped exemption (its "Use this skill when …" phrasing is
    // a real trigger the exact-string check does not recognise) — never via an
    // edit to the pinned bytes.
    expect(
      findSkillHygieneFailures({
        skillId: skill.id,
        text: fs.readFileSync(path.join(snapshotRoot, 'SKILL.md'), 'utf8'),
      })
    ).toEqual([]);
  });

  it('matches the Company.OS canonical tree file-for-file when that checkout is reachable', () => {
    const canonical = canonicalRoot(skill.id);
    if (!canonical) {
      // Honest no-op, not a silent skip: no reachable checkout carries this
      // skill. Both trees are still bound by the pinned digests above, so
      // "not cross-checked here" never means "unverified".
      const candidates = [process.env.COMMAND_EVE_SKILLS_SRC?.trim(), DEFAULT_SKILLS_SRC as string].filter(Boolean);
      expect(candidates.some((candidate) => fs.existsSync(path.join(candidate as string, skill.id)))).toBe(false);
      return;
    }
    expect(treeFiles(canonical)).toEqual(treeFiles(snapshotRoot));
    for (const relativePath of treeFiles(snapshotRoot)) {
      expect(sha256(path.join(canonical, relativePath)), `${relativePath} must be identical in both repos`).toBe(
        sha256(path.join(snapshotRoot, relativePath))
      );
    }
  });
});

describe.each(SKILLS)('$id snapshot: provenance readback', (skill) => {
  const snapshotRoot = path.join(REPO_ROOT, 'resources/bundled-skills', skill.id);
  const provenance = () => fs.readFileSync(path.join(snapshotRoot, 'PROVENANCE.md'), 'utf8');

  it('records the exact source path, licence status, retrieval date and every digest', () => {
    const text = provenance();
    for (const needle of skill.provenanceNeedles) {
      expect(text, `provenance must record ${JSON.stringify(needle)}`).toContain(needle);
    }
    for (const [relativePath, digest] of Object.entries(skill.pinnedSha256)) {
      expect(text, `${relativePath} digest must be recorded`).toContain(digest);
      expect(text).toContain(relativePath);
    }
  });

  it('keeps the provenance record and the enforced constants in agreement', () => {
    // A provenance file that disagrees with the gate is worse than none: it
    // reads authoritative while the build enforces something else.
    expect(provenance()).toContain(skill.upstream.source_path);
    expect(provenance()).toContain(skill.upstream.retrieved);
  });
});

describe.each(SKILLS)('$id snapshot: forbidden-content scan', (skill) => {
  // Scoped to the UPSTREAM files. PROVENANCE.md is ours and legitimately NAMES
  // these categories in order to deny them, so scanning it here would flag the
  // denial itself; it gets the readback assertions above instead.
  //
  // Read LAZILY, inside each test: a module-scope read turns a deleted file into
  // a load-time crash that names no property. Every scan below therefore first
  // asserts the file is there, so a missing file fails the scan BY NAME.
  const snapshotRoot = path.join(REPO_ROOT, 'resources/bundled-skills', skill.id);
  const upstreamFiles = (): Array<{ rel: string; text: string }> =>
    Object.keys(skill.pinnedSha256).map((rel) => {
      const full = path.join(snapshotRoot, rel);
      expect(fs.existsSync(full), `${rel} must be present to be scanned`).toBe(true);
      return { rel, text: fs.readFileSync(full, 'utf8') };
    });

  it('scans a non-trivial corpus (the scan is not vacuously green)', () => {
    const upstream = upstreamFiles();
    expect(upstream.length).toBeGreaterThanOrEqual(1);
    expect(upstream.every((file) => file.text.length > 1000)).toBe(true);
  });

  it('carries no secret material', () => {
    for (const { rel, text } of upstreamFiles()) {
      expect(text, rel).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text, rel).not.toMatch(/\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/);
      expect(text, rel).not.toMatch(
        /\b(?:api[_-]?key|secret|password|passwd|token|bearer)\b\s*[:=]\s*['"`]?[A-Za-z0-9_-]{16,}/i
      );
      expect(text, rel).not.toMatch(/\b(?:ANTHROPIC|OPENAI|OPENROUTER|XAI|GEMINI|AWS)_[A-Z_]*KEY\b/);
    }
  });

  it('carries no product / billing / entitlement / credit / history logic', () => {
    for (const { rel, text } of upstreamFiles()) {
      expect(text, rel).not.toMatch(/\b(?:stripe|entitlement|invoice|chargebee|paddle|webhook)\b/i);
      expect(text, rel).not.toMatch(/\b(?:credit_balance|credits_remaining|seat_usage|command-eve\.[a-z-]+)\b/i);
      expect(text, rel).not.toMatch(/\bconversation[_ ]history\b|\bchat[_ ]history\b/i);
    }
  });

  it('ships no executable content — the whole tree is documentation markdown', () => {
    const upstream = upstreamFiles();
    for (const { rel } of upstream) {
      const full = path.join(snapshotRoot, rel);
      // eslint-disable-next-line no-bitwise
      expect(fs.statSync(full).mode & 0o111, `${rel} must not be executable`).toBe(0);
      expect(fs.readFileSync(full, 'utf8').startsWith('#!'), `${rel} must not have a shebang`).toBe(false);
    }
    // The whole tree is text; not one script/binary extension is present.
    expect(
      treeFiles(snapshotRoot).filter((f) => /\.(mjs|cjs|js|ts|sh|bash|zsh|py|rb|pl|exe|dylib|so)$/.test(f))
    ).toEqual([]);
    // The skill itself teaches no process execution. (Code fences in these
    // files — html/xml/css/typescript — are documentation EXAMPLES the agent
    // adapts into an operator's app; nothing runnable ships in the tree.)
    for (const { rel, text } of upstream) {
      expect(text, rel).not.toMatch(/\b(?:child_process|subprocess|os\.system|eval\(|execSync|spawnSync)\b/);
    }
  });

  it('makes no network calls (documentation URLs and example client code excepted)', () => {
    // seo SKILL.md references example.com/schema.org/Google docs as PROSE
    // references; seo-aeo references show an app's own CMS `client.fetch(...)`
    // inside typescript EXAMPLES. Neither is the skill performing a request, so
    // the ban is on invocation tooling, not on the mention of a URL.
    for (const { rel, text } of upstreamFiles()) {
      expect(text, rel).not.toMatch(/\b(?:curl|wget|axios|XMLHttpRequest|WebSocket|urllib|requests\.(?:get|post))\b/);
    }
  });

  it('passes the shared bundled-skill content gate that every other skill passes', () => {
    for (const { rel, text } of upstreamFiles()) {
      expect(findForbiddenSkillContent(text), rel).toEqual([]);
    }
  });
});

describe('seo + seo-aeo-best-practices snapshot: bundle wiring', () => {
  it('both are allowlisted in BOTH the build staging list and the runtime copy list, in lockstep', () => {
    for (const id of ['seo', 'seo-aeo-best-practices']) {
      expect(EVE_STRATEGY_SKILL_IDS as readonly string[]).toContain(id);
    }
    expect(EVE_STRATEGY_SKILLS.map((skill: { id: string }) => skill.id)).toEqual([...EVE_STRATEGY_SKILL_IDS]);
  });

  it.each(SKILLS)('$id declares fail-closed required files AND digest pins on its allowlist entry', (skill) => {
    const entry = EVE_STRATEGY_SKILLS.find((candidate: { id: string }) => candidate.id === skill.id);
    expect(entry?.requiredFiles).toBe(skill.requiredFiles);
    expect(entry?.pinnedSha256).toBe(skill.pinnedSha256);
    // requiredFiles proves PRESENCE; pinnedSha256 proves the BYTES. Every pinned
    // path must also be required, so a deleted file fails on both gates.
    for (const relativePath of Object.keys(skill.pinnedSha256)) {
      expect(skill.requiredFiles).toContain(relativePath);
    }
    expect(skill.requiredFiles).toContain('PROVENANCE.md');
    // No executable / script surface may creep into a vendored text skill.
    expect(skill.requiredFiles.filter((f) => /\.(mjs|js|cjs|sh|py|bash|zsh)$/.test(f))).toEqual([]);
  });

  it.each(SKILLS)('$id has a user-facing capability card naming its third-party provenance', (skill) => {
    const card = DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((candidate) => candidate.id === skill.id);
    expect(card).toBeDefined();
    expect(card?.name).not.toBe(skill.id);
    expect(card?.source).toMatch(skill.capabilitySource);
    expect(card?.source).toMatch(/vendored unchanged/);
  });

  it('the seo-aeo hygiene exemption is exactly scoped — one check, one id, vendored bytes untouched', () => {
    expect(VENDORED_SKILL_HYGIENE_EXEMPTIONS).toEqual({
      'seo-aeo-best-practices': ['description_missing_trigger'],
    });
    // The upstream description really is the phrasing the exemption exists for:
    // prove the check WOULD fire without the exemption, so the exemption can
    // never silently outlive its reason.
    const text = fs.readFileSync(
      path.join(REPO_ROOT, 'resources/bundled-skills/seo-aeo-best-practices/SKILL.md'),
      'utf8'
    );
    expect(text).toContain('Use this skill when');
    expect(VENDORED_SKILL_HYGIENE_EXEMPTIONS['seo-aeo-best-practices']).toContain('description_missing_trigger');
  });
});
