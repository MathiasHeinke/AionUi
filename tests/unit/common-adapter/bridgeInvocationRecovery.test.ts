/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * @vitest-environment node
 */

/**
 * THE LOST-REPLY DEAD END — the defect this file pins.
 *
 * MEASURED SYMPTOM (Command EVE 1.823.2, first run): the browser PKCE callback
 * arrives, the browser tab renders "Anmeldung bestätigt" — a page that is only
 * reachable AFTER a byte-equal state check and a present code — and the app then
 * sits on "Sichere Anmeldung wird geöffnet…" with all three sign-in buttons
 * disabled, forever.
 *
 * THE CAUSE IS NOT IN THE LOGIN. It is one layer below, in the bridge. The
 * platform's invoke primitive (verbatim from the shipped bundle) is:
 *
 *     C = function (e, r) { var n = i(e); return new Promise(function (t) { … }) }
 *
 * — a promise with a resolve and NO REJECT. It settles only when a matching
 * `subscribe.callback-<providerKey><id>` event comes back. Meanwhile the Electron
 * adapter's `emit` CAN reject: `ipcMain.handle` throws on a blocked/unknown
 * provider, and Command EVE's own logs carry exactly that
 * ("Error occurred in handler for 'office-ai-bridge-adapter'", 2026-08-17 and
 * 2026-08-18). The platform discards the adapter's return value, so that
 * rejection went nowhere and the caller's `await` never returned — which means
 * its `finally` never ran, and a UI clearing its "busy" flag there stayed busy
 * with every control disabled.
 *
 * WHAT IS ASSERTED HERE is the pure derivation the fix depends on: the exact
 * callback wire name a pending invocation listens on, and the typed failure that
 * takes the place of the missing reply. Getting the name wrong would emit into
 * the void — indistinguishable from the bug — so it is asserted against the
 * platform's own construction rule (`id` = providerKey + nonce) rather than
 * against a hand-copied literal.
 *
 * SHARPNESS: `resolveProviderCallbackWireName` returning `null` for a real
 * invocation, or a name that does not match what the platform listens on, leaves
 * the caller stranded exactly as before. Both are red below.
 */

import { describe, expect, it } from 'vitest';
import {
  buildBridgeInvocationFailureResponse,
  PROVIDER_CALLBACK_WIRE_PREFIX,
  PROVIDER_INVOCATION_WIRE_PREFIX,
  resolveProviderCallbackWireName,
} from '@/common/adapter/bridgeInvocationRecovery';

/**
 * The platform's own id construction, reproduced from the shipped bundle:
 *   i = function (e) { return (e ?? '') + Math.random().toString(16).slice(2, 10) }
 * The id therefore ALWAYS carries its provider key as a prefix — that is what
 * makes the callback name derivable at all.
 */
function platformInvocationId(providerKey: string): string {
  return `${providerKey}${Math.random().toString(16).slice(2, 10)}`;
}

/** What the platform subscribes to while waiting: `subscribe.callback-` + key + id. */
function platformCallbackWireName(providerKey: string, invocationId: string): string {
  return `${PROVIDER_CALLBACK_WIRE_PREFIX}${providerKey}${invocationId}`;
}

describe('bridge invocation recovery — the reply a stranded caller is waiting for', () => {
  it('derives the EXACT wire name the platform listens on for a pending invocation', () => {
    const providerKey = 'command-eve.auth-web-login';
    const invocationId = platformInvocationId(providerKey);

    const resolved = resolveProviderCallbackWireName(`${PROVIDER_INVOCATION_WIRE_PREFIX}${providerKey}`, {
      id: invocationId,
      data: { intent: 'login' },
    });

    // Byte-equal to what the platform subscribed to. Anything else is a message
    // sent into the void, i.e. the dead end this fix exists to remove.
    expect(resolved).toBe(platformCallbackWireName(providerKey, invocationId));
  });

  it('works for any provider key, not just the auth one that surfaced the defect', () => {
    for (const providerKey of ['command-eve.entitlement-status', 'restart-app', 'command-eve.auth-resume']) {
      const invocationId = platformInvocationId(providerKey);
      expect(
        resolveProviderCallbackWireName(`${PROVIDER_INVOCATION_WIRE_PREFIX}${providerKey}`, { id: invocationId })
      ).toBe(platformCallbackWireName(providerKey, invocationId));
    }
  });

  it('refuses to answer anything it did not positively identify as an invocation', () => {
    const providerKey = 'command-eve.auth-web-login';
    const invocationId = platformInvocationId(providerKey);

    // Emitter traffic (main → renderer events) has no waiting promise.
    expect(resolveProviderCallbackWireName('command-eve.browser-context-changed', { id: invocationId })).toBeNull();
    // Our own reply channel must never be answered by us.
    expect(
      resolveProviderCallbackWireName(platformCallbackWireName(providerKey, invocationId), { id: invocationId })
    ).toBeNull();
    // Malformed / foreign envelopes: guessing a name would be worse than the hang.
    expect(resolveProviderCallbackWireName(`${PROVIDER_INVOCATION_WIRE_PREFIX}${providerKey}`, {})).toBeNull();
    expect(
      resolveProviderCallbackWireName(`${PROVIDER_INVOCATION_WIRE_PREFIX}${providerKey}`, { id: 'other-provider-1a2b' })
    ).toBeNull();
    expect(resolveProviderCallbackWireName(`${PROVIDER_INVOCATION_WIRE_PREFIX}${providerKey}`, null)).toBeNull();
    expect(resolveProviderCallbackWireName(PROVIDER_INVOCATION_WIRE_PREFIX, { id: invocationId })).toBeNull();
  });

  it('synthesises a FAILURE that the caller reads as "no usable result", never as success', () => {
    const response = buildBridgeInvocationFailureResponse(new Error('Blocked unknown adapter bridge event.'));

    // Same shape as IBridgeResponse, so `response.data?.…` is undefined and every
    // existing caller takes its established error branch instead of a surprise.
    expect(response.success).toBe(false);
    expect(response).not.toHaveProperty('data');
    // The original cause survives for whoever reads the console.
    expect(response.msg).toContain('Blocked unknown adapter bridge event.');
    expect(response.msg).toContain('BRIDGE_INVOCATION_FAILED');

    // A non-Error rejection must still produce a usable, non-empty failure.
    const fallback = buildBridgeInvocationFailureResponse('boom');
    expect(fallback.success).toBe(false);
    expect(fallback.msg.length).toBeGreaterThan(0);
  });
});
