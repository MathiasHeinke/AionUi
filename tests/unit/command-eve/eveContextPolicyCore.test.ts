import { describe, expect, it } from 'vitest';

import {
  buildCommandEveContextHeadroomContract,
  buildCommandEveContextPolicy,
} from '@/common/config/eveContextPolicyCore';

describe('Command EVE context policy v1 headroom', () => {
  it('keeps the cloud compression trigger below the hard limit by the declared output and margin', () => {
    const policy = buildCommandEveContextPolicy('cloud');
    const headroom = buildCommandEveContextHeadroomContract(policy);

    expect(policy).toMatchObject({
      hard_limit_tokens: 262_144,
      compression_threshold_tokens: 196_608,
    });
    expect(headroom).toEqual({
      declared_max_output_tokens: 8_192,
      compression_margin_tokens: 4_096,
      available_headroom_tokens: 65_536,
      required_headroom_tokens: 12_288,
    });
    expect(headroom.available_headroom_tokens).toBeGreaterThanOrEqual(headroom.required_headroom_tokens);
  });

  it.each([2_048, 8_192])('keeps a local %i-token output contract inside the v1 headroom', (maxOutput) => {
    const policy = buildCommandEveContextPolicy('local', 65_536);
    const headroom = buildCommandEveContextHeadroomContract(policy);

    expect(policy.compression_threshold_tokens).toBe(49_152);
    expect(policy.hard_limit_tokens - policy.compression_threshold_tokens).toBeGreaterThanOrEqual(
      maxOutput + headroom.compression_margin_tokens
    );
  });

  it('rejects malformed policy input that violates the declared headroom contract', () => {
    expect(() =>
      buildCommandEveContextHeadroomContract({
        ...buildCommandEveContextPolicy('local', 65_536),
        compression_threshold_tokens: 61_440,
      })
    ).toThrow('COMMAND_EVE_CONTEXT_HEADROOM_UNSAFE');
  });
});
