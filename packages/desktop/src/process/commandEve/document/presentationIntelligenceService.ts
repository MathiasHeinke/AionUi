/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import path from 'node:path';
import {
  buildPresentationCitationSidecar,
  COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION,
  COMMAND_EVE_PRESENTATION_MAX_BATCH_SLIDES,
  parsePresentationVisionMarkdownSections,
  type CommandEvePreparedPresentationDocument,
  type CommandEvePresentationLocale,
  type CommandEvePresentationSlideContext,
} from '@/common/config/evePresentationIntelligenceCore';
import { writePrivateDocumentAtomic } from './privateDocumentCache';
import {
  assertPresentationSourceUnchanged,
  inspectLocalPresentation,
  isActivePptxPackagePart,
  isSafePptxPackageEntry,
  validatePptxPackage,
} from './presentationPackageInspection';
import { resolveOfficeCliPath, runOfficeCliJson } from './presentationOfficeCli';
import {
  buildPresentationBatchContext,
  normalizePresentationSlideToJpeg,
  renderPresentationSlide,
} from './presentationSlideRendering';
import {
  CommandEvePresentationPreparationError,
  PRESENTATION_CACHE_VERSION,
  PRESENTATION_MAX_SIDECAR_BYTES,
  type LocalPresentationInspection,
  type OfficeCliJsonRunner,
  type PngToJpegConverter,
  type PresentationVisionBatchAnalyzer,
  type PresentationVisionBatchInput,
} from './presentationIntelligenceTypes';

export * from './presentationIntelligenceTypes';
export {
  inspectLocalPresentation,
  isActivePptxPackagePart,
  isSafePptxPackageEntry,
  validatePptxPackage,
  resolveOfficeCliPath,
  runOfficeCliJson,
};

export async function preparePresentationWithVision(input: {
  inspection: LocalPresentationInspection;
  hermesHome: string;
  locale: CommandEvePresentationLocale;
  requestId: string;
  analyzeBatch: PresentationVisionBatchAnalyzer;
  officeCliRunner?: OfficeCliJsonRunner;
  pngToJpegConverter?: PngToJpegConverter;
  assertPersistenceAllowed?: () => void;
}): Promise<CommandEvePreparedPresentationDocument> {
  if (input.inspection.cachedDocument) return input.inspection.cachedDocument;
  await assertPresentationSourceUnchanged(input.inspection);
  const run = input.officeCliRunner ?? runOfficeCliJson;
  const converter = input.pngToJpegConverter ?? normalizePresentationSlideToJpeg;
  const slides: CommandEvePresentationSlideContext[] = [];
  let model = '';

  for (let offset = 0; offset < input.inspection.slideCount; offset += COMMAND_EVE_PRESENTATION_MAX_BATCH_SLIDES) {
    const batchNumbers = Array.from(
      { length: Math.min(COMMAND_EVE_PRESENTATION_MAX_BATCH_SLIDES, input.inspection.slideCount - offset) },
      (_, index) => offset + index + 1
    );
    const rendered: PresentationVisionBatchInput['images'] = [];
    for (const slideNumber of batchNumbers) {
      const bytes = await renderPresentationSlide({
        inspection: input.inspection,
        slideNumber,
        officeCliRunner: run,
        converter,
      });
      rendered.push({
        slideNumber,
        mimeType: 'image/jpeg',
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes,
      });
    }
    const batchTexts = batchNumbers.map(
      (slideNumber) =>
        input.inspection.slideTexts.find((slide) => slide.slideNumber === slideNumber) ?? { slideNumber, text: '' }
    );
    const result = await input.analyzeBatch({
      requestId: `${input.requestId}-${offset / COMMAND_EVE_PRESENTATION_MAX_BATCH_SLIDES + 1}`,
      fileName: input.inspection.sourceName,
      fileSha256: input.inspection.sha256,
      slideCount: input.inspection.slideCount,
      contextText: buildPresentationBatchContext(batchTexts),
      locale: input.locale,
      images: rendered,
    });
    if (
      result.slideNumbers.length !== batchNumbers.length ||
      result.slideNumbers.some((value, index) => value !== batchNumbers[index])
    ) {
      throw new CommandEvePresentationPreparationError(
        'EVE_PRESENTATION_VISION_BAD_BOUNDARIES',
        'Cloud presentation analysis returned the wrong slide receipt.'
      );
    }
    const parsed = parsePresentationVisionMarkdownSections(result.markdown, batchNumbers);
    if (!parsed) {
      throw new CommandEvePresentationPreparationError(
        'EVE_PRESENTATION_VISION_BAD_BOUNDARIES',
        'Cloud presentation analysis did not preserve exact slide boundaries.'
      );
    }
    if (model && model !== result.model) {
      throw new CommandEvePresentationPreparationError(
        'EVE_PRESENTATION_VISION_MODEL_DRIFT',
        'Cloud presentation analysis changed models within one deck.'
      );
    }
    model = result.model;
    for (const section of parsed) {
      slides.push({
        ...section,
        localText: batchTexts.find((slide) => slide.slideNumber === section.slideNumber)?.text || '',
      });
    }
  }

  if (slides.length !== input.inspection.slideCount || slides.some((slide, index) => slide.slideNumber !== index + 1)) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_VISION_INCOMPLETE',
      'Cloud presentation analysis did not cover every slide.'
    );
  }
  const sidecar = buildPresentationCitationSidecar({
    sourceName: input.inspection.sourceName,
    sha256: input.inspection.sha256,
    slideCount: input.inspection.slideCount,
    model,
    slides,
  });
  const sidecarBytes = Buffer.byteLength(sidecar, 'utf8');
  if (sidecarBytes <= 0 || sidecarBytes > PRESENTATION_MAX_SIDECAR_BYTES) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_SIDECAR_TOO_LARGE',
      'Presentation analysis exceeded the private sidecar size limit.'
    );
  }
  const sidecarPath = path.join(input.inspection.cacheDirectory, 'document.md');
  const manifestPath = path.join(input.inspection.cacheDirectory, 'manifest.json');
  input.assertPersistenceAllowed?.();
  writePrivateDocumentAtomic(input.hermesHome, sidecarPath, sidecar);
  writePrivateDocumentAtomic(
    input.hermesHome,
    manifestPath,
    JSON.stringify(
      {
        version: PRESENTATION_CACHE_VERSION,
        intelligenceVersion: COMMAND_EVE_PRESENTATION_INTELLIGENCE_VERSION,
        sha256: input.inspection.sha256,
        slideCount: input.inspection.slideCount,
        model,
        sidecarSha256: crypto.createHash('sha256').update(sidecar, 'utf8').digest('hex'),
        sidecarBytes,
      },
      null,
      2
    ) + '\n'
  );
  return {
    source_path: input.inspection.sourcePath,
    source_name: input.inspection.sourceName,
    sha256: input.inspection.sha256,
    bytes: input.inspection.sourceBytes,
    slide_count: input.inspection.slideCount,
    analyzed_slides: slides.length,
    extraction_mode: 'cloud_vision',
    sidecar_path: sidecarPath,
    prompt_context: sidecar,
    citation_format: '[PPTX slide N]',
    model,
    cache_hit: false,
  };
}
