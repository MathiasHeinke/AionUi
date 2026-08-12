import { describe, expect, it } from 'vitest';

import { resolveProviderFreeFixtureScenario } from '../../../fixtures/provider-free/providerFreeScenario';
import { providerFreeFixtureOriginsFor } from '../../../fixtures/provider-free/providerFreeScenarioTypes';

describe('provider-free fixture safety boundary', () => {
  it('rejects a wrong origin rather than performing prefix or eTLD matching', () => {
    expect(
      resolveProviderFreeFixtureScenario({
        domain: 'commerce',
        action: 'purchase',
        origins: ['https://merchant.eve.invalid', 'https://merchant.eve.invalid.attacker.invalid'],
      })
    ).toEqual({ status: 'denied', reasonCode: 'FIXTURE_ORIGIN_MISMATCH' });
  });

  it('rejects raw-secret-shaped and authority-shaped fields without returning their canary', () => {
    const canary = 'RAW_SECRET_CANARY_MUST_NOT_ESCAPE';
    const result = resolveProviderFreeFixtureScenario({
      domain: 'phone_identity',
      action: 'otp_use',
      origins: providerFreeFixtureOriginsFor('phone_identity'),
      password: canary,
      card: canary,
      otp: canary,
      recoveryCode: canary,
      accountRef: canary,
      seedRef: canary,
      reservationRef: canary,
      continuation: canary,
    });

    expect(result).toEqual({ status: 'denied', reasonCode: 'FIXTURE_INPUT_INVALID' });
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it('rejects a challenge missing its exact needs-user outcome and rejects a phone 3DS scenario', () => {
    expect(
      resolveProviderFreeFixtureScenario({
        domain: 'commerce',
        action: 'purchase',
        origins: providerFreeFixtureOriginsFor('commerce', '3ds'),
        challengeKind: '3ds',
      })
    ).toEqual({ status: 'denied', reasonCode: 'FIXTURE_CHALLENGE_INVALID' });

    expect(
      resolveProviderFreeFixtureScenario({
        domain: 'phone_identity',
        action: 'sms_send',
        origins: providerFreeFixtureOriginsFor('phone_identity', '3ds'),
        outcome: 'needs_user',
        challengeKind: '3ds',
      })
    ).toEqual({ status: 'denied', reasonCode: 'FIXTURE_CHALLENGE_INVALID' });
  });

  it('does not create a continuation, authority reference, or retry route for needs-user', () => {
    const result = resolveProviderFreeFixtureScenario({
      domain: 'commerce',
      action: 'purchase',
      origins: providerFreeFixtureOriginsFor('commerce', 'oauth'),
      outcome: 'needs_user',
      challengeKind: 'oauth',
    });

    expect(result.status).toBe('needs_user');
    expect(JSON.stringify(result)).not.toMatch(/continuation|resume|authority|reservation|broker|token/i);
  });
});
