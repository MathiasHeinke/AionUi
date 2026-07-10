/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import ChannelDingTalkLogo from '@/renderer/assets/channel-logos/dingtalk.svg';
import ChannelDiscordLogo from '@/renderer/assets/channel-logos/discord.svg';
import ChannelLarkLogo from '@/renderer/assets/channel-logos/lark.svg';
import ChannelSlackLogo from '@/renderer/assets/channel-logos/slack.svg';
import ChannelTelegramLogo from '@/renderer/assets/channel-logos/telegram.svg';
import ChannelWecomLogo from '@/renderer/assets/channel-logos/wecom.svg';
import ChannelWeixinLogo from '@/renderer/assets/channel-logos/weixin.svg';
import { resolveExtensionAssetUrl } from '@/renderer/utils/platform';
import { Switch, Tag } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { ChannelConfig } from './types';

interface ChannelHeaderProps {
  channel: ChannelConfig;
  onToggleEnabled?: (enabled: boolean) => void;
}

const ChannelHeader: React.FC<ChannelHeaderProps> = ({ channel, onToggleEnabled }) => {
  const { t } = useTranslation();
  const channelLogoMap: Record<string, { src: string; alt: string }> = {
    telegram: { src: ChannelTelegramLogo, alt: 'Telegram' },
    lark: { src: ChannelLarkLogo, alt: 'Lark' },
    dingtalk: { src: ChannelDingTalkLogo, alt: 'DingTalk' },
    slack: { src: ChannelSlackLogo, alt: 'Slack' },
    discord: { src: ChannelDiscordLogo, alt: 'Discord' },
    weixin: { src: ChannelWeixinLogo, alt: 'WeChat' },
    wecom: { src: ChannelWecomLogo, alt: 'WeCom' },
  };
  const builtinLogo = channelLogoMap[channel.id];
  // Extension channels may provide a custom icon via ChannelConfig
  const logoSrc = builtinLogo?.src || resolveExtensionAssetUrl(channel.icon);
  const logoAlt = builtinLogo?.alt || channel.title;
  const isDisabled = channel.status === 'coming_soon' || channel.disabled;

  return (
    <div className='eve-channel-header' data-channel-header={channel.id}>
      <div className='eve-channel-header__identity'>
        {logoSrc && <img src={logoSrc} alt={logoAlt} className='eve-channel-header__logo' />}
        <div className='eve-channel-header__copy'>
          <div className='eve-channel-header__title-line'>
            <span className='eve-channel-header__title'>{channel.title}</span>
            {channel.status === 'coming_soon' && (
              <Tag size='small' color='gray'>
                {t('settings.channels.comingSoon', 'Coming Soon')}
              </Tag>
            )}
          </div>
          <div className='eve-channel-header__description'>{channel.description}</div>
        </div>
      </div>
      <div className='eve-channel-header__control' onClick={(e) => e.stopPropagation()}>
        <Switch
          data-channel-switch-for={channel.id}
          data-channel-switch-disabled={isDisabled ? 'true' : 'false'}
          aria-disabled={isDisabled ? 'true' : undefined}
          aria-label={t('settings.channels.enableChannel', {
            channel: channel.title,
            defaultValue: `Enable ${channel.title}`,
          })}
          checked={channel.enabled}
          onChange={onToggleEnabled}
          size='small'
          disabled={isDisabled}
        />
      </div>
    </div>
  );
};

export default ChannelHeader;
