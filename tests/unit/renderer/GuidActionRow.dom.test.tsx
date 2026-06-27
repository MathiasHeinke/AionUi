/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// t() echoes the key so labels/prefixes are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? k, i18n: { language: 'de' } }),
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
}));
vi.mock('@/renderer/utils/model/agentModes', () => ({
  supportsModeSwitch: () => true,
  createModeLabelFormatter: () => (m: { label: string }) => m.label,
}));

import GuidActionRow from '@/renderer/pages/guid/components/GuidActionRow';

const baseProps = {
  files: [] as string[],
  onFilesUploaded: vi.fn(),
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
  allSkills: [],
  disabledBuiltinSkills: [],
  enabledSkills: [],
  onToggleSkill: vi.fn(),
  mcpServers: [],
  selectedMcpServerIds: [],
  onToggleMcpServer: vi.fn(),
  loading: false,
  isButtonDisabled: false,
  onSend: vi.fn(),
};

describe('GuidActionRow (UnifiedSendBar integration)', () => {
  it('renders the file-attach, model, mic, context and send slots in the shared bar', () => {
    const onSend = vi.fn();
    render(
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
    expect(screen.getByTestId('model-node')).toBeTruthy();
    expect(screen.getByTestId('guid-mic')).toBeTruthy();
    expect(screen.getByTestId('guid-context')).toBeTruthy();
    expect(screen.getByTestId('guid-send-btn')).toBeTruthy();
  });

  it('keeps the send handler wired through the bar', () => {
    const onSend = vi.fn();
    render(<GuidActionRow {...baseProps} onSend={onSend} />);
    fireEvent.click(screen.getByTestId('guid-send-btn'));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('shows the EVE "Berechtigung" permission prefix for the EVE backend', () => {
    render(<GuidActionRow {...baseProps} effectiveModeAgent='hermes' selectedAgent='hermes' />);
    // The EVE start screen mirrors the in-chat pill prefix.
    expect(screen.getByTestId('mode-selector').textContent).toContain('agentMode.permission');
  });
});
