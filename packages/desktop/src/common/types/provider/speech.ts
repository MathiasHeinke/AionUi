/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// 'local' = on-device transcription via the bundled Hermes venv (faster-whisper).
// Keyless + DSGVO-clean (audio never leaves the Mac) — the doctrine-aligned default,
// distinct from the cloud providers which need an API key.
export type SpeechToTextProvider = 'openai' | 'deepgram' | 'local';

// Local on-device STT. No api_key — that's the whole point.
export type LocalSpeechToTextConfig = {
  // faster-whisper model size. 'base' (~150 MB) is the default; larger = more
  // accurate + slower + bigger download.
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
  language?: string;
};

export type OpenAISpeechToTextConfig = {
  api_key: string;
  base_url?: string;
  language?: string;
  model: string;
  prompt?: string;
  temperature?: number;
};

export type DeepgramSpeechToTextConfig = {
  api_key: string;
  base_url?: string;
  detectLanguage?: boolean;
  language?: string;
  model: string;
  punctuate?: boolean;
  smartFormat?: boolean;
};

export type SpeechToTextConfig = {
  autoSend?: boolean;
  enabled: boolean;
  provider: SpeechToTextProvider;
  deepgram?: DeepgramSpeechToTextConfig;
  openai?: OpenAISpeechToTextConfig;
  local?: LocalSpeechToTextConfig;
};

export type SpeechToTextAudioBuffer = Uint8Array | number[] | Record<string, number>;

export type SpeechToTextRequest = {
  audioBuffer: SpeechToTextAudioBuffer;
  file_name: string;
  languageHint?: string;
  mimeType: string;
};

// The local-lane IPC payload: the audio plus the chosen faster-whisper model.
// Routed to the main process (which can spawn the venv python), NOT to aioncore.
export type CommandEveLocalSttRequest = SpeechToTextRequest & {
  localModel?: LocalSpeechToTextConfig['model'];
};

export type SpeechToTextResult = {
  language?: string;
  model: string;
  provider: SpeechToTextProvider;
  text: string;
};
