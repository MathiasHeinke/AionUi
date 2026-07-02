/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.4 T5 — the renderer relay's PURE per-turn decision (decideSessionDigestRelay).
 * A terminal turn flushes immediately; a non-terminal one arms the debounce; the
 * 'unknown' state-default falle stays NON-terminal (arm, never flush); a missing
 * session id is ignored. The full timer/IPC wiring is exercised by the useEffect hook
 * (mounted in ConversationHistoryProvider); this test locks the decision itself.
 */

import { describe, expect, it } from 'vitest';
import { decideSessionDigestRelay } from '@/renderer/pages/conversation/GroupedHistory/hooks/useSessionDigestRelay';
import { isTerminalTurnState } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';

describe('decideSessionDigestRelay', () => {
  it('flushes immediately on the three terminal states', () => {
    for (const state of ['ai_waiting_input', 'error', 'stopped']) {
      expect(decideSessionDigestRelay({ session_id: 'c1', state })).toEqual({ action: 'flush_now' });
    }
  });

  it("arms the debounce on non-terminal states, incl. the 'unknown' default falle", () => {
    for (const state of ['ai_generating', 'ai_waiting_confirmation', 'initializing', 'unknown']) {
      expect(decideSessionDigestRelay({ session_id: 'c1', state })).toEqual({ action: 'arm_debounce' });
    }
    // A missing state also arms (never an immediate flush on an ambiguous event).
    expect(decideSessionDigestRelay({ session_id: 'c1' })).toEqual({ action: 'arm_debounce' });
  });

  it('ignores an event with no session id', () => {
    expect(decideSessionDigestRelay({ state: 'stopped' })).toEqual({ action: 'ignore' });
    expect(decideSessionDigestRelay({ session_id: '   ', state: 'error' })).toEqual({ action: 'ignore' });
  });

  it('uses the SAME terminal predicate the sidebar store exports (no drift)', () => {
    // Sanity: the relay's flush decision agrees with isTerminalTurnState for each state.
    for (const state of ['ai_waiting_input', 'error', 'stopped', 'unknown', 'ai_generating']) {
      const flushes = decideSessionDigestRelay({ session_id: 'c1', state }).action === 'flush_now';
      expect(flushes).toBe(isTerminalTurnState(state));
    }
  });
});
