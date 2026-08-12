import { describe, expect, it } from 'vitest';

import { resolveProviderFreeFixtureScenario } from '../../../fixtures/provider-free/providerFreeScenario';
import {
  PROVIDER_FREE_FIXTURE_CAPABILITIES,
  PROVIDER_FREE_FIXTURE_ORIGINS,
  PROVIDER_FREE_FIXTURE_SCOPE,
  PROVIDER_FREE_FIXTURE_TRANSPORT,
  providerFreeFixtureOriginsFor,
} from '../../../fixtures/provider-free/providerFreeScenarioTypes';

describe('provider-free identity, phone, and commerce scenario fixture', () => {
  it('declares only fixed .invalid origins and zero runtime capabilities', () => {
    expect(PROVIDER_FREE_FIXTURE_TRANSPORT).toBe('in_process_only');
    expect(PROVIDER_FREE_FIXTURE_SCOPE).toBe('tests_only');
    expect(PROVIDER_FREE_FIXTURE_CAPABILITIES).toEqual({
      network: false,
      persistence: false,
      authority: false,
      broker: false,
      budget: false,
      productionRegistration: false,
    });
    expect(Object.values(PROVIDER_FREE_FIXTURE_ORIGINS)).toEqual([
      'https://mail.eve.invalid',
      'https://sms.eve.invalid',
      'https://merchant.eve.invalid',
      'https://oauth.eve.invalid',
      'https://3ds.eve.invalid',
    ]);
  });

  it('models each email lifecycle operation as an opaque committed test signal', () => {
    for (const action of ['provision', 'link', 'verify', 'send', 'receive', 'revoke'] as const) {
      const result = resolveProviderFreeFixtureScenario({
        domain: 'email_identity',
        action,
        origins: providerFreeFixtureOriginsFor('email_identity'),
      });

      expect(result.status).toBe('committed');
      expect(JSON.stringify(result)).not.toMatch(/@|password|card|otp|recovery|token/i);
    }
  });

  it('models phone provisioning, opaque OTP outcomes, SMS, and revoke without voice telephony', () => {
    for (const action of [
      'provision',
      'link',
      'otp_receive',
      'otp_use',
      'sms_send',
      'sms_receive',
      'revoke',
    ] as const) {
      const result = resolveProviderFreeFixtureScenario({
        domain: 'phone_identity',
        action,
        origins: providerFreeFixtureOriginsFor('phone_identity'),
      });

      expect(result.status).toBe('committed');
    }

    expect(
      resolveProviderFreeFixtureScenario({
        domain: 'phone_identity',
        action: 'voice_telephony',
        origins: providerFreeFixtureOriginsFor('phone_identity'),
      })
    ).toEqual({
      status: 'unsupported',
      capability: 'voice_telephony',
      reasonCode: 'VOICE_TELEPHONY_UNSUPPORTED',
    });
  });

  it('models commerce post-effect uncertainty as non-retryable without a payment execution path', () => {
    const result = resolveProviderFreeFixtureScenario({
      domain: 'commerce',
      action: 'purchase',
      origins: providerFreeFixtureOriginsFor('commerce'),
      outcome: 'possible_effect_unknown',
    });

    expect(result).toEqual({
      status: 'unknown_outcome',
      effect: 'possibly_started',
      reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
      retryAllowed: false,
    });
  });

  it('emits needs-user metadata only for an allowed local challenge scenario', () => {
    const result = resolveProviderFreeFixtureScenario({
      domain: 'commerce',
      action: 'purchase',
      origins: providerFreeFixtureOriginsFor('commerce', '3ds'),
      outcome: 'needs_user',
      challengeKind: '3ds',
    });

    expect(result).toEqual({
      status: 'needs_user',
      effect: 'not_started',
      challenge: {
        kind: '3ds',
        origin: 'https://3ds.eve.invalid',
        instructionCode: 'COMPLETE_3DS',
      },
    });
  });
});
