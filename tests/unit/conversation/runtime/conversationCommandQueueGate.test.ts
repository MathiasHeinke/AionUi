/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getCommandQueueExecutionGate,
  resolveConversationBusyControlCommand,
} from '@/renderer/pages/conversation/platforms/useConversationCommandQueue';

describe('resolveConversationBusyControlCommand', () => {
  it('canonicalizes Hermes queue commands for busy conversations', () => {
    expect(resolveConversationBusyControlCommand('/queue mach danach weiter')).toEqual({
      mode: 'queue',
      input: '/queue mach danach weiter',
    });
    expect(resolveConversationBusyControlCommand('/q  zweiter Schritt')).toEqual({
      mode: 'queue',
      input: '/queue zweiter Schritt',
    });
  });

  it('canonicalizes Hermes steer commands for mid-run corrections', () => {
    expect(resolveConversationBusyControlCommand('/steer nimm stattdessen den anderen Ansatz')).toEqual({
      mode: 'steer',
      input: '/steer nimm stattdessen den anderen Ansatz',
    });
  });

  it('ignores normal prompts and empty control payloads', () => {
    expect(resolveConversationBusyControlCommand('mach danach weiter')).toBeNull();
    expect(resolveConversationBusyControlCommand('/queue')).toBeNull();
    expect(resolveConversationBusyControlCommand('/steer   ')).toBeNull();
  });
});

describe('getCommandQueueExecutionGate', () => {
  it('keeps the legacy path gated by hydration and busy state', () => {
    expect(getCommandQueueExecutionGate({ isBusy: true, isHydrated: true })).toEqual({
      hydrated: true,
      canExecute: false,
      isProcessing: true,
    });

    expect(getCommandQueueExecutionGate({ isBusy: false, isHydrated: false })).toEqual({
      hydrated: false,
      canExecute: true,
      isProcessing: false,
    });
  });

  it('does not execute runtime-gated commands before hydration', () => {
    expect(
      getCommandQueueExecutionGate({
        isBusy: false,
        runtimeGate: {
          hydrated: false,
          canSendMessage: true,
          isProcessing: false,
        },
      })
    ).toEqual({
      hydrated: false,
      canExecute: true,
      isProcessing: false,
    });
  });

  it('does not execute when runtime cannot send', () => {
    expect(
      getCommandQueueExecutionGate({
        isBusy: false,
        runtimeGate: {
          hydrated: true,
          canSendMessage: false,
          isProcessing: false,
        },
      })
    ).toEqual({
      hydrated: true,
      canExecute: false,
      isProcessing: false,
    });
  });

  it('does not execute while runtime is processing', () => {
    expect(
      getCommandQueueExecutionGate({
        isBusy: false,
        runtimeGate: {
          hydrated: true,
          canSendMessage: true,
          isProcessing: true,
        },
      })
    ).toEqual({
      hydrated: true,
      canExecute: false,
      isProcessing: true,
    });
  });

  it('executes only when runtime is hydrated, sendable, and idle', () => {
    expect(
      getCommandQueueExecutionGate({
        isBusy: true,
        runtimeGate: {
          hydrated: true,
          canSendMessage: true,
          isProcessing: false,
        },
      })
    ).toEqual({
      hydrated: true,
      canExecute: true,
      isProcessing: false,
    });
  });
});
