/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * UnifiedSendBar — ONE Claude-Code-style bottom control row, shared by the start
 * screen (GuidInputCard) and the in-chat send box (AcpSendBox → SendBox).
 *
 * This is a PRESENTATIONAL slot layout, NOT a new input/model/send facade. It
 * does not own the textarea, the send handler, the draft hook, mention/@file, or
 * file-attach — each surface keeps its own machinery (their persistence backends
 * differ: the start screen seeds a pre-conversation mode into the first message's
 * `session_mode`; the in-chat lane drives `ipcBridge.acpConversation.setMode`).
 * The bar only arranges the controls so both surfaces read identically:
 *
 *   left:  [ + file ]
 *   right: [ model/inference picker · permission mode · context+credits · mic · send ]
 *
 * Every piece is passed in as a slot, so the EXISTING components are reused:
 *   - modelSlot       → EveInferencePicker (EVE) | Acp/Guid model selector (else)
 *   - micSlot         → SpeechInputButton (mounted for BOTH surfaces)
 *   - permissionSlot  → AgentModeSelector (compact, Shield, 'Berechtigung' prefix)
 *   - contextSlot     → ContextUsageIndicator (the consumed-context + credits ring)
 *   - sendSlot        → each surface's own send/stop button (wired to its textarea)
 *
 * Any slot may be omitted (e.g. the start screen has no live context frame yet, so
 * contextSlot is empty there until the first acp_context_usage arrives in-chat).
 */

import React from 'react';
import './UnifiedSendBar.css';

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
  /** Permission-mode selector (the 3 honest EVE modes; compact, Shield, prefix). */
  permissionSlot?: React.ReactNode;
  /** Context-usage + credits indicator (the consumed-context ring + popover). */
  contextSlot?: React.ReactNode;
  /** The send / stop button — owned by each surface (wired to its own textarea). */
  sendSlot?: React.ReactNode;
  /** Optional extra class on the outer row. */
  className?: string;
}

/**
 * The shared control-row layout. Pure presentation: it places the slots and owns
 * NO behaviour. Order (left → right) is the single Claude-Code-style truth both
 * surfaces render through.
 */
const UnifiedSendBar: React.FC<UnifiedSendBarProps> = ({
  leftSlot,
  centerSlot,
  modelSlot,
  micSlot,
  permissionSlot,
  contextSlot,
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

      {/* Right cluster: model · mic · permission · context · send. Stays on one
          row, never wraps under the send button. */}
      <div className='unified-send-bar__right flex items-center gap-6px flex-shrink-0 min-w-0 ml-auto'>
        {/* The config controls (model + permission) form one visual group, the
            same way the in-chat sendbox + the start-screen actionConfigGroup do. */}
        {modelSlot}
        {permissionSlot}
        {contextSlot}
        {micSlot}
        {sendSlot}
      </div>
    </div>
  );
};

export default UnifiedSendBar;
