/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import { resolveConversationMode, resolveStoredPreferredMode } from '@/renderer/pages/guid/hooks/agentSelectionUtils';
import {
  buildCliAgentParams,
  buildPresetAssistantParams,
} from '@/renderer/pages/conversation/utils/createConversationParams';
import { getAgentModes } from '@/renderer/utils/model/agentModes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configGetMock, loadPresetAssistantResourcesMock } = vi.hoisted(() => ({
  configGetMock: vi.fn(),
  loadPresetAssistantResourcesMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/common/utils/presetAssistantResources', () => ({
  loadPresetAssistantResources: loadPresetAssistantResourcesMock,
}));

vi.mock('@/renderer/hooks/agent/useAgents', () => ({
  getAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    mode: {
      listProviders: {
        invoke: vi.fn(),
      },
    },
  },
}));

describe('EVE permission authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configGetMock.mockImplementation((key: string) => {
      if (key === 'acp.config') {
        return {
          claude: { preferredMode: 'bypassPermissions' },
          hermes: { preferredMode: 'dont_ask' },
        };
      }
      return undefined;
    });
    loadPresetAssistantResourcesMock.mockResolvedValue({
      rules: '',
      enabled_skills: [],
      exclude_auto_inject_skills: [],
    });
  });

  it('makes the stored EVE preference override a stale existing-chat mode', () => {
    const modes = getAgentModes('hermes');

    expect(resolveStoredPreferredMode('hermes', modes)).toBe('dont_ask');
    expect(resolveConversationMode('hermes', 'default', modes)).toBe('dont_ask');
  });

  it('lets a REAL seat grant win, and leaves an install without one untouched', () => {
    // The seat-scoped grant is what makes "per seat" true for the EFFECTIVE mode:
    // acp.config is install-global, so without this a client seat would inherit
    // the operator's ladder. But it may only win when a grant actually EXISTS —
    // reading the fail-closed fallback here would silently drop every existing
    // install from its chosen mode to "ask" on upgrade.
    const modes = getAgentModes('hermes');
    configGetMock.mockImplementation((key: string) => {
      if (key === 'acp.config') return { hermes: { preferredMode: 'dont_ask' } };
      if (key === 'commandEve.authority') return { ladder: 1, capabilities: {}, updatedBy: 'user' };
      return undefined;
    });
    expect(resolveStoredPreferredMode('hermes', modes)).toBe('default');

    configGetMock.mockImplementation((key: string) => {
      if (key === 'acp.config') return { hermes: { preferredMode: 'dont_ask' } };
      if (key === 'commandEve.authority') return { ladder: 9, capabilities: {}, updatedBy: 'user' };
      return undefined;
    });
    // A malformed grant is not a grant: fall back, never force.
    expect(resolveStoredPreferredMode('hermes', modes)).toBe('dont_ask');
  });

  it('keeps other agents session-local even when they have a stored preference', () => {
    expect(resolveConversationMode('claude', 'default', getAgentModes('claude'))).toBe('default');
  });

  it('does not broaden foreign permission synonyms for other agents', () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'acp.config' ? { claude: { preferredMode: 'yolo' } } : undefined
    );

    expect(resolveStoredPreferredMode('claude')).toBeUndefined();
  });

  it('maps the legacy Hermes unrestricted flag to dont_ask', () => {
    configGetMock.mockImplementation((key: string) =>
      key === 'acp.config' ? { hermes: { yoloMode: true } } : undefined
    );

    expect(resolveStoredPreferredMode('hermes')).toBe('dont_ask');
  });

  it('seeds new CLI and preset EVE conversations from the same stored preference', async () => {
    const cliParams = await buildCliAgentParams(
      {
        id: 'hermes-agent',
        name: 'EVE',
        agent_type: 'acp',
        backend: 'hermes',
      } as AgentMetadata,
      '/tmp/eve-workspace'
    );
    const presetParams = await buildPresetAssistantParams(
      {
        id: 'eve-preset',
        name: 'EVE',
        preset_agent_type: 'hermes',
      } as Assistant,
      '/tmp/eve-workspace',
      'de'
    );

    expect(cliParams.extra.session_mode).toBe('dont_ask');
    expect(presetParams.extra.session_mode).toBe('dont_ask');
  });
});
