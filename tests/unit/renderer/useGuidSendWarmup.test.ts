import { describe, expect, it } from 'vitest';
import {
  commandEveWarmupReadyForModel,
  resolveCommandEveCloudUnavailableReason,
} from '@/renderer/pages/guid/hooks/useGuidSend';

describe('Command EVE runtime warm-up readiness', () => {
  it('accepts only an explicit ready state for the expected runtime model', () => {
    expect(commandEveWarmupReadyForModel({ model: 'gemma3:4b', status: 'ready' }, 'gemma3:4b')).toBe(true);
    expect(commandEveWarmupReadyForModel({ model: 'gemma3:4b', status: 'skipped' }, 'gemma3:4b')).toBe(false);
    expect(commandEveWarmupReadyForModel({ model: 'gemma3:12b', status: 'ready' }, 'gemma3:4b')).toBe(false);
    expect(commandEveWarmupReadyForModel(undefined, 'gemma3:4b')).toBe(false);
  });
});

describe('Command EVE cloud send decision', () => {
  it('blocks unavailable cloud sends instead of falling back to local Gemma', () => {
    expect(resolveCommandEveCloudUnavailableReason({ isOffline: true, hasResolvedProvider: true })).toBe('offline');
    expect(resolveCommandEveCloudUnavailableReason({ isOffline: false, hasResolvedProvider: false })).toBe(
      'activation'
    );
    expect(resolveCommandEveCloudUnavailableReason({ isOffline: false, hasResolvedProvider: true })).toBeNull();
  });
});
