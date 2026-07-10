import { Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import CommandEveGlyph from '@/renderer/components/commandEve/CommandEveGlyph';

const AppLoader: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className='eve-app-loader' role='status' aria-label={t('common.loading')}>
      <Spin className='eve-app-loader__spinner' icon={<CommandEveGlyph size={24} />} />
    </div>
  );
};

export default AppLoader;
