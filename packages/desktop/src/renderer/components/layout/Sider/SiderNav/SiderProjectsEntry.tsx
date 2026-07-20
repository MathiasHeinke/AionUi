import { Button, Tooltip } from '@arco-design/web-react';
import { FolderFocus } from '@icon-park/react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';

type SiderProjectsEntryProps = {
  isMobile: boolean;
  isActive: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onClick: () => void;
};

const SiderProjectsEntry: React.FC<SiderProjectsEntryProps> = ({
  isMobile,
  isActive,
  collapsed,
  siderTooltipProps,
  onClick,
}) => {
  const { t } = useTranslation();
  const label = t('common.projects.sider');

  return (
    <Tooltip {...siderTooltipProps} content={label} position='right'>
      <Button
        type='text'
        aria-current={isActive ? 'page' : undefined}
        aria-label={collapsed ? label : undefined}
        data-testid='sider-projects-entry'
        className={classNames(
          '!box-border !h-34px !w-full !border-none !bg-transparent !text-t-primary !rd-8px',
          collapsed
            ? '!px-0 !flex !items-center !justify-center'
            : '!px-10px !flex !items-center !justify-start !gap-8px',
          isMobile && 'sider-action-btn-mobile',
          isActive ? '!bg-fill-3' : 'hover:!bg-fill-3 active:!bg-fill-4'
        )}
        icon={<FolderFocus theme='outline' size={collapsed ? '20' : '16'} fill='currentColor' />}
        onClick={onClick}
      >
        {collapsed ? null : <span className='text-14px font-[500] leading-24px'>{label}</span>}
      </Button>
    </Tooltip>
  );
};

export default SiderProjectsEntry;
