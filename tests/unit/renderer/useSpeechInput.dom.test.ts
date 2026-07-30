import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserMediaMock } = vi.hoisted(() => ({
  getUserMediaMock: vi.fn(),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
}));

vi.mock('@/renderer/services/SpeechToTextService', () => ({
  transcribeAudioBlob: vi.fn(),
}));

import { useSpeechInput } from '@/renderer/hooks/system/useSpeechInput';

class MediaRecorderMock {
  static isTypeSupported = vi.fn(() => true);

  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;
  state: RecordingState = 'inactive';

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? '';
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
  }
}

describe('useSpeechInput microphone activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('MediaRecorder', MediaRecorderMock);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: getUserMediaMock },
    });
    getUserMediaMock.mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not request microphone access until startRecording is called', async () => {
    const { result, rerender, unmount } = renderHook(() => useSpeechInput({ onTranscript: vi.fn() }));

    expect(result.current.availability).toBe('record');
    expect(getUserMediaMock).not.toHaveBeenCalled();

    rerender();
    expect(getUserMediaMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.startRecording();
    });

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(getUserMediaMock).toHaveBeenCalledWith({ audio: true });

    unmount();
  });
});
