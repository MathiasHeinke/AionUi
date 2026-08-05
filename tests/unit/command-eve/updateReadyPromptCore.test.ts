/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773: a stale 1.820.2/1.820.3 build kept running for ~a day while 1.820.4
 * was already installed on disk — the downloaded update waited silently for a
 * manual quit. These tests pin the pure prompt-state machine that closes the
 * gap: downloaded -> prompt shown; dismiss -> snoozed (never silent forever);
 * snooze expiry / window focus -> re-prompt; a newer build re-prompts over a
 * snooze; a superseded download stops prompting.
 */
import { describe, expect, it } from 'vitest';

import {
  INITIAL_UPDATE_READY_PROMPT_STATE,
  reduceUpdateReadyPrompt,
  resolveInstallableUpdateVersion,
  UPDATE_READY_SNOOZE_MS,
} from '@/common/update/updateReadyPromptCore';
import type { AutoUpdateStatus } from '@/common/update/updateTypes';

const NOW = 1_700_000_000_000;

const downloaded = (version: string): AutoUpdateStatus => ({ status: 'downloaded', version });

describe('reduceUpdateReadyPrompt', () => {
  it('stays hidden while no update has been downloaded', () => {
    let state = INITIAL_UPDATE_READY_PROMPT_STATE;
    for (const status of [
      { status: 'checking' },
      { status: 'not-available' },
      { status: 'available', version: '1.820.4' },
      { status: 'downloading', version: '1.820.4' },
      { status: 'error', error: 'boom' },
    ] as AutoUpdateStatus[]) {
      state = reduceUpdateReadyPrompt(state, { type: 'status', status });
    }
    expect(state.phase).toBe('hidden');
    expect(state.version).toBeNull();
  });

  it('shows the prompt once the update is downloaded', () => {
    const state = reduceUpdateReadyPrompt(INITIAL_UPDATE_READY_PROMPT_STATE, {
      type: 'status',
      status: downloaded('1.820.4'),
    });
    expect(state).toEqual({ phase: 'visible', version: '1.820.4', snoozedUntil: null });
  });

  it('snoozes on dismiss — never permanently — and re-surfaces after the snooze expires', () => {
    let state = reduceUpdateReadyPrompt(INITIAL_UPDATE_READY_PROMPT_STATE, {
      type: 'status',
      status: downloaded('1.820.4'),
    });
    state = reduceUpdateReadyPrompt(state, { type: 'dismiss', now: NOW });
    expect(state.phase).toBe('snoozed');
    expect(state.snoozedUntil).toBe(NOW + UPDATE_READY_SNOOZE_MS);

    // A tick (window focus or wake-up timer) before expiry stays quiet...
    state = reduceUpdateReadyPrompt(state, { type: 'tick', now: NOW + UPDATE_READY_SNOOZE_MS - 1 });
    expect(state.phase).toBe('snoozed');

    // ...but the snooze is not silence: at expiry the prompt comes back.
    state = reduceUpdateReadyPrompt(state, { type: 'tick', now: NOW + UPDATE_READY_SNOOZE_MS });
    expect(state).toEqual({ phase: 'visible', version: '1.820.4', snoozedUntil: null });
  });

  it('repeated status events for the same build do not clear an armed snooze', () => {
    let state = reduceUpdateReadyPrompt(INITIAL_UPDATE_READY_PROMPT_STATE, {
      type: 'status',
      status: downloaded('1.820.4'),
    });
    state = reduceUpdateReadyPrompt(state, { type: 'dismiss', now: NOW });
    // The background re-check re-reports the same downloaded build.
    state = reduceUpdateReadyPrompt(state, { type: 'status', status: downloaded('1.820.4') });
    expect(state.phase).toBe('snoozed');
    expect(state.snoozedUntil).toBe(NOW + UPDATE_READY_SNOOZE_MS);
  });

  it('re-surfaces over an active snooze when a NEWER build finishes downloading', () => {
    let state = reduceUpdateReadyPrompt(INITIAL_UPDATE_READY_PROMPT_STATE, {
      type: 'status',
      status: downloaded('1.820.4'),
    });
    state = reduceUpdateReadyPrompt(state, { type: 'dismiss', now: NOW });
    state = reduceUpdateReadyPrompt(state, { type: 'status', status: downloaded('1.820.5') });
    expect(state).toEqual({ phase: 'visible', version: '1.820.5', snoozedUntil: null });
  });

  it('stops prompting when the downloaded build is superseded before install', () => {
    let state = reduceUpdateReadyPrompt(INITIAL_UPDATE_READY_PROMPT_STATE, {
      type: 'status',
      status: downloaded('1.820.4'),
    });
    // mergeAutoUpdateStatus replaces the state wholesale when a different
    // version becomes available — the old download is no longer the offer.
    state = reduceUpdateReadyPrompt(state, {
      type: 'status',
      status: { status: 'available', version: '1.820.5' },
    });
    expect(state).toEqual(INITIAL_UPDATE_READY_PROMPT_STATE);
  });

  it('ignores dismiss unless the prompt is visible', () => {
    const hidden = reduceUpdateReadyPrompt(INITIAL_UPDATE_READY_PROMPT_STATE, { type: 'dismiss', now: NOW });
    expect(hidden).toEqual(INITIAL_UPDATE_READY_PROMPT_STATE);

    let snoozed = reduceUpdateReadyPrompt(INITIAL_UPDATE_READY_PROMPT_STATE, {
      type: 'status',
      status: downloaded('1.820.4'),
    });
    snoozed = reduceUpdateReadyPrompt(snoozed, { type: 'dismiss', now: NOW });
    const again = reduceUpdateReadyPrompt(snoozed, { type: 'dismiss', now: NOW + 1000 });
    expect(again).toEqual(snoozed);
  });

  it('keeps the prior version when a downloaded event carries none', () => {
    let state = reduceUpdateReadyPrompt(INITIAL_UPDATE_READY_PROMPT_STATE, {
      type: 'status',
      status: downloaded('1.820.4'),
    });
    state = reduceUpdateReadyPrompt(state, { type: 'status', status: { status: 'downloaded' } });
    expect(state).toEqual({ phase: 'visible', version: '1.820.4', snoozedUntil: null });
  });

  it('prompts even for a downloaded event without any version', () => {
    const state = reduceUpdateReadyPrompt(INITIAL_UPDATE_READY_PROMPT_STATE, {
      type: 'status',
      status: { status: 'downloaded' },
    });
    expect(state.phase).toBe('visible');
    expect(state.version).toBeNull();
  });
});

describe('resolveInstallableUpdateVersion', () => {
  it('returns the version only while a download is ready to install', () => {
    expect(resolveInstallableUpdateVersion(downloaded('1.820.4'))).toBe('1.820.4');
    expect(resolveInstallableUpdateVersion({ status: 'downloaded' })).toBeNull();
    expect(resolveInstallableUpdateVersion({ status: 'downloading', version: '1.820.4' })).toBeNull();
    expect(resolveInstallableUpdateVersion({ status: 'available', version: '1.820.4' })).toBeNull();
    expect(resolveInstallableUpdateVersion({ status: 'checking' })).toBeNull();
    expect(resolveInstallableUpdateVersion(null)).toBeNull();
    expect(resolveInstallableUpdateVersion(undefined)).toBeNull();
  });
});
