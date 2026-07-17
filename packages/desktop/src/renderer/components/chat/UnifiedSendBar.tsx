/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UnifiedSendBar — the shared Command EVE composer control row used by the
 * start screen and active conversations.
 *
 * This is a PRESENTATIONAL slot layout, NOT a new input/model/send facade. It
 * does not own the textarea, the send handler, the draft hook, mention/@file, or
 * file-attach — each surface keeps its own machinery (their persistence backends
 * differ: the start screen seeds a pre-conversation mode into the first message's
 * `session_mode`; the in-chat lane drives `ipcBridge.acpConversation.setMode`).
 * The bar arranges the controls so both surfaces read identically:
 *
 *   left:  [ + file ]
 *   right: [ EVE control · mic · send ]
 *
 * Every piece is passed in as a slot, so the EXISTING components are reused:
 * EVE combines inference, privacy, permission/tools and context into one
 * progressive-disclosure control. Non-EVE surfaces retain their direct slots.
 *   - micSlot         → SpeechInputButton (mounted for BOTH surfaces)
 *   - busyModeSlot    → queue/correction mode while EVE is already working
 *   - permissionSlot  → AgentModeSelector (compact, Shield, 'Berechtigung' prefix)
 *   - contextSlot     → ContextUsageIndicator (the consumed-context + credits ring)
 *   - sendSlot        → each surface's own send/stop button (wired to its textarea)
 *
 * Any slot may be omitted (e.g. the start screen has no live context frame yet, so
 * contextSlot is empty there until the first acp_context_usage arrives in-chat).
 */

import type { TokenUsageData } from '@/common/config/storage';
import CommandEveGlyph from '@/renderer/components/commandEve/CommandEveGlyph';
import ContextUsageIndicator from '@/renderer/components/agent/ContextUsageIndicator';
import { useEveInferenceSelection } from '@/renderer/hooks/agent/useEveInferenceSelection';
import { resolveEffectiveContextLimit } from '@/renderer/utils/model/modelContextLimits';
import { Button, Popover } from '@arco-design/web-react';
import { Layers, Right, SettingTwo, Shield, Tool } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import './UnifiedSendBar.css';

export type EveComposerControlConfig = {
  tokenUsage: TokenUsageData | null;
  contextLimit?: number;
  modelId?: string;
  disabled?: boolean;
};

export interface UnifiedSendBarProps {
  /** Left cluster — the [+ file] attach control. */
  leftSlot?: React.ReactNode;
  /**
   * Optional center passthrough (e.g. a preset-agent tag). The textarea and file
   * previews stay in the parent input card above this row; this is only for any
   * inline center control a surface wants between the left and right clusters.
   */
  centerSlot?: React.ReactNode;
  /** Model / inference picker (EveInferencePicker for EVE, Acp/Guid selector otherwise). */
  modelSlot?: React.ReactNode;
  /** Microphone — the shared SpeechInputButton, mounted for BOTH surfaces. */
  micSlot?: React.ReactNode;
  /** Queue/correction mode shown only while the current turn is running. */
  busyModeSlot?: React.ReactNode;
  /** Permission-mode selector (the 3 honest EVE modes; compact, Shield, prefix). */
  permissionSlot?: React.ReactNode;
  /** Context-usage + credits indicator (the consumed-context ring + popover). */
  contextSlot?: React.ReactNode;
  /** Consolidate model, privacy, tools and context behind one EVE control. */
  eveControl?: EveComposerControlConfig;
  /** The send / stop button — owned by each surface (wired to its own textarea). */
  sendSlot?: React.ReactNode;
  /** Optional extra class on the outer row. */
  className?: string;
}

/**
 * The single non-technical EVE control. Existing model and permission selectors
 * stay mounted inside the popover, preserving their real persistence and runtime
 * behavior while removing infrastructure jargon from the default composer.
 */
const EveComposerControl: React.FC<{
  config: EveComposerControlConfig;
  modelSlot?: React.ReactNode;
  permissionSlot?: React.ReactNode;
}> = ({ config, modelSlot, permissionSlot }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [popoverVisible, setPopoverVisible] = useState(false);
  const { selectedItem, cloudBearerAvailable } = useEveInferenceSelection();
  const effectiveLimit = resolveEffectiveContextLimit(config.modelId, config.contextLimit);
  const percentage = useMemo(() => {
    if (!config.tokenUsage || effectiveLimit <= 0) return null;
    return Math.max(0, Math.min(100, (config.tokenUsage.total_tokens / effectiveLimit) * 100));
  }, [config.tokenUsage, effectiveLimit]);

  const privacySummary =
    selectedItem?.group === 'local'
      ? t('conversation.eveControl.local')
      : cloudBearerAvailable === false
        ? t('conversation.eveInference.needsActivation')
        : t('conversation.eveControl.cloud');
  const contextSummary =
    percentage === null
      ? t('conversation.eveControl.contextReady')
      : t('conversation.eveControl.contextPercent', { percent: Math.round(percentage) });

  const content = (
    <div className='eve-composer-control__menu' data-testid='eve-composer-control-menu'>
      <div className='eve-composer-control__row'>
        <SettingTwo size={17} aria-hidden='true' />
        <span className='eve-composer-control__label'>{t('conversation.eveControl.howEveWorks')}</span>
        <span className='eve-composer-control__value'>{modelSlot ?? t('conversation.eveControl.automatic')}</span>
      </div>

      <Button
        type='text'
        className='eve-composer-control__row eve-composer-control__row--button'
        onClick={() => void navigate('/settings/privacy')}
      >
        <Shield size={17} aria-hidden='true' />
        <span className='eve-composer-control__label'>{t('conversation.eveControl.privacy')}</span>
        <span className='eve-composer-control__value'>{privacySummary}</span>
        <Right size={13} aria-hidden='true' />
      </Button>

      <div className='eve-composer-control__row'>
        <Tool size={17} aria-hidden='true' />
        <span className='eve-composer-control__label'>{t('conversation.eveControl.tools')}</span>
        <span className='eve-composer-control__value'>{permissionSlot ?? t('conversation.eveControl.automatic')}</span>
      </div>

      <div className='eve-composer-control__row'>
        <Layers size={17} aria-hidden='true' />
        <span className='eve-composer-control__label'>{t('conversation.eveControl.context')}</span>
        <span className='eve-composer-control__value'>{contextSummary}</span>
      </div>

      <Button
        type='text'
        className='eve-composer-control__advanced'
        onClick={() => void navigate('/settings/eve-runtime')}
      >
        {t('conversation.eveControl.advancedSettings')}
      </Button>
    </div>
  );

  return (
    <Popover
      content={content}
      position='top'
      trigger='click'
      className='eve-composer-control-popover'
      popupVisible={popoverVisible}
      onVisibleChange={setPopoverVisible}
    >
      <Button
        type='text'
        shape='circle'
        className='eve-composer-control__trigger'
        disabled={config.disabled}
        aria-label={t('conversation.eveControl.open')}
        aria-haspopup='menu'
        aria-expanded={popoverVisible}
        data-testid='eve-composer-control-trigger'
      >
        <span className='eve-composer-control__trigger-visual' aria-hidden='true'>
          {config.tokenUsage ? (
            <ContextUsageIndicator
              tokenUsage={config.tokenUsage}
              context_limit={config.contextLimit}
              modelId={config.modelId}
              className='eve-composer-control__ring'
              size={30}
              showDetails={false}
            />
          ) : null}
          <CommandEveGlyph size={17} />
        </span>
      </Button>
    </Popover>
  );
};

const UnifiedSendBar: React.FC<UnifiedSendBarProps> = ({
  leftSlot,
  centerSlot,
  modelSlot,
  micSlot,
  busyModeSlot,
  permissionSlot,
  contextSlot,
  eveControl,
  sendSlot,
  className,
}) => {
  return (
    <div
      className={`unified-send-bar flex items-center justify-between w-full gap-8px ${className ?? ''}`}
      data-testid='unified-send-bar'
    >
      {/* Left cluster: [+ file]. flex-shrink so a long preset tag can compress it. */}
      <div className='unified-send-bar__left inline-flex items-center gap-6px flex-shrink min-w-0'>
        {leftSlot}
        {centerSlot}
      </div>

      {/* Right cluster: EVE control · mic · send. Stays on one
          row, never wraps under the send button. */}
      <div className='unified-send-bar__right flex items-center gap-6px flex-shrink-0 min-w-0 ml-auto'>
        {busyModeSlot ? <div className='unified-send-bar__busy-slot'>{busyModeSlot}</div> : null}
        {eveControl ? (
          <EveComposerControl config={eveControl} modelSlot={modelSlot} permissionSlot={permissionSlot} />
        ) : (
          <>
            {modelSlot}
            {permissionSlot}
            {contextSlot}
          </>
        )}
        {micSlot}
        {sendSlot}
      </div>
    </div>
  );
};

export default UnifiedSendBar;
