import { describe, expect, it } from 'vitest';

import {
  commandEveWarmupPermitsLocalSend,
  commandEveWarmupSkipIsDeliberate,
  describeCommandEveWarmupBlocker,
} from '@/common/config/eveModelWarmupCore';

describe('Command EVE model warm-up skip classification', () => {
  it('treats only a deliberate opt-out as a skip that may proceed', () => {
    expect(commandEveWarmupSkipIsDeliberate('disabled_by_env')).toBe(true);
    expect(commandEveWarmupSkipIsDeliberate('disabled_by_user')).toBe(true);
    expect(commandEveWarmupSkipIsDeliberate('runtime_not_ready')).toBe(false);
  });

  it('fails closed for a skip that cannot prove it was deliberate', () => {
    // Receipts written before 1.823 carry no reason. Reading them as readiness
    // is exactly the fail-open this classification exists to remove.
    expect(commandEveWarmupSkipIsDeliberate(undefined)).toBe(false);
    expect(commandEveWarmupPermitsLocalSend({ status: 'skipped' })).toBe(false);
    expect(commandEveWarmupPermitsLocalSend({ status: 'skipped', skip_reason: 'legacy-nonsense' })).toBe(false);
  });

  it('permits a ready warm-up and a deliberately disabled one, never an unready runtime', () => {
    expect(commandEveWarmupPermitsLocalSend({ status: 'ready' })).toBe(true);
    expect(commandEveWarmupPermitsLocalSend({ status: 'skipped', skip_reason: 'disabled_by_user' })).toBe(true);
    expect(commandEveWarmupPermitsLocalSend({ status: 'skipped', skip_reason: 'disabled_by_env' })).toBe(true);
    expect(commandEveWarmupPermitsLocalSend({ status: 'skipped', skip_reason: 'runtime_not_ready' })).toBe(false);
  });

  it('never reads a failed, running or absent warm-up as readiness', () => {
    expect(commandEveWarmupPermitsLocalSend({ status: 'failed' })).toBe(false);
    expect(commandEveWarmupPermitsLocalSend({ status: 'running' })).toBe(false);
    expect(commandEveWarmupPermitsLocalSend(undefined)).toBe(false);
    // A deliberate reason must not launder a non-skipped terminal state.
    expect(commandEveWarmupPermitsLocalSend({ status: 'failed', skip_reason: 'disabled_by_user' })).toBe(false);
  });
});

describe('Command EVE local-model blocker description', () => {
  it('carries the bootstrap reason code and detail instead of a generic sentence', () => {
    expect(
      describeCommandEveWarmupBlocker([
        { id: 'manifest', status: 'pass' },
        { id: 'capacity', status: 'skip', code: 'BLOCKED_RAM', detail: 'Local model needs 16GB; found 8GB' },
        { id: 'model', status: 'skip', code: 'BLOCKED_RAM' },
      ])
    ).toBe('BLOCKED_RAM: Local model needs 16GB; found 8GB');

    expect(
      describeCommandEveWarmupBlocker([{ id: 'capacity', status: 'skip', code: 'BLOCKED_DISK' }])
    ).toBe('BLOCKED_DISK');
  });

  it('ignores a managed provider’s expected runtime skip and unrelated stages', () => {
    // Bonsai/Colibri legitimately skip the Ollama stage with no reason code;
    // reporting that as a blocker would invent a failure.
    expect(
      describeCommandEveWarmupBlocker([
        { id: 'ollama', status: 'skip' },
        { id: 'model', status: 'pass' },
      ])
    ).toBeUndefined();
    expect(describeCommandEveWarmupBlocker([{ id: 'hermes', status: 'blocked', code: 'HERMES_X' }])).toBeUndefined();
    expect(describeCommandEveWarmupBlocker(undefined)).toBeUndefined();
  });
});
