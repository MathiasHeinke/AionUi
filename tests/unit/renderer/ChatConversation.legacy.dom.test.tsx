import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TChatConversation } from '@/common/config/storage';
import ChatConversation from '@/renderer/pages/conversation/components/ChatConversation';

const { modelSelectionOptions, runtimeViewMock, stopInvokeMock, updateInvokeMock, saveDefaultModelMock } = vi.hoisted(
  () => ({
    modelSelectionOptions: {
      current: null as { onSelectModel: (provider: unknown, model: string) => Promise<boolean> } | null,
    },
    runtimeViewMock: {
      activeTurnId: 'turn-a' as string | null,
      issueStopAttempt: vi.fn(() => ({
        kind: 'stop',
        conversationId: 'conv-aionrs',
        seatId: 'seat-a',
        seatGeneration: 0,
        attemptId: 1,
      })),
      markStopRequested: vi.fn(() => true),
      markStopAcknowledged: vi.fn(() => true),
      resetLocalGate: vi.fn(() => true),
    },
    stopInvokeMock: vi.fn(),
    updateInvokeMock: vi.fn(),
    saveDefaultModelMock: vi.fn(),
  })
);

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      stop: { invoke: stopInvokeMock },
      update: { invoke: updateInvokeMock },
    },
  },
}));

vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => runtimeViewMock,
}));

vi.mock('@/renderer/pages/conversation/platforms/aionrs/useAionrsModelSelection', () => ({
  useAionrsModelSelection: (options: typeof modelSelectionOptions.current) => {
    modelSelectionOptions.current = options;
    return { current_model: undefined, providers: [], getAvailableModels: () => [], handleSelectModel: vi.fn() };
  },
}));

vi.mock('@/renderer/pages/guid/hooks/agentSelectionUtils', () => ({
  saveAionrsDefaultModel: saveDefaultModelMock,
}));

vi.mock('@/renderer/pages/conversation/platforms/aionrs/AionrsModelSelector', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/platforms/aionrs/AionrsChat', () => ({ default: () => <div>aionrs chat</div> }));

vi.mock('@/renderer/pages/conversation/Messages/MessageList', () => ({
  default: ({ className }: { className?: string }) => <div className={className}>message history</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  MessageListLoadingProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MessageListProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useMessageLstCache: vi.fn(),
}));

vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({
  ConversationArtifactProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/renderer/pages/conversation/components/ChatLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/pages/conversation/components/ChatSlider.tsx', () => ({
  default: () => <div>slider</div>,
}));

vi.mock('@/renderer/pages/cron', () => ({
  CronJobManager: () => <div>cron</div>,
}));

vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  resolveAssistantConfigId: () => undefined,
  usePresetAssistantInfo: () => ({ info: undefined, isLoading: false }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ openPreview: vi.fn() }),
}));

function legacyConversation(type: 'gemini' | 'codex' | 'openclaw-gateway' | 'nanobot' | 'remote'): TChatConversation {
  return {
    id: `conv-${type}`,
    user_id: 'user-1',
    name: `${type} history`,
    type,
    model: {},
    extra: { workspace: '/tmp/aionui-history' },
    status: 'finished',
    source: 'aionui',
    created_at: 1,
    modified_at: 1,
    pinned: false,
  } as TChatConversation;
}

const aionrsConversation = (): TChatConversation =>
  ({
    ...legacyConversation('remote'),
    id: 'conv-aionrs',
    type: 'aionrs',
    model: { id: 'provider-old', use_model: 'old-model' },
  }) as TChatConversation;

describe('ChatConversation legacy runtime rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeViewMock.activeTurnId = 'turn-a';
    runtimeViewMock.markStopRequested.mockReturnValue(true);
    runtimeViewMock.markStopAcknowledged.mockReturnValue(true);
    runtimeViewMock.resetLocalGate.mockReturnValue(true);
    stopInvokeMock.mockResolvedValue({ runtime: { is_processing: false, turn_id: null } });
    updateInvokeMock.mockResolvedValue(true);
  });
  it.each(['gemini', 'codex', 'openclaw-gateway', 'nanobot', 'remote'] as const)(
    'renders %s history without the old runtime chat',
    (type) => {
      render(<ChatConversation conversation={legacyConversation(type)} />);

      expect(screen.getByText('message history')).toBeInTheDocument();
      expect(screen.queryByTestId('legacy-openclaw-chat')).not.toBeInTheDocument();
      expect(screen.queryByTestId('legacy-nanobot-chat')).not.toBeInTheDocument();
      expect(screen.queryByTestId('legacy-remote-chat')).not.toBeInTheDocument();
    }
  );

  it('updates an AionRS model only after the exact stop ticket is acknowledged', async () => {
    render(<ChatConversation conversation={aionrsConversation()} />);
    await act(async () => {
      await modelSelectionOptions.current?.onSelectModel({ id: 'provider-new' }, 'new-model');
    });

    const ticket = runtimeViewMock.issueStopAttempt.mock.results[0]?.value;
    expect(runtimeViewMock.markStopRequested).toHaveBeenCalledWith(ticket, 'turn-a');
    expect(runtimeViewMock.markStopAcknowledged).toHaveBeenCalledWith(ticket, 'turn-a', expect.anything());
    expect(updateInvokeMock).toHaveBeenCalledTimes(1);
    expect(saveDefaultModelMock).toHaveBeenCalledWith('provider-new', 'new-model');
  });

  it('suppresses model mutation after a stale or rejected stop result', async () => {
    render(<ChatConversation conversation={aionrsConversation()} />);
    runtimeViewMock.markStopAcknowledged.mockReturnValueOnce(false);
    await act(async () => {
      await modelSelectionOptions.current?.onSelectModel({ id: 'provider-new' }, 'new-model');
    });
    expect(updateInvokeMock).not.toHaveBeenCalled();
    expect(saveDefaultModelMock).not.toHaveBeenCalled();

    stopInvokeMock.mockRejectedValueOnce(new Error('stop failed'));
    await act(async () => {
      await modelSelectionOptions.current?.onSelectModel({ id: 'provider-new' }, 'new-model');
    });
    expect(runtimeViewMock.resetLocalGate).toHaveBeenCalledWith(
      runtimeViewMock.issueStopAttempt.mock.results[1]?.value,
      'stop_failed'
    );
    expect(updateInvokeMock).not.toHaveBeenCalled();
  });
});
