/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import React, { useEffect, useState } from 'react';

type ComposerReferencePreviewProps =
  | Readonly<{ path: string; conversationId?: undefined; artifactId?: undefined; alt: string }>
  | Readonly<{ path?: undefined; conversationId: string; artifactId: string; alt: string }>;

const MAX_PREVIEW_SOURCE_CHARS = 64 * 1024 * 1024;

function safeImageDataUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_PREVIEW_SOURCE_CHARS) return null;
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value) ? value : null;
}

/** Loads a granted local image or a Main-owned managed artifact for the tiny composer thumbnail. */
const ComposerReferencePreview: React.FC<ComposerReferencePreviewProps> = (props) => {
  const [source, setSource] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSource(null);
    void (async () => {
      try {
        const candidate = props.path
          ? await ipcBridge.fs.getImageBase64.invoke({ path: props.path })
          : await ipcBridge.commandEve.imageArtifactPreview
              .invoke({ conversationId: props.conversationId, artifactId: props.artifactId })
              .then((response) => {
                const preview = response?.data;
                return preview ? `data:${preview.mime_type};base64,${preview.data_base64}` : null;
              });
        if (active) setSource(safeImageDataUrl(candidate));
      } catch {
        if (active) setSource(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [props.artifactId, props.conversationId, props.path]);

  return source ? <img src={source} alt={props.alt} draggable={false} /> : <span aria-hidden='true' />;
};

export default ComposerReferencePreview;
