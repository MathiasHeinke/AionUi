/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE per-seat USAGE ATTRIBUTION — pure core (v1.5 A3, desktop Lane 3).
 *
 * This module is PURE (no Electron, no fs, no network) so the wire parse, the
 * month math and the display-model shaping are unit-testable in plain Node —
 * mirroring `creditsCore.ts`.
 *
 * It is shaped against the `seat-usage` Edge Function contract (v1.5 A-Spec §3.3):
 *   GET seat-usage?month=YYYY-MM  (CEVE bearer, verify_jwt=false, service-role read)
 *   →
 *   { ok, month,
 *     seats: [{ seat_id, calls, ok_calls, prompt_tokens, completion_tokens,
 *               retail_eur_cents, raw_eur_cents, credits }],
 *     total: { calls, ok_calls, prompt_tokens, completion_tokens,
 *              retail_eur_cents, raw_eur_cents, credits } }
 *
 * IMPORTANT — the server sends ONLY opaque seat ids, NEVER names/PII (H3
 * continued server-side). The seat LABEL join happens in the RENDERER (the
 * `useSeatUsage` hook joins `seat_id → access.seats[].name` from the my-seats
 * wire the operator already holds). A row with `seat_id === null` is the
 * "Nicht zugeordnet" (unattributed / legacy) bucket.
 *
 * VERSION-SKEW SAFE by construction: an absent/404/malformed response parses to
 * an EMPTY, `available:false` model — the card then shows the honest
 * "Verbrauchsdaten ab dem nächsten Server-Update" resting state. A field absent
 * on a seat row degrades to 0, never throws.
 */

// ---------------------------------------------------------------------------
// Backend contract (mirrored; the server is the source of truth)
// ---------------------------------------------------------------------------

/** The Command EVE seat-usage Edge Function. Same Supabase project as eve-inference. */
export const SEAT_USAGE_FUNCTION_URL =
  'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/seat-usage';

/** One seat's aggregated usage for the queried month (opaque id only). */
export interface SeatUsageRow {
  /** Opaque seat id: 'seat-1' | uuid-text | null (the "Nicht zugeordnet" bucket). */
  seat_id: string | null;
  calls: number;
  ok_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** Precise retail in EUR cents (sub-cent aware; NOT the rounded eur_value_cents echo). */
  retail_eur_cents: number;
  /** Precise RAW/COGS in EUR cents (operator's own COGS view). May be absent server-side. */
  raw_eur_cents: number;
  /** Display credits (server converts via eurToCredits; the ledger stays money-truth). */
  credits: number;
}

/** The seat-usage response contract (A-Spec §3.3). */
export interface SeatUsageResponse {
  ok: boolean;
  /** Echoed queried month, `YYYY-MM`. */
  month: string;
  seats: SeatUsageRow[];
  total: Omit<SeatUsageRow, 'seat_id'>;
}

// ---------------------------------------------------------------------------
// Month helpers (UTC calendar month; pure)
// ---------------------------------------------------------------------------

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** True when `month` is a well-formed `YYYY-MM` (01..12). */
export function isValidUsageMonth(month: unknown): month is string {
  return typeof month === 'string' && MONTH_RE.test(month);
}

/** The current UTC calendar month as `YYYY-MM`. */
export function currentUsageMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * The prior UTC calendar month as `YYYY-MM` (the "Vormonat" switch target). Rolls
 * the year back at January. Pure — derived from the passed anchor month string.
 */
export function priorUsageMonth(month: string): string {
  if (!isValidUsageMonth(month)) return currentUsageMonth();
  const [y, m] = month.split('-').map((s) => parseInt(s, 10));
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear = m === 1 ? y - 1 : y;
  return `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Defensive wire parse (crosses the wire → parse fail-quiet)
// ---------------------------------------------------------------------------

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** An empty, unavailable model — the resting/version-skew state. */
export function emptySeatUsage(month: string): SeatUsageResponse {
  return {
    ok: false,
    month: isValidUsageMonth(month) ? month : currentUsageMonth(),
    seats: [],
    total: {
      calls: 0,
      ok_calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      retail_eur_cents: 0,
      raw_eur_cents: 0,
      credits: 0,
    },
  };
}

function parseSeatRow(raw: unknown): SeatUsageRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // seat_id: opaque string OR null (the unattributed bucket). Anything else ⇒ null.
  const seatId = typeof r.seat_id === 'string' && r.seat_id.length > 0 ? r.seat_id : null;
  return {
    seat_id: seatId,
    calls: num(r.calls),
    ok_calls: num(r.ok_calls),
    prompt_tokens: num(r.prompt_tokens),
    completion_tokens: num(r.completion_tokens),
    retail_eur_cents: num(r.retail_eur_cents),
    raw_eur_cents: num(r.raw_eur_cents),
    credits: num(r.credits),
  };
}

/**
 * Parse a raw seat-usage wire payload into the typed response, fail-quiet.
 * A missing/malformed/`ok:false` payload yields `emptySeatUsage` (available =
 * false), so the caller renders the honest "ab dem nächsten Server-Update" state.
 */
export function parseSeatUsageResponse(raw: unknown, requestedMonth: string): SeatUsageResponse {
  if (!raw || typeof raw !== 'object') return emptySeatUsage(requestedMonth);
  const obj = raw as Record<string, unknown>;
  if (obj.ok !== true) return emptySeatUsage(requestedMonth);

  const month = isValidUsageMonth(obj.month) ? obj.month : requestedMonth;
  const rawSeats = Array.isArray(obj.seats) ? obj.seats : [];
  const seats: SeatUsageRow[] = [];
  for (const entry of rawSeats) {
    const row = parseSeatRow(entry);
    if (row) seats.push(row);
  }

  const totalRaw = obj.total && typeof obj.total === 'object' ? (obj.total as Record<string, unknown>) : {};
  const total = {
    calls: num(totalRaw.calls),
    ok_calls: num(totalRaw.ok_calls),
    prompt_tokens: num(totalRaw.prompt_tokens),
    completion_tokens: num(totalRaw.completion_tokens),
    retail_eur_cents: num(totalRaw.retail_eur_cents),
    raw_eur_cents: num(totalRaw.raw_eur_cents),
    credits: num(totalRaw.credits),
  };

  return { ok: true, month: isValidUsageMonth(month) ? month : currentUsageMonth(), seats, total };
}

/**
 * Partition a parsed seat-usage response for the VIEWING seat — the main-side
 * belt for the account-wide-leak finding (Codex C1). `parseSeatUsageResponse`
 * returns EVERY seat's row + the account-wide total; the renderer alone used to
 * filter for display, which means the raw sibling rows (seat ids, calls, tokens,
 * retail/RAW cost) crossed the IPC wire to a client/delegate seat that must never
 * see them.
 *
 * - `visibleSeatId === null` ⇒ the owner/all-seat summary is authorized (the
 *   caller has already checked Founder/Admin-Legacy) — return the response
 *   unchanged.
 * - otherwise ⇒ keep ONLY the viewer's own row and RE-DERIVE `total` from the
 *   visible rows, so neither sibling rows nor the account-wide aggregate leak.
 *   A viewer with no attributed usage yet gets an empty seats list + zero total.
 *
 * Pure — no IO. The server-side seat-usage function should ALSO partition by the
 * bearer's account/role (defense in depth); this is the local enforcement point.
 */
export function partitionSeatUsageForViewer(
  response: SeatUsageResponse,
  visibleSeatId: string | null
): SeatUsageResponse {
  if (visibleSeatId === null) return response;
  const seats = response.seats.filter((r) => r.seat_id === visibleSeatId);
  const total = seats.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      ok_calls: acc.ok_calls + r.ok_calls,
      prompt_tokens: acc.prompt_tokens + r.prompt_tokens,
      completion_tokens: acc.completion_tokens + r.completion_tokens,
      retail_eur_cents: acc.retail_eur_cents + r.retail_eur_cents,
      raw_eur_cents: acc.raw_eur_cents + r.raw_eur_cents,
      credits: acc.credits + r.credits,
    }),
    { calls: 0, ok_calls: 0, prompt_tokens: 0, completion_tokens: 0, retail_eur_cents: 0, raw_eur_cents: 0, credits: 0 }
  );
  return { ok: response.ok, month: response.month, seats, total };
}

// ---------------------------------------------------------------------------
// Display-model shaping (label join is the caller's; ordering + bucket is here)
// ---------------------------------------------------------------------------

/** A seat-usage row enriched with its display label for the billing card. */
export interface SeatUsageCardRow extends SeatUsageRow {
  /** Display label joined from the my-seats wire; "Nicht zugeordnet" for NULL/unknown ids. */
  label: string;
  /** EUR (from cents) for display — the precise retail, not the rounded echo. */
  retail_eur: number;
  /** Bar fraction 0..1 relative to the max credits in the set (for the relative bar). */
  bar_fraction: number;
}

/** The "Nicht zugeordnet" label used for the NULL/unknown-id bucket. */
export const SEAT_USAGE_UNATTRIBUTED_LABEL = 'Nicht zugeordnet';

/**
 * Build the ordered, label-joined card rows. Ordering follows `seatOrder` (the
 * Rail order = `access.seats` order, Founder-Ask); usage-only ids not in the
 * order list come AFTER, and the NULL bucket last. `labelFor` resolves an opaque
 * id to its display name (the hook passes `seat_id → access.seats[].name`);
 * unknown/NULL ⇒ "Nicht zugeordnet".
 *
 * When `visibleSeatId` is set (a delegate / non-founder seat is active), ONLY the
 * row for that seat is returned — deckungsgleich mit dem my-seats-Scoping (a
 * delegate never sees sibling seats). When it is null (founder summary), all rows.
 */
export function buildSeatUsageCardRows(
  rows: SeatUsageRow[],
  seatOrder: string[],
  labelFor: (seatId: string | null) => string | undefined,
  visibleSeatId: string | null
): SeatUsageCardRow[] {
  const scoped = visibleSeatId === null ? rows : rows.filter((r) => r.seat_id === visibleSeatId);

  const orderIndex = new Map<string, number>();
  seatOrder.forEach((id, i) => orderIndex.set(id, i));
  const rank = (seatId: string | null): number => {
    if (seatId === null) return Number.MAX_SAFE_INTEGER; // NULL bucket always last
    const i = orderIndex.get(seatId);
    return i === undefined ? Number.MAX_SAFE_INTEGER - 1 : i; // usage-only ids just before NULL
  };

  const ordered = [...scoped].sort((a, b) => rank(a.seat_id) - rank(b.seat_id));
  const maxCredits = ordered.reduce((m, r) => Math.max(m, r.credits), 0);

  return ordered.map((r) => {
    const joined = r.seat_id === null ? undefined : labelFor(r.seat_id);
    return {
      ...r,
      label: joined && joined.length > 0 ? joined : SEAT_USAGE_UNATTRIBUTED_LABEL,
      retail_eur: r.retail_eur_cents / 100,
      bar_fraction: maxCredits > 0 ? r.credits / maxCredits : 0,
    };
  });
}
