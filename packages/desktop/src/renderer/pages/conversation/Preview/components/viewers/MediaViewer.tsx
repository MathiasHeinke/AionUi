/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';

type MediaPreviewProps = {
  type: 'video' | 'audio';
  source?: string;
  title?: string;
};

const MediaPreview: React.FC<MediaPreviewProps> = ({ type, source, title }) => {
  const { t } = useTranslation();

  if (!source) {
    return (
      <div className='flex flex-1 items-center justify-center bg-bg-1 px-24px text-center text-13px text-t-secondary'>
        {t('messages.artifact.previewUnavailable')}
      </div>
    );
  }

  return (
    <section className='flex flex-1 min-h-0 items-center justify-center overflow-hidden bg-bg-1 p-18px'>
      {type === 'video' ? (
        <video
          data-testid='workbench-video-preview'
          src={source}
          title={title}
          controls
          playsInline
          preload='metadata'
          className='block max-h-full max-w-full rd-10px bg-black object-contain shadow-sm'
        />
      ) : (
        <div className='flex w-full max-w-620px flex-col gap-12px px-12px'>
          {title ? <span className='truncate text-12px font-500 text-t-secondary'>{title}</span> : null}
          <audio
            data-testid='workbench-audio-preview'
            src={source}
            title={title}
            controls
            preload='metadata'
            className='h-42px w-full'
          />
        </div>
      )}
    </section>
  );
};

export default MediaPreview;
