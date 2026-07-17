import type { SkillCapabilityCatalog } from '@/renderer/hooks/capabilities';
import {
  SKILL_CAPABILITY_MENU_POPUP_STYLE,
  SkillCapabilityCountLabel,
  SkillCapabilityMenuItems,
} from '@/renderer/components/media/SkillCapabilityMenu';
import { fireEvent, render, screen } from '@testing-library/react';
import { Menu } from '@arco-design/web-react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const selectionCatalog: SkillCapabilityCatalog = {
  mode: 'selection',
  status: 'ready',
  items: [
    { name: 'active-skill', description: '', isAutoInject: true, active: true },
    { name: 'inactive-skill', description: '', isAutoInject: false, active: false },
  ],
  activeItems: [{ name: 'active-skill', description: '', isAutoInject: true, active: true }],
  activeCount: 1,
  totalCount: 2,
  selection: { enabledSkills: [], excludedAutoInjectSkills: [] },
};

describe('SkillCapabilityMenu', () => {
  it('renders the shared active/available label and toggles new-chat selections', () => {
    const onToggleSkill = vi.fn();
    render(
      <>
        <SkillCapabilityCountLabel catalog={selectionCatalog} />
        <Menu style={SKILL_CAPABILITY_MENU_POPUP_STYLE}>
          <SkillCapabilityMenuItems catalog={selectionCatalog} onToggleSkill={onToggleSkill} />
        </Menu>
      </>
    );

    expect(screen.getByTestId('skill-capability-count').textContent).toBe('common.skills (1/2)');
    expect(screen.getByTestId('skill-capability-active-skill')).toBeTruthy();
    fireEvent.click(screen.getByText('inactive-skill'));
    expect(onToggleSkill).toHaveBeenCalledWith(selectionCatalog.items[1]);
    expect(SKILL_CAPABILITY_MENU_POPUP_STYLE.maxHeight).toBe(360);
  });

  it('shows and invokes only persisted runtime-active skills in existing chats', () => {
    const onInvokeSkill = vi.fn();
    const runtimeCatalog: SkillCapabilityCatalog = {
      ...selectionCatalog,
      mode: 'runtime',
      selection: {},
    };
    render(
      <Menu>
        <SkillCapabilityMenuItems catalog={runtimeCatalog} onInvokeSkill={onInvokeSkill} />
      </Menu>
    );

    expect(screen.getByText('active-skill')).toBeTruthy();
    expect(screen.queryByText('inactive-skill')).toBeNull();
    fireEvent.click(screen.getByText('active-skill'));
    expect(onInvokeSkill).toHaveBeenCalledWith(runtimeCatalog.activeItems[0]);
  });
});
