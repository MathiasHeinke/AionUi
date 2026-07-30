/*
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  extractCommandEveManagedVisualTurnToken,
  resolveCommandEveManagedVisualPreferredTier,
  stripCommandEveManagedVisualTurnMarkers,
  type CommandEveManagedVisualTurnAuthorizationRequest,
} from '@/common/config/eveManagedVisualTurnCore';
import {
  authorizeCommandEveManagedVisualTurn,
  clearCommandEveManagedVisualTurnAuthorizationsForTests,
  resolveCommandEveManagedVisualTurn,
} from '@process/commandEve/managedVisualTurnAuthorizationCore';

const TOKEN_A = 'A'.repeat(43);
const TOKEN_B = 'B'.repeat(43);
const SEAT_A = 'seat-a';
const SEAT_B = 'seat-b';
const REVISION_A = 7;
const FLOW_A = 'visual_flow_0123456789abcdef';
const RECEIPT_ID = 'r'.repeat(43);
const RECEIPT = {
  version: 'command-eve-cloud-visual-policy/v1' as const,
  receiptId: RECEIPT_ID,
  flowId: FLOW_A,
  expiresAt: new Date(301_000).toISOString(),
};

const request = (
  preferredTier: 'high' | 'xhigh' | 'max' | 'ultra' = 'high'
): CommandEveManagedVisualTurnAuthorizationRequest => ({
  flowId: FLOW_A,
  visualPolicyReceipt: RECEIPT,
  preferredTier,
  sourceCount: 1,
});

const verifiedReceipt = {
  seatId: SEAT_A,
  seatContextRevision: REVISION_A,
  flowId: FLOW_A,
  receiptId: RECEIPT_ID,
};

function authorize(overrides: Partial<Parameters<typeof authorizeCommandEveManagedVisualTurn>[0]> = {}) {
  return authorizeCommandEveManagedVisualTurn({
    request: request(),
    seatId: SEAT_A,
    seatContextRevision: REVISION_A,
    verifiedReceipt,
    hasPaidSeat: true,
    hasLicenseWire: true,
    retireVerifiedReceipt: () => true,
    nowMs: 1_000,
    randomToken: () => TOKEN_A,
    ...overrides,
  });
}

describe('managed visual turn authorization', () => {
  afterEach(() => clearCommandEveManagedVisualTurnAuthorizationsForTests());

  it('gives a paid seat at least high and preserves an explicit ultra selection', () => {
    const high = authorize({ request: request('high') });
    const ultra = authorize({ request: request('ultra'), randomToken: () => TOKEN_B });
    expect(high).toMatchObject({ ok: true, tier: 'high' });
    expect(ultra).toMatchObject({ ok: true, tier: 'ultra' });
  });

  it('keeps free seats on the managed standard entitlement lane instead of local inference', () => {
    expect(authorize({ request: request('ultra'), hasPaidSeat: false })).toMatchObject({
      ok: true,
      tier: 'standard',
    });
  });

  it('requires the verified flow receipt and rejects historical consent-only input', () => {
    expect(authorize({ verifiedReceipt: undefined })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MANAGED_VISUAL_POLICY_RECEIPT_REQUIRED',
    });
    expect(
      authorize({
        request: {
          consentVersion: 'command-eve-managed-visual-turn-consent/v1',
          preferredTier: 'high',
          sourceCount: 1,
        },
      })
    ).toMatchObject({ ok: false, reason_code: 'EVE_MANAGED_VISUAL_POLICY_RECEIPT_REQUIRED' });
    expect(
      authorize({
        verifiedReceipt: { ...verifiedReceipt, receiptId: 'x'.repeat(43) },
      })
    ).toMatchObject({ ok: false, reason_code: 'EVE_MANAGED_VISUAL_POLICY_RECEIPT_REQUIRED' });
  });

  it('binds the opaque marker to seat plus monotonic revision and consumes it once', () => {
    const authorization = authorize({ request: request('max') });
    if (!authorization.marker) throw new Error('expected marker');
    const body = { messages: [{ role: 'user', content: `${authorization.marker}\nAnalyze the deck.` }] };

    expect(resolveCommandEveManagedVisualTurn(body, SEAT_B, REVISION_A, 2_000)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_SEAT_MISMATCH',
    });
    expect(resolveCommandEveManagedVisualTurn(body, SEAT_A, REVISION_A + 2, 2_000)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_SEAT_MISMATCH',
    });
    expect(resolveCommandEveManagedVisualTurn(body, SEAT_A, REVISION_A, 2_000)).toEqual({
      status: 'authorized',
      tier: 'max',
      visualPolicyClaim: verifiedReceipt,
    });
    expect(resolveCommandEveManagedVisualTurn(body, SEAT_A, REVISION_A, 2_001)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_UNKNOWN',
    });
  });

  it('expires fail-closed and never restores a consumed marker', () => {
    const authorization = authorize();
    if (!authorization.marker) throw new Error('expected marker');
    const body = { messages: [{ role: 'user', content: authorization.marker }] };
    expect(resolveCommandEveManagedVisualTurn(body, SEAT_A, REVISION_A, 1_000 + 15 * 60 * 1000)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_EXPIRED',
    });
    expect(resolveCommandEveManagedVisualTurn(body, SEAT_A, REVISION_A, 2_000)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_UNKNOWN',
    });
  });

  it('uses only the latest user turn and strips the authorization before model handling', () => {
    const authorization = authorize();
    if (!authorization.marker) throw new Error('expected marker');
    const body = {
      messages: [
        { role: 'user', content: `${authorization.marker}\nAnalyze the deck.` },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: 'Thanks.' },
      ],
    };
    expect(resolveCommandEveManagedVisualTurn(body, SEAT_A, REVISION_A)).toEqual({ status: 'absent' });
    expect(extractCommandEveManagedVisualTurnToken(authorization.marker)).toBe(TOKEN_A);
    expect(stripCommandEveManagedVisualTurnMarkers(`${authorization.marker}\nAnalyze the deck.`)).toBe(
      'Analyze the deck.'
    );
  });

  it('recognizes Hermes structured text parts without replaying an older authorization', () => {
    const authorization = authorize();
    if (!authorization.marker) throw new Error('expected marker');
    const structured = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `${authorization.marker}\nAnalyze the deck.` }],
        },
      ],
    };
    expect(resolveCommandEveManagedVisualTurn(structured, SEAT_A, REVISION_A, 2_000)).toEqual({
      status: 'authorized',
      tier: 'high',
      visualPolicyClaim: verifiedReceipt,
    });

    const newerNonTextUserTurn = {
      messages: [
        ...structured.messages,
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
      ],
    };
    expect(resolveCommandEveManagedVisualTurn(newerNonTextUserTurn, SEAT_A, REVISION_A)).toEqual({
      status: 'absent',
    });
  });

  it('retires the verified receipt only after every earlier marker gate passes', () => {
    let retireCalls = 0;
    const retireVerifiedReceipt = () => {
      retireCalls += 1;
      return true;
    };

    expect(authorize({ hasLicenseWire: false, retireVerifiedReceipt })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MANAGED_VISUAL_NO_BEARER',
    });
    expect(authorize({ request: { ...request(), sourceCount: 7 }, retireVerifiedReceipt })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MANAGED_VISUAL_BAD_SOURCE_COUNT',
    });
    expect(retireCalls).toBe(0);

    expect(authorize({ retireVerifiedReceipt })).toMatchObject({ ok: true });
    expect(retireCalls).toBe(1);
  });

  it('mints no marker when atomic receipt retirement loses a race', () => {
    const result = authorize({ retireVerifiedReceipt: () => false });
    expect(result).toMatchObject({
      ok: false,
      reason_code: 'EVE_MANAGED_VISUAL_POLICY_RECEIPT_REQUIRED',
    });
    expect(result).not.toHaveProperty('marker');
  });

  it('rejects missing license and malformed source counts', () => {
    expect(authorize({ hasLicenseWire: false })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MANAGED_VISUAL_NO_BEARER',
    });
    expect(authorize({ request: { ...request(), sourceCount: 7 } })).toMatchObject({
      ok: false,
      reason_code: 'EVE_MANAGED_VISUAL_BAD_SOURCE_COUNT',
    });
  });

  it('maps local and standard picker selections to high while preserving higher paid tiers', () => {
    expect(resolveCommandEveManagedVisualPreferredTier(undefined)).toBe('high');
    expect(resolveCommandEveManagedVisualPreferredTier('standard')).toBe('high');
    expect(resolveCommandEveManagedVisualPreferredTier('xhigh')).toBe('xhigh');
    expect(resolveCommandEveManagedVisualPreferredTier('max')).toBe('max');
    expect(resolveCommandEveManagedVisualPreferredTier('ultra')).toBe('ultra');
  });
});
