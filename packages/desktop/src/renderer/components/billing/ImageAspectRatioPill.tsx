/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS,
  type CommandEveManagedImageAspectRatio,
} from '@/common/config/eveManagedImageGenerationCore';
import { CheckSmall } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MediaPillDropdown } from './MediaModelDropdown';
import './billing.css';

export type ImageAspectRatioPillProps = Readonly<{
  value: CommandEveManagedImageAspectRatio;
  onChange: (aspectRatio: CommandEveManagedImageAspectRatio) => void;
  visible: boolean;
}>;

/** Exact managed-image format selector shared by start and active composers. */
const ImageAspectRatioPill: React.FC<ImageAspectRatioPillProps> = ({ value, onChange, visible }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!visible) return null;

  const label = t('conversation.workProduct.image.aspectRatio', { defaultValue: 'Bildformat' });

  return (
    <div className='image-model-pill__group' data-testid='image-aspect-ratio-group'>
      <MediaPillDropdown
        open={open}
        onToggle={() => setOpen((current) => !current)}
        onClose={() => setOpen(false)}
        ariaLabel={label}
        triggerTestId='image-aspect-ratio-dropdown-trigger'
        listTestId='image-aspect-ratio-dropdown'
        triggerContent={value}
        triggerActive={value !== '16:9'}
        estimatedRows={COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS.length}
      >
        {COMMAND_EVE_MANAGED_IMAGE_ASPECT_RATIOS.map((option) => {
          const selected = option === value;
          return (
            <button
              key={option}
              type='button'
              role='option'
              aria-selected={selected}
              data-eve-composite-owner='listbox'
              className={`video-quality-pill__model-entry${selected ? ' is-selected' : ''}`}
              data-testid={`image-aspect-ratio-option-${option.replace(':', '-')}`}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              <span className='video-quality-pill__model-name'>{option}</span>
              {selected ? <CheckSmall theme='outline' size={13} className='video-quality-pill__check' /> : null}
            </button>
          );
        })}
      </MediaPillDropdown>
    </div>
  );
};

export default ImageAspectRatioPill;
