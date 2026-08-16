/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The video-creation pill on the START-CHAT surface (MAT-1773 P3 parity:
 * "startchat und chatsession müssen das selbe können").
 *
 * This is NOT a fork: it renders the same VideoQualityPill over the same
 * shared selection hook the conversation composer uses, fed by the same
 * capabilities/catalog answer. Visibility follows the same intent resolver —
 * a video-create intent in the guid draft opens the same model/resolution/
 * duration dropdowns with the same estimate. The selection travels with the
 * first send through the initial-message handoff (see useGuidSend and
 * useAcpInitialMessage), so the new conversation's send carries exactly what
 * was picked here.
 */

import React, { useMemo } from 'react';
import type { VideoModeKind } from '@/common/config/videoCostCore';
import VideoQualityPill from '@/renderer/components/billing/VideoQualityPill';
import type { VideoComposerSelection } from '@/renderer/components/billing/useVideoComposerSelection';
import { isImageFile } from '@/renderer/pages/conversation/Preview/fileUtils';

const GuidVideoPill: React.FC<{
  files: string[];
  selection: VideoComposerSelection;
  visible: boolean;
}> = ({ files, selection, visible }) => {
  // The mode follows the attachments, mirroring the conversation composer:
  // one image -> image-to-video, several -> reference (1.5 only).
  const imageCount = useMemo(() => files.filter((path) => isImageFile(path)).length, [files]);
  const modeKind: VideoModeKind = imageCount === 0 ? 'text' : imageCount === 1 ? 'image' : 'reference';

  return (
    <VideoQualityPill
      visible={visible}
      value={selection.tierId}
      onChange={selection.handleTierChange}
      modelId={selection.modelId}
      onModelChange={selection.handleModelChange}
      resolution={selection.resolution}
      onResolutionChange={selection.handleResolutionChange}
      durationSeconds={selection.durationSeconds}
      onDurationChange={selection.setDurationSeconds}
      modeKind={modeKind}
      capabilities={selection.capabilities}
      catalogEntries={selection.catalog.entries}
      catalogApproximate={selection.catalog.approximate}
    />
  );
};

export default GuidVideoPill;
