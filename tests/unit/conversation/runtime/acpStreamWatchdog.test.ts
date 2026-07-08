/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { classifyAcpStreamWatchdog } from '@/renderer/pages/conversation/platforms/acp/useAcpMessage';
import { describe, expect, it } from 'vitest';

describe('classifyAcpStreamWatchdog', () => {
  it('reports renderer backlog when stream events are buffered but not committed', () => {
    expect(
      classifyAcpStreamWatchdog({
        now: 10_000,
        lastBackendEventAt: 9_500,
        lastRendererCommitAt: 6_500,
        pendingBufferedSinceAt: 6_600,
        pendingBufferedEvents: 2,
      })
    ).toBe('ui_backlog');
  });

  it('keeps active tool work visible while the backend is waiting', () => {
    expect(
      classifyAcpStreamWatchdog({
        now: 20_000,
        lastBackendEventAt: 10_000,
        pendingBufferedEvents: 0,
        activeToolName: 'Write',
      })
    ).toBe('tool_wait');
  });

  it('distinguishes stale backend heartbeat from a failed run', () => {
    expect(
      classifyAcpStreamWatchdog({
        now: 20_000,
        lastBackendEventAt: 10_000,
        pendingBufferedEvents: 0,
      })
    ).toBe('heartbeat_only');
    expect(
      classifyAcpStreamWatchdog({
        now: 20_000,
        lastBackendEventAt: 10_000,
        pendingBufferedEvents: 0,
        runFailed: true,
      })
    ).toBe('failed');
  });
});
