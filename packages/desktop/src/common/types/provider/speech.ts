/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// 'local' = on-device transcription via the bundled Hermes venv (faster-whisper).
// Keyless + DSGVO-clean (audio never leaves the Mac) — the doctrine-aligned default,
// distinct from the cloud providers which need an API key.
//
// 'groq' = Groq Whisper API (whisper-large-v3-turbo): sub-second, strong German
// out of the box. The bundled Hermes venv already ships the native Groq handler
// (tools.transcription_tools, provider 'groq'); the desktop just routes to it and
// supplies GROQ_API_KEY at runtime from ~/.hermes/.env — the key is NEVER bundled,
// hardcoded, persisted to config.yaml, or logged.
export type SpeechToTextProvider = 'openai' | 'deepgram' | 'local' | 'groq';

// Local on-device STT. No api_key — that's the whole point.
export type LocalSpeechToTextConfig = {
  // faster-whisper model size. 'base' (~150 MB) is the default; larger = more
  // accurate + slower + bigger download.
  model?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
  language?: string;
};

// Groq cloud STT. No api_key field here BY DESIGN: the key is read at runtime
// from ~/.hermes/.env (never stored in the desktop config, never logged). Only
// the non-secret model/language tuning lives here.
export type GroqSpeechToTextConfig = {
  // Groq Whisper model. 'whisper-large-v3-turbo' is the fast default; the venv
  // defaults to the same when this is omitted.
  model?: string;
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
  groq?: GroqSpeechToTextConfig;
};

export type SpeechToTextAudioBuffer = Uint8Array | number[] | Record<string, number>;

export type SpeechToTextRequest = {
  audioBuffer: SpeechToTextAudioBuffer;
  file_name: string;
  languageHint?: string;
  mimeType: string;
};

// The on-device / venv-routed STT payload: the audio plus the chosen provider
// and model. Routed to the main process (which can spawn the venv python and
// inject GROQ_API_KEY from ~/.hermes/.env), NOT to aioncore.
//
// `provider` defaults to 'local' (faster-whisper) when omitted. 'groq' uses the
// bundled venv's native Groq handler (cloud, key injected at runtime). Only the
// keyless venv lanes are valid here — 'openai'/'deepgram' stay on the aioncore
// /api/stt cloud lane (ipcBridge.speechToText.transcribe).
export type CommandEveLocalSttRequest = SpeechToTextRequest & {
  localModel?: LocalSpeechToTextConfig['model'];
  provider?: Extract<SpeechToTextProvider, 'local' | 'groq'>;
  groqModel?: string;
};

export type SpeechToTextResult = {
  language?: string;
  model: string;
  provider: SpeechToTextProvider;
  text: string;
};
