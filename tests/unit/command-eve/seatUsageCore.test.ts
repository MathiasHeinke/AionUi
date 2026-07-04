/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SEAT_USAGE_UNATTRIBUTED_LABEL,
  buildSeatUsageCardRows,
  currentUsageMonth,
  emptySeatUsage,
  isValidUsageMonth,
  parseSeatUsageResponse,
  partitionSeatUsageForViewer,
  priorUsageMonth,
  type SeatUsageResponse,
  type SeatUsageRow,
} from '../../../packages/desktop/src/common/config/seatUsageCore';

describe('seatUsageCore — month helpers', () => {
  it('validates YYYY-MM strictly (01..12)', () => {
    expect(isValidUsageMonth('2026-07')).toBe(true);
    expect(isValidUsageMonth('2026-01')).toBe(true);
    expect(isValidUsageMonth('2026-12')).toBe(true);
    expect(isValidUsageMonth('2026-13')).toBe(false);
    expect(isValidUsageMonth('2026-00')).toBe(false);
    expect(isValidUsageMonth('2026-7')).toBe(false);
    expect(isValidUsageMonth('202607')).toBe(false);
    expect(isValidUsageMonth(undefined)).toBe(false);
    expect(isValidUsageMonth(202607)).toBe(false);
  });

  it('derives the current UTC month', () => {
    expect(currentUsageMonth(new Date('2026-07-02T12:00:00Z'))).toBe('2026-07');
    expect(currentUsageMonth(new Date('2026-01-31T23:59:59Z'))).toBe('2026-01');
  });

  it('rolls the prior month back, including the January→December year wrap', () => {
    expect(priorUsageMonth('2026-07')).toBe('2026-06');
    expect(priorUsageMonth('2026-01')).toBe('2025-12');
    // A malformed anchor degrades to the current month, never throws.
    expect(isValidUsageMonth(priorUsageMonth('garbage'))).toBe(true);
  });
});

describe('seatUsageCore — defensive wire parse (version-skew safe)', () => {
  it('parses a well-formed ok response, including a NULL "Nicht zugeordnet" bucket', () => {
    const raw = {
      ok: true,
      month: '2026-07',
      seats: [
        { seat_id: 'seat-1', calls: 10, ok_calls: 9, prompt_tokens: 100, completion_tokens: 50, retail_eur_cents: 12.5, raw_eur_cents: 3.1, credits: 125 },
        { seat_id: null, calls: 2, ok_calls: 2, prompt_tokens: 20, completion_tokens: 10, retail_eur_cents: 2, raw_eur_cents: 0.5, credits: 20 },
      ],
      total: { calls: 12, ok_calls: 11, prompt_tokens: 120, completion_tokens: 60, retail_eur_cents: 14.5, raw_eur_cents: 3.6, credits: 145 },
    };
    const parsed = parseSeatUsageResponse(raw, '2026-07');
    expect(parsed.ok).toBe(true);
    expect(parsed.month).toBe('2026-07');
    expect(parsed.seats).toHaveLength(2);
    expect(parsed.seats[0].seat_id).toBe('seat-1');
    expect(parsed.seats[1].seat_id).toBeNull();
    expect(parsed.total.credits).toBe(145);
  });

  it('treats ok:false / absent / malformed as an empty unavailable model (resting state)', () => {
    expect(parseSeatUsageResponse({ ok: false }, '2026-07').ok).toBe(false);
    expect(parseSeatUsageResponse(null, '2026-07').ok).toBe(false);
    expect(parseSeatUsageResponse('nope', '2026-07').ok).toBe(false);
    expect(parseSeatUsageResponse(undefined, '2026-07').seats).toEqual([]);
    // A 404/version-skew shape (no ok field) is unavailable, not a crash.
    expect(parseSeatUsageResponse({ month: '2026-07', seats: [] }, '2026-07').ok).toBe(false);
  });

  it('degrades a missing numeric field on a seat row to 0 (never NaN/throw)', () => {
    const parsed = parseSeatUsageResponse(
      { ok: true, month: '2026-07', seats: [{ seat_id: 'seat-1' }], total: {} },
      '2026-07'
    );
    expect(parsed.seats[0].calls).toBe(0);
    expect(parsed.seats[0].credits).toBe(0);
    expect(parsed.total.retail_eur_cents).toBe(0);
  });

  it('emptySeatUsage echoes a valid month and zeroes the total', () => {
    const empty = emptySeatUsage('2026-07');
    expect(empty.ok).toBe(false);
    expect(empty.month).toBe('2026-07');
    expect(empty.total.calls).toBe(0);
    expect(isValidUsageMonth(emptySeatUsage('garbage').month)).toBe(true);
  });
});

describe('seatUsageCore — card-row shaping (label join + ordering + visibility)', () => {
  const rows: SeatUsageRow[] = [
    { seat_id: 'uuid-client', calls: 4, ok_calls: 4, prompt_tokens: 0, completion_tokens: 0, retail_eur_cents: 500, raw_eur_cents: 100, credits: 50 },
    { seat_id: 'seat-1', calls: 10, ok_calls: 10, prompt_tokens: 0, completion_tokens: 0, retail_eur_cents: 1000, raw_eur_cents: 200, credits: 100 },
    { seat_id: null, calls: 1, ok_calls: 1, prompt_tokens: 0, completion_tokens: 0, retail_eur_cents: 50, raw_eur_cents: 10, credits: 5 },
    { seat_id: 'uuid-usage-only', calls: 2, ok_calls: 2, prompt_tokens: 0, completion_tokens: 0, retail_eur_cents: 200, raw_eur_cents: 40, credits: 20 },
  ];
  // Rail order: Founder (seat-1) first, then the client seat. uuid-usage-only is NOT listed.
  const seatOrder = ['seat-1', 'uuid-client'];
  const labelFor = (id: string | null): string | undefined =>
    id === 'seat-1' ? 'Founder' : id === 'uuid-client' ? 'Klinik Salem' : undefined;

  it('founder summary (visibleSeatId=null): all rows, Rail order, usage-only then NULL last', () => {
    const cards = buildSeatUsageCardRows(rows, seatOrder, labelFor, null);
    expect(cards.map((c) => c.seat_id)).toEqual(['seat-1', 'uuid-client', 'uuid-usage-only', null]);
    expect(cards[0].label).toBe('Founder');
    expect(cards[1].label).toBe('Klinik Salem');
    // An id with no label (usage-only, unknown) and the NULL bucket both read "Nicht zugeordnet".
    expect(cards[2].label).toBe(SEAT_USAGE_UNATTRIBUTED_LABEL);
    expect(cards[3].label).toBe(SEAT_USAGE_UNATTRIBUTED_LABEL);
  });

  it('bar fraction is relative to the max credits in the set; retail_eur is cents/100', () => {
    const cards = buildSeatUsageCardRows(rows, seatOrder, labelFor, null);
    const founder = cards.find((c) => c.seat_id === 'seat-1')!;
    const client = cards.find((c) => c.seat_id === 'uuid-client')!;
    expect(founder.bar_fraction).toBe(1); // 100 credits is the max
    expect(client.bar_fraction).toBeCloseTo(0.5, 5); // 50 / 100
    expect(founder.retail_eur).toBeCloseTo(10, 5); // 1000 cents
  });

  it('client-seat scope (visibleSeatId set): ONLY the active seat row — no sibling seats leak', () => {
    const cards = buildSeatUsageCardRows(rows, seatOrder, labelFor, 'uuid-client');
    expect(cards).toHaveLength(1);
    expect(cards[0].seat_id).toBe('uuid-client');
    expect(cards[0].label).toBe('Klinik Salem');
    // Its own bar is full when it is the only visible row.
    expect(cards[0].bar_fraction).toBe(1);
  });
});

describe('seatUsageCore — partitionSeatUsageForViewer (C1: main-side wire partition)', () => {
  const response: SeatUsageResponse = {
    ok: true,
    month: '2026-07',
    seats: [
      { seat_id: 'seat-1', calls: 10, ok_calls: 10, prompt_tokens: 100, completion_tokens: 40, retail_eur_cents: 1000, raw_eur_cents: 200, credits: 100 },
      { seat_id: 'uuid-client', calls: 4, ok_calls: 4, prompt_tokens: 20, completion_tokens: 8, retail_eur_cents: 500, raw_eur_cents: 100, credits: 50 },
      { seat_id: null, calls: 1, ok_calls: 1, prompt_tokens: 5, completion_tokens: 2, retail_eur_cents: 50, raw_eur_cents: 10, credits: 5 },
    ],
    total: { calls: 15, ok_calls: 15, prompt_tokens: 125, completion_tokens: 50, retail_eur_cents: 1550, raw_eur_cents: 310, credits: 155 },
  };

  it('owner/all-seat summary (visibleSeatId=null): returns the response UNCHANGED', () => {
    const out = partitionSeatUsageForViewer(response, null);
    expect(out).toBe(response); // same reference — no copy, no filter
    expect(out.seats).toHaveLength(3);
    expect(out.total.retail_eur_cents).toBe(1550);
  });

  it('client seat: keeps ONLY its own row and RE-DERIVES total — no sibling row, id, cost or account-wide aggregate leaks', () => {
    const out = partitionSeatUsageForViewer(response, 'uuid-client');
    expect(out.seats).toHaveLength(1);
    expect(out.seats[0].seat_id).toBe('uuid-client');
    // No sibling seat ids survive the partition.
    expect(out.seats.some((r) => r.seat_id === 'seat-1' || r.seat_id === null)).toBe(false);
    // The total reflects ONLY the viewer's own row — never the account-wide sum.
    expect(out.total.retail_eur_cents).toBe(500);
    expect(out.total.raw_eur_cents).toBe(100);
    expect(out.total.calls).toBe(4);
    expect(out.total.credits).toBe(50);
  });

  it('a viewer with no attributed usage: empty seats + zero total (never falls back to account-wide)', () => {
    const out = partitionSeatUsageForViewer(response, 'uuid-unknown-seat');
    expect(out.seats).toHaveLength(0);
    expect(out.total.retail_eur_cents).toBe(0);
    expect(out.total.calls).toBe(0);
    expect(out.total.credits).toBe(0);
  });
});
