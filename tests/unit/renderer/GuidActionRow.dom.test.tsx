/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

// t() echoes the key so labels/prefixes are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k,
    i18n: { language: 'de' },
  }),
}));

// Layout: desktop.
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

// Heavy children mocked to simple markers so we test GuidActionRow's own layout,
// not their internals.
vi.mock('@/renderer/components/agent/AgentModeSelector', () => ({
  default: ({ compactLabelPrefix }: { compactLabelPrefix?: string }) => (
    <div data-testid='mode-selector'>{compactLabelPrefix ?? 'mode'}</div>
  ),
}));
vi.mock('@/renderer/components/agent/ContextUsageIndicator', () => ({
  default: () => <span data-testid='eve-context-ring' />,
}));
vi.mock('@/renderer/hooks/agent/useEveInferenceSelection', () => ({
  useEveInferenceSelection: () => ({ selectedItem: { group: 'local' }, cloudBearerAvailable: true }),
}));
vi.mock('@/renderer/components/workspace', () => ({
  WorkspaceContextControl: ({ workspacePath }: { workspacePath?: string }) => (
    <div data-testid='workspace-context-control'>{workspacePath}</div>
  ),
}));
vi.mock('@/renderer/pages/guid/components/PresetAgentTag', () => ({
  default: () => <div data-testid='preset-tag' />,
}));
vi.mock('@/common', () => ({ ipcBridge: { dialog: { showOpen: { invoke: vi.fn() } } } }));
vi.mock('@/renderer/services/FileService', () => ({
  getCleanFileNames: (files: string[]) => files,
  FileService: { processDroppedFiles: vi.fn() },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
// EVE backend gate — true so the permission prefix renders the EVE label.
vi.mock('@/common/config/commandEveShell', () => ({
  isCommandEveAcpConversation: (b?: string) => b === 'hermes',
  COMMAND_EVE_DEFAULT_ACP_BACKEND: 'hermes',
  // GuidActionRow reads COMMAND_EVE_SHELL_ENABLED to force the hermes backend on
  // the start screen so it shows EVE's permission modes/labels (see source).
  COMMAND_EVE_SHELL_ENABLED: true,
}));
vi.mock('@/renderer/utils/model/agentModes', () => ({
  supportsModeSwitch: () => true,
  createModeLabelFormatter: () => (m: { label: string }) => m.label,
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
  loading: false,
  isButtonDisabled: false,
  onSend: vi.fn(),
};

const renderRow = (row: React.ReactElement) => render(<MemoryRouter>{row}</MemoryRouter>);

describe('GuidActionRow (UnifiedSendBar integration)', () => {
  it('renders project, EVE control, mic and send while keeping advanced controls in the popover', async () => {
    const onSend = vi.fn();
    renderRow(
      <GuidActionRow
        {...baseProps}
        onSend={onSend}
        speechInputNode={<div data-testid='guid-mic' />}
        contextIndicatorNode={<div data-testid='guid-context' />}
      />
    );

    // The single shared bar hosts everything.
    expect(screen.getByTestId('unified-send-bar')).toBeTruthy();
    expect(screen.getByTestId('file-upload-btn')).toBeTruthy();
    expect(screen.getByTestId('workspace-context-control').textContent).toContain('Produkt-Roadmap');
    expect(screen.getByTestId('guid-mic')).toBeTruthy();
    expect(screen.queryByTestId('guid-context')).toBeNull();
    expect(screen.getByTestId('guid-send-btn')).toBeTruthy();

    // THE CONTRACT (MAT-1749): the model node used to live INSIDE the EVE
    // popover, under a "how EVE works → automatic" row. That row is deleted, and
    // in Command EVE MAX is the ONLY intelligence affordance — so a supplied
    // model node must render NOWHERE. Not in the menu, and not beside MAX on the
    // bar either: putting it there would relocate the deleted row into a more
    // prominent place rather than remove it.
    //
    // COMMAND_EVE_SHELL_ENABLED is mocked true here, so this row IS the EVE
    // branch (see the commandEveShell mock above).
    expect(screen.queryByTestId('model-node')).toBeNull();

    fireEvent.click(screen.getByTestId('eve-composer-control-trigger'));
    await screen.findByTestId('eve-composer-control-menu');
    expect(screen.queryByTestId('model-node')).toBeNull();
    expect(screen.getByTestId('mode-selector')).toBeTruthy();
  });

  it('keeps the send handler wired through the bar', () => {
    const onSend = vi.fn();
    renderRow(<GuidActionRow {...baseProps} onSend={onSend} />);
    fireEvent.click(screen.getByTestId('guid-send-btn'));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('shows the EVE "Berechtigung" permission prefix for the EVE backend', async () => {
    renderRow(<GuidActionRow {...baseProps} effectiveModeAgent='hermes' selectedAgent='hermes' />);
    fireEvent.click(screen.getByTestId('eve-composer-control-trigger'));
    // The EVE start screen mirrors the in-chat pill prefix.
    expect((await screen.findByTestId('mode-selector')).textContent).toContain('agentMode.permission');
  });

  it('uses the shared active/available skill count on the new-chat capability menu', async () => {
    renderRow(
      <GuidActionRow
        {...baseProps}
        skillCatalog={{
          mode: 'selection',
          status: 'ready',
          items: [
            { name: 'auto-skill', description: '', isAutoInject: true, active: true },
            { name: 'optional-skill', description: '', isAutoInject: false, active: false },
          ],
          activeItems: [{ name: 'auto-skill', description: '', isAutoInject: true, active: true }],
          activeCount: 1,
          totalCount: 2,
          selection: { enabledSkills: [], excludedAutoInjectSkills: [] },
        }}
      />
    );

    fireEvent.click(screen.getByTestId('file-upload-btn'));
    expect((await screen.findByTestId('skill-capability-count')).textContent).toBe('common.skills (1/2)');
  });

  it('renders the nested skill menu and forwards a new-chat toggle', async () => {
    const onToggleSkill = vi.fn();
    renderRow(
      <GuidActionRow
        {...baseProps}
        onToggleSkill={onToggleSkill}
        skillCatalog={{
          mode: 'selection',
          status: 'ready',
          items: [{ name: 'optional-skill', description: '', isAutoInject: false, active: false }],
          activeItems: [],
          activeCount: 0,
          totalCount: 1,
          selection: { enabledSkills: [], excludedAutoInjectSkills: [] },
        }}
      />
    );

    fireEvent.click(screen.getByTestId('file-upload-btn'));
    fireEvent.mouseEnter(await screen.findByTestId('skill-capability-count'));
    fireEvent.click(await screen.findByText('optional-skill'));

    expect(onToggleSkill).toHaveBeenCalledWith('optional-skill', false);
  });

  it('renders the nested MCP menu and forwards a server toggle', async () => {
    const onToggleMcpServer = vi.fn();
    renderRow(
      <GuidActionRow
        {...baseProps}
        mcpServers={[
          {
            id: 'filesystem',
            name: 'Filesystem',
            enabled: false,
            transport: { type: 'stdio', command: 'filesystem-server' },
            tools: [{ name: 'read_file', description: 'Read a file', inputSchema: {} }],
            created_at: 0,
            updated_at: 0,
            original_json: '{}',
          },
        ]}
        onToggleMcpServer={onToggleMcpServer}
      />
    );

    fireEvent.click(screen.getByTestId('file-upload-btn'));
    const mcpCount = await screen.findByText('mcp.label (0/1)');
    fireEvent.mouseEnter(mcpCount);
    fireEvent.click(await screen.findByText('Filesystem (1 mcp.tools)'));

    expect(onToggleMcpServer).toHaveBeenCalledWith('filesystem');
  });
});
