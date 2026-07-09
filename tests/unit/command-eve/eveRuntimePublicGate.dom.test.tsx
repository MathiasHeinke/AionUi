import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigProvider } from '@arco-design/web-react';
import { commandEve } from '@/common/adapter/ipcBridge';
import EveRuntime from '@/renderer/pages/settings/EveRuntime';

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    shellFlags: { invoke: vi.fn() },
  },
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

vi.mock('@renderer/components/team/DeinTeamPanel', () => ({
  default: () => <div data-testid='dein-team-panel'>curated team</div>,
}));

vi.mock('@/renderer/pages/settings/AssistantSettings', () => ({
  AssistantSettingsBody: () => <div data-testid='assistant-settings-body'>raw assistants</div>,
}));

vi.mock('@/renderer/components/settings/SettingsModal/contents/AgentModalContent', () => ({
  default: () => <div data-testid='agent-modal-content'>raw local agents</div>,
}));

vi.mock('@/renderer/pages/settings/EveRuntime/WorkerAssignmentCard', () => ({
  default: () => <div data-testid='worker-assignment-card'>raw worker assignment</div>,
}));

vi.mock('@/renderer/pages/settings/EveRuntime/HumanGateDisplay', () => ({
  default: () => <div data-testid='human-gate-display'>raw human gates</div>,
}));

const renderRuntime = () =>
  render(
    <ConfigProvider>
      <EveRuntime />
    </ConfigProvider>
  );

beforeEach(() => {
  vi.mocked(commandEve.shellFlags.invoke).mockResolvedValue({
    success: true,
    data: { ok: true, founder_build: false },
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EveRuntime public surface gate', () => {
  it('shows only the curated Command EVE orchestration surface in public builds', async () => {
    renderRuntime();

    await waitFor(() => expect(commandEve.shellFlags.invoke).toHaveBeenCalled());

    expect(screen.getByTestId('dein-team-panel')).toBeInTheDocument();
    expect(screen.queryByText('Assistenten')).toBeNull();
    expect(screen.queryByText('Agenten & Belegschaft')).toBeNull();
    expect(screen.queryByTestId('assistant-settings-body')).toBeNull();
    expect(screen.queryByTestId('agent-modal-content')).toBeNull();
    expect(screen.queryByTestId('worker-assignment-card')).toBeNull();
    expect(screen.queryByTestId('human-gate-display')).toBeNull();
  });
});
