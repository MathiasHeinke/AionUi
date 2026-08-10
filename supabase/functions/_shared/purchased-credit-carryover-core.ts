// Command EVE — purchased-credit carryover selection.
//
// Bought credit packs are ledger value: if a subscription/trial entitlement
// lapses, a positive purchased bucket remains spendable until a refund or
// reversal zeroes it. This is shared with the inference lane contract.

export interface CarryoverEntitlementInput {
  id?: string | null;
  spend_cap_eur_cents?: number | null;
}

export interface CarryoverBalanceInput {
  entitlement_id?: string | null;
  purchased_credits_remaining?: number | null;
}

export interface PurchasedCreditCarryover {
  entitlementId: string;
  purchasedCredits: number;
  spendCapEurCents: number | null;
}

function nonNegativeCredit(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function nullableNonNegativeCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function pickLatestPurchasedCreditCarryover(
  entitlementsNewestFirst: CarryoverEntitlementInput[],
  balances: CarryoverBalanceInput[]
): PurchasedCreditCarryover | null {
  const purchasedByEntitlement = new Map<string, number>();
  for (const row of balances) {
    const id = typeof row.entitlement_id === 'string' ? row.entitlement_id : '';
    if (!id) continue;
    const purchased = nonNegativeCredit(row.purchased_credits_remaining);
    if (purchased <= 0) continue;
    purchasedByEntitlement.set(id, (purchasedByEntitlement.get(id) ?? 0) + purchased);
  }

  for (const entitlement of entitlementsNewestFirst) {
    const id = typeof entitlement.id === 'string' ? entitlement.id : '';
    if (!id) continue;
    const purchasedCredits = purchasedByEntitlement.get(id) ?? 0;
    if (purchasedCredits <= 0) continue;
    return {
      entitlementId: id,
      purchasedCredits,
      spendCapEurCents: nullableNonNegativeCents(entitlement.spend_cap_eur_cents),
    };
  }

  return null;
}
