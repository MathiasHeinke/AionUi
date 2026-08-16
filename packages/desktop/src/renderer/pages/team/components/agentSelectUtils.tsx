import React from 'react';
import { Robot } from '@renderer/components/icons';
import { getAgentLogo } from '@renderer/utils/model/agentLogo';
import { CUSTOM_AVATAR_IMAGE_MAP } from '@renderer/pages/guid/constants';
import type { AgentMetadata } from '@renderer/utils/model/agentTypes';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import {
  COMMAND_EVE_APP_NAME,
  COMMAND_EVE_ASSISTANT_AVATAR,
  COMMAND_EVE_ASSISTANT_ID,
  COMMAND_EVE_DEFAULT_ACP_BACKEND,
} from '@/common/config/commandEveShell';
import { resolveBackendAssetUrl } from '@renderer/utils/platform';
import {
  isDeprecatedRuntimeAgentType,
  resolveSupportedConversationType,
} from '@/renderer/utils/model/agentTypeSupportPolicy';

/**
 * Team leader selector entry — unified view over CLI agents and preset
 * assistants. Both sources share the dropdown but have different native
 * shapes; this type is what the dropdown code actually reads.
 */
export type TeamAgentOption = {
  id: string;
  name: string;
  /** Execution backend (claude, gemini, qwen, …). For assistants this is
   *  `preset_agent_type`; for CLI agents it's `backend`. */
  backend?: string;
  /** Top-level runtime type from detected agents. Preset assistants leave this unset. */
  agent_type?: string;
  /** Icon / avatar token — an SVG filename, emoji, or key into
   *  `CUSTOM_AVATAR_IMAGE_MAP`. */
  icon?: string;
  /** User-facing label when a raw backend is intentionally masked behind a product surface. */
  displayName?: string;
  /** Whether this agent supports team mode. Sourced from backend `team_capable` field. */
  team_capable?: boolean;
};

export function cliAgentToOption(agent: AgentMetadata): TeamAgentOption {
  return {
    id: agent.id,
    name: agent.name,
    backend: agent.backend || agent.agent_type,
    agent_type: agent.agent_type,
    icon: agent.icon,
    team_capable: agent.team_capable,
  };
}

export function assistantToOption(assistant: Assistant, teamCapableKeys?: Set<string>): TeamAgentOption {
  return {
    id: assistant.id,
    name: assistant.name,
    backend: assistant.preset_agent_type,
    icon: assistant.avatar,
    team_capable: teamCapableKeys ? teamCapableKeys.has(assistant.preset_agent_type) : undefined,
  };
}

export function agentKey(agent: TeamAgentOption): string {
  return agent.id;
}

export function agentFromKey(key: string, allAgents: TeamAgentOption[]): TeamAgentOption | undefined {
  return allAgents.find((a) => agentKey(a) === key);
}

export function resolveTeamAgentType(agent: TeamAgentOption | undefined, fallback: string): string {
  return agent?.backend || fallback;
}

/** Filter agents to only those supported in team mode */
export function filterTeamSupportedAgents(agents: TeamAgentOption[]): TeamAgentOption[] {
  return agents.filter((a) => a.team_capable && !isDeprecatedRuntimeAgentType(a.agent_type));
}

function asCommandEveTeamLeader(agent: TeamAgentOption): TeamAgentOption {
  return {
    ...agent,
    id: COMMAND_EVE_ASSISTANT_ID,
    displayName: COMMAND_EVE_APP_NAME,
    icon: COMMAND_EVE_ASSISTANT_AVATAR,
  };
}

function isCommandEveAssistant(agent: TeamAgentOption): boolean {
  return agent.id === COMMAND_EVE_ASSISTANT_ID;
}

function isHermesCommandEveBackend(agent: TeamAgentOption): boolean {
  return agent.backend === COMMAND_EVE_DEFAULT_ACP_BACKEND || agent.id === COMMAND_EVE_DEFAULT_ACP_BACKEND;
}

export function filterUserVisibleTeamLeaderAgents(agents: TeamAgentOption[]): TeamAgentOption[] {
  // EVE's assistant bootstrap binds durably to Hermes even while the runtime's
  // liveness entry is still starting. Do not hide the only public team leader
  // during that transient detection window.
  const commandEveAssistant = agents.find(isCommandEveAssistant);
  if (commandEveAssistant && !isDeprecatedRuntimeAgentType(commandEveAssistant.agent_type)) {
    return [asCommandEveTeamLeader({ ...commandEveAssistant, team_capable: true })];
  }

  const supported = filterTeamSupportedAgents(agents);
  const hermesFallback = supported.find(isHermesCommandEveBackend);
  return hermesFallback ? [asCommandEveTeamLeader(hermesFallback)] : [];
}

export function resolveConversationType(backend: string): 'acp' | 'aionrs' {
  return resolveSupportedConversationType(backend);
}

export const AgentOptionLabel: React.FC<{ agent: TeamAgentOption }> = ({ agent }) => {
  const label = agent.displayName || agent.name;
  const logo = getAgentLogo(agent.backend);
  const avatarImage = agent.icon ? CUSTOM_AVATAR_IMAGE_MAP[agent.icon] : undefined;
  const directIcon =
    agent.icon &&
    !avatarImage &&
    (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(agent.icon) || /\.(svg|png|jpe?g|gif|webp)$/i.test(agent.icon))
      ? (resolveBackendAssetUrl(agent.icon) ?? agent.icon)
      : undefined;
  const isEmoji = Boolean(agent.icon && !avatarImage && !directIcon);
  return (
    <div className='flex items-center gap-8px'>
      {avatarImage ? (
        <img src={avatarImage} alt={label} style={{ width: 16, height: 16, objectFit: 'contain' }} />
      ) : isEmoji ? (
        <span style={{ fontSize: 14, lineHeight: '16px' }}>{agent.icon}</span>
      ) : directIcon ? (
        <img src={directIcon} alt={label} style={{ width: 16, height: 16, objectFit: 'contain' }} />
      ) : logo ? (
        <img src={logo} alt={label} style={{ width: 16, height: 16, objectFit: 'contain' }} />
      ) : (
        <Robot size='16' />
      )}
      <span>{label}</span>
    </div>
  );
};
