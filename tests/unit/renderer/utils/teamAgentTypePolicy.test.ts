import { describe, expect, it } from 'vitest';

import {
  cliAgentToOption,
  filterTeamSupportedAgents,
  filterUserVisibleTeamLeaderAgents,
  resolveConversationType,
} from '@/renderer/pages/team/components/agentSelectUtils';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import {
  COMMAND_EVE_APP_NAME,
  COMMAND_EVE_ASSISTANT_AVATAR,
  COMMAND_EVE_ASSISTANT_ID,
  COMMAND_EVE_DEFAULT_ACP_BACKEND,
} from '@/common/config/commandEveShell';

describe('team agent type policy', () => {
  it('resolves every non-Aion CLI backend as ACP conversation type', () => {
    expect(resolveConversationType('aionrs')).toBe('aionrs');
    expect(resolveConversationType('claude')).toBe('acp');
    expect(resolveConversationType('gemini')).toBe('acp');
    expect(resolveConversationType('openclaw-gateway')).toBe('acp');
    expect(resolveConversationType('nanobot')).toBe('acp');
    expect(resolveConversationType('remote')).toBe('acp');
  });

  it('filters retired top-level runtime agents out of team creation options', () => {
    const options = [
      cliAgentToOption(agent('acp', 'claude')),
      cliAgentToOption(agent('aionrs')),
      cliAgentToOption(agent('openclaw-gateway')),
      cliAgentToOption(agent('nanobot')),
      cliAgentToOption(agent('remote')),
      cliAgentToOption(agent('gemini')),
    ];

    expect(filterTeamSupportedAgents(options).map((option) => option.backend)).toEqual(['claude', 'aionrs']);
  });

  it('exposes only the Command EVE assistant in the user-facing team leader list', () => {
    const options = [
      cliAgentToOption(agent('acp', 'claude')),
      cliAgentToOption(agent('acp', COMMAND_EVE_DEFAULT_ACP_BACKEND)),
      cliAgentToOption(agent('aionrs')),
      {
        id: COMMAND_EVE_ASSISTANT_ID,
        name: 'EVE',
        backend: COMMAND_EVE_DEFAULT_ACP_BACKEND,
        team_capable: true,
      },
    ];

    expect(filterUserVisibleTeamLeaderAgents(options)).toEqual([
      expect.objectContaining({
        id: COMMAND_EVE_ASSISTANT_ID,
        backend: COMMAND_EVE_DEFAULT_ACP_BACKEND,
        displayName: COMMAND_EVE_APP_NAME,
        icon: COMMAND_EVE_ASSISTANT_AVATAR,
      }),
    ]);
  });

  it('uses Hermes as a Command EVE fallback without exposing other CLI agents', () => {
    const options = [
      cliAgentToOption(agent('acp', 'claude')),
      cliAgentToOption(agent('acp', COMMAND_EVE_DEFAULT_ACP_BACKEND)),
      cliAgentToOption(agent('aionrs')),
    ];

    expect(filterUserVisibleTeamLeaderAgents(options)).toEqual([
      expect.objectContaining({
        id: COMMAND_EVE_ASSISTANT_ID,
        backend: COMMAND_EVE_DEFAULT_ACP_BACKEND,
        displayName: COMMAND_EVE_APP_NAME,
      }),
    ]);
  });

  it('keeps the EVE assistant visible while Hermes liveness detection is still pending', () => {
    const options = [
      {
        id: COMMAND_EVE_ASSISTANT_ID,
        name: 'EVE',
        backend: COMMAND_EVE_DEFAULT_ACP_BACKEND,
        team_capable: false,
      },
      cliAgentToOption(agent('acp', 'claude')),
    ];

    expect(filterUserVisibleTeamLeaderAgents(options)).toEqual([
      expect.objectContaining({
        id: COMMAND_EVE_ASSISTANT_ID,
        backend: COMMAND_EVE_DEFAULT_ACP_BACKEND,
        displayName: COMMAND_EVE_APP_NAME,
        team_capable: true,
      }),
    ]);
  });
});

function agent(agent_type: string, backend?: string): AgentMetadata {
  return {
    id: backend ?? agent_type,
    name: backend ?? agent_type,
    agent_type,
    backend,
    agent_source: 'builtin',
    team_capable: true,
  } as AgentMetadata;
}
