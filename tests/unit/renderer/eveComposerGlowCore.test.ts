/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  COMPOSER_GLOW_ATTRIBUTE,
  COMPOSER_MAX_IGNITION_ATTRIBUTE,
  COMPOSER_MAX_IGNITION_MS,
  resolveComposerGlowState,
} from '@/renderer/components/agent/eveComposerGlowCore';

describe('resolveComposerGlowState (MAT-1773, founder decision 2026-08-05)', () => {
  it('MAX off is OFF for every phase — the standard composer keeps its neutral look', () => {
    for (const phase of ['idle', 'submitting', 'thinking', 'streaming', 'tool_wait', 'error'] as const) {
      expect(resolveComposerGlowState({ maxActive: false, phase })).toBe('off');
    }
  });

  it('submitting and connecting map to start-stau (queued anticipation)', () => {
    expect(resolveComposerGlowState({ maxActive: true, phase: 'submitting' })).toBe('start-stau');
    expect(resolveComposerGlowState({ maxActive: true, phase: 'connecting' })).toBe('start-stau');
  });

  it('thinking, tool_wait and heartbeat_only map to denk-puls (the heartbeat)', () => {
    expect(resolveComposerGlowState({ maxActive: true, phase: 'thinking' })).toBe('denk-puls');
    expect(resolveComposerGlowState({ maxActive: true, phase: 'tool_wait' })).toBe('denk-puls');
    expect(resolveComposerGlowState({ maxActive: true, phase: 'heartbeat_only' })).toBe('denk-puls');
  });

  it('streaming and ui_backlog map to the calm stream flow', () => {
    expect(resolveComposerGlowState({ maxActive: true, phase: 'streaming' })).toBe('stream');
    expect(resolveComposerGlowState({ maxActive: true, phase: 'ui_backlog' })).toBe('stream');
  });

  it('idle/ready/done/error map to the armed breath (MAX on, nothing running)', () => {
    for (const phase of ['idle', 'ready', 'done', 'error'] as const) {
      expect(resolveComposerGlowState({ maxActive: true, phase })).toBe('armed');
    }
  });

  it('an unknown future phase falls back to armed, never to a dead glow', () => {
    expect(resolveComposerGlowState({ maxActive: true, phase: 'some_future_phase' })).toBe('armed');
  });

  it('exposes the attribute names and the ignition window the stylesheet relies on', () => {
    expect(COMPOSER_GLOW_ATTRIBUTE).toBe('data-eve-glow');
    expect(COMPOSER_MAX_IGNITION_ATTRIBUTE).toBe('data-eve-max-ignition');
    // The marker outlives the 300ms sweep by a small margin, then retracts.
    expect(COMPOSER_MAX_IGNITION_MS).toBe(350);
  });
});
