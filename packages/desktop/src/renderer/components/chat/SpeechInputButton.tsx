/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { Message, Button, Tooltip } from '@arco-design/web-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  useSpeechInput,
  type SpeechInputAvailability,
  type SpeechInputErrorCode,
} from '@/renderer/hooks/system/useSpeechInput';

type SpeechInputButtonProps = {
  disabled?: boolean;
  locale?: string;
  onTranscript: (transcript: string) => void;
};

const SpeechMicIcon = () => (
  <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' aria-hidden='true'>
    <path d='M12 3a3 3 0 0 1 3 3v6a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Z' />
    <path d='M19 10v2a7 7 0 0 1-14 0v-2' />
    <path d='M12 19v3' />
  </svg>
);

const SpeechStopIcon = () => (
  <svg width='18' height='18' viewBox='0 0 24 24' fill='currentColor' aria-hidden='true'>
    <rect x='6' y='6' width='12' height='12' rx='2.5' />
  </svg>
);

const SpeechLoaderIcon = () => <span className='speech-loader-spinner' aria-hidden='true' />;

const SpeechRetryIcon = () => (
  <svg width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' aria-hidden='true'>
    <path d='M21 12a9 9 0 1 1-3-6.7L21 8' />
    <path d='M21 3v5h-5' />
  </svg>
);

const SPEECH_TO_TEXT_CONFIG_CHANGED_EVENT = 'aionui:speech-to-text-config-changed';

/**
 * S9 #4 store-split fix — the mic CONSUMER-DEFAULT. The first-run seed used to
 * write `{enabled:true}` to the main-process ProcessConfig store, but this
 * consumer reads the BACKEND store (configService), so the seed was never visible
 * here and the mic button stayed hidden on a virgin install ("audio geht nicht").
 * The product is German + local-first, so an ABSENT config (undefined / no
 * `enabled` field) now means the seed intention "default ON". Only an EXPLICIT
 * `enabled === false` (a real user opt-out persisted to the backend) hides the
 * button. This pure predicate is the single source of that default (the dead JSON
 * seed was deleted from initStorage).
 */
export function resolveSpeechInputEnabledDefault(config: { enabled?: boolean } | null | undefined): boolean {
  return config?.enabled !== false;
}

const getAvailabilityMessageKey = (availability: SpeechInputAvailability) => {
  switch (availability) {
    case 'file':
      return 'conversation.chat.speech.pickFileTooltip';
    case 'unsupported':
      return 'conversation.chat.speech.unsupported';
    default:
      return 'conversation.chat.speech.recordTooltip';
  }
};

const getErrorMessageKey = (errorCode: SpeechInputErrorCode) => {
  switch (errorCode) {
    case 'audio-capture':
      return 'conversation.chat.speech.audioCaptureError';
    case 'empty-transcript':
      return 'conversation.chat.speech.emptyTranscript';
    case 'file-too-large':
      return 'conversation.chat.speech.fileTooLarge';
    case 'network':
      return 'conversation.chat.speech.networkError';
    case 'not-configured':
      return 'conversation.chat.speech.notConfigured';
    case 'permission-denied':
      return 'conversation.chat.speech.permissionDenied';
    case 'recording-unsupported':
      return 'conversation.chat.speech.recordingUnsupported';
    case 'transcription-failed':
      return 'conversation.chat.speech.transcriptionFailed';
    case 'aborted':
    case 'unknown':
    default:
      return 'conversation.chat.speech.genericError';
  }
};

const formatSpeechDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const getTooltipKey = (availability: SpeechInputAvailability, isListening: boolean, isProcessing: boolean) => {
  if (isProcessing) {
    return 'conversation.chat.speech.processing';
  }
  if (isListening) {
    return 'conversation.chat.speech.stopTooltip';
  }
  if (availability === 'record') {
    return 'conversation.chat.speech.recordTooltip';
  }
  return getAvailabilityMessageKey(availability);
};

const SpeechInputButton: React.FC<SpeechInputButtonProps> = ({ disabled, locale, onTranscript }) => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isSpeechToTextEnabled, setIsSpeechToTextEnabled] = useState(false);
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);
  const {
    availability,
    canRetry,
    clearError,
    errorCode,
    errorMessage,
    recordingDurationMs,
    recordingLevels,
    retryTranscription,
    startRecording,
    status,
    stopRecording,
    transcribeFile,
  } = useSpeechInput({
    locale,
    onTranscript,
  });

  const isRecording = status === 'recording';
  const isProcessing = status === 'transcribing';
  const showSpeechFeedback = isRecording || isProcessing;
  const displayedWaveformLevels = useMemo(() => {
    if (recordingLevels.length > 0) {
      return recordingLevels;
    }
    return [0.08, 0.12, 0.1, 0.16, 0.09, 0.14];
  }, [recordingLevels]);

  useEffect(() => {
    let cancelled = false;

    const syncSpeechToTextEnabled = async () => {
      try {
        const config = configService.get('tools.speechToText');
        if (cancelled) {
          return;
        }
        // S9 #4 store-split fix — CONSUMER-DEFAULT flip. See
        // resolveSpeechInputEnabledDefault: absent config ⇒ ON (the seed
        // intention); explicit `enabled:false` ⇒ hidden.
        setIsSpeechToTextEnabled(resolveSpeechInputEnabledDefault(config));
      } catch {
        if (cancelled) {
          return;
        }
        setIsSpeechToTextEnabled(false);
      } finally {
        if (!cancelled) {
          setIsConfigLoaded(true);
        }
      }
    };

    const handleConfigChanged = () => {
      void syncSpeechToTextEnabled();
    };

    void syncSpeechToTextEnabled();
    window.addEventListener(SPEECH_TO_TEXT_CONFIG_CHANGED_EVENT, handleConfigChanged);

    return () => {
      cancelled = true;
      window.removeEventListener(SPEECH_TO_TEXT_CONFIG_CHANGED_EVENT, handleConfigChanged);
    };
  }, []);

  useEffect(() => {
    if (!errorCode) {
      return;
    }

    const baseMessage = t(getErrorMessageKey(errorCode));
    const detail = errorMessage?.trim();
    if (errorCode === 'empty-transcript') {
      Message.warning(baseMessage);
      clearError();
      return;
    }
    Message.error(detail ? `${baseMessage}: ${detail}` : baseMessage);
    // When the audio is still intact (canRetry), DON'T clearError — keep the
    // error state so the inline Retry button stays visible and the preserved
    // recording isn't dropped. Otherwise reset immediately as before.
    if (!canRetry) {
      clearError();
    }
  }, [canRetry, clearError, errorCode, errorMessage, t]);

  const handleRetry = () => {
    if (disabled) return;
    retryTranscription();
  };

  const handleClick = () => {
    if (disabled) {
      return;
    }

    if (availability === 'unsupported') {
      Message.warning(t(getAvailabilityMessageKey(availability)));
      return;
    }

    if (isRecording) {
      stopRecording();
      return;
    }

    if (availability === 'file') {
      fileInputRef.current?.click();
      return;
    }

    void startRecording();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    void transcribeFile(file);
  };

  if (!isConfigLoaded || !isSpeechToTextEnabled) {
    return null;
  }

  const tooltipKey = getTooltipKey(availability, isRecording, isProcessing);
  const ariaLabel = t(tooltipKey);
  const icon = isRecording ? <SpeechStopIcon /> : isProcessing ? <SpeechLoaderIcon /> : <SpeechMicIcon />;

  return (
    <>
      <input
        ref={fileInputRef}
        type='file'
        accept='audio/*'
        capture='user'
        className='hidden'
        onChange={handleFileChange}
      />
      <div className={`speech-input-control ${showSpeechFeedback ? 'speech-input-control--active' : ''}`}>
        {showSpeechFeedback && (
          <div
            className={`speech-input-feedback ${isProcessing ? 'speech-input-feedback--processing' : ''}`}
            role='status'
            aria-live='polite'
          >
            <div className='speech-input-feedback__waveform' aria-hidden='true'>
              {displayedWaveformLevels.map((level, index) => (
                <span
                  key={`speech-wave-${index}`}
                  className='speech-input-feedback__bar'
                  style={{
                    height: `${Math.max(1.5, 1 + level * 18)}px`,
                    animationDelay: `${index * 40}ms`,
                  }}
                />
              ))}
            </div>
            <span className='speech-input-feedback__label'>
              {isProcessing
                ? t('conversation.chat.speech.transcribingShort')
                : formatSpeechDuration(recordingDurationMs)}
            </span>
          </div>
        )}
        {canRetry && !showSpeechFeedback && (
          <Tooltip content={t('conversation.chat.speech.retryTooltip')} mini>
            <Button
              type='text'
              size='small'
              shape='circle'
              className='speech-input-button speech-input-button--retry'
              disabled={disabled}
              onClick={handleRetry}
              aria-label={t('conversation.chat.speech.retryTooltip')}
              icon={<SpeechRetryIcon />}
            />
          </Tooltip>
        )}
        <Tooltip content={ariaLabel} mini>
          <Button
            type='text'
            size='small'
            shape='circle'
            className={`speech-input-button ${isRecording ? 'speech-input-button--listening' : ''} ${isProcessing ? 'speech-input-button--processing' : ''}`}
            disabled={disabled || isProcessing}
            onClick={handleClick}
            aria-label={ariaLabel}
            icon={icon}
          />
        </Tooltip>
      </div>
    </>
  );
};

export default SpeechInputButton;
