import { describe, expect, it } from 'vitest';
import { fromAvailableSkillsToBuiltinAutoSkills } from '@/common/adapter/skillMapper';

describe('skillMapper', () => {
  it('derives auto-injected builtins from the canonical skill catalog', () => {
    expect(
      fromAvailableSkillsToBuiltinAutoSkills([
        {
          name: 'cron',
          description: 'Schedule work',
          location: '/tmp/builtin-skills/auto-inject/cron/SKILL.md',
          relative_location: 'auto-inject/cron/SKILL.md',
          is_custom: false,
          source: 'builtin',
        },
        {
          name: 'mermaid',
          description: 'Render diagrams',
          location: '/tmp/builtin-skills/mermaid/SKILL.md',
          relative_location: 'mermaid/SKILL.md',
          is_custom: false,
          source: 'builtin',
        },
        {
          name: 'custom-cron',
          description: 'User skill',
          location: '/tmp/user-skills/custom-cron/SKILL.md',
          relative_location: 'auto-inject/custom-cron/SKILL.md',
          is_custom: true,
          source: 'custom',
        },
      ])
    ).toEqual([
      {
        name: 'cron',
        description: 'Schedule work',
        location: 'auto-inject/cron/SKILL.md',
      },
    ]);
  });

  it('ignores malformed builtin rows without a relative location', () => {
    expect(
      fromAvailableSkillsToBuiltinAutoSkills([
        {
          name: 'broken',
          description: 'Missing relative path',
          location: '/tmp/builtin-skills/broken/SKILL.md',
          is_custom: false,
          source: 'builtin',
        },
      ])
    ).toEqual([]);
  });
});
