import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { EveExternalActionBinding } from '@/common/config/eveExternalActionPolicyCore';
import {
  ExternalActionStore,
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
      allowedDomains: ['shop.example'],
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
  return {
    binding: scoped,
    policyRevision: policy.revision,
    sessionEpoch: policy.sessionEpoch,
    authorityDecision: 'allow',
    authorityGrantId: 'grant-a',
    classificationDigest: digest('a'),
    riskClass: 'ordinary',
    actionKind: 'purchase',
    domain: 'shop.example',
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
    expect(
      first.markAllowed({
        binding: scoped,
        reservationId: reserved.reservationId!,
        claimId: 'claim-a',
        outcomeDigest: digest('1'),
      })
    ).toMatchObject({ ok: true, state: 'allowed' });

    closeStore(first);
    const reopened = openStore(file);
    expect(reopened.getReservation(scoped, reserved.reservationId!)?.state).toBe('allowed');
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
    expect(reopened.claim(claim)).toMatchObject({ ok: true, execute: false, replay: true, state: 'unknown' });
  });
});

describe('ExternalActionStore isolation, authority and budget fences', () => {
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
        outcomeDigest: digest('6'),
      })
    ).toMatchObject({ ok: true, state: 'reversed' });
    expect(store.reserve(secondInput)).toMatchObject({ ok: true, state: 'reserved' });
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
    expect(store.getReservation(seatA, a.reservationId!)?.state).toBe('reversed');
    expect(store.getReservation(seatB, b.reservationId!)?.state).toBe('reserved');
    const revoked = store.revokePolicy(seatB);
    expect(revoked.ok && revoked.policy.revokedAt).toBeTruthy();
    expect(store.getReservation(seatB, b.reservationId!)?.state).toBe('reversed');
  });
});
