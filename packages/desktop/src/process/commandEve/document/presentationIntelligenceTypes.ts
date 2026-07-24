/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandEvePreparedPresentationDocument,
  CommandEvePresentationLocale,
} from '@/common/config/evePresentationIntelligenceCore';

export const PRESENTATION_CACHE_VERSION = 'command-eve-presentation-cache/v1' as const;
export const PRESENTATION_MAX_SIDECAR_BYTES = 8 * 1024 * 1024;

export class CommandEvePresentationPreparationError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string
  ) {
    super(message);
    this.name = 'CommandEvePresentationPreparationError';
  }
}

export type PresentationSlideText = {
  slideNumber: number;
  text: string;
};

export type LocalPresentationInspection = {
  sourcePath: string;
  sourceName: string;
  sourceBytes: number;
  sha256: string;
  slideCount: number;
  slideTexts: PresentationSlideText[];
  cacheDirectory: string;
  cachedDocument?: CommandEvePreparedPresentationDocument;
};

export type PresentationVisionBatchInput = {
  requestId: string;
  fileName: string;
  fileSha256: string;
  slideCount: number;
  contextText: string;
  locale: CommandEvePresentationLocale;
  images: Array<{
    slideNumber: number;
    mimeType: 'image/jpeg';
    sha256: string;
    bytes: Uint8Array;
  }>;
};

export type PresentationVisionBatchOutput = {
  markdown: string;
  model: string;
  slideNumbers: number[];
};

export type PresentationVisionBatchAnalyzer = (
  input: PresentationVisionBatchInput
) => Promise<PresentationVisionBatchOutput>;

export type OfficeCliJsonRunner = (args: readonly string[]) => Promise<unknown>;
export type PngToJpegConverter = (pngBytes: Uint8Array) => Promise<Uint8Array>;
