/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import FilePreview from '@/renderer/components/media/FilePreview';
import UploadProgressBar from '@/renderer/components/media/UploadProgressBar';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useCompositionInput } from '@/renderer/hooks/chat/useCompositionInput';
import { useComposerSpotlight } from '@/renderer/hooks/ui/useComposerSpotlight';
import { Input } from '@arco-design/web-react';
import React, { useRef } from 'react';
import styles from '../index.module.css';

type GuidInputCardProps = {
  // Input state
  input: string;
  onInputChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onPaste: React.ClipboardEventHandler;
  onFocus: () => void;
  onBlur: () => void;
  placeholder: string;

  // Styling
  isFileDragging: boolean;
  dragHandlers: React.HTMLAttributes<HTMLDivElement>;

  // Mention state
  mentionOpen: boolean;
  mentionSelectorBadge: React.ReactNode;
  mentionDropdown: React.ReactNode;

  // Files
  files: string[];
  onRemoveFile: (path: string) => void;

  // Media-lane pill (MAT-1773 P3): the video-creation picker, rendered in the
  // draft band above the input when the draft routes to a media-create intent.
  mediaPill?: React.ReactNode;

  // Action row
  actionRow: React.ReactNode;
};

const GuidInputCard: React.FC<GuidInputCardProps> = ({
  input,
  onInputChange,
  onKeyDown,
  onPaste,
  onFocus,
  onBlur,
  placeholder,
  isFileDragging,
  dragHandlers,
  mentionOpen,
  mentionSelectorBadge,
  mentionDropdown,
  files,
  onRemoveFile,
  mediaPill,
  actionRow,
}) => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const { compositionHandlers, isComposing } = useCompositionInput();
  const composerRef = useRef<HTMLDivElement>(null);
  const composerSpotlightHandlers = useComposerSpotlight(composerRef);
  const textareaAutoSize = isMobile ? { minRows: 2, maxRows: 8 } : { minRows: 2, maxRows: 20 };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing.current) return;
    onKeyDown(e);
  };

  return (
    <div
      ref={composerRef}
      className={`${styles.guidInputCardWrap} guid-input-card-shell eve-panel eve-composer-surface relative flex flex-col ${mentionOpen ? 'overflow-visible' : 'overflow-hidden'} transition-all duration-200 ${isFileDragging ? 'b b-solid border-dashed guid-input-card-shell--dragging eve-composer-surface--dragging' : ''}`}
      style={{
        zIndex: 1,
        transition: 'box-shadow 0.25s ease',
      }}
      {...composerSpotlightHandlers}
      {...dragHandlers}
    >
      <div className={`${styles.guidInputInner} p-12px flex flex-col`}>
        {mentionSelectorBadge}
        {mediaPill}
        <Input.TextArea
          autoSize={textareaAutoSize}
          placeholder={placeholder}
          spellCheck={false}
          className={`text-14px focus:b-none rounded-xl !bg-transparent !b-none !resize-none !py-0 !pr-0 !pl-7px ${styles.lightPlaceholder}`}
          value={input}
          onChange={onInputChange}
          onPaste={onPaste}
          onFocus={onFocus}
          onBlur={onBlur}
          {...compositionHandlers}
          onKeyDown={handleKeyDown}
          data-testid='guid-input'
        />
        <div style={{ height: 12, flexShrink: 0 }} aria-hidden='true' />
        {mentionOpen && (
          <div className='absolute z-50' style={{ left: 16, top: 44 }}>
            {mentionDropdown}
          </div>
        )}
        {files.length > 0 && (
          <div className='flex flex-wrap items-center gap-8px mt-12px mb-12px'>
            {files.map((path) => (
              <FilePreview key={path} path={path} onRemove={() => onRemoveFile(path)} />
            ))}
          </div>
        )}
        <UploadProgressBar source='sendbox' />
        {actionRow}
      </div>
    </div>
  );
};

export default GuidInputCard;
