import {
  providerFreeFixtureOriginsFor,
  type ProviderFreeCommerceAction,
  type ProviderFreeEmailAction,
  type ProviderFreeFixtureAction,
  type ProviderFreeFixtureChallengeKind,
  type ProviderFreeFixtureCommittedResult,
  type ProviderFreeFixtureDomain,
  type ProviderFreeFixtureOutcome,
  type ProviderFreeFixtureScenario,
  type ProviderFreeFixtureSignal,
  type ProviderFreePhoneAction,
} from './providerFreeScenarioTypes';

const EMAIL_ACTIONS = new Set<ProviderFreeEmailAction>(['provision', 'link', 'verify', 'send', 'receive', 'revoke']);
const PHONE_ACTIONS = new Set<ProviderFreePhoneAction>([
  'provision',
  'link',
  'otp_receive',
  'otp_use',
  'sms_send',
  'sms_receive',
  'revoke',
  'voice_telephony',
]);
const COMMERCE_ACTIONS = new Set<ProviderFreeCommerceAction>(['purchase']);
const OUTCOMES = new Set<ProviderFreeFixtureOutcome>([
  'committed',
  'pre_effect_reversed',
  'possible_effect_unknown',
  'needs_user',
]);
const CHALLENGES = new Set<ProviderFreeFixtureChallengeKind>(['oauth', '3ds', 'mfa', 'passkey', 'captcha', 'risk']);
const ALLOWED_FIELDS = new Set(['domain', 'action', 'origins', 'outcome', 'challengeKind']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyAllowedFields(input: Record<string, unknown>): boolean {
  return Object.keys(input).every((field) => ALLOWED_FIELDS.has(field));
}

function sameOrigins(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((origin, index) => origin === expected[index]);
}

function isSupportedAction(domain: ProviderFreeFixtureDomain, action: string): action is ProviderFreeFixtureAction {
  return (
    (domain === 'email_identity' && EMAIL_ACTIONS.has(action as ProviderFreeEmailAction)) ||
    (domain === 'phone_identity' && PHONE_ACTIONS.has(action as ProviderFreePhoneAction)) ||
    (domain === 'commerce' && COMMERCE_ACTIONS.has(action as ProviderFreeCommerceAction))
  );
}

function denied(
  reasonCode: Extract<ProviderFreeFixtureSignal, { status: 'denied' }>['reasonCode']
): ProviderFreeFixtureSignal {
  return { status: 'denied', reasonCode };
}

function parseScenario(input: unknown): ProviderFreeFixtureScenario | ProviderFreeFixtureSignal {
  if (!isRecord(input) || !hasOnlyAllowedFields(input)) return denied('FIXTURE_INPUT_INVALID');
  if (input.domain !== 'email_identity' && input.domain !== 'phone_identity' && input.domain !== 'commerce') {
    return denied('FIXTURE_INPUT_INVALID');
  }
  if (typeof input.action !== 'string' || !isSupportedAction(input.domain, input.action)) {
    return denied('FIXTURE_ACTION_INVALID');
  }
  if (!Array.isArray(input.origins) || !input.origins.every((origin) => typeof origin === 'string')) {
    return denied('FIXTURE_INPUT_INVALID');
  }
  if (
    input.outcome !== undefined &&
    (typeof input.outcome !== 'string' || !OUTCOMES.has(input.outcome as ProviderFreeFixtureOutcome))
  ) {
    return denied('FIXTURE_INPUT_INVALID');
  }
  if (
    input.challengeKind !== undefined &&
    (typeof input.challengeKind !== 'string' ||
      !CHALLENGES.has(input.challengeKind as ProviderFreeFixtureChallengeKind))
  ) {
    return denied('FIXTURE_CHALLENGE_INVALID');
  }

  const outcome = (input.outcome ?? 'committed') as ProviderFreeFixtureOutcome;
  const challengeKind = input.challengeKind as ProviderFreeFixtureChallengeKind | undefined;
  if ((outcome === 'needs_user') !== Boolean(challengeKind)) return denied('FIXTURE_CHALLENGE_INVALID');
  if (challengeKind === '3ds' && input.domain !== 'commerce') return denied('FIXTURE_CHALLENGE_INVALID');
  if (!sameOrigins(input.origins, providerFreeFixtureOriginsFor(input.domain, challengeKind))) {
    return denied('FIXTURE_ORIGIN_MISMATCH');
  }

  return {
    domain: input.domain,
    action: input.action,
    origins: input.origins,
    ...(input.outcome ? { outcome } : {}),
    ...(challengeKind ? { challengeKind } : {}),
  };
}

function instructionFor(
  kind: ProviderFreeFixtureChallengeKind
): Extract<ProviderFreeFixtureSignal, { status: 'needs_user' }>['challenge']['instructionCode'] {
  switch (kind) {
    case 'oauth':
      return 'COMPLETE_OAUTH_CONSENT';
    case '3ds':
      return 'COMPLETE_3DS';
    case 'mfa':
      return 'COMPLETE_MFA';
    case 'passkey':
      return 'COMPLETE_PASSKEY';
    case 'captcha':
      return 'COMPLETE_CAPTCHA';
    case 'risk':
      return 'CONTACT_PROVIDER_FOR_REVIEW';
  }
}

function committedResult(
  domain: ProviderFreeFixtureDomain,
  action: ProviderFreeFixtureAction
): ProviderFreeFixtureCommittedResult {
  if (domain === 'email_identity') {
    if (action === 'send') return { kind: 'message' };
    if (action === 'receive') return { kind: 'inbox' };
    if (action === 'revoke') return { kind: 'revocation' };
    return { kind: 'identity' };
  }

  if (domain === 'phone_identity') {
    if (action === 'voice_telephony') {
      throw new Error('voice_telephony has no committed provider-free fixture result');
    }
    if (action === 'otp_receive') return { kind: 'otp_handle' };
    if (action === 'otp_use') return { kind: 'otp_consumed' };
    if (action === 'sms_send') return { kind: 'message' };
    if (action === 'sms_receive') return { kind: 'inbox' };
    if (action === 'revoke') return { kind: 'revocation' };
    return { kind: 'identity' };
  }

  return { kind: 'purchase' };
}

/**
 * Resolve a deterministic, in-memory test signal. This is intentionally not
 * an adapter, transport, executor, persistence store, or production contract.
 * It does not receive or return credentials, card data, OTPs, authority,
 * reservations, Account/Seed data, opaque handles, receipts, continuations,
 * or browser state.
 */
export function resolveProviderFreeFixtureScenario(input: unknown): ProviderFreeFixtureSignal {
  const parsed = parseScenario(input);
  if ('status' in parsed) return parsed;

  if (parsed.domain === 'phone_identity' && parsed.action === 'voice_telephony') {
    return {
      status: 'unsupported',
      capability: 'voice_telephony',
      reasonCode: 'VOICE_TELEPHONY_UNSUPPORTED',
    };
  }

  const outcome = parsed.outcome ?? 'committed';
  if (outcome === 'pre_effect_reversed') {
    return { status: 'reversed', effect: 'not_started', reasonCode: 'FIXTURE_PRE_EFFECT_BLOCKED' };
  }
  if (outcome === 'possible_effect_unknown') {
    return {
      status: 'unknown_outcome',
      effect: 'possibly_started',
      reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
      retryAllowed: false,
    };
  }
  if (outcome === 'needs_user') {
    const challengeKind = parsed.challengeKind!;
    return {
      status: 'needs_user',
      effect: 'not_started',
      challenge: {
        kind: challengeKind,
        origin: parsed.origins.at(-1)!,
        instructionCode: instructionFor(challengeKind),
      },
    };
  }

  return { status: 'committed', result: committedResult(parsed.domain, parsed.action) };
}
