import FlexFullContainer from '@/renderer/components/layout/FlexFullContainer';
import { isElectronDesktop, resolveExtensionAssetUrl } from '@/renderer/utils/platform';
import { type IExtensionSettingsTab } from '@/common/adapter/ipcBridge';
import { useExtI18n } from '@/renderer/hooks/system/useExtI18n';
import { useExtensionSettingsTabs } from '@/renderer/hooks/system/useExtensionSettingsTabs';
import { Puzzle } from '@icon-park/react';
import classNames from 'classnames';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Tooltip } from '@arco-design/web-react';
import { getSiderTooltipProps } from '@/renderer/utils/ui/siderTooltip';
import EveIconTile from '@/renderer/components/base/EveIconTile';
import {
  BUILTIN_TAB_IDS,
  getBuiltinSettingsNavigationItems,
  isSettingsPathActive,
  LEGACY_ANCHOR_REMAP,
} from './settingsNavigation';
import './settings.css';

export { BUILTIN_TAB_IDS, isSettingsPathActive, LEGACY_ANCHOR_REMAP } from './settingsNavigation';

/**
 * Group headers displayed above specific builtin tabs.
 * The header is rendered once, immediately before the first item whose id matches.
 * Extension tabs anchored between these builtins inherit the enclosing group visually.
 */
const GROUP_HEADER_BEFORE: Record<string, string> = {
  // 1.2.18 — AI-Core group now opens above EVE-Runtime (was 'agent').
  eveRuntime: 'settings.groupAiCore',
  appearance: 'settings.groupApp',
  about: 'settings.groupAbout',
};

type SiderItem = {
  id: string;
  label: string;
  icon: React.ReactElement;
  isImageIcon?: boolean;
  /** Route path segment — for builtins: `/settings/{path}`, for extensions: `/settings/ext/{id}` */
  path: string;
};

const SettingsSider: React.FC<{ collapsed?: boolean; tooltipEnabled?: boolean }> = ({
  collapsed = false,
  tooltipEnabled = false,
}) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const isDesktop = isElectronDesktop();

  const extensionTabs = useExtensionSettingsTabs();
  const { resolveExtTabName } = useExtI18n();

  const { menus, groupHeaderAt } = useMemo(() => {
    const result: SiderItem[] = getBuiltinSettingsNavigationItems(isDesktop, t);

    // Extension tabs with position anchoring
    const beforeMap = new Map<string, IExtensionSettingsTab[]>();
    const afterMap = new Map<string, IExtensionSettingsTab[]>();
    const unanchored: IExtensionSettingsTab[] = [];

    for (const tab of extensionTabs) {
      if (!tab.position) {
        unanchored.push(tab);
        continue;
      }
      const { relativeTo: rawAnchor, placement } = tab.position;
      const anchor = LEGACY_ANCHOR_REMAP[rawAnchor] ?? rawAnchor;
      if (!result.some((item) => item.id === anchor)) {
        unanchored.push(tab);
        continue;
      }
      const map = placement === 'before' ? beforeMap : afterMap;
      let list = map.get(anchor);
      if (!list) {
        list = [];
        map.set(anchor, list);
      }
      list.push(tab);
    }

    // Helper to create SiderItem from extension tab
    const toSiderItem = (tab: IExtensionSettingsTab): SiderItem => {
      const resolvedIcon = resolveExtensionAssetUrl(tab.icon) || tab.icon;
      return {
        id: tab.id,
        label: resolveExtTabName(tab),
        icon: resolvedIcon ? <img src={resolvedIcon} alt='' className='w-full h-full object-contain' /> : <Puzzle />,
        isImageIcon: Boolean(resolvedIcon),
        path: `ext/${tab.id}`,
      };
    };

    // Insert anchored tabs (reverse iteration to preserve indices)
    for (let i = result.length - 1; i >= 0; i--) {
      const builtinId = result[i].id;
      const afters = afterMap.get(builtinId);
      if (afters) {
        result.splice(i + 1, 0, ...afters.map(toSiderItem));
      }
      const befores = beforeMap.get(builtinId);
      if (befores) {
        result.splice(i, 0, ...befores.map(toSiderItem));
      }
    }

    // Append unanchored before "system"
    if (unanchored.length > 0) {
      const systemIdx = result.findIndex((item) => item.id === 'system');
      const insertIdx = systemIdx >= 0 ? systemIdx : result.length;
      result.splice(insertIdx, 0, ...unanchored.map(toSiderItem));
    }

    // Compute group header render positions.
    //
    // A header must appear before the first *visible* item of its group, which may
    // be an extension tab anchored with placement='before' to the group's first
    // builtin — not the builtin itself. Otherwise such an extension would render
    // above the header and visually belong to the previous group.
    const headerAt = new Map<number, string>();
    for (const [builtinId, headerKey] of Object.entries(GROUP_HEADER_BEFORE)) {
      const builtinIdx = result.findIndex((item) => item.id === builtinId);
      if (builtinIdx < 0) continue;
      const beforeCount = beforeMap.get(builtinId)?.length ?? 0;
      headerAt.set(builtinIdx - beforeCount, headerKey);
    }

    return { menus: result, groupHeaderAt: headerAt };
  }, [t, isDesktop, extensionTabs, resolveExtTabName]);

  const siderTooltipProps = getSiderTooltipProps(tooltipEnabled);
  return (
    <div
      className={classNames('h-full settings-sider flex flex-col gap-2px overflow-y-auto overflow-x-hidden', {
        'settings-sider--collapsed': collapsed,
      })}
    >
      {menus.map((item, index) => {
        const isSelected = isSettingsPathActive(pathname, item.path);
        const groupHeaderKey = groupHeaderAt.get(index);
        const groupHeader =
          groupHeaderKey && !collapsed ? (
            <div className='settings-sider__group-header px-12px mt-8px h-28px flex items-center text-14px font-[500] text-t-tertiary select-none'>
              {t(groupHeaderKey)}
            </div>
          ) : null;
        return (
          <React.Fragment key={item.id}>
            {groupHeader}
            <Tooltip {...siderTooltipProps} content={item.label} position='right'>
              <button
                type='button'
                data-settings-id={item.id}
                data-settings-path={item.path}
                aria-current={isSelected ? 'page' : undefined}
                className={classNames(
                  'settings-sider__item eve-row eve-focus-ring h-42px flex items-center gap-10px group cursor-pointer relative overflow-hidden shrink-0 border-0 bg-transparent text-left [&+.settings-sider__item]:mt-2px',
                  collapsed ? 'w-full justify-center px-0' : 'justify-start px-10px',
                  { 'eve-row--selected': isSelected }
                )}
                onClick={() => {
                  Promise.resolve(navigate(`/settings/${item.path}`, { replace: true })).catch((error) => {
                    console.error('Navigation failed:', error);
                  });
                }}
              >
                <EveIconTile
                  tone={isSelected ? 'action' : 'neutral'}
                  size='small'
                  className='settings-sider__icon-tile'
                >
                  {item.isImageIcon ? (
                    <span className='w-16px h-16px flex items-center justify-center'>{item.icon}</span>
                  ) : (
                    <span className='settings-sider__icon-glyph'>{item.icon}</span>
                  )}
                </EveIconTile>
                <FlexFullContainer className='h-24px collapsed-hidden'>
                  <div className='settings-sider__item-label text-nowrap overflow-hidden inline-block w-full text-14px font-[500] lh-24px whitespace-nowrap text-t-primary'>
                    {item.label}
                  </div>
                </FlexFullContainer>
              </button>
            </Tooltip>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default SettingsSider;
