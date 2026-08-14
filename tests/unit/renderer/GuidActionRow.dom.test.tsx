/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'de' },
  }),
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));
vi.mock('@/renderer/components/agent/AgentModeSelector', () => ({
  default: () => <div data-testid='mode-compatibility-controller' />,
}));
vi.mock('@/renderer/components/agent/EveMaxToggle', () => ({ default: () => <div data-testid='eve-max-toggle' /> }));
vi.mock('@/renderer/components/chat/ComposerContextDeck', () => ({
  default: ({ projectSlot, maxSlot }: { projectSlot: React.ReactNode; maxSlot?: React.ReactNode }) => (
    <div data-testid='composer-context-deck'>
      {projectSlot}
      <span data-testid='composer-authority-control'>authority</span>
      {maxSlot}
    </div>
  ),
}));
vi.mock('@/renderer/components/workspace', () => ({
  WorkspaceContextControl: ({ workspacePath }: { workspacePath?: string }) => (
    <div data-testid='workspace-context-control'>{workspacePath}</div>
  ),
}));
vi.mock('@/renderer/pages/guid/components/PresetAgentTag', () => ({ default: () => <div data-testid='preset-tag' /> }));

const { showOpen } = vi.hoisted(() => ({ showOpen: vi.fn(() => Promise.resolve<string[]>([])) }));
vi.mock('@/common', () => ({ ipcBridge: { dialog: { showOpen: { invoke: showOpen } } } }));
vi.mock('@/renderer/services/FileService', () => ({
  getCleanFileNames: (files: string[]) => files,
  FileService: { processDroppedFiles: vi.fn() },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/common/config/commandEveShell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common/config/commandEveShell')>();
  return {
    ...actual,
    isCommandEveAcpConversation: (backend?: string) => backend === 'hermes',
    COMMAND_EVE_DEFAULT_ACP_BACKEND: 'hermes',
    COMMAND_EVE_SHELL_ENABLED: true,
  };
});
vi.mock('@/renderer/utils/model/agentModes', () => ({
  supportsModeSwitch: () => true,
  createModeLabelFormatter: () => (mode: { label: string }) => mode.label,
}));

import GuidActionRow from '@/renderer/pages/guid/components/GuidActionRow';

const baseProps = {
  files: [] as string[],
  onFilesUploaded: vi.fn(),
  workspaceDir: '/tmp/Produkt-Roadmap',
  onSelectWorkspace: vi.fn(),
  onClearWorkspace: vi.fn(),
  modelSelectorNode: <div data-testid='model-node' />,
  selectedAgent: 'hermes',
  effectiveModeAgent: 'hermes',
  selectedMode: 'default',
  onModeSelect: vi.fn(),
  is_presetAgent: false,
  selectedAgentInfo: undefined,
  assistants: [],
  localeKey: 'de',
  onClosePresetTag: vi.fn(),
  skillCatalog: {
    mode: 'selection' as const,
    status: 'ready' as const,
    items: [],
    activeItems: [],
    activeCount: 0,
    totalCount: 0,
    selection: {},
  },
  onToggleSkill: vi.fn(),
  mcpServers: [],
  selectedMcpServerIds: [],
  onToggleMcpServer: vi.fn(),
  workProductMode: 'chat' as const,
  onWorkProductModeChange: vi.fn(),
  loading: false,
  isButtonDisabled: false,
  onSend: vi.fn(),
};

const renderRow = (props = {}) =>
  render(
    <MemoryRouter>
      <GuidActionRow {...baseProps} {...props} />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  showOpen.mockResolvedValue([]);
});

describe('GuidActionRow (compact EVE composer)', () => {
  it('renders one primary row plus the shared project/authority/MAX/context deck', () => {
    renderRow({ speechInputNode: <div data-testid='guid-mic' /> });

    expect(screen.getByTestId('unified-send-bar')).toBeVisible();
    expect(screen.getByTestId('file-upload-btn')).toBeVisible();
    expect(screen.getByTestId('work-product-tools-trigger')).toBeVisible();
    expect(screen.getByTestId('composer-context-deck')).toBeVisible();
    expect(screen.getByTestId('workspace-context-control')).toHaveTextContent('Produkt-Roadmap');
    expect(screen.getByTestId('composer-authority-control')).toBeVisible();
    expect(screen.getByTestId('eve-max-toggle')).toBeVisible();
    expect(screen.getByTestId('guid-mic')).toBeVisible();
    expect(screen.getByTestId('guid-send-btn')).toBeVisible();
    expect(screen.queryByTestId('eve-composer-control-trigger')).toBeNull();
    expect(screen.queryByTestId('model-node')).toBeNull();
  });

  it('keeps the compatibility mode controller mounted but not in the visible control row', () => {
    renderRow();
    const controller = screen.getByTestId('mode-compatibility-controller');
    expect(controller.closest('[class*="compatibilityController"]')).not.toBeNull();
  });

  it('keeps the send handler wired', () => {
    const onSend = vi.fn();
    renderRow({ onSend });
    fireEvent.click(screen.getByTestId('guid-send-btn'));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('changes work-product authority only through a real tools-menu choice', async () => {
    const onWorkProductModeChange = vi.fn();
    renderRow({ onWorkProductModeChange });
    fireEvent.click(screen.getByTestId('work-product-tools-trigger'));
    fireEvent.click(await screen.findByTestId('work-product-mode-image'));
    expect(onWorkProductModeChange).toHaveBeenCalledWith('image');
  });

  it('shows the combined MCP/plugin count in the tools menu', async () => {
    renderRow({
      skillCatalog: { ...baseProps.skillCatalog, totalCount: 2 },
      mcpServers: [{ id: 'filesystem', name: 'Filesystem', enabled: false, tools: [] }],
    });
    fireEvent.click(screen.getByTestId('work-product-tools-trigger'));
    expect(await screen.findByText('conversation.workProduct.capabilities')).toBeVisible();
    expect(screen.getByText('3')).toBeVisible();
  });

  it('uses the plus as a direct attachment action', () => {
    renderRow();
    fireEvent.click(screen.getByTestId('file-upload-btn'));
    expect(showOpen).toHaveBeenCalledWith({ properties: ['openFile', 'multiSelections'] });
  });
});
