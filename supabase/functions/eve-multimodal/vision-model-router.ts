// Command EVE — server-authoritative Vision model routing.
//
// The desktop never chooses or learns the concrete provider model. The Edge
// Function resolves one of two product lanes from the same drawable entitlement
// and balance that the credit gate uses:
//   * trial: cheap but genuinely multimodal
//   * paid: materially stronger visual reasoning
//
// Purchased/granted credits deliberately override the legacy `pilot` edition.
// This mirrors the product's MAX rule: money in the purchased bucket is the
// authoritative upgrade signal, not a stale local edition badge.

import {
  type DrawableEntitlementRow,
  pickDrawableEntitlement,
} from "../_shared/entitlement-draw-core.ts";
import { pickLatestPurchasedCreditCarryover } from "../_shared/purchased-credit-carryover-core.ts";

export const DEFAULT_TRIAL_VISION_MODEL = "qwen/qwen3.7-flash";
export const DEFAULT_PAID_VISION_MODEL = "google/gemini-3.6-flash";

const MAX_ROUTE_RESPONSE_BYTES = 32 * 1024;
const ROUTE_TIMEOUT_MS = 5_000;

export type VisionProductLane = "trial" | "paid";

export type VisionModelRoute = {
  lane: VisionProductLane;
  model: string;
  /** Retail reservation ceiling per supplied image, in EUR cents. */
  boundRetailEurCentsPerImage: number;
  /** Hard output cap per provider attempt. */
  maxOutputTokens: number;
};

export type VisionRouteEntitlementRow = DrawableEntitlementRow & {
  edition?: string | null;
};

export type VisionRouteBalance = {
  included_allowance_credits_remaining: number;
  purchased_credits_remaining: number;
};

export type ResolveVisionModelRouteInput = {
  entitlement: VisionRouteEntitlementRow;
  balance: VisionRouteBalance;
  imageCount: number;
};

export type LoadVisionModelRouteResult =
  | {
    ok: true;
    route: VisionModelRoute;
    entitlementId: string;
  }
  | {
    ok: false;
    reason:
      | "route-not-configured"
      | "entitlement-unavailable"
      | "balance-unavailable"
      | "route-response-invalid"
      | "route-request-failed"
      | "route-unsupported-edition";
  };

function finiteNonNegative(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function boundedImageCount(value: number): number {
  return Number.isInteger(value) && value >= 1 && value <= 8 ? value : 1;
}

/**
 * Pure product decision. It does not trust the license edition alone:
 * `purchased_credits_remaining > 0` always unlocks the paid Vision lane.
 */
export function resolveVisionModelRoute(
  input: ResolveVisionModelRouteInput,
): VisionModelRoute | null {
  const purchased = finiteNonNegative(
    input.balance.purchased_credits_remaining,
  );
  const included = finiteNonNegative(
    input.balance.included_allowance_credits_remaining,
  );
  if (purchased === null || included === null) return null;

  const edition = (input.entitlement.edition ?? "").trim().toLowerCase();
  const status = (input.entitlement.status ?? "").trim().toLowerCase();
  const hasPurchasedCredits = purchased > 0;
  const hasPaidPlan = status === "active" && edition === "standard";

  if (!hasPurchasedCredits && !hasPaidPlan && edition !== "pilot") {
    return null;
  }

  const lane: VisionProductLane = hasPurchasedCredits || hasPaidPlan
    ? "paid"
    : "trial";
  const imageCount = boundedImageCount(input.imageCount);

  if (lane === "paid") {
    return {
      lane,
      model: DEFAULT_PAID_VISION_MODEL,
      // Gemini 3.6 Flash is capped below and may be called twice only for a
      // strict-format correction. 35 cents per image remains above that bounded
      // raw-cost × 10 retail envelope while settlement returns the unused hold.
      boundRetailEurCentsPerImage: 35,
      maxOutputTokens: Math.min(4_800, 1_200 + imageCount * 600),
    };
  }

  return {
    lane,
    model: DEFAULT_TRIAL_VISION_MODEL,
    // Qwen 3.7 Flash is orders of magnitude cheaper; one retail cent per image
    // still safely bounds two capped attempts and is settled down afterwards.
    boundRetailEurCentsPerImage: 1,
    maxOutputTokens: Math.min(3_200, 800 + imageCount * 400),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isVisionEntitlementRow(
  value: unknown,
): value is VisionRouteEntitlementRow {
  return isRecord(value) && typeof value.id === "string" &&
    typeof value.status === "string";
}

async function boundedJson(
  response: Response,
): Promise<unknown | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_ROUTE_RESPONSE_BYTES) {
    return null;
  }
  const text = await response.text();
  if (text.length > MAX_ROUTE_RESPONSE_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Resolve the authoritative server-side route. No client-supplied tier or
 * model participates. The selected entitlement id is the same one returned by
 * the shared drawable-entitlement core used by metering.
 */
export async function loadVisionModelRoute(args: {
  tenantId: string;
  nowIso: string;
  imageCount: number;
  supabaseUrl: string | null | undefined;
  serviceRoleKey: string | null | undefined;
  fetchFn?: typeof fetch;
}): Promise<LoadVisionModelRouteResult> {
  const baseUrl = args.supabaseUrl?.trim();
  const serviceRoleKey = args.serviceRoleKey?.trim();
  if (!baseUrl || !serviceRoleKey) {
    return { ok: false, reason: "route-not-configured" };
  }

  const fetchFn = args.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  try {
    const entitlementUrl = new URL("/rest/v1/entitlements", baseUrl);
    entitlementUrl.searchParams.set("tenant_id", `eq.${args.tenantId}`);
    entitlementUrl.searchParams.set(
      "select",
      "id,status,edition,spend_cap_eur_cents,created_at,trial_ends_at,expires_at",
    );
    entitlementUrl.searchParams.set("order", "created_at.desc");

    const entitlementResponse = await fetchFn(entitlementUrl, {
      method: "GET",
      signal: controller.signal,
      headers,
    });
    if (!entitlementResponse.ok) {
      return { ok: false, reason: "entitlement-unavailable" };
    }
    const entitlementPayload = await boundedJson(entitlementResponse);
    if (!Array.isArray(entitlementPayload)) {
      return { ok: false, reason: "route-response-invalid" };
    }
    const rows = entitlementPayload.filter(isVisionEntitlementRow);
    const balanceUrl = new URL("/rest/v1/credit_balances", baseUrl);
    const entitlementIds = rows.map((row) => row.id).filter(Boolean);
    if (entitlementIds.length === 0) {
      return { ok: false, reason: "entitlement-unavailable" };
    }
    balanceUrl.searchParams.set(
      "entitlement_id",
      `in.(${entitlementIds.join(",")})`,
    );
    balanceUrl.searchParams.set(
      "select",
      "entitlement_id,included_allowance_credits_remaining,purchased_credits_remaining",
    );
    const balanceResponse = await fetchFn(balanceUrl, {
      method: "GET",
      signal: controller.signal,
      headers,
    });
    if (!balanceResponse.ok) {
      return { ok: false, reason: "balance-unavailable" };
    }
    const balancePayload = await boundedJson(balanceResponse);
    if (!Array.isArray(balancePayload)) {
      return { ok: false, reason: "balance-unavailable" };
    }

    const drawable = pickDrawableEntitlement(rows, args.nowIso);
    const carryover = pickLatestPurchasedCreditCarryover(rows, balancePayload);
    const selectedEntitlementId = drawable?.entitlementId ??
      carryover?.entitlementId;
    if (!selectedEntitlementId) {
      return { ok: false, reason: "entitlement-unavailable" };
    }
    const entitlement = rows.find((row) => row.id === selectedEntitlementId);
    const balanceRow = balancePayload.find(
      (row) => isRecord(row) && row.entitlement_id === selectedEntitlementId,
    );
    if (!entitlement) {
      return { ok: false, reason: "route-response-invalid" };
    }
    if (!isRecord(balanceRow)) {
      return { ok: false, reason: "balance-unavailable" };
    }
    const purchased = finiteNonNegative(
      balanceRow.purchased_credits_remaining,
    );
    const included = finiteNonNegative(
      balanceRow.included_allowance_credits_remaining,
    );
    if (purchased === null || included === null) {
      return { ok: false, reason: "balance-unavailable" };
    }

    const route = resolveVisionModelRoute({
      entitlement,
      balance: {
        purchased_credits_remaining: purchased,
        included_allowance_credits_remaining: included,
      },
      imageCount: args.imageCount,
    });
    if (!route) {
      return { ok: false, reason: "route-unsupported-edition" };
    }
    return { ok: true, route, entitlementId: selectedEntitlementId };
  } catch {
    return { ok: false, reason: "route-request-failed" };
  } finally {
    clearTimeout(timeout);
  }
}
