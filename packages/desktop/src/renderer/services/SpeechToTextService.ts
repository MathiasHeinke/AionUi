/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
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
    // The 'local' provider transcribes ON-DEVICE via the bundled venv (no cloud,
    // no key) — a separate main-process IPC, NOT aioncore's /api/stt cloud lane.
    //
    // DEFAULT to local on desktop. The on-device lane is the DSGVO-clean lane (audio never
    // leaves the Mac, no key) and is what the product intends (hermes config.yaml pins
    // stt.provider:local). Previously an UNSET provider fell through to aioncore's /api/stt
    // cloud lane, which 400s instantly → "Spracheingabe fehlgeschlagen" even though the local
    // lane works. Only route to a cloud STT provider if one is EXPLICITLY configured.
    const sttConfig = configService.get('tools.speechToText') as SpeechToTextConfig | undefined;
    const useLocal = !sttConfig?.provider || sttConfig.provider === 'local';
    if (useLocal) {
      const response = await ipcBridge.commandEve.speechToTextLocal.invoke({
        ...payload,
        localModel: sttConfig?.local?.model,
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
