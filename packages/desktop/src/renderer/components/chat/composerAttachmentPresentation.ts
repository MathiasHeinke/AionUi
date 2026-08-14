/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ComposerWorkProductMode } from '@/common/config/composerWorkProductModeCore';
import { isImageFile } from '@/renderer/pages/conversation/Preview/fileUtils';

export type ComposerAttachmentPresentation = Readonly<{
  referenceImagePath?: string;
  visibleFiles: string[];
}>;

/** Keeps attachment placement byte-identical between the start and in-session composers. */
export function resolveComposerAttachmentPresentation(
  mode: ComposerWorkProductMode,
  files: readonly string[],
  hasArtifactReference = false
): ComposerAttachmentPresentation {
  if (mode !== 'image' || hasArtifactReference) return { visibleFiles: [...files] };
  const referenceImagePath = files.find((path) => isImageFile(path));
  if (!referenceImagePath) return { visibleFiles: [...files] };
  return {
    referenceImagePath,
    visibleFiles: files.filter((path) => path !== referenceImagePath),
  };
}
