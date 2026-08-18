/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * RECOVERY FOR A RENDERER INVOCATION WHOSE MAIN-SIDE REPLY NEVER ARRIVES.
 *
 * THE STRUCTURAL GAP, STATED FIRST, BECAUSE IT IS NOT OURS TO FIX WHERE IT LIVES.
 * `@office-ai/platform`'s invoke primitive is, verbatim from the shipped bundle:
 *
 *     C = function (e, r) {
 *       var n = i(e);
 *       return new Promise(function (t) {              // <- resolve ONLY. no reject.
 *         _("subscribe-" + e, { id: n, data: r });
 *         var o = h("subscribe.callback-" + e + n, function (e) { t(e), o(); });
 *       });
 *     }
 *
 * The returned promise has NO rejection path. It settles if — and only if — a
 * matching `subscribe.callback-<providerKey><id>` event comes back. The adapter's
 * `emit` return value is discarded by the platform (`_` calls it and drops the
 * result), so when our Electron `emit` REJECTS — `ipcMain.handle` threw, e.g.
 * "Blocked unknown adapter bridge event." — that rejection is an unhandled promise
 * somewhere off to the side, and the caller's `await` waits forever.
 *
 * MEASURED, not theorised: Command EVE's own logs carry that exact main-side throw
 * (`Error occurred in handler for 'office-ai-bridge-adapter'`) on 2026-08-17 and
 * 2026-08-18. Every one of those lines is a renderer call that never settled — and
 * every `try/finally` around it never ran its `finally`. A UI that clears its
 * "busy" flag in `finally` therefore stays busy forever, with every control it
 * disabled while busy left disabled. That is a dead end produced by a lost message,
 * not by a failed login.
 *
 * SO WE CLOSE IT AT THE SEAM WE OWN. `common/adapter/browser.ts` knows both the
 * rejection and the envelope, which is everything needed to synthesise the reply
 * the platform is waiting for. This module is the pure half of that: it derives the
 * callback wire name and the failure payload, with no window, no Electron and no
 * bundler, so the derivation is provable in a plain unit test.
 *
 * WHAT THIS IS NOT. It does not retry, does not repair the main-side cause, and
 * does not invent a success. It converts an infinite wait into a typed failure that
 * the existing caller-side error handling already knows how to show. The main-side
 * throw remains a real defect and is still logged where it happens.
 */

/** Wire prefix the platform uses for a renderer→main provider invocation. */
export const PROVIDER_INVOCATION_WIRE_PREFIX = 'subscribe-';

/** Wire prefix the platform listens on for the main→renderer reply. */
export const PROVIDER_CALLBACK_WIRE_PREFIX = 'subscribe.callback-';

/**
 * The shape a synthesised reply carries. It matches `IBridgeResponse` (`success` /
 * `msg` / optional `data`), which is what every Command EVE provider returns, so a
 * caller that reads `response.data?.…` sees `undefined` and takes its existing
 * "no usable result" branch rather than a surprise.
 */
export type BridgeInvocationFailureResponse = Readonly<{
  success: false;
  msg: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Derive the exact callback wire name the pending invocation is listening on, or
 * `null` when this emit is not a provider invocation we can settle.
 *
 * The platform listens on `subscribe.callback-<providerKey><invocationId>`, where
 * `<invocationId>` ALREADY begins with the provider key (`i(e)` returns
 * `providerKey + 8 hex chars`). Reproducing that concatenation is the whole job —
 * getting it wrong means emitting into the void, which is indistinguishable from
 * the bug we are fixing, so it is asserted directly in the tests.
 *
 * Returns `null` for emitter traffic (`subscribe.callback-…`, plain events) and for
 * malformed envelopes: settling something we did not positively identify would be
 * worse than the hang.
 */
export function resolveProviderCallbackWireName(wireName: unknown, envelope: unknown): string | null {
  if (typeof wireName !== 'string' || !wireName.startsWith(PROVIDER_INVOCATION_WIRE_PREFIX)) return null;
  // `subscribe.callback-…` also starts with `subscribe`, but not with `subscribe-`.
  // Guard anyway so a future rename cannot make us answer our own replies.
  if (wireName.startsWith(PROVIDER_CALLBACK_WIRE_PREFIX)) return null;

  const providerKey = wireName.slice(PROVIDER_INVOCATION_WIRE_PREFIX.length);
  if (!providerKey) return null;

  if (!isRecord(envelope)) return null;
  const invocationId = envelope.id;
  // The id is minted as providerKey + nonce. If it does not carry its provider key
  // this is not an invocation envelope, and we must not guess a name.
  if (typeof invocationId !== 'string' || !invocationId.startsWith(providerKey)) return null;

  return `${PROVIDER_CALLBACK_WIRE_PREFIX}${providerKey}${invocationId}`;
}

/**
 * Build the failure payload handed to the stranded caller. The message is
 * diagnostic text for a developer reading a console, never user-facing copy — the
 * UI maps its own localized string from its own error branch.
 */
export function buildBridgeInvocationFailureResponse(error: unknown): BridgeInvocationFailureResponse {
  const detail = error instanceof Error && error.message ? error.message : 'bridge invocation was not delivered';
  return { success: false, msg: `BRIDGE_INVOCATION_FAILED: ${detail}` };
}
