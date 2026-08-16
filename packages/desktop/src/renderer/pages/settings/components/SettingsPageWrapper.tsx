import classNames from 'classnames';
import React from 'react';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { SettingsViewModeProvider } from '@/renderer/components/settings/SettingsModal/settingsViewContext';
import { isElectronDesktop, resolveExtensionAssetUrl } from '@/renderer/utils/platform';
import { type IExtensionSettingsTab } from '@/common/adapter/ipcBridge';
import { useExtensionSettingsTabs } from '@/renderer/hooks/system/useExtensionSettingsTabs';
import { Puzzle } from '@renderer/components/icons';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useExtI18n } from '@/renderer/hooks/system/useExtI18n';
import { getBuiltinSettingsNavigationItems, isSettingsPathActive, LEGACY_ANCHOR_REMAP } from './settingsNavigation';
import { Button } from '@arco-design/web-react';
import EveIconTile from '@/renderer/components/base/EveIconTile';
import './settings.css';

interface SettingsPageWrapperProps {
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

type NavItem = { label: string; icon: React.ReactElement; path: string; id: string };

type TranslateFn = (key: string, options?: { defaultValue?: string }) => string;

export function getBuiltinSettingsNavItems(isDesktop: boolean, t: TranslateFn): NavItem[] {
  return getBuiltinSettingsNavigationItems(isDesktop, t);
}

const SettingsPageWrapper: React.FC<SettingsPageWrapperProps> = ({ children, className, contentClassName }) => {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const isDesktop = isElectronDesktop();

  const extensionTabs = useExtensionSettingsTabs();

  const { resolveExtTabName } = useExtI18n();
  const mobileNavRef = React.useRef<HTMLDivElement>(null);
  const [mobileNavOverflow, setMobileNavOverflow] = React.useState({ before: false, after: false });

  const menuItems = React.useMemo(() => {
    const builtins = getBuiltinSettingsNavItems(isDesktop, t);

    // Insert extension tabs before system (unanchored default) or at anchor position
    const result = [...builtins];
    const unanchored: IExtensionSettingsTab[] = [];
    const beforeMap = new Map<string, IExtensionSettingsTab[]>();
    const afterMap = new Map<string, IExtensionSettingsTab[]>();

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

    const toNavItem = (tab: IExtensionSettingsTab): NavItem => {
      const resolvedIcon = resolveExtensionAssetUrl(tab.icon) || tab.icon;
      return {
        id: tab.id,
        label: resolveExtTabName(tab),
        icon: resolvedIcon ? (
          <img src={resolvedIcon} alt='' className='w-16px h-16px object-contain' />
        ) : (
          <Puzzle size='16' />
        ),
        path: `ext/${tab.id}`,
      };
    };

    for (let i = result.length - 1; i >= 0; i--) {
      const id = result[i].id;
      const afters = afterMap.get(id);
      if (afters) result.splice(i + 1, 0, ...afters.map(toNavItem));
      const befores = beforeMap.get(id);
      if (befores) result.splice(i, 0, ...befores.map(toNavItem));
    }

    if (unanchored.length > 0) {
      const sysIdx = result.findIndex((item) => item.id === 'system');
      const idx = sysIdx >= 0 ? sysIdx : result.length;
      result.splice(idx, 0, ...unanchored.map(toNavItem));
    }

    return result;
  }, [isDesktop, t, extensionTabs, resolveExtTabName]);

  const syncMobileNavOverflow = React.useCallback(() => {
    const nav = mobileNavRef.current;
    if (!nav) return;

    const maxScrollLeft = Math.max(0, nav.scrollWidth - nav.clientWidth);
    const next = {
      before: nav.scrollLeft > 2,
      after: nav.scrollLeft < maxScrollLeft - 2,
    };
    setMobileNavOverflow((current) =>
      current.before === next.before && current.after === next.after ? current : next
    );
  }, []);

  React.useLayoutEffect(() => {
    if (!isMobile) return;

    const nav = mobileNavRef.current;
    if (!nav) return;

    nav.querySelector<HTMLElement>("[aria-current='page']")?.scrollIntoView?.({
      behavior: 'auto',
      block: 'nearest',
      inline: 'center',
    });

    const frame = window.requestAnimationFrame(syncMobileNavOverflow);
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(syncMobileNavOverflow);
    resizeObserver?.observe(nav);
    window.addEventListener('resize', syncMobileNavOverflow);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', syncMobileNavOverflow);
    };
  }, [isMobile, menuItems, pathname, syncMobileNavOverflow]);

  const containerClass = classNames(
    'settings-page-wrapper eve-settings-page w-full min-h-full box-border overflow-y-auto',
    isMobile ? 'px-16px py-14px' : 'px-12px md:px-40px py-32px',
    className
  );

  const contentClass = classNames('settings-page-content mx-auto w-full md:max-w-1024px', contentClassName);

  return (
    <SettingsViewModeProvider value='page'>
      <div className={containerClass}>
        {isMobile && (
          <div
            className={classNames('settings-mobile-top-nav-shell', {
              'settings-mobile-top-nav-shell--before': mobileNavOverflow.before,
              'settings-mobile-top-nav-shell--after': mobileNavOverflow.after,
            })}
          >
            <div ref={mobileNavRef} className='settings-mobile-top-nav' onScroll={syncMobileNavOverflow}>
              {menuItems.map((item) => {
                const active = isSettingsPathActive(pathname, item.path);
                return (
                  <Button
                    key={item.path}
                    type='text'
                    size='small'
                    className={classNames('settings-mobile-top-nav__item', {
                      'settings-mobile-top-nav__item--active': active,
                    })}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      void navigate(`/settings/${item.path}`, { replace: true });
                    }}
                  >
                    <EveIconTile
                      tone={active ? 'action' : 'neutral'}
                      size='small'
                      className='settings-mobile-top-nav__icon'
                    >
                      {item.icon}
                    </EveIconTile>
                    <span className='settings-mobile-top-nav__label'>{item.label}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        )}
        <div className={contentClass}>{children}</div>
      </div>
    </SettingsViewModeProvider>
  );
};

export default SettingsPageWrapper;
