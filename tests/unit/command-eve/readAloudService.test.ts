/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const { multimodalTtsInvokeMock, multimodalTtsStatusInvokeMock } = vi.hoisted(() => ({
  multimodalTtsInvokeMock: vi.fn(),
  multimodalTtsStatusInvokeMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      multimodalTts: { invoke: multimodalTtsInvokeMock },
      multimodalTtsStatus: { invoke: multimodalTtsStatusInvokeMock },
    },
  },
}));

import { readAloudText, stopReadAloud } from '@/renderer/services/ReadAloudService';

class FakeSpeechSynthesisUtterance {
  lang = '';
  onend: (() => void) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null;
  onstart: (() => void) | null = null;

  constructor(public text: string) {}
}

const originalSpeechSynthesis = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
const originalElectronApi = Object.getOwnPropertyDescriptor(window, 'electronAPI');
const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
const spokenUtterances: FakeSpeechSynthesisUtterance[] = [];
const playedAudios: FakeAudio[] = [];

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplay: (() => void) | null = null;
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  play = vi.fn(async () => {
    this.onplay?.();
  });

  constructor(public src: string) {
    playedAudios.push(this);
  }
}

function installSpeechSynthesis() {
  spokenUtterances.length = 0;
  vi.stubGlobal('SpeechSynthesisUtterance', FakeSpeechSynthesisUtterance);
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      cancel: vi.fn(),
      speak: vi.fn((utterance: FakeSpeechSynthesisUtterance) => {
        spokenUtterances.push(utterance);
      }),
    },
  });
}

function installElectronSurface() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {},
  });
}

function installCloudAudioSurface() {
  playedAudios.length = 0;
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('atob', (value: string) => Buffer.from(value, 'base64').toString('binary'));
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:read-aloud'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
}

function restoreSpeechSynthesis() {
  if (originalSpeechSynthesis) {
    Object.defineProperty(window, 'speechSynthesis', originalSpeechSynthesis);
    return;
  }
  delete (window as unknown as { speechSynthesis?: unknown }).speechSynthesis;
}

function restoreElectronSurface() {
  if (originalElectronApi) {
    Object.defineProperty(window, 'electronAPI', originalElectronApi);
    return;
  }
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
}

function restoreObjectUrl() {
  if (originalCreateObjectUrl) {
    Object.defineProperty(URL, 'createObjectURL', originalCreateObjectUrl);
  } else {
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  }
  if (originalRevokeObjectUrl) {
    Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectUrl);
  } else {
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  }
}

describe('ReadAloudService', () => {
  afterEach(() => {
    stopReadAloud();
    restoreSpeechSynthesis();
    restoreElectronSurface();
    restoreObjectUrl();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['canceled', 'cancelled', 'interrupted'])('suppresses %s speech errors after cancel/stop', async (error) => {
    installSpeechSynthesis();
    const onError = vi.fn();

    expect(await readAloudText('Assistant answer', { onError })).toBe(true);
    spokenUtterances[0].onerror?.({ error } as SpeechSynthesisErrorEvent);

    expect(onError).not.toHaveBeenCalled();
  });

  it('forwards real speech errors to the caller', async () => {
    installSpeechSynthesis();
    const onError = vi.fn();

    expect(await readAloudText('Assistant answer', { onError })).toBe(true);
    spokenUtterances[0].onerror?.({ error: 'not-allowed' } as SpeechSynthesisErrorEvent);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ error: 'not-allowed' }));
  });

  it('uses cloud TTS audio artifacts when the desktop gate is ready', async () => {
    installElectronSurface();
    installCloudAudioSurface();
    installSpeechSynthesis();
    const onEnd = vi.fn();
    const onStart = vi.fn();
    multimodalTtsStatusInvokeMock.mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        reason_code: 'EVE_MULTIMODAL_TTS_READY',
      },
    });
    multimodalTtsInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: true,
        artifact: {
          bytes: 4,
          data_base64: Buffer.from('tone').toString('base64'),
          encoding: 'base64',
          kind: 'audio',
          mime_type: 'audio/mpeg',
          status: 'created',
        },
      },
    });

    expect(await readAloudText('Assistant answer', { lang: 'de-DE', onEnd, onStart })).toBe(true);

    expect(multimodalTtsInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'de-DE',
        text: 'Assistant answer',
        voiceId: 'eve',
      })
    );
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledTimes(1);
    playedAudios[0].onended?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:read-aloud');
  });

  it('falls back to local speech when cloud TTS is not ready', async () => {
    installElectronSurface();
    installCloudAudioSurface();
    installSpeechSynthesis();
    multimodalTtsStatusInvokeMock.mockResolvedValue({
      success: true,
      data: {
        enabled: false,
        reason_code: 'EVE_MULTIMODAL_TTS_NOT_ENABLED',
      },
    });

    expect(await readAloudText('Assistant answer')).toBe(true);

    expect(multimodalTtsInvokeMock).not.toHaveBeenCalled();
    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
  });

  it('stops active cloud audio playback and revokes the object URL', async () => {
    installElectronSurface();
    installCloudAudioSurface();
    multimodalTtsStatusInvokeMock.mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        reason_code: 'EVE_MULTIMODAL_TTS_READY',
      },
    });
    multimodalTtsInvokeMock.mockResolvedValue({
      success: true,
      data: {
        ok: true,
        artifact: {
          bytes: 4,
          data_base64: Buffer.from('tone').toString('base64'),
          encoding: 'base64',
          kind: 'audio',
          mime_type: 'audio/mpeg',
          status: 'created',
        },
      },
    });

    expect(await readAloudText('Assistant answer')).toBe(true);
    stopReadAloud();

    expect(playedAudios[0].pause).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:read-aloud');
  });
});
