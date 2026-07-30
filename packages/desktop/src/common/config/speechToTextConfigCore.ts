/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SpeechToTextConfig } from '@/common/types/provider/speech';

export const DEFAULT_LOCAL_SPEECH_TO_TEXT_MODEL = 'small';

export const DEFAULT_SPEECH_TO_TEXT_CONFIG: SpeechToTextConfig = {
  enabled: true,
  provider: 'local',
  openai: {
    api_key: '',
    base_url: '',
    language: '',
    model: 'whisper-1',
  },
  deepgram: {
    api_key: '',
    base_url: '',
    detectLanguage: true,
    language: '',
    model: 'nova-2',
    punctuate: true,
    smartFormat: true,
  },
  local: {
    model: DEFAULT_LOCAL_SPEECH_TO_TEXT_MODEL,
    language: '',
  },
  groq: {
    model: 'whisper-large-v3-turbo',
    language: '',
  },
};

export const normalizeSpeechToTextConfig = (config?: SpeechToTextConfig): SpeechToTextConfig => ({
  ...DEFAULT_SPEECH_TO_TEXT_CONFIG,
  ...config,
  openai: {
    ...DEFAULT_SPEECH_TO_TEXT_CONFIG.openai,
    ...config?.openai,
  },
  deepgram: {
    ...DEFAULT_SPEECH_TO_TEXT_CONFIG.deepgram,
    ...config?.deepgram,
  },
  local: {
    ...DEFAULT_SPEECH_TO_TEXT_CONFIG.local,
    ...config?.local,
  },
  groq: {
    ...DEFAULT_SPEECH_TO_TEXT_CONFIG.groq,
    ...config?.groq,
  },
});

export const failClosedSpeechToTextConfig = (config?: SpeechToTextConfig): SpeechToTextConfig => ({
  ...normalizeSpeechToTextConfig(config),
  enabled: false,
});
