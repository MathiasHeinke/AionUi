import { describe, expect, it } from 'vitest';
import {
  LOCAL_RUNTIME_PULL_POLL_LIMIT,
  LOCAL_RUNTIME_WARMUP_POLL_LIMIT,
  shouldScheduleLocalRuntimePoll,
} from '@/renderer/pages/localRuntime';

describe('local runtime polling limits', () => {
  it('keeps the short warmup poll bounded', () => {
    expect(
      shouldScheduleLocalRuntimePoll({ pollCount: LOCAL_RUNTIME_WARMUP_POLL_LIMIT - 1, pullInProgress: false })
    ).toBe(true);
    expect(shouldScheduleLocalRuntimePoll({ pollCount: LOCAL_RUNTIME_WARMUP_POLL_LIMIT, pullInProgress: false })).toBe(
      false
    );
  });

  it('allows a 30+ minute model pull but eventually stops renderer polling', () => {
    expect(LOCAL_RUNTIME_PULL_POLL_LIMIT * 2500).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(shouldScheduleLocalRuntimePoll({ pollCount: LOCAL_RUNTIME_PULL_POLL_LIMIT - 1, pullInProgress: true })).toBe(
      true
    );
    expect(shouldScheduleLocalRuntimePoll({ pollCount: LOCAL_RUNTIME_PULL_POLL_LIMIT, pullInProgress: true })).toBe(
      false
    );
  });
});
