import type { RawAvailableSkill } from '@/common/adapter/skillMapper';
import { buildSkillCapabilityCatalog } from '@/renderer/hooks/capabilities';
import { describe, expect, it } from 'vitest';

const skills: RawAvailableSkill[] = [
  {
    name: 'auto-active',
    description: 'Always available unless excluded',
    location: '/skills/auto-active',
    relative_location: 'auto-inject/auto-active',
    is_custom: false,
    source: 'builtin',
  },
  {
    name: 'auto-excluded',
    description: 'Can be excluded before conversation creation',
    location: '/skills/auto-excluded',
    relative_location: 'auto-inject/auto-excluded',
    is_custom: false,
    source: 'builtin',
  },
  {
    name: 'optional-active',
    description: 'Can be enabled before conversation creation',
    location: '/skills/optional-active',
    is_custom: true,
    source: 'custom',
  },
  {
    name: 'optional-inactive',
    description: 'Not selected',
    location: '/skills/optional-inactive',
    is_custom: false,
    source: 'extension',
  },
];

describe('skill capability catalog', () => {
  it('uses one active/available count and removes selections the runtime catalog cannot apply', () => {
    const catalog = buildSkillCapabilityCatalog(skills, {
      mode: 'selection',
      enabledSkills: ['optional-active', 'missing-skill', 'auto-active'],
      excludedAutoInjectSkills: ['auto-excluded', 'missing-skill'],
    });

    expect(catalog.items.map((item) => item.name)).toEqual([
      'auto-active',
      'auto-excluded',
      'optional-active',
      'optional-inactive',
    ]);
    expect(catalog.activeItems.map((item) => item.name)).toEqual(['auto-active', 'optional-active']);
    expect({ active: catalog.activeCount, available: catalog.totalCount }).toEqual({ active: 2, available: 4 });
    expect(catalog.selection).toEqual({
      enabledSkills: ['optional-active'],
      excludedAutoInjectSkills: ['auto-excluded'],
    });
  });

  it('treats the persisted runtime snapshot as truth without claiming inactive skills are runnable', () => {
    const catalog = buildSkillCapabilityCatalog(skills, {
      mode: 'runtime',
      activeSkills: ['optional-active', 'removed-after-start'],
    });

    expect(catalog.activeItems.map((item) => item.name)).toEqual(['optional-active', 'removed-after-start']);
    expect({ active: catalog.activeCount, available: catalog.totalCount }).toEqual({ active: 2, available: 5 });
    expect(catalog.items.find((item) => item.name === 'optional-inactive')?.active).toBe(false);
  });

  it('keeps the persisted runtime snapshot usable when catalog loading fails', () => {
    const catalog = buildSkillCapabilityCatalog(
      undefined,
      { mode: 'runtime', activeSkills: ['runtime-only'] },
      'error'
    );

    expect(catalog.status).toBe('error');
    expect(catalog.activeItems.map((item) => item.name)).toEqual(['runtime-only']);
    expect({ active: catalog.activeCount, available: catalog.totalCount }).toEqual({ active: 1, available: 1 });
  });
});
