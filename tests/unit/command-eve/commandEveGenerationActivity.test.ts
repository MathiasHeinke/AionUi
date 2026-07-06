/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.7.3 — the generation-activity registry that backs the seat-switch guard.
 * The conversation marks itself generating while a turn streams; the seat rail
 * reads isAnyGenerating() to warn before a switch would kill the in-flight turn.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAllGenerating,
  isAnyGenerating,
  setGenerating,
} from '@renderer/services/commandEveGenerationActivity';

describe('commandEveGenerationActivity — the seat-switch guard signal', () => {
  afterEach(() => clearAllGenerating());

  it('is empty by default', () => {
    expect(isAnyGenerating()).toBe(false);
  });

  it('reflects a conversation that starts and finishes a turn', () => {
    setGenerating('conv-a', true);
    expect(isAnyGenerating()).toBe(true);
    setGenerating('conv-a', false);
    expect(isAnyGenerating()).toBe(false);
  });

  it('stays true while ANY conversation is generating (multiple in flight)', () => {
    setGenerating('conv-a', true);
    setGenerating('conv-b', true);
    expect(isAnyGenerating()).toBe(true);
    setGenerating('conv-a', false);
    // conv-b still streaming → switch would still interrupt.
    expect(isAnyGenerating()).toBe(true);
    setGenerating('conv-b', false);
    expect(isAnyGenerating()).toBe(false);
  });

  it('is idempotent and set-based (clearing one id twice is safe)', () => {
    setGenerating('conv-a', true);
    setGenerating('conv-a', true); // duplicate mark
    setGenerating('conv-a', false);
    setGenerating('conv-a', false); // duplicate clear
    expect(isAnyGenerating()).toBe(false);
  });

  it('ignores an empty conversation id (never a stuck ghost flag)', () => {
    setGenerating('', true);
    expect(isAnyGenerating()).toBe(false);
  });
});
