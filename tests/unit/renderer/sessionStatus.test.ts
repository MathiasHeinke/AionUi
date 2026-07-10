/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  deriveSessionStatus,
  sessionStatusColor,
  sessionStatusShape,
  type SessionStatus,
  type SessionStatusInput,
} from '@/renderer/pages/conversation/GroupedHistory/sessionStatus';

const statusInput = (overrides: Partial<SessionStatusInput> = {}): SessionStatusInput => ({
  isGenerating: false,
  hasCompletionUnread: false,
  isWaitingInput: false,
  hasError: false,
  cronStatus: 'none',
  ...overrides,
});

describe('deriveSessionStatus', () => {
  it('running dominates everything', () => {
    expect(
      deriveSessionStatus(statusInput({ isGenerating: true, hasCompletionUnread: true, cronStatus: 'error' }))
    ).toBe('running');
  });

  it('cron error → error (loudest resting state)', () => {
    expect(deriveSessionStatus(statusInput({ hasCompletionUnread: true, cronStatus: 'error' }))).toBe('error');
  });

  it('chat error dominates waiting-input and unread completion', () => {
    expect(deriveSessionStatus(statusInput({ hasError: true, isWaitingInput: true, hasCompletionUnread: true }))).toBe(
      'error'
    );
  });

  it('cron paused → attention', () => {
    expect(deriveSessionStatus(statusInput({ cronStatus: 'paused' }))).toBe('attention');
  });

  it('waiting-input → attention', () => {
    expect(deriveSessionStatus(statusInput({ isWaitingInput: true }))).toBe('attention');
  });

  it('chat completion unread → done', () => {
    expect(deriveSessionStatus(statusInput({ hasCompletionUnread: true }))).toBe('done');
  });

  it('cron unread execution → done', () => {
    expect(deriveSessionStatus(statusInput({ cronStatus: 'unread' }))).toBe('done');
  });

  it('quiet active cron / nothing flagged → idle', () => {
    expect(deriveSessionStatus(statusInput({ cronStatus: 'active' }))).toBe('idle');
    expect(deriveSessionStatus(statusInput())).toBe('idle');
  });
});

describe('session status presentation', () => {
  const cases: Array<[SessionStatus, string | null, string]> = [
    ['running', 'var(--eve-status-running)', 'ring'],
    ['attention', 'var(--eve-status-attention)', 'diamond'],
    ['error', 'var(--eve-status-error)', 'square'],
    ['done', 'var(--eve-status-completed)', 'circle'],
    ['idle', null, 'none'],
  ];
  it.each(cases)('%s → %s + %s', (status, color, shape) => {
    expect(sessionStatusColor(status)).toBe(color);
    expect(sessionStatusShape(status)).toBe(shape);
  });
});
