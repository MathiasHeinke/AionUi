/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import type { AcpSessionConfigOption } from '@/common/types/platform/acpTypes';
import { savePreferredMode } from '@/renderer/pages/guid/hooks/agentSelectionUtils';
import { getAgentModes, resolveModeForBackend, supportsModeSwitch, type AgentModeOption } from '@/renderer/utils/model/agentModes';
import { emitter } from '@/renderer/utils/emitter';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { AgentLogoIcon } from './AgentBadge';
import { Button, Dropdown, Menu, Message } from '@arco-design/web-react';
import { Down } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MarqueePillLabel from './MarqueePillLabel';

/**
 * Extract mode options from cached ACP config_options.
 * Looks for a select-type option with category === 'mode' and converts
 * its choices to AgentModeOption[] format.
 */
function extractModesFromConfigOptions(config_options: AcpSessionConfigOption[]): AgentModeOption[] {
  const modeOption = config_options.find((opt) => opt.category === 'mode' && opt.type === 'select' && opt.options);
  if (!modeOption?.options || modeOption.options.length === 0) return [];
  return modeOption.options.map((opt) => ({
    value: opt.value,
    label: opt.name || opt.label || opt.value,
  }));
}

export interface AgentModeSelectorProps {
  /** Agent backend type / 代理后端类型 */
  backend?: string;
  /** Display name for the agent / 代理显示名称 */
  agent_name?: string;
  /** Custom agent logo (SVG path or emoji) / 自定义代理 logo */
  agentLogo?: string;
  /** Whether the logo is an emoji / logo 是否为 emoji */
  agentLogoIsEmoji?: boolean;
  /** Conversation ID for mode switching / 用于切换模式的会话 ID */
  conversation_id?: string;
  /** Compact mode: only show mode label + dropdown, no logo/name / 紧凑模式：仅显示模式标签和下拉 */
  compact?: boolean;
  /** Show agent logo in compact mode / 紧凑模式是否显示代理图标 */
  showLogoInCompact?: boolean;
  /** Compact label content: mode label or agent name / 紧凑模式文案：模式名或代理名 */
  compactLabelType?: 'mode' | 'agent';
  /** Initial mode override (for Guid page pre-conversation selection) */
  initialMode?: string;
  /** Callback when mode is selected locally (no conversation_id needed) */
  onModeSelect?: (mode: string) => void;
  /** Optional compact label override */
  compactLabelOverride?: string;
  /** Optional compact leading icon */
  compactLeadingIcon?: React.ReactNode;
  /** Optional display label formatter for mode options */
  modeLabelFormatter?: (mode: AgentModeOption) => string;
  /** Optional compact prefix text, e.g. "Permission" / "权限" */
  compactLabelPrefix?: string;
  /** Hide compact prefix on mobile */
  hideCompactLabelPrefixOnMobile?: boolean;
  /** Callback fired after a successful mode change (for team-mode propagation) */
  onModeChanged?: (mode: string) => void;
  /** Dynamic modes from capabilities (overrides static list when non-empty) */
  dynamicModes?: AgentModeOption[];
  /** Optional runtime preparation before reading active-session mode. */
  beforeRuntimeSync?: () => Promise<void>;
}

/**
 * AgentModeSelector - A dropdown component for switching agent modes
 * Displays agent logo and name, with dropdown menu for mode selection
 *
 * 代理模式选择器 - 用于切换代理模式的下拉组件
 * 显示代理 logo 和名称，通过下拉菜单选择模式
 */
const AgentModeSelector: React.FC<AgentModeSelectorProps> = ({
  backend,
  agent_name,
  agentLogo,
  agentLogoIsEmoji,
  conversation_id,
  compact,
  showLogoInCompact = false,
  compactLabelType = 'mode',
  initialMode,
  onModeSelect,
  compactLabelOverride,
  compactLeadingIcon,
  modeLabelFormatter,
  compactLabelPrefix,
  hideCompactLabelPrefixOnMobile = false,
  onModeChanged,
  dynamicModes,
  beforeRuntimeSync,
}) => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const isMobile = Boolean(layout?.isMobile);
  const [cachedModes, setCachedModes] = useState<AgentModeOption[]>([]);

  // Load modes from cache: try top-level `acp.cachedModes` first (qoder, opencode),
  // then fall back to `acp.cached_config_options` category=mode (codex)
  useEffect(() => {
    if (!backend) return;

    const cachedModes = configService.get('acp.cachedModes');
    const session_modes = cachedModes?.[backend];
    if (session_modes?.available_modes && session_modes.available_modes.length > 0) {
      setCachedModes(
        session_modes.available_modes.map((m) => ({
          value: m.id,
          label: m.name ?? m.id,
        }))
      );
      return;
    }

    const cached = configService.get('acp.cached_config_options');
    const options = cached?.[backend];
    if (Array.isArray(options)) {
      const modes = extractModesFromConfigOptions(options as AcpSessionConfigOption[]);
      if (modes.length > 0) {
        setCachedModes(modes);
      }
    }
  }, [backend]);

  // Priority: dynamicModes (runtime) > cachedModes (from cache) > getAgentModes (static fallback)
  const modes = useMemo(() => {
    if (dynamicModes && dynamicModes.length > 0) return dynamicModes;
    if (cachedModes.length > 0) return cachedModes;
    return getAgentModes(backend);
  }, [dynamicModes, cachedModes, backend]);
  const defaultMode = modes[0]?.value ?? 'default';
  // Validate initialMode against available modes; fall back to backend's default
  // when the provided value doesn't match (e.g. opencode has 'build'/'plan', not 'default').
  // resolveModeForBackend ALSO maps cross-backend synonyms (e.g. a saved
  // session_mode 'yolo' → hermes' equivalent 'dont_ask'), which is the real fix for
  // "YOLO set in the start view resets to Standard in the chat" — the start screen
  // stored 'yolo' but hermes only knows default/accept_edits/dont_ask, so the plain
  // some()-match snapped it back to the default.
  const validInitialMode = resolveModeForBackend(initialMode, modes) ?? defaultMode;
  const [current_mode, setCurrentMode] = useState<string>(validInitialMode);
  const [isLoading, setIsLoading] = useState(false);
  const [dropdownVisible, setDropdownVisible] = useState(false);
  // Once the user picks a mode in THIS conversation, neither the initialMode
  // re-sync nor the passive backend getMode-sync may overwrite it. This is the
  // core fix for "the in-session permission selector resets to Standard and
  // locks": the start-view choice (carried as session_mode → initialMode) used
  // to be silently overwritten by the backend's bare `default` once the agent
  // warmed, and every modes/dynamicModes change snapped current_mode back. The
  // ref is reset per conversation so switching tabs re-enables the sync.
  const userSelectedModeRef = useRef(false);
  // Remember the initialMode we last applied so the prop-change effect fires
  // ONLY on a genuine initialMode change (agent switch / new session_mode), not
  // on every `modes` array identity change.
  const appliedInitialModeRef = useRef<string | undefined>(initialMode);
  // Backend session mode is never seeded from session_mode (warmup calls no
  // setMode), so getMode authoritatively returns 'default' and the pick is lost.
  // Seed it ONCE per conversation from a non-default initialMode; this ref makes
  // the push idempotent so an SWR/getMode re-run can't double-fire it.
  const seededBackendModeRef = useRef(false);
  const getDisplayModeLabel = useCallback(
    (mode: AgentModeOption) => modeLabelFormatter?.(mode) ?? mode.label,
    [modeLabelFormatter]
  );

  const can_switchMode = (supportsModeSwitch(backend) || modes.length > 0) && (conversation_id || onModeSelect);
  // Mobile conversation header agent pill is display-only by design.
  const canInteract = can_switchMode && !(compact && compactLabelType === 'agent');

  // A new conversation tab OR a backend (agent) switch re-enables both syncs —
  // the user's selection guard is scoped to one conversation/agent context.
  // Reset so the incoming context's initialMode/getMode can seed the pill
  // without a stale lock. Keyed ONLY on conversation_id + backend; re-seeding on
  // every `modes` identity change is exactly the bug that snapped a user pick
  // back, so `modes`/`initialMode` are deliberately excluded here.
  useEffect(() => {
    userSelectedModeRef.current = false;
    appliedInitialModeRef.current = initialMode;
    // Re-arm the one-shot backend seed for the incoming conversation/agent.
    seededBackendModeRef.current = false;
    // Use resolveModeForBackend (not a bare some()-match) so a cross-backend
    // synonym like 'yolo' resolves to hermes' 'dont_ask' instead of snapping to
    // the default — this effect re-runs on every conversation/backend switch and
    // was silently RE-OVERRIDING the line-146 seed back to Standard.
    setCurrentMode(resolveModeForBackend(initialMode, modes) ?? defaultMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation_id, backend]);

  // When initialMode prop GENUINELY changes (e.g. agent switch on the Guid start
  // screen, or a new persisted session_mode), update local state — UNLESS the
  // user has already made an explicit pick in this conversation. Guarded against
  // `modes`-identity churn by comparing to the last applied initialMode.
  useEffect(() => {
    if (initialMode === undefined) return;
    if (initialMode === appliedInitialModeRef.current) return;
    appliedInitialModeRef.current = initialMode;
    if (userSelectedModeRef.current) return;
    const valid = resolveModeForBackend(initialMode, modes) ?? defaultMode;
    setCurrentMode(valid);
  }, [initialMode, modes, defaultMode]);

  // Sync mode from backend when mounting or switching conversation tabs.
  // This is a PASSIVE read used to reflect the backend's live mode — it must
  // never override the user's explicit in-session pick, and it must not
  // downgrade a valid non-default selection (the start-view choice carried via
  // session_mode) to the backend's bare `default` before that choice has been
  // pushed. Those two rules are the fix for the reset-and-lock report.
  useEffect(() => {
    if (!conversation_id || !can_switchMode) return;
    let cancelled = false;

    void (async () => {
      await beforeRuntimeSync?.();
      return ipcBridge.acpConversation.getMode.invoke({ conversation_id });
    })()
      .then((result) => {
        if (cancelled || !result) return;
        // The user's explicit pick wins, always.
        if (userSelectedModeRef.current) return;
        // Before the manager is initialized, getMode returns
        // { mode: 'default', initialized: false } — never adopt that.
        if (result.initialized === false) return;
        const backendMode = result.mode;
        const initialIsNonDefault =
          initialMode !== undefined && initialMode !== defaultMode && modes.some((m) => m.value === initialMode);
        // ROOT FIX: the backend session mode is never seeded from session_mode,
        // so a non-default start-view pick reads back here as bare `default`.
        // Push the pick to the backend ONCE so the real session mode matches the
        // selector, then adopt initialMode as authoritative instead of `default`.
        if (backendMode === defaultMode && initialIsNonDefault && !seededBackendModeRef.current && initialMode) {
          seededBackendModeRef.current = true;
          setCurrentMode(initialMode);
          void ipcBridge.acpConversation.setMode.invoke({ conversation_id, mode: initialMode }).catch(() => {
            // Seeding is best-effort; the selector already shows initialMode and
            // an explicit in-session pick will re-issue setMode authoritatively.
          });
          return;
        }
        // Even if the one-shot seed already ran, never downgrade a deliberately
        // non-default initialMode to a stale backend `default`.
        if (backendMode === defaultMode && initialIsNonDefault) return;
        // Only adopt a backend mode that is actually a known mode for this
        // backend (guards against a stale/foreign value rendering blank).
        if (modes.some((m) => m.value === backendMode)) {
          setCurrentMode(backendMode);
        }
      })
      .catch(() => {
        // Silent fail, keep current state
      });

    return () => {
      cancelled = true;
    };
  }, [conversation_id, can_switchMode, beforeRuntimeSync, defaultMode, initialMode, modes]);

  // Broadcast the effective permission mode for THIS conversation so the ACP
  // message handler's auto-approve path stays in lockstep with the pill. This is
  // the load-bearing signal for the YOLO/"Nicht fragen" fix: the backend has no
  // live /mode route (it 404s), so the desktop honors the mode itself, and the
  // request_permission handler reads the mode from this broadcast. Fires on the
  // initial resolved mode and on every change (sync or user pick). No-op without a
  // conversation_id (the Guid start screen has no live conversation to gate yet).
  useEffect(() => {
    if (!conversation_id) return;
    emitter.emit('acp.permission.mode', { conversation_id, mode: current_mode });
  }, [conversation_id, current_mode]);

  const handleModeChange = useCallback(
    async (mode: string) => {
      // Close dropdown immediately after selection
      setDropdownVisible(false);

      if (mode === current_mode) return;

      // The user has now explicitly chosen — no passive sync may override it.
      userSelectedModeRef.current = true;

      // Local mode (Guid page): update state and notify parent, no IPC needed
      if (!conversation_id && onModeSelect) {
        setCurrentMode(mode);
        onModeSelect(mode);
        onModeChanged?.(mode);
        return;
      }

      if (!conversation_id) return;

      // OPTIMISTIC: reflect the pick in the UI immediately. The backend /mode PUT is
      // BEST-EFFORT — the bundled runtime 404s it (the mode lives on the conversation's
      // session_mode, there is no live /mode route), and the OLD code only set
      // current_mode AFTER a successful setMode, so a 404 reverted the switch → exactly
      // the "Umschalten in der Session geht nicht" the founder reported. We must keep the
      // user's pick regardless of the network result.
      setCurrentMode(mode);
      onModeChanged?.(mode);
      if (backend) {
        // Mirror Guid-page behaviour: an in-session switch becomes the next default.
        void savePreferredMode(backend, mode);
      }
      setIsLoading(true);
      try {
        await beforeRuntimeSync?.();
        const confirmed = await ipcBridge.acpConversation.setMode.invoke({ conversation_id, mode });
        // Only correct course if the backend authoritatively confirms a DIFFERENT mode.
        const confirmedMode = confirmed?.mode;
        if (confirmedMode && confirmedMode !== mode && modes.some((m) => m.value === confirmedMode)) {
          setCurrentMode(confirmedMode);
          onModeChanged?.(confirmedMode);
        }
      } catch (error) {
        // best-effort: a missing /mode route must NOT undo the visible switch.
        console.warn('[AgentModeSelector] setMode best-effort (kept local pick):', error);
      } finally {
        setIsLoading(false);
      }
    },
    [backend, beforeRuntimeSync, conversation_id, current_mode, onModeChanged, onModeSelect, t]
  );

  const renderLogo = () => (
    <AgentLogoIcon
      backend={backend}
      agent_name={agent_name}
      agentLogo={agentLogo}
      agentLogoIsEmoji={agentLogoIsEmoji}
    />
  );

  // Get display label for current mode
  const getCurrentModeLabel = () => {
    const modeOption = modes.find((m) => m.value === current_mode);
    return modeOption ? getDisplayModeLabel(modeOption) : '';
  };

  // Dropdown menu (shared between compact and full mode)
  const dropdownMenu = (
    <Menu onClickMenuItem={(key) => void handleModeChange(key)}>
      <Menu.ItemGroup title={t('agentMode.switchMode', { defaultValue: 'Switch Mode' })}>
        {modes.map((mode: AgentModeOption) => (
          <Menu.Item key={mode.value} className={current_mode === mode.value ? '!bg-2' : ''}>
            <div
              className='flex items-center gap-8px'
              data-mode-value={mode.value}
              data-testid={`aionrs-mode-option-${mode.value}`}
            >
              {current_mode === mode.value && <span className='text-primary'>✓</span>}
              <span className={current_mode !== mode.value ? 'ml-16px' : ''}>{getDisplayModeLabel(mode)}</span>
            </div>
          </Menu.Item>
        ))}
      </Menu.ItemGroup>
    </Menu>
  );

  // Compact mode: render only mode label chip in sendbox area
  if (compact) {
    const legacyCompactBehavior = !showLogoInCompact && compactLabelType === 'mode';
    const baseCompactLabel =
      compactLabelType === 'agent'
        ? agent_name || backend || 'Agent'
        : can_switchMode
          ? getCurrentModeLabel()
          : agent_name || backend || 'Agent';
    // The compact chat-bar pill drops the "Berechtigung · " prefix: the 🛡 shield
    // icon already signals "permission", and the founder wants it short + identical
    // in the start view and in-session (e.g. "Auto-Edits", not the long
    // "Berechtigung · Änderungen übernehmen"). compactLabelPrefix is kept in the
    // condition so non-EVE callers can still opt back in via compactLabelOverride.
    const compactLabel =
      compactLabelOverride ||
      (compactLabelPrefix && compactLabelType !== 'agent' ? baseCompactLabel : baseCompactLabel);
    if (!canInteract && legacyCompactBehavior) {
      return null;
    }

    // Single trigger element. When interactive it becomes the Arco Dropdown
    // child directly — NO wrapping <span> and NO manual onClick that toggles
    // visibility. A controlled `popupVisible` plus the Button's own toggle was
    // a double-toggle: Arco's trigger opened the popup and the Button's onClick
    // immediately flipped it back, so a click appeared to do nothing and the
    // founder could never switch the permission mode. We now mirror the proven
    // EveInferencePicker pattern: let `trigger='click'` own open/close and gate
    // opening with `disabled` while a switch is in flight.
    const compactTrigger = (
      <Button
        data-testid={backend ? `agent-mode-selector-${backend}` : 'agent-mode-selector'}
        className={`sendbox-model-btn agent-mode-compact-pill ${canInteract ? '' : 'agent-mode-compact-pill--readonly'}`}
        shape='round'
        size='small'
        style={{
          opacity: isLoading ? 0.6 : 1,
          transition: 'opacity 0.2s',
          cursor: canInteract ? 'pointer' : 'default',
        }}
      >
        <span className='flex items-center gap-6px min-w-0 leading-none'>
          {compactLeadingIcon && <span className='shrink-0 inline-flex items-center'>{compactLeadingIcon}</span>}
          {showLogoInCompact && <span className='shrink-0 inline-flex items-center'>{renderLogo()}</span>}
          <MarqueePillLabel>{compactLabel}</MarqueePillLabel>
          {canInteract && <Down size={12} className='text-t-tertiary shrink-0' />}
        </span>
      </Button>
    );

    if (!canInteract) {
      return (
        <span data-testid='mode-selector' data-current-mode={current_mode} className='inline-flex'>
          {compactTrigger}
        </span>
      );
    }

    return (
      <span data-testid='mode-selector' data-current-mode={current_mode} className='inline-flex'>
        <Dropdown trigger='click' position='bl' disabled={isLoading} droplist={dropdownMenu}>
          {compactTrigger}
        </Dropdown>
      </span>
    );
  }

  // Full mode: logo + name + optional mode label
  const content = (
    <div
      className={`flex items-center gap-2 bg-2 w-fit rounded-full px-[8px] py-[2px] ${can_switchMode ? 'cursor-pointer hover:bg-3' : ''}`}
      style={{ opacity: isLoading ? 0.6 : 1, transition: 'opacity 0.2s' }}
    >
      {renderLogo()}
      <span className='text-sm text-t-primary'>{agent_name || backend}</span>
      {can_switchMode && (
        <>
          {current_mode !== defaultMode && <span className='text-xs text-t-tertiary'>({getCurrentModeLabel()})</span>}
          <Down size={12} className='text-t-tertiary' />
        </>
      )}
    </div>
  );

  // If mode switching is not supported, just render the content without dropdown
  if (!can_switchMode) {
    return <div className='ml-16px'>{content}</div>;
  }

  // Render dropdown with mode selection menu
  return (
    <div className='ml-16px'>
      <Dropdown
        trigger='click'
        popupVisible={dropdownVisible}
        onVisibleChange={(visible) => !isLoading && setDropdownVisible(visible)}
        droplist={dropdownMenu}
      >
        {content}
      </Dropdown>
    </div>
  );
};

export default AgentModeSelector;
