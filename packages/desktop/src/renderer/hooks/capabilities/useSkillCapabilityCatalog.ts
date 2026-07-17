import { ipcBridge } from '@/common';
import { fromAvailableSkillsToBuiltinAutoSkills, type RawAvailableSkill } from '@/common/adapter/skillMapper';
import { useMemo } from 'react';
import useSWR, { type ScopedMutator } from 'swr';
import { useActiveSeatId } from '@/renderer/hooks/useActiveSeatId';
import type {
  SkillCapabilityCatalog,
  SkillCapabilityCatalogOptions,
  SkillCapabilityItem,
  SkillCapabilitySelection,
} from './types';

export const SKILL_CAPABILITY_CATALOG_KEY = 'skills.capability-catalog';

export const getSkillCapabilityCatalogKey = (activeSeatId: string) =>
  [SKILL_CAPABILITY_CATALOG_KEY, activeSeatId] as const;

export const isSkillCapabilityCatalogKey = (key: unknown): boolean =>
  Array.isArray(key) && key[0] === SKILL_CAPABILITY_CATALOG_KEY;

export const invalidateSkillCapabilityCatalog = (mutate: ScopedMutator) => mutate(isSkillCapabilityCatalogKey);

const uniqueNames = (names: string[] | undefined): string[] | undefined => {
  if (names === undefined) return undefined;
  return Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
};

export const buildSkillCapabilityCatalog = (
  rawSkills: RawAvailableSkill[] | undefined,
  options: SkillCapabilityCatalogOptions,
  status: SkillCapabilityCatalog['status'] = rawSkills ? 'ready' : 'loading'
): SkillCapabilityCatalog => {
  const selectionCatalogReady = options.mode === 'selection' && status === 'ready' && rawSkills !== undefined;
  const availableSkills = options.mode === 'selection' && !selectionCatalogReady ? [] : (rawSkills ?? []);
  const autoInjectNames = new Set(fromAvailableSkillsToBuiltinAutoSkills(availableSkills).map((skill) => skill.name));
  const runtimeNames = options.mode === 'runtime' ? (uniqueNames(options.activeSkills) ?? []) : [];
  const runtimeNameSet = new Set(runtimeNames);
  const availableNames = new Set(availableSkills.map((skill) => skill.name));

  const enabledSkills = options.mode === 'selection' ? uniqueNames(options.enabledSkills) : undefined;
  const excludedAutoInjectSkills =
    options.mode === 'selection' ? uniqueNames(options.excludedAutoInjectSkills) : undefined;

  // A new-chat selection is authoritative only while its install catalog is
  // ready. Loading/error states intentionally carry no hidden selection; the
  // create request can then use backend assistant defaults deterministically.
  const selection: SkillCapabilitySelection = selectionCatalogReady
    ? {
        enabledSkills: enabledSkills?.filter((name) => availableNames.has(name) && !autoInjectNames.has(name)),
        excludedAutoInjectSkills: excludedAutoInjectSkills?.filter((name) => autoInjectNames.has(name)),
      }
    : {};
  const selectedNames = new Set(selection.enabledSkills ?? []);
  const excludedNames = new Set(selection.excludedAutoInjectSkills ?? []);

  const orderedSkills = [
    ...availableSkills.filter((skill) => autoInjectNames.has(skill.name)),
    ...availableSkills.filter((skill) => !autoInjectNames.has(skill.name)),
  ];
  const seenNames = new Set<string>();
  const items: SkillCapabilityItem[] = [];

  for (const skill of orderedSkills) {
    if (seenNames.has(skill.name)) continue;
    seenNames.add(skill.name);
    const isAutoInject = autoInjectNames.has(skill.name);
    items.push({
      name: skill.name,
      description: skill.description,
      isAutoInject,
      active:
        options.mode === 'runtime'
          ? runtimeNameSet.has(skill.name)
          : isAutoInject
            ? !excludedNames.has(skill.name)
            : selectedNames.has(skill.name),
    });
  }

  // The persisted conversation snapshot is runtime truth. Keep an active skill
  // visible even when the install catalog changed after the conversation began.
  for (const name of runtimeNames) {
    if (seenNames.has(name)) continue;
    items.push({
      name,
      description: '',
      isAutoInject: false,
      active: true,
    });
  }

  const activeItems = items.filter((item) => item.active);
  return {
    mode: options.mode,
    status,
    items,
    activeItems,
    activeCount: activeItems.length,
    totalCount: items.length,
    selection,
  };
};

export const useSkillCapabilityCatalog = (options: SkillCapabilityCatalogOptions): SkillCapabilityCatalog => {
  const activeSeatId = useActiveSeatId();
  const { data, error } = useSWR<RawAvailableSkill[]>(getSkillCapabilityCatalogKey(activeSeatId), () =>
    ipcBridge.fs.listAvailableSkills.invoke()
  );

  return useMemo(
    () => buildSkillCapabilityCatalog(data, options, error ? 'error' : data ? 'ready' : 'loading'),
    [data, error, options]
  );
};
