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

import { readAloudText, selectLocalSpeechVoice, stopReadAloud } from '@/renderer/services/ReadAloudService';

class FakeSpeechSynthesisUtterance {
  lang = '';
  voice: SpeechSynthesisVoice | null = null;
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
let deferredAudioPlay: Promise<void> | null = null;
let rejectNextAudioPlay = false;

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplay: (() => void) | null = null;
  pause = vi.fn();
  removeAttribute = vi.fn();
  load = vi.fn();
  play = vi.fn(async () => {
    if (rejectNextAudioPlay) {
      rejectNextAudioPlay = false;
      throw new Error('blocked');
    }
    if (deferredAudioPlay) {
      await deferredAudioPlay;
    }
    this.onplay?.();
  });

  constructor(public src: string) {
    playedAudios.push(this);
  }
}

const speechVoice = (input: {
  default?: boolean;
  lang: string;
  localService: boolean;
  name: string;
}): SpeechSynthesisVoice =>
  ({
    default: input.default ?? false,
    lang: input.lang,
    localService: input.localService,
    name: input.name,
    voiceURI: input.name,
  }) as SpeechSynthesisVoice;

const defaultLocalVoice = speechVoice({ default: true, lang: 'en-US', localService: true, name: 'Local English' });

function installSpeechSynthesis(voices: SpeechSynthesisVoice[] = [defaultLocalVoice]) {
  spokenUtterances.length = 0;
  vi.stubGlobal('SpeechSynthesisUtterance', FakeSpeechSynthesisUtterance);
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      cancel: vi.fn(),
      getVoices: vi.fn(() => voices),
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
  deferredAudioPlay = null;
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
    deferredAudioPlay = null;
    rejectNextAudioPlay = false;
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

  it('selects a language-matching localService voice and refuses remote-only voices', async () => {
    const remoteGerman = speechVoice({ lang: 'de-DE', localService: false, name: 'Remote German' });
    const localEnglish = speechVoice({ lang: 'en-US', localService: true, name: 'Local English' });
    const localGerman = speechVoice({ lang: 'de-DE', localService: true, name: 'Local German' });
    installSpeechSynthesis([remoteGerman, localEnglish, localGerman]);

    expect(selectLocalSpeechVoice([remoteGerman, localEnglish, localGerman], 'de-DE')).toBe(localGerman);
    expect(await readAloudText('Lokale Antwort', { lang: 'de-DE', preferCloud: false })).toBe(true);
    expect(spokenUtterances[0].voice).toBe(localGerman);

    installSpeechSynthesis([remoteGerman]);
    expect(await readAloudText('Nicht extern sprechen', { lang: 'de-DE', preferCloud: false })).toBe(false);
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
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
    installSpeechSynthesis([speechVoice({ default: true, lang: 'de-DE', localService: true, name: 'Local German' })]);
    const onCloudArtifact = vi.fn();
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
        capability: 'tts',
        ok: true,
        provider: 'xai',
        reason: 'provider-complete',
        artifact: {
          bytes: 4,
          data_base64: Buffer.from('tone').toString('base64'),
          encoding: 'base64',
          kind: 'audio',
          mime_type: 'audio/mpeg',
          status: 'created',
        },
        residency: {
          confirmation: 'explicit-us-cloud',
          effectiveResidency: 'us_cloud',
          requestedPrivacyLane: 'cloud_us',
        },
        tts: {
          language: 'de-DE',
          text_length: 16,
          voice_id: 'eve',
        },
      },
    });

    expect(await readAloudText('Assistant answer', { lang: 'de-DE', onCloudArtifact, onEnd, onStart })).toBe(true);

    expect(multimodalTtsInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'de-DE',
        text: 'Assistant answer',
        voiceId: 'eve',
      })
    );
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onCloudArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({ bytes: 4, mime_type: 'audio/mpeg' }),
        provider: 'xai',
        requestId: expect.stringMatching(/^read-aloud-/),
        sourceUrl: `data:audio/mpeg;base64,${Buffer.from('tone').toString('base64')}`,
      })
    );
    playedAudios[0].onended?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:read-aloud');
  });

  it('does not publish a cloud artifact when playback fails and local speech handles the text', async () => {
    installElectronSurface();
    installCloudAudioSurface();
    installSpeechSynthesis();
    const onCloudArtifact = vi.fn();
    rejectNextAudioPlay = true;
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
        capability: 'tts',
        ok: true,
        provider: 'xai',
        reason: 'provider-complete',
        artifact: {
          bytes: 4,
          data_base64: Buffer.from('tone').toString('base64'),
          encoding: 'base64',
          kind: 'audio',
          mime_type: 'audio/mpeg',
          status: 'created',
        },
        residency: {
          confirmation: 'explicit-us-cloud',
          effectiveResidency: 'us_cloud',
          requestedPrivacyLane: 'cloud_us',
        },
      },
    });

    expect(await readAloudText('Assistant answer', { onCloudArtifact })).toBe(true);

    expect(onCloudArtifact).not.toHaveBeenCalled();
    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
  });

  it('does not publish a cloud artifact from a superseded read-aloud run', async () => {
    installElectronSurface();
    installCloudAudioSurface();
    installSpeechSynthesis();
    const onCloudArtifact = vi.fn();
    let releasePlayback!: () => void;
    deferredAudioPlay = new Promise<void>((resolve) => {
      releasePlayback = resolve;
    });
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
        capability: 'tts',
        ok: true,
        provider: 'xai',
        reason: 'provider-complete',
        artifact: {
          bytes: 4,
          data_base64: Buffer.from('tone').toString('base64'),
          encoding: 'base64',
          kind: 'audio',
          mime_type: 'audio/mpeg',
          status: 'created',
        },
        residency: {
          confirmation: 'explicit-us-cloud',
          effectiveResidency: 'us_cloud',
          requestedPrivacyLane: 'cloud_us',
        },
      },
    });

    const firstRead = readAloudText('Assistant answer', { onCloudArtifact });
    await vi.waitFor(() => {
      expect(playedAudios).toHaveLength(1);
    });
    stopReadAloud();
    releasePlayback();

    expect(await firstRead).toBe(true);
    expect(onCloudArtifact).not.toHaveBeenCalled();
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

  it('uses German local speech without probing cloud when dialogue mode forbids cloud', async () => {
    installElectronSurface();
    installCloudAudioSurface();
    installSpeechSynthesis([speechVoice({ default: true, lang: 'de-DE', localService: true, name: 'Local German' })]);
    multimodalTtsStatusInvokeMock.mockResolvedValue({
      success: true,
      data: {
        enabled: true,
        reason_code: 'EVE_MULTIMODAL_TTS_READY',
      },
    });

    expect(await readAloudText('Lokale Antwort', { lang: 'de-DE', preferCloud: false })).toBe(true);

    expect(multimodalTtsStatusInvokeMock).not.toHaveBeenCalled();
    expect(multimodalTtsInvokeMock).not.toHaveBeenCalled();
    expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
    expect(spokenUtterances[0]).toMatchObject({ text: 'Lokale Antwort', lang: 'de-DE' });
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
        capability: 'tts',
        ok: true,
        provider: 'xai',
        reason: 'provider-complete',
        artifact: {
          bytes: 4,
          data_base64: Buffer.from('tone').toString('base64'),
          encoding: 'base64',
          kind: 'audio',
          mime_type: 'audio/mpeg',
          status: 'created',
        },
        residency: {
          confirmation: 'explicit-us-cloud',
          effectiveResidency: 'us_cloud',
          requestedPrivacyLane: 'cloud_us',
        },
      },
    });

    expect(await readAloudText('Assistant answer')).toBe(true);
    stopReadAloud();

    expect(playedAudios[0].pause).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:read-aloud');
  });
});
