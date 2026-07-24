/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_MANAGED_VISUAL_TURN_CONSENT_VERSION,
  extractCommandEveManagedVisualTurnToken,
  resolveCommandEveManagedVisualPreferredTier,
  stripCommandEveManagedVisualTurnMarkers,
} from '@/common/config/eveManagedVisualTurnCore';
import {
  authorizeCommandEveManagedVisualTurn,
  clearCommandEveManagedVisualTurnAuthorizationsForTests,
  resolveCommandEveManagedVisualTurn,
} from '@process/commandEve/managedVisualTurnAuthorizationCore';

const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);

const request = (preferredTier: 'high' | 'xhigh' | 'max' | 'ultra' = 'high') => ({
  consentVersion: COMMAND_EVE_MANAGED_VISUAL_TURN_CONSENT_VERSION,
  preferredTier,
  sourceCount: 1,
});

describe('managed visual turn authorization', () => {
  afterEach(() => clearCommandEveManagedVisualTurnAuthorizationsForTests());

  it('gives a paid seat at least high and preserves an explicit ultra selection', () => {
    const high = authorizeCommandEveManagedVisualTurn({
      request: request('high'),
      seatId: 'seat-paid',
      hasPaidSeat: true,
      hasLicenseWire: true,
      nowMs: 1_000,
      randomToken: () => TOKEN_A,
    });
    const ultra = authorizeCommandEveManagedVisualTurn({
      request: request('ultra'),
      seatId: 'seat-paid',
      hasPaidSeat: true,
      hasLicenseWire: true,
      nowMs: 1_000,
      randomToken: () => TOKEN_B,
    });
    expect(high).toMatchObject({ ok: true, tier: 'high' });
    expect(ultra).toMatchObject({ ok: true, tier: 'ultra' });
  });

  it('keeps free seats on the managed standard entitlement lane instead of local inference', () => {
    const result = authorizeCommandEveManagedVisualTurn({
      request: request('ultra'),
      seatId: 'seat-free',
      hasPaidSeat: false,
      hasLicenseWire: true,
      nowMs: 1_000,
      randomToken: () => TOKEN_A,
    });
    expect(result).toMatchObject({ ok: true, tier: 'standard' });
  });

  it('binds the opaque marker to the seat and expires fail-closed', () => {
    const authorization = authorizeCommandEveManagedVisualTurn({
      request: request('max'),
      seatId: 'seat-a',
      hasPaidSeat: true,
      hasLicenseWire: true,
      nowMs: 1_000,
      randomToken: () => TOKEN_A,
    });
    if (!authorization.marker) throw new Error('expected marker');
    const body = { messages: [{ role: 'user', content: `${authorization.marker}\nAnalyze the deck.` }] };
    expect(resolveCommandEveManagedVisualTurn(body, 'seat-b', 2_000)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_SEAT_MISMATCH',
    });
    expect(resolveCommandEveManagedVisualTurn(body, 'seat-a', 2_000)).toEqual({
      status: 'authorized',
      tier: 'max',
    });
    expect(resolveCommandEveManagedVisualTurn(body, 'seat-a', 2_001)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_UNKNOWN',
    });

    const expiringAuthorization = authorizeCommandEveManagedVisualTurn({
      request: request('high'),
      seatId: 'seat-a',
      hasPaidSeat: true,
      hasLicenseWire: true,
      nowMs: 1_000,
      randomToken: () => TOKEN_B,
    });
    if (!expiringAuthorization.marker) throw new Error('expected expiring marker');
    const expiringBody = {
      messages: [{ role: 'user', content: `${expiringAuthorization.marker}\nAnalyze the deck.` }],
    };
    expect(resolveCommandEveManagedVisualTurn(expiringBody, 'seat-a', 1_000 + 15 * 60 * 1000)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_EXPIRED',
    });
  });

  it('uses only the latest user turn and strips the authorization before model handling', () => {
    const authorization = authorizeCommandEveManagedVisualTurn({
      request: request(),
      seatId: 'seat-a',
      hasPaidSeat: true,
      hasLicenseWire: true,
      randomToken: () => TOKEN_A,
    });
    if (!authorization.marker) throw new Error('expected marker');
    const body = {
      messages: [
        { role: 'user', content: `${authorization.marker}\nAnalyze the deck.` },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: 'Thanks.' },
      ],
    };
    expect(resolveCommandEveManagedVisualTurn(body, 'seat-a')).toEqual({ status: 'absent' });
    expect(extractCommandEveManagedVisualTurnToken(authorization.marker)).toBe(TOKEN_A);
    expect(stripCommandEveManagedVisualTurnMarkers(`${authorization.marker}\nAnalyze the deck.`)).toBe(
      'Analyze the deck.'
    );
  });

  it('recognizes Hermes structured text parts without replaying an older authorization', () => {
    const authorization = authorizeCommandEveManagedVisualTurn({
      request: request('high'),
      seatId: 'seat-a',
      hasPaidSeat: true,
      hasLicenseWire: true,
      randomToken: () => TOKEN_A,
    });
    if (!authorization.marker) throw new Error('expected marker');

    const structured = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `${authorization.marker}\nAnalyze the deck.` }],
        },
      ],
    };
    expect(resolveCommandEveManagedVisualTurn(structured, 'seat-a')).toEqual({
      status: 'authorized',
      tier: 'high',
    });

    const newerNonTextUserTurn = {
      messages: [
        ...structured.messages,
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
      ],
    };
    expect(resolveCommandEveManagedVisualTurn(newerNonTextUserTurn, 'seat-a')).toEqual({ status: 'absent' });
  });

  it('rejects missing consent, license and malformed source counts', () => {
    expect(
      authorizeCommandEveManagedVisualTurn({
        request: { ...request(), consentVersion: 'wrong' as never },
        seatId: 'seat-a',
        hasPaidSeat: true,
        hasLicenseWire: true,
      })
    ).toMatchObject({ ok: false, reason_code: 'EVE_MANAGED_VISUAL_CONSENT_REQUIRED' });
    expect(
      authorizeCommandEveManagedVisualTurn({
        request: request(),
        seatId: 'seat-a',
        hasPaidSeat: true,
        hasLicenseWire: false,
      })
    ).toMatchObject({ ok: false, reason_code: 'EVE_MANAGED_VISUAL_NO_BEARER' });
    expect(
      authorizeCommandEveManagedVisualTurn({
        request: { ...request(), sourceCount: 7 },
        seatId: 'seat-a',
        hasPaidSeat: true,
        hasLicenseWire: true,
      })
    ).toMatchObject({ ok: false, reason_code: 'EVE_MANAGED_VISUAL_BAD_SOURCE_COUNT' });
  });

  it('maps local and standard picker selections to high while preserving higher paid tiers', () => {
    expect(resolveCommandEveManagedVisualPreferredTier(undefined)).toBe('high');
    expect(resolveCommandEveManagedVisualPreferredTier('standard')).toBe('high');
    expect(resolveCommandEveManagedVisualPreferredTier('xhigh')).toBe('xhigh');
    expect(resolveCommandEveManagedVisualPreferredTier('max')).toBe('max');
    expect(resolveCommandEveManagedVisualPreferredTier('ultra')).toBe('ultra');
  });
});
