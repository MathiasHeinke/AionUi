import { describe, expect, it } from 'vitest';

import type { ICronJob } from '@/common/adapter/ipcBridge';
import { COMMAND_EVE_APP_NAME, COMMAND_EVE_ASSISTANT_AVATAR } from '@/common/config/commandEveShell';
import { getJobAgentMeta } from '@/renderer/pages/cron/ScheduledTasksPage/jobAgentMeta';

describe('getJobAgentMeta', () => {
  it('never exposes a raw worker identity in the Command EVE shell', () => {
    const legacyWorkerJob = {
      metadata: {
        agent_type: 'acp',
        agent_config: {
          name: 'Claude Code CLI',
          assistant_id: 'bare:claude-row',
        },
      },
    } as ICronJob;

    expect(
      getJobAgentMeta(legacyWorkerJob, [
        {
          id: 'claude-row',
          name: 'Claude Code CLI',
          agent_type: 'acp',
          backend: 'claude',
        },
      ])
    ).toEqual({
      name: COMMAND_EVE_APP_NAME,
      logo: COMMAND_EVE_ASSISTANT_AVATAR,
    });
  });
});
