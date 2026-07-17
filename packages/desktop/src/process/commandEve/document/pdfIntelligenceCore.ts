/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export type ExtractedPdfPage = {
  pageNumber: number;
  text: string;
};

export type PdfTextQuality = {
  extractedCharacters: number;
  pagesWithText: number;
  requiresOcr: boolean;
};

export function normalizeExtractedPdfText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function assessPdfTextQuality(pages: readonly ExtractedPdfPage[]): PdfTextQuality {
  const normalized = pages.map((page) => normalizeExtractedPdfText(page.text));
  const extractedCharacters = normalized.reduce((sum, text) => sum + text.replace(/\s/g, '').length, 0);
  const pagesWithText = normalized.filter((text) => text.replace(/\s/g, '').length >= 16).length;
  const minimumTextPages = Math.max(1, Math.ceil(pages.length * 0.5));
  return {
    extractedCharacters,
    pagesWithText,
    requiresOcr: pages.length === 0 || extractedCharacters < 64 || pagesWithText < minimumTextPages,
  };
}

function safeMarkdownLabel(value: string): string {
  return (
    value
      .replace(/[\r\n]+/g, ' ')
      .replace(/[<>]/g, '')
      .trim()
      .slice(0, 180) || 'document.pdf'
  );
}

export function buildPdfCitationSidecar(input: {
  sourceName: string;
  sha256: string;
  pages: readonly ExtractedPdfPage[];
  extractionMode: 'local_text' | 'cloud_ocr';
}): string {
  const sourceName = safeMarkdownLabel(input.sourceName);
  const sections = input.pages.map((page) => {
    const text = normalizeExtractedPdfText(page.text) || '[No reliable text extracted on this page.]';
    return `## PDF p. ${page.pageNumber}\n\n${text}`;
  });
  return [
    '# Command EVE PDF context',
    '',
    `- Source: ${sourceName}`,
    `- SHA-256: ${input.sha256}`,
    `- Pages: ${input.pages.length}`,
    `- Extraction: ${input.extractionMode}`,
    '- Citation rule: cite claims from this document as `[PDF p. N]` using the page number below.',
    '- Truth rule: distinguish direct document statements from your own inference.',
    '',
    ...sections,
    '',
  ].join('\n');
}

export function parseCloudOcrMarkdownPages(markdown: string, expectedPageCount: number): ExtractedPdfPage[] {
  const normalized = normalizeExtractedPdfText(markdown);
  const headings = Array.from(normalized.matchAll(/^##\s+(?:PDF\s+)?(?:Page|p\.)\s*(\d+)\s*$/gim));
  if (headings.length > 0) {
    const pages = headings
      .map((heading, index) => {
        const bodyStart = (heading.index ?? 0) + heading[0].length;
        const bodyEnd = headings[index + 1]?.index ?? normalized.length;
        return {
          pageNumber: Number(heading[1]),
          text: normalizeExtractedPdfText(normalized.slice(bodyStart, bodyEnd)),
        };
      })
      .filter((page) => Number.isInteger(page.pageNumber) && page.pageNumber > 0)
      .sort((a, b) => a.pageNumber - b.pageNumber);
    if (pages.length > 0) return pages;
  }
  return [{ pageNumber: 1, text: normalized || '[Cloud OCR returned no reliable text.]' }].concat(
    Array.from({ length: Math.max(0, expectedPageCount - 1) }, (_, index) => ({
      pageNumber: index + 2,
      text: '[Page boundary unavailable in cloud OCR response.]',
    }))
  );
}
