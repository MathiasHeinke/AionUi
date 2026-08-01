/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * copywriting — the SNAPSHOT VERIFIER for the first VENDORED third-party skill
 * (Command EVE 1.820.1).
 *
 * Every other bundled skill is authored in Company.OS, so "does the snapshot have
 * a SKILL.md" is a reasonable gate. This one is different: it is an MIT skill from
 * `coreyhaines31/marketingskills`, pinned to ONE upstream commit and shipped
 * byte-identical. For a vendored dependency the interesting failure is not a
 * missing file — it is a file that is still there and no longer the reviewed bytes.
 * Presence checks are structurally blind to that, so this suite pins the sha256 of
 * every upstream file and holds BOTH trees to the same digests:
 *
 *   Company.OS  .claude/skills/copywriting/            (canonical authoring home)
 *   AionUI      resources/bundled-skills/copywriting/  (committed shipped snapshot)
 *
 * The digests live in scripts/fetch-bundled-skills.mjs (COPYWRITING_PINNED_SHA256),
 * which is the same constant the BUILD gate enforces — so this suite and the build
 * cannot drift apart into two different opinions about what "unchanged" means.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_COMMAND_EVE_CAPABILITY_PACK, EVE_STRATEGY_SKILL_IDS } from '@/process/commandEve/runtimeBootstrapCore';
import {
  COPYWRITING_PINNED_SHA256,
  COPYWRITING_REQUIRED_FILES,
  COPYWRITING_UPSTREAM,
  DEFAULT_SKILLS_SRC,
  EVE_STRATEGY_SKILLS,
  findForbiddenSkillContent,
  findSkillHygieneFailures,
  verifyPinnedSkillFiles,
} from '../../../scripts/fetch-bundled-skills.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SNAPSHOT_ROOT = path.join(REPO_ROOT, 'resources/bundled-skills/copywriting');
const PINNED_PATHS = Object.keys(COPYWRITING_PINNED_SHA256 as Record<string, string>);

const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const treeFiles = (root: string): string[] =>
  fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .toSorted();

/**
 * The Company.OS canonical tree, when this machine has that checkout. It is
 * deliberately ABSENT on CI, a fresh clone and every operator box — the committed
 * snapshot is what ships. Resolution mirrors the build script: the explicit
 * COMMAND_EVE_SKILLS_SRC override first, then the historical default root.
 */
const CANONICAL_CANDIDATES = [process.env.COMMAND_EVE_SKILLS_SRC?.trim(), DEFAULT_SKILLS_SRC as string]
  .filter((root): root is string => Boolean(root))
  .map((root) => path.join(root, 'copywriting'));

const canonicalRoot = (): string | null =>
  CANONICAL_CANDIDATES.find((candidate) => {
    try {
      return fs.statSync(path.join(candidate, 'SKILL.md')).isFile();
    } catch {
      return false;
    }
  }) ?? null;

describe('copywriting snapshot: the shipped bytes are the pinned upstream bytes', () => {
  it('hashes every pinned upstream file to its recorded sha256', () => {
    // Per-file, not an aggregate: an aggregate tells you SOMETHING moved,
    // this tells you WHICH file and is the thing a reviewer can act on.
    const actual = Object.fromEntries(PINNED_PATHS.map((rel) => [rel, sha256(path.join(SNAPSHOT_ROOT, rel))]));
    expect(actual).toEqual(COPYWRITING_PINNED_SHA256);
    // And the shared gate agrees (same constant the build enforces).
    expect(
      verifyPinnedSkillFiles({
        skillId: 'copywriting',
        root: SNAPSHOT_ROOT,
        pinnedSha256: COPYWRITING_PINNED_SHA256,
      })
    ).toEqual([]);
  });

  it('ships exactly the vendored tree — four upstream files, the licence, the provenance record', () => {
    expect(treeFiles(SNAPSHOT_ROOT)).toEqual([
      'LICENSE',
      'PROVENANCE.md',
      'SKILL.md',
      'evals/evals.json',
      'references/copy-frameworks.md',
      'references/natural-transitions.md',
    ]);
    // No wrapper file was needed: the upstream SKILL.md already satisfies the
    // bundled-skill hygiene gate as shipped. If a future upstream forces one, it
    // must be an ADDITIONAL documented file — never an edit to the pinned bytes.
    expect(
      findSkillHygieneFailures({
        skillId: 'copywriting',
        text: fs.readFileSync(path.join(SNAPSHOT_ROOT, 'SKILL.md'), 'utf8'),
      })
    ).toEqual([]);
  });

  it('matches the Company.OS canonical tree file-for-file when that checkout is reachable', () => {
    const canonical = canonicalRoot();
    if (!canonical) {
      // Honest no-op, not a silent skip: the canonical checkout genuinely is not
      // on this machine. Both trees are still bound by the pinned digests above,
      // so "not cross-checked here" never means "unverified".
      expect(CANONICAL_CANDIDATES.some((candidate) => fs.existsSync(candidate))).toBe(false);
      return;
    }
    expect(treeFiles(canonical)).toEqual(treeFiles(SNAPSHOT_ROOT));
    for (const relativePath of treeFiles(SNAPSHOT_ROOT)) {
      expect(sha256(path.join(canonical, relativePath)), `${relativePath} must be identical in both repos`).toBe(
        sha256(path.join(SNAPSHOT_ROOT, relativePath))
      );
    }
  });
});

describe('copywriting snapshot: licence + provenance readback', () => {
  const licence = () => fs.readFileSync(path.join(SNAPSHOT_ROOT, 'LICENSE'), 'utf8');
  const provenance = () => fs.readFileSync(path.join(SNAPSHOT_ROOT, 'PROVENANCE.md'), 'utf8');

  it('ships the full MIT licence text with the upstream copyright holder', () => {
    const text = licence();
    expect(text.startsWith('MIT License')).toBe(true);
    expect(text).toContain('Copyright (c) 2025 Corey Haines');
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('The above copyright notice and this permission notice shall be included in all');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });

  it('records the registry slug, repo, pinned commit, version, retrieval date and every digest', () => {
    const text = provenance();
    expect(text).toContain('coreyhaines31/marketingskills@copywriting');
    expect(text).toContain('coreyhaines31/marketingskills');
    expect(text).toContain('7868cb9251fad80a73d26e488a5ad5f6c4a9f335');
    expect(text).toContain('2.0.1');
    expect(text).toContain('2026-08-01');
    expect(text).toContain('MIT');
    for (const [relativePath, digest] of Object.entries(COPYWRITING_PINNED_SHA256 as Record<string, string>)) {
      expect(text, `${relativePath} digest must be recorded`).toContain(digest);
      expect(text).toContain(relativePath);
    }
  });

  it('keeps the provenance record and the enforced constants in agreement', () => {
    // A provenance file that disagrees with the gate is worse than none: it reads
    // authoritative while the build enforces something else.
    expect(provenance()).toContain(COPYWRITING_UPSTREAM.commit);
    expect(COPYWRITING_UPSTREAM.version).toBe('2.0.1');
    expect(fs.readFileSync(path.join(SNAPSHOT_ROOT, 'SKILL.md'), 'utf8')).toMatch(
      new RegExp(`^\\s{2}version:\\s*${COPYWRITING_UPSTREAM.version}$`, 'm')
    );
  });
});

describe('copywriting snapshot: forbidden-content scan', () => {
  // Scoped to the UPSTREAM files. PROVENANCE.md is ours and legitimately NAMES
  // these categories in order to deny them, so scanning it here would flag the
  // denial itself; it gets the readback assertions above instead.
  //
  // Read LAZILY, inside each test: a module-scope read turns a deleted file into a
  // load-time crash that names no property. Every scan below therefore first
  // asserts the file is there, so a missing file fails the scan BY NAME.
  const upstreamFiles = (): Array<{ rel: string; text: string }> =>
    PINNED_PATHS.filter((rel) => rel !== 'LICENSE').map((rel) => {
      const full = path.join(SNAPSHOT_ROOT, rel);
      expect(fs.existsSync(full), `${rel} must be present to be scanned`).toBe(true);
      return { rel, text: fs.readFileSync(full, 'utf8') };
    });

  it('scans a non-trivial corpus (the scan is not vacuously green)', () => {
    const upstream = upstreamFiles();
    expect(upstream).toHaveLength(4);
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

  it('carries no executable content', () => {
    const upstream = upstreamFiles();
    for (const { rel } of upstream) {
      const full = path.join(SNAPSHOT_ROOT, rel);
      // eslint-disable-next-line no-bitwise
      expect(fs.statSync(full).mode & 0o111, `${rel} must not be executable`).toBe(0);
      expect(fs.readFileSync(full, 'utf8').startsWith('#!'), `${rel} must not have a shebang`).toBe(false);
    }
    // The whole tree is text; not one script/binary extension is present.
    expect(
      treeFiles(SNAPSHOT_ROOT).filter((f) => /\.(mjs|cjs|js|ts|sh|bash|zsh|py|rb|pl|exe|dylib|so)$/.test(f))
    ).toEqual([]);
    for (const { rel, text } of upstream) {
      expect(text, rel).not.toMatch(/```(?:bash|sh|shell|zsh|python|javascript|typescript|js|ts)\b/i);
      expect(text, rel).not.toMatch(/\b(?:child_process|subprocess|os\.system|eval\(|execSync|spawnSync)\b/);
    }
  });

  it('makes no network calls and names no remote endpoint', () => {
    for (const { rel, text } of upstreamFiles()) {
      expect(text, rel).not.toMatch(/https?:\/\//i);
      expect(text, rel).not.toMatch(
        /\b(?:curl|wget|fetch\(|axios|XMLHttpRequest|WebSocket|urllib|requests\.(?:get|post))\b/
      );
    }
  });

  it('passes the shared bundled-skill content gate that every other skill passes', () => {
    for (const { rel, text } of upstreamFiles()) {
      expect(findForbiddenSkillContent(text), rel).toEqual([]);
    }
  });
});

describe('copywriting snapshot: bundle wiring', () => {
  it('is allowlisted in BOTH the build staging list and the runtime copy list, in lockstep', () => {
    expect(EVE_STRATEGY_SKILL_IDS as readonly string[]).toContain('copywriting');
    expect(EVE_STRATEGY_SKILLS.map((skill: { id: string }) => skill.id)).toEqual([...EVE_STRATEGY_SKILL_IDS]);
  });

  it('declares fail-closed required files AND digest pins on its allowlist entry', () => {
    const entry = EVE_STRATEGY_SKILLS.find((skill: { id: string }) => skill.id === 'copywriting');
    expect(entry?.requiredFiles).toBe(COPYWRITING_REQUIRED_FILES);
    expect(entry?.pinnedSha256).toBe(COPYWRITING_PINNED_SHA256);
  });

  it('has a user-facing capability card naming its third-party provenance', () => {
    const card = DEFAULT_COMMAND_EVE_CAPABILITY_PACK.skills.find((skill) => skill.id === 'copywriting');
    expect(card).toBeDefined();
    expect(card?.name).not.toBe('copywriting');
    expect(card?.source).toMatch(/MIT/);
    expect(card?.source).toMatch(/Corey Haines/);
  });
});
