import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configGetMock, configReadyMock, localInvokeMock, transcribeInvokeMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  configReadyMock: vi.fn(),
  localInvokeMock: vi.fn(),
  transcribeInvokeMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    whenReady: configReadyMock,
  },
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      speechToTextLocal: {
        invoke: localInvokeMock,
      },
    },
    speechToText: {
      transcribe: {
        invoke: transcribeInvokeMock,
      },
    },
  },
}));

import { transcribeAudioBlob } from '@/renderer/services/SpeechToTextService';

describe('SpeechToTextService readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configReadyMock.mockResolvedValue(undefined);
    configGetMock.mockReturnValue(undefined);
    localInvokeMock.mockResolvedValue({
      success: true,
      data: { text: 'Hallo' },
    });
  });

  it('uses the bundled local lane after a successful fresh-config read', async () => {
    const result = await transcribeAudioBlob(new Blob(['audio'], { type: 'audio/webm' }), 'de-DE');

    expect(configReadyMock).toHaveBeenCalledTimes(1);
    expect(localInvokeMock).toHaveBeenCalledTimes(1);
    expect(localInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        languageHint: 'de-DE',
        provider: 'local',
        localModel: 'small',
      })
    );
    expect(transcribeInvokeMock).not.toHaveBeenCalled();
    expect(result.text).toBe('Hallo');
  });

  it('fails closed when config initialization fails', async () => {
    configReadyMock.mockRejectedValue(new Error('settings unavailable'));

    await expect(transcribeAudioBlob(new Blob(['audio'], { type: 'audio/webm' }))).rejects.toThrow(
      'settings unavailable'
    );

    expect(configGetMock).not.toHaveBeenCalled();
    expect(localInvokeMock).not.toHaveBeenCalled();
    expect(transcribeInvokeMock).not.toHaveBeenCalled();
  });

  it('blocks programmatic transcription after an explicit disable', async () => {
    configGetMock.mockReturnValue({ enabled: false, provider: 'local' });

    await expect(transcribeAudioBlob(new Blob(['audio'], { type: 'audio/webm' }))).rejects.toThrow('STT_DISABLED');

    expect(localInvokeMock).not.toHaveBeenCalled();
    expect(transcribeInvokeMock).not.toHaveBeenCalled();
  });
});
