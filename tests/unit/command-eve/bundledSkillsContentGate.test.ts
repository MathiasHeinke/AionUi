/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The BUILD-time content gate (2026-07-06). fetch-bundled-skills refreshes the
 * bundled skill snapshots FROM the canonical Company.OS source at build time. The
 * C2 governance test checks the committed snapshot, but a dangerous source once
 * re-shipped past it (hardened commit, dangerous source re-pulled by the build).
 * findForbiddenSkillContent is the fail-closed check the build runs on what landed:
 * it forbids the permission RUBBER-STAMP framing, while allowing the legitimate
 * operator-opt-in autonomy language.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
// The build-gate logic is exported from the plain build script (ESM .mjs).
import {
  findForbiddenSkillContent,
  findRuntimeInstallInstructions,
  findSkillHygieneFailures,
  FORBIDDEN_SKILL_CONTENT,
} from '../../../scripts/fetch-bundled-skills.mjs';

describe('bundled-skills build content gate', () => {
  it('excludes the retired outbound tree from the signed app payload', () => {
    const builder = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'packages/desktop/electron-builder.yml'),
      'utf8'
    );
    expect(builder).toMatch(
      /from: resources\/bundled-skills[\s\S]*!marketing-outbound[\s\S]*!marketing-outbound\/\*\*/
    );
  });

  it('flags the "WRONG for automation" rubber-stamp framing', () => {
    expect(findForbiddenSkillContent('the safe/exit option (WRONG for automation)')).toContain('wrong-for-automation');
  });

  it('flags auto-accepting a permission/bypass warning', () => {
    expect(
      findForbiddenSkillContent('Permissions warning → arrow **Down** to the accept option, then Enter')
    ).toContain('auto-accept-permission-warning');
    expect(
      findForbiddenSkillContent('| Bypass-permissions warning | safe/exit (WRONG) | send Down + Enter |')
    ).toContain('bypass-permissions-warning-row');
  });

  it('does NOT flag the legitimate governance / opt-in autonomy language', () => {
    const safe = [
      'EVE is the gate: she judges each action and escalates the consequential to the operator (HG-4).',
      'Autonomous mode is an explicit operator opt-in, scope-bounded to a disposable worktree.',
      'Inviolable hard floors: never publish/deploy, never touch secrets or another seat.',
    ].join('\n');
    expect(findForbiddenSkillContent(safe)).toEqual([]);
  });

  it('handles empty / nullish input without throwing', () => {
    expect(findForbiddenSkillContent('')).toEqual([]);
    expect(findForbiddenSkillContent(undefined)).toEqual([]);
    expect(FORBIDDEN_SKILL_CONTENT.length).toBeGreaterThanOrEqual(3);
  });

  it('the actually-shipped bundled ai-coding-delegation SKILL.md passes the gate (end-to-end)', () => {
    const body = fs.readFileSync(
      path.resolve(__dirname, '../../../resources/bundled-skills/ai-coding-delegation/SKILL.md'),
      'utf8'
    );
    expect(findForbiddenSkillContent(body)).toEqual([]);
  });

  it('fails closed on consumer-facing package-manager instructions while allowing explicit prohibitions', () => {
    expect(findRuntimeInstallInstructions('Install: `brew install graphviz`')).toContain('runtime-brew-install');
    expect(findRuntimeInstallInstructions('Run `pip install pymupdf` now.')).toContain('runtime-pip-install');
    expect(findRuntimeInstallInstructions('Never run `pip install pymupdf` in a consumer task.')).toEqual([]);
  });

  it('keeps the shipped document artifact skills runtime-invisible', () => {
    for (const id of [
      'eve-doctrine',
      'presentation-studio',
      'lead-magnet-pdf',
      'autor-studio',
      'essay-writer',
      'book-publishing',
      'legal-enforcement-dach',
    ]) {
      const body = fs.readFileSync(path.resolve(__dirname, `../../../resources/bundled-skills/${id}/SKILL.md`), 'utf8');
      expect(findRuntimeInstallInstructions(body), id).toEqual([]);
      expect(findSkillHygieneFailures({ skillId: id, text: body }), id).toEqual([]);
    }
  });

  it('does NOT false-positive on a doc that DESCRIBES the anti-pattern in order to forbid it', () => {
    // The safe skill names the rubber-stamp to forbid it — the exact-pattern gate is
    // chosen deliberately so that describing the anti-pattern does not trip it. (The
    // semantic layer — "the governance model must be PRESENT" — is the C2 test.)
    const describesAntiPattern =
      'The anti-pattern to never fall into: blindly sending Down/Enter to accept every permission or bypass warning — that is rubber-stamping, not judgment, and it turns the gate off.';
    expect(findForbiddenSkillContent(describesAntiPattern)).toEqual([]);
  });

  it('ships the author-production skills with hygienic trigger metadata and no forbidden content', () => {
    for (const id of ['autor-studio', 'essay-writer', 'book-publishing']) {
      const body = fs.readFileSync(path.resolve(__dirname, `../../../resources/bundled-skills/${id}/SKILL.md`), 'utf8');
      expect(findSkillHygieneFailures({ skillId: id, text: body }), id).toEqual([]);
      expect(findForbiddenSkillContent(body), id).toEqual([]);
    }
  });

  it('keeps genre intent binding and every publication mutation behind a Human-Gate', () => {
    const authorStudio = fs.readFileSync(
      path.resolve(__dirname, '../../../resources/bundled-skills/autor-studio/SKILL.md'),
      'utf8'
    );
    const essayWriter = fs.readFileSync(
      path.resolve(__dirname, '../../../resources/bundled-skills/essay-writer/SKILL.md'),
      'utf8'
    );
    const bookPublishing = fs.readFileSync(
      path.resolve(__dirname, '../../../resources/bundled-skills/book-publishing/SKILL.md'),
      'utf8'
    );

    expect(authorStudio).toContain('Das genannte Genre ist das gelieferte Genre.');
    expect(authorStudio).toContain('Niemals aus einem Essay-Auftrag ein Buch bauen.');
    expect(essayWriter).toMatch(/Genre-Grenze:[\s\S]*ESSAYS[\s\S]*kein Buch/);
    expect(bookPublishing).toMatch(/DRM[\s\S]*KDP Select[\s\S]*finaler Publish-Klick[\s\S]*Human-Gates/);
  });

  it('ships the complete 30-file book-production tree including references, checklists and build templates', () => {
    const root = path.resolve(__dirname, '../../../resources/bundled-skills/book-publishing');
    const files = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .toSorted();

    expect(files).toHaveLength(30);
    expect(files).toEqual(
      expect.arrayContaining([
        'SKILL.md',
        'references/01_concept_and_positioning.md',
        'references/12_launch_and_funnel.md',
        'references/checklists/pre_publish_qa_checklist.md',
        'references/templates/build_ebook.sh',
        'references/templates/build_interior.sh',
      ])
    );
  });

  it('ships the complete premium website builder with local-first media and deploy gates', () => {
    const root = path.resolve(__dirname, '../../../resources/bundled-skills/premium-website-builder');
    const files = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .toSorted();
    const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');

    expect(files).toEqual([
      'SKILL.md',
      'agents/openai.yaml',
      'references/art-direction.md',
      'references/poster-first-lazy-video.md',
      'references/quality-gates.md',
      'references/responsive-interaction.md',
    ]);
    expect(findSkillHygieneFailures({ skillId: 'premium-website-builder', text: skill })).toEqual([]);
    expect(findForbiddenSkillContent(skill)).toEqual([]);
    expect(skill).toMatch(/poster[- ]first/i);
    expect(skill).toMatch(/public deploy[\s\S]*explicit/i);
    expect(skill).toMatch(/BLOCKED_CAPABILITY/);
  });
});
