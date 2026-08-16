/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TokenUsageData } from '@/common/config/storage';
import { configService } from '@/common/config/configService';
import type { EveLadderRung } from '@/common/config/eveAuthorityCore';
import { ENFORCED_LADDER_RUNGS, resolveStoredGrant, withLadder } from '@/common/config/eveAuthorityStoreCore';
import ContextCreditsPopover from '@/renderer/components/agent/ContextCreditsPopover';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { COMPOSER_MENU_TRIGGER_PROPS } from '@/renderer/utils/ui/composerMenuMotion';
import { resolveEffectiveContextLimit } from '@/renderer/utils/model/modelContextLimits';
import { Button, Dropdown, Menu, Popover } from '@arco-design/web-react';
import { Check, Down, Shield } from '@renderer/components/icons';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './ComposerContextDeck.module.css';

const RUNG_KEYS: Record<EveLadderRung, string> = {
  0: 'watch',
  1: 'ask',
  2: 'routine',
  3: 'work',
  4: 'independent',
  5: 'full',
};

const RUNG_SHORT_KEYS: Record<EveLadderRung, string> = {
  0: 'watch',
  1: 'ask',
  2: 'routine',
  3: 'work',
  4: 'auto',
  5: 'full',
};

export const ComposerAuthorityControl: React.FC<{ disabled?: boolean }> = ({ disabled = false }) => {
  const { t } = useTranslation();
  const [storedGrant, setStoredGrant] = useConfig('commandEve.authority');
  const [legacyAcpConfig] = useConfig('acp.config');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void configService.whenReady().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const grant = useMemo(() => resolveStoredGrant(storedGrant, legacyAcpConfig), [legacyAcpConfig, storedGrant]);
  const label = ready
    ? t(`conversation.composerDeck.authorityShort.${RUNG_SHORT_KEYS[grant.ladder]}`)
    : t('common.loading');

  const menu = (
    <Menu
      className={styles.authorityMenu}
      selectedKeys={[String(grant.ladder)]}
      onClickMenuItem={(key) => {
        const rung = Number(key) as EveLadderRung;
        if (!ENFORCED_LADDER_RUNGS.includes(rung)) return;
        void setStoredGrant(withLadder(grant, rung));
      }}
    >
      {ENFORCED_LADDER_RUNGS.map((rung) => (
        <Menu.Item key={String(rung)}>
          <span className={styles.authorityMenuItem}>
            <span className={styles.authorityMenuCopy}>
              <span className={styles.authorityMenuTitle}>
                {t(`commandEve.authority.rung.${RUNG_KEYS[rung]}.title`)}
              </span>
              <span className={styles.authorityMenuBody}>{t(`commandEve.authority.rung.${RUNG_KEYS[rung]}.body`)}</span>
            </span>
            {grant.ladder === rung ? <Check size={14} aria-hidden='true' /> : null}
          </span>
        </Menu.Item>
      ))}
    </Menu>
  );

  return (
    <Dropdown
      trigger='click'
      position='bl'
      droplist={menu}
      disabled={disabled}
      triggerProps={COMPOSER_MENU_TRIGGER_PROPS}
    >
      <Button
        type='text'
        className={styles.authorityButton}
        disabled={disabled || !ready}
        aria-label={t('conversation.composerDeck.authorityLabel', { level: label })}
        data-testid='composer-authority-control'
        data-rung={grant.ladder}
      >
        <Shield size={15} aria-hidden='true' />
        <span>{label}</span>
        <Down size={11} aria-hidden='true' />
      </Button>
    </Dropdown>
  );
};

export type ComposerContextDeckProps = Readonly<{
  projectSlot: React.ReactNode;
  maxSlot?: React.ReactNode;
  tokenUsage: TokenUsageData | null;
  contextLimit?: number;
  modelId?: string;
  disabled?: boolean;
}>;

const ComposerContextDeck: React.FC<ComposerContextDeckProps> = ({
  projectSlot,
  maxSlot,
  tokenUsage,
  contextLimit,
  modelId,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const effectiveLimit = resolveEffectiveContextLimit(modelId, contextLimit);
  const percentage = tokenUsage
    ? Math.max(0, Math.min(100, (tokenUsage.total_tokens / Math.max(1, effectiveLimit)) * 100))
    : null;
  const rounded = percentage === null ? null : Math.round(percentage);
  const contextLabel =
    rounded === null
      ? t('conversation.composerDeck.contextPercent', { percent: 0 })
      : t('conversation.composerDeck.contextPercent', { percent: rounded });
  const level =
    percentage !== null && percentage > 90 ? 'danger' : percentage !== null && percentage > 70 ? 'warning' : 'normal';
  const progress = `${percentage ?? 0}%`;

  return (
    <div className={`${styles.deck} unified-send-bar`} data-testid='composer-context-deck'>
      <div className={styles.leftCompound}>
        <div className={styles.projectSlot}>{projectSlot}</div>
        <span className={styles.divider} aria-hidden='true' />
        <ComposerAuthorityControl disabled={disabled} />
      </div>

      <div className={styles.rightCompound}>
        {maxSlot ? <div className={styles.maxSlot}>{maxSlot}</div> : null}
        <Popover
          content={<ContextCreditsPopover tokenUsage={tokenUsage} contextLimit={contextLimit} modelId={modelId} />}
          position='top'
          trigger='click'
          className='context-usage-popover'
        >
          <button
            type='button'
            className={styles.contextMeter}
            style={{ '--eve-context-progress': progress } as React.CSSProperties}
            data-level={level}
            data-testid='composer-context-meter'
            aria-label={t('conversation.composerDeck.contextOpen', { value: contextLabel })}
          >
            <span className={styles.contextFill} aria-hidden='true' />
            <span className={styles.contextLabel}>{contextLabel}</span>
          </button>
        </Popover>
      </div>
    </div>
  );
};

export default ComposerContextDeck;
