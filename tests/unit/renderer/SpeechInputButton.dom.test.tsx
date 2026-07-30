import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configGetMock, configReadyMock, startRecordingMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  configReadyMock: vi.fn(),
  startRecordingMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    whenReady: configReadyMock,
  },
}));

vi.mock('@/renderer/hooks/system/useSpeechInput', () => ({
  useSpeechInput: () => ({
    availability: 'record',
    canRetry: false,
    clearError: vi.fn(),
    errorCode: null,
    errorMessage: null,
    recordingDurationMs: 0,
    recordingLevels: [],
    retryTranscription: vi.fn(),
    startRecording: startRecordingMock,
    status: 'idle',
    stopRecording: vi.fn(),
    transcribeFile: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({ icon, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: React.ReactNode }) => (
    <button {...props}>{icon}</button>
  ),
  Message: {
    error: vi.fn(),
    warning: vi.fn(),
  },
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import SpeechInputButton from '@/renderer/components/chat/SpeechInputButton';

const renderButton = () => render(<SpeechInputButton onTranscript={vi.fn()} />);

describe('SpeechInputButton config readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configReadyMock.mockResolvedValue(undefined);
    configGetMock.mockReturnValue(undefined);
  });

  it('does not start microphone capture on mount', async () => {
    renderButton();

    expect(startRecordingMock).not.toHaveBeenCalled();
    await screen.findByRole('button', { name: 'conversation.chat.speech.recordTooltip' });
    expect(startRecordingMock).not.toHaveBeenCalled();
  });

  it('shows the mic only after a successful fresh-config read', async () => {
    let resolveReady!: () => void;
    configReadyMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveReady = resolve;
      })
    );
    renderButton();

    expect(screen.queryByRole('button')).toBeNull();
    await act(async () => resolveReady());

    expect(await screen.findByRole('button', { name: 'conversation.chat.speech.recordTooltip' })).toBeInTheDocument();
  });

  it('stays hidden when persisted config explicitly disables speech input', async () => {
    configGetMock.mockReturnValue({ enabled: false });
    renderButton();

    await waitFor(() => expect(configGetMock).toHaveBeenCalledWith('tools.speechToText'));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('stays hidden when config initialization fails', async () => {
    configReadyMock.mockRejectedValue(new Error('settings unavailable'));
    renderButton();

    await waitFor(() => expect(configReadyMock).toHaveBeenCalledTimes(1));
    expect(configGetMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('starts recording only after the user clicks the visible mic', async () => {
    const user = userEvent.setup();
    renderButton();

    const button = await screen.findByRole('button', {
      name: 'conversation.chat.speech.recordTooltip',
    });
    expect(startRecordingMock).not.toHaveBeenCalled();
    await user.click(button);

    expect(startRecordingMock).toHaveBeenCalledTimes(1);
  });
});
