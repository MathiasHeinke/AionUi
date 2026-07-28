/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import {
  savePreferredMode,
  resolveConversationMode,
  resolveStoredPreferredMode,
} from '@/renderer/pages/guid/hooks/agentSelectionUtils';
import {
  buildCliAgentParams,
  buildPresetAssistantParams,
} from '@/renderer/pages/conversation/utils/createConversationParams';
import { getAgentModes } from '@/renderer/utils/model/agentModes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configGetMock, configSetMock, loadPresetAssistantResourcesMock } = vi.hoisted(() => ({
  configSetMock: vi.fn(),
  configGetMock: vi.fn(),
  loadPresetAssistantResourcesMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    set: configSetMock,
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

  it('an in-chat restriction survives the restart it used to vanish across', async () => {
    // P1 (final integrator audit, Codex): the reader prefers the seat grant, so a
    // pill that wrote only the legacy key let a RESTRICTION disappear — pick
    // "Fragen" with a rung-3 grant, restart, and the session silently reopened at
    // dont_ask. Silent re-widening is the consent break this layer exists to stop.
    const written: Record<string, unknown> = {};
    configSetMock.mockImplementation(async (key: string, value: unknown) => {
      written[key] = value;
    });
    configGetMock.mockImplementation((key: string) => {
      if (key === 'commandEve.authority') return { ladder: 3, capabilities: {}, updatedBy: 'user' };
      if (key === 'acp.config') return { hermes: { preferredMode: 'dont_ask' } };
      return undefined;
    });

    await savePreferredMode('hermes', 'default');

    // The record the reader actually reads must carry the narrower choice.
    expect((written['commandEve.authority'] as { ladder: number }).ladder).toBe(1);
    // And NOTHING is mirrored into the install-global key — see the seat-leak
    // test below for why that mirror had to go.
    expect(written['acp.config']).toBeUndefined();
  });

  it('never lets one seat write the install-global key another seat reads', async () => {
    // P1 (Kimi, desktop review): `commandEve.authority` is seat-scoped,
    // `acp.config` is NOT. While the EVE lane mirrored its choice into the
    // global key, seat A picking "Arbeiten" handed `dont_ask` to every seat that
    // had never opened Freigaben — including a client's. The mirror is gone;
    // the only remaining global read is a value that predates 1.820.
    const written: Record<string, unknown> = {};
    configSetMock.mockImplementation(async (key: string, value: unknown) => {
      written[key] = value;
    });
    configGetMock.mockImplementation((key: string) => {
      if (key === 'commandEve.authority') return { ladder: 1, capabilities: {}, updatedBy: 'user' };
      return undefined;
    });

    // Seat A widens to the top enforced rung.
    await savePreferredMode('hermes', 'dont_ask');
    expect((written['commandEve.authority'] as { ladder: number }).ladder).toBe(3);
    expect(written['acp.config']).toBeUndefined();

    // Seat B has no grant of its own. It must not inherit seat A's choice — the
    // only thing it can see is the pre-1.820 install value, here none at all.
    configGetMock.mockImplementation(() => undefined);
    expect(resolveStoredPreferredMode('hermes', getAgentModes('hermes'))).toBeUndefined();

    // Every other backend keeps writing the global key exactly as before.
    await savePreferredMode('claude', 'bypassPermissions');
    expect((written['acp.config'] as Record<string, { preferredMode?: string }>).claude?.preferredMode).toBe(
      'bypassPermissions'
    );
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
