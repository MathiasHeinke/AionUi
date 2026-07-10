/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICronAgentConfig, ICronJob } from '@/common/adapter/ipcBridge';

export type BuildCronAgentConfigInput = {
  assistantId: string;
  name: string;
  mode?: string;
  modelId?: string;
  providerId?: string;
  configOptions?: Record<string, string>;
  workspace?: string;
};

/**
 * Build the strict AionCore 0.1.37 cron-agent wire contract.
 *
 * The backend denies unknown fields. Keep this whitelist separate from UI
 * state so legacy keys such as backend/custom_agent_id cannot leak back into
 * POST/PUT payloads.
 */
export function buildCronAgentConfig(input: BuildCronAgentConfigInput): ICronAgentConfig {
  const config: ICronAgentConfig = {
    name: input.name,
    assistant_id: input.assistantId,
  };

  if (input.mode) config.mode = input.mode;
  if (input.configOptions && Object.keys(input.configOptions).length > 0) {
    config.config_options = input.configOptions;
  }
  if (input.workspace) config.workspace = input.workspace;

  if (input.providerId && input.modelId) {
    config.model = {
      provider_id: input.providerId,
      model: input.modelId,
      use_model: input.modelId,
    };
  } else if (input.modelId) {
    config.model_id = input.modelId;
  }

  return config;
}

export function getBareAssistantId(agentId: string): string {
  return `bare:${agentId}`;
}

type CronCliAgentIdentity = {
  id?: string;
  backend?: string;
  agent_type: string;
};

type LegacyCronAgentConfig = ICronAgentConfig & {
  backend?: string;
  custom_agent_id?: string;
};

/**
 * Recover the selected agent from current assistant-first rows and legacy cron
 * rows without guessing an ACP vendor. A bare `agent_type: "acp"` is
 * intentionally unresolved: choosing the first ACP catalog row could silently
 * move a saved job from one execution engine to another on edit.
 */
export function resolveCronAgentSelectionKey(job: ICronJob, cliAgents: CronCliAgentIdentity[]): string | undefined {
  const config = job.metadata.agent_config as LegacyCronAgentConfig | undefined;
  const assistantId = config?.assistant_id;

  if (assistantId?.startsWith('bare:')) {
    const bareAgentId = assistantId.slice('bare:'.length);
    const matched = cliAgents.find((agent) => agent.id === bareAgentId);
    return matched ? `cli:${matched.backend || matched.agent_type}` : undefined;
  }
  if (assistantId) return `preset:${assistantId}`;
  if (config?.custom_agent_id) return `preset:${config.custom_agent_id}`;
  if (config?.backend) return `cli:${config.backend}`;

  const rawType = job.metadata.agent_type?.replace(/^cli:/, '');
  return rawType && rawType !== 'acp' ? `cli:${rawType}` : undefined;
}
