import { describe, expect, it } from 'vitest';
import { fromBackendAgent, fromBackendTeam, toBackendAgent } from '@/common/adapter/teamMapper';

describe('teamMapper', () => {
  it('serializes assistant-backed team agents with assistant_id and no raw backend', () => {
    const body = toBackendAgent({
      role: 'leader',
      status: 'pending',
      agent_type: 'hermes',
      agent_name: 'Leader',
      conversation_type: 'acp',
      custom_agent_id: 'command-eve-chief-of-staff',
      model: 'default',
    });

    expect(body).toEqual({
      name: 'Leader',
      role: 'lead',
      assistant_id: 'command-eve-chief-of-staff',
      model: 'default',
    });
    expect(body).not.toHaveProperty('backend');
    expect(body).not.toHaveProperty('custom_agent_id');
  });

  it('maps backend assistant_id back to the renderer custom-agent alias', () => {
    const agent = fromBackendAgent({
      slot_id: 'slot-1',
      conversation_id: 'conv-1',
      role: 'lead',
      backend: 'hermes',
      assistant_id: 'command-eve-chief-of-staff',
      name: 'Leader',
      model: 'default',
      status: 'idle',
    });

    expect(agent.custom_agent_id).toBe('command-eve-chief-of-staff');
    expect(agent.agent_type).toBe('hermes');
    expect(agent.role).toBe('leader');
  });

  it('maps the current backend assistants response shape into team agents', () => {
    const team = fromBackendTeam({
      id: 'team-1',
      name: 'Command EVE Team',
      workspace: '/tmp/team',
      leader_assistant_id: 'slot-1',
      assistants: [
        {
          slot_id: 'slot-1',
          conversation_id: 'conv-1',
          assistant_name: 'Leader',
          role: 'lead',
          backend: 'hermes',
          assistant_id: 'command-eve-chief-of-staff',
          model: 'default',
        },
      ],
    });

    expect(team.leader_agent_id).toBe('slot-1');
    expect(team.agents).toHaveLength(1);
    expect(team.agents[0]?.agent_name).toBe('Leader');
    expect(team.agents[0]?.custom_agent_id).toBe('command-eve-chief-of-staff');
  });
});
