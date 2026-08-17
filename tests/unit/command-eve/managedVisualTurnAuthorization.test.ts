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

  it('binds the opaque marker to seat plus monotonic revision and rejects an identical replay', () => {
    const authorization = authorize({ request: request('max') });
    if (!authorization.marker) throw new Error('expected marker');
    const body = {
      session_id: 'hermes-session-a',
      messages: [{ role: 'user', content: `${authorization.marker}\nAnalyze the deck.` }],
    };

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
      reason_code: 'AUTHORIZATION_REPLAY',
    });
  });

  it('authorizes one unique same-session Hermes tool continuation and rejects cross-session replay', () => {
    const authorization = authorize();
    if (!authorization.marker) throw new Error('expected marker');
    const user = { role: 'user', content: `${authorization.marker}\nAnalyze the image.` };
    const initial = { session_id: 'hermes-session-a', messages: [user] };
    expect(resolveCommandEveManagedVisualTurn(initial, SEAT_A, REVISION_A, 2_000)).toMatchObject({
      status: 'authorized',
    });

    const continuation = {
      session_id: 'hermes-session-a',
      messages: [
        user,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'vision_analyze', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'The image contains the requested evidence.' },
      ],
    };
    expect(resolveCommandEveManagedVisualTurn(continuation, SEAT_A, REVISION_A, 2_001)).toMatchObject({
      status: 'authorized',
    });
    expect(resolveCommandEveManagedVisualTurn(continuation, SEAT_A, REVISION_A, 2_002)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_REPLAY',
    });
    expect(
      resolveCommandEveManagedVisualTurn({ ...continuation, session_id: 'hermes-session-b' }, SEAT_A, REVISION_A, 2_003)
    ).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_SESSION_MISMATCH',
    });

    const forkedContinuation = {
      session_id: 'hermes-session-a',
      messages: [
        user,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-fork', type: 'function', function: { name: 'vision_analyze', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call-fork', content: 'alternate branch' },
      ],
    };
    expect(resolveCommandEveManagedVisualTurn(forkedContinuation, SEAT_A, REVISION_A, 2_004)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_CONTINUATION_INVALID',
    });
  });

  it('requires a session before the first provider request', () => {
    const authorization = authorize();
    if (!authorization.marker) throw new Error('expected marker');
    expect(
      resolveCommandEveManagedVisualTurn(
        { messages: [{ role: 'user', content: `${authorization.marker}\nAnalyze the image.` }] },
        SEAT_A,
        REVISION_A,
        2_000
      )
    ).toMatchObject({ status: 'invalid', reason_code: 'AUTHORIZATION_SESSION_REQUIRED' });
  });

  it('supports parallel tools and a later sequential tool round in the same append-only chain', () => {
    const authorization = authorize();
    if (!authorization.marker) throw new Error('expected marker');
    const user = { role: 'user', content: `${authorization.marker}\nAnalyze the image.` };
    const messages: Record<string, unknown>[] = [user];
    expect(
      resolveCommandEveManagedVisualTurn({ session_id: 'hermes-session-a', messages }, SEAT_A, REVISION_A, 2_000)
    ).toMatchObject({ status: 'authorized' });

    messages.push(
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'vision_analyze', arguments: '{}' } },
          { id: 'call-2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'visual result' },
      { role: 'tool', tool_call_id: 'call-2', content: 'file result' }
    );
    expect(
      resolveCommandEveManagedVisualTurn({ session_id: 'hermes-session-a', messages }, SEAT_A, REVISION_A, 2_001)
    ).toMatchObject({ status: 'authorized' });

    messages.push(
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-3', type: 'function', function: { name: 'vision_analyze', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-3', content: 'second visual result' }
    );
    expect(
      resolveCommandEveManagedVisualTurn({ session_id: 'hermes-session-a', messages }, SEAT_A, REVISION_A, 2_002)
    ).toMatchObject({ status: 'authorized' });
  });

  it('allows Hermes to compact history before the marked visual turn without weakening that turn chain', () => {
    const authorization = authorize();
    if (!authorization.marker) throw new Error('expected marker');
    const user = { role: 'user', content: `${authorization.marker}\nAnalyze the image.` };
    expect(
      resolveCommandEveManagedVisualTurn(
        {
          session_id: 'hermes-session-a',
          messages: [
            { role: 'system', content: 'Original system context.' },
            { role: 'assistant', content: 'Older conversation history.' },
            user,
          ],
        },
        SEAT_A,
        REVISION_A,
        2_000
      )
    ).toMatchObject({ status: 'authorized' });

    expect(
      resolveCommandEveManagedVisualTurn(
        {
          session_id: 'hermes-session-a',
          messages: [
            { role: 'system', content: 'Compacted system context.' },
            user,
            {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'vision_analyze', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'call-1', content: 'visual result' },
          ],
        },
        SEAT_A,
        REVISION_A,
        2_001
      )
    ).toMatchObject({ status: 'authorized' });
  });

  it('accepts a 438-message, roughly 185k-token-shaped prehistory when the latest marked turn is valid and under the body cap', () => {
    const authorization = authorize();
    if (!authorization.marker) throw new Error('expected marker');
    // 437 older messages × 423 whitespace-delimited tokens is roughly 185k
    // tokens. The marker contract intentionally hashes only the latest marked
    // turn and its append-only tool chain, so unrelated history cannot turn a
    // valid new image request into an authorization failure.
    const olderMessages = Array.from({ length: 437 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: 'history '.repeat(423),
    }));
    const body = {
      session_id: 'hermes-session-a',
      messages: [...olderMessages, { role: 'user', content: `${authorization.marker}\nAnalyze the image.` }],
    };
    expect(body.messages).toHaveLength(438);
    expect(JSON.stringify(body).length).toBeLessThan(25_000_000);
    expect(resolveCommandEveManagedVisualTurn(body, SEAT_A, REVISION_A, 2_000)).toMatchObject({
      status: 'authorized',
    });
  });

  it('caps a single visual turn at sixteen unique provider requests', () => {
    const authorization = authorize();
    if (!authorization.marker) throw new Error('expected marker');
    const messages: Record<string, unknown>[] = [
      { role: 'user', content: `${authorization.marker}\nAnalyze the image.` },
    ];
    const resolve = (nowMs: number) =>
      resolveCommandEveManagedVisualTurn({ session_id: 'hermes-session-a', messages }, SEAT_A, REVISION_A, nowMs);

    expect(resolve(2_000)).toMatchObject({ status: 'authorized' });
    for (let round = 1; round <= 15; round += 1) {
      const callId = `call-${round}`;
      messages.push(
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: callId, type: 'function', function: { name: 'vision_analyze', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: callId, content: `result-${round}` }
      );
      expect(resolve(2_000 + round)).toMatchObject({ status: 'authorized' });
    }

    messages.push(
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-16', type: 'function', function: { name: 'vision_analyze', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call-16', content: 'result-16' }
    );
    expect(resolve(2_016)).toMatchObject({ status: 'invalid', reason_code: 'AUTHORIZATION_CHAIN_LIMIT' });
  });

  it('rejects malformed or unmatched tool-result continuations before egress', () => {
    const authorization = authorize();
    if (!authorization.marker) throw new Error('expected marker');
    const user = { role: 'user', content: `${authorization.marker}\nAnalyze the image.` };
    expect(
      resolveCommandEveManagedVisualTurn(
        { session_id: 'hermes-session-a', messages: [user] },
        SEAT_A,
        REVISION_A,
        2_000
      )
    ).toMatchObject({ status: 'authorized' });

    const malformed = {
      session_id: 'hermes-session-a',
      messages: [
        user,
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'vision_analyze', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'different-call', content: 'unmatched' },
      ],
    };
    expect(resolveCommandEveManagedVisualTurn(malformed, SEAT_A, REVISION_A, 2_001)).toMatchObject({
      status: 'invalid',
      reason_code: 'AUTHORIZATION_CONTINUATION_INVALID',
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
      session_id: 'hermes-session-a',
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
