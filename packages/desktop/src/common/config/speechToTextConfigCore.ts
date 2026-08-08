/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SpeechToTextConfig } from '@/common/types/provider/speech';

export const DEFAULT_LOCAL_SPEECH_TO_TEXT_MODEL = 'small';

/**
 * The defaults are COMPLETE, and the type now says so.
 *
 * Every sub-config is optional in `SpeechToTextConfig`, so annotating this
 * object with that type checked the literal and then threw away what the
 * literal knows: `DEFAULT_SPEECH_TO_TEXT_CONFIG.openai` came out as
 * `OpenAISpeechToTextConfig | undefined` even though the object right here
 * plainly provides it. That is how a complete set of defaults ends up unable to
 * serve as defaults.
 *
 * Spelling the completeness into the type is better than `satisfies` here:
 * `satisfies` would also pin the literals (`detectLanguage: true`,
 * `model: 'small'`), and a default nobody may override is not a default.
 */
type CompleteSpeechToTextConfig = SpeechToTextConfig &
  Required<Pick<SpeechToTextConfig, 'openai' | 'deepgram' | 'local' | 'groq'>>;

export const DEFAULT_SPEECH_TO_TEXT_CONFIG: CompleteSpeechToTextConfig = {
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

/**
 * Lay an optional, possibly-partial override over a COMPLETE default.
 *
 * Why this exists rather than four inline spreads: `{ ...defaults, ...maybe }`
 * widens every required field of `defaults` to optional as soon as `maybe` can
 * be `undefined`, so the result stops satisfying its own type even though the
 * defaults supply every field at runtime.
 *
 * The direction here is deliberately fail-CLOSED and stays that way. The one
 * credential involved, `api_key`, defaults to the empty string, and an empty key
 * cannot authenticate — so falling back to the default can only ever leave
 * speech-to-text unable to run, never quietly enable it. This is a type
 * correction, not a policy default; nothing here decides authority, money or
 * permission.
 */
const overlay = <T extends object>(defaults: T, override: Partial<T> | undefined): T => ({
  ...defaults,
  ...override,
});

export const normalizeSpeechToTextConfig = (config?: SpeechToTextConfig): SpeechToTextConfig => ({
  ...DEFAULT_SPEECH_TO_TEXT_CONFIG,
  ...config,
  openai: overlay(DEFAULT_SPEECH_TO_TEXT_CONFIG.openai, config?.openai),
  deepgram: overlay(DEFAULT_SPEECH_TO_TEXT_CONFIG.deepgram, config?.deepgram),
  local: overlay(DEFAULT_SPEECH_TO_TEXT_CONFIG.local, config?.local),
  groq: overlay(DEFAULT_SPEECH_TO_TEXT_CONFIG.groq, config?.groq),
});

export const failClosedSpeechToTextConfig = (config?: SpeechToTextConfig): SpeechToTextConfig => ({
  ...normalizeSpeechToTextConfig(config),
  enabled: false,
});
