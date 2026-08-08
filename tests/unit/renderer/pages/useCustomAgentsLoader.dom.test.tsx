import { cleanup, renderHook, waitFor } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  listAssistants: vi.fn(),
  ensureAssistant: vi.fn(),
  refreshCustomAgents: vi.fn(),
}));

const agentMocks = vi.hoisted(() => ({
  revalidate: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      list: { invoke: bridgeMocks.listAssistants },
    },
    commandEve: {
      ensureAssistant: { invoke: bridgeMocks.ensureAssistant },
    },
    acpConversation: {
      refreshCustomAgents: { invoke: bridgeMocks.refreshCustomAgents },
    },
  },
}));

vi.mock('@/common/config/commandEveShell', () => ({
  COMMAND_EVE_ASSISTANT_ID: 'command-eve-chief-of-staff',
  COMMAND_EVE_SHELL_ENABLED: true,
}));

vi.mock('@/renderer/hooks/agent/useAgents', () => ({
  useAgents: () => ({ agents: [], revalidate: agentMocks.revalidate }),
}));

import type { Assistant } from '@/common/types/agent/assistantTypes';
import { useCustomAgentsLoader } from '@/renderer/pages/guid/hooks/useCustomAgentsLoader';

const eveAssistant = (overrides: Partial<Assistant> = {}): Assistant => ({
  id: 'command-eve-chief-of-staff',
  source: 'user',
  name: 'EVE',
  name_i18n: {},
  description_i18n: {},
  enabled: true,
  sort_order: -1000,
  preset_agent_type: 'aionrs',
  enabled_skills: ['stale-skill'],
  custom_skill_names: ['stale-skill'],
  disabled_builtin_skills: [],
  context_i18n: {},
  prompts: [],
  prompts_i18n: {},
  models: [],
  ...overrides,
});

function SwrWrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}

describe('useCustomAgentsLoader readiness merge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('merges successful readiness metadata even when enabled_skills is empty', async () => {
    bridgeMocks.listAssistants.mockResolvedValue([eveAssistant()]);
    bridgeMocks.ensureAssistant.mockResolvedValue({
      success: true,
      data: {
        status: 'ready',
        assistant_id: 'command-eve-chief-of-staff',
        preset_agent_type: 'hermes',
        agent_id: 'agent-hermes-acp',
        enabled_skills: [],
        custom_skill_names: [],
        skill_count: 0,
      },
    });

    const { result } = renderHook(() => useCustomAgentsLoader({ availableCustomAgentIds: new Set() }), {
      wrapper: SwrWrapper,
    });

    await waitFor(() => expect(result.current.assistants).toHaveLength(1));
    expect(result.current.assistants[0]).toMatchObject({
      preset_agent_type: 'hermes',
      enabled_skills: [],
      custom_skill_names: [],
    });
  });

  it('preserves the catalog record when readiness is unavailable', async () => {
    bridgeMocks.listAssistants.mockResolvedValue([eveAssistant()]);
    bridgeMocks.ensureAssistant.mockResolvedValue({ success: false });

    const { result } = renderHook(() => useCustomAgentsLoader({ availableCustomAgentIds: new Set() }), {
      wrapper: SwrWrapper,
    });

    await waitFor(() => expect(result.current.assistants).toHaveLength(1));
    expect(result.current.assistants[0]).toMatchObject({
      preset_agent_type: 'aionrs',
      enabled_skills: ['stale-skill'],
      custom_skill_names: ['stale-skill'],
    });
  });
});
