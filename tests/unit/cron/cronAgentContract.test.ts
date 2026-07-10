/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildCronAgentConfig,
  getBareAssistantId,
  resolveCronAgentSelectionKey,
} from '@/renderer/pages/cron/ScheduledTasksPage/cronAgentContract';
import type { ICronJob } from '@/common/adapter/ipcBridge';

describe('cronAgentContract', () => {
  it('emits only assistant-first fields accepted by strict AionCore JSON decoding', () => {
    const config = buildCronAgentConfig({
      assistantId: 'command-eve-chief-of-staff',
      name: 'Command EVE',
      mode: 'bypassPermissions',
      modelId: 'eve-model',
      configOptions: { reasoning_effort: 'high' },
      workspace: '/tmp/eve-workspace',
    });

    expect(config).toEqual({
      name: 'Command EVE',
      assistant_id: 'command-eve-chief-of-staff',
      mode: 'bypassPermissions',
      model_id: 'eve-model',
      config_options: { reasoning_effort: 'high' },
      workspace: '/tmp/eve-workspace',
    });
    expect(config).not.toHaveProperty('backend');
    expect(config).not.toHaveProperty('is_preset');
    expect(config).not.toHaveProperty('custom_agent_id');
    expect(config).not.toHaveProperty('preset_agent_type');
  });

  it('uses the nested provider model contract for AionRS jobs', () => {
    expect(
      buildCronAgentConfig({
        assistantId: getBareAssistantId('agent-aionrs'),
        name: 'Aion CLI',
        modelId: 'gpt-5.5',
        providerId: 'provider-openai',
      })
    ).toEqual({
      name: 'Aion CLI',
      assistant_id: 'bare:agent-aionrs',
      model: {
        provider_id: 'provider-openai',
        model: 'gpt-5.5',
        use_model: 'gpt-5.5',
      },
    });
  });

  it('uses the stored legacy backend instead of the first ACP catalog row', () => {
    const job = {
      metadata: {
        agent_type: 'acp',
        agent_config: { backend: 'codex' },
      },
    } as ICronJob;

    expect(
      resolveCronAgentSelectionKey(job, [
        { id: 'claude-row', agent_type: 'acp', backend: 'claude' },
        { id: 'codex-row', agent_type: 'acp', backend: 'codex' },
      ])
    ).toBe('cli:codex');
  });

  it('refuses to guess a vendor for an ambiguous legacy ACP row', () => {
    const job = {
      metadata: { agent_type: 'acp', agent_config: {} },
    } as ICronJob;

    expect(
      resolveCronAgentSelectionKey(job, [
        { id: 'claude-row', agent_type: 'acp', backend: 'claude' },
        { id: 'codex-row', agent_type: 'acp', backend: 'codex' },
      ])
    ).toBeUndefined();
  });
});
