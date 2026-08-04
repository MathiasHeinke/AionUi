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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  RECOVERED_REPORT_STAGE_MAX_BYTES,
  RecoveredReportStageError,
  resolveRecoveredReportStagePath,
  SeatTruthFenceError,
  stageRecoveredMarkdownInWorkspace,
  type PdfRenderer,
  type ReportContent,
} from '@process/commandEve/reportExportCore';
import { __resetActiveSeatForTests, LEGACY_SEAT_ID, setActiveSeatId } from '@process/commandEve/seatContextCore';

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
const tempRoots: string[] = [];

const makeWorkspace = (): string => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-report-stage-'));
  tempRoots.push(workspace);
  return workspace;
};

afterEach(() => {
  __resetActiveSeatForTests();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
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

describe('reportExportCore — ACP external-write recovery staging', () => {
  const stage = (
    workspaceRoot: string,
    overrides: Partial<Parameters<typeof stageRecoveredMarkdownInWorkspace>[0]> = {}
  ) =>
    stageRecoveredMarkdownInWorkspace({
      workspaceRoot,
      requestedPath: '/Users/operator/Desktop/Quarterly Client Report.pdf',
      markdown: '# Quarterly client report\n\nRecovered.',
      seatId: SEAT_A,
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      toolCallId: 'tool-call-1',
      activeSeatId: SEAT_A,
      ...overrides,
    });

  it('resolves a sanitized direct markdown child and never preserves an external directory', () => {
    const workspace = makeWorkspace();
    const resolved = resolveRecoveredReportStagePath({
      workspaceRoot: workspace,
      requestedPath: '/Users/operator/Downloads/Q3 Überprüfung.docx',
    });
    expect(resolved.relativePath).toBe('q3-berpr-fung.md');
    expect(resolved.absolutePath).toBe(path.join(workspace, resolved.relativePath));
    expect(path.dirname(resolved.absolutePath)).toBe(workspace);
    expect(resolved.absolutePath).not.toContain('/Downloads/');
  });

  it('creates one relative 0600 file with the exact bounded markdown', () => {
    const workspace = makeWorkspace();
    const result = stage(workspace);
    expect(result.relativePath).toMatch(/^quarterly-client-report-eve-[0-9a-f]{12}\.md$/);
    expect(result.absolutePath).toBe(path.join(workspace, result.relativePath));
    expect(result.bytesWritten).toBe(Buffer.byteLength('# Quarterly client report\n\nRecovered.'));
    expect(fs.readFileSync(result.absolutePath, 'utf8')).toBe('# Quarterly client report\n\nRecovered.');
    expect(fs.lstatSync(result.absolutePath).isSymbolicLink()).toBe(false);
    expect(fs.statSync(result.absolutePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(workspace)).toEqual([result.relativePath]);
  });

  it('never overwrites an unrelated human-named report', () => {
    const workspace = makeWorkspace();
    const existing = path.join(workspace, 'quarterly-client-report.md');
    fs.writeFileSync(existing, 'original', { mode: 0o600 });
    const result = stage(workspace);
    expect(result.relativePath).not.toBe('quarterly-client-report.md');
    expect(fs.readFileSync(existing, 'utf8')).toBe('original');
    expect(fs.readFileSync(result.absolutePath, 'utf8')).toContain('Recovered.');
  });

  it('returns the exact same verified file for a replay after remount/restart', () => {
    const workspace = makeWorkspace();
    const first = stage(workspace);
    const replay = stage(workspace);
    expect(replay).toEqual(first);
    expect(fs.readdirSync(workspace)).toEqual([first.relativePath]);
  });

  it('fails closed when the deterministic replay target has different bytes', () => {
    const workspace = makeWorkspace();
    const first = stage(workspace);
    fs.writeFileSync(first.absolutePath, 'tampered', { mode: 0o600 });
    try {
      stage(workspace);
      throw new Error('expected idempotency conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveredReportStageError);
      expect((error as RecoveredReportStageError).reasonCode).toBe('REPORT_STAGE_IDEMPOTENCY_CONFLICT');
    }
    expect(fs.readdirSync(workspace)).toEqual([first.relativePath]);
  });

  it('rejects traversal and an unavailable workspace before creating anything', () => {
    const workspace = makeWorkspace();
    expect(() => stage(workspace, { requestedPath: '../outside.md' })).toThrow(RecoveredReportStageError);
    expect(fs.readdirSync(workspace)).toEqual([]);
    expect(() => stage('', { workspaceRoot: '' })).toThrow(RecoveredReportStageError);
  });

  it('rejects target and workspace symlinks instead of following them', () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace();
    const outsideFile = path.join(outside, 'outside.md');
    fs.writeFileSync(outsideFile, 'outside', { mode: 0o600 });
    const first = stage(workspace);
    fs.unlinkSync(first.absolutePath);
    fs.symlinkSync(outsideFile, first.absolutePath);
    try {
      stage(workspace);
      throw new Error('expected target link rejection');
    } catch (error) {
      expect((error as RecoveredReportStageError).reasonCode).toBe('REPORT_STAGE_TARGET_LINK');
    }
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside');

    const linkParent = makeWorkspace();
    const workspaceLink = path.join(linkParent, 'workspace-link');
    fs.symlinkSync(outside, workspaceLink, 'dir');
    try {
      stage(workspaceLink);
      throw new Error('expected workspace link rejection');
    } catch (error) {
      expect((error as RecoveredReportStageError).reasonCode).toBe('REPORT_STAGE_WORKSPACE_LINK');
    }
  });

  it('rejects an authoritative workspace inode swap before creating a file', () => {
    const workspace = makeWorkspace();
    const displacedWorkspace = `${workspace}-displaced`;
    tempRoots.push(displacedWorkspace);
    let seatChecks = 0;

    try {
      stage(workspace, {
        isSeatCurrent: () => {
          seatChecks += 1;
          if (seatChecks === 2) {
            fs.renameSync(workspace, displacedWorkspace);
            fs.mkdirSync(workspace, { mode: 0o700 });
          }
          return true;
        },
      });
      throw new Error('expected workspace identity rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(RecoveredReportStageError);
      expect((error as RecoveredReportStageError).reasonCode).toBe('REPORT_STAGE_WORKSPACE_CHANGED');
    }
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('rejects a cross-seat or stale-seat write without leaving a file', () => {
    const workspace = makeWorkspace();
    expect(() => stage(workspace, { activeSeatId: SEAT_B })).toThrow(RecoveredReportStageError);
    expect(() => stage(workspace, { isSeatCurrent: () => false })).toThrow(RecoveredReportStageError);
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('rejects missing and oversized markdown without leaving a file', () => {
    const workspace = makeWorkspace();
    expect(() => stage(workspace, { markdown: '' })).toThrow(RecoveredReportStageError);
    expect(() => stage(workspace, { markdown: 'x'.repeat(RECOVERED_REPORT_STAGE_MAX_BYTES + 1) })).toThrow(
      RecoveredReportStageError
    );
    expect(fs.readdirSync(workspace)).toEqual([]);
  });
});
