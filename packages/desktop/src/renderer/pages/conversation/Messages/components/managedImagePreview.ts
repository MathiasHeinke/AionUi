/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IGeneratedConversationArtifact } from '@/common/adapter/ipcBridge';
import type { PreviewContextValue } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

export function openManagedImagePreview(
  preview: Pick<PreviewContextValue, 'openPreview'>,
  source: string,
  artifact: IGeneratedConversationArtifact,
  title: string,
  fileName: string
): void {
  preview.openPreview(source, 'image', {
    title,
    file_name: fileName,
    conversation_id: artifact.conversation_id,
    artifact_id: artifact.id,
    artifact_kind: 'file',
    artifact_created_at: artifact.created_at,
    editable: false,
  });
}
