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
export const SEAT_USAGE_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/seat-usage';

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
  /**
   * Optional, server-attested SG-1 agent ledger. `null` is the only safe value
   * for older, missing or malformed payloads; consumers must never derive an
   * agent route or an "actual" value from the seat aggregates above.
   */
  agent_usage: AgentUsageLedgerEnvelope | null;
}

/** Exact data payload crossing `command-eve.seat-usage` Main → renderer IPC. */
export interface SeatUsageIpcResult extends SeatUsageResponse {
  version: 'command-eve-seat-usage/v0';
}

// ---------------------------------------------------------------------------
// SG-1 agent-ledger contract (strict, provenance-first)
// ---------------------------------------------------------------------------

/** Canonical route decisions the honest team meter may reproduce verbatim. */
export type AgentUsageRoute = 'subscription' | 'byok' | 'local';

/** One immutable SG-1 usage event plus the routing receipt that authorized it. */
export interface AgentUsageLedgerRow {
  ledger_event_id: string;
  routing_receipt_id: string;
  agent_id: string;
  period: string;
  route: AgentUsageRoute;
  recorded_at: string;
  immutable: true;
  /** Actual recorded invocations represented by this immutable ledger row. */
  calls: number;
}

/**
 * Complete server snapshot for one period. Both `immutable` and `complete` are
 * required: without either assertion, aggregating the rows could turn a partial
 * or mutable response into a false team-wide "actual" claim.
 */
export interface AgentUsageLedgerEnvelope {
  version: 'command-eve-agent-usage/v1';
  immutable: true;
  complete: true;
  period: string;
  as_of: string;
  rows: readonly AgentUsageLedgerRow[];
}

export const AGENT_USAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type AgentUsageUnavailableReason =
  | 'missing-or-malformed'
  | 'period-mismatch'
  | 'stale'
  | 'agent-mismatch'
  | 'no-matching-rows';

export type VerifiedAgentUsageSnapshot =
  | {
      status: 'unavailable';
      period: string;
      reason: AgentUsageUnavailableReason;
      rows: readonly [];
      total_calls: null;
      as_of: null;
    }
  | {
      status: 'available';
      period: string;
      rows: readonly AgentUsageLedgerRow[];
      total_calls: number;
      as_of: string;
    };

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

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const finiteTimestamp = (value: unknown): string | null => {
  const text = nonEmptyString(value);
  return text && ISO_INSTANT_RE.test(text) && Number.isFinite(Date.parse(text)) ? text : null;
};

const isAgentUsageRoute = (value: unknown): value is AgentUsageRoute =>
  value === 'subscription' || value === 'byok' || value === 'local';

function parseAgentUsageLedgerRow(raw: unknown): AgentUsageLedgerRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const ledgerEventId = nonEmptyString(row.ledger_event_id);
  const routingReceiptId = nonEmptyString(row.routing_receipt_id);
  const agentId = nonEmptyString(row.agent_id);
  const recordedAt = finiteTimestamp(row.recorded_at);
  if (
    !ledgerEventId ||
    !routingReceiptId ||
    !agentId ||
    !isValidUsageMonth(row.period) ||
    !isAgentUsageRoute(row.route) ||
    !recordedAt ||
    row.immutable !== true ||
    typeof row.calls !== 'number' ||
    !Number.isSafeInteger(row.calls) ||
    row.calls <= 0
  ) {
    return null;
  }
  return {
    ledger_event_id: ledgerEventId,
    routing_receipt_id: routingReceiptId,
    agent_id: agentId,
    period: row.period,
    route: row.route,
    recorded_at: recordedAt,
    immutable: true,
    calls: row.calls,
  };
}

/**
 * Parse the optional agent ledger as one atomic proof. A single malformed or
 * duplicate row invalidates the entire envelope instead of silently producing a
 * plausible-looking partial total.
 */
export function parseAgentUsageLedgerEnvelope(raw: unknown): AgentUsageLedgerEnvelope | null {
  if (!raw || typeof raw !== 'object') return null;
  const envelope = raw as Record<string, unknown>;
  if (
    envelope.version !== 'command-eve-agent-usage/v1' ||
    envelope.immutable !== true ||
    envelope.complete !== true ||
    !isValidUsageMonth(envelope.period) ||
    !finiteTimestamp(envelope.as_of) ||
    !Array.isArray(envelope.rows)
  ) {
    return null;
  }
  const asOf = finiteTimestamp(envelope.as_of);
  if (!asOf) return null;

  const rows: AgentUsageLedgerRow[] = [];
  const ledgerIds = new Set<string>();
  for (const rawRow of envelope.rows) {
    const row = parseAgentUsageLedgerRow(rawRow);
    if (!row || ledgerIds.has(row.ledger_event_id)) return null;
    ledgerIds.add(row.ledger_event_id);
    rows.push(row);
  }

  return {
    version: 'command-eve-agent-usage/v1',
    immutable: true,
    complete: true,
    period: envelope.period,
    as_of: asOf,
    rows,
  };
}

function unavailableAgentUsage(period: string, reason: AgentUsageUnavailableReason): VerifiedAgentUsageSnapshot {
  return { status: 'unavailable', period, reason, rows: [], total_calls: null, as_of: null };
}

/**
 * Verify a parsed SG-1 envelope for the exact period and displayed agent set.
 * No filtering or fallback is allowed: one mismatched row makes the whole
 * snapshot unavailable, preventing a subset from being presented as the total.
 */
export function verifyAgentUsageLedger(
  envelope: AgentUsageLedgerEnvelope | null,
  expectedPeriod: string,
  displayedAgentIds: readonly string[],
  now: Date = new Date(),
  maxAgeMs: number = AGENT_USAGE_MAX_AGE_MS
): VerifiedAgentUsageSnapshot {
  const period = isValidUsageMonth(expectedPeriod) ? expectedPeriod : currentUsageMonth(now);
  if (!envelope) return unavailableAgentUsage(period, 'missing-or-malformed');
  if (envelope.period !== period || envelope.rows.some((row) => row.period !== period)) {
    return unavailableAgentUsage(period, 'period-mismatch');
  }
  if (envelope.rows.some((row) => currentUsageMonth(new Date(row.recorded_at)) !== period)) {
    return unavailableAgentUsage(period, 'period-mismatch');
  }

  const asOfMs = Date.parse(envelope.as_of);
  const nowMs = now.getTime();
  if (!Number.isFinite(asOfMs) || asOfMs > nowMs + 5 * 60 * 1000 || nowMs - asOfMs > maxAgeMs) {
    return unavailableAgentUsage(period, 'stale');
  }

  const allowed = new Set(displayedAgentIds);
  if (envelope.rows.some((row) => !allowed.has(row.agent_id))) {
    return unavailableAgentUsage(period, 'agent-mismatch');
  }
  if (envelope.rows.length === 0) return unavailableAgentUsage(period, 'no-matching-rows');

  const rowAfterSnapshot = envelope.rows.some((row) => Date.parse(row.recorded_at) > asOfMs + 5 * 60 * 1000);
  if (rowAfterSnapshot) return unavailableAgentUsage(period, 'stale');

  const totalCalls = envelope.rows.reduce((sum, row) => sum + row.calls, 0);
  if (!Number.isSafeInteger(totalCalls)) return unavailableAgentUsage(period, 'missing-or-malformed');

  return {
    status: 'available',
    period,
    rows: envelope.rows,
    total_calls: totalCalls,
    as_of: envelope.as_of,
  };
}

/** Read and verify the optional agent ledger from a seat-usage shaped value. */
export function verifiedAgentUsageFromSeatUsage(
  raw: unknown,
  expectedPeriod: string,
  displayedAgentIds: readonly string[],
  now: Date = new Date(),
  maxAgeMs: number = AGENT_USAGE_MAX_AGE_MS
): VerifiedAgentUsageSnapshot {
  const candidate = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).agent_usage : null;
  return verifyAgentUsageLedger(
    parseAgentUsageLedgerEnvelope(candidate),
    expectedPeriod,
    displayedAgentIds,
    now,
    maxAgeMs
  );
}

/**
 * Shape the already parsed and seat-partitioned response for IPC. Deliberately
 * copies only the typed fields so raw provider bodies, headers or secret-adjacent
 * wire data can never hitchhike to the renderer.
 */
export function buildSeatUsageIpcResult(scoped: SeatUsageResponse): SeatUsageIpcResult {
  return {
    version: 'command-eve-seat-usage/v0',
    ok: scoped.ok,
    month: scoped.month,
    seats: scoped.seats,
    total: scoped.total,
    agent_usage: scoped.agent_usage,
  };
}

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
    agent_usage: null,
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

  return {
    ok: true,
    month: isValidUsageMonth(month) ? month : currentUsageMonth(),
    seats,
    total,
    agent_usage: parseAgentUsageLedgerEnvelope(obj.agent_usage),
  };
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
  // The SG-1 envelope is agent-scoped but does not itself carry seat identity.
  // Until the server supplies a seat-bound proof, a delegate partition must not
  // receive it; only the already-authorized owner/all-seat path above may keep it.
  return { ok: response.ok, month: response.month, seats, total, agent_usage: null };
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
