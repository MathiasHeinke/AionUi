/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { normalizeSpeechToTextConfig } from '@/common/config/speechToTextConfigCore';
import type { SpeechToTextConfig, SpeechToTextResult } from '@/common/types/provider/speech';
import { isElectronDesktop } from '@/renderer/utils/platform';

const MAX_AUDIO_FILE_SIZE_MB = 30;
const MAX_AUDIO_FILE_SIZE_BYTES = MAX_AUDIO_FILE_SIZE_MB * 1024 * 1024;

const getAudioExtension = (mimeType: string) => {
  switch (mimeType) {
    case 'audio/mp4':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/ogg':
    case 'audio/ogg;codecs=opus':
      return 'ogg';
    case 'audio/wav':
    case 'audio/wave':
      return 'wav';
    default:
      return 'webm';
  }
};

const createAudioFileName = (mimeType: string) => {
  return `speech-input.${getAudioExtension(mimeType)}`;
};

const ensureAudioSize = (blob: Blob) => {
  if (blob.size > MAX_AUDIO_FILE_SIZE_BYTES) {
    throw new Error('STT_FILE_TOO_LARGE');
  }
};

const parseWebResponse = async (response: XMLHttpRequest): Promise<SpeechToTextResult> => {
  const payload = JSON.parse(response.responseText) as {
    data?: SpeechToTextResult;
    msg?: string;
    success: boolean;
  };

  if (!payload.success || !payload.data) {
    throw new Error(payload.msg || 'STT_REQUEST_FAILED');
  }

  return payload.data;
};

export async function transcribeAudioBlob(blob: Blob, languageHint?: string): Promise<SpeechToTextResult> {
  ensureAudioSize(blob);
  await configService.whenReady();
  const storedSttConfig = configService.get('tools.speechToText') as SpeechToTextConfig | undefined;
  const sttConfig = normalizeSpeechToTextConfig(storedSttConfig);
  if (sttConfig.enabled === false) {
    throw new Error('STT_DISABLED');
  }

  const mimeType = blob.type || 'audio/webm';
  const file_name = createAudioFileName(mimeType);

  if (isElectronDesktop()) {
    const audioBuffer = new Uint8Array(await blob.arrayBuffer());
    const payload = {
      audioBuffer: Array.from(audioBuffer),
      file_name,
      languageHint,
      mimeType,
    };
    // The 'local' and 'groq' providers transcribe via the bundled venv through a
    // separate main-process IPC, NOT aioncore's /api/stt cloud lane:
    //   - 'local' runs faster-whisper ON-DEVICE (no cloud, no key) — DSGVO-clean.
    //   - 'groq'  calls the Groq Whisper API (whisper-large-v3-turbo, sub-second,
    //     strong German). The key is injected at runtime in the MAIN process from
    //     ~/.hermes/.env — never bundled, hardcoded, persisted, or logged here.
    //
    // DEFAULT to local on desktop. Previously an UNSET provider fell through to
    // aioncore's /api/stt cloud lane, which 400s instantly → "Spracheingabe
    // fehlgeschlagen" even though the local lane works. Only the venv lanes
    // (local/groq) go through speechToTextLocal; openai/deepgram stay on the
    // aioncore /api/stt cloud lane.
    const provider = sttConfig.provider;
    const useVenvLane = provider === 'local' || provider === 'groq';
    if (useVenvLane) {
      const response = await ipcBridge.commandEve.speechToTextLocal.invoke({
        ...payload,
        provider: provider === 'groq' ? 'groq' : 'local',
        localModel: sttConfig.local?.model,
        groqModel: sttConfig.groq?.model,
      });
      if (!response.success || !response.data) {
        throw new Error(response.msg || 'STT_REQUEST_FAILED');
      }
      return response.data;
    }
    return ipcBridge.speechToText.transcribe.invoke(payload);
  }

  const formData = new FormData();
  formData.append('audio', blob, file_name);
  formData.append('mimeType', mimeType);
  if (languageHint) {
    formData.append('languageHint', languageHint);
  }

  return new Promise<SpeechToTextResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/stt');
    xhr.withCredentials = true;

    xhr.addEventListener('load', () => {
      if (xhr.status === 413) {
        reject(new Error('STT_FILE_TOO_LARGE'));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`STT_REQUEST_FAILED:${xhr.status} ${xhr.statusText}`));
        return;
      }

      parseWebResponse(xhr).then(resolve).catch(reject);
    });

    xhr.addEventListener('error', () => {
      reject(new Error('STT_NETWORK_ERROR'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('STT_ABORTED'));
    });

    xhr.send(formData);
  });
}
