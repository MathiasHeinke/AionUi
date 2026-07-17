import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  evaluateGateDecision: vi.fn(),
  ensureAssistant: vi.fn(),
  resolveInferenceProvider: vi.fn(),
  runtimeStatus: vi.fn(),
  warmLocalModel: vi.fn(),
  conversationCreate: vi.fn(),
}));

const { configGetMock, messageErrorMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  messageErrorMock: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      evaluateGateDecision: { invoke: bridgeMocks.evaluateGateDecision },
      ensureAssistant: { invoke: bridgeMocks.ensureAssistant },
      resolveInferenceProvider: { invoke: bridgeMocks.resolveInferenceProvider },
      runtimeStatus: { invoke: bridgeMocks.runtimeStatus },
      warmLocalModel: { invoke: bridgeMocks.warmLocalModel },
    },
    conversation: {
      create: { invoke: bridgeMocks.conversationCreate },
    },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    whenReady: vi.fn().mockResolvedValue(undefined),
    get: configGetMock,
  },
}));

vi.mock('@arco-design/web-react', () => ({
  Message: {
    error: messageErrorMock,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { COMMAND_EVE_ASSISTANT_KEY } from '@/common/config/commandEveShell';
import { useGuidSend, type GuidSendDeps } from '@/renderer/pages/guid/hooks/useGuidSend';

function createDeps(): GuidSendDeps {
  return {
    input: 'Keep this draft',
    setInput: vi.fn(),
    files: ['/tmp/evidence.txt'],
    setFiles: vi.fn(),
    dir: '/tmp/customer-workspace',
    setDir: vi.fn(),
    setLoading: vi.fn(),
    loading: false,
    selectedAgent: 'acp',
    selectedAgentKey: COMMAND_EVE_ASSISTANT_KEY,
    selectedAgentInfo: {
      agent_type: 'acp',
      backend: 'acp',
      name: 'Command EVE',
      custom_agent_id: 'command-eve',
      is_preset: true,
    },
    is_presetAgent: true,
    selectedMode: 'ask',
    selectedAcpModel: null,
    currentAcpCachedModelInfo: null,
    current_model: undefined,
    findAgentByKey: vi.fn(() => ({
      id: 'hermes-runtime',
      agent_type: 'hermes',
      backend: 'hermes',
      name: 'EVE',
      cli_path: '/runtime/hermes',
    })),
    getEffectiveAgentType: vi.fn(() => ({ agent_type: 'hermes', isAvailable: true })),
    resolvePresetRulesAndSkills: vi.fn().mockResolvedValue({}),
    skillCatalog: {
      mode: 'selection',
      status: 'ready',
      items: [],
      activeItems: [],
      activeCount: 0,
      totalCount: 0,
      selection: {},
    },
    availableMcpServers: [],
    selectedMcpServerIds: [],
    currentEffectiveAgentInfo: { agent_type: 'acp', isAvailable: true },
    isGoogleAuth: false,
    setMentionOpen: vi.fn(),
    setMentionQuery: vi.fn(),
    setMentionSelectorOpen: vi.fn(),
    setMentionActiveIndex: vi.fn(),
    navigate: vi.fn(),
    t: ((key: string, fallback?: string | { defaultValue?: string }) =>
      typeof fallback === 'string' ? fallback : fallback?.defaultValue || key) as GuidSendDeps['t'],
  };
}

describe('useGuidSend blocked cloud lane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridgeMocks.evaluateGateDecision.mockResolvedValue({ success: true });
    bridgeMocks.ensureAssistant.mockResolvedValue({ success: false });
    bridgeMocks.resolveInferenceProvider.mockResolvedValue({ success: false });
    bridgeMocks.conversationCreate.mockReset();
    configGetMock.mockReturnValue(undefined);
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  });

  it('keeps the draft, files, and workspace when EVE Cloud needs activation', async () => {
    const deps = createDeps();
    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      result.current.sendMessageHandler();
    });

    await waitFor(() => expect(deps.setLoading).toHaveBeenLastCalledWith(false));
    expect(deps.setInput).not.toHaveBeenCalled();
    expect(deps.setFiles).not.toHaveBeenCalled();
    expect(deps.setDir).not.toHaveBeenCalled();
    expect(deps.setMentionOpen).not.toHaveBeenCalled();
  });

  it('shows a neutral error and preserves the draft when the EVE ACP conversation cannot be created', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'commandEve.inferenceSelection' ? 'command-eve-local:local-standard' : undefined
    );
    bridgeMocks.ensureAssistant.mockResolvedValue({
      success: true,
      data: {
        status: 'ready',
        agent_id: 'hermes-runtime',
        agent_name: 'EVE',
        cli_path: '/runtime/hermes',
        enabled_skills: [],
      },
    });
    bridgeMocks.runtimeStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'ready',
        default_model: 'command-eve-gemma4-e4b-64k:latest',
        model_warmup: {
          status: 'ready',
          model: 'command-eve-gemma4-e4b-64k:latest',
        },
      },
    });
    bridgeMocks.conversationCreate.mockResolvedValue(null);

    const deps = createDeps();
    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      result.current.sendMessageHandler();
    });

    await waitFor(() => expect(deps.setLoading).toHaveBeenLastCalledWith(false));
    expect(messageErrorMock).toHaveBeenCalledWith('Failed to create conversation');
    expect(deps.setInput).not.toHaveBeenCalled();
    expect(deps.setFiles).not.toHaveBeenCalled();
    expect(deps.setDir).not.toHaveBeenCalled();
  });

  it('hands the shared new-chat skill selection to the conversation create contract', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'commandEve.inferenceSelection' ? 'command-eve-local:local-standard' : undefined
    );
    bridgeMocks.ensureAssistant.mockResolvedValue({
      success: true,
      data: {
        status: 'ready',
        agent_id: 'hermes-runtime',
        agent_name: 'EVE',
        cli_path: '/runtime/hermes',
        enabled_skills: ['assistant-default'],
      },
    });
    bridgeMocks.runtimeStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'ready',
        default_model: 'command-eve-gemma4-e4b-64k:latest',
        model_warmup: {
          status: 'ready',
          model: 'command-eve-gemma4-e4b-64k:latest',
        },
      },
    });
    bridgeMocks.conversationCreate.mockResolvedValue({ id: 'conversation-1' });

    const deps = createDeps();
    deps.skillCatalog = {
      ...deps.skillCatalog,
      selection: {
        enabledSkills: ['optional-active'],
        excludedAutoInjectSkills: ['auto-excluded'],
      },
    };
    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    expect(bridgeMocks.conversationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({
          preset_enabled_skills: ['optional-active'],
          exclude_auto_inject_skills: ['auto-excluded'],
        }),
      })
    );
  });

  it('preserves an explicit empty ready-catalog selection instead of restoring assistant defaults', async () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'commandEve.inferenceSelection' ? 'command-eve-local:local-standard' : undefined
    );
    bridgeMocks.ensureAssistant.mockResolvedValue({
      success: true,
      data: {
        status: 'ready',
        agent_id: 'hermes-runtime',
        agent_name: 'EVE',
        cli_path: '/runtime/hermes',
        enabled_skills: ['assistant-default'],
      },
    });
    bridgeMocks.runtimeStatus.mockResolvedValue({
      success: true,
      data: {
        status: 'ready',
        default_model: 'command-eve-gemma4-e4b-64k:latest',
        model_warmup: { status: 'ready', model: 'command-eve-gemma4-e4b-64k:latest' },
      },
    });
    bridgeMocks.conversationCreate.mockResolvedValue({ id: 'conversation-1' });

    const deps = createDeps();
    deps.skillCatalog = {
      ...deps.skillCatalog,
      selection: { enabledSkills: [], excludedAutoInjectSkills: [] },
    };
    const { result } = renderHook(() => useGuidSend(deps));

    await act(async () => {
      await result.current.handleSend();
    });

    expect(bridgeMocks.conversationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        extra: expect.objectContaining({
          preset_enabled_skills: [],
          exclude_auto_inject_skills: [],
        }),
      })
    );
  });

  it.each(['loading', 'error'] as const)(
    'omits stale and readiness-derived skill selections while the catalog is %s',
    async (status) => {
      configGetMock.mockImplementation((key: string) =>
        key === 'commandEve.inferenceSelection' ? 'command-eve-local:local-standard' : undefined
      );
      bridgeMocks.ensureAssistant.mockResolvedValue({
        success: true,
        data: {
          status: 'ready',
          agent_id: 'hermes-runtime',
          agent_name: 'EVE',
          cli_path: '/runtime/hermes',
          enabled_skills: ['assistant-default'],
        },
      });
      bridgeMocks.runtimeStatus.mockResolvedValue({
        success: true,
        data: {
          status: 'ready',
          default_model: 'command-eve-gemma4-e4b-64k:latest',
          model_warmup: { status: 'ready', model: 'command-eve-gemma4-e4b-64k:latest' },
        },
      });
      bridgeMocks.conversationCreate.mockResolvedValue({ id: 'conversation-1' });

      const deps = createDeps();
      deps.skillCatalog = {
        mode: 'selection',
        status,
        items: [{ name: 'stale-skill', description: '', isAutoInject: false, active: true }],
        activeItems: [{ name: 'stale-skill', description: '', isAutoInject: false, active: true }],
        activeCount: 1,
        totalCount: 1,
        selection: {
          enabledSkills: ['stale-skill'],
          excludedAutoInjectSkills: ['stale-auto'],
        },
      };
      const { result } = renderHook(() => useGuidSend(deps));

      await act(async () => {
        await result.current.handleSend();
      });

      const createPayload = bridgeMocks.conversationCreate.mock.calls[0]?.[0];
      expect(createPayload?.extra).not.toHaveProperty('preset_enabled_skills');
      expect(createPayload?.extra).not.toHaveProperty('exclude_auto_inject_skills');
    }
  );
});
