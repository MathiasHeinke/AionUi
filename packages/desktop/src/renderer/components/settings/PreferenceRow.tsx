import classNames from 'classnames';
import React from 'react';
import { Switch } from '@arco-design/web-react';

export interface PreferenceRowProps {
  label: React.ReactNode;
  children: React.ReactNode;
  description?: React.ReactNode;
  extra?: React.ReactNode;
  testId?: string;
  className?: string;
  controlClassName?: string;
  stackOnMobile?: boolean;
}

/** Shared settings row: readable copy on the left, one direct control on the right. */
const PreferenceRow: React.FC<PreferenceRowProps> = ({
  label,
  children,
  description,
  extra,
  testId,
  className,
  controlClassName,
  stackOnMobile = false,
}) => {
  const labelId = React.useId();
  const switchControl = React.isValidElement<Record<string, unknown>>(children) && children.type === Switch;
  const hasExplicitAccessibleName =
    switchControl && Boolean(children.props['aria-label'] || children.props['aria-labelledby']);
  const control =
    switchControl && !hasExplicitAccessibleName
      ? React.cloneElement(children, { 'aria-labelledby': labelId })
      : children;

  return (
    <div
      className={classNames(
        'eve-settings-preference-row',
        stackOnMobile && 'eve-settings-preference-row--stack-mobile',
        className
      )}
      data-testid={testId}
    >
      <div className='eve-settings-preference-row__copy'>
        <div className='eve-settings-preference-row__label-line'>
          <div id={labelId} className='eve-settings-preference-row__label'>
            {label}
          </div>
          {extra}
        </div>
        {description && <div className='eve-settings-preference-row__description'>{description}</div>}
      </div>
      <div className={classNames('eve-settings-preference-row__control', controlClassName)}>{control}</div>
    </div>
  );
};

export default PreferenceRow;
