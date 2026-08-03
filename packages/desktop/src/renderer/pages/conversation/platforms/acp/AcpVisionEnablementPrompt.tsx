/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1769 — the ONE-TIME in-chat Vision enablement prompt.
 *
 * Renders INSIDE the composer's draft band (SendBox `prefix`), never as an
 * overlay or modal: it cannot intercept keyboard input, it cannot delay an
 * unrelated send, and it appears only when a send actually hit the disabled
 * cloud-visual policy wall with an image attached.
 *
 * The contract this card carries:
 *
 *   - the copy discloses the CLOUD consequences BEFORE enablement: the
 *     destination class (managed cloud vision provider), the credit effect
 *     (cloud vision analysis costs credits per image) and the privacy effect
 *     (a downscaled preview of the image bytes leaves the device). A LOCAL
 *     vision lane would need none of this warning — this composer currently
 *     offers only the managed cloud lane, so the warning is unconditional;
 *   - the two actions are exactly "Vision aktivieren" / "Nicht jetzt", and
 *     either answer is the one-time decision: accept persists the seat policy
 *     through Main (`cloudVisualPolicySet`), decline persists the per-seat
 *     `commandEve.visionEnablementDeclined` marker. No confirmation ever
 *     appears before an already-decided image send;
 *   - no OS permission is requested: the flow uploads bytes the user already
 *     granted through file selection, which requires no screen-recording,
 *     accessibility or media-library permission on any supported platform.
 *
 * AAA: the card is a labelled `group` (not a modal dialog), focus moves to the
 * accept action when it appears and returns to the previously focused element
 * (the composer textarea) when it leaves, Escape answers "Nicht jetzt", and
 * the card has no animation at all, so reduced-motion users see the same
 * static surface.
 */
import { Button } from '@arco-design/web-react';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export type AcpVisionEnablementPromptProps = {
  /** True while the accept path persists the policy and re-drives the pending send. */
  busy: boolean;
  onAccept: () => void;
  onDecline: () => void;
};

const DESCRIPTION_ID = 'acp-vision-enablement-description';

const AcpVisionEnablementPrompt: React.FC<AcpVisionEnablementPromptProps> = ({ busy, onAccept, onDecline }) => {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<Element | null>(null);

  // Focus management: on appear, move focus to the accept action so keyboard
  // and VoiceOver users land on the decision; on dismiss, hand focus back to
  // whatever had it before (the composer textarea in practice). Queried from
  // the DOM rather than a Button ref so the behaviour is identical with the
  // real Arco button and with a plain-button test double.
  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    rootRef.current?.querySelector<HTMLButtonElement>('[data-vision-accept]')?.focus();
    return () => {
      const target = returnFocusRef.current;
      if (target instanceof HTMLElement && target.isConnected) {
        target.focus();
      }
    };
  }, []);

  const title = t('conversation.visual.enablement.title');
  const confirmText = t('conversation.visual.enablement.confirm');
  const declineText = t('conversation.visual.enablement.decline');

  return (
    <div
      ref={rootRef}
      className='acp-vision-enablement'
      role='group'
      aria-label={title}
      aria-describedby={DESCRIPTION_ID}
      data-eve-interaction-role='event-boundary'
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.stopPropagation();
          onDecline();
        }
      }}
    >
      <div className='acp-vision-enablement__title'>{title}</div>
      <p className='acp-vision-enablement__description' id={DESCRIPTION_ID}>
        {t('conversation.visual.enablement.description')}
      </p>
      <div className='acp-vision-enablement__actions'>
        <Button
          type='primary'
          size='small'
          data-vision-accept
          disabled={busy}
          aria-label={confirmText}
          onClick={onAccept}
        >
          {confirmText}
        </Button>
        <Button size='small' data-vision-decline disabled={busy} aria-label={declineText} onClick={onDecline}>
          {declineText}
        </Button>
      </div>
    </div>
  );
};

export default AcpVisionEnablementPrompt;
