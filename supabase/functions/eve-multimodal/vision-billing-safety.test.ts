import { assertEquals } from 'jsr:@std/assert@1';
import {
  type BillingLedgerPort,
  reserveBillableOperation,
  settleBillableOperation,
} from '../_shared/billable-operations.ts';
import { pickLatestPurchasedCreditCarryover } from '../_shared/purchased-credit-carryover-core.ts';

function recordingPort() {
  const commits: Array<Record<string, unknown>> = [];
  const reversals: Array<Record<string, unknown>> = [];
  const port: BillingLedgerPort = {
    commit: (input) => {
      commits.push(input);
      return Promise.resolve({
        status: 'applied' as const,
        entitlementId: String(input.expectedEntitlementId ?? 'entitlement-default'),
        externalRef: input.externalRef,
      });
    },
    reverse: (input) => {
      reversals.push(input);
      return Promise.resolve({ ok: true });
    },
  };
  return { port, commits, reversals };
}

Deno.test('purchased Vision carry-over selects the newest wallet with a positive purchased bucket', () => {
  const picked = pickLatestPurchasedCreditCarryover(
    [
      { id: 'newest-empty', spend_cap_eur_cents: 10_000 },
      { id: 'newest-funded', spend_cap_eur_cents: 20_000 },
      { id: 'older-funded', spend_cap_eur_cents: 30_000 },
    ],
    [
      { entitlement_id: 'newest-empty', purchased_credits_remaining: 0 },
      { entitlement_id: 'newest-funded', purchased_credits_remaining: 98_047 },
      { entitlement_id: 'older-funded', purchased_credits_remaining: 12_000 },
    ]
  );

  assertEquals(picked, {
    entitlementId: 'newest-funded',
    purchasedCredits: 98_047,
    spendCapEurCents: 20_000,
  });
});

Deno.test('Vision reserve binds the quality route to the exact entitlement inspected', async () => {
  const { port, commits } = recordingPort();
  const reserved = await reserveBillableOperation({
    port,
    operationId: 'multimodal.vision',
    tenantId: 'tenant-1',
    externalRef: 'vision:route-bound',
    model: 'google/gemini-3.6-flash',
    expectedEntitlementId: 'entitlement-paid',
    boundUnits: 1,
    explicitBoundRetailEurCents: 35,
  });

  assertEquals(reserved.status, 'reserved');
  assertEquals(commits.length, 1);
  assertEquals(commits[0]?.expectedEntitlementId, 'entitlement-paid');
  if (reserved.status === 'reserved') {
    assertEquals(reserved.receipt.entitlementId, 'entitlement-paid');
    assertEquals(reserved.receipt.boundEurCents, 35);
  }
});

Deno.test('Vision never releases an artifact when provider cost exceeds the reserved bound', async () => {
  const { port, commits, reversals } = recordingPort();
  const reserved = await reserveBillableOperation({
    port,
    operationId: 'multimodal.vision',
    tenantId: 'tenant-1',
    externalRef: 'vision:over-bound',
    model: 'google/gemini-3.6-flash',
    expectedEntitlementId: 'entitlement-paid',
    boundUnits: 1,
    explicitBoundRetailEurCents: 35,
  });
  if (reserved.status !== 'reserved') throw new Error('reserve failed');

  const settled = await settleBillableOperation({
    port,
    receipt: reserved.receipt,
    actual: {
      ok: true,
      rawEurCents: 3.6,
      retailEurCents: 36,
      basis: 'provider-reported',
    },
    model: 'google/gemini-3.6-flash',
  });

  assertEquals(settled, {
    status: 'reversed',
    reason: 'actual-exceeds-reserved-bound',
  });
  assertEquals(commits.length, 1);
  assertEquals(reversals.length, 1);
  assertEquals(reversals[0]?.reason, 'vision analysis not produced');
});
