import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { EveExternalActionBinding } from '@/common/config/eveExternalActionPolicyCore';
import {
  ExternalActionStore,
  externalActionClaimDigest,
  externalActionExpectationDigest,
  type ExternalActionExecutionContractExpectation,
  type ExternalActionReserveInput,
} from '@/process/services/external-action/externalActionStore';
import { NodeSqliteDriver } from './testSqliteDriver';

const NOW_ISO = '2026-08-11T12:00:00.000Z';
const POLICY_EXPIRY = '2026-08-18T12:00:00.000Z';
const RESERVATION_EXPIRY = '2026-08-11T13:00:00.000Z';
const tmpRoots: string[] = [];
const liveStores = new Set<ExternalActionStore>();
let uuidCounter = 0;

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function claimDigestFor(executionContractDigest: string, reservationId: string, claimId: string): string {
  return externalActionClaimDigest({ executionContractDigest, reservationId, claimId });
}

function databaseFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-external-action-ledger-'));
  tmpRoots.push(root);
  return path.join(root, 'ledger.sqlite3');
}

function openStore(file: string): ExternalActionStore {
  const store = new ExternalActionStore(new NodeSqliteDriver(file), {
    now: () => new Date(NOW_ISO),
    randomUUID: () => `test-${++uuidCounter}`,
  });
  liveStores.add(store);
  return store;
}

function closeStore(store: ExternalActionStore): void {
  store.close();
  liveStores.delete(store);
}

function binding(store: ExternalActionStore, accountId = 'account-a', seedId = 'seed-a'): EveExternalActionBinding {
  return { installationId: store.getInstallationId(), accountId, seedId };
}

function configure(store: ExternalActionStore, scoped = binding(store)) {
  const result = store.replacePolicy(
    scoped,
    {
      currency: 'EUR',
      perActionLimitMinor: 800,
      dailyLimitMinor: 1_000,
      monthlyLimitMinor: 5_000,
      allowedOrigins: ['https://shop.example'],
      allowedActionKinds: ['purchase', 'browser_submit'],
      expiresAt: POLICY_EXPIRY,
    },
    'Europe/Berlin'
  );
  if (!result.ok) throw new Error(result.reasonCode);
  return result.policy;
}

function reserveInput(
  store: ExternalActionStore,
  overrides: Partial<ExternalActionReserveInput> = {}
): ExternalActionReserveInput {
  const scoped = overrides.binding ?? binding(store);
  const policy = store.getPolicy(scoped);
  if (!policy) throw new Error('test policy missing');
  const targetOrigin = overrides.targetOrigin ?? 'https://shop.example';
  return {
    binding: scoped,
    conversationId: 'conversation-a',
    conversationSessionId: 'conversation-session-a',
    adapterId: 'synthetic-shop-adapter',
    authMode: 'none',
    adapterDomain: 'generic',
    adapterAction: 'purchase',
    counterpartyId: 'synthetic-shop-adapter',
    providerOrMerchantLabelCode: 'fixture_merchant',
    adapterOrigins: [targetOrigin],
    slotManifest: [],
    policyRevision: policy.revision,
    sessionEpoch: policy.sessionEpoch,
    authorityDecision: 'allow',
    authorityGrantId: 'grant-a',
    authorityReceiptDigest: digest('9'),
    classificationDigest: digest('a'),
    riskClass: 'ordinary',
    actionKind: 'purchase',
    targetOrigin,
    intentId: 'intent-a',
    requestId: 'request-a',
    operationDigest: digest('b'),
    idempotencyKeyDigest: digest('c'),
    executionContractDigest: digest('d'),
    quoteDigest: digest('e'),
    amountMinor: 700,
    currency: 'EUR',
    expiresAt: RESERVATION_EXPIRY,
    ...overrides,
  };
}

function executionContract(
  store: ExternalActionStore,
  overrides: Partial<ExternalActionExecutionContractExpectation> = {}
): ExternalActionExecutionContractExpectation {
  const scoped = overrides.installationId
    ? { installationId: overrides.installationId, accountId: 'account-a', seedId: 'seed-a' }
    : binding(store);
  const reservationId = overrides.reservationId ?? 'reservation:test';
  const claimId = overrides.claimId ?? 'claim-a';
 const executionContractDigest = overrides.executionContractDigest ?? digest('d');
  const claimDigest = overrides.claimDigest ?? claimDigestFor(executionContractDigest, reservationId, claimId);
  return {
    installationId: scoped.installationId,
    accountId: scoped.accountId,
    seedId: scoped.seedId,
    conversationId: 'conversation-a',
    conversationSessionId: 'conversation-session-a',
    adapterId: 'synthetic-shop-adapter',
    authMode: 'none',
    domain: 'generic',
    domainAction: 'purchase',
    counterpartyId: 'synthetic-shop-adapter',
    providerOrMerchantLabelCode: 'fixture_merchant',
    providerOrigin: 'https://shop.example',
    slotManifest: [],
    intentId: 'intent-a',
    requestId: 'request-a',
    operationDigest: digest('b'),
    idempotencyKeyDigest: digest('c'),
    executionContractDigest,
    authorityGrantId: 'grant-a',
    authorityReceiptDigest: digest('9'),
    classificationDigest: digest('a'),
    policyRevision: 1,
    sessionEpoch: 1,
    quoteDigest: digest('e'),
    claimDigest,
    actionKind: 'purchase',
    targetOrigin: 'https://shop.example',
    amountMinor: 700,
    currency: 'EUR',
    reservationId,
    claimId,
    expectationDigest: externalActionExpectationDigest({
      executionContractDigest,
      reservationId,
      claimId,
      claimDigest,
    }),
    ...overrides,
  };
}

afterEach(() => {
  for (const store of liveStores) {
    try {
      store.close();
    } catch {
      // already closed by a crash/reopen test
    }
  }
  liveStores.clear();
  while (tmpRoots.length) fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true });
});

describe('ExternalActionStore persistent at-most-once ledger', () => {
  it('persists reserve → claim → allowed across a reopen', () => {
    const file = databaseFile();
    const first = openStore(file);
    const scoped = binding(first);
    configure(first, scoped);

    const reserved = first.reserve(reserveInput(first));
    expect(reserved).toMatchObject({ ok: true, state: 'reserved' });
    const claimed = first.claim({
      binding: scoped,
      reservationId: reserved.reservationId!,
      claimId: 'claim-a',
      claimDigest: digest('f'),
      policyRevision: 1,
      sessionEpoch: 1,
    });
    expect(claimed).toMatchObject({ ok: true, execute: true, state: 'claimed' });
    const allowed = first.markAllowed({
      binding: scoped,
      reservationId: reserved.reservationId!,
      claimId: 'claim-a',
      authMode: 'none',
      outcomeDigest: digest('1'),
    });
    expect(allowed).toMatchObject({
      ok: true,
      state: 'allowed',
      receipt: {
        outcome: 'committed',
        domain: 'generic',
        action: 'purchase',
        providerOrMerchantId: 'synthetic-shop-adapter',
        retryAllowed: false,
      },
    });

    closeStore(first);
    const reopened = openStore(file);
    expect(reopened.getReservation(scoped, reserved.reservationId!)?.state).toBe('allowed');
    expect(reopened.getReceipt(scoped, reserved.reservationId!)).toEqual(allowed.receipt);
    expect(reopened.readAuditEvents(scoped).map((event) => event.event_type)).toEqual(
      expect.arrayContaining(['ledger.reserved', 'ledger.claimed', 'ledger.allowed'])
    );
  });

  it('returns the existing record for an exact replay and rejects semantic-key drift', () => {
    const store = openStore(databaseFile());
    configure(store);
    const original = reserveInput(store);
    const first = store.reserve(original);
    const replay = store.reserve(original);
    expect(replay).toMatchObject({ ok: true, replay: true, reservationId: first.reservationId, state: 'reserved' });

    const conflict = store.reserve({ ...original, requestId: 'request-other', amountMinor: 600 });
    expect(conflict).toMatchObject({ ok: false, reasonCode: 'EXTERNAL_REPLAY_CONFLICT' });
  });

  it('hands out exactly one executable claim', () => {
    const store = openStore(databaseFile());
    const scoped = binding(store);
    configure(store);
    const reserved = store.reserve(reserveInput(store));
    const claim = {
      binding: scoped,
      reservationId: reserved.reservationId!,
      claimId: 'claim-once',
      claimDigest: digest('f'),
      policyRevision: 1,
      sessionEpoch: 1,
    };
    expect(store.claim(claim).execute).toBe(true);
    expect(store.claim(claim)).toMatchObject({ ok: true, execute: false, replay: true, state: 'claimed' });
  });

  it('turns a crash-window claim into explicit unknown and never retries it', () => {
    const file = databaseFile();
    const first = openStore(file);
    const scoped = binding(first);
    configure(first);
    const reserved = first.reserve(reserveInput(first));
    const claim = {
      binding: scoped,
      reservationId: reserved.reservationId!,
      claimId: 'claim-crash',
      claimDigest: digest('f'),
      policyRevision: 1,
      sessionEpoch: 1,
    };
    expect(first.claim(claim).execute).toBe(true);
    closeStore(first);

    const reopened = openStore(file);
    expect(reopened.getReservation(scoped, reserved.reservationId!)?.state).toBe('unknown');
    expect(reopened.getReceipt(scoped, reserved.reservationId!)).toMatchObject({
      outcome: 'unknown_outcome',
      retryAllowed: false,
    });
    expect(reopened.claim(claim)).toMatchObject({ ok: true, execute: false, replay: true, state: 'unknown' });
  });

  it('fails closed when persisted policy or ledger safety fields are corrupt', () => {
    const file = databaseFile();
    const first = openStore(file);
    const scoped = binding(first);
    configure(first);
    const reserved = first.reserve(reserveInput(first));
    closeStore(first);

    const raw = new NodeSqliteDriver(file);
    raw.pragma('ignore_check_constraints = ON');
    raw
      .prepare(
        `UPDATE external_action_policies SET kill_switch = 2
       WHERE installation_id = ? AND account_id = ? AND seed_id = ?`
      )
      .run(scoped.installationId, scoped.accountId, scoped.seedId);
    raw
      .prepare("UPDATE external_action_reservations SET auth_mode = 'corrupt' WHERE reservation_id = ?")
      .run(reserved.reservationId!);
    raw.close();

    const reopened = openStore(file);
    expect(reopened.getPolicy(scoped)).toBeNull();
    expect(reopened.getReservation(scoped, reserved.reservationId!)).toBeNull();
  });

  it('binds every persisted execution-contract field at the final Main fence', () => {
    const file = databaseFile();
    const store = openStore(file);
    const scoped = binding(store);
    configure(store);
    const reserved = store.reserve(reserveInput(store));
    expect(
      store.claim({
        binding: scoped,
        reservationId: reserved.reservationId!,
        claimId: 'claim-a',
        claimDigest: claimDigestFor(digest('d'), reserved.reservationId!, 'claim-a'),
        policyRevision: 1,
        sessionEpoch: 1,
      }).execute
    ).toBe(true);
    const expected = executionContract(store, { reservationId: reserved.reservationId!, claimId: 'claim-a' });
    expect(store.recheckClaimForExecution(scoped, reserved.reservationId!, 'claim-a', expected)).toEqual({ ok: true });

    const raw = new NodeSqliteDriver(file);
    raw
      .prepare(
        `UPDATE external_action_reservations
         SET execution_contract_digest = ?, quote_digest = ?, authority_grant_id = ?,
             classification_digest = ?, claim_digest = ?
         WHERE reservation_id = ?`
      )
      .run(digest('9'), digest('8'), 'grant-mutated', digest('7'), digest('6'), reserved.reservationId!);
    raw.close();

    expect(store.recheckClaimForExecution(scoped, reserved.reservationId!, 'claim-a', expected)).toMatchObject({
      ok: false,
      reasonCode: 'EXTERNAL_EXECUTION_CONTRACT_STALE',
    });
  });

  it('persists a hashed one-use challenge and crash-fences resuming as unknown', () => {
    const file = databaseFile();
    const first = openStore(file);
    const scoped = binding(first);
    configure(first);
    const reserved = first.reserve(reserveInput(first));
    first.claim({
      binding: scoped,
      reservationId: reserved.reservationId!,
      claimId: 'claim-a',
      claimDigest: claimDigestFor(digest('d'), reserved.reservationId!, 'claim-a'),
      policyRevision: 1,
      sessionEpoch: 1,
    });
    const suspended = first.suspendForUser({
      binding: scoped,
      reservationId: reserved.reservationId!,
      claimId: 'claim-a',
      executionContract: executionContract(first, {
        reservationId: reserved.reservationId!,
        claimId: 'claim-a',
      }),
      challenge: {
        kind: '3ds',
        challengeRef: 'challenge-3ds-a',
        origin: 'https://shop.example',
        expiresAt: '2026-08-11T12:30:00.000Z',
        userInstructionCode: 'COMPLETE_3DS',
      },
      proposal: {
        version: 'command-eve-external-action-proposal/v1',
        clientRequestId: 'client-request-a',
        idempotencyKey: 'idempotency-a',
        action: {
          kind: 'purchase',
          targetOrigin: 'https://shop.example',
          argumentsDigest: digest('1'),
          quoteDigest: digest('e'),
          amount: { currency: 'EUR', minorUnits: 700 },
        },
      },
      adapterId: 'synthetic-shop-adapter',
      authMode: 'none',
      continuation: 'adapter_resume',
      continuationRef: 'continuation-store-test',
      resumeRef: 'resume-ref-store-test',
    });
    if (!suspended.ok) throw new Error(suspended.reasonCode);
    expect(first.getReservation(scoped, reserved.reservationId!)?.state).toBe('suspended');
    expect(first.getBudgetUsedToday(scoped, 'EUR')).toBe(700);
    const rawToken = suspended.record.resumeToken;
    const databaseBytes = [file, `${file}-wal`, `${file}-shm`]
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => fs.readFileSync(candidate));
    expect(databaseBytes.some((bytes) => bytes.includes(Buffer.from(rawToken)))).toBe(false);

    const resumed = first.resumeChallenge({
      binding: scoped,
      conversationId: 'conversation-a',
      conversationSessionId: 'conversation-session-a',
      resumeTokenDigest: `sha256:${crypto.createHash('sha256').update(rawToken).digest('hex')}`,
      completionAttestationDigest: digest('2'),
    });
    expect(resumed).toMatchObject({ ok: true, record: { reservationId: reserved.reservationId, claimId: 'claim-a' } });
    expect(first.getReservation(scoped, reserved.reservationId!)?.state).toBe('resuming');
    expect(
      first.resumeChallenge({
        binding: scoped,
        conversationId: 'conversation-a',
        conversationSessionId: 'conversation-session-a',
        resumeTokenDigest: `sha256:${crypto.createHash('sha256').update(rawToken).digest('hex')}`,
        completionAttestationDigest: digest('2'),
      })
    ).toMatchObject({ ok: false, reasonCode: 'EXTERNAL_RESUME_NOT_ACTIVE' });
    closeStore(first);
    const reopened = openStore(file);
    expect(reopened.getReservation(scoped, reserved.reservationId!)?.state).toBe('unknown');
    expect(
      reopened.reverse({
        binding: scoped,
        reservationId: reserved.reservationId!,
        claimId: 'claim-a',
        authMode: 'none',
        outcomeDigest: digest('3'),
      })
    ).toMatchObject({ state: 'unknown', replay: true });
  });
});

describe('ExternalActionStore isolation, authority and budget fences', () => {
  it('rejects renderer policy payloads with missing or extra authority fields', () => {
    const store = openStore(databaseFile());
    const scoped = binding(store);
    const base = {
      currency: 'EUR',
      perActionLimitMinor: 800,
      dailyLimitMinor: 1_000,
      monthlyLimitMinor: 5_000,
      allowedOrigins: ['https://shop.example'],
      allowedActionKinds: ['purchase'] as const,
      expiresAt: POLICY_EXPIRY,
    };
    expect(
      store.replacePolicy(scoped, { ...base, seedId: 'renderer-forged-seed' } as typeof base, 'Europe/Berlin')
    ).toMatchObject({ ok: false, reasonCode: 'EXTERNAL_POLICY_FIELDS_INVALID' });
    const { expiresAt: _omitted, ...missingExpiry } = base;
    expect(store.replacePolicy(scoped, missingExpiry as typeof base, 'Europe/Berlin')).toMatchObject({
      ok: false,
      reasonCode: 'EXTERNAL_POLICY_FIELDS_INVALID',
    });
    expect(store.getPolicy(scoped)).toBeNull();
  });

  it('binds the exact HTTPS origin and rejects lookalikes, paths and scheme drift', () => {
    const store = openStore(databaseFile());
    configure(store);
    expect(store.reserve(reserveInput(store, { targetOrigin: 'https://shop.example.evil' }))).toMatchObject({
      ok: false,
      reasonCode: 'EXTERNAL_ORIGIN_BLOCKED',
    });
    expect(store.reserve(reserveInput(store, { targetOrigin: 'http://shop.example' }))).toMatchObject({
      ok: false,
      reasonCode: 'EXTERNAL_ORIGIN_INVALID',
    });
    expect(store.reserve(reserveInput(store, { targetOrigin: 'https://shop.example/checkout' }))).toMatchObject({
      ok: false,
      reasonCode: 'EXTERNAL_ORIGIN_INVALID',
    });
  });

  it('cannot read or claim a reservation through another account or seed', () => {
    const store = openStore(databaseFile());
    const scoped = binding(store);
    configure(store, scoped);
    const reserved = store.reserve(reserveInput(store));
    const otherAccount = binding(store, 'account-b', 'seed-a');
    const otherSeed = binding(store, 'account-a', 'seed-b');
    expect(store.getReservation(otherAccount, reserved.reservationId!)).toBeNull();
    expect(store.getReservation(otherSeed, reserved.reservationId!)).toBeNull();
    expect(
      store.claim({
        binding: otherSeed,
        reservationId: reserved.reservationId!,
        claimId: 'claim-cross-seat',
        claimDigest: digest('f'),
        policyRevision: 1,
        sessionEpoch: 1,
      })
    ).toMatchObject({ ok: false, execute: false });
  });

  it('allows the same semantic id only after a separately configured account/seed binding', () => {
    const store = openStore(databaseFile());
    const accountA = binding(store, 'account-a', 'seed-a');
    const accountB = binding(store, 'account-b', 'seed-b');
    configure(store, accountA);
    configure(store, accountB);
    expect(store.reserve(reserveInput(store, { binding: accountA })).ok).toBe(true);
    expect(store.reserve(reserveInput(store, { binding: accountB })).ok).toBe(true);
  });

  it('never converts ask/block or fixed high-risk classes into a reservation', () => {
    const store = openStore(databaseFile());
    configure(store);
    expect(store.reserve(reserveInput(store, { authorityDecision: 'ask' }))).toMatchObject({
      ok: false,
      reasonCode: 'EXTERNAL_AUTHORITY_NOT_ALLOW',
    });
    expect(store.reserve(reserveInput(store, { authorityDecision: 'block' }))).toMatchObject({
      ok: false,
      reasonCode: 'EXTERNAL_AUTHORITY_NOT_ALLOW',
    });
    expect(store.reserve(reserveInput(store, { riskClass: 'legal_agreement' }))).toMatchObject({
      ok: false,
      reasonCode: 'EXTERNAL_ACTION_HUMAN_GATE_REQUIRED',
    });
  });

  it('counts reservations atomically, keeps unknown budget held and frees reversal budget', () => {
    const store = openStore(databaseFile());
    const scoped = binding(store);
    configure(store);
    const first = store.reserve(reserveInput(store));
    const secondInput = reserveInput(store, {
      intentId: 'intent-b',
      requestId: 'request-b',
      operationDigest: digest('2'),
      idempotencyKeyDigest: digest('3'),
      executionContractDigest: digest('4'),
      quoteDigest: digest('5'),
      amountMinor: 400,
    });
    expect(store.reserve(secondInput)).toMatchObject({
      ok: false,
      reasonCode: 'EXTERNAL_BUDGET_DAILY_EXCEEDED',
    });

    expect(
      store.reverse({
        binding: scoped,
        reservationId: first.reservationId!,
        claimId: '',
        authMode: 'none',
        outcomeDigest: digest('6'),
      })
    ).toMatchObject({ ok: true, state: 'reversed' });
    expect(store.reserve(secondInput)).toMatchObject({ ok: true, state: 'reserved' });
  });

  it('fails closed when persisted day/month keys are moved out of the active budget period', () => {
    const file = databaseFile();
    const store = openStore(file);
    configure(store);
    const first = store.reserve(reserveInput(store));
    const raw = new NodeSqliteDriver(file);
    raw
      .prepare('UPDATE external_action_reservations SET day_id = ?, month_id = ? WHERE reservation_id = ?')
      .run('2099-01-01', '2099-01', first.reservationId!);
    raw.close();
    expect(
      store.reserve(
        reserveInput(store, {
          intentId: 'intent-period-b',
          requestId: 'request-period-b',
          operationDigest: digest('2'),
          idempotencyKeyDigest: digest('3'),
          executionContractDigest: digest('4'),
          quoteDigest: digest('5'),
          amountMinor: 100,
        })
      )
    ).toMatchObject({ ok: false, reasonCode: 'EXTERNAL_BUDGET_LEDGER_INVALID' });
  });

  it('keeps the original budget timezone immutable across policy revisions', () => {
    const store = openStore(databaseFile());
    const scoped = binding(store);
    const policy = configure(store);
    expect(
      store.replacePolicy(
        scoped,
        {
          currency: policy.currency,
          perActionLimitMinor: policy.perActionLimitMinor,
          dailyLimitMinor: policy.dailyLimitMinor,
          monthlyLimitMinor: policy.monthlyLimitMinor,
          allowedOrigins: policy.allowedOrigins,
          allowedActionKinds: policy.allowedActionKinds,
          expiresAt: policy.expiresAt,
        },
        'UTC'
      )
    ).toMatchObject({ ok: false, reasonCode: 'EXTERNAL_POLICY_TIMEZONE_IMMUTABLE' });
  });

  it('policy edits bump revision/epoch and fence both reserved and claimed work', () => {
    const store = openStore(databaseFile());
    const scoped = binding(store);
    const firstPolicy = configure(store);
    const reservedA = store.reserve(reserveInput(store));
    const reservedB = store.reserve(
      reserveInput(store, {
        intentId: 'intent-b',
        requestId: 'request-b',
        operationDigest: digest('2'),
        idempotencyKeyDigest: digest('3'),
        executionContractDigest: digest('4'),
        quoteDigest: digest('5'),
        amountMinor: 100,
      })
    );
    expect(
      store.claim({
        binding: scoped,
        reservationId: reservedB.reservationId!,
        claimId: 'claim-policy-change',
        claimDigest: digest('f'),
        policyRevision: firstPolicy.revision,
        sessionEpoch: firstPolicy.sessionEpoch,
      }).execute
    ).toBe(true);

    const next = configure(store);
    expect(next.revision).toBe(firstPolicy.revision + 1);
    expect(next.sessionEpoch).toBe(firstPolicy.sessionEpoch + 1);
    expect(store.getReservation(scoped, reservedA.reservationId!)?.state).toBe('reversed');
    expect(store.getReservation(scoped, reservedB.reservationId!)?.state).toBe('unknown');
    expect(
      store.claim({
        binding: scoped,
        reservationId: reservedA.reservationId!,
        claimId: 'claim-stale',
        claimDigest: digest('7'),
        policyRevision: firstPolicy.revision,
        sessionEpoch: firstPolicy.sessionEpoch,
      })
    ).toMatchObject({ ok: false, execute: false, reasonCode: 'EXTERNAL_POLICY_STALE' });
  });

  it('kill and revoke invalidate outstanding work only inside the current binding', () => {
    const store = openStore(databaseFile());
    const seatA = binding(store, 'account-a', 'seed-a');
    const seatB = binding(store, 'account-a', 'seed-b');
    configure(store, seatA);
    configure(store, seatB);
    const a = store.reserve(reserveInput(store, { binding: seatA }));
    const b = store.reserve(reserveInput(store, { binding: seatB }));
    expect(store.setKillSwitch(seatA, true).ok).toBe(true);
    expect(store.getReservation(seatA, a.reservationId!)?.state).toBe('revoked');
    expect(store.getReservation(seatB, b.reservationId!)?.state).toBe('reserved');
    const revoked = store.revokePolicy(seatB);
    expect(revoked.ok && revoked.policy.revokedAt).toBeTruthy();
    expect(store.getReservation(seatB, b.reservationId!)?.state).toBe('revoked');
  });

  it('allows cross-account/seed secret access only through an exact explicit grant and revokes it immediately', () => {
    const store = openStore(databaseFile());
    const owner = binding(store, 'account-a', 'seed-a');
    const grantee = binding(store, 'account-b', 'seed-b');
    expect(
      store.registerSecretHandle({
        binding: owner,
        handleId: 'shared-oauth',
        type: 'oauth_token',
        source: 'hermes_onepassword',
        sourceRef: 'secret-source:v1:onepassword:GOOGLE_REFRESH_TOKEN',
        actionKinds: ['browser_submit'],
        targetOrigins: ['https://accounts.example'],
        expiresAt: POLICY_EXPIRY,
      })
    ).toEqual({ ok: true });
    expect(
      store.resolveSecretHandleAccess(grantee, 'shared-oauth', 'browser_submit', 'https://accounts.example')
    ).toBeNull();
    expect(
      store.registerSecretShareGrant({
        ownerBinding: owner,
        granteeBinding: grantee,
        grantId: 'grant-shared-oauth',
        handleId: 'shared-oauth',
        actionKind: 'browser_submit',
        targetOrigin: 'https://accounts.example',
        expiresAt: RESERVATION_EXPIRY,
      })
    ).toEqual({ ok: true });
    expect(
      store.resolveSecretHandleAccess(grantee, 'shared-oauth', 'browser_submit', 'https://accounts.example')
    ).toMatchObject({ accessGrantId: 'grant-shared-oauth', binding: owner });
    expect(store.resolveSecretHandleAccess(grantee, 'shared-oauth', 'purchase', 'https://accounts.example')).toBeNull();
    expect(store.revokeSecretShareGrant(owner, 'grant-shared-oauth')).toEqual({ ok: true });
    expect(
      store.resolveSecretHandleAccess(grantee, 'shared-oauth', 'browser_submit', 'https://accounts.example')
    ).toBeNull();
  });

  it('keeps Hermes SecretSource startup hydration out of identity/payment/password handles', () => {
    const store = openStore(databaseFile());
    const scoped = binding(store);
    for (const type of ['identity_email', 'identity_phone', 'payment_profile', 'account_credential'] as const) {
      expect(
        store.registerSecretHandle({
          binding: scoped,
          handleId: `blocked-${type}`,
          type,
          source: 'hermes_bitwarden',
          sourceRef: 'secret-source:v1:bitwarden:SYNTHETIC_ALIAS',
          actionKinds: ['browser_submit'],
          targetOrigins: ['https://accounts.example'],
          expiresAt: POLICY_EXPIRY,
        })
      ).toMatchObject({ ok: false, reasonCode: 'EXTERNAL_SECRET_HANDLE_INVALID' });
    }
  });

  it('consumes an OTP handle globally once across independently claimed reservations and forbids sharing', () => {
    const store = openStore(databaseFile());
    const scoped = binding(store);
    const other = binding(store, 'account-b', 'seed-b');
    configure(store, scoped);
    const otpRef = `keychain:v1:${Buffer.from('synthetic-otp-ciphertext').toString('base64')}`;
    expect(
      store.registerSecretHandle({
        binding: scoped,
        handleId: 'otp-handle-a',
        type: 'otp_code',
        source: 'eve_keychain',
        sourceRef: otpRef,
        actionKinds: ['purchase'],
        targetOrigins: ['https://shop.example'],
        expiresAt: POLICY_EXPIRY,
      })
    ).toEqual({ ok: true });
    expect(
      store.registerSecretShareGrant({
        ownerBinding: scoped,
        granteeBinding: other,
        grantId: 'otp-share-blocked',
        handleId: 'otp-handle-a',
        actionKind: 'purchase',
        targetOrigin: 'https://shop.example',
        expiresAt: RESERVATION_EXPIRY,
      })
    ).toMatchObject({ ok: false, reasonCode: 'EXTERNAL_SECRET_GRANT_SCOPE_INVALID' });

    const makeClaim = (suffix: string, characters: readonly [string, string, string, string, string]) => {
      const reserve = reserveInput(store, {
        authMode: 'otp',
        slotManifest: [{ slot: 'otp_code', handleId: 'otp-handle-a', handleType: 'otp_code' }],
        intentId: `intent-otp-${suffix}`,
        requestId: `request-otp-${suffix}`,
        operationDigest: digest(characters[0]),
        idempotencyKeyDigest: digest(characters[1]),
        executionContractDigest: digest(characters[2]),
        quoteDigest: digest(characters[3]),
        amountMinor: 100,
      });
      const reserved = store.reserve(reserve);
      const claimId = `claim-otp-${suffix}`;
      const claimDigest = claimDigestFor(reserve.executionContractDigest, reserved.reservationId!, claimId);
      expect(
        store.claim({
          binding: scoped,
          reservationId: reserved.reservationId!,
          claimId,
          claimDigest,
          policyRevision: 1,
          sessionEpoch: 1,
        }).execute
      ).toBe(true);
      const contract = executionContract(store, {
        reservationId: reserved.reservationId!,
        claimId,
        intentId: reserve.intentId,
        requestId: reserve.requestId,
        operationDigest: reserve.operationDigest,
        idempotencyKeyDigest: reserve.idempotencyKeyDigest,
        executionContractDigest: reserve.executionContractDigest,
        quoteDigest: reserve.quoteDigest,
        claimDigest,
        amountMinor: reserve.amountMinor,
        authMode: 'otp',
        slotManifest: [{ slot: 'otp_code', handleId: 'otp-handle-a', handleType: 'otp_code' }],
      });
      expect(
        store.registerSecretSlotPermit({
          binding: scoped,
          reservationId: reserved.reservationId!,
          claimId,
          slot: 'otp_code',
          handleId: 'otp-handle-a',
          expectedHandleType: 'otp_code',
          executionContract: contract,
        })
      ).toEqual({ ok: true });
      return { reservationId: reserved.reservationId!, claimId, contract };
    };

    const first = makeClaim('a', ['1', '2', '3', '4', '5']);
    const second = makeClaim('b', ['6', '7', '8', '9', 'a']);
    expect(
      store.consumeSecretUsePermit(scoped, first.reservationId, first.claimId, 'otp_code', first.contract)
    ).toMatchObject({
      ok: true,
    });
    expect(
      store.consumeSecretUsePermit(scoped, second.reservationId, second.claimId, 'otp_code', second.contract)
    ).toMatchObject({ ok: false, reasonCode: 'EXTERNAL_OTP_ALREADY_CONSUMED' });
  });

  it('rolls a terminal transition back when its sanitized receipt cannot be persisted exactly', () => {
    const file = databaseFile();
    const store = openStore(file);
    const scoped = binding(store);
    configure(store, scoped);
    const reserved = store.reserve(reserveInput(store));
    expect(
      store.claim({
        binding: scoped,
        reservationId: reserved.reservationId!,
        claimId: 'claim-receipt-conflict',
        claimDigest: digest('f'),
        policyRevision: 1,
        sessionEpoch: 1,
      }).execute
    ).toBe(true);
    const raw = new NodeSqliteDriver(file);
    const conflictingResult = '{"action":"purchase","domain":"generic","resultRef":"result:conflict"}';
    const conflictingResultDigest = `sha256:${crypto.createHash('sha256').update(conflictingResult).digest('hex')}`;
    raw
      .prepare(
        `INSERT INTO external_action_receipts (
           receipt_ref, reservation_id, operation_ref, outcome,
           auth_mode, account_ref, seed_ref, authority_receipt_digest, policy_revision,
           domain, action, provider_or_merchant_id, origins_json, amount_currency, amount_minor,
           result_json, result_digest, reason_code, occurred_at, retry_allowed
         ) VALUES (?, ?, ?, 'committed', 'none', ?, ?, ?, 1,
                   'generic', 'purchase', ?, ?, 'EUR', 700, ?, ?, NULL, ?, 0)`
      )
      .run(
        'receipt:conflict',
        reserved.reservationId!,
        'operation:conflict',
        'account:conflict',
        'seed:conflict',
        digest('9'),
        'synthetic-shop-adapter',
        JSON.stringify(['https://shop.example']),
        conflictingResult,
        conflictingResultDigest,
        NOW_ISO
      );
    raw.close();

    expect(
      store.markAllowed({
        binding: scoped,
        reservationId: reserved.reservationId!,
        claimId: 'claim-receipt-conflict',
        authMode: 'none',
        outcomeDigest: digest('1'),
      })
    ).toMatchObject({ ok: false, reasonCode: 'EXTERNAL_OUTCOME_PERSIST_FAILED' });
    expect(store.getReservation(scoped, reserved.reservationId!)?.state).toBe('claimed');
    expect(store.getReceipt(scoped, reserved.reservationId!)).toBeNull();
  });

  it('fails closed instead of silently opening an incompatible pre-release ledger schema', () => {
    const file = databaseFile();
    const driver = new NodeSqliteDriver(file);
    driver.exec(`
      CREATE TABLE external_action_meta (
        singleton INTEGER PRIMARY KEY,
        schema_version TEXT NOT NULL,
        installation_id TEXT NOT NULL UNIQUE
      );
      INSERT INTO external_action_meta (singleton, schema_version, installation_id)
      VALUES (1, 'command-eve-external-action-ledger/v1', 'install:legacy-test');
    `);
    expect(
      () =>
        new ExternalActionStore(driver, {
          now: () => new Date(NOW_ISO),
          randomUUID: () => 'schema-test',
        })
    ).toThrow('EXTERNAL_ACTION_SCHEMA_MIGRATION_REQUIRED');
    driver.close();
  });
});
