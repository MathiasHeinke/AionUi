import { describe, expect, it } from 'vitest';

import {
  signExternalActionPolicyContext,
  verifyExternalActionPolicyContext,
} from '@/process/services/external-action/policyContextToken';

describe('external-action policy context token', () => {
  it('binds account, Seed and policy epoch without exposing them in the token', () => {
    const key = new TextEncoder().encode('synthetic-process-local-hmac-key');
    const binding = { installationId: 'install-a', accountId: 'account-private', seedId: 'seed-private' };
    const token = signExternalActionPolicyContext(key, binding, 4, 7);
    expect(token).toMatch(/^policy-context:v1:[a-f0-9]{64}$/);
    expect(token).not.toContain(binding.accountId);
    expect(token).not.toContain(binding.seedId);
    expect(verifyExternalActionPolicyContext(key, token, binding, 4, 7)).toBe(true);
    expect(verifyExternalActionPolicyContext(key, token, { ...binding, accountId: 'account-other' }, 4, 7)).toBe(false);
    expect(verifyExternalActionPolicyContext(key, token, { ...binding, seedId: 'seed-other' }, 4, 7)).toBe(false);
    expect(verifyExternalActionPolicyContext(key, token, binding, 5, 7)).toBe(false);
    expect(verifyExternalActionPolicyContext(key, token, binding, 4, 8)).toBe(false);
  });
});
