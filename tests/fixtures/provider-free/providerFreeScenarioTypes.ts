/**
 * Test-only, provider-free scenario vocabulary for future external-action
 * adapter tests. Nothing in this directory is production code.
 *
 * The fixture deliberately has no network transport, persistence, authority,
 * credential, budget, broker, reservation, receipt, or resume ownership.
 * Main owns those concerns if and only if a reviewed source contract later
 * permits integration.
 */

export const PROVIDER_FREE_FIXTURE_ORIGINS = {
  mail: 'https://mail.eve.invalid',
  sms: 'https://sms.eve.invalid',
  merchant: 'https://merchant.eve.invalid',
  oauth: 'https://oauth.eve.invalid',
  threeDs: 'https://3ds.eve.invalid',
} as const;

export const PROVIDER_FREE_FIXTURE_TRANSPORT = 'in_process_only' as const;
export const PROVIDER_FREE_FIXTURE_SCOPE = 'tests_only' as const;

export const PROVIDER_FREE_FIXTURE_CAPABILITIES = {
  network: false,
  persistence: false,
  authority: false,
  broker: false,
  budget: false,
  productionRegistration: false,
} as const;

export type ProviderFreeFixtureDomain = 'email_identity' | 'phone_identity' | 'commerce';

export type ProviderFreeEmailAction = 'provision' | 'link' | 'verify' | 'send' | 'receive' | 'revoke';

export type ProviderFreePhoneAction =
  | 'provision'
  | 'link'
  | 'otp_receive'
  | 'otp_use'
  | 'sms_send'
  | 'sms_receive'
  | 'revoke'
  | 'voice_telephony';

export type ProviderFreeCommerceAction = 'purchase';

export type ProviderFreeFixtureAction = ProviderFreeEmailAction | ProviderFreePhoneAction | ProviderFreeCommerceAction;

export type ProviderFreeFixtureOutcome = 'committed' | 'pre_effect_reversed' | 'possible_effect_unknown' | 'needs_user';

export type ProviderFreeFixtureChallengeKind = 'oauth' | '3ds' | 'mfa' | 'passkey' | 'captcha' | 'risk';

export type ProviderFreeFixtureScenario = {
  readonly domain: ProviderFreeFixtureDomain;
  readonly action: ProviderFreeFixtureAction;
  readonly origins: readonly string[];
  readonly outcome?: ProviderFreeFixtureOutcome;
  readonly challengeKind?: ProviderFreeFixtureChallengeKind;
};

export type ProviderFreeFixtureCommittedResult =
  | { readonly kind: 'identity' }
  | { readonly kind: 'message' }
  | { readonly kind: 'inbox' }
  | { readonly kind: 'revocation' }
  | { readonly kind: 'otp_handle' }
  | { readonly kind: 'otp_consumed' }
  | { readonly kind: 'purchase' };

export type ProviderFreeFixtureSignal =
  | { readonly status: 'committed'; readonly result: ProviderFreeFixtureCommittedResult }
  | { readonly status: 'reversed'; readonly effect: 'not_started'; readonly reasonCode: 'FIXTURE_PRE_EFFECT_BLOCKED' }
  | {
      readonly status: 'unknown_outcome';
      readonly effect: 'possibly_started';
      readonly reasonCode: 'UNKNOWN_EXTERNAL_EFFECT';
      readonly retryAllowed: false;
    }
  | {
      readonly status: 'needs_user';
      readonly effect: 'not_started';
      readonly challenge: {
        readonly kind: ProviderFreeFixtureChallengeKind;
        readonly origin: string;
        readonly instructionCode:
          | 'COMPLETE_OAUTH_CONSENT'
          | 'COMPLETE_3DS'
          | 'COMPLETE_MFA'
          | 'COMPLETE_PASSKEY'
          | 'COMPLETE_CAPTCHA'
          | 'CONTACT_PROVIDER_FOR_REVIEW';
      };
    }
  | {
      readonly status: 'unsupported';
      readonly capability: 'voice_telephony';
      readonly reasonCode: 'VOICE_TELEPHONY_UNSUPPORTED';
    }
  | {
      readonly status: 'denied';
      readonly reasonCode:
        | 'FIXTURE_INPUT_INVALID'
        | 'FIXTURE_ORIGIN_MISMATCH'
        | 'FIXTURE_ACTION_INVALID'
        | 'FIXTURE_CHALLENGE_INVALID';
    };

export function providerFreeFixtureOriginsFor(
  domain: ProviderFreeFixtureDomain,
  challengeKind?: ProviderFreeFixtureChallengeKind
): readonly string[] {
  const primary =
    domain === 'email_identity'
      ? PROVIDER_FREE_FIXTURE_ORIGINS.mail
      : domain === 'phone_identity'
        ? PROVIDER_FREE_FIXTURE_ORIGINS.sms
        : PROVIDER_FREE_FIXTURE_ORIGINS.merchant;

  if (challengeKind === 'oauth') return [primary, PROVIDER_FREE_FIXTURE_ORIGINS.oauth];
  if (challengeKind === '3ds') return [PROVIDER_FREE_FIXTURE_ORIGINS.merchant, PROVIDER_FREE_FIXTURE_ORIGINS.threeDs];
  return [primary];
}
