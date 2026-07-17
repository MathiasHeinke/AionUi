/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLocalPdfPageCount,
  COMMAND_EVE_PDF_MAX_LOCAL_PAGES,
  CommandEvePdfPreparationError,
  persistPdfSidecar,
  prepareLocalPdf,
  withPdfExtractionDeadline,
} from '@process/commandEve/document/pdfIntelligenceService';
import {
  assessPdfTextQuality,
  buildPdfCitationSidecar,
  parseCloudOcrMarkdownPages,
} from '@process/commandEve/document/pdfIntelligenceCore';

const roots: string[] = [];

function fixture(): { root: string; home: string; pdf: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-pdf-test-'));
  roots.push(root);
  const home = path.join(root, 'seat-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const pdf = path.join(root, 'client.pdf');
  fs.writeFileSync(pdf, '%PDF-1.7\nfixture', { mode: 0o600 });
  return { root, home, pdf };
}

function buildTextPdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${escaped}) Tj\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('PDF intelligence service', () => {
  it('rejects local extraction above the bounded page count', () => {
    expect(() => assertLocalPdfPageCount(COMMAND_EVE_PDF_MAX_LOCAL_PAGES)).not.toThrow();
    expect(() => assertLocalPdfPageCount(COMMAND_EVE_PDF_MAX_LOCAL_PAGES + 1)).toThrowError(
      expect.objectContaining({ reasonCode: 'EVE_PDF_LOCAL_EXTRACTION_FAILED' })
    );
  });

  it('fails an expired local extraction deadline without waiting for the operation', async () => {
    await expect(withPdfExtractionDeadline(new Promise<never>(() => {}), 100, () => 101)).rejects.toMatchObject({
      reasonCode: 'EVE_PDF_LOCAL_EXTRACTION_FAILED',
      message: 'Local PDF extraction exceeded its time limit.',
    });
  });

  it('reads a real born-digital PDF through bundled pdfjs and produces page-cited text', async () => {
    const { home, pdf } = fixture();
    const expectedText =
      'Command EVE extracts this born digital PDF locally and preserves its physical page citation for analysis.';
    fs.writeFileSync(pdf, buildTextPdf(expectedText), { mode: 0o600 });

    const result = await prepareLocalPdf({ filePath: pdf, hermesHome: home });

    expect(result.quality.requiresOcr).toBe(false);
    expect(result.document.page_count).toBe(1);
    expect(result.pages[0]?.text).toContain('Command EVE extracts this born digital PDF locally');
    const sidecar = fs.readFileSync(result.document.sidecar_path, 'utf8');
    expect(sidecar).toContain('## PDF p. 1');
    expect(sidecar).toContain('[PDF p. N]');
  });

  it('extracts locally, writes a private page-citation sidecar and reuses it', async () => {
    const { home, pdf } = fixture();
    let extractionCalls = 0;
    const extractor = async () => {
      extractionCalls += 1;
      return [
        { pageNumber: 1, text: 'Revenue increased by 20 percent and the board approved the plan.' },
        { pageNumber: 2, text: 'The next milestone is scheduled for September 2026.' },
      ];
    };

    const first = await prepareLocalPdf({ filePath: pdf, hermesHome: home, extractor });
    expect(first.quality.requiresOcr).toBe(false);
    expect(first.document.extraction_mode).toBe('local_text');
    expect(first.document.cache_hit).toBe(false);
    const sidecar = fs.readFileSync(first.document.sidecar_path, 'utf8');
    expect(sidecar).toContain('## PDF p. 1');
    expect(sidecar).toContain('## PDF p. 2');
    expect(sidecar).toContain('cite claims from this document as `[PDF p. N]`');
    expect(fs.statSync(first.document.sidecar_path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(first.document.sidecar_path)).mode & 0o777).toBe(0o700);

    const second = await prepareLocalPdf({ filePath: pdf, hermesHome: home, extractor });
    expect(second.document.cache_hit).toBe(true);
    expect(second.document.sidecar_path).toBe(first.document.sidecar_path);
    expect(second.pages).toEqual(first.pages);
    expect(extractionCalls).toBe(1);
  });

  it('rejects a tampered citation sidecar and rebuilds it from the source PDF', async () => {
    const { home, pdf } = fixture();
    const originalText = 'The signed customer agreement starts on 1 September 2026 and runs for twelve months.';
    const first = await prepareLocalPdf({
      filePath: pdf,
      hermesHome: home,
      extractor: async () => [{ pageNumber: 1, text: originalText }],
    });
    fs.appendFileSync(first.document.sidecar_path, '\nInjected cache text.\n');

    let rebuildCalls = 0;
    const rebuilt = await prepareLocalPdf({
      filePath: pdf,
      hermesHome: home,
      extractor: async () => {
        rebuildCalls += 1;
        return [{ pageNumber: 1, text: originalText }];
      },
    });

    expect(rebuildCalls).toBe(1);
    expect(rebuilt.document.cache_hit).toBe(false);
    expect(rebuilt.pages).toEqual([{ pageNumber: 1, text: originalText }]);
    expect(fs.readFileSync(rebuilt.document.sidecar_path, 'utf8')).not.toContain('Injected cache text.');
  });

  it('flags image-only PDFs for explicit OCR consent without writing a misleading sidecar', async () => {
    const { home, pdf } = fixture();
    const result = await prepareLocalPdf({
      filePath: pdf,
      hermesHome: home,
      extractor: async () => [{ pageNumber: 1, text: '' }],
    });
    expect(result.quality.requiresOcr).toBe(true);
    expect(fs.existsSync(result.document.sidecar_path)).toBe(false);
  });

  it('rejects symlink inputs and non-PDF magic', async () => {
    const { root, home, pdf } = fixture();
    const link = path.join(root, 'linked.pdf');
    fs.symlinkSync(pdf, link);
    await expect(
      prepareLocalPdf({ filePath: link, hermesHome: home, extractor: async () => [] })
    ).rejects.toMatchObject({
      reasonCode: 'EVE_PDF_UNSAFE_SOURCE',
    });

    const fake = path.join(root, 'fake.pdf');
    fs.writeFileSync(fake, 'not a pdf');
    await expect(
      prepareLocalPdf({ filePath: fake, hermesHome: home, extractor: async () => [] })
    ).rejects.toMatchObject({
      reasonCode: 'EVE_PDF_BAD_MAGIC',
    });
  });

  it('rejects symlinked cache components without changing or writing through the target', async () => {
    const { root, home, pdf } = fixture();
    const external = path.join(root, 'external-cache-target');
    fs.mkdirSync(external, { mode: 0o755 });
    fs.symlinkSync(external, path.join(home, 'document-intelligence'));

    await expect(
      prepareLocalPdf({
        filePath: pdf,
        hermesHome: home,
        extractor: async () => [{ pageNumber: 1, text: 'Enough trustworthy local text for the citation sidecar.' }],
      })
    ).rejects.toMatchObject({ reasonCode: 'EVE_PDF_UNSAFE_CACHE' });

    expect(fs.statSync(external).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(external)).toEqual([]);
  });

  it('persists cloud OCR as the same private citation contract', () => {
    const { home, pdf } = fixture();
    const pages = parseCloudOcrMarkdownPages('## Page 1\nInvoice total 120 EUR\n\n## Page 2\nDue tomorrow', 2);
    expect(pages).toEqual([
      { pageNumber: 1, text: 'Invoice total 120 EUR' },
      { pageNumber: 2, text: 'Due tomorrow' },
    ]);
    const document = persistPdfSidecar({
      hermesHome: home,
      sourcePath: pdf,
      sha256: 'b'.repeat(64),
      bytes: 100,
      pages,
      extractionMode: 'cloud_ocr',
      requiresOcr: false,
    });
    expect(document.extraction_mode).toBe('cloud_ocr');
    expect(fs.readFileSync(document.sidecar_path, 'utf8')).toContain('Extraction: cloud_ocr');
  });

  it('keeps short/noisy extraction out of the reliable-text lane', () => {
    expect(assessPdfTextQuality([{ pageNumber: 1, text: 'x' }]).requiresOcr).toBe(true);
    expect(
      buildPdfCitationSidecar({
        sourceName: 'x.pdf',
        sha256: 'c'.repeat(64),
        pages: [{ pageNumber: 1, text: 'Text' }],
        extractionMode: 'local_text',
      })
    ).not.toContain('<script>');
    expect(new CommandEvePdfPreparationError('X', 'message').reasonCode).toBe('X');
  });
});
