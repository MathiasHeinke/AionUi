/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The single definition of the Command EVE provider-call identity contract.
 *
 * Hermes mints these tokens, Main's local shim reads them back off the wire, and
 * the TTFT formal gate adjudicates them. If any of those three accepted a
 * different character set, a real inference turn could produce a token one side
 * treats as valid evidence and another silently discards, which reads as a
 * missing provider call rather than as the contract violation it is. Keeping one
 * definition here makes that divergence impossible inside this repository
 * instead of merely unlikely.
 *
 * The grammar is printable, non-space ASCII: such a token survives an HTTP
 * header round-trip byte-for-byte and cannot smuggle prompt content, whitespace
 * padding, or control bytes into a receipt that claims to be content-free.
 */
const CONTENT_FREE_CALL_IDENTITY = /^[\x21-\x7e]{1,256}$/;

/** True only for a token every Command EVE provider-call boundary will accept. */
export function isContentFreeCallIdentity(value: unknown): value is string {
  return typeof value === 'string' && CONTENT_FREE_CALL_IDENTITY.test(value);
}

/**
 * The one place the request identity is composed. Callers that instead rebuilt
 * the string inline would each become an independent chance to drift from the
 * shape the formal gate verifies.
 */
export function commandEveProviderCallRequestId(turnId: string, callIndex: number): string {
  return `${turnId}:api:${callIndex}`;
}
