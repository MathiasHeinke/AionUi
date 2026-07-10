/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICronJob } from '@/common/adapter/ipcBridge';
import { getAgentLogo } from '@renderer/utils/model/agentLogo';
import type { AgentMetadata } from '@renderer/utils/model/agentTypes';
import {
  COMMAND_EVE_APP_NAME,
  COMMAND_EVE_ASSISTANT_AVATAR,
  COMMAND_EVE_ASSISTANT_ID,
  COMMAND_EVE_SHELL_ENABLED,
} from '@/common/config/commandEveShell';

function normalizeAgentBackend(agent: string | undefined): string | undefined {
  if (!agent) return undefined;
  return agent.replace(/^cli:/, '').replace(/^preset:/, '');
}

/**
 * Resolve the display name and logo for a cron job's agent.
 *
 * Current AionCore cron rows are assistant-first: `assistant_id` identifies a
 * preset assistant or a generated `bare:<agent-row-id>` assistant. The backend
 * derives `agent_type`; the renderer never infers execution identity from a
 * provider id.
 */
export function getJobAgentMeta(job: ICronJob, cliAgents: AgentMetadata[]): { name?: string; logo?: string | null } {
  if (COMMAND_EVE_SHELL_ENABLED) {
    return { name: COMMAND_EVE_APP_NAME, logo: COMMAND_EVE_ASSISTANT_AVATAR };
  }

  const rawType = normalizeAgentBackend(job.metadata.agent_type);
  const config = job.metadata.agent_config;
  const assistantId = config?.assistant_id;

  if (assistantId === COMMAND_EVE_ASSISTANT_ID) {
    return { name: config?.name || 'Command EVE', logo: COMMAND_EVE_ASSISTANT_AVATAR };
  }

  const bareAgentId = assistantId?.startsWith('bare:') ? assistantId.slice('bare:'.length) : undefined;
  const detected = bareAgentId
    ? cliAgents.find((agent) => agent.id === bareAgentId)
    : cliAgents.find((agent) => (agent.backend || agent.agent_type) === rawType);
  const backend = detected?.backend || detected?.agent_type || rawType;

  return {
    name: config?.name || detected?.name || rawType,
    logo: getAgentLogo(backend),
  };
}
