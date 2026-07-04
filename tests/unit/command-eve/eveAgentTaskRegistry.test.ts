/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetEveAgentTaskRegistryForTest,
  currentLeaseFor,
  eveDispatchTelemetry,
  mintLeaseToken,
  regenerateLeases,
  resolveDispatchAgentId,
} from '../../../packages/desktop/src/process/commandEve/eveAgentTaskRegistry';

const SEAT_A = 'seat-1';
const SEAT_B = '11111111-2222-3333-4444-555555555555';

describe('eveAgentTaskRegistry (SG-1 Design A)', () => {
  beforeEach(() => {
    __resetEveAgentTaskRegistryForTest();
  });

  describe('mint — free-guard (A7a) + validity', () => {
    it('mints a lease for a paid roster role', () => {
      const lease = mintLeaseToken('growth-lead', SEAT_A);
      expect(lease).not.toBeNull();
      expect(lease?.agentId).toBe('growth-lead');
      expect(lease?.seatId).toBe(SEAT_A);
    });

    it('NEVER mints a lease for the free-floor role house-keeper (A7 free-guard)', () => {
      expect(mintLeaseToken('house-keeper', SEAT_A)).toBeNull();
      // …and so it can never be surfaced as a metered agent_id via any token.
      expect(currentLeaseFor('house-keeper', SEAT_A)).toBeUndefined();
    });

    it('never mints for the system default eve or a non-roster id', () => {
      expect(mintLeaseToken('eve', SEAT_A)).toBeNull();
      expect(mintLeaseToken('totally-made-up', SEAT_A)).toBeNull();
      expect(mintLeaseToken('', SEAT_A)).toBeNull();
    });

    it('never mints for a blank seat', () => {
      expect(mintLeaseToken('growth-lead', '   ')).toBeNull();
      expect(mintLeaseToken('growth-lead', '')).toBeNull();
    });

    it('mints WHITESPACE-FREE tokens (sh launcher tr -d invariant)', () => {
      // Exercise the production CSPRNG path many times.
      for (let i = 0; i < 200; i += 1) {
        __resetEveAgentTaskRegistryForTest();
        const lease = mintLeaseToken('seo-lead', SEAT_A);
        expect(lease).not.toBeNull();
        expect(lease?.token).toMatch(/^\S+$/);
        expect(/\s/.test(lease?.token ?? ' ')).toBe(false);
      }
    });

    it('rejects an injected whitespace token (defense-in-depth)', () => {
      expect(() => mintLeaseToken('seo-lead', SEAT_A, { randomToken: () => 'has space' })).toThrow(/whitespace-free/);
      expect(() => mintLeaseToken('seo-lead', SEAT_A, { randomToken: () => 'tab\there' })).toThrow(/whitespace-free/);
      expect(() => mintLeaseToken('seo-lead', SEAT_A, { randomToken: () => '' })).toThrow(/whitespace-free/);
    });

    it('is idempotent per (role, seat) — a re-emit does not churn tokens', () => {
      const first = mintLeaseToken('content-writer', SEAT_A);
      const second = mintLeaseToken('content-writer', SEAT_A);
      expect(first?.token).toBe(second?.token);
    });
  });

  describe('resolve — attribution + fail-open', () => {
    it('resolves a valid token on its own seat to the roster id', () => {
      const lease = mintLeaseToken('growth-lead', SEAT_A, { randomToken: () => 'tok-growth-a' });
      expect(resolveDispatchAgentId(lease?.token, SEAT_A)).toBe('growth-lead');
    });

    it('A1 steady-state: an absent/empty token → eve, NOT counted as anomaly', () => {
      expect(resolveDispatchAgentId(undefined, SEAT_A)).toBe('eve');
      expect(resolveDispatchAgentId('', SEAT_A)).toBe('eve');
      expect(resolveDispatchAgentId(null, SEAT_A)).toBe('eve');
      expect(eveDispatchTelemetry().unresolvedDispatchTokens).toBe(0);
    });

    it('SEAT-PARTITION: a token minted on seat A does NOT resolve on seat B (→ eve + counted)', () => {
      const lease = mintLeaseToken('growth-lead', SEAT_A, { randomToken: () => 'tok-cross-seat' });
      expect(resolveDispatchAgentId(lease?.token, SEAT_A)).toBe('growth-lead');
      expect(resolveDispatchAgentId(lease?.token, SEAT_B)).toBe('eve');
      expect(eveDispatchTelemetry().unresolvedDispatchTokens).toBe(1);
    });

    it('an unknown non-empty token → eve + counted', () => {
      expect(resolveDispatchAgentId('never-minted', SEAT_A)).toBe('eve');
      expect(eveDispatchTelemetry().unresolvedDispatchTokens).toBe(1);
    });

    it('A5 relaunch: prior tokens degrade to eve (no 409-series) + counted', () => {
      const lease = mintLeaseToken('seo-lead', SEAT_A, { randomToken: () => 'tok-before-relaunch' });
      expect(resolveDispatchAgentId(lease?.token, SEAT_A)).toBe('seo-lead');
      regenerateLeases();
      expect(resolveDispatchAgentId(lease?.token, SEAT_A)).toBe('eve');
      expect(eveDispatchTelemetry().unresolvedDispatchTokens).toBe(1);
    });

    it('a blank caller seat never resolves a lease (→ eve)', () => {
      const lease = mintLeaseToken('reddit-lead', SEAT_A, { randomToken: () => 'tok-blank-seat' });
      expect(resolveDispatchAgentId(lease?.token, '')).toBe('eve');
    });
  });
});
