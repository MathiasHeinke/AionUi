import classNames from 'classnames';
import React from 'react';

export interface SettingsSectionHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  titleId?: string;
  className?: string;
}

export const SettingsSectionHeader: React.FC<SettingsSectionHeaderProps> = ({
  title,
  description,
  action,
  titleId,
  className,
}) => (
  <header className={classNames('eve-settings-section-header', className)}>
    <div className='eve-settings-section-header__copy'>
      <h2 id={titleId} className='eve-settings-section-title'>
        {title}
      </h2>
      {description && <p className='eve-settings-section-description'>{description}</p>}
    </div>
    {action && <div className='eve-settings-section-header__action'>{action}</div>}
  </header>
);

export interface SettingsSectionProps extends SettingsSectionHeaderProps {
  children: React.ReactNode;
  bodyClassName?: string;
  testId?: string;
}

/** Unframed settings group with a single shared heading and optional action. */
const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  action,
  titleId,
  className,
  bodyClassName,
  testId,
  children,
}) => (
  <section className={classNames('eve-settings-group', className)} aria-labelledby={titleId} data-testid={testId}>
    <SettingsSectionHeader title={title} description={description} action={action} titleId={titleId} />
    <div className={classNames('eve-settings-section-body', bodyClassName)}>{children}</div>
  </section>
);

export default SettingsSection;
