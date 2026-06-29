/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  deriveSessionStatus,
  sessionStatusColor,
  type SessionStatus,
} from '@/renderer/pages/conversation/GroupedHistory/sessionStatus';

describe('deriveSessionStatus', () => {
  it('running dominates everything', () => {
    expect(
      deriveSessionStatus({ isGenerating: true, hasCompletionUnread: true, cronStatus: 'error' })
    ).toBe('running');
  });

  it('cron error → error (loudest resting state)', () => {
    expect(
      deriveSessionStatus({ isGenerating: false, hasCompletionUnread: true, cronStatus: 'error' })
    ).toBe('error');
  });

  it('cron paused → attention', () => {
    expect(
      deriveSessionStatus({ isGenerating: false, hasCompletionUnread: false, cronStatus: 'paused' })
    ).toBe('attention');
  });

  it('chat completion unread → done', () => {
    expect(
      deriveSessionStatus({ isGenerating: false, hasCompletionUnread: true, cronStatus: 'none' })
    ).toBe('done');
  });

  it('cron unread execution → done', () => {
    expect(
      deriveSessionStatus({ isGenerating: false, hasCompletionUnread: false, cronStatus: 'unread' })
    ).toBe('done');
  });

  it('quiet active cron / nothing flagged → idle', () => {
    expect(
      deriveSessionStatus({ isGenerating: false, hasCompletionUnread: false, cronStatus: 'active' })
    ).toBe('idle');
    expect(
      deriveSessionStatus({ isGenerating: false, hasCompletionUnread: false, cronStatus: 'none' })
    ).toBe('idle');
  });
});

describe('sessionStatusColor (Claude-Code semantics)', () => {
  const cases: Array<[SessionStatus, string | null]> = [
    ['running', 'rgb(var(--primary-6))'],
    ['attention', 'rgb(var(--warning-6))'],
    ['error', 'rgb(var(--danger-6))'],
    ['done', 'rgb(var(--success-6))'],
    ['idle', null],
  ];
  it.each(cases)('%s → %s', (status, color) => {
    expect(sessionStatusColor(status)).toBe(color);
  });
});
