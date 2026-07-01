/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S9 #4 — the mic CONSUMER-DEFAULT (store-split fix). The first-run STT seed used
 * to write `{enabled:true}` to the main-process ProcessConfig store, but the mic
 * button reads the BACKEND store (configService), so the seed was invisible and
 * the button stayed hidden on a virgin install. The fix flips the CONSUMER
 * default: absent config ⇒ ON; only an explicit `enabled:false` hides the button.
 *
 * This pins the pure predicate that is now the single source of that default (the
 * dead JSON seed was deleted from initStorage).
 */

import { describe, expect, it } from 'vitest';
import { resolveSpeechInputEnabledDefault } from '@renderer/components/chat/SpeechInputButton';

describe('resolveSpeechInputEnabledDefault (mic consumer-default)', () => {
  it('a FRESH store (undefined) → ENABLED (the seed intention: default ON)', () => {
    expect(resolveSpeechInputEnabledDefault(undefined)).toBe(true);
  });

  it('a null config → ENABLED (default ON)', () => {
    expect(resolveSpeechInputEnabledDefault(null)).toBe(true);
  });

  it('a config object with NO `enabled` field → ENABLED (default ON)', () => {
    expect(resolveSpeechInputEnabledDefault({})).toBe(true);
  });

  it('an explicit `enabled: false` (user opt-out) → DISABLED (button hidden)', () => {
    expect(resolveSpeechInputEnabledDefault({ enabled: false })).toBe(false);
  });

  it('an explicit `enabled: true` → ENABLED', () => {
    expect(resolveSpeechInputEnabledDefault({ enabled: true })).toBe(true);
  });
});
