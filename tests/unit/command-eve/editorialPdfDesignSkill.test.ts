/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVE_STRATEGY_SKILL_IDS as RUNTIME_SKILL_IDS } from '@/process/commandEve/runtimeBootstrapCore';
import {
  EVE_STRATEGY_SKILL_IDS as STAGED_SKILL_IDS,
  EVE_STRATEGY_SKILLS,
  findForbiddenSkillContent,
  findRuntimeInstallInstructions,
  findSkillHygieneFailures,
} from '../../../scripts/fetch-bundled-skills.mjs';

const skillRoot = path.resolve(process.cwd(), 'resources/bundled-skills/editorial-pdf-design');
const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
const coverExportQa = fs.readFileSync(path.join(skillRoot, 'references/cover-export-qa.md'), 'utf8');
const renderPdfPagesMacos = fs.readFileSync(path.join(skillRoot, 'scripts/render_pdf_pages_macos.jxa'), 'utf8');
const imageGenServer = fs.readFileSync(
  path.resolve(process.cwd(), 'packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts'),
  'utf8'
);
const publicCapabilityPack = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'public/command-eve-capabilities.json'), 'utf8')
) as { skills?: Array<{ id?: string; default_state?: string }> };

describe('editorial-pdf-design Hermes skill', () => {
  it('ships through both allowlists with its cover-export reference and native macOS renderer', () => {
    expect(RUNTIME_SKILL_IDS as readonly string[]).toContain('editorial-pdf-design');
    expect(STAGED_SKILL_IDS).toEqual([...RUNTIME_SKILL_IDS]);
    expect(EVE_STRATEGY_SKILLS.find((entry) => entry.id === 'editorial-pdf-design')?.requiredFiles).toEqual([
      'references/cover-export-qa.md',
    ]);
    expect(fs.existsSync(path.join(skillRoot, 'references/cover-export-qa.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillRoot, 'scripts/render_pdf_pages_macos.jxa'))).toBe(true);
    expect(publicCapabilityPack.skills?.find((entry) => entry.id === 'editorial-pdf-design')?.default_state).toBe(
      'active'
    );
  });

  it('has hygienic trigger metadata and remains runtime-invisible', () => {
    expect(skill.startsWith('---\nname: editorial-pdf-design\n')).toBe(true);
    expect(findSkillHygieneFailures({ skillId: 'editorial-pdf-design', text: skill })).toEqual([]);
    expect(findRuntimeInstallInstructions(skill)).toEqual([]);
    expect(findForbiddenSkillContent(skill)).toEqual([]);
  });

  it('owns general PDF production while reserving lead-magnet-pdf for lead-generation intent', () => {
    expect(skill).toContain('Use for existing PDFs, general PDF documents, covers, brochures, and reports');
    expect(skill).toContain('review, or visually QA polished PDFs');
    expect(skill).toContain('Use for existing PDFs');
    expect(skill).toContain('use lead-magnet-pdf only for an actual lead-generation asset');
    expect(skill).toContain('Build an editable source in HTML/CSS');
    expect(skill).toContain('managed `pypdf` runtime');
    expect(skill).toContain('Hermes `execute_code`');
    expect(skill).toMatch(/do not invoke generic host\s+`python`/);
    expect(skill).toContain('do not call `terminal` from inside `execute_code`');
    expect(skill).toContain('from pypdf import PdfReader');
    expect(skill).toContain('render every page of the final PDF to one PNG per page');
    expect(skill).toContain(
      '${HERMES_HOME}/skills-command-eve/editorial-pdf-design/scripts/render_pdf_pages_macos.jxa'
    );
    expect(skill).toContain('/usr/bin/osascript -l JavaScript');
    expect(skill).toMatch(/Keep the user's working directory\s+unchanged/);
    expect(skill).toContain('eve_pdf_qa_root="$(mktemp -d /tmp/eve-pdf-qa.XXXXXX)"');
    expect(skill).toContain('Never\n     prefix the renderer with `rm`, `mkdir`, or another cleanup command');
    expect(skill).toContain('"${eve_pdf_qa_root}/pages"');
    expect(skill).not.toContain('From the directory containing this `SKILL.md`');
    expect(skill).toMatch(/uses\s+only\s+macOS PDFKit\/AppKit/);
    expect(skill).toContain('do not invent a managed renderer');
    expect(skill).toContain("Hermes' native `vision_analyze`");
    expect(skill).toContain('separately on every rendered PNG');
    expect(skill).toContain('Page N of M');
    expect(skill).toContain('never send a zero-area');
    expect(skill).toContain('[0, 0, width, height]');
    expect(skill).toContain('never submit\n     unlabeled page images');
    expect(skill).toContain('page-by-page evidence');
    expect(skill).toContain('the final answer must list every page separately');
    expect(skill).toContain('“pages 1–6 checked” is not page-by-page evidence');
    expect(skill).toContain('clipped or');
    expect(skill).toContain('broken tables');
    expect(skill).toContain('app-internal placeholder');
    expect(skill).toContain('a local model is optional, never a prerequisite');
    expect(skill).toContain('Hermes `open_preview`');
    expect(skill).toContain('`computer_use`');
    expect(skill).toMatch(/optional second\s+visual/);
    expect(skill).toContain('neither replace nor gate');
    expect(skill).toContain('exact sentinel');
    expect(skill).toContain('`NEEDS_HUMAN`');
    expect(skill).toMatch(/do\s+not deliver the PDF or claim visual PASS/);
    expect(coverExportQa).toContain('managed `pypdf` structural receipt');
    expect(coverExportQa).toContain('existing Hermes `execute_code` capability');
    expect(coverExportQa).toMatch(/do not invoke generic host\s+`python`/);
    expect(coverExportQa).not.toContain('python - <<');
    expect(coverExportQa).toContain('render every page of the final PDF to one PNG per page');
    expect(coverExportQa).toContain(
      '${HERMES_HOME}/skills-command-eve/editorial-pdf-design/scripts/render_pdf_pages_macos.jxa'
    );
    expect(coverExportQa).toContain('/usr/bin/osascript -l JavaScript');
    expect(coverExportQa).toMatch(/Keep the user's working directory\s+unchanged/);
    expect(coverExportQa).toContain('eve_pdf_qa_root="$(mktemp -d /tmp/eve-pdf-qa.XXXXXX)"');
    expect(coverExportQa).toContain('Never prefix the\nrenderer with `rm`, `mkdir`, or another cleanup command');
    expect(coverExportQa).toContain('"${eve_pdf_qa_root}/pages"');
    expect(coverExportQa).not.toContain("From the directory containing the skill's");
    expect(coverExportQa).toMatch(/uses\s+only\s+macOS PDFKit\/AppKit/);
    expect(coverExportQa).toContain('do not invent a managed renderer');
    expect(coverExportQa).toContain("Hermes' native `vision_analyze`");
    expect(coverExportQa).toContain('separately for every rendered PNG');
    expect(coverExportQa).toContain('Page N of M');
    expect(coverExportQa).toContain('never submit unlabeled page images');
    expect(coverExportQa).toContain('explicit defect checklist');
    expect(coverExportQa).toContain('The final answer must list');
    expect(coverExportQa).toContain('“pages 1–6 checked” is not');
    expect(coverExportQa).toContain('a local model is optional, never a prerequisite');
    expect(coverExportQa).toMatch(/optional second\s+visual/);
    expect(coverExportQa).toContain('neither replace nor gate');
    expect(coverExportQa).toContain('`NEEDS_HUMAN`');
    expect(coverExportQa).toMatch(/do not deliver the PDF or\s+claim visual PASS/);
    expect(skill).toContain('never use `pdftoppm` instead of the\n     bundled PDFKit helper');
    expect(coverExportQa).toContain('Poppler');
    expect(coverExportQa).toContain('optional diagnostics\nonly');
    expect(coverExportQa).toContain('never use `pdftoppm` instead of the bundled PDFKit helper');
    expect(coverExportQa).toMatch(/never install\s+Poppler/);
  });

  it('uses only native PDFKit and emits a verified every-page JSON receipt', () => {
    expect(renderPdfPagesMacos).toContain("ObjC.import('Foundation')");
    expect(renderPdfPagesMacos).toContain("ObjC.import('AppKit')");
    expect(renderPdfPagesMacos).toContain("ObjC.import('PDFKit')");
    expect(renderPdfPagesMacos).toContain('function run(argv)');
    expect(renderPdfPagesMacos).toContain('document.pageAtIndex(index)');
    expect(renderPdfPagesMacos).toContain('pages.length !== pageCount');
    expect(renderPdfPagesMacos).toContain('writeToFileAtomically');
    expect(renderPdfPagesMacos).toContain('true,\n    $({}),\n    error');
    expect(renderPdfPagesMacos).not.toContain('true,\n    null,\n    error');
    expect(renderPdfPagesMacos).toContain("renderer: 'macos-pdfkit'");
    expect(renderPdfPagesMacos).toContain('page_count: pageCount');
    expect(renderPdfPagesMacos).toContain('return JSON.stringify');
    expect(renderPdfPagesMacos).not.toMatch(/https?:\/\//);
    expect(renderPdfPagesMacos).not.toMatch(/\b(?:curl|wget|brew|npm|pip|pdftoppm)\b/);
  });

  it('keeps image generation separate from native visual inspection', () => {
    expect(imageGenServer).toContain("use Hermes'\nnative \\`vision_analyze\\` tool");
    expect(imageGenServer).toContain('This image-generation tool does not analyze images.');
    expect(imageGenServer).not.toContain('Text prompts for generation or analysis');
    expect(imageGenServer).not.toContain('description/analysis');
    expect(imageGenServer).not.toContain('"Analyze image: [what to analyze]"');
  });
});
