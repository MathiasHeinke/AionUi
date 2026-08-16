import React from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { configGetMock, configReadyMock, getUserMediaMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  configReadyMock: vi.fn(),
  getUserMediaMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    whenReady: configReadyMock,
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: {
    updateServer: { invoke: vi.fn() },
    toggleServer: { invoke: vi.fn() },
  },
}));

vi.mock('@/renderer/hooks/agent/useAgents', () => ({
  getAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/renderer/hooks/agent/useConfigModelListWithImage', () => ({
  default: () => ({ modelListWithImage: [] }),
}));

vi.mock('@/renderer/hooks/mcp', () => ({
  useMcpServers: () => ({
    mcpServers: [],
    extensionMcpServers: [],
    saveMcpServers: vi.fn(),
    setMcpServers: vi.fn(),
    isMcpServersLoading: false,
  }),
  useMcpConnection: () => ({
    testingServers: new Set<string>(),
    handleTestMcpConnection: vi.fn(),
    handleTestMcpConnections: vi.fn(),
  }),
  useMcpModal: () => ({
    showMcpModal: false,
    editingMcpServer: undefined,
    deleteConfirmVisible: false,
    serverToDelete: undefined,
    mcpCollapseKey: {},
    showAddMcpModal: vi.fn(),
    showEditMcpModal: vi.fn(),
    hideMcpModal: vi.fn(),
    showDeleteConfirm: vi.fn(),
    hideDeleteConfirm: vi.fn(),
    toggleServerCollapse: vi.fn(),
  }),
  useMcpServerCRUD: () => ({
    handleAddMcpServer: vi.fn(),
    handleBatchImportMcpServers: vi.fn(),
    handleEditMcpServer: vi.fn(),
    handleDeleteMcpServer: vi.fn(),
  }),
  useMcpOAuth: () => ({
    oauthStatus: {},
    loggingIn: {},
    checkOAuthStatus: vi.fn(),
    markLoginRequired: vi.fn(),
    clearLoginRequired: vi.fn(),
    login: vi.fn(),
  }),
}));

vi.mock('@/renderer/components/base/AionScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/components/base/AionSelect', () => {
  const Select = ({
    value,
    onChange,
    children,
  }: {
    value?: string;
    onChange?: (value: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value ?? ''} onChange={(event) => onChange?.(event.target.value)}>
      {children}
    </select>
  );
  Select.Option = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  );
  Select.OptGroup = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <optgroup label={label}>{children}</optgroup>
  );
  return { default: Select };
});

vi.mock('@/renderer/components/settings/SettingsSection', () => ({
  default: ({ title, action, children }: { title: string; action?: React.ReactNode; children?: React.ReactNode }) => (
    <section data-testid={`settings-section-${title}`}>
      <h2>{title}</h2>
      {action}
      {children}
    </section>
  ),
}));

vi.mock('@/renderer/pages/settings/components/AddMcpServerModal', () => ({
  default: () => null,
}));

vi.mock('@/renderer/pages/settings/ToolsSettings/McpServerItem', () => ({
  default: () => null,
}));

vi.mock('@/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'page',
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/components/icons', () => ({
  Down: () => null,
  Help: () => null,
  LinkCloud: () => null,
  Plus: () => null,
}));

vi.mock('@arco-design/web-react', () => {
  const Form = ({ children }: { children: React.ReactNode }) => <form>{children}</form>;
  Form.Item = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;

  const Input = (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />;
  Input.Password = Input;

  const Menu = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Menu.Item = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;

  return {
    Form,
    Input,
    Menu,
    Switch: ({ checked, onChange }: { checked?: boolean; onChange?: (checked: boolean) => void }) => (
      <input type='checkbox' checked={Boolean(checked)} onChange={(event) => onChange?.(event.target.checked)} />
    ),
    Message: {
      useMessage: () => [
        {
          error: vi.fn(),
          success: vi.fn(),
        },
        null,
      ],
    },
    Button: ({ children }: { children?: React.ReactNode }) => <button>{children}</button>,
    Dropdown: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Modal: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import ToolsModalContent from '@/renderer/components/settings/SettingsModal/contents/ToolsModalContent';

const speechSection = () => screen.getByTestId('settings-section-settings.speechToText');

function readSpeechSwitch(): HTMLInputElement {
  return within(speechSection()).getByRole('checkbox');
}

describe('ToolsModalContent speech-to-text readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configReadyMock.mockResolvedValue(undefined);
    configGetMock.mockReturnValue(undefined);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: getUserMediaMock },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders successful config absence as enabled local speech input with the small model', async () => {
    render(<ToolsModalContent />);

    await waitFor(() => expect(configGetMock).toHaveBeenCalledWith('tools.speechToText'));
    expect(readSpeechSwitch()).toBeChecked();
    expect(
      within(speechSection())
        .getAllByRole('combobox')
        .map((select) => (select as HTMLSelectElement).value)
    ).toEqual(['local', 'small']);
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });

  it('preserves an explicit operator disable', async () => {
    configGetMock.mockImplementation((key: string) => (key === 'tools.speechToText' ? { enabled: false } : undefined));

    render(<ToolsModalContent />);

    await waitFor(() => expect(readSpeechSwitch()).not.toBeChecked());
    expect(within(speechSection()).queryByRole('combobox')).toBeNull();
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });

  it('fails closed in the rendered settings UI when config initialization is unavailable', async () => {
    configReadyMock.mockRejectedValue(new Error('settings unavailable'));

    render(<ToolsModalContent />);

    await waitFor(() => expect(readSpeechSwitch()).not.toBeChecked());
    expect(configGetMock).not.toHaveBeenCalled();
    expect(within(speechSection()).queryByRole('combobox')).toBeNull();
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });
});
