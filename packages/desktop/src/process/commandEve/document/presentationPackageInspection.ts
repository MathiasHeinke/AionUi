/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import {
  COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION,
  COMMAND_EVE_PRESENTATION_MAX_LOCAL_BYTES,
  COMMAND_EVE_PRESENTATION_MAX_SLIDES,
  type CommandEvePreparedPresentationDocument,
} from '@/common/config/evePresentationIntelligenceCore';
import { ensurePrivateDocumentDirectory } from './privateDocumentCache';
import {
  CommandEvePresentationPreparationError,
  PRESENTATION_CACHE_VERSION,
  PRESENTATION_MAX_SIDECAR_BYTES,
  type LocalPresentationInspection,
  type OfficeCliJsonRunner,
  type PresentationSlideText,
} from './presentationIntelligenceTypes';
import { runOfficeCliJson } from './presentationOfficeCli';

const PRESENTATION_MAX_ZIP_ENTRIES = 5_000;
const PRESENTATION_MAX_UNCOMPRESSED_BYTES = 250 * 1024 * 1024;

export function isSafePptxPackageEntry(rawName: string): boolean {
  if (!rawName || rawName.includes('\\') || /\p{Cc}/u.test(rawName)) return false;
  if (rawName.startsWith('/') || rawName.includes('//') || /^[A-Za-z]:/.test(rawName)) return false;
  const segments = rawName.split('/');
  if (rawName.endsWith('/')) segments.pop();
  return segments.length > 0 && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function isActivePptxPackagePart(name: string): boolean {
  return /^(?:ppt\/(?:activeX|embeddings|externalLinks)\/|ppt\/vbaProject\.bin$)/i.test(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function assertSafePresentationSource(filePath: string): fs.Stats {
  if (!path.isAbsolute(filePath)) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_PATH_NOT_ABSOLUTE',
      'Presentation source path must be absolute.'
    );
  }
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_UNSAFE_SOURCE',
      'Presentation source must be a regular non-symlink file.'
    );
  }
  if (stat.size <= 0 || stat.size > COMMAND_EVE_PRESENTATION_MAX_LOCAL_BYTES) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_BAD_SIZE',
      'Presentation source is empty or exceeds the local size limit.'
    );
  }
  if (path.extname(filePath).toLowerCase() !== '.pptx') {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_BAD_EXTENSION',
      'Presentation source must use the .pptx extension.'
    );
  }
  const magic = Buffer.alloc(4);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.readSync(descriptor, magic, 0, magic.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (magic[0] !== 0x50 || magic[1] !== 0x4b) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_BAD_MAGIC',
      'Selected file is not a valid OOXML presentation.'
    );
  }
  return stat;
}

async function hashPresentationFile(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function assertPresentationSourceUnchanged(inspection: LocalPresentationInspection): Promise<void> {
  const stat = assertSafePresentationSource(inspection.sourcePath);
  const sha256 = await hashPresentationFile(inspection.sourcePath);
  if (stat.size !== inspection.sourceBytes || sha256 !== inspection.sha256) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_SOURCE_CHANGED',
      'Presentation changed after local inspection; select it again before sending.'
    );
  }
}

export function validatePptxPackage(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true },
      (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(
            new CommandEvePresentationPreparationError(
              'EVE_PRESENTATION_BAD_PACKAGE',
              'Presentation package could not be opened safely.'
            )
          );
          return;
        }
        let entries = 0;
        let uncompressedBytes = 0;
        let hasContentTypes = false;
        let hasPresentation = false;
        let settled = false;
        const slides = new Set<number>();
        const entryNames = new Set<string>();
        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          zipFile.close();
          reject(new CommandEvePresentationPreparationError('EVE_PRESENTATION_BAD_PACKAGE', message));
        };

        zipFile.on('error', () => fail('Presentation package failed structural validation.'));
        zipFile.on('entry', (entry) => {
          entries += 1;
          uncompressedBytes += entry.uncompressedSize;
          const name = entry.fileName;
          if (
            entries > PRESENTATION_MAX_ZIP_ENTRIES ||
            uncompressedBytes > PRESENTATION_MAX_UNCOMPRESSED_BYTES ||
            !isSafePptxPackageEntry(name) ||
            entryNames.has(name) ||
            isActivePptxPackagePart(name) ||
            (entry.generalPurposeBitFlag & 0x1) !== 0
          ) {
            fail('Presentation package exceeded its structural safety bounds.');
            return;
          }
          entryNames.add(name);
          if (name === '[Content_Types].xml') hasContentTypes = true;
          if (name === 'ppt/presentation.xml') hasPresentation = true;
          const slideMatch = name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
          if (slideMatch) slides.add(Number(slideMatch[1]));
          zipFile.readEntry();
        });
        zipFile.on('end', () => {
          if (settled) return;
          if (
            !hasContentTypes ||
            !hasPresentation ||
            slides.size < 1 ||
            slides.size > COMMAND_EVE_PRESENTATION_MAX_SLIDES
          ) {
            settled = true;
            reject(
              new CommandEvePresentationPreparationError(
                'EVE_PRESENTATION_BAD_PACKAGE',
                'Presentation package is missing required OOXML parts or exceeds the slide limit.'
              )
            );
            return;
          }
          const sorted = Array.from(slides).sort((left, right) => left - right);
          if (sorted.some((slideNumber, index) => slideNumber !== index + 1)) {
            settled = true;
            reject(
              new CommandEvePresentationPreparationError(
                'EVE_PRESENTATION_BAD_PACKAGE',
                'Presentation slide parts are not sequential.'
              )
            );
            return;
          }
          settled = true;
          resolve(slides.size);
        });
        zipFile.readEntry();
      }
    );
  });
}

function parseOfficeCliInspection(
  statsRaw: unknown,
  textRaw: unknown,
  packageSlideCount: number
): PresentationSlideText[] {
  if (!isRecord(statsRaw) || statsRaw.success !== true || !isRecord(statsRaw.data)) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_LOCAL_EXTRACTION_FAILED',
      'Presentation statistics were unavailable.'
    );
  }
  if (!Number.isInteger(statsRaw.data.slides) || Number(statsRaw.data.slides) !== packageSlideCount) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_SLIDE_COUNT_MISMATCH',
      'Presentation structure and rendered slide count did not agree.'
    );
  }
  if (
    !isRecord(textRaw) ||
    textRaw.success !== true ||
    !isRecord(textRaw.data) ||
    !Array.isArray(textRaw.data.slides)
  ) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_LOCAL_EXTRACTION_FAILED',
      'Presentation text could not be extracted locally.'
    );
  }
  const bySlide = new Map<number, string>();
  for (const slide of textRaw.data.slides) {
    if (!isRecord(slide) || !Number.isInteger(slide.index) || Number(slide.index) < 1) continue;
    const texts = Array.isArray(slide.texts) ? slide.texts.map(normalizeText).filter(Boolean) : [];
    bySlide.set(Number(slide.index), texts.join('\n'));
  }
  return Array.from({ length: packageSlideCount }, (_, index) => ({
    slideNumber: index + 1,
    text: bySlide.get(index + 1) || '',
  }));
}

function readCachedPresentation(input: {
  sourcePath: string;
  sourceName: string;
  sourceBytes: number;
  sha256: string;
  slideCount: number;
  cacheDirectory: string;
}): CommandEvePreparedPresentationDocument | undefined {
  const sidecarPath = path.join(input.cacheDirectory, 'document.md');
  const manifestPath = path.join(input.cacheDirectory, 'manifest.json');
  try {
    const sidecarStat = fs.lstatSync(sidecarPath);
    const manifestStat = fs.lstatSync(manifestPath);
    if (
      sidecarStat.isSymbolicLink() ||
      !sidecarStat.isFile() ||
      manifestStat.isSymbolicLink() ||
      !manifestStat.isFile() ||
      (sidecarStat.mode & 0o077) !== 0 ||
      (manifestStat.mode & 0o077) !== 0 ||
      sidecarStat.size <= 0 ||
      sidecarStat.size > PRESENTATION_MAX_SIDECAR_BYTES
    )
      return undefined;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    if (
      manifest.version !== PRESENTATION_CACHE_VERSION ||
      manifest.intelligenceVersion !== COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION ||
      manifest.sha256 !== input.sha256 ||
      manifest.slideCount !== input.slideCount ||
      typeof manifest.model !== 'string' ||
      typeof manifest.sidecarSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(manifest.sidecarSha256) ||
      manifest.sidecarBytes !== sidecarStat.size
    )
      return undefined;
    const sidecar = fs.readFileSync(sidecarPath, 'utf8');
    if (crypto.createHash('sha256').update(sidecar, 'utf8').digest('hex') !== manifest.sidecarSha256) return undefined;
    const headings = Array.from(sidecar.matchAll(/^##\s+PPTX\s+slide\s+(\d+)\s*$/gim)).map((match) => Number(match[1]));
    if (headings.length !== input.slideCount || headings.some((slideNumber, index) => slideNumber !== index + 1)) {
      return undefined;
    }
    return {
      source_path: input.sourcePath,
      source_name: input.sourceName,
      sha256: input.sha256,
      bytes: input.sourceBytes,
      slide_count: input.slideCount,
      analyzed_slides: input.slideCount,
      extraction_mode: 'cloud_vision',
      sidecar_path: sidecarPath,
      prompt_context: sidecar,
      citation_format: '[PPTX slide N]',
      model: String(manifest.model),
      cache_hit: true,
    };
  } catch {
    return undefined;
  }
}

export async function inspectLocalPresentation(input: {
  filePath: string;
  hermesHome: string;
  officeCliRunner?: OfficeCliJsonRunner;
}): Promise<LocalPresentationInspection> {
  const stat = assertSafePresentationSource(input.filePath);
  const packageSlideCount = await validatePptxPackage(input.filePath);
  const sha256 = await hashPresentationFile(input.filePath);
  const cacheDirectory = path.join(input.hermesHome, 'document-intelligence', 'presentation', sha256);
  ensurePrivateDocumentDirectory(input.hermesHome, cacheDirectory);
  const sourceName = path.basename(input.filePath);
  const cachedDocument = readCachedPresentation({
    sourcePath: input.filePath,
    sourceName,
    sourceBytes: stat.size,
    sha256,
    slideCount: packageSlideCount,
    cacheDirectory,
  });
  if (cachedDocument) {
    return {
      sourcePath: input.filePath,
      sourceName,
      sourceBytes: stat.size,
      sha256,
      slideCount: packageSlideCount,
      slideTexts: [],
      cacheDirectory,
      cachedDocument,
    };
  }

  const run = input.officeCliRunner ?? runOfficeCliJson;
  const [statsRaw, textRaw] = await Promise.all([
    run(['view', input.filePath, 'stats', '--json']),
    run(['view', input.filePath, 'text', '--max-lines', String(COMMAND_EVE_PRESENTATION_MAX_SLIDES), '--json']),
  ]);
  return {
    sourcePath: input.filePath,
    sourceName,
    sourceBytes: stat.size,
    sha256,
    slideCount: packageSlideCount,
    slideTexts: parseOfficeCliInspection(statsRaw, textRaw, packageSlideCount),
    cacheDirectory,
  };
}
