/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-625 — the memory-boundary contract. Pins the three structural invariants:
 * seat isolation (no cross-client write), the S3 hard floor (never persist/derive raw
 * secret/financial/health), and the derive egress class (deriver only local or through
 * the redaction shim), plus the oversize raw-transcript smell. The S3 trigger strings
 * are the SAME ones the egress detector test uses, so memory + egress share one truth.
 */

import { describe, expect, it } from 'vitest';
import {
  enforceMemoryBoundary,
  MEMORY_BOUNDARY_OK,
  MEMORY_BOUNDARY_MALFORMED,
  MEMORY_BOUNDARY_SEAT_UNKNOWN,
  MEMORY_BOUNDARY_SEAT_MISMATCH,
  MEMORY_BOUNDARY_S3_FORBIDDEN,
  MEMORY_BOUNDARY_EGRESS_UNREDACTED,
  MEMORY_BOUNDARY_OVERSIZE,
} from '@/process/commandEve/memoryBoundaryContractCore';

// Real S3-triggering strings (identical to egressBoundaryCore.test.ts).
const SECRET = 'Mein API key: sk-abcdefghijklmnopqrstuvwxyz123456';
const FINANCIAL = 'Bitte überweise auf IBAN DE89 3704 0044 0532 0130 00, Karte 4111 1111 1111 1111.';
const HEALTH = 'Versichertennummer: A123456789 — bitte vormerken.';
const BENIGN = 'Kunde will bis Freitag die Landingpage-Texte.';

describe('memory-boundary — MALFORMED fail-closed (Codex re-audit holes)', () => {
  it('rejects undefined input (no silent allow)', () => {
    expect(enforceMemoryBoundary(undefined as never).reasonCode).toBe(MEMORY_BOUNDARY_MALFORMED);
  });

  it('rejects a write with a missing store (nothing to scope/cap)', () => {
    expect(enforceMemoryBoundary({ operation: 'write', payloadText: 'benign' }).reasonCode).toBe(MEMORY_BOUNDARY_MALFORMED);
  });

  it('rejects an unknown store instead of skipping seat isolation (the cross-seat bypass)', () => {
    const d = enforceMemoryBoundary({ operation: 'write', store: 'made-up-store' as never, activeSeatId: 'seat-a', targetSeatId: 'seat-b', payloadText: BENIGN });
    expect(d.ok).toBe(false);
    expect(d.reasonCode).toBe(MEMORY_BOUNDARY_MALFORMED);
  });

  it('rejects a missing operation instead of defaulting to read (the S3-on-read bypass)', () => {
    expect(enforceMemoryBoundary({ store: 'company-brain', payloadText: SECRET } as never).reasonCode).toBe(MEMORY_BOUNDARY_MALFORMED);
  });

  it('rejects an unknown operation instead of skipping the write oversize gate', () => {
    const d = enforceMemoryBoundary({ operation: 'persist' as never, store: 'company-brain', activeSeatId: 's', targetSeatId: 's', payloadText: 'x'.repeat(100000) });
    expect(d.ok).toBe(false);
    expect(d.reasonCode).toBe(MEMORY_BOUNDARY_MALFORMED);
  });
});

describe('memory-boundary — seat isolation (GATE-NULL extension)', () => {
  it('rejects a write whose target seat is not the active seat', () => {
    const d = enforceMemoryBoundary({ operation: 'write', store: 'company-brain', activeSeatId: 'seat-a', targetSeatId: 'seat-b', payloadText: BENIGN });
    expect(d.ok).toBe(false);
    expect(d.reasonCode).toBe(MEMORY_BOUNDARY_SEAT_MISMATCH);
  });

  it('rejects a write with a missing/empty seat id (fail-closed)', () => {
    expect(enforceMemoryBoundary({ operation: 'write', store: 'company-brain', activeSeatId: '', targetSeatId: 'seat-a', payloadText: BENIGN }).reasonCode).toBe(MEMORY_BOUNDARY_SEAT_UNKNOWN);
    expect(enforceMemoryBoundary({ operation: 'write', store: 'honcho', activeSeatId: 'seat-a', targetSeatId: '  ', payloadText: BENIGN }).reasonCode).toBe(MEMORY_BOUNDARY_SEAT_UNKNOWN);
  });

  it('allows a write when active === target', () => {
    const d = enforceMemoryBoundary({ operation: 'write', store: 'company-brain', activeSeatId: 'seat-a', targetSeatId: 'seat-a', payloadText: BENIGN });
    expect(d.ok).toBe(true);
    expect(d.reasonCode).toBe(MEMORY_BOUNDARY_OK);
    expect(d.sensitivityClass).toBe('S0');
  });

  it('does not require a seat match for a pure read', () => {
    expect(enforceMemoryBoundary({ operation: 'read', store: 'company-brain' }).ok).toBe(true);
  });
});

describe('memory-boundary — S3 hard floor (never persist/derive raw secret/financial/health)', () => {
  it('rejects a write carrying a raw secret', () => {
    const d = enforceMemoryBoundary({ operation: 'write', store: 'company-brain', activeSeatId: 's', targetSeatId: 's', payloadText: SECRET });
    expect(d.ok).toBe(false);
    expect(d.reasonCode).toBe(MEMORY_BOUNDARY_S3_FORBIDDEN);
    expect(d.sensitivityClass).toBe('S3');
  });

  it('rejects a write carrying financial data (IBAN/card)', () => {
    expect(enforceMemoryBoundary({ operation: 'write', store: 'memory-md', activeSeatId: 's', targetSeatId: 's', payloadText: FINANCIAL }).reasonCode).toBe(MEMORY_BOUNDARY_S3_FORBIDDEN);
  });

  it('rejects a write carrying health data', () => {
    expect(enforceMemoryBoundary({ operation: 'write', store: 'user-md', activeSeatId: 's', targetSeatId: 's', payloadText: HEALTH }).reasonCode).toBe(MEMORY_BOUNDARY_S3_FORBIDDEN);
  });

  it('rejects an S3 payload on the derive path too (deriver never sees a raw secret)', () => {
    expect(enforceMemoryBoundary({ operation: 'derive', store: 'honcho', activeSeatId: 's', targetSeatId: 's', payloadText: SECRET, egress: 'redacted-cloud-deriver' }).reasonCode).toBe(MEMORY_BOUNDARY_S3_FORBIDDEN);
  });

  it('allows an S3 payload on a READ (recall is not a persist/derive)', () => {
    expect(enforceMemoryBoundary({ operation: 'read', store: 'company-brain', payloadText: SECRET }).ok).toBe(true);
  });
});

describe('memory-boundary — derive egress class (deriver only local or through the shim)', () => {
  it('rejects a derive that would egress as syncable-metadata (raw content off-device)', () => {
    const d = enforceMemoryBoundary({ operation: 'derive', store: 'honcho', activeSeatId: 's', targetSeatId: 's', payloadText: BENIGN, egress: 'syncable-metadata' });
    expect(d.ok).toBe(false);
    expect(d.reasonCode).toBe(MEMORY_BOUNDARY_EGRESS_UNREDACTED);
  });

  it('allows a local-only derive (local Gemma)', () => {
    expect(enforceMemoryBoundary({ operation: 'derive', store: 'honcho', activeSeatId: 's', targetSeatId: 's', payloadText: BENIGN, egress: 'local-only' }).ok).toBe(true);
  });

  it('allows a redacted-cloud-deriver derive and hands back S1+-stripped text when PII present', () => {
    const withPhone = 'Ruf den Kunden unter 0151 23456789 an.';
    const d = enforceMemoryBoundary({ operation: 'derive', store: 'honcho', activeSeatId: 's', targetSeatId: 's', payloadText: withPhone, egress: 'redacted-cloud-deriver' });
    expect(d.ok).toBe(true);
    expect(typeof d.redactedText).toBe('string');
    expect(d.redactedText).not.toContain('23456789');
  });

  it('does not attach redactedText for a benign (S0) redacted derive', () => {
    const d = enforceMemoryBoundary({ operation: 'derive', store: 'honcho', activeSeatId: 's', targetSeatId: 's', payloadText: BENIGN, egress: 'redacted-cloud-deriver' });
    expect(d.ok).toBe(true);
    expect(d.redactedText).toBeUndefined();
  });
});

describe('memory-boundary — oversize raw-transcript smell', () => {
  it('rejects a session-digest write past the 2000-char cap', () => {
    const d = enforceMemoryBoundary({ operation: 'write', store: 'session-digest', activeSeatId: 's', targetSeatId: 's', payloadText: 'x'.repeat(2001) });
    expect(d.ok).toBe(false);
    expect(d.reasonCode).toBe(MEMORY_BOUNDARY_OVERSIZE);
  });

  it('rejects a company-brain write past the 8000-char cap', () => {
    expect(enforceMemoryBoundary({ operation: 'write', store: 'company-brain', activeSeatId: 's', targetSeatId: 's', payloadText: 'y'.repeat(8001) }).reasonCode).toBe(MEMORY_BOUNDARY_OVERSIZE);
  });

  it('allows a digest write at the cap', () => {
    expect(enforceMemoryBoundary({ operation: 'write', store: 'session-digest', activeSeatId: 's', targetSeatId: 's', payloadText: 'z'.repeat(2000) }).ok).toBe(true);
  });
});
