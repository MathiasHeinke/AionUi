/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fix #3 — a FRESH launch must land on the home / new-chat surface, never the
 * last chat. `normalizeBootHash` rewrites a stale per-chat boot hash to the home
 * route while leaving every other route (home, settings, login, deep-launches)
 * untouched.
 */

import { describe, expect, it } from 'vitest';
import { normalizeBootHash, BOOT_HOME_HASH } from '@/renderer/utils/bootRoute';

describe('normalizeBootHash (fix #3)', () => {
  it('rewrites a stale conversation deep-link to the home surface', () => {
    expect(normalizeBootHash('#/conversation/abc-123')).toBe(BOOT_HOME_HASH);
  });

  it('rewrites a stale team chat deep-link to the home surface', () => {
    expect(normalizeBootHash('#/team/team-9')).toBe(BOOT_HOME_HASH);
  });

  it('leaves an empty / root hash untouched (router already defaults to home)', () => {
    expect(normalizeBootHash('')).toBe('');
    expect(normalizeBootHash('#')).toBe('#');
    expect(normalizeBootHash('#/')).toBe('#/');
    expect(normalizeBootHash(undefined)).toBe('');
    expect(normalizeBootHash(null)).toBe('');
  });

  it('leaves the home route untouched', () => {
    expect(normalizeBootHash('#/guid')).toBe('#/guid');
  });

  it('does NOT clobber non-chat deep-launches (settings / login / other top-level routes)', () => {
    expect(normalizeBootHash('#/settings/about')).toBe('#/settings/about');
    expect(normalizeBootHash('#/settings/company-brain')).toBe('#/settings/company-brain');
    expect(normalizeBootHash('#/login')).toBe('#/login');
    expect(normalizeBootHash('#/scheduled')).toBe('#/scheduled');
    expect(normalizeBootHash('#/command-center')).toBe('#/command-center');
  });

  it('does not match a route that merely contains "conversation" but is not the chat surface', () => {
    // Only the exact chat-surface prefixes are rewritten.
    expect(normalizeBootHash('#/guid?from=conversation')).toBe('#/guid?from=conversation');
  });
});
