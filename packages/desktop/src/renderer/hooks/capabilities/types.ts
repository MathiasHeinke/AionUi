export type SkillCapabilityMode = 'selection' | 'runtime';

export type SkillCapabilitySelection = {
  enabledSkills?: string[];
  excludedAutoInjectSkills?: string[];
};

export type SkillCapabilityItem = {
  name: string;
  description: string;
  isAutoInject: boolean;
  active: boolean;
};

export type SkillCapabilityCatalog = {
  mode: SkillCapabilityMode;
  status: 'loading' | 'ready' | 'error';
  items: SkillCapabilityItem[];
  activeItems: SkillCapabilityItem[];
  activeCount: number;
  totalCount: number;
  selection: SkillCapabilitySelection;
};

export type SkillCapabilityCatalogOptions =
  | ({ mode: 'selection' } & SkillCapabilitySelection)
  | {
      mode: 'runtime';
      activeSkills?: string[];
    };
