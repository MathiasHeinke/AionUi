import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EveExternalActionBinding } from '@/common/config/eveExternalActionPolicyCore';
import {
  ExternalActionStore,
  externalActionClaimDigest,
  externalActionExpectationDigest,
} from '@/process/services/external-action/externalActionStore';
import { ExternalSecretUseBroker } from '@/process/services/external-action/secretUseBroker';
import { NodeSqliteDriver } from './testSqliteDriver';

const NOW_ISO = '2026-08-11T12:00:00.000Z';
const PAYMENT_REF = `keychain:v1:${Buffer.from('opaque-ciphertext-only').toString('base64')}`;
const tmpRoots: string[] = [];
const stores = new Set<ExternalActionStore>();
let sequence = 0;

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function openFixture(): { store: ExternalActionStore; file: string; binding: EveExternalActionBinding } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-secret-broker-'));
  tmpRoots.push(root);
  const file = path.join(root, 'ledger.sqlite3');
  const store = new ExternalActionStore(new NodeSqliteDriver(file), {
    now: () => new Date(NOW_ISO),
    randomUUID: () => `broker-${++sequence}`,
  });
  stores.add(store);
  const binding = { installationId: store.getInstallationId(), accountId: 'account-a', seedId: 'seed-a' };
  const policy = store.replacePolicy(
    binding,
    {
      currency: 'EUR',
      perActionLimitMinor: 1_000,
      dailyLimitMinor: 2_000,
      monthlyLimitMinor: 10_000,
      allowedOrigins: ['https://shop.example'],
      allowedActionKinds: ['purchase'],
      expiresAt: '2026-08-18T12:00:00.000Z',
    },
    'Europe/Berlin'
  );
  if (!policy.ok) throw new Error(policy.reasonCode);
  return { store, file, binding };
}

function claimedReservation(store: ExternalActionStore, binding: EveExternalActionBinding) {
  const policy = store.getPolicy(binding)!;
  const reserved = store.reserve({
    binding,
    conversationId: 'conversation-a',
    conversationSessionId: 'conversation-session-a',
    adapterId: 'synthetic-payment-adapter',
    authMode: 'payment_fields',
    adapterDomain: 'generic',
    adapterAction: 'purchase',
    counterpartyId: 'synthetic-payment-adapter',
    providerOrMerchantLabelCode: 'fixture_merchant',
    adapterOrigins: ['https://shop.example'],
    slotManifest: [{ slot: 'payment_pan', handleId: 'handle-payment-a', handleType: 'payment_profile' }],
    policyRevision: policy.revision,
    sessionEpoch: policy.sessionEpoch,
    authorityDecision: 'allow',
    authorityGrantId: 'grant-a',
    authorityReceiptDigest: digest('9'),
    classificationDigest: digest('a'),
    riskClass: 'ordinary',
    actionKind: 'purchase',
    targetOrigin: 'https://shop.example',
    intentId: 'intent-a',
    requestId: 'request-a',
    operationDigest: digest('b'),
    idempotencyKeyDigest: digest('c'),
    executionContractDigest: digest('d'),
    quoteDigest: digest('e'),
    amountMinor: 500,
    currency: 'EUR',
    expiresAt: '2026-08-11T13:00:00.000Z',
  });
  if (!reserved.ok || !reserved.reservationId) throw new Error('reserve fixture failed');
  const claimDigest = externalActionClaimDigest({
    executionContractDigest: digest('d'),
    reservationId: reserved.reservationId,
    claimId: 'claim-a',
  });
  const claim = store.claim({
    binding,
    reservationId: reserved.reservationId,
    claimId: 'claim-a',
    claimDigest,
    policyRevision: policy.revision,
    sessionEpoch: policy.sessionEpoch,
  });
  if (!claim.execute) throw new Error('claim fixture failed');
  const executionContract = {
    installationId: binding.installationId,
    accountId: binding.accountId,
    seedId: binding.seedId,
    conversationId: 'conversation-a',
    conversationSessionId: 'conversation-session-a',
    adapterId: 'synthetic-payment-adapter',
    authMode: 'payment_fields' as const,
    domain: 'generic' as const,
    domainAction: 'purchase',
    counterpartyId: 'synthetic-payment-adapter',
    providerOrMerchantLabelCode: 'fixture_merchant',
    providerOrigin: 'https://shop.example',
    slotManifest: [
      { slot: 'payment_pan' as const, handleId: 'handle-payment-a', handleType: 'payment_profile' as const },
    ],
    intentId: 'intent-a',
    requestId: 'request-a',
    operationDigest: digest('b'),
    idempotencyKeyDigest: digest('c'),
    executionContractDigest: digest('d'),
    authorityGrantId: 'grant-a',
    authorityReceiptDigest: digest('9'),
    classificationDigest: digest('a'),
    policyRevision: policy.revision,
    sessionEpoch: policy.sessionEpoch,
    quoteDigest: digest('e'),
    claimDigest,
    expectationDigest: externalActionExpectationDigest({
      executionContractDigest: digest('d'),
      reservationId: reserved.reservationId,
      claimId: 'claim-a',
      claimDigest,
    }),
    actionKind: 'purchase' as const,
    targetOrigin: 'https://shop.example',
    amountMinor: 500,
    currency: 'EUR',
    reservationId: reserved.reservationId,
    claimId: 'claim-a',
  };
  const permit = store.registerSecretSlotPermit({
    binding,
    reservationId: reserved.reservationId,
    claimId: 'claim-a',
    slot: 'payment_pan',
    handleId: 'handle-payment-a',
    expectedHandleType: 'payment_profile',
    executionContract,
  });
  if (!permit.ok) throw new Error('permit fixture failed');
  return { reservationId: reserved.reservationId, claimId: 'claim-a', slot: 'payment_pan' as const, executionContract };
}

function registerHandle(store: ExternalActionStore, binding: EveExternalActionBinding) {
  return store.registerSecretHandle({
    binding,
    handleId: 'handle-payment-a',
    type: 'payment_profile',
    source: 'eve_keychain',
    sourceRef: PAYMENT_REF,
    actionKinds: ['purchase'],
    targetOrigins: ['https://shop.example'],
    expiresAt: '2026-08-18T12:00:00.000Z',
  });
}

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe('ExternalSecretUseBroker opaque one-use injection', () => {
  it('injects synthetic bytes once, returns metadata only and zeroes the buffer', async () => {
    const { store, binding } = openFixture();
    expect(registerHandle(store, binding)).toEqual({ ok: true });
    const claim = claimedReservation(store, binding);
    const broker = new ExternalSecretUseBroker(store);
    const secret = 'synthetic-card-token-never-persist';
    let received = '';
    let materialReference: Uint8Array | undefined;

    const result = await broker.use(
      {
        binding,
        ...claim,
      },
      { resolve: async () => new TextEncoder().encode(secret) },
      {
        inject: async (material) => {
          materialReference = material;
          received = new TextDecoder().decode(material);
        },
      }
    );

    expect(received).toBe(secret);
    expect(result).toEqual({
      ok: true,
      status: 'injected',
      handleId: 'handle-payment-a',
      reservationId: claim.reservationId,
      claimId: claim.claimId,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(Array.from(materialReference ?? [])).toEqual(Array.from({ length: secret.length }, () => 0));

    const replay = await broker.use(
      {
        binding,
        ...claim,
      },
      { resolve: async () => new TextEncoder().encode(secret) },
      { inject: async () => undefined }
    );
    expect(replay).toMatchObject({ ok: false, status: 'unknown', reasonCode: 'EXTERNAL_SECRET_USE_REPLAY_BLOCKED' });
  });

  it('rejects plaintext and wrong-source references before any database write', () => {
    const { store, file, binding } = openFixture();
    const synthetic = 'plaintext-secret-must-never-hit-db';
    expect(
      store.registerSecretHandle({
        binding,
        handleId: 'bad-handle',
        type: 'account_credential',
        source: 'eve_keychain',
        sourceRef: synthetic,
        actionKinds: ['purchase'],
        targetOrigins: ['https://shop.example'],
        expiresAt: '2026-08-18T12:00:00.000Z',
      })
    ).toMatchObject({ ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_INVALID' });
    expect(fs.readFileSync(file).includes(Buffer.from(synthetic))).toBe(false);
  });

  it('does not resolve a handle through another account or seed', async () => {
    const { store, binding } = openFixture();
    registerHandle(store, binding);
    const claim = claimedReservation(store, binding);
    const broker = new ExternalSecretUseBroker(store);
    const otherSeed = { ...binding, seedId: 'seed-b' };
    const result = await broker.use(
      {
        binding: otherSeed,
        ...claim,
      },
      { resolve: async () => new Uint8Array([1]) },
      { inject: async () => undefined }
    );
    expect(result).toMatchObject({ ok: false, status: 'blocked' });
  });

  it('rechecks revoke immediately before resolution and never calls the resolver', async () => {
    const { store, binding } = openFixture();
    registerHandle(store, binding);
    const claim = claimedReservation(store, binding);
    expect(store.revokeSecretHandle(binding, 'handle-payment-a')).toEqual({ ok: true });
    const resolve = vi.fn(async () => new Uint8Array([1]));
    const result = await new ExternalSecretUseBroker(store).use(
      {
        binding,
        ...claim,
      },
      { resolve },
      { inject: async () => undefined }
    );
    expect(result).toMatchObject({ ok: false, status: 'blocked' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('binds a permit to adapter, ordinal and expiry and terminalizes tampering before resolution', async () => {
    const { store, file, binding } = openFixture();
    registerHandle(store, binding);
    const claim = claimedReservation(store, binding);
    const raw = new NodeSqliteDriver(file);
    raw
      .prepare(
        `UPDATE external_action_secret_slot_permits
         SET adapter_id = ?, ordinal = ?, expires_at = ?
         WHERE reservation_id = ? AND slot = ?`
      )
      .run('adapter-tampered', 9, '2099-01-01T00:00:00.000Z', claim.reservationId, claim.slot);
    raw.close();
    const resolve = vi.fn(async () => new TextEncoder().encode('must-not-resolve'));
    const result = await new ExternalSecretUseBroker(store).use(
      { binding, ...claim },
      { resolve },
      { inject: async () => undefined }
    );
    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      reasonCode: 'EXTERNAL_SECRET_SLOT_CONTRACT_STALE',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(store.getReservation(binding, claim.reservationId)?.state).toBe('denied');
    expect(store.getReceipt(binding, claim.reservationId)).toMatchObject({ outcome: 'denied' });
  });

  it('rechecks a handle after resolution and blocks a mid-resolution revoke before injection', async () => {
    const { store, binding } = openFixture();
    registerHandle(store, binding);
    const claim = claimedReservation(store, binding);
    const inject = vi.fn(async () => undefined);
    let materialReference: Uint8Array | undefined;
    const result = await new ExternalSecretUseBroker(store).use(
      {
        binding,
        ...claim,
      },
      {
        resolve: async () => {
          expect(store.revokeSecretHandle(binding, 'handle-payment-a')).toEqual({ ok: true });
          materialReference = new TextEncoder().encode('synthetic-raced-secret');
          return materialReference;
        },
      },
      { inject }
    );
    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      reasonCode: 'EXTERNAL_SECRET_HANDLE_NOT_ACTIVE',
    });
    expect(inject).not.toHaveBeenCalled();
    expect(store.getReservation(binding, claim.reservationId)?.state).toBe('denied');
    expect(Array.from(materialReference ?? [])).toEqual(
      Array.from({ length: 'synthetic-raced-secret'.length }, () => 0)
    );
  });

  it('reduces resolver errors to a fixed code and reverses before any injection', async () => {
    const { store, binding } = openFixture();
    registerHandle(store, binding);
    const claim = claimedReservation(store, binding);
    const secret = 'synthetic-resolver-error-secret';
    const broker = new ExternalSecretUseBroker(store);
    let injected = false;
    const result = await broker.use(
      {
        binding,
        ...claim,
      },
      {
        resolve: async () => {
          throw new Error(secret);
        },
      },
      {
        inject: async () => {
          injected = true;
        },
      }
    );
    expect(injected).toBe(false);
    expect(result).toMatchObject({ ok: false, status: 'blocked', reasonCode: 'EXTERNAL_SECRET_RESOLVE_FAILED' });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(store.getReservation(binding, claim.reservationId)?.state).toBe('denied');
  });

  it('marks an injector exception as unknown without echoing secret text to result, DB or audit', async () => {
    const { store, file, binding } = openFixture();
    registerHandle(store, binding);
    const claim = claimedReservation(store, binding);
    const secret = 'synthetic-injector-error-secret';
    const broker = new ExternalSecretUseBroker(store);
    const result = await broker.use(
      {
        binding,
        ...claim,
      },
      { resolve: async () => new TextEncoder().encode(secret) },
      {
        inject: async () => {
          throw new Error(secret);
        },
      }
    );
    expect(result).toMatchObject({
      ok: false,
      status: 'unknown',
      reasonCode: 'EXTERNAL_SECRET_INJECTION_UNKNOWN',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(store.getReservation(binding, claim.reservationId)?.state).toBe('unknown');
    expect(JSON.stringify(store.readAuditEvents(binding))).not.toContain(secret);
    expect(fs.readFileSync(file).includes(Buffer.from(secret))).toBe(false);
  });
});
