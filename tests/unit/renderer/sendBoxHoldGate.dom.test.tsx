/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `disabled` MUST HOLD THE SEND — from the button AND from the keyboard.
 *
 * SendBox has always documented that "the SEND action stays gated by `disabled`"
 * (see `keepInputEditableWhenDisabled`), and the button honoured it. The Enter key
 * did not: `onKeyDown → sendMessageHandler` never consulted `disabled`, so a
 * composer the product had deliberately held could still submit from the
 * keyboard. That gap is invisible until something real depends on the hold — and
 * the EVE MAX entitlement hold does: an unverified seat must not be able to fire
 * a paid turn, and "the mouse is blocked" is not a hold.
 *
 * THIS FILE STANDS UP THE REAL SendBox. Every other suite mocks
 * `components/chat/SendBox` away (AcpSendBox.dom, AionrsSendBox.dom), which is
 * exactly why `sendBoxFailureVisibility.test.ts` had to fall back to a source
 * contract. Only the component's ambient CONTEXTS are supplied here; the send
 * path itself is the shipped one, so a regression in the guard is a red test
 * rather than a re-read of the file.
 *
 * NAMING: `.dom.test.tsx` — the `node` project takes `*.test.ts` only and excludes
 * `*.dom.test.*`; the `dom` project takes ONLY `*.dom.test.ts(x)`.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'de-DE' },
  }),
}));

// The ambient contexts SendBox consumes. None of them is on the path under test;
// they exist so the real component can mount outside a full conversation shell.
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    setSendBoxHandler: vi.fn(),
    domSnippets: [],
    removeDomSnippet: vi.fn(),
    clearDomSnippets: vi.fn(),
  }),
}));
vi.mock('@/renderer/pages/team/hooks/TeamPermissionContext', () => ({
  useTeamPermission: () => ({ isLeaderInTeam: false, permission: null }),
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({ useConversationContextSafe: () => null }));
vi.mock('@renderer/pages/conversation/Messages/hooks', () => ({ useMessageList: () => [] }));

import SendBox from '@/renderer/components/chat/SendBox';

const DRAFT = 'Bitte fasse den Vertrag zusammen';

/**
 * `allowSendWhileLoading` mirrors the EVE composer (AcpSendBox passes it), which
 * is what keeps the textarea editable while `disabled` gates only the SEND.
 */
function renderSendBox(disabled: boolean, onSend: ReturnType<typeof vi.fn>) {
  const view = render(
    <SendBox value={DRAFT} onChange={() => undefined} onSend={onSend} disabled={disabled} allowSendWhileLoading />
  );
  return {
    unmount: view.unmount,
    button: (): HTMLElement => screen.getByTestId('sendbox-send-btn'),
    textarea: (): HTMLElement => screen.getByTestId('sendbox-input'),
  };
}

describe('SendBox — a held composer cannot submit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSITIVE CONTROL: without the hold, the BUTTON sends', () => {
    // Without this, every assertion below could pass on a composer that simply
    // never sends — the classic vacuous green.
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { button } = renderSendBox(false, onSend);

    expect(button()).not.toBeDisabled();
    fireEvent.click(button());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(DRAFT);
  });

  it('POSITIVE CONTROL: without the hold, ENTER sends', () => {
    // A fresh mount, because the first send leaves the composer in its in-flight
    // state and the second submit would be refused for an unrelated reason.
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { textarea } = renderSendBox(false, onSend);

    fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith(DRAFT);
  });

  it('HELD: the button is disabled AND the Enter key is refused', () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { button, textarea } = renderSendBox(true, onSend);

    expect(button()).toBeDisabled();
    fireEvent.click(button());
    expect(onSend, 'the button submitted a held composer').not.toHaveBeenCalled();

    // THE GAP THIS CLOSES. Enter bypassed `disabled` entirely, so the hold was
    // decorative: the user pressed Return and the turn went out anyway.
    fireEvent.keyDown(textarea(), { key: 'Enter', code: 'Enter' });
    expect(onSend, 'Enter walked past the hold').not.toHaveBeenCalled();
  });

  it('HELD: the draft stays editable — the user may compose, just not submit', () => {
    // The hold is on the SEND, not on the composer. Blocking typing would punish
    // the user for an entitlement read that has not come back yet.
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { textarea } = renderSendBox(true, onSend);
    expect(textarea()).not.toBeDisabled();
  });
});
