import crypto from 'node:crypto';

import type {
  EveExternalActionSanitizedResult,
  EveExternalActionSlotBinding,
} from '@/common/config/eveExternalActionExecutionCore';
import type { EveExternalActionKind } from '@/common/config/eveExternalActionPolicyCore';
import {
  EXTERNAL_ACTION_ADAPTER_PAYLOAD_VALIDATION_VERSION,
  type ExternalActionAdapter,
  type ExternalActionAdapterOutcome,
  type ExternalActionAdapterPayloadValidation,
  type ExternalActionRegisteredOperation,
} from '@/process/services/external-action/externalActionExecutionService';

import { resolveProviderFreeFixtureScenario } from './providerFreeScenario';
import {
  PROVIDER_FREE_FIXTURE_ORIGINS,
  providerFreeFixtureOriginsFor,
  type ProviderFreeFixtureChallengeKind,
  type ProviderFreeFixtureScenario,
  type ProviderFreeFixtureSignal,
} from './providerFreeScenarioTypes';

export const PROVIDER_FREE_EXTERNAL_ACTION_PAYLOAD_VERSION =
  'command-eve-provider-free-external-action-payload/v0' as const;

const FIXTURE_CHALLENGE_EXPIRY = '2026-08-11T12:05:00.000Z';

export type ProviderFreeCommerceEnvelope = Readonly<{
  productCount: number;
  cartDigest: string;
  quoteDigest: string;
  amount: Readonly<{ currency: string; minorUnits: number }>;
}>;

/**
 * Test-only Main-service adapter input. It deliberately has one registered
 * operation so current actionKind+targetOrigin matching cannot become
 * ambiguous. It has no transport, persistence, authority, broker, or receipt
 * ownership; Main continues to own all of those concerns.
 */
export type ProviderFreeExternalActionAdapterConfig = Readonly<{
  id: string;
  counterpartyId: string;
  scenario: ProviderFreeFixtureScenario;
  actionKind: EveExternalActionKind;
  authMode: 'oauth' | 'otp' | 'payment_fields' | 'session';
  slotManifest?: readonly EveExternalActionSlotBinding[];
  authOrigins?: readonly string[];
  commerce?: ProviderFreeCommerceEnvelope;
}>;

export type ProviderFreeExternalActionAdapterFixture = Readonly<{
  adapter: ExternalActionAdapter;
  payload: Uint8Array;
  payloadRef: string;
  payloadDigest: string;
  completeOAuthConsent(): void;
  /** Returns non-secret call metadata for assertions; it never retains bytes. */
  inspect(): ProviderFreeExternalActionAdapterTelemetry;
}>;

export type ProviderFreeExternalActionAdapterTelemetry = Readonly<{
  oauthProbeCalls: number;
  executeCalls: number;
  resumeCalls: number;
  lastOAuthProbe?: Readonly<{
    authOrigin?: string;
    authOrigins: readonly string[];
    authBrowserPartition?: string;
    actionTargetOrigin: string;
    callbackRef: string;
  }>;
  lastExecute?: Readonly<{
    authMode: 'oauth' | 'password' | 'otp' | 'payment_fields' | 'session' | 'none';
    actionTargetOrigin: string;
    secretUseRefs: readonly Readonly<{ slot: string; deliveryRef: string }>[];
    adapterPayloadDigest?: string;
  }>;
  lastResume?: Readonly<{
    authMode: 'oauth' | 'password' | 'otp' | 'payment_fields' | 'session' | 'none';
    challengeOrigin: string;
    completionAttestationPresent: boolean;
    adapterPayloadDigest?: string;
  }>;
}>;

function sha256Bytes(value: Uint8Array): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sha256Text(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fixtureSetupError(code: string): never {
  throw new Error(`PROVIDER_FREE_FIXTURE_SETUP_${code}`);
}

function validatedSignal(
  scenario: ProviderFreeFixtureScenario
): Exclude<ProviderFreeFixtureSignal, { status: 'denied' | 'unsupported' }> {
  const signal = resolveProviderFreeFixtureScenario(scenario);
  if (signal.status === 'denied' || signal.status === 'unsupported') fixtureSetupError('SCENARIO_INVALID');
  return signal;
}

function registeredOriginsFor(scenario: ProviderFreeFixtureScenario): readonly string[] {
  if (scenario.domain === 'commerce') {
    // An unknown outcome has no separate 3DS origin. The existing Main
    // commerce operation still has a merchant/checkout pair, so this remains
    // one action instance with a same-origin pair rather than a new action kind.
    return Object.freeze([scenario.origins[0]!, scenario.origins[1] ?? scenario.origins[0]!]);
  }
  return Object.freeze([scenario.origins[0]!]);
}

function actionTarget(scenario: ProviderFreeFixtureScenario, origins: readonly string[]): string {
  return scenario.domain === 'commerce' ? origins[1]! : origins[0]!;
}

function operationFor(
  config: ProviderFreeExternalActionAdapterConfig,
  origins: readonly string[]
): ExternalActionRegisteredOperation {
  const { scenario } = config;
  if (scenario.domain === 'commerce') {
    if (config.actionKind !== 'purchase' || scenario.action !== 'purchase' || origins.length !== 2) {
      fixtureSetupError('COMMERCE_OPERATION');
    }
    return {
      actionKind: 'purchase',
      domain: 'commerce',
      action: 'purchase',
      counterpartyId: config.counterpartyId,
      merchantOrigin: origins[0]!,
      checkoutOrigin: origins[1]!,
    };
  }
  if (origins.length !== 1) {
    fixtureSetupError('IDENTITY_ORIGINS');
  }
  return {
    actionKind: config.actionKind,
    domain: scenario.domain,
    action: scenario.action,
    counterpartyId: config.counterpartyId,
    providerOrigin: origins[0]!,
  };
}

function providerReceiptDigest(scenario: ProviderFreeFixtureScenario): string {
  return sha256Text(`provider-free-receipt:${scenario.domain}:${scenario.action}`);
}

function committedResult(
  scenario: ProviderFreeFixtureScenario,
  commerce: ProviderFreeCommerceEnvelope | undefined
): EveExternalActionSanitizedResult {
  const suffix = `${scenario.domain}-${scenario.action}`;
  if (scenario.domain === 'email_identity') {
    switch (scenario.action) {
      case 'provision':
      case 'link':
      case 'verify':
        return { domain: 'email_identity', action: scenario.action, identityRef: `identity:provider-free-${suffix}` };
      case 'send':
        return {
          domain: 'email_identity',
          action: 'send',
          messageRef: `message:provider-free-${suffix}`,
          providerReceiptDigest: providerReceiptDigest(scenario),
        };
      case 'receive':
        return {
          domain: 'email_identity',
          action: 'receive',
          messageRefs: [`message:provider-free-${suffix}`],
          cursorRef: `cursor:provider-free-${suffix}`,
        };
      case 'revoke':
        return { domain: 'email_identity', action: 'revoke', revocationRef: `revocation:provider-free-${suffix}` };
    }
  }
  if (scenario.domain === 'phone_identity') {
    switch (scenario.action) {
      case 'provision':
      case 'link':
        return { domain: 'phone_identity', action: scenario.action, identityRef: `identity:provider-free-${suffix}` };
      case 'otp_receive':
        return { domain: 'phone_identity', action: 'otp_receive', otpHandleRef: `handle:provider-free-${suffix}` };
      case 'otp_use':
        return {
          domain: 'phone_identity',
          action: 'otp_use',
          challengeReceiptRef: `receipt:provider-free-${suffix}`,
        };
      case 'sms_send':
        return {
          domain: 'phone_identity',
          action: 'sms_send',
          messageRef: `message:provider-free-${suffix}`,
          providerReceiptDigest: providerReceiptDigest(scenario),
        };
      case 'sms_receive':
        return {
          domain: 'phone_identity',
          action: 'sms_receive',
          messageRefs: [`message:provider-free-${suffix}`],
          cursorRef: `cursor:provider-free-${suffix}`,
        };
      case 'revoke':
        return { domain: 'phone_identity', action: 'revoke', revocationRef: `revocation:provider-free-${suffix}` };
      case 'voice_telephony':
        return fixtureSetupError('VOICE_UNSUPPORTED');
    }
  }
  if (!commerce) fixtureSetupError('COMMERCE_ENVELOPE');
  return {
    domain: 'commerce',
    action: 'purchase',
    purchaseRef: `purchase:provider-free-${suffix}`,
    productDigest: commerce.cartDigest,
    amount: { ...commerce.amount },
    providerReceiptDigest: providerReceiptDigest(scenario),
  };
}

function challengeKind(
  kind: ProviderFreeFixtureChallengeKind
): 'oauth_consent' | '3ds' | 'mfa' | 'passkey' | 'captcha' | 'provider_risk_review' {
  switch (kind) {
    case 'oauth':
      return 'oauth_consent';
    case '3ds':
      return '3ds';
    case 'mfa':
      return 'mfa';
    case 'passkey':
      return 'passkey';
    case 'captcha':
      return 'captcha';
    case 'risk':
      return 'provider_risk_review';
  }
}

function actionOutcome(
  signal: Exclude<ProviderFreeFixtureSignal, { status: 'denied' | 'unsupported' }>,
  scenario: ProviderFreeFixtureScenario,
  commerce: ProviderFreeCommerceEnvelope | undefined
): ExternalActionAdapterOutcome {
  if (signal.status === 'committed') return { status: 'allowed', result: committedResult(scenario, commerce) };
  if (signal.status === 'reversed') return { status: 'denied', reasonCode: 'POLICY_DENIED' };
  if (signal.status === 'unknown_outcome') return { status: 'unknown_outcome', reasonCode: 'UNKNOWN_EXTERNAL_EFFECT' };
  if (signal.challenge.kind === 'oauth') return { status: 'allowed', result: committedResult(scenario, commerce) };
  const kind = challengeKind(signal.challenge.kind);
  return {
    status: 'needs_user',
    reasonCode: signal.challenge.instructionCode,
    challenge: {
      kind,
      challengeRef: `challenge:provider-free-${scenario.domain}-${scenario.action}-${kind}`,
      origin: signal.challenge.origin,
      expiresAt: FIXTURE_CHALLENGE_EXPIRY,
      userInstructionCode: signal.challenge.instructionCode,
    },
    continuation: 'adapter_resume',
    continuationRef: `continuation:provider-free-${scenario.domain}-${scenario.action}-${kind}`,
    effectState: 'challenge_pending_no_effect',
  };
}

/**
 * Builds exactly one deterministic provider-free adapter for a Main-service
 * test. It is intentionally not registered with the application bridge.
 */
export function createProviderFreeExternalActionAdapter(
  config: ProviderFreeExternalActionAdapterConfig
): ProviderFreeExternalActionAdapterFixture {
  const signal = validatedSignal(config.scenario);
  const expectedOrigins = providerFreeFixtureOriginsFor(config.scenario.domain, config.scenario.challengeKind);
  if (!sameStrings(config.scenario.origins, expectedOrigins)) fixtureSetupError('ORIGIN_MISMATCH');
  if (config.scenario.domain === 'commerce' ? !config.commerce : Boolean(config.commerce)) {
    fixtureSetupError('COMMERCE_ENVELOPE');
  }
  if (
    (config.scenario.challengeKind === 'oauth' && config.authMode !== 'oauth') ||
    (config.authMode === 'oauth' && config.scenario.challengeKind !== 'oauth')
  ) {
    fixtureSetupError('OAUTH_MODE');
  }

  const origins = registeredOriginsFor(config.scenario);
  const targetOrigin = actionTarget(config.scenario, origins);
  const authOrigins = config.authOrigins ? Object.freeze([...config.authOrigins]) : undefined;
  if (
    authOrigins &&
    (config.authMode !== 'oauth' ||
      authOrigins.length !== 1 ||
      authOrigins[0] !== PROVIDER_FREE_FIXTURE_ORIGINS.oauth ||
      authOrigins.includes(targetOrigin))
  ) {
    fixtureSetupError('AUTH_ORIGIN');
  }
  if (config.authMode === 'oauth' && !authOrigins) fixtureSetupError('AUTH_ORIGIN_REQUIRED');

  const slotManifest = Object.freeze([...(config.slotManifest ?? [])].map((slot) => Object.freeze({ ...slot })));
  const payload = new TextEncoder().encode(
    JSON.stringify({
      version: PROVIDER_FREE_EXTERNAL_ACTION_PAYLOAD_VERSION,
      domain: config.scenario.domain,
      action: config.scenario.action,
      actionKind: config.actionKind,
      authMode: config.authMode,
      origins,
      ...(config.commerce
        ? {
            commerce: {
              productCount: config.commerce.productCount,
              cartDigest: config.commerce.cartDigest,
              quoteDigest: config.commerce.quoteDigest,
              amount: config.commerce.amount,
            },
          }
        : {}),
    })
  );
  const payloadDigest = sha256Bytes(payload);
  const payloadRef = `payload:provider-free-${config.scenario.domain}-${config.scenario.action}`;
  const operation = operationFor(config, origins);
  let oauthConsentComplete = config.scenario.challengeKind !== 'oauth';
  let oauthProbeCalls = 0;
  let executeCalls = 0;
  let resumeCalls = 0;
  let lastOAuthProbe: ProviderFreeExternalActionAdapterTelemetry['lastOAuthProbe'];
  let lastExecute: ProviderFreeExternalActionAdapterTelemetry['lastExecute'];
  let lastResume: ProviderFreeExternalActionAdapterTelemetry['lastResume'];

  const validatePayload: NonNullable<ExternalActionAdapter['validatePayload']> = (candidate, context) => {
    if (
      !sameBytes(candidate, payload) ||
      context.domain !== config.scenario.domain ||
      context.action !== config.scenario.action ||
      context.counterpartyId !== config.counterpartyId ||
      !sameStrings(context.origins, origins) ||
      context.targetOrigin !== targetOrigin
    ) {
      fixtureSetupError('PAYLOAD_CONTRACT');
    }
    const validation: ExternalActionAdapterPayloadValidation = {
      version: EXTERNAL_ACTION_ADAPTER_PAYLOAD_VALIDATION_VERSION,
      canonicalPayloadDigest: payloadDigest,
      authMode: config.authMode,
      domain: config.scenario.domain,
      action: config.scenario.action,
      counterpartyId: config.counterpartyId,
      origins,
      slotManifest,
    };
    if (!config.commerce) return validation;
    if (
      context.quoteDigest !== config.commerce.quoteDigest ||
      context.argumentsDigest !== config.commerce.cartDigest ||
      context.amount.currency !== config.commerce.amount.currency ||
      context.amount.minorUnits !== config.commerce.amount.minorUnits
    ) {
      fixtureSetupError('COMMERCE_DIGEST');
    }
    return {
      ...validation,
      commerce: {
        productCount: config.commerce.productCount,
        cartDigest: config.commerce.cartDigest,
        quoteDigest: config.commerce.quoteDigest,
        amount: { ...config.commerce.amount },
      },
    };
  };

  const adapter: ExternalActionAdapter = {
    id: config.id,
    providerOrMerchantLabelCode:
      config.scenario.domain === 'email_identity'
        ? 'fixture_mail'
        : config.scenario.domain === 'phone_identity'
          ? 'fixture_sms'
          : 'fixture_merchant',
    operations: Object.freeze([operation]),
    ...(authOrigins ? { authOrigins } : {}),
    supports: Object.freeze({
      oauth: config.authMode === 'oauth',
      browserSession: config.authMode === 'session',
      password: false,
      ...(config.authMode === 'otp' ? { otp: true } : {}),
      ...(config.authMode === 'payment_fields' ? { paymentFields: true } : {}),
      unauthenticated: false,
    }),
    classifyRisk: () => 'ordinary',
    validatePayload,
    ...(config.authMode === 'oauth'
      ? {
          probeOAuth: async (context) => {
            oauthProbeCalls += 1;
            lastOAuthProbe = Object.freeze({
              ...(context.authOrigin ? { authOrigin: context.authOrigin } : {}),
              authOrigins: Object.freeze([...context.authOrigins]),
              ...(context.authBrowserPartition ? { authBrowserPartition: context.authBrowserPartition } : {}),
              actionTargetOrigin: context.proposal.action.targetOrigin,
              callbackRef: context.callbackRef,
            });
            return oauthConsentComplete ? ('ready' as const) : ('needs_user' as const);
          },
        }
      : {}),
    ...(config.authMode === 'session'
      ? {
          probeBrowserSession: async () => 'ready' as const,
        }
      : {}),
    execute: async (context) => {
      executeCalls += 1;
      lastExecute = Object.freeze({
        authMode: context.authMode,
        actionTargetOrigin: context.proposal.action.targetOrigin,
        secretUseRefs: Object.freeze(
          (context.secretUseRefs ?? []).map((entry) =>
            Object.freeze({ slot: entry.slot, deliveryRef: entry.deliveryRef })
          )
        ),
        ...(context.adapterPayload ? { adapterPayloadDigest: sha256Bytes(context.adapterPayload) } : {}),
      });
      if (context.authMode !== config.authMode || context.proposal.action.targetOrigin !== targetOrigin) {
        return { status: 'denied', reasonCode: 'CONTRACT_CHANGED' };
      }
      return actionOutcome(signal, config.scenario, config.commerce);
    },
    ...(signal.status === 'needs_user' && signal.challenge.kind !== 'oauth'
      ? {
          resume: async (context) => {
            resumeCalls += 1;
            lastResume = Object.freeze({
              authMode: context.authMode,
              challengeOrigin: context.challenge.origin,
              completionAttestationPresent: context.completionAttestationPresent,
              ...(context.adapterPayload ? { adapterPayloadDigest: sha256Bytes(context.adapterPayload) } : {}),
            });
            if (
              context.authMode !== config.authMode ||
              context.challenge.origin !== targetOrigin ||
              !context.completionAttestationPresent
            ) {
              return { status: 'denied' as const, reasonCode: 'CONTRACT_CHANGED' as const };
            }
            return { status: 'allowed' as const, result: committedResult(config.scenario, config.commerce) };
          },
        }
      : {}),
  };

  return Object.freeze({
    adapter: Object.freeze(adapter),
    payload,
    payloadRef,
    payloadDigest,
    completeOAuthConsent: () => {
      oauthConsentComplete = true;
    },
    inspect: () =>
      Object.freeze({
        oauthProbeCalls,
        executeCalls,
        resumeCalls,
        ...(lastOAuthProbe ? { lastOAuthProbe } : {}),
        ...(lastExecute ? { lastExecute } : {}),
        ...(lastResume ? { lastResume } : {}),
      }),
  });
}
