/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import LocalImageView from '@renderer/components/media/LocalImageView';
import React, { useState } from 'react';

const isLocalFilePath = (src: string): boolean =>
  !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:');

const decodeLocalFilePath = (src: string): string => {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
};

const MarkdownImage: React.FC<React.ImgHTMLAttributes<HTMLImageElement>> = ({ src = '', alt = '', ...props }) => {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return alt ? (
      <span role='img' aria-label={alt} data-testid='markdown-image-fallback'>
        {alt}
      </span>
    ) : null;
  }
  if (isLocalFilePath(src)) {
    return <LocalImageView src={decodeLocalFilePath(src)} alt={alt} className={props.className} />;
  }
  return <img {...props} src={src} alt={alt} onError={() => setFailed(true)} />;
};

export default MarkdownImage;
