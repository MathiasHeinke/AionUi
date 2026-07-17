import type { RawAvailableSkill } from '@/common/adapter/skillMapper';
import {
  buildSkillCapabilityCatalog,
  getSkillCapabilityCatalogKey,
  invalidateSkillCapabilityCatalog,
  isSkillCapabilityCatalogKey,
} from '@/renderer/hooks/capabilities';
import type { ScopedMutator } from 'swr';
import { describe, expect, it, vi } from 'vitest';

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
  it('marks assistant-readiness skills active and removes selections the runtime catalog cannot apply', () => {
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

  it.each(['loading', 'error'] as const)('fails closed for a new-chat selection while the catalog is %s', (status) => {
    const catalog = buildSkillCapabilityCatalog(
      status === 'error' ? skills : undefined,
      {
        mode: 'selection',
        enabledSkills: ['optional-active'],
        excludedAutoInjectSkills: ['auto-excluded'],
      },
      status
    );

    expect(catalog.selection).toEqual({});
    expect(catalog.items).toEqual([]);
    expect({ active: catalog.activeCount, available: catalog.totalCount }).toEqual({ active: 0, available: 0 });
  });

  it('keeps new-chat and running-chat capability truth aligned for the same active skills', () => {
    const newChatCatalog = buildSkillCapabilityCatalog(skills, {
      mode: 'selection',
      enabledSkills: ['optional-active'],
      excludedAutoInjectSkills: ['auto-excluded'],
    });
    const runningChatCatalog = buildSkillCapabilityCatalog(skills, {
      mode: 'runtime',
      activeSkills: newChatCatalog.activeItems.map((item) => item.name),
    });

    expect(runningChatCatalog.activeItems.map((item) => item.name)).toEqual(
      newChatCatalog.activeItems.map((item) => item.name)
    );
    expect({ active: runningChatCatalog.activeCount, available: runningChatCatalog.totalCount }).toEqual({
      active: newChatCatalog.activeCount,
      available: newChatCatalog.totalCount,
    });
  });

  it('invalidates every seat-scoped catalog without matching unrelated SWR keys', async () => {
    const mutate = vi.fn().mockResolvedValue(undefined);

    await invalidateSkillCapabilityCatalog(mutate as unknown as ScopedMutator);

    expect(mutate).toHaveBeenCalledWith(isSkillCapabilityCatalogKey);
    expect(isSkillCapabilityCatalogKey(getSkillCapabilityCatalogKey('seat-a'))).toBe(true);
    expect(isSkillCapabilityCatalogKey(getSkillCapabilityCatalogKey('seat-b'))).toBe(true);
    expect(isSkillCapabilityCatalogKey(['assistants.list', 'seat-a'])).toBe(false);
  });
});
