import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVE_EXTERNAL_ACTION_PROPOSAL_VERSION,
  type EveExternalActionProposal,
  type EveExternalActionSlotBinding,
} from '@/common/config/eveExternalActionExecutionCore';
import type { EveExternalActionBinding } from '@/common/config/eveExternalActionPolicyCore';
import {
  EXTERNAL_ACTION_ADAPTER_PAYLOAD_VALIDATION_VERSION,
  ExternalActionExecutionService,
  type ExternalActionAdapter,
  type ExternalActionExecutionDeps,
} from '@/process/services/external-action/externalActionExecutionService';
import { ExternalActionStore } from '@/process/services/external-action/externalActionStore';
import type { SecretMaterialResolver } from '@/process/services/external-action/secretUseBroker';
import { NodeSqliteDriver } from './testSqliteDriver';

const NOW_ISO = '2026-08-11T12:00:00.000Z';
const ORIGIN = 'https://shop.example';
const MERCHANT_ORIGIN = 'https://merchant.example';
const OTHER_ORIGIN = 'https://evil.example';
const OAUTH_REF = `keychain:v1:${Buffer.from('oauth-ciphertext-material').toString('base64')}`;
const PASSWORD_REF = `keychain:v1:${Buffer.from('password-ciphertext-material').toString('base64')}`;
const PAYMENT_REF = `keychain:v1:${Buffer.from('payment-ciphertext-material').toString('base64')}`;
const roots: string[] = [];
const stores = new Set<ExternalActionStore>();
let sequence = 0;

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function payloadValidator(
  input: {
    authMode?: 'oauth' | 'password' | 'otp' | 'payment_fields' | 'session' | 'none';
    slotManifest?: readonly EveExternalActionSlotBinding[];
    commerce?: Readonly<{
      productCount: number;
      cartDigest: string;
      quoteDigest: string;
      amount: { currency: string; minorUnits: number };
    }>;
  } = {}
): NonNullable<ExternalActionAdapter['validatePayload']> {
  return (payload, context) => ({
    version: EXTERNAL_ACTION_ADAPTER_PAYLOAD_VALIDATION_VERSION,
    canonicalPayloadDigest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
    authMode: input.authMode ?? 'none',
    domain: context.domain,
    action: context.action,
    counterpartyId: context.counterpartyId,
    origins: context.origins,
    slotManifest: input.slotManifest ?? [],
    ...(input.commerce ? { commerce: input.commerce } : {}),
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-execution-service-'));
  roots.push(root);
  const file = path.join(root, 'ledger.sqlite3');
  const store = new ExternalActionStore(new NodeSqliteDriver(file), {
    now: () => new Date(NOW_ISO),
    randomUUID: () => `store-${++sequence}`,
  });
  stores.add(store);
  const binding: EveExternalActionBinding = {
    installationId: store.getInstallationId(),
    accountId: 'account-a',
    seedId: 'seed-a',
  };
  const policy = store.replacePolicy(
    binding,
    {
      currency: 'EUR',
      perActionLimitMinor: 1_000,
      dailyLimitMinor: 2_000,
      monthlyLimitMinor: 10_000,
      allowedOrigins: [ORIGIN],
      allowedActionKinds: ['purchase'],
      expiresAt: '2026-08-18T12:00:00.000Z',
    },
    'Europe/Berlin'
  );
  if ('reasonCode' in policy) throw new Error(policy.reasonCode);
  for (const handle of [
    { handleId: 'oauth-handle', type: 'oauth_token' as const, ref: OAUTH_REF },
    { handleId: 'password-handle', type: 'account_credential' as const, ref: PASSWORD_REF },
  ]) {
    const registered = store.registerSecretHandle({
      binding,
      handleId: handle.handleId,
      type: handle.type,
      source: 'eve_keychain',
      sourceRef: handle.ref,
      actionKinds: ['purchase'],
      targetOrigins: [ORIGIN],
      expiresAt: '2026-08-18T12:00:00.000Z',
    });
    if ('reasonCode' in registered) throw new Error(registered.reasonCode);
  }
  return { root, file, store, binding };
}

function proposal(overrides: Partial<EveExternalActionProposal> = {}): EveExternalActionProposal {
  return {
    version: EVE_EXTERNAL_ACTION_PROPOSAL_VERSION,
    clientRequestId: 'client-request-a',
    idempotencyKey: 'idempotency-a',
    action: {
      kind: 'purchase',
      targetOrigin: ORIGIN,
      argumentsDigest: digest('a'),
      quoteDigest: digest('b'),
      amount: { currency: 'EUR', minorUnits: 500 },
    },
    oauthHandleId: 'oauth-handle',
    passwordHandleId: 'password-handle',
    ...overrides,
  };
}

function adapter(overrides: Partial<ExternalActionAdapter> = {}): ExternalActionAdapter {
  return {
    id: 'synthetic-shop-adapter',
    providerOrMerchantLabelCode: 'fixture_merchant',
    operations: [
      {
        actionKind: 'purchase' as const,
        domain: 'generic' as const,
        action: 'op:purchase',
        counterpartyId: 'merchant-fixture',
        providerOrigin: ORIGIN,
      },
    ],
    supports: { oauth: true, browserSession: true, password: true, unauthenticated: false },
    classifyRisk: () => 'ordinary',
    probeOAuth: async () => 'ready',
    probeBrowserSession: async () => 'unavailable',
    execute: async () => ({ status: 'allowed' }),
    ...overrides,
  };
}

function service(input: {
  store: ExternalActionStore;
  binding: EveExternalActionBinding;
  adapter: ExternalActionAdapter;
  resolver?: SecretMaterialResolver;
  bindingOverride?: EveExternalActionBinding;
  resolveBinding?: ExternalActionExecutionDeps['resolveBinding'];
  resolveConversationContext?: ExternalActionExecutionDeps['resolveConversationContext'];
  resolveAuthority?: ExternalActionExecutionDeps['resolveAuthority'];
  adapterPayloadReader?: ExternalActionExecutionDeps['adapterPayloadReader'];
  completionAttestationReader?: ExternalActionExecutionDeps['completionAttestationReader'];
  reconciliationEvidenceReader?: ExternalActionExecutionDeps['reconciliationEvidenceReader'];
  secretSink?: ExternalActionExecutionDeps['secretSink'];
}) {
  return new ExternalActionExecutionService(input.store, {
    resolveBinding: input.resolveBinding ?? (() => ({ ok: true, binding: input.bindingOverride ?? input.binding })),
    resolveConversationContext:
      input.resolveConversationContext ??
      (() => ({
        context: {
          version: 'command-eve-external-action-conversation-context/v0',
          conversationId: 'conversation-a',
          conversationSessionId: 'conversation-session-a',
        },
      })),
    resolveAuthority:
      input.resolveAuthority ??
      (async () => ({ decision: 'allow', authorityGrantId: 'grant-test', riskClass: 'ordinary' })),
    secretResolver:
      input.resolver ??
      ({
        resolve: async ({ sourceRef }) =>
          new TextEncoder().encode(sourceRef === OAUTH_REF ? 'synthetic-refresh-token' : 'synthetic-password'),
      } satisfies SecretMaterialResolver),
    secretSink:
      input.secretSink ??
      ({
        inject: async ({ slot }) => ({ status: 'applied' as const, deliveryRef: `delivery:${slot}` }),
      } satisfies NonNullable<ExternalActionExecutionDeps['secretSink']>),
    ...(input.adapterPayloadReader ? { adapterPayloadReader: input.adapterPayloadReader } : {}),
    ...(input.completionAttestationReader ? { completionAttestationReader: input.completionAttestationReader } : {}),
    ...(input.reconciliationEvidenceReader ? { reconciliationEvidenceReader: input.reconciliationEvidenceReader } : {}),
    adapters: [input.adapter],
    now: () => new Date(NOW_ISO),
    randomUUID: () => `execution-${++sequence}`,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ExternalActionExecutionService Main-owned seam', () => {
  it('prefers OAuth, permits renewal inside the trusted adapter and executes an exact replay at most once', async () => {
    const { store, binding } = fixture();
    const injected: Uint8Array[] = [];
    const execute = vi.fn(async ({ authMode, secretUseRefs }) => {
      expect(authMode).toBe('oauth');
      expect(secretUseRefs).toEqual([{ slot: 'oauth_token', deliveryRef: 'delivery:oauth_token' }]);
      // Synthetic renewal happens here, inside the trusted adapter. No token is
      // returned in the sanitized outcome.
      return { status: 'allowed' as const };
    });
    const runner = service({
      store,
      binding,
      adapter: adapter({ execute }),
      secretSink: {
        inject: async ({ material, slot }) => {
          expect(new TextDecoder().decode(material)).toBe('synthetic-refresh-token');
          injected.push(material);
          return { status: 'applied', deliveryRef: `delivery:${slot}` };
        },
      },
    });

    const first = await runner.execute(proposal());
    const replay = await runner.execute(proposal());
    expect(first).toMatchObject({ status: 'allowed', authMode: 'oauth' });
    expect(replay).toMatchObject({ status: 'allowed', replay: true, reservationId: first.reservationId });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(injected).toHaveLength(1);
    expect([...injected[0]!]).toEqual(Array(injected[0]!.length).fill(0));
    expect(JSON.stringify([first, replay])).not.toContain('synthetic-refresh-token');
  });

  it('never accepts a password handle in the OAuth slot', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const outcome = await service({ store, binding, adapter: adapter({ execute }) }).execute(
      proposal({ oauthHandleId: 'password-handle' })
    );
    expect(outcome).toMatchObject({
      status: 'denied',
      reasonCode: 'POLICY_DENIED',
    });
    expect(store.getReservation(binding, outcome.reservationId!)?.state).toBe('denied');
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks semantic replay even when request, idempotency and policy revision are changed', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const runner = service({ store, binding, adapter: adapter({ execute }) });
    expect(await runner.execute(proposal())).toMatchObject({ status: 'allowed' });

    const current = store.getPolicy(binding)!;
    expect(
      store.replacePolicy(
        binding,
        {
          currency: current.currency,
          perActionLimitMinor: current.perActionLimitMinor,
          dailyLimitMinor: current.dailyLimitMinor,
          monthlyLimitMinor: current.monthlyLimitMinor,
          allowedOrigins: current.allowedOrigins,
          allowedActionKinds: current.allowedActionKinds,
          expiresAt: current.expiresAt,
        },
        current.timezone
      )
    ).toMatchObject({ ok: true, policy: { revision: 2 } });
    expect(
      store.registerSecretHandle({
        binding,
        handleId: 'oauth-handle-rotated',
        type: 'oauth_token',
        source: 'eve_keychain',
        sourceRef: `keychain:v1:${Buffer.from('rotated-oauth-ciphertext').toString('base64')}`,
        actionKinds: ['purchase'],
        targetOrigins: [ORIGIN],
        expiresAt: '2026-08-18T12:00:00.000Z',
      })
    ).toEqual({ ok: true });

    expect(
      await runner.execute(
        proposal({
          clientRequestId: 'fresh-client-request',
          idempotencyKey: 'fresh-idempotency-key',
          oauthHandleId: 'oauth-handle-rotated',
        })
      )
    ).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_REPLAY_CONFLICT' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('returns needs_user for MFA/risk auth challenges and never falls back to password', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const runner = service({
      store,
      binding,
      adapter: adapter({ probeOAuth: async () => 'needs_user', execute }),
    });
    expect(await runner.execute(proposal())).toMatchObject({
      status: 'needs_user',
      reasonCode: 'COMPLETE_OAUTH_CONSENT',
      authMode: 'oauth',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reduces an auth-probe exception to a fixed needs_user result without leaking its message', async () => {
    const { store, binding, file } = fixture();
    const leaked = 'synthetic-auth-probe-secret';
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const runner = service({
      store,
      binding,
      adapter: adapter({
        probeOAuth: async () => {
          throw new Error(leaked);
        },
        execute,
      }),
    });
    const outcome = await runner.execute(proposal());
    expect(outcome).toMatchObject({ status: 'needs_user', reasonCode: 'EXTERNAL_AUTH_PROBE_UNAVAILABLE' });
    expect(JSON.stringify(outcome)).not.toContain(leaked);
    expect(fs.readFileSync(file).includes(Buffer.from(leaked))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses password only after OAuth and the isolated browser session explicitly report unavailable', async () => {
    const { store, binding } = fixture();
    const injected: Uint8Array[] = [];
    const execute = vi.fn(async ({ authMode, secretUseRefs, browserPartition }) => {
      expect(authMode).toBe('password');
      expect(secretUseRefs).toEqual([{ slot: 'account_password', deliveryRef: 'delivery:account_password' }]);
      expect(browserPartition).toBeUndefined();
      return { status: 'allowed' as const };
    });
    const runner = service({
      store,
      binding,
      adapter: adapter({
        probeOAuth: async () => 'unavailable',
        probeBrowserSession: async () => 'unavailable',
        execute,
      }),
      secretSink: {
        inject: async ({ material, slot }) => {
          expect(new TextDecoder().decode(material)).toBe('synthetic-password');
          injected.push(material);
          return { status: 'applied', deliveryRef: `delivery:${slot}` };
        },
      },
    });
    expect(await runner.execute(proposal())).toMatchObject({ status: 'allowed', authMode: 'password' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect([...injected[0]!]).toEqual(Array(injected[0]!.length).fill(0));
  });

  it('fails closed for wrong account, seed and origin before any adapter call', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const wrongAccount = service({
      store,
      binding,
      adapter: adapter({ execute }),
      bindingOverride: { ...binding, accountId: 'account-b' },
    });
    const wrongSeed = service({
      store,
      binding,
      adapter: adapter({ execute }),
      bindingOverride: { ...binding, seedId: 'seed-b' },
    });
    const right = service({
      store,
      binding,
      adapter: adapter({
        execute,
        operations: [
          {
            actionKind: 'purchase' as const,
            domain: 'generic' as const,
            action: 'op:purchase',
            counterpartyId: 'merchant-fixture',
            providerOrigin: ORIGIN,
          },
          {
            actionKind: 'purchase' as const,
            domain: 'generic' as const,
            action: 'op:purchase-mirror',
            counterpartyId: 'merchant-fixture',
            providerOrigin: OTHER_ORIGIN,
          },
        ],
      }),
    });
    expect(await wrongAccount.execute(proposal())).toMatchObject({ status: 'denied' });
    expect(await wrongSeed.execute(proposal())).toMatchObject({ status: 'denied' });
    expect(
      await right.execute(proposal({ action: { ...proposal().action, targetOrigin: OTHER_ORIGIN } }))
    ).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_POLICY_ORIGIN_DENIED' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('blocks a seat switch that occurs while Main resolves a credential', async () => {
    const { store, binding } = fixture();
    let activeBinding = binding;
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const runner = service({
      store,
      binding,
      adapter: adapter({ execute }),
      resolveBinding: () => ({ ok: true, binding: activeBinding }),
      resolver: {
        resolve: async () => {
          activeBinding = { ...binding, seedId: 'seed-switched' };
          return new TextEncoder().encode('synthetic-refresh-token');
        },
      },
    });
    const outcome = await runner.execute(proposal());
    expect(outcome).toMatchObject({ status: 'denied', reasonCode: 'BINDING_MISMATCH' });
    expect(execute).not.toHaveBeenCalled();
    expect(store.getReservation(binding, outcome.reservationId!)?.state).toBe('denied');
  });

  it('marks a crash-window adapter throw unknown and never retries it', async () => {
    const { store, binding } = fixture();
    const secret = 'synthetic-adapter-secret-in-error';
    const execute = vi.fn(async () => {
      throw new Error(secret);
    });
    const runner = service({ store, binding, adapter: adapter({ execute }) });
    const first = await runner.execute(proposal());
    const replay = await runner.execute(proposal());
    expect(first).toMatchObject({ status: 'unknown_outcome' });
    expect(replay).toMatchObject({ status: 'unknown_outcome', replay: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([first, replay, store.readAuditEvents(binding)])).not.toContain(secret);
  });

  it('reconciles unknown only through a Main-owned evidence port and never re-enters the adapter', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => {
      throw new Error('synthetic post-effect crash');
    });
    const readEvidence = vi.fn(async ({ evidenceRef, reconciliationRef, reservationId, binding: scoped }) => ({
      version: 'command-eve-external-action-reconciliation-evidence/v0' as const,
      evidenceRef,
      reservationId,
      reconciliationRef,
      decision: 'reconciled_no_effect' as const,
      evidenceDigest: digest('7'),
      authorityReceiptDigest: digest('8'),
      actorRef: 'actor-reconciliation-fixture',
      accountId: scoped.accountId,
      seedId: scoped.seedId,
      observedAt: NOW_ISO,
    }));
    const runner = service({
      store,
      binding,
      adapter: adapter({ execute }),
      reconciliationEvidenceReader: { read: readEvidence },
    });
    const unknown = await runner.execute(proposal());
    expect(unknown).toMatchObject({
      status: 'unknown_outcome',
      retryAllowed: false,
      receipt: { outcome: 'unknown_outcome', reconciliationRef: expect.stringMatching(/^reconciliation:/) },
    });
    expect(store.getBudgetUsedToday(binding, 'EUR')).toBe(500);
    const reconciled = await runner.reconcileFromMain({
      version: 'command-eve-external-action-reconciliation-request/v0',
      reconciliationRef: unknown.receipt!.reconciliationRef!,
      evidenceRef: 'evidence-fixture-a',
    });
    expect(reconciled).toMatchObject({
      status: 'reconciled_no_effect',
      retryAllowed: false,
      receipt: {
        outcome: 'reconciled_no_effect',
        reconciliationRef: unknown.receipt!.reconciliationRef,
        priorReceiptRef: unknown.receipt!.receiptRef,
        evidenceDigest: digest('7'),
      },
    });
    expect(store.getBudgetUsedToday(binding, 'EUR')).toBe(0);
    expect(await runner.execute(proposal())).toMatchObject({ status: 'reconciled_no_effect', replay: true });
    expect(
      await runner.reconcileFromMain({
        version: 'command-eve-external-action-reconciliation-request/v0',
        reconciliationRef: unknown.receipt!.reconciliationRef!,
        evidenceRef: 'evidence-fixture-a',
      })
    ).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_RECONCILIATION_NOT_ACTIVE' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(readEvidence).toHaveBeenCalledTimes(1);
  });

  it('reports unknown when revoke wins a mid-flight race, even if the adapter reports success', async () => {
    const { store, binding } = fixture();
    const runner = service({
      store,
      binding,
      adapter: adapter({
        execute: async () => {
          expect(store.revokePolicy(binding)).toMatchObject({ ok: true });
          return { status: 'allowed' };
        },
      }),
    });
    expect(await runner.execute(proposal())).toMatchObject({
      status: 'unknown_outcome',
      reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
    });
  });

  it('rejects plaintext/unknown proposal fields and never writes them to result, log or SQLite', async () => {
    const { store, binding, file } = fixture();
    const leaked = 'synthetic-plaintext-renderer-secret';
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runner = service({ store, binding, adapter: adapter() });
    const untrusted = { ...proposal(), secret: leaked };
    const outcome = await runner.execute(untrusted);
    expect(outcome).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_PROPOSAL_FIELDS_INVALID' });
    expect(JSON.stringify(outcome)).not.toContain(leaked);
    expect(fs.readFileSync(file).includes(Buffer.from(leaked))).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain(leaked);
  });

  it('suspends an OAuth challenge and resumes the same claim exactly once through a Main-only ref', async () => {
    const { store, binding } = fixture();
    let ready = false;
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const runner = service({
      store,
      binding,
      adapter: adapter({ probeOAuth: async () => (ready ? 'ready' : 'needs_user'), execute }),
    });
    const first = await runner.execute(proposal());
    expect(first).toMatchObject({
      status: 'needs_user',
      authMode: 'oauth',
      eventReceipt: {
        version: 'command-eve-agent-external-action-event-receipt/v0',
        challengeKind: 'oauth_consent',
        origins: [ORIGIN],
      },
      workbenchCard: {
        conversationId: 'conversation-a',
        status: 'needs_user',
        needsUser: { kind: 'oauth_consent' },
        affordances: ['resume', 'revoke', 'stop'],
      },
    });
    expect(first).not.toHaveProperty('challenge');
    expect(first).not.toHaveProperty('resumeRef');
    expect(first.eventReceipt?.resumeRef).toMatch(/^resume-ref:/);
    expect(JSON.stringify(first)).not.toContain('resume:execution-');
    expect(store.getReservation(binding, first.reservationId!)?.state).toBe('suspended');

    const replay = await runner.execute(proposal());
    expect(replay).toMatchObject({ status: 'needs_user', replay: true, reservationId: first.reservationId });
    expect(replay.eventReceipt).toEqual(first.eventReceipt);
    ready = true;
    const resumed = await runner.resume({
      version: 'command-eve-external-action-resume/v1',
      resumeRef: first.eventReceipt!.resumeRef,
    });
    expect(resumed).toMatchObject({ status: 'allowed', reservationId: first.reservationId });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      await runner.resume({
        version: 'command-eve-external-action-resume/v1',
        resumeRef: first.eventReceipt!.resumeRef,
      })
    ).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_RESUME_NOT_ACTIVE' });
  });

  it('persists the event receipt across restart but never reissues or blind-retries the Main-only bearer', async () => {
    const { store, binding, file } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const firstRunner = service({
      store,
      binding,
      adapter: adapter({ probeOAuth: async () => 'needs_user', execute }),
    });
    const suspended = await firstRunner.execute(proposal());
    expect(suspended).toMatchObject({ status: 'needs_user', eventReceipt: { challengeKind: 'oauth_consent' } });
    store.close();
    stores.delete(store);

    const reopened = new ExternalActionStore(new NodeSqliteDriver(file), {
      now: () => new Date(NOW_ISO),
      randomUUID: () => `restart-${++sequence}`,
    });
    stores.add(reopened);
    const restartedRunner = service({
      store: reopened,
      binding,
      adapter: adapter({ probeOAuth: async () => 'ready', execute }),
    });
    const replay = await restartedRunner.execute(proposal());
    expect(replay.eventReceipt).toEqual(suspended.eventReceipt);
    expect(
      await restartedRunner.resume({
        version: 'command-eve-external-action-resume/v1',
        resumeRef: suspended.eventReceipt!.resumeRef,
      })
    ).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_RESUME_NOT_ACTIVE' });
    expect(reopened.getReservation(binding, suspended.reservationId!)?.state).toBe('suspended');
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses adapter.resume after an adapter challenge and never re-executes or re-resolves the credential', async () => {
    const { store, binding } = fixture();
    const resolve = vi.fn(async () => new TextEncoder().encode('synthetic-refresh-token'));
    const execute = vi.fn(async () => ({
      status: 'needs_user' as const,
      continuation: 'adapter_resume' as const,
      continuationRef: 'continuation-3ds-provider',
      effectState: 'challenge_pending_no_effect' as const,
      reasonCode: 'COMPLETE_3DS',
      challenge: {
        kind: '3ds' as const,
        challengeRef: 'challenge-3ds-provider',
        origin: ORIGIN,
        expiresAt: '2026-08-11T12:05:00.000Z',
        userInstructionCode: 'COMPLETE_3DS' as const,
      },
    }));
    const resume = vi.fn(async ({ completionAttestationDigest, completionAttestationPresent }) => {
      expect(completionAttestationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(completionAttestationPresent).toBe(true);
      return { status: 'allowed' as const };
    });
    const readAttestation = vi.fn(
      async ({ attestationRef, reservationId, challengeRef, binding: scoped, conversationContext }) => ({
        version: 'command-eve-external-action-completion-attestation/v0' as const,
        attestationRef,
        reservationId,
        challengeRef,
        accountId: scoped.accountId,
        seedId: scoped.seedId,
        conversationId: conversationContext.conversationId,
        conversationSessionId: conversationContext.conversationSessionId,
        completedAt: NOW_ISO,
      })
    );
    const runner = service({
      store,
      binding,
      resolver: { resolve },
      adapter: adapter({ execute, resume }),
      completionAttestationReader: { read: readAttestation },
    });
    const suspended = await runner.execute(proposal());
    expect(suspended).toMatchObject({ status: 'needs_user', eventReceipt: { challengeKind: '3ds' } });
    const completed = await runner.resume({
      version: 'command-eve-external-action-resume/v1',
      resumeRef: suspended.eventReceipt!.resumeRef,
      completionAttestationRef: 'completion-attestation-a',
    });
    expect(completed).toMatchObject({ status: 'allowed', reservationId: suspended.reservationId });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(readAttestation).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('requires a trusted adapter risk attestation and HumanGates legal/high-risk classifications', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const missing = adapter({ classifyRisk: undefined as unknown as ExternalActionAdapter['classifyRisk'], execute });
    expect(await service({ store, binding, adapter: missing }).execute(proposal())).toMatchObject({
      status: 'needs_user',
      reasonCode: 'EXTERNAL_RISK_CLASSIFICATION_REQUIRED',
    });
    const highRisk = adapter({ classifyRisk: () => 'high_risk_finance', execute });
    expect(await service({ store, binding, adapter: highRisk }).execute(proposal())).toMatchObject({
      status: 'needs_user',
      reasonCode: 'EXTERNAL_ACTION_HUMAN_GATE_REQUIRED',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('injects a bound multi-slot set once and returns only a sanitized receipt/workbench projection', async () => {
    const { store, binding, file } = fixture();
    expect(
      store.replacePolicy(
        binding,
        {
          currency: 'EUR',
          perActionLimitMinor: 1_000,
          dailyLimitMinor: 2_000,
          monthlyLimitMinor: 10_000,
          allowedOrigins: [MERCHANT_ORIGIN, ORIGIN],
          allowedActionKinds: ['purchase'],
          expiresAt: '2026-08-18T12:00:00.000Z',
        },
        'Europe/Berlin'
      )
    ).toMatchObject({ ok: true });
    expect(
      store.registerSecretHandle({
        binding,
        handleId: 'payment-handle',
        type: 'payment_profile',
        source: 'eve_keychain',
        sourceRef: PAYMENT_REF,
        actionKinds: ['purchase'],
        targetOrigins: [ORIGIN],
        expiresAt: '2026-08-18T12:00:00.000Z',
      })
    ).toEqual({ ok: true });
    const payload = new TextEncoder().encode('synthetic-provider-payload');
    const visibleDuringCall: Uint8Array[] = [];
    const execute = vi.fn(async ({ secretUseRefs, adapterPayload }) => {
      expect(secretUseRefs).toEqual([
        { slot: 'payment_cvc', deliveryRef: 'delivery:payment_cvc' },
        { slot: 'payment_expiry', deliveryRef: 'delivery:payment_expiry' },
        { slot: 'payment_pan', deliveryRef: 'delivery:payment_pan' },
      ]);
      expect(new TextDecoder().decode(adapterPayload)).toBe('synthetic-provider-payload');
      visibleDuringCall.push(adapterPayload!);
      return {
        status: 'allowed' as const,
        result: {
          domain: 'commerce' as const,
          action: 'purchase' as const,
          purchaseRef: 'purchase-fixture',
          productDigest: digest('7'),
          amount: { currency: 'EUR', minorUnits: 500 },
          providerReceiptDigest: digest('8'),
        },
      };
    });
    const resolve = vi.fn(async ({ sourceRef }: { sourceRef: string }) => {
      if (sourceRef === OAUTH_REF) return new TextEncoder().encode('synthetic-refresh-token');
      if (sourceRef === PAYMENT_REF) return new TextEncoder().encode('synthetic-payment-pan');
      throw new Error('unused password must not resolve');
    });
    const multiSlotProposal = proposal({
      oauthHandleId: undefined,
      passwordHandleId: undefined,
      action: {
        ...proposal().action,
        adapterPayloadRef: 'payload-ref-multi-slot',
        adapterPayloadDigest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
      },
    });
    const commerceAdapter = adapter({
      operations: [
        {
          actionKind: 'purchase' as const,
          domain: 'commerce' as const,
          action: 'purchase' as const,
          counterpartyId: 'merchant-fixture',
          merchantOrigin: MERCHANT_ORIGIN,
          checkoutOrigin: ORIGIN,
        },
      ],
      supports: {
        oauth: false,
        browserSession: false,
        password: false,
        paymentFields: true,
        unauthenticated: false,
      },
      validatePayload: payloadValidator({
        authMode: 'payment_fields',
        slotManifest: [
          { slot: 'payment_cvc', handleId: 'payment-handle', handleType: 'payment_profile' },
          { slot: 'payment_expiry', handleId: 'payment-handle', handleType: 'payment_profile' },
          { slot: 'payment_pan', handleId: 'payment-handle', handleType: 'payment_profile' },
        ],
        commerce: {
          productCount: 2,
          cartDigest: digest('a'),
          quoteDigest: digest('b'),
          amount: { currency: 'EUR', minorUnits: 500 },
        },
      }),
      execute,
    });
    const runner = service({
      store,
      binding,
      adapter: commerceAdapter,
      resolver: { resolve },
      adapterPayloadReader: { read: async () => payload.slice() },
      secretSink: {
        inject: async ({ material, slot }) => {
          expect(new TextDecoder().decode(material)).toBe('synthetic-payment-pan');
          visibleDuringCall.push(material);
          return { status: 'applied', deliveryRef: `delivery:${slot}` };
        },
      },
    });
    const outcome = await runner.execute(multiSlotProposal);
    expect(outcome).toMatchObject({
      status: 'allowed',
      receipt: {
        version: 'command-eve-agent-external-action-receipt/v0',
        outcome: 'committed',
        domain: 'commerce',
        action: 'purchase',
        providerOrMerchantId: 'merchant-fixture',
        origins: [MERCHANT_ORIGIN, ORIGIN],
        result: {
          purchaseRef: 'purchase-fixture',
          productDigest: digest('7'),
          providerReceiptDigest: digest('8'),
        },
        retryAllowed: false,
      },
      workbenchCard: {
        version: 'command-eve-external-action-workbench-card/v0',
        conversationId: 'conversation-a',
        status: 'committed',
        providerOrMerchantLabelCode: 'fixture_merchant',
        domain: 'commerce',
        action: 'purchase',
        origins: [MERCHANT_ORIGIN, ORIGIN],
        commerce: { productCount: 2 },
      },
    });
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.getReservation(binding, outcome.reservationId!)?.adapterPayloadProductCount).toBe(2);
    for (const bytes of visibleDuringCall) expect([...bytes]).toEqual(Array(bytes.length).fill(0));
    const serialized = JSON.stringify(outcome);
    for (const forbidden of [
      // Opaque handle IDs are permitted in Main-owned storage; only raw
      // credential/payload bytes must never cross into DB/DTO/logs.
      'synthetic-refresh-token',
      'synthetic-payment-pan',
      'synthetic-provider-payload',
    ]) {
      expect(serialized).not.toContain(forbidden);
      expect(fs.readFileSync(file).includes(Buffer.from(forbidden))).toBe(false);
    }
    store.close();
    stores.delete(store);
    const reopened = new ExternalActionStore(new NodeSqliteDriver(file), {
      now: () => new Date(NOW_ISO),
      randomUUID: () => `store-reopened-${++sequence}`,
    });
    stores.add(reopened);
    expect(reopened.getReservation(binding, outcome.reservationId!)?.adapterPayloadProductCount).toBe(2);
    const replay = await service({
      store: reopened,
      binding,
      adapter: commerceAdapter,
      resolver: { resolve },
      adapterPayloadReader: { read: async () => payload.slice() },
    }).execute(multiSlotProposal);
    expect(replay).toMatchObject({
      status: 'allowed',
      replay: true,
      workbenchCard: { status: 'committed', commerce: { productCount: 2 } },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects extra adapter outcome fields as unknown without reflecting provider data', async () => {
    const { store, binding } = fixture();
    const leaked = 'raw-provider-response-secret';
    const runner = service({
      store,
      binding,
      adapter: adapter({
        execute: async () => ({ status: 'allowed', providerRaw: leaked }) as unknown as { status: 'allowed' },
      }),
    });
    const outcome = await runner.execute(proposal());
    expect(outcome).toMatchObject({
      status: 'unknown_outcome',
      reasonCode: 'SANITIZATION_FAILED',
      retryAllowed: false,
      receipt: { outcome: 'unknown_outcome', retryAllowed: false },
    });
    expect(JSON.stringify(outcome)).not.toContain(leaked);
  });

  it('rejects renderer-supplied adapter contracts before reservation or adapter dispatch', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const payload = new TextEncoder().encode('commerce-contract-fixture');
    const untrusted = proposal({
      action: {
        ...proposal().action,
        adapterPayloadRef: 'payload-commerce-invalid',
        adapterPayloadDigest: `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`,
        adapterContract: {
          domain: 'commerce',
          action: 'checkout',
          counterpartyId: 'merchant-fixture',
          merchantOrigin: MERCHANT_ORIGIN,
          checkoutOrigin: ORIGIN,
          slotManifest: [
            { slot: 'account_password', handleId: 'password-handle', handleType: 'account_credential' },
            { slot: 'oauth_token', handleId: 'oauth-handle', handleType: 'oauth_token' },
          ],
        },
      },
    } as unknown as EveExternalActionProposal);
    expect(await service({ store, binding, adapter: adapter({ execute }) }).execute(untrusted)).toMatchObject({
      status: 'denied',
      reasonCode: 'EXTERNAL_PROPOSAL_ACTION_FIELDS_INVALID',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rechecks adapter payload bytes immediately before the call and reverses a pre-effect mismatch', async () => {
    const { store, binding } = fixture();
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const expectedPayload = new TextEncoder().encode('strict-synthetic-payload');
    const changedPayload = new TextEncoder().encode('mutated-synthetic-payload');
    const payloadProposal = proposal({
      oauthHandleId: undefined,
      passwordHandleId: undefined,
      action: {
        ...proposal().action,
        adapterPayloadRef: 'payload-ref-a',
        adapterPayloadDigest: `sha256:${crypto.createHash('sha256').update(expectedPayload).digest('hex')}`,
      },
    });
    let payloadReadCount = 0;
    const secretSink = { inject: vi.fn(async () => ({ status: 'applied' as const, deliveryRef: 'delivery:oauth' })) };
    const runner = service({
      store,
      binding,
      adapter: adapter({
        validatePayload: payloadValidator({
          authMode: 'oauth',
          slotManifest: [{ slot: 'oauth_token', handleId: 'oauth-handle', handleType: 'oauth_token' }],
        }),
        execute,
      }),
      adapterPayloadReader: {
        read: async () => (++payloadReadCount === 1 ? expectedPayload.slice() : changedPayload),
      },
      secretSink,
    });
    const outcome = await runner.execute(payloadProposal);
    expect(outcome).toMatchObject({
      status: 'denied',
      reasonCode: 'CONTRACT_CHANGED',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(secretSink.inject).not.toHaveBeenCalled();
    expect(payloadReadCount).toBe(2);
    expect(store.getReservation(binding, outcome.reservationId!)?.state).toBe('denied');
    expect(Array.from(changedPayload)).toEqual(Array.from({ length: changedPayload.length }, () => 0));
  });

  it('rejects missing or cross-auth commerce slots before reservation or secret use', async () => {
    const { store, binding } = fixture();
    expect(
      store.replacePolicy(
        binding,
        {
          currency: 'EUR',
          perActionLimitMinor: 1_000,
          dailyLimitMinor: 2_000,
          monthlyLimitMinor: 10_000,
          allowedOrigins: [MERCHANT_ORIGIN, ORIGIN],
          allowedActionKinds: ['purchase'],
          expiresAt: '2026-08-18T12:00:00.000Z',
        },
        'Europe/Berlin'
      )
    ).toMatchObject({ ok: true });
    const payload = new TextEncoder().encode('strict-commerce-slot-payload');
    const payloadDigest = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
    const reader = vi.fn(async () => payload.slice());
    let manifest: readonly EveExternalActionSlotBinding[] = [];
    const validatePayload = vi.fn((bytes: Uint8Array, context: { domain: 'generic' | 'email_identity' | 'phone_identity' | 'commerce'; action: string; counterpartyId: string; origins: readonly string[] }) => ({
      version: EXTERNAL_ACTION_ADAPTER_PAYLOAD_VALIDATION_VERSION,
      canonicalPayloadDigest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
      authMode: 'payment_fields' as const,
      domain: context.domain,
      action: context.action,
      counterpartyId: context.counterpartyId,
      origins: context.origins,
      slotManifest: manifest,
      commerce: {
        productCount: 1,
        cartDigest: digest('a'),
        quoteDigest: digest('b'),
        amount: { currency: 'EUR', minorUnits: 500 },
      },
    }));
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const runner = service({
      store,
      binding,
      adapter: adapter({
        operations: [
          {
            actionKind: 'purchase' as const,
            domain: 'commerce' as const,
            action: 'purchase' as const,
            counterpartyId: 'merchant-fixture',
            merchantOrigin: MERCHANT_ORIGIN,
            checkoutOrigin: ORIGIN,
          },
        ],
        supports: {
          oauth: false,
          browserSession: false,
          password: false,
          paymentFields: true,
          unauthenticated: false,
        },
        validatePayload,
        execute,
      }),
      adapterPayloadReader: { read: reader },
    });
    const slotProposal = () =>
      proposal({
        oauthHandleId: undefined,
        passwordHandleId: undefined,
        action: {
          ...proposal().action,
          adapterPayloadRef: 'payload-strict-slots',
          adapterPayloadDigest: payloadDigest,
        },
      });
    manifest = [
      { slot: 'payment_expiry', handleId: 'payment-handle', handleType: 'payment_profile' },
      { slot: 'payment_pan', handleId: 'payment-handle', handleType: 'payment_profile' },
    ];
    const missing = await runner.execute(slotProposal());
    manifest = [
      { slot: 'oauth_token', handleId: 'oauth-handle', handleType: 'oauth_token' },
      { slot: 'payment_cvc', handleId: 'payment-handle', handleType: 'payment_profile' },
      { slot: 'payment_expiry', handleId: 'payment-handle', handleType: 'payment_profile' },
      { slot: 'payment_pan', handleId: 'payment-handle', handleType: 'payment_profile' },
    ];
    const crossAuth = await runner.execute(slotProposal());
    expect(missing).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_SCHEMA_INVALID' });
    expect(crossAuth).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_SCHEMA_INVALID' });
    expect(execute).not.toHaveBeenCalled();
    expect(store.readAuditEvents(binding).some((event) => event.event_type === 'ledger.reserved')).toBe(false);
  });

  it('rejects payload attestations that differ from the Main-registered operation before reserve', async () => {
    const { store, binding } = fixture();
    const payload = new TextEncoder().encode('strict-binding-payload');
    const payloadDigest = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
    const execute = vi.fn(async () => ({ status: 'allowed' as const }));
    const sink = { inject: vi.fn(async () => ({ status: 'applied' as const, deliveryRef: 'delivery:oauth' })) };
    const runner = service({
      store,
      binding,
      adapter: adapter({
        validatePayload: (bytes, context) => ({
          version: EXTERNAL_ACTION_ADAPTER_PAYLOAD_VALIDATION_VERSION,
          canonicalPayloadDigest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
          authMode: 'oauth' as const,
          domain: context.domain,
          action: context.action,
          counterpartyId: 'attacker-fixture',
          origins: context.origins,
          slotManifest: [{ slot: 'oauth_token' as const, handleId: 'oauth-handle', handleType: 'oauth_token' as const }],
        }),
        execute,
      }),
      adapterPayloadReader: { read: async () => payload.slice() },
      secretSink: sink,
    });
    const outcome = await runner.execute(
      proposal({
        oauthHandleId: undefined,
        passwordHandleId: undefined,
        action: {
          ...proposal().action,
          adapterPayloadRef: 'payload-binding-mismatch',
          adapterPayloadDigest: payloadDigest,
        },
      })
    );
    expect(outcome).toMatchObject({ status: 'denied', reasonCode: 'EXTERNAL_ADAPTER_PAYLOAD_SCHEMA_INVALID' });
    expect(outcome.reservationId).toBeUndefined();
    expect(sink.inject).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(store.readAuditEvents(binding).some((event) => event.event_type === 'ledger.reserved')).toBe(false);
  });

  it('turns a post-call conversation switch into unknown and suppresses the workbench projection', async () => {
    const { store, binding } = fixture();
    let conversationId = 'conversation-a';
    const execute = vi.fn(async () => {
      conversationId = 'conversation-b';
      return { status: 'allowed' as const };
    });
    const outcome = await service({
      store,
      binding,
      adapter: adapter({ execute }),
      resolveConversationContext: () => ({
        context: {
          version: 'command-eve-external-action-conversation-context/v0',
          conversationId,
          conversationSessionId: 'conversation-session-a',
        },
      }),
    }).execute(proposal());
    expect(outcome).toMatchObject({
      status: 'unknown_outcome',
      reasonCode: 'UNKNOWN_EXTERNAL_EFFECT',
      receipt: { outcome: 'unknown_outcome', retryAllowed: false },
    });
    expect(outcome.workbenchCard).toBeUndefined();
    expect(store.getReservation(binding, outcome.reservationId!)?.state).toBe('unknown');
  });

  it('rejects a secret-shaped value in an otherwise legal result ref without persisting or returning it', async () => {
    const { store, binding, file } = fixture();
    const canary = 'result:synthetic-secret-canary';
    const outcome = await service({
      store,
      binding,
      adapter: adapter({
        execute: async () => ({
          status: 'allowed',
          result: { domain: 'generic', action: 'purchase', resultRef: canary },
        }),
      }),
    }).execute(proposal());
    expect(outcome).toMatchObject({
      status: 'unknown_outcome',
      reasonCode: 'SANITIZATION_FAILED',
      receipt: { outcome: 'unknown_outcome', reasonCode: 'SANITIZATION_FAILED' },
    });
    expect(JSON.stringify(outcome)).not.toContain(canary);
    for (const candidate of [file, `${file}-wal`, `${file}-shm`].filter((entry) => fs.existsSync(entry))) {
      expect(fs.readFileSync(candidate).includes(Buffer.from(canary))).toBe(false);
    }
  });
});
