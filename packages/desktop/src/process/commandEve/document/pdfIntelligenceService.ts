/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  COMMAND_EVE_PDF_MAX_LOCAL_BYTES,
  type CommandEvePreparedPdfDocument,
} from '@/common/config/evePdfIntelligenceCore';
import {
  assessPdfTextQuality,
  buildPdfCitationSidecar,
  normalizeExtractedPdfText,
  parseCloudOcrMarkdownPages,
  type ExtractedPdfPage,
  type PdfTextQuality,
} from './pdfIntelligenceCore';

export class CommandEvePdfPreparationError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string
  ) {
    super(message);
    this.name = 'CommandEvePdfPreparationError';
  }
}

export type LocalPdfPreparation = {
  document: CommandEvePreparedPdfDocument;
  pages: ExtractedPdfPage[];
  quality: PdfTextQuality;
  sourceBytes: Uint8Array;
};

export type PdfTextExtractor = (bytes: Uint8Array) => Promise<ExtractedPdfPage[]>;

export const COMMAND_EVE_PDF_MAX_LOCAL_PAGES = 500;
export const COMMAND_EVE_PDF_LOCAL_EXTRACTION_TIMEOUT_MS = 90_000;

export function assertLocalPdfPageCount(pageCount: number): void {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > COMMAND_EVE_PDF_MAX_LOCAL_PAGES) {
    throw new CommandEvePdfPreparationError(
      'EVE_PDF_LOCAL_EXTRACTION_FAILED',
      `PDF page count must be between 1 and ${COMMAND_EVE_PDF_MAX_LOCAL_PAGES}.`
    );
  }
}

export async function withPdfExtractionDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number,
  now: () => number = Date.now
): Promise<T> {
  const remainingMs = deadlineAt - now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new CommandEvePdfPreparationError(
      'EVE_PDF_LOCAL_EXTRACTION_FAILED',
      'Local PDF extraction exceeded its time limit.'
    );
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new CommandEvePdfPreparationError(
                'EVE_PDF_LOCAL_EXTRACTION_FAILED',
                'Local PDF extraction exceeded its time limit.'
              )
            ),
          remainingMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function ensurePrivateDirectory(rootDirectory: string, directory: string): void {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(directory);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CommandEvePdfPreparationError('EVE_PDF_UNSAFE_CACHE', 'PDF cache escaped the private seat home.');
  }

  let rootStat: fs.Stats | null = null;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    rootStat = null;
  }
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new CommandEvePdfPreparationError('EVE_PDF_UNSAFE_CACHE', 'PDF cache root is not a regular directory.');
  }

  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new CommandEvePdfPreparationError(
        'EVE_PDF_UNSAFE_CACHE',
        'PDF cache path contains a non-directory or symbolic link.'
      );
    }
    fs.chmodSync(current, 0o700);
  }
}

function writePrivateAtomic(rootDirectory: string, filePath: string, contents: string): void {
  ensurePrivateDirectory(rootDirectory, path.dirname(filePath));
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function assertSafePdfSource(filePath: string): fs.Stats {
  if (!path.isAbsolute(filePath)) {
    throw new CommandEvePdfPreparationError('EVE_PDF_PATH_NOT_ABSOLUTE', 'PDF source path must be absolute.');
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CommandEvePdfPreparationError('EVE_PDF_UNSAFE_SOURCE', 'PDF source must be a regular non-symlink file.');
  }
  if (stat.size <= 0 || stat.size > COMMAND_EVE_PDF_MAX_LOCAL_BYTES) {
    throw new CommandEvePdfPreparationError('EVE_PDF_BAD_SIZE', 'PDF source is empty or exceeds the local size limit.');
  }
  if (path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new CommandEvePdfPreparationError('EVE_PDF_BAD_EXTENSION', 'PDF source must use the .pdf extension.');
  }
  return stat;
}

export async function extractPdfPagesWithPdfJs(bytes: Uint8Array): Promise<ExtractedPdfPage[]> {
  const deadlineAt = Date.now() + COMMAND_EVE_PDF_LOCAL_EXTRACTION_TIMEOUT_MS;
  const worker = await withPdfExtractionDeadline(import('pdfjs-dist/legacy/build/pdf.worker.mjs'), deadlineAt);
  const pdfjsGlobal = globalThis as typeof globalThis & {
    pdfjsWorker?: typeof worker;
  };
  pdfjsGlobal.pdfjsWorker ??= worker;
  const pdfjs = await withPdfExtractionDeadline(import('pdfjs-dist/legacy/build/pdf.mjs'), deadlineAt);
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useSystemFonts: true,
  });
  const pages: ExtractedPdfPage[] = [];
  try {
    const document = await withPdfExtractionDeadline(loadingTask.promise, deadlineAt);
    assertLocalPdfPageCount(document.numPages);
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await withPdfExtractionDeadline(document.getPage(pageNumber), deadlineAt);
      try {
        const content = await withPdfExtractionDeadline(page.getTextContent(), deadlineAt);
        const chunks: string[] = [];
        for (const item of content.items) {
          if (!('str' in item) || typeof item.str !== 'string') continue;
          chunks.push(item.str);
          chunks.push('hasEOL' in item && item.hasEOL ? '\n' : ' ');
        }
        pages.push({ pageNumber, text: normalizeExtractedPdfText(chunks.join('')) });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
}

function cacheDirectory(hermesHome: string, sha256: string): string {
  if (!path.isAbsolute(hermesHome)) {
    throw new CommandEvePdfPreparationError('EVE_PDF_BAD_HOME', 'PDF preparation requires an absolute seat home.');
  }
  return path.join(hermesHome, 'document-intelligence', 'pdf', sha256);
}

export async function prepareLocalPdf(input: {
  filePath: string;
  hermesHome: string;
  extractor?: PdfTextExtractor;
  /** Request-scoped Seed/revision fence, evaluated immediately before any
   * post-extraction sidecar or manifest write. */
  isContextCurrent?: () => boolean;
}): Promise<LocalPdfPreparation> {
  const stat = assertSafePdfSource(input.filePath);
  const sourceBytes = new Uint8Array(fs.readFileSync(input.filePath));
  if (new TextDecoder().decode(sourceBytes.slice(0, 5)) !== '%PDF-') {
    throw new CommandEvePdfPreparationError('EVE_PDF_BAD_MAGIC', 'Selected file is not a valid PDF document.');
  }

  const sha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  const directory = cacheDirectory(input.hermesHome, sha256);
  ensurePrivateDirectory(input.hermesHome, directory);
  const sidecarPath = path.join(directory, 'document.md');
  const manifestPath = path.join(directory, 'manifest.json');
  if (fs.existsSync(sidecarPath) && fs.existsSync(manifestPath)) {
    const sidecarStat = fs.lstatSync(sidecarPath);
    const manifestStat = fs.lstatSync(manifestPath);
    if (
      !sidecarStat.isSymbolicLink() &&
      sidecarStat.isFile() &&
      !manifestStat.isSymbolicLink() &&
      manifestStat.isFile()
    ) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          version?: string;
          sha256?: string;
          pageCount?: number;
          extractedCharacters?: number;
          extractionMode?: 'local_text' | 'cloud_ocr';
          requiresOcr?: boolean;
          sidecarSha256?: string;
          sidecarBytes?: number;
        };
        if (
          manifest.version === 'command-eve-pdf-cache/v1' &&
          manifest.sha256 === sha256 &&
          Number.isInteger(manifest.pageCount) &&
          Number(manifest.pageCount) > 0 &&
          Number(manifest.pageCount) <= COMMAND_EVE_PDF_MAX_LOCAL_PAGES &&
          Number.isInteger(manifest.extractedCharacters) &&
          (manifest.extractionMode === 'local_text' || manifest.extractionMode === 'cloud_ocr') &&
          typeof manifest.sidecarSha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(manifest.sidecarSha256) &&
          Number.isInteger(manifest.sidecarBytes) &&
          Number(manifest.sidecarBytes) > 0 &&
          sidecarStat.size === Number(manifest.sidecarBytes)
        ) {
          const sidecar = fs.readFileSync(sidecarPath, 'utf8');
          const sidecarSha256 = crypto.createHash('sha256').update(sidecar, 'utf8').digest('hex');
          if (sidecarSha256 !== manifest.sidecarSha256) throw new Error('PDF sidecar hash mismatch.');
          const headings = Array.from(sidecar.matchAll(/^##\s+PDF\s+p\.\s*(\d+)\s*$/gim)).map((match) =>
            Number(match[1])
          );
          if (
            headings.length !== Number(manifest.pageCount) ||
            headings.some((pageNumber, index) => pageNumber !== index + 1)
          ) {
            throw new Error('PDF sidecar page boundaries are invalid.');
          }
          const pages = parseCloudOcrMarkdownPages(sidecar, Number(manifest.pageCount));
          const quality = assessPdfTextQuality(pages);
          if (quality.extractedCharacters !== Number(manifest.extractedCharacters)) {
            throw new Error('PDF sidecar character receipt mismatch.');
          }
          return {
            sourceBytes,
            pages,
            quality: { ...quality, requiresOcr: manifest.requiresOcr === true },
            document: {
              source_path: input.filePath,
              source_name: path.basename(input.filePath),
              sha256,
              bytes: stat.size,
              page_count: Number(manifest.pageCount),
              extracted_characters: Number(manifest.extractedCharacters),
              extraction_mode: manifest.extractionMode,
              sidecar_path: sidecarPath,
              citation_format: '[PDF p. N]',
              cache_hit: true,
            },
          };
        }
      } catch {
        // A malformed cache is ignored and deterministically rebuilt from source.
      }
    }
  }

  let pages: ExtractedPdfPage[];
  try {
    pages = await (input.extractor ?? extractPdfPagesWithPdfJs)(sourceBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'PDF text extraction failed.';
    const reason = /password|encrypted/i.test(message) ? 'EVE_PDF_ENCRYPTED' : 'EVE_PDF_LOCAL_EXTRACTION_FAILED';
    throw new CommandEvePdfPreparationError(reason, message);
  }
  if (input.isContextCurrent && !input.isContextCurrent()) {
    throw new CommandEvePdfPreparationError(
      'EVE_PDF_SEAT_CHANGED',
      'The active Seed changed while the PDF was being prepared.'
    );
  }
  const quality = assessPdfTextQuality(pages);
  if (!quality.requiresOcr) {
    persistPdfSidecar({
      hermesHome: input.hermesHome,
      sourcePath: input.filePath,
      sha256,
      bytes: stat.size,
      pages,
      extractionMode: 'local_text',
      requiresOcr: false,
    });
  }
  return {
    sourceBytes,
    pages,
    quality,
    document: {
      source_path: input.filePath,
      source_name: path.basename(input.filePath),
      sha256,
      bytes: stat.size,
      page_count: pages.length,
      extracted_characters: quality.extractedCharacters,
      extraction_mode: 'local_text',
      sidecar_path: sidecarPath,
      citation_format: '[PDF p. N]',
      cache_hit: false,
    },
  };
}

export function persistPdfSidecar(input: {
  hermesHome: string;
  sourcePath: string;
  sha256: string;
  bytes: number;
  pages: readonly ExtractedPdfPage[];
  extractionMode: 'local_text' | 'cloud_ocr';
  requiresOcr: boolean;
}): CommandEvePreparedPdfDocument {
  const directory = cacheDirectory(input.hermesHome, input.sha256);
  ensurePrivateDirectory(input.hermesHome, directory);
  const sidecarPath = path.join(directory, 'document.md');
  const manifestPath = path.join(directory, 'manifest.json');
  const quality = assessPdfTextQuality(input.pages);
  const sidecar = buildPdfCitationSidecar({
    sourceName: path.basename(input.sourcePath),
    sha256: input.sha256,
    pages: input.pages,
    extractionMode: input.extractionMode,
  });
  const sidecarSha256 = crypto.createHash('sha256').update(sidecar, 'utf8').digest('hex');
  const sidecarBytes = Buffer.byteLength(sidecar, 'utf8');
  writePrivateAtomic(input.hermesHome, sidecarPath, sidecar);
  writePrivateAtomic(
    input.hermesHome,
    manifestPath,
    `${JSON.stringify(
      {
        version: 'command-eve-pdf-cache/v1',
        sha256: input.sha256,
        sourceName: path.basename(input.sourcePath),
        bytes: input.bytes,
        pageCount: input.pages.length,
        extractedCharacters: quality.extractedCharacters,
        extractionMode: input.extractionMode,
        requiresOcr: input.requiresOcr,
        sidecarSha256,
        sidecarBytes,
      },
      null,
      2
    )}\n`
  );
  return {
    source_path: input.sourcePath,
    source_name: path.basename(input.sourcePath),
    sha256: input.sha256,
    bytes: input.bytes,
    page_count: input.pages.length,
    extracted_characters: quality.extractedCharacters,
    extraction_mode: input.extractionMode,
    sidecar_path: sidecarPath,
    citation_format: '[PDF p. N]',
    cache_hit: false,
  };
}
