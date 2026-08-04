/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE REPORT EXPORT core (Lane C / RPT-1 — the client-report deliverable
 * exporter).
 *
 * THE GAP THIS CLOSES. Today there is NO PDF/report export. The orphan
 * `DocumentConverter` (common/chat/document/DocumentConverter.ts) does
 * Markdown↔Word/Excel but has NO PDF path and ZERO callers; the Preview panel's
 * `handleDownload` only dumps raw .md/.html/.txt with no styling, no brand, no
 * pagination. This module turns an EVE-produced report (the in-memory markdown of
 * the ACTIVE seat's Preview artifact) into a clean, paginated, OPERATOR-branded
 * deliverable in three formats:
 *   - PDF   via Electron's OWN bundled Chromium (webContents.printToPDF over a
 *           themed, self-contained, CSP-safe HTML page in an offscreen
 *           BrowserWindow) — NO heavy puppeteer / headless-chrome dep.
 *   - DOCX  by delegating to the existing-but-unused
 *           `DocumentConverter.markdownToWord` (this is its first caller).
 *   - MD    the source markdown, verbatim.
 *
 * SEAT-TRUTH FENCE (load-bearing, RPT-4). The export is a PURE function of content
 * the renderer already holds for the ACTIVE conversation/seat. `assertSeatTruth`
 * asserts `content.seatId === activeSeatId` and FAILS CLOSED otherwise — it NEVER
 * queries a store by seat to "gather" a report, never globs across seat
 * workspaces. The only non-seat-A content in the output is the OPERATOR's own
 * brand block (logo/name/footer), which is intentionally seat-independent and
 * carries zero client data — and is the OPERATOR's brand, NEVER Command EVE's.
 * The deliverable is a static file written to disk; the recipient never logs in,
 * there is no auth/session/live-fetch embedded.
 *
 * PURE / INJECTABLE. The HTML template builder, the markdown→HTML conversion, the
 * seat-fence gate, and the docx delegation are all pure and unit-test in plain
 * node/vitest. The single Electron-dependent step (printToPDF) is injected via a
 * `PdfRenderer` so the PDF path is fully exercised under test with a mock, and
 * the real Electron renderer lives in a thin, lazily-imported wrapper that never
 * loads `electron` in a test/non-Electron context.
 */

import { documentConverter } from '@/common/chat/document/DocumentConverter';
import { getActiveSeatId } from '@process/commandEve/seatContextCore';
import fs from 'node:fs';
import path from 'node:path';

/** Supported export formats. */
export type ReportExportFormat = 'pdf' | 'docx' | 'md';

/**
 * The operator-level brand block (RPT-3 fills this; seat-INDEPENDENT, zero client
 * data). It is the only non-seat-A content allowed in the output, and it is the
 * OPERATOR's own — never Command EVE / EVE / Hermes.
 */
export interface OperatorBrand {
  /** Operator/agency display name shown in the header. */
  displayName?: string;
  /**
   * A logo image as a self-contained `data:` URI (base64). MUST be a data URI so
   * the print HTML stays CSP-safe with NO remote asset fetch. A non-data URL is
   * dropped (fail-safe: no remote load) rather than embedded.
   */
  logoDataUri?: string;
  /** Footer line (e.g. the agency's legal name / contact). */
  footer?: string;
}

/**
 * The content to export. `seatId` is the seat the content ORIGINATED in; the
 * fence asserts it equals the active seat before anything is generated.
 */
export interface ReportContent {
  /** The report markdown (the exact in-memory content of the active artifact). */
  markdown: string;
  /** The seat this content originated in (for the fail-closed seat fence). */
  seatId: string;
  /** Optional human title used in the document <title> / first-page heading. */
  title?: string;
}

export interface ReportExportOptions {
  brand?: OperatorBrand;
  /**
   * The active seat id to fence against. Defaults to the process-local active
   * seat (`getActiveSeatId()`), so a caller cannot accidentally widen the fence
   * by omitting it.
   */
  activeSeatId?: string;
}

/** Result of building an export artifact (bytes + a suggested file extension). */
export interface ReportExportArtifact {
  format: ReportExportFormat;
  /** The bytes to write to disk. */
  bytes: Uint8Array;
  /** Suggested extension WITHOUT the dot (e.g. 'pdf'). */
  ext: ReportExportFormat;
  /** The self-contained HTML used for the PDF (exposed for PDF only; testable). */
  html?: string;
}

/**
 * Injectable PDF renderer: takes self-contained HTML, returns PDF bytes. The real
 * implementation (Electron offscreen BrowserWindow + webContents.printToPDF) is
 * provided by `createElectronPdfRenderer()`; tests inject a mock so the whole
 * HTML/brand/fence pipeline is exercised without Electron.
 */
export type PdfRenderer = (html: string) => Promise<Uint8Array>;

/** Raised when the seat-truth fence rejects (content seat ≠ active seat). */
export class SeatTruthFenceError extends Error {
  readonly reasonCode: string;
  constructor(message: string, reasonCode = 'REPORT_EXPORT_SEAT_FENCE') {
    super(message);
    this.name = 'SeatTruthFenceError';
    this.reasonCode = reasonCode;
  }
}

/**
 * FAIL-CLOSED seat-truth fence. Asserts the content originated in the ACTIVE seat
 * before any export byte is produced. Rejects when:
 *   - the active seat is unresolvable / empty, OR
 *   - the content's seatId is missing / empty, OR
 *   - content.seatId !== activeSeatId.
 *
 * It NEVER reads a store, never touches the filesystem, never globs seats — it is
 * a pure equality assertion on data the caller already holds, so a seat-B leak is
 * impossible by construction (no seat-B data is ever in scope here).
 */
export function assertSeatTruth(
  contentSeatId: string | undefined | null,
  activeSeatId: string | undefined | null
): string {
  const active = typeof activeSeatId === 'string' ? activeSeatId.trim() : '';
  if (active.length === 0) {
    throw new SeatTruthFenceError(
      'Report export refused: active seat is unresolved (fail-closed).',
      'REPORT_EXPORT_NO_ACTIVE_SEAT'
    );
  }
  const origin = typeof contentSeatId === 'string' ? contentSeatId.trim() : '';
  if (origin.length === 0) {
    throw new SeatTruthFenceError(
      'Report export refused: content has no originating seat (fail-closed).',
      'REPORT_EXPORT_NO_CONTENT_SEAT'
    );
  }
  if (origin !== active) {
    throw new SeatTruthFenceError(
      `Report export refused: content seat (${JSON.stringify(origin)}) is not the active seat (${JSON.stringify(active)}) — cross-seat export blocked.`,
      'REPORT_EXPORT_CROSS_SEAT'
    );
  }
  return active;
}

/** Resolve the active seat to fence against (explicit option wins, else process-local). */
function resolveActiveSeatId(options?: ReportExportOptions): string {
  if (options?.activeSeatId && options.activeSeatId.trim().length > 0) return options.activeSeatId.trim();
  return getActiveSeatId();
}

// ---------------------------------------------------------------------------
// HTML escaping + minimal, dependency-free markdown → HTML
// ---------------------------------------------------------------------------

/** HTML-escape a raw string (defends the print HTML from injection in content). */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render inline markdown (bold/italic/code/links) AFTER block-level escaping. */
function renderInline(escaped: string): string {
  let out = escaped;
  // inline code first so its contents are not further transformed
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // bold (**x**), then italic (*x* / _x_)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  // links [text](http...) — only allow http(s)/mailto to stay CSP-safe & inert.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_m, text, href) => {
    return `<a href="${href}">${text}</a>`;
  });
  return out;
}

/** True when a line is a GFM table separator row (`| --- | --- |`). */
function isTableSeparatorRow(s: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(s);
}

/** Split a `| a | b |` row into trimmed cells. */
function splitTableRow(s: string): string[] {
  return s
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * A small, self-contained markdown→HTML converter (NO new dep). Supports the
 * subset a client report uses: ATX headings, paragraphs, unordered/ordered
 * lists, GFM tables, fenced code blocks, blockquotes, and horizontal rules. All
 * text is HTML-escaped first, so raw HTML in the markdown is rendered inert
 * (never executed) — defensive for an attacker-influenced report body.
 */
export function markdownToReportHtml(markdown: string): string {
  const lines = (markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  let inCode = false;
  let codeBuf: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code blocks
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (inCode) {
        html.push(`<pre class="code"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      i += 1;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i += 1;
      continue;
    }

    // GFM table: a header row followed by a separator row
    if (/\|/.test(line) && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
      closeList();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim().length > 0) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${header.map((c) => `<th>${renderInline(escapeHtml(c))}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(escapeHtml(c))}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      html.push(`<table class="report-table">${thead}${tbody}</table>`);
      continue;
    }

    // headings
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`);
      i += 1;
      continue;
    }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      html.push('<hr />');
      i += 1;
      continue;
    }

    // blockquote
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      html.push(`<blockquote>${renderInline(escapeHtml(quote[1]))}</blockquote>`);
      i += 1;
      continue;
    }

    // unordered list
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${renderInline(escapeHtml(ul[1]))}</li>`);
      i += 1;
      continue;
    }

    // ordered list
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${renderInline(escapeHtml(ol[1]))}</li>`);
      i += 1;
      continue;
    }

    // blank line
    if (line.trim().length === 0) {
      closeList();
      i += 1;
      continue;
    }

    // paragraph
    closeList();
    html.push(`<p>${renderInline(escapeHtml(line))}</p>`);
    i += 1;
  }

  if (inCode) {
    // unterminated fence — flush as code so nothing is lost
    html.push(`<pre class="code"><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  closeList();
  return html.join('\n');
}

// ---------------------------------------------------------------------------
// Self-contained, CSP-safe, print-themed HTML document
// ---------------------------------------------------------------------------

/** The operator brand HEADER block (logo + name). Empty when no brand provided. */
function buildBrandHeader(brand?: OperatorBrand): string {
  if (!brand) return '';
  const name = brand.displayName ? `<span class="brand-name">${escapeHtml(brand.displayName)}</span>` : '';
  // Only embed a data: URI — never a remote URL (CSP / no remote asset fetch).
  const logo =
    brand.logoDataUri && brand.logoDataUri.startsWith('data:')
      ? `<img class="brand-logo" alt="" src="${brand.logoDataUri}" />`
      : '';
  if (!logo && !name) return '';
  return `<header class="report-brand-header">${logo}${name}</header>`;
}

/** The operator brand FOOTER block. Empty when no footer provided. */
function buildBrandFooter(brand?: OperatorBrand): string {
  if (!brand?.footer) return '';
  return `<footer class="report-brand-footer">${escapeHtml(brand.footer)}</footer>`;
}

/**
 * Build the complete, self-contained HTML document for printToPDF. NO remote
 * assets (a strict CSP meta tag forbids them, and only inline styles + an
 * embedded data: logo are used), print CSS with @page margins and
 * page-break-inside:avoid for headings/tables, and the operator brand
 * header/footer. The body is the rendered (escaped) report markdown — the only
 * client data, and it is seat-A's own.
 */
export function buildReportHtml(content: ReportContent, brand?: OperatorBrand): string {
  const title = content.title?.trim() || 'Report';
  const body = markdownToReportHtml(content.markdown);
  const header = buildBrandHeader(brand);
  const footer = buildBrandFooter(brand);
  // CSP: default-src 'none' + allow inline styles + data: images only. No remote
  // fetch, no script execution — the file is inert.
  const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    color: #1a1a1a;
    font-size: 12pt;
    line-height: 1.5;
  }
  .report-brand-header {
    display: flex; align-items: center; gap: 12px;
    padding-bottom: 12px; margin-bottom: 20px;
    border-bottom: 1px solid #e2e2e2;
  }
  .brand-logo { max-height: 40px; max-width: 200px; }
  .brand-name { font-size: 14pt; font-weight: 600; }
  .report-brand-footer {
    margin-top: 28px; padding-top: 10px;
    border-top: 1px solid #e2e2e2;
    font-size: 9pt; color: #777;
  }
  h1, h2, h3, h4, h5, h6 { page-break-inside: avoid; page-break-after: avoid; line-height: 1.25; }
  h1 { font-size: 20pt; margin: 0 0 12px; }
  h2 { font-size: 16pt; margin: 22px 0 8px; }
  h3 { font-size: 13pt; margin: 18px 0 6px; }
  p { margin: 0 0 10px; }
  ul, ol { margin: 0 0 10px 22px; }
  li { margin: 0 0 4px; }
  blockquote { margin: 0 0 12px; padding: 6px 14px; border-left: 3px solid #d0d0d0; color: #555; }
  hr { border: none; border-top: 1px solid #e2e2e2; margin: 18px 0; }
  pre.code { background: #f5f5f5; padding: 10px 12px; border-radius: 4px; font-size: 10pt; overflow-wrap: anywhere; white-space: pre-wrap; page-break-inside: avoid; }
  code { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 10.5pt; }
  table.report-table { border-collapse: collapse; width: 100%; margin: 0 0 14px; page-break-inside: avoid; }
  table.report-table th, table.report-table td { border: 1px solid #d8d8d8; padding: 6px 9px; text-align: left; vertical-align: top; }
  table.report-table thead th { background: #f2f2f2; font-weight: 600; }
  a { color: #1a1a1a; text-decoration: underline; }
</style>
</head>
<body>
${header}
<main class="report-body">
${body}
</main>
${footer}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Per-format exporters (all behind the seat-truth fence)
// ---------------------------------------------------------------------------

/** Markdown export — the source bytes, verbatim (after the fence). */
export function exportReportToMarkdown(content: ReportContent, options?: ReportExportOptions): ReportExportArtifact {
  assertSeatTruth(content.seatId, resolveActiveSeatId(options));
  return {
    format: 'md',
    ext: 'md',
    bytes: new TextEncoder().encode(content.markdown ?? ''),
  };
}

/**
 * DOCX export — delegates to the existing (previously-unused)
 * `DocumentConverter.markdownToWord`. This is its FIRST caller (RPT-1 wires the
 * orphan converter). Behind the seat-truth fence.
 */
export async function exportReportToDocx(
  content: ReportContent,
  options?: ReportExportOptions
): Promise<ReportExportArtifact> {
  assertSeatTruth(content.seatId, resolveActiveSeatId(options));
  const buffer = await documentConverter.markdownToWord(content.markdown ?? '');
  return {
    format: 'docx',
    ext: 'docx',
    bytes: new Uint8Array(buffer),
  };
}

/**
 * PDF export — render the themed self-contained HTML, then hand it to the
 * injected `PdfRenderer` (Electron printToPDF in production). Behind the
 * seat-truth fence. The returned artifact also carries the HTML so callers/tests
 * can assert the brand block + body without re-deriving it.
 */
export async function exportReportToPdf(
  content: ReportContent,
  renderer: PdfRenderer,
  options?: ReportExportOptions
): Promise<ReportExportArtifact> {
  assertSeatTruth(content.seatId, resolveActiveSeatId(options));
  const html = buildReportHtml(content, options?.brand);
  const bytes = await renderer(html);
  return { format: 'pdf', ext: 'pdf', bytes, html };
}

/**
 * Unified entry used by the IPC bridge: dispatch by format, all behind the fence.
 * The PDF renderer is injected (the bridge passes the Electron one).
 */
export async function exportReport(
  format: ReportExportFormat,
  content: ReportContent,
  options: ReportExportOptions & { pdfRenderer?: PdfRenderer } = {}
): Promise<ReportExportArtifact> {
  switch (format) {
    case 'md':
      return exportReportToMarkdown(content, options);
    case 'docx':
      return exportReportToDocx(content, options);
    case 'pdf': {
      if (!options.pdfRenderer) {
        throw new Error('exportReport: a PdfRenderer must be provided for PDF export.');
      }
      return exportReportToPdf(content, options.pdfRenderer, options);
    }
    default: {
      const never: never = format;
      throw new Error(`exportReport: unsupported format ${JSON.stringify(never)}.`);
    }
  }
}

/**
 * Build the real Electron PDF renderer: render the HTML in an OFFSCREEN, hidden
 * BrowserWindow with web security on and node integration off (the HTML is inert
 * anyway), wait for load, call `webContents.printToPDF`, and always destroy the
 * window. Lazily imports `electron` so this module never pulls Electron into a
 * test / non-Electron context. NO new dependency — uses Electron's own Chromium.
 */
export function createElectronPdfRenderer(): PdfRenderer {
  return async (html: string): Promise<Uint8Array> => {
    // Lazy import keeps `electron` out of unit/non-Electron contexts.
    const { BrowserWindow } = await import('electron');
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 1130,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        javascript: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
        webviewTag: false,
        experimentalFeatures: false,
        enableWebSQL: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    try {
      const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      await win.loadURL(dataUrl);
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        margins: { marginType: 'default' },
        pageSize: 'A4',
      });
      return new Uint8Array(pdf);
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  };
}

/** Default file-name stem (sanitized) for a report artifact. */
export function defaultReportFileStem(title?: string): string {
  const base = (title?.trim() || 'report')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return base.length > 0 ? base : 'report';
}

// ---------------------------------------------------------------------------
// ACP external-write recovery staging
// ---------------------------------------------------------------------------

/** Largest recovered markdown body Main will stage into a conversation workspace. */
export const RECOVERED_REPORT_STAGE_MAX_BYTES = 1024 * 1024;
/** `name.md` plus at most fifteen deterministic collision suffixes. */
export const RECOVERED_REPORT_STAGE_MAX_CANDIDATES = 16;

export type RecoveredReportStagePath = {
  /** Direct-child file name, safe to return as Preview metadata. */
  relativePath: string;
  /** Main-only absolute destination. Never crosses the renderer bridge. */
  absolutePath: string;
};

export type RecoveredReportStageResult = RecoveredReportStagePath & {
  bytesWritten: number;
};

export type RecoveredReportStageInput = {
  /** Authoritative conversation workspace fetched from AionCore by Main. */
  workspaceRoot: string;
  /** Original path or path-free basename hint; used only to derive a safe name. */
  requestedPath: string;
  markdown: string;
  /** Seat captured before Main fetched the conversation. */
  seatId: string;
  /** Current seat at the staging boundary. Must equal `seatId`. */
  activeSeatId: string;
  /** Optional live seat/revision fence checked before and after the write. */
  isSeatCurrent?: () => boolean;
};

export class RecoveredReportStageError extends Error {
  readonly reasonCode: string;
  constructor(message: string, reasonCode: string) {
    super(message);
    this.name = 'RecoveredReportStageError';
    this.reasonCode = reasonCode;
  }
}

function stageError(reasonCode: string, message: string): never {
  throw new RecoveredReportStageError(message, reasonCode);
}

function portableReportBasename(requestedPath: string): string {
  if (
    typeof requestedPath !== 'string' ||
    requestedPath.trim().length === 0 ||
    requestedPath.length > 4096 ||
    requestedPath.includes('\0')
  ) {
    return stageError('REPORT_STAGE_REQUESTED_NAME_INVALID', 'Recovered report staging requires a bounded file name.');
  }
  const segments = requestedPath.trim().split(/[\\/]+/);
  if (segments.some((segment) => segment === '..')) {
    return stageError('REPORT_STAGE_TRAVERSAL', 'Recovered report staging rejected a traversal segment.');
  }
  const basename = segments.at(-1)?.trim();
  if (!basename || basename === '.' || basename === '..') {
    return stageError('REPORT_STAGE_REQUESTED_NAME_INVALID', 'Recovered report staging requires a file name.');
  }
  return basename;
}

/**
 * Resolve one deterministic, direct-child markdown candidate.
 *
 * This function performs lexical confinement only. The writer below additionally
 * performs lstat/realpath checks and exclusive no-follow creation.
 */
export function resolveRecoveredReportStagePath(input: {
  workspaceRoot: string;
  requestedPath: string;
  collisionIndex?: number;
}): RecoveredReportStagePath {
  if (
    typeof input.workspaceRoot !== 'string' ||
    input.workspaceRoot.trim().length === 0 ||
    input.workspaceRoot.length > 4096 ||
    input.workspaceRoot.includes('\0') ||
    !path.isAbsolute(input.workspaceRoot)
  ) {
    return stageError('REPORT_STAGE_WORKSPACE_INVALID', 'Recovered report staging requires an absolute workspace.');
  }
  const collisionIndex = input.collisionIndex ?? 0;
  if (
    !Number.isInteger(collisionIndex) ||
    collisionIndex < 0 ||
    collisionIndex >= RECOVERED_REPORT_STAGE_MAX_CANDIDATES
  ) {
    return stageError('REPORT_STAGE_COLLISION_INDEX_INVALID', 'Recovered report collision index is out of range.');
  }

  const requestedName = portableReportBasename(input.requestedPath);
  const stem = defaultReportFileStem(requestedName.replace(/\.[^.]*$/, ''));
  const relativePath = `${stem}${collisionIndex === 0 ? '' : `-${collisionIndex + 1}`}.md`;
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, absolutePath);
  if (
    !relative ||
    relative !== relativePath ||
    path.isAbsolute(relative) ||
    path.dirname(absolutePath) !== workspaceRoot
  ) {
    return stageError('REPORT_STAGE_PATH_ESCAPE', 'Recovered report path escaped the workspace root.');
  }
  return { relativePath, absolutePath };
}

function assertRecoveredReportSeat(input: RecoveredReportStageInput): void {
  const captured = String(input.seatId || '').trim();
  const active = String(input.activeSeatId || '').trim();
  if (!captured || !active || captured !== active || (input.isSeatCurrent && !input.isSeatCurrent())) {
    stageError('REPORT_STAGE_CROSS_SEAT', 'Recovered report staging refused a stale or cross-seat write.');
  }
}

function removeCreatedFileIfSame(candidate: string, created: fs.Stats | undefined): void {
  if (!created) return;
  try {
    const current = fs.lstatSync(candidate);
    if (!current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino)
      fs.unlinkSync(candidate);
  } catch {
    // The file is already absent or no longer ours; never chase or remove a replacement.
  }
}

/**
 * Stage recovered markdown in the authoritative conversation workspace.
 *
 * The destination is always one new direct `.md` child. Existing files are
 * never overwritten; regular-file collisions receive a bounded suffix. A link,
 * special file, traversal, oversized body, seat mismatch, or realpath escape
 * fails closed. Creation uses O_NOFOLLOW | O_CREAT | O_EXCL and mode 0600.
 */
export function stageRecoveredMarkdownInWorkspace(input: RecoveredReportStageInput): RecoveredReportStageResult {
  assertRecoveredReportSeat(input);
  if (typeof input.markdown !== 'string' || input.markdown.trim().length === 0) {
    return stageError('REPORT_STAGE_MARKDOWN_REQUIRED', 'Recovered report staging requires markdown content.');
  }
  const bytes = Buffer.from(input.markdown, 'utf8');
  if (bytes.byteLength > RECOVERED_REPORT_STAGE_MAX_BYTES) {
    return stageError('REPORT_STAGE_MARKDOWN_TOO_LARGE', 'Recovered report markdown exceeds the staging limit.');
  }

  // Validate both untrusted strings before path.resolve/lstat can observe a
  // fallback CWD or an unsafe name. The loop resolves the same candidate again
  // with its collision index after the canonical workspace is known.
  resolveRecoveredReportStagePath({ workspaceRoot: input.workspaceRoot, requestedPath: input.requestedPath });
  const workspaceRoot = path.resolve(input.workspaceRoot);
  let rootStats: fs.Stats;
  let realWorkspaceRoot: string;
  try {
    rootStats = fs.lstatSync(workspaceRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return stageError('REPORT_STAGE_WORKSPACE_LINK', 'Recovered report workspace must be a real directory.');
    }
    realWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch (error) {
    if (error instanceof RecoveredReportStageError) throw error;
    return stageError('REPORT_STAGE_WORKSPACE_UNAVAILABLE', 'Recovered report workspace is unavailable.');
  }

  for (let collisionIndex = 0; collisionIndex < RECOVERED_REPORT_STAGE_MAX_CANDIDATES; collisionIndex += 1) {
    assertRecoveredReportSeat(input);
    const candidate = resolveRecoveredReportStagePath({
      workspaceRoot,
      requestedPath: input.requestedPath,
      collisionIndex,
    });

    // The only parent is the authoritative workspace itself. Resolve it before
    // every attempt so a symlink swap cannot silently redirect a later suffix.
    let realParent: string;
    try {
      realParent = fs.realpathSync.native(path.dirname(candidate.absolutePath));
    } catch {
      return stageError('REPORT_STAGE_WORKSPACE_UNAVAILABLE', 'Recovered report workspace became unavailable.');
    }
    if (realParent !== realWorkspaceRoot) {
      return stageError('REPORT_STAGE_PATH_ESCAPE', 'Recovered report parent escaped the canonical workspace.');
    }

    try {
      const existing = fs.lstatSync(candidate.absolutePath);
      if (existing.isSymbolicLink()) {
        return stageError('REPORT_STAGE_TARGET_LINK', 'Recovered report target is a symbolic link.');
      }
      if (!existing.isFile()) {
        return stageError('REPORT_STAGE_TARGET_INVALID', 'Recovered report target collision is not a regular file.');
      }
      continue;
    } catch (error) {
      if (error instanceof RecoveredReportStageError) throw error;
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
    }

    let fd: number | undefined;
    let createdStats: fs.Stats | undefined;
    try {
      fd = fs.openSync(
        candidate.absolutePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600
      );
      createdStats = fs.fstatSync(fd);
      if (!createdStats.isFile() || createdStats.nlink !== 1) {
        return stageError('REPORT_STAGE_TARGET_INVALID', 'Recovered report target is not a private regular file.');
      }

      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.fchmodSync(fd, 0o600);
      createdStats = fs.fstatSync(fd);
      if ((createdStats.mode & 0o777) !== 0o600 || createdStats.size !== bytes.byteLength) {
        return stageError('REPORT_STAGE_WRITE_VERIFY_FAILED', 'Recovered report write verification failed.');
      }

      const linkedStats = fs.lstatSync(candidate.absolutePath);
      if (
        linkedStats.isSymbolicLink() ||
        !linkedStats.isFile() ||
        linkedStats.nlink !== 1 ||
        linkedStats.dev !== createdStats.dev ||
        linkedStats.ino !== createdStats.ino
      ) {
        return stageError('REPORT_STAGE_TARGET_CHANGED', 'Recovered report target changed during staging.');
      }
      const realCandidate = fs.realpathSync.native(candidate.absolutePath);
      const realRelative = path.relative(realWorkspaceRoot, realCandidate);
      if (
        realRelative !== candidate.relativePath ||
        path.isAbsolute(realRelative) ||
        path.dirname(realCandidate) !== realWorkspaceRoot
      ) {
        return stageError('REPORT_STAGE_PATH_ESCAPE', 'Recovered report target escaped the canonical workspace.');
      }
      assertRecoveredReportSeat(input);
      fs.closeSync(fd);
      fd = undefined;
      return { ...candidate, bytesWritten: bytes.byteLength };
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Cleanup below is inode-bound; a close failure never widens removal.
        }
      }
      removeCreatedFileIfSame(candidate.absolutePath, createdStats);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        try {
          const racedCollision = fs.lstatSync(candidate.absolutePath);
          if (racedCollision.isSymbolicLink()) {
            return stageError('REPORT_STAGE_TARGET_LINK', 'Recovered report target is a symbolic link.');
          }
          if (!racedCollision.isFile()) {
            return stageError(
              'REPORT_STAGE_TARGET_INVALID',
              'Recovered report target collision is not a regular file.'
            );
          }
          continue;
        } catch (collisionError) {
          if (collisionError instanceof RecoveredReportStageError) throw collisionError;
          return stageError('REPORT_STAGE_WRITE_FAILED', 'Recovered report collision verification failed.');
        }
      }
      if (error instanceof RecoveredReportStageError) throw error;
      return stageError('REPORT_STAGE_WRITE_FAILED', 'Recovered report staging failed.');
    }
  }

  return stageError('REPORT_STAGE_COLLISIONS_EXHAUSTED', 'Recovered report collision suffixes are exhausted.');
}
