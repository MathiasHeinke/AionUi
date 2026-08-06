/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The send-catch quota gate (CEVE-18205 quota forensics).
 *
 * A live turn died as a cold UNKNOWN_UPSTREAM_ERROR card with the residue
 * `0.1}]}` on screen, while agent.log held a perfectly-formed 402
 * quota_exhausted contract. Root cause: the warm-wall detection
 * (`detectQuotaExhausted` via `useQuotaWall.reportInferenceError`) was wired on
 * the STREAM-error lane only; a 402 that kills the SEND itself arrives as a
 * backend BAD_GATEWAY in the AcpSendBox / useAcpInitialMessage catch, which
 * never asked the wall and stamped every such failure UNKNOWN_UPSTREAM_ERROR.
 *
 * Three contracts here:
 *   1. `detectQuotaExhausted` recognizes the REAL flat shape of that lane —
 *      the BackendHttpError whose message embeds the python-repr 402 body —
 *      so the gate has something to switch on.
 *   2. `stripEmbeddedJsonFromSendFailureText` cuts leaked machine bodies (and
 *      orphaned tails like `0.1}]}`) out of the user-visible sentence while
 *      keeping the `[ACP-AUTH-…]` markers the auth branch matches on.
 *   3. Source contract, in the sendBoxFailureVisibility style (the DOM suites
 *      mock the real components away): both catch sites ask the wall BEFORE
 *      building the cold card, and the card is gated on a negative signal.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectQuotaExhausted } from '@/common/config/creditsCore';
import { stripEmbeddedJsonFromSendFailureText } from '@/renderer/pages/conversation/platforms/acp/useAcpInitialMessage';

const ACP_SEND_BOX = resolve(process.cwd(), 'packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx');
const INITIAL_MESSAGE = resolve(
  process.cwd(),
  'packages/desktop/src/renderer/pages/conversation/platforms/acp/useAcpInitialMessage.ts'
);

/** The observed real-world lane shape: Hermes' flat 402 text inside the backend's 502. */
const HERMES_402_TEXT =
  "Error: HTTP 402: Error code: 402 - {'error': 'quota_exhausted', 'reason': 'insufficient_credits', " +
  "'credits_needed': 41, 'credits_available': 0, 'shortfall_credits': 41, " +
  "'packs': [{'eur': 5, 'credits': 5000, 'bonus': 0.05}, {'eur': 20, 'credits': 21000, 'bonus': 0.1}]}";

const backendBadGatewayError = () => {
  const body = { code: 'BAD_GATEWAY', error: HERMES_402_TEXT };
  return {
    name: 'BackendHttpError',
    status: 502,
    code: 'BAD_GATEWAY',
    backendMessage: HERMES_402_TEXT,
    details: undefined,
    body,
    message: `Backend POST /api/conversation/send failed (502): ${JSON.stringify(body)}`,
  };
};

describe('detectQuotaExhausted on the send-failure lane shape', () => {
  it('recognizes the backend BAD_GATEWAY wrapper around the flat Hermes 402 text', () => {
    const detected = detectQuotaExhausted(backendBadGatewayError());
    expect(detected).not.toBeNull();
    expect(detected?.error).toBe('quota_exhausted');
  });

  it('recognizes the bare flat text too (message-only sniff)', () => {
    expect(detectQuotaExhausted({ message: HERMES_402_TEXT })).not.toBeNull();
  });

  it('stays null for an unrelated 502 so ordinary failures keep the cold card', () => {
    expect(
      detectQuotaExhausted({
        name: 'BackendHttpError',
        status: 502,
        code: 'BAD_GATEWAY',
        message: 'Backend POST /api/conversation/send failed (502): upstream unreachable',
      })
    ).toBeNull();
  });
});

describe('stripEmbeddedJsonFromSendFailureText', () => {
  it('cuts the embedded python-repr body and keeps the readable head', () => {
    const stripped = stripEmbeddedJsonFromSendFailureText(HERMES_402_TEXT);
    expect(stripped).toBe('Error: HTTP 402: Error code: 402');
    expect(stripped).not.toContain('{');
    expect(stripped).not.toContain('quota_exhausted');
  });

  it('drops the orphaned tail that survives an upstream head-truncation', () => {
    expect(stripEmbeddedJsonFromSendFailureText('0.1}]}')).toBe('');
    expect(stripEmbeddedJsonFromSendFailureText('Error: 0.1}]}')).toBe('Error');
  });

  it('keeps the [ACP-AUTH-…] markers the auth branch matches on', () => {
    const text = 'gemini authentication failed [ACP-AUTH-EXPIRED] please sign in again';
    expect(stripEmbeddedJsonFromSendFailureText(text)).toBe(text);
  });

  it('leaves a clean translated sentence untouched', () => {
    const text = 'Der Arbeitsbereich ist nicht verfügbar.';
    expect(stripEmbeddedJsonFromSendFailureText(text)).toBe(text);
  });
});

/** Line comments stripped, so prose quoting a pattern cannot satisfy the guard. */
const readWithoutLineComments = (path: string): string =>
  readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

describe('send-catch quota gate — source contract', () => {
  it('AcpSendBox asks the wall with an in-flight send before any cold rendering', () => {
    const source = readWithoutLineComments(ACP_SEND_BOX);
    const gate = source.indexOf('quotaWall?.reportInferenceError?.(error, { jobInFlight: true })');
    expect(gate, 'the send-catch no longer feeds the quota wall').toBeGreaterThan(-1);
    // The cold card in the catch is reachable only on a negative signal.
    expect(source).toMatch(/else if \(!quotaSignal\) \{/);
    // The auth branch is likewise out of the quota path.
    expect(source).toMatch(/!quotaSignal &&\s*\(errorMsg\.includes\('\[ACP-AUTH-'\)/);
    // The visible sentence passes the blob-strip at the shared binding.
    expect(source.indexOf('stripEmbeddedJsonFromSendFailureText(')).toBeGreaterThan(-1);
  });

  it('useAcpInitialMessage gates its cold card on the same wall feed', () => {
    const source = readWithoutLineComments(INITIAL_MESSAGE);
    const gate = source.indexOf("reportInferenceError?.(error, { jobInFlight: true })");
    expect(gate, 'the initial-message catch no longer feeds the quota wall').toBeGreaterThan(-1);
    const card = source.indexOf('const errorMessage: TMessage');
    expect(card).toBeGreaterThan(-1);
    expect(gate, 'the wall must be asked BEFORE the cold card is built').toBeLessThan(card);
    expect(source.indexOf('stripEmbeddedJsonFromSendFailureText(')).toBeGreaterThan(-1);
  });
});
