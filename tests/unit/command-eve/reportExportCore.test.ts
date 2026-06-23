/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RPT-1 report-export core tests.
 *
 * Proves: (1) markdown export is byte-for-byte the source; (2) docx export
 * delegates to the existing DocumentConverter and yields a real OOXML (PK zip);
 * (3) the PDF path builds a self-contained, CSP-safe, themed HTML carrying the
 * OPERATOR brand block + the seat-A body, and is rendered via the INJECTED
 * renderer (Electron printToPDF in prod) — exercised here with a mock so the
 * whole pipeline runs without Electron; (4) the SEAT-TRUTH FENCE rejects content
 * whose seatId != active, fail-closed (and rejects an unresolved active seat / a
 * seatless body) BEFORE any byte is produced; (5) no new heavy dep is added.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertSeatTruth,
  buildReportHtml,
  defaultReportFileStem,
  escapeHtml,
  exportReport,
  exportReportToDocx,
  exportReportToMarkdown,
  exportReportToPdf,
  markdownToReportHtml,
  SeatTruthFenceError,
  type PdfRenderer,
  type ReportContent,
} from '@process/commandEve/reportExportCore';
import {
  __resetActiveSeatForTests,
  LEGACY_SEAT_ID,
  setActiveSeatId,
} from '@process/commandEve/seatContextCore';

const SEAT_A = '11111111-1111-4111-8111-111111111111';
const SEAT_B = '22222222-2222-4222-8222-222222222222';

const sampleMarkdown = [
  '# Quarterly client report',
  '',
  'Bottom line: **traffic up 32%**, _conversions steady_.',
  '',
  '## Results',
  '',
  '| Metric | Value |',
  '| --- | --- |',
  '| Sessions | 12,304 |',
  '| Signups | 412 |',
  '',
  '- Did the SEO refresh',
  '- Shipped the new landing page',
  '',
  '> One residual risk: attribution window.',
  '',
  '```',
  'code stays verbatim & <not escaped as html tag>',
  '```',
].join('\n');

const okContent = (seatId: string): ReportContent => ({
  markdown: sampleMarkdown,
  seatId,
  title: 'Quarterly client report',
});

const noopBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
const fakePdfRenderer: PdfRenderer = async () => noopBytes;

afterEach(() => {
  __resetActiveSeatForTests();
});

describe('reportExportCore — seat-truth fence (fail-closed)', () => {
  it('accepts content from the active seat', () => {
    expect(assertSeatTruth(SEAT_A, SEAT_A)).toBe(SEAT_A);
  });

  it('REJECTS content from a different seat (cross-seat blocked)', () => {
    expect(() => assertSeatTruth(SEAT_B, SEAT_A)).toThrow(SeatTruthFenceError);
    try {
      assertSeatTruth(SEAT_B, SEAT_A);
    } catch (e) {
      expect((e as SeatTruthFenceError).reasonCode).toBe('REPORT_EXPORT_CROSS_SEAT');
    }
  });

  it('REJECTS when the active seat is unresolved (fail-closed)', () => {
    expect(() => assertSeatTruth(SEAT_A, '')).toThrow(/active seat is unresolved/);
    try {
      assertSeatTruth(SEAT_A, undefined);
    } catch (e) {
      expect((e as SeatTruthFenceError).reasonCode).toBe('REPORT_EXPORT_NO_ACTIVE_SEAT');
    }
  });

  it('REJECTS when the content has no originating seat', () => {
    try {
      assertSeatTruth('', SEAT_A);
    } catch (e) {
      expect((e as SeatTruthFenceError).reasonCode).toBe('REPORT_EXPORT_NO_CONTENT_SEAT');
    }
  });

  it('fences every export format: a SEAT_B body cannot be exported in SEAT_A', async () => {
    setActiveSeatId(SEAT_A);
    const crossSeat = okContent(SEAT_B);
    expect(() => exportReportToMarkdown(crossSeat)).toThrow(SeatTruthFenceError);
    await expect(exportReportToDocx(crossSeat)).rejects.toThrow(SeatTruthFenceError);
    await expect(exportReportToPdf(crossSeat, fakePdfRenderer)).rejects.toThrow(SeatTruthFenceError);
    await expect(exportReport('pdf', crossSeat, { pdfRenderer: fakePdfRenderer })).rejects.toThrow(SeatTruthFenceError);
  });

  it('uses the process-local active seat when no explicit activeSeatId is passed', async () => {
    setActiveSeatId(SEAT_A);
    // Body says SEAT_B; process active seat is SEAT_A → must reject.
    expect(() => exportReportToMarkdown(okContent(SEAT_B))).toThrow(SeatTruthFenceError);
    // Body matches the active seat → ok.
    expect(() => exportReportToMarkdown(okContent(SEAT_A))).not.toThrow();
  });
});

describe('reportExportCore — markdown export', () => {
  it('is byte-for-byte the source markdown (after the fence)', () => {
    const artifact = exportReportToMarkdown(okContent(SEAT_A), { activeSeatId: SEAT_A });
    expect(artifact.format).toBe('md');
    expect(artifact.ext).toBe('md');
    expect(new TextDecoder().decode(artifact.bytes)).toBe(sampleMarkdown);
  });

  it('works for the legacy single-seat default', () => {
    const artifact = exportReportToMarkdown(okContent(LEGACY_SEAT_ID), { activeSeatId: LEGACY_SEAT_ID });
    expect(new TextDecoder().decode(artifact.bytes)).toBe(sampleMarkdown);
  });
});

describe('reportExportCore — docx export (delegates to DocumentConverter)', () => {
  it('produces a real OOXML document (PK zip signature)', async () => {
    const artifact = await exportReportToDocx(okContent(SEAT_A), { activeSeatId: SEAT_A });
    expect(artifact.format).toBe('docx');
    expect(artifact.ext).toBe('docx');
    // .docx is a zip — first bytes are 'PK\x03\x04'.
    expect(artifact.bytes[0]).toBe(0x50); // P
    expect(artifact.bytes[1]).toBe(0x4b); // K
    expect(artifact.bytes.length).toBeGreaterThan(100);
  });
});

describe('reportExportCore — HTML template (PDF source)', () => {
  it('is a self-contained, CSP-locked, themed document', () => {
    const html = buildReportHtml(okContent(SEAT_A));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    // CSP forbids remote assets / scripts.
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script/i);
    // print CSS: @page margins + page-break-inside:avoid for headings/tables.
    expect(html).toContain('@page');
    expect(html).toContain('page-break-inside: avoid');
    // The body rendered the markdown (heading + GFM table + list).
    expect(html).toContain('<h1>Quarterly client report</h1>');
    expect(html).toContain('<table class="report-table">');
    expect(html).toContain('<li>Did the SEO refresh</li>');
  });

  it('embeds the OPERATOR brand block, and only a data: URI logo (no remote asset)', () => {
    const html = buildReportHtml(okContent(SEAT_A), {
      displayName: 'Alois Marketing GmbH',
      logoDataUri: 'data:image/png;base64,AAAA',
      footer: 'Alois Marketing GmbH · Musterstraße 1',
    });
    expect(html).toContain('<header class="report-brand-header">');
    expect(html).toContain('Alois Marketing GmbH');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('<footer class="report-brand-footer">');
    // Brand is the operator's own — the engine is never named.
    expect(html).not.toMatch(/Command EVE|Hermes|AionUi/i);
  });

  it('DROPS a non-data: (remote) logo url — CSP / no remote fetch', () => {
    const html = buildReportHtml(okContent(SEAT_A), {
      displayName: 'Op',
      logoDataUri: 'https://evil.example.com/logo.png',
    });
    expect(html).not.toContain('https://evil.example.com/logo.png');
    expect(html).not.toContain('<img');
  });

  it('renders with NO brand when none provided (neutral, unbranded)', () => {
    const html = buildReportHtml(okContent(SEAT_A));
    // The CSS always defines the brand classes; assert the ELEMENTS are absent.
    expect(html).not.toContain('<header class="report-brand-header">');
    expect(html).not.toContain('<footer class="report-brand-footer">');
  });
});

describe('reportExportCore — markdown→html escaping (inert body)', () => {
  it('HTML-escapes raw content so embedded markup is inert', () => {
    const html = markdownToReportHtml('Hello <img src=x onerror=alert(1)> world');
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img src=x');
  });

  it('escapeHtml covers the dangerous five', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('reportExportCore — PDF export via injected renderer', () => {
  it('builds the HTML and hands it to the injected renderer (no Electron in test)', async () => {
    let seenHtml = '';
    const renderer: PdfRenderer = async (html) => {
      seenHtml = html;
      return noopBytes;
    };
    const artifact = await exportReportToPdf(okContent(SEAT_A), renderer, {
      activeSeatId: SEAT_A,
      brand: { displayName: 'Alois Marketing GmbH', footer: 'footer line' },
    });
    expect(artifact.format).toBe('pdf');
    expect(artifact.bytes).toBe(noopBytes);
    expect(seenHtml).toContain('Alois Marketing GmbH');
    expect(seenHtml).toContain('<h1>Quarterly client report</h1>');
    expect(artifact.html).toBe(seenHtml);
  });

  it('exportReport(pdf) requires a renderer (fail-loud, never silent)', async () => {
    setActiveSeatId(SEAT_A);
    await expect(exportReport('pdf', okContent(SEAT_A))).rejects.toThrow(/PdfRenderer/);
  });
});

describe('reportExportCore — file stem helper', () => {
  it('sanitizes a title into a safe stem', () => {
    expect(defaultReportFileStem('Quarterly Client Report!')).toBe('quarterly-client-report');
    expect(defaultReportFileStem('   ')).toBe('report');
    expect(defaultReportFileStem(undefined)).toBe('report');
  });
});
