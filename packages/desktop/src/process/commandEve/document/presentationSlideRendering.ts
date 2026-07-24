/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  COMMAND_EVE_PRESENTATION_MAX_CONTEXT_CHARS,
  COMMAND_EVE_PRESENTATION_MAX_IMAGE_BYTES,
} from '@/common/config/evePresentationIntelligenceCore';
import {
  CommandEvePresentationPreparationError,
  type LocalPresentationInspection,
  type OfficeCliJsonRunner,
  type PngToJpegConverter,
  type PresentationSlideText,
} from './presentationIntelligenceTypes';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function normalizePresentationSlideToJpeg(pngBytes: Uint8Array): Promise<Uint8Array> {
  const { nativeImage } = await import('electron');
  const image = nativeImage.createFromBuffer(Buffer.from(pngBytes));
  if (image.isEmpty()) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_LOCAL_RENDER_FAILED',
      'Rendered presentation slide was not a valid image.'
    );
  }
  const size = image.getSize();
  if (size.width < 320 || size.height < 180 || size.width > 4096 || size.height > 4096) {
    throw new CommandEvePresentationPreparationError(
      'EVE_PRESENTATION_LOCAL_RENDER_FAILED',
      'Rendered presentation slide dimensions were outside the safety bounds.'
    );
  }
  for (const quality of [82, 72, 60]) {
    const jpeg = image.toJPEG(quality);
    if (jpeg.byteLength >= 4 && jpeg.byteLength <= COMMAND_EVE_PRESENTATION_MAX_IMAGE_BYTES) {
      return new Uint8Array(jpeg);
    }
  }
  throw new CommandEvePresentationPreparationError(
    'EVE_PRESENTATION_LOCAL_RENDER_FAILED',
    'Rendered presentation slide could not be compressed safely.'
  );
}

export async function renderPresentationSlide(input: {
  inspection: LocalPresentationInspection;
  slideNumber: number;
  officeCliRunner: OfficeCliJsonRunner;
  converter: PngToJpegConverter;
}): Promise<Uint8Array> {
  const temporaryPngPath = path.join(
    input.inspection.cacheDirectory,
    `.slide-${input.slideNumber}.${process.pid}.${Date.now()}.png`
  );
  try {
    const receipt = await input.officeCliRunner([
      'view',
      input.inspection.sourcePath,
      'screenshot',
      '--page',
      String(input.slideNumber),
      '--render',
      'html',
      '--screenshot-width',
      '1280',
      '--screenshot-height',
      '720',
      '--out',
      temporaryPngPath,
      '--json',
    ]);
    if (!isRecord(receipt) || receipt.success !== true || receipt.data !== temporaryPngPath) {
      throw new CommandEvePresentationPreparationError(
        'EVE_PRESENTATION_LOCAL_RENDER_FAILED',
        `Slide ${input.slideNumber} did not produce a trustworthy render receipt.`
      );
    }
    const stat = fs.lstatSync(temporaryPngPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 8 || stat.size > 16 * 1024 * 1024) {
      throw new CommandEvePresentationPreparationError(
        'EVE_PRESENTATION_LOCAL_RENDER_FAILED',
        `Slide ${input.slideNumber} render was outside the local size bounds.`
      );
    }
    fs.chmodSync(temporaryPngPath, 0o600);
    const png = new Uint8Array(fs.readFileSync(temporaryPngPath));
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (!signature.every((byte, index) => png[index] === byte)) {
      throw new CommandEvePresentationPreparationError(
        'EVE_PRESENTATION_LOCAL_RENDER_FAILED',
        `Slide ${input.slideNumber} render was not a PNG image.`
      );
    }
    const jpeg = await input.converter(png);
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) {
      throw new CommandEvePresentationPreparationError(
        'EVE_PRESENTATION_LOCAL_RENDER_FAILED',
        `Slide ${input.slideNumber} render was not a valid JPEG image.`
      );
    }
    return jpeg;
  } finally {
    try {
      const stat = fs.lstatSync(temporaryPngPath);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(temporaryPngPath);
    } catch {
      // Best-effort removal of a private transient slide render.
    }
  }
}

export function buildPresentationBatchContext(slideTexts: readonly PresentationSlideText[]): string {
  let context = '';
  for (const slide of slideTexts) {
    const section = `Slide ${slide.slideNumber}:\n${slide.text || '[No text extracted locally.]'}\n\n`;
    if (context.length + section.length > COMMAND_EVE_PRESENTATION_MAX_CONTEXT_CHARS) {
      const remaining = COMMAND_EVE_PRESENTATION_MAX_CONTEXT_CHARS - context.length;
      if (remaining > 0) context += section.slice(0, remaining);
      break;
    }
    context += section;
  }
  return context.trim();
}
