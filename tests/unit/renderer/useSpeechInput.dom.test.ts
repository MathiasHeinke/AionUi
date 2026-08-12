import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserMediaMock, transcribeAudioBlobMock } = vi.hoisted(() => ({
  getUserMediaMock: vi.fn(),
  transcribeAudioBlobMock: vi.fn(),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
}));

vi.mock('@/renderer/services/SpeechToTextService', () => ({
  transcribeAudioBlob: transcribeAudioBlobMock,
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

  it('reports a denied microphone permission without retrying capture', async () => {
    getUserMediaMock.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    const { result } = renderHook(() => useSpeechInput({ onTranscript: vi.fn() }));

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('permission-denied');
    expect(result.current.canRetry).toBe(false);
  });

  it('reports a missing microphone as an audio-capture error', async () => {
    getUserMediaMock.mockRejectedValue(new DOMException('no device', 'NotFoundError'));
    const { result } = renderHook(() => useSpeechInput({ onTranscript: vi.fn() }));

    await act(async () => {
      await result.current.startRecording();
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('audio-capture');
    expect(result.current.canRetry).toBe(false);
  });

  it('keeps recorded audio retryable when local transcription is offline', async () => {
    transcribeAudioBlobMock.mockRejectedValue(new Error('STT_NETWORK_ERROR'));
    const { result } = renderHook(() => useSpeechInput({ onTranscript: vi.fn() }));

    await act(async () => {
      await result.current.transcribeFile(new Blob(['audio'], { type: 'audio/webm' }));
    });

    expect(result.current.status).toBe('error');
    expect(result.current.errorCode).toBe('network');
    expect(result.current.canRetry).toBe(true);
  });

  it('forwards the voice-dialogue local-only policy to transcription', async () => {
    transcribeAudioBlobMock.mockResolvedValue({ text: 'Hallo EVE' });
    const onTranscript = vi.fn();
    const { result } = renderHook(() =>
      useSpeechInput({ forceLocalTranscription: true, locale: 'de-DE', onTranscript })
    );

    await act(async () => {
      await result.current.transcribeFile(new Blob(['audio'], { type: 'audio/webm' }));
    });

    expect(transcribeAudioBlobMock).toHaveBeenCalledWith(expect.any(Blob), 'de-DE', { forceLocal: true });
    expect(onTranscript).toHaveBeenCalledWith('Hallo EVE');
  });

  it('keeps failed voice audio local-only when retry runs after voice mode is disabled', async () => {
    let forceLocalTranscription = true;
    transcribeAudioBlobMock.mockRejectedValueOnce(new Error('STT_NETWORK_ERROR'));
    const { result, rerender } = renderHook(() =>
      useSpeechInput({ forceLocalTranscription, locale: 'de-DE', onTranscript: vi.fn() })
    );

    await act(async () => {
      await result.current.transcribeFile(new Blob(['voice-audio'], { type: 'audio/webm' }));
    });
    expect(result.current.canRetry).toBe(true);

    forceLocalTranscription = false;
    rerender();
    transcribeAudioBlobMock.mockResolvedValueOnce({ text: 'Lokaler Retry' });
    act(() => result.current.retryTranscription());

    await waitFor(() => expect(transcribeAudioBlobMock).toHaveBeenCalledTimes(2));
    expect(transcribeAudioBlobMock.mock.calls[1]).toEqual([expect.any(Blob), 'de-DE', { forceLocal: true }]);
  });
});
