import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  evaluateGateDecision: vi.fn(),
  ensureAssistant: vi.fn(),
  resolveInferenceProvider: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      evaluateGateDecision: { invoke: bridgeMocks.evaluateGateDecision },
      ensureAssistant: { invoke: bridgeMocks.ensureAssistant },
      resolveInferenceProvider: { invoke: bridgeMocks.resolveInferenceProvider },
    },
  },
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    whenReady: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockReturnValue(undefined),
  },
}));

vi.mock('@arco-design/web-react', () => ({
  Message: {
    error: vi.fn(),
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
    findAgentByKey: vi.fn(),
    getEffectiveAgentType: vi.fn(),
    resolvePresetRulesAndSkills: vi.fn(),
    resolveEnabledSkills: vi.fn(),
    resolveDisabledBuiltinSkills: vi.fn(),
    guidDisabledBuiltinSkills: undefined,
    guidEnabledSkills: undefined,
    availableMcpServers: [],
    selectedMcpServerIds: [],
    currentEffectiveAgentInfo: { agent_type: 'acp', isAvailable: true },
    isGoogleAuth: false,
    setMentionOpen: vi.fn(),
    setMentionQuery: vi.fn(),
    setMentionSelectorOpen: vi.fn(),
    setMentionActiveIndex: vi.fn(),
    navigate: vi.fn(),
    t: ((key: string, fallback?: string) => fallback || key) as GuidSendDeps['t'],
  };
}

describe('useGuidSend blocked cloud lane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridgeMocks.evaluateGateDecision.mockResolvedValue({ success: true });
    bridgeMocks.ensureAssistant.mockResolvedValue({ success: false });
    bridgeMocks.resolveInferenceProvider.mockResolvedValue({ success: false });
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
});
