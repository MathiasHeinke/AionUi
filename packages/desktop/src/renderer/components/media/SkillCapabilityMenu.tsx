import type { SkillCapabilityCatalog, SkillCapabilityItem } from '@/renderer/hooks/capabilities';
import { iconColors } from '@/renderer/styles/colors';
import { Checkbox, Menu } from '@arco-design/web-react';
import { Lightning } from '@renderer/components/icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

export const SKILL_CAPABILITY_MENU_POPUP_STYLE: React.CSSProperties = {
  maxHeight: 360,
  overflowY: 'auto',
  overflowX: 'hidden',
};

export const SkillCapabilityCountLabel: React.FC<{ catalog: SkillCapabilityCatalog }> = ({ catalog }) => {
  const { t } = useTranslation();
  return (
    <span data-testid='skill-capability-count'>
      {t('common.skills')} ({catalog.activeCount}/{catalog.totalCount})
    </span>
  );
};

type SkillCapabilityMenuItemsProps = {
  catalog: SkillCapabilityCatalog;
  onToggleSkill?: (skill: SkillCapabilityItem) => void;
  onInvokeSkill?: (skill: SkillCapabilityItem) => void;
};

export const SkillCapabilityMenuItems: React.FC<SkillCapabilityMenuItemsProps> = ({
  catalog,
  onToggleSkill,
  onInvokeSkill,
}) => {
  const visibleItems = catalog.mode === 'runtime' ? catalog.activeItems : catalog.items;

  return (
    <>
      {visibleItems.map((skill) =>
        catalog.mode === 'selection' ? (
          <Menu.Item
            key={`skill-${skill.name}`}
            data-testid={`skill-capability-${skill.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleSkill?.(skill);
            }}
          >
            <Checkbox
              checked={skill.active}
              onClick={(event: React.MouseEvent) => event.stopPropagation()}
              onChange={() => onToggleSkill?.(skill)}
            >
              <span className='text-13px' title={skill.description || undefined}>
                {skill.name}
              </span>
            </Checkbox>
          </Menu.Item>
        ) : (
          <Menu.Item
            key={`skill-${skill.name}`}
            data-testid={`skill-capability-${skill.name}`}
            disabled={!onInvokeSkill}
            onClick={(event) => {
              event.stopPropagation();
              onInvokeSkill?.(skill);
            }}
          >
            <span className='flex items-center gap-8px'>
              <Lightning theme='outline' size='15' strokeWidth={2.5} fill={iconColors.primary} />
              <span className='text-13px' title={skill.description || undefined}>
                {skill.name}
              </span>
            </span>
          </Menu.Item>
        )
      )}
    </>
  );
};
