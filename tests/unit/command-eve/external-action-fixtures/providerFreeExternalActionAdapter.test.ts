import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EVE_EXTERNAL_ACTION_PROPOSAL_VERSION,
  EVE_EXTERNAL_ACTION_RESUME_VERSION,
  type EveExternalActionProposal,
  type EveExternalActionSlotBinding,
} from '@/common/config/eveExternalActionExecutionCore';
import type { EveExternalActionBinding, EveExternalActionKind } from '@/common/config/eveExternalActionPolicyCore';
import {
  EXTERNAL_ACTION_COMPLETION_ATTESTATION_VERSION,
  ExternalActionExecutionService,
  type ExternalActionExecutionDeps,
} from '@/process/services/external-action/externalActionExecutionService';
import { ExternalActionStore } from '@/process/services/external-action/externalActionStore';
import {
  createProviderFreeExternalActionAdapter,
  type ProviderFreeCommerceEnvelope,
  type ProviderFreeExternalActionAdapterConfig,
  type ProviderFreeExternalActionAdapterFixture,
} from '../../../fixtures/provider-free/providerFreeExternalActionAdapter';
import {
  PROVIDER_FREE_FIXTURE_ORIGINS,
  providerFreeFixtureOriginsFor,
} from '../../../fixtures/provider-free/providerFreeScenarioTypes';
import { NodeSqliteDriver } from '../external-action/testSqliteDriver';

const NOW_ISO = '2026-08-11T12:00:00.000Z';
const roots: string[] = [];
const stores = new Set<ExternalActionStore>();
let sequence = 0;

function digest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function actionTarget(fixture: ProviderFreeExternalActionAdapterFixture): string {
  const operation = fixture.adapter.operations[0]!;
  return operation.domain === 'commerce' ? operation.checkoutOrigin : operation.providerOrigin;
}

function actionOrigins(fixture: ProviderFreeExternalActionAdapterFixture): string[] {
  const operation = fixture.adapter.operations[0]!;
  return operation.domain === 'commerce'
    ? [operation.merchantOrigin, operation.checkoutOrigin]
    : [operation.providerOrigin];
}

function proposalFor(
  fixture: ProviderFreeExternalActionAdapterFixture,
  config: ProviderFreeExternalActionAdapterConfig,
  suffix: string
): EveExternalActionProposal {
  const commerce = config.commerce;
  return {
    version: EVE_EXTERNAL_ACTION_PROPOSAL_VERSION,
    clientRequestId: `request-${suffix}`,
    idempotencyKey: `idempotency-${suffix}`,
    action: {
      kind: config.actionKind,
      targetOrigin: actionTarget(fixture),
      argumentsDigest: commerce?.cartDigest ?? digest(`arguments:${suffix}`),
      ...(commerce ? { quoteDigest: commerce.quoteDigest } : {}),
      adapterPayloadRef: fixture.payloadRef,
      adapterPayloadDigest: fixture.payloadDigest,
      amount: commerce?.amount ?? { currency: 'NONE', minorUnits: 0 },
    },
  };
}

function createHarness(config: ProviderFreeExternalActionAdapterConfig) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-provider-free-adapter-'));
  roots.push(root);
  const file = path.join(root, 'ledger.sqlite3');
  const store = new ExternalActionStore(new NodeSqliteDriver(file), {
    now: () => new Date(NOW_ISO),
    randomUUID: () => `provider-free-store-${++sequence}`,
  });
  stores.add(store);
  const fixture = createProviderFreeExternalActionAdapter(config);
  const binding: EveExternalActionBinding = {
    installationId: store.getInstallationId(),
    accountId: 'account-provider-free',
    seedId: 'seed-provider-free',
  };
  let activeBinding = binding;
  const policy = store.replacePolicy(
    binding,
    {
      currency: 'EUR',
      perActionLimitMinor: 5_000,
      dailyLimitMinor: 10_000,
      monthlyLimitMinor: 20_000,
      allowedOrigins: [...new Set(actionOrigins(fixture))],
      allowedActionKinds: [config.actionKind],
      expiresAt: '2026-08-18T12:00:00.000Z',
    },
    'Europe/Berlin'
  );
  if (!policy.ok) throw new Error(policy.reasonCode);

  for (const slot of config.slotManifest ?? []) {
    const registered = store.registerSecretHandle({
      binding,
      handleId: slot.handleId,
      type: slot.handleType,
      source: 'eve_keychain',
      sourceRef: `keychain:v1:${Buffer.from(`fixture-${slot.handleId}`).toString('base64')}`,
      actionKinds: [config.actionKind],
      targetOrigins: [actionTarget(fixture)],
      expiresAt: '2026-08-18T12:00:00.000Z',
    });
    if (!registered.ok) throw new Error(registered.reasonCode);
  }

  const injected: Uint8Array[] = [];
  const runner = new ExternalActionExecutionService(store, {
    resolveBinding: () => ({ ok: true, binding: activeBinding }),
    resolveConversationContext: () => ({
      context: {
        version: 'command-eve-external-action-conversation-context/v0',
        conversationId: 'conversation-provider-free',
        conversationSessionId: 'conversation-session-provider-free',
      },
    }),
    resolveAuthority: async () => ({
      decision: 'allow',
      authorityGrantId: 'grant-provider-free',
      riskClass: 'ordinary',
    }),
    secretResolver: {
      // Deliberately non-credential fixture bytes. They must be zeroed by the
      // broker after the in-process sink sees them.
      resolve: async () => Uint8Array.from([8, 6, 7, 5, 3, 0, 9]),
    },
    secretSink: {
      inject: async ({ material, slot }) => {
        injected.push(material);
        return { status: 'applied', deliveryRef: `delivery-${slot}` };
      },
    },
    adapterPayloadReader: {
      read: async ({ payloadRef, expectedPayloadDigest }) => {
        if (payloadRef !== fixture.payloadRef || expectedPayloadDigest !== fixture.payloadDigest) {
          throw new Error('unexpected provider-free payload reference');
        }
        return fixture.payload.slice();
      },
    },
    completionAttestationReader: {
      read: async ({ attestationRef, reservationId, challengeRef, binding: scoped, conversationContext }) => ({
        version: EXTERNAL_ACTION_COMPLETION_ATTESTATION_VERSION,
        attestationRef,
        reservationId,
        challengeRef,
        accountId: scoped.accountId,
        seedId: scoped.seedId,
        conversationId: conversationContext.conversationId,
        conversationSessionId: conversationContext.conversationSessionId,
        completedAt: NOW_ISO,
      }),
    },
    adapters: [fixture.adapter],
    now: () => new Date(NOW_ISO),
    randomUUID: () => `provider-free-execution-${++sequence}`,
  } satisfies ExternalActionExecutionDeps);

  return {
    root,
    file,
    store,
    binding,
    fixture,
    runner,
    injected,
    proposal: (suffix: string) => proposalFor(fixture, config, suffix),
    switchBinding: (next: EveExternalActionBinding) => {
      activeBinding = next;
    },
  };
}

function commerceEnvelope(suffix: string): ProviderFreeCommerceEnvelope {
  return {
    productCount: 1,
    cartDigest: digest(`cart:${suffix}`),
    quoteDigest: digest(`quote:${suffix}`),
    amount: { currency: 'EUR', minorUnits: 500 },
  };
}

function slots(kind: 'oauth' | 'otp' | 'payment'): readonly EveExternalActionSlotBinding[] {
  if (kind === 'oauth') return [{ slot: 'oauth_token', handleId: 'handle-oauth', handleType: 'oauth_token' }];
  if (kind === 'otp') return [{ slot: 'otp_code', handleId: 'handle-otp', handleType: 'otp_code' }];
  return [
    { slot: 'payment_cvc', handleId: 'handle-payment', handleType: 'payment_profile' },
    { slot: 'payment_expiry', handleId: 'handle-payment', handleType: 'payment_profile' },
    { slot: 'payment_pan', handleId: 'handle-payment', handleType: 'payment_profile' },
  ];
}

function identityConfig(input: {
  id: string;
  domain: 'email_identity' | 'phone_identity';
  action: string;
  actionKind: EveExternalActionKind;
  authMode?: 'oauth' | 'otp' | 'session';
  outcome?: 'committed' | 'needs_user';
  challengeKind?: 'oauth';
}): ProviderFreeExternalActionAdapterConfig {
  const authMode = input.authMode ?? 'session';
  return {
    id: input.id,
    counterpartyId: `counterparty-${input.id}`,
    scenario: {
      domain: input.domain,
      action: input.action as never,
      origins: providerFreeFixtureOriginsFor(input.domain, input.challengeKind),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.challengeKind ? { challengeKind: input.challengeKind } : {}),
    },
    actionKind: input.actionKind,
    authMode,
    ...(authMode === 'oauth'
      ? { authOrigins: [PROVIDER_FREE_FIXTURE_ORIGINS.oauth], slotManifest: slots('oauth') }
      : authMode === 'otp'
        ? { slotManifest: slots('otp') }
        : {}),
  };
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('provider-free identity, mail, phone, and commerce adapter binding', () => {
  it('keeps OAuth authorization origin separate from the mail action target and resumes only after consent', async () => {
    const harness = createHarness(
      identityConfig({
        id: 'adapter-mail-link',
        domain: 'email_identity',
        action: 'link',
        actionKind: 'browser_submit',
        authMode: 'oauth',
        outcome: 'needs_user',
        challengeKind: 'oauth',
      })
    );
    const first = await harness.runner.execute(harness.proposal('mail-link'));
    expect(first).toMatchObject({
      status: 'needs_user',
      authMode: 'oauth',
      eventReceipt: { challengeKind: 'oauth_consent', challengeOrigin: PROVIDER_FREE_FIXTURE_ORIGINS.oauth },
    });
    expect(harness.fixture.inspect()).toMatchObject({
      oauthProbeCalls: 1,
      executeCalls: 0,
      lastOAuthProbe: {
        authOrigin: PROVIDER_FREE_FIXTURE_ORIGINS.oauth,
        authOrigins: [PROVIDER_FREE_FIXTURE_ORIGINS.oauth],
        actionTargetOrigin: PROVIDER_FREE_FIXTURE_ORIGINS.mail,
        callbackRef: 'command-eve-main-oauth-callback/v1',
      },
    });
    const pending = harness.store.getPendingChallenge(harness.binding, first.reservationId!);
    expect(pending?.executionContract).toMatchObject({
      authOrigin: PROVIDER_FREE_FIXTURE_ORIGINS.oauth,
      authOrigins: [PROVIDER_FREE_FIXTURE_ORIGINS.oauth],
      targetOrigin: PROVIDER_FREE_FIXTURE_ORIGINS.mail,
    });

    harness.fixture.completeOAuthConsent();
    const resumed = await harness.runner.resume({
      version: EVE_EXTERNAL_ACTION_RESUME_VERSION,
      resumeRef: first.eventReceipt!.resumeRef,
    });
    expect(resumed).toMatchObject({
      status: 'allowed',
      receipt: { outcome: 'committed', domain: 'email_identity', action: 'link' },
    });
    expect(harness.fixture.inspect()).toMatchObject({
      oauthProbeCalls: 2,
      executeCalls: 1,
      lastExecute: { actionTargetOrigin: PROVIDER_FREE_FIXTURE_ORIGINS.mail, secretUseRefs: [{ slot: 'oauth_token' }] },
    });
  });

  it('covers mail verify/send/receive/revoke as isolated one-operation fixture instances', async () => {
    const cases: ReadonlyArray<readonly [string, EveExternalActionKind]> = [
      ['verify', 'browser_submit'],
      ['send', 'communication_send'],
      ['receive', 'browser_submit'],
      ['revoke', 'browser_submit'],
    ];
    for (const [action, actionKind] of cases) {
      const harness = createHarness(
        identityConfig({
          id: `adapter-mail-${action}`,
          domain: 'email_identity',
          action,
          actionKind,
          ...(action === 'verify' ? { authMode: 'otp' } : {}),
        })
      );
      const outcome = await harness.runner.execute(harness.proposal(`mail-${action}`));
      expect(outcome).toMatchObject({ status: 'allowed', receipt: { domain: 'email_identity', action } });
      expect(harness.fixture.adapter.operations).toHaveLength(1);
      expect(harness.fixture.inspect()).toMatchObject({ executeCalls: 1, resumeCalls: 0 });
    }
  });

  it('keeps SMS/OTP lifecycle receipts opaque and does not persist injected OTP bytes', async () => {
    const otp = createHarness(
      identityConfig({
        id: 'adapter-sms-otp-use',
        domain: 'phone_identity',
        action: 'otp_use',
        actionKind: 'browser_submit',
        authMode: 'otp',
      })
    );
    const otpOutcome = await otp.runner.execute(otp.proposal('sms-otp-use'));
    expect(otpOutcome).toMatchObject({
      status: 'allowed',
      receipt: { domain: 'phone_identity', action: 'otp_use', result: { challengeReceiptRef: expect.any(String) } },
    });
    expect(otp.fixture.inspect()).toMatchObject({
      executeCalls: 1,
      lastExecute: { authMode: 'otp', secretUseRefs: [{ slot: 'otp_code', deliveryRef: 'delivery-otp_code' }] },
    });
    expect(otp.injected).toHaveLength(1);
    expect([...otp.injected[0]!]).toEqual(Array(7).fill(0));
    expect(fs.readFileSync(otp.file).includes(Uint8Array.from([8, 6, 7, 5, 3, 0, 9]))).toBe(false);
    expect(JSON.stringify(otpOutcome)).not.toContain('handle-otp');

    for (const [action, actionKind] of [
      ['otp_receive', 'browser_submit'],
      ['sms_send', 'communication_send'],
      ['sms_receive', 'browser_submit'],
      ['revoke', 'browser_submit'],
    ] as const) {
      const harness = createHarness(
        identityConfig({ id: `adapter-sms-${action}`, domain: 'phone_identity', action, actionKind })
      );
      const outcome = await harness.runner.execute(harness.proposal(`sms-${action}`));
      expect(outcome).toMatchObject({ status: 'allowed', receipt: { domain: 'phone_identity', action } });
      expect(harness.fixture.adapter.operations).toHaveLength(1);
    }
  });

  it('keeps 3DS at the checkout action target, binds payment fields through opaque handles, and resumes from an attestation', async () => {
    const commerce = commerceEnvelope('3ds');
    const config: ProviderFreeExternalActionAdapterConfig = {
      id: 'adapter-merchant-3ds',
      counterpartyId: 'counterparty-merchant-3ds',
      scenario: {
        domain: 'commerce',
        action: 'purchase',
        origins: providerFreeFixtureOriginsFor('commerce', '3ds'),
        outcome: 'needs_user',
        challengeKind: '3ds',
      },
      actionKind: 'purchase',
      authMode: 'payment_fields',
      slotManifest: slots('payment'),
      commerce,
    };
    const harness = createHarness(config);
    const first = await harness.runner.execute(harness.proposal('merchant-3ds'));
    expect(first).toMatchObject({
      status: 'needs_user',
      eventReceipt: {
        challengeKind: '3ds',
        challengeOrigin: PROVIDER_FREE_FIXTURE_ORIGINS.threeDs,
        origins: [PROVIDER_FREE_FIXTURE_ORIGINS.merchant, PROVIDER_FREE_FIXTURE_ORIGINS.threeDs],
      },
    });
    expect(harness.fixture.inspect()).toMatchObject({
      executeCalls: 1,
      resumeCalls: 0,
      lastExecute: {
        authMode: 'payment_fields',
        actionTargetOrigin: PROVIDER_FREE_FIXTURE_ORIGINS.threeDs,
        secretUseRefs: [
          { slot: 'payment_cvc', deliveryRef: 'delivery-payment_cvc' },
          { slot: 'payment_expiry', deliveryRef: 'delivery-payment_expiry' },
          { slot: 'payment_pan', deliveryRef: 'delivery-payment_pan' },
        ],
      },
    });
    for (const material of harness.injected) expect([...material]).toEqual(Array(7).fill(0));
    expect(JSON.stringify(first)).not.toContain('handle-payment');
    expect(fs.readFileSync(harness.file).includes(Uint8Array.from([8, 6, 7, 5, 3, 0, 9]))).toBe(false);

    const resumed = await harness.runner.resume({
      version: EVE_EXTERNAL_ACTION_RESUME_VERSION,
      resumeRef: first.eventReceipt!.resumeRef,
      completionAttestationRef: 'attestation-merchant-3ds',
    });
    expect(resumed).toMatchObject({ status: 'allowed', receipt: { outcome: 'committed', domain: 'commerce' } });
    expect(harness.fixture.inspect()).toMatchObject({
      executeCalls: 1,
      resumeCalls: 1,
      lastResume: {
        authMode: 'payment_fields',
        challengeOrigin: PROVIDER_FREE_FIXTURE_ORIGINS.threeDs,
        completionAttestationPresent: true,
      },
    });
  });

  it('records possible merchant effects as unknown and never blindly retries the fixture action', async () => {
    const commerce = commerceEnvelope('unknown');
    const config: ProviderFreeExternalActionAdapterConfig = {
      id: 'adapter-merchant-unknown',
      counterpartyId: 'counterparty-merchant-unknown',
      scenario: {
        domain: 'commerce',
        action: 'purchase',
        origins: providerFreeFixtureOriginsFor('commerce'),
        outcome: 'possible_effect_unknown',
      },
      actionKind: 'purchase',
      authMode: 'payment_fields',
      slotManifest: slots('payment'),
      commerce,
    };
    const harness = createHarness(config);
    const proposal = harness.proposal('merchant-unknown');
    const first = await harness.runner.execute(proposal);
    expect(first).toMatchObject({
      status: 'unknown_outcome',
      reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
      retryAllowed: false,
    });
    const replay = await harness.runner.execute(proposal);
    expect(replay).toMatchObject({ status: 'unknown_outcome', retryAllowed: false, replay: true });
    expect(harness.fixture.inspect()).toMatchObject({ executeCalls: 1 });
  });

  it('fails closed across account/seed switch, policy revoke, and Main restart without re-executing OAuth', async () => {
    for (const bindingChange of [{ accountId: 'account-switched' }, { seedId: 'seed-switched' }]) {
      const harness = createHarness(
        identityConfig({
          id: `adapter-mail-isolation-${Object.keys(bindingChange)[0]}`,
          domain: 'email_identity',
          action: 'link',
          actionKind: 'browser_submit',
          authMode: 'oauth',
          outcome: 'needs_user',
          challengeKind: 'oauth',
        })
      );
      const first = await harness.runner.execute(harness.proposal(`isolation-${Object.keys(bindingChange)[0]}`));
      harness.switchBinding({ ...harness.binding, ...bindingChange });
      expect(
        await harness.runner.resume({
          version: EVE_EXTERNAL_ACTION_RESUME_VERSION,
          resumeRef: first.eventReceipt!.resumeRef,
        })
      ).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_RESUME_NOT_ACTIVE' });
      expect(harness.fixture.inspect()).toMatchObject({ executeCalls: 0 });
    }

    const revoked = createHarness(
      identityConfig({
        id: 'adapter-mail-revoked',
        domain: 'email_identity',
        action: 'link',
        actionKind: 'browser_submit',
        authMode: 'oauth',
        outcome: 'needs_user',
        challengeKind: 'oauth',
      })
    );
    const revokedFirst = await revoked.runner.execute(revoked.proposal('revoked'));
    expect(revoked.store.revokePolicy(revoked.binding)).toMatchObject({ ok: true });
    expect(
      await revoked.runner.resume({
        version: EVE_EXTERNAL_ACTION_RESUME_VERSION,
        resumeRef: revokedFirst.eventReceipt!.resumeRef,
      })
    ).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_RESUME_NOT_ACTIVE' });
    expect(revoked.fixture.inspect()).toMatchObject({ executeCalls: 0 });

    const restarted = createHarness(
      identityConfig({
        id: 'adapter-mail-restart',
        domain: 'email_identity',
        action: 'link',
        actionKind: 'browser_submit',
        authMode: 'oauth',
        outcome: 'needs_user',
        challengeKind: 'oauth',
      })
    );
    const suspended = await restarted.runner.execute(restarted.proposal('restart'));
    restarted.store.close();
    stores.delete(restarted.store);
    const reopened = new ExternalActionStore(new NodeSqliteDriver(restarted.file), {
      now: () => new Date(NOW_ISO),
      randomUUID: () => `provider-free-restart-${++sequence}`,
    });
    stores.add(reopened);
    const restartedRunner = new ExternalActionExecutionService(reopened, {
      resolveBinding: () => ({ ok: true, binding: restarted.binding }),
      resolveConversationContext: () => ({
        context: {
          version: 'command-eve-external-action-conversation-context/v0',
          conversationId: 'conversation-provider-free',
          conversationSessionId: 'conversation-session-provider-free',
        },
      }),
      resolveAuthority: async () => ({
        decision: 'allow',
        authorityGrantId: 'grant-provider-free',
        riskClass: 'ordinary',
      }),
      secretResolver: { resolve: async () => Uint8Array.from([8, 6, 7, 5, 3, 0, 9]) },
      adapterPayloadReader: { read: async () => restarted.fixture.payload.slice() },
      adapters: [restarted.fixture.adapter],
      now: () => new Date(NOW_ISO),
      randomUUID: () => `provider-free-restarted-${++sequence}`,
    } satisfies ExternalActionExecutionDeps);
    expect(
      await restartedRunner.resume({
        version: EVE_EXTERNAL_ACTION_RESUME_VERSION,
        resumeRef: suspended.eventReceipt!.resumeRef,
      })
    ).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_RESUME_NOT_ACTIVE' });
    expect(restarted.fixture.inspect()).toMatchObject({ executeCalls: 0 });
  });
});
