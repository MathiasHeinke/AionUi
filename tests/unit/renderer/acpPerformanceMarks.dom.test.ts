import {
  ACP_PERFORMANCE_MARK_EVENT,
  emitAcpPerformanceMark,
  type AcpPerformanceMark,
} from '@/renderer/utils/performance/acpPerformanceMarks';
import { describe, expect, it, vi } from 'vitest';

describe('acpPerformanceMarks', () => {
  it('emits a content-free renderer receipt with wall and monotonic clocks', () => {
    const listener = vi.fn();
    window.addEventListener(ACP_PERFORMANCE_MARK_EVENT, listener);

    const mark = emitAcpPerformanceMark({
      stage: 'acp_first_text',
      conversationId: 'conv-1',
      turnId: 'turn-1',
    });

    expect(mark).toMatchObject({
      version: 'command-eve-acp-performance-mark/v1',
      stage: 'acp_first_text',
      conversationId: 'conv-1',
      turnId: 'turn-1',
    });
    expect(mark.atEpochMs).toBeGreaterThan(0);
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent<AcpPerformanceMark>;
    expect(event.detail).toEqual(mark);

    window.removeEventListener(ACP_PERFORMANCE_MARK_EVENT, listener);
  });
});
