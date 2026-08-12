/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import type { CommandEveManagedVisualAuthorizationFailureReason } from './managedVisualTurnAuthorizationCore';

/**
 * F-14 (Kimi 1.819 audit): the shim's top-level catch must never echo raw
 * error.message — a latent throw source could smuggle credentials into the
 * client response. But a small number of DELIBERATE fail-closed messages are
 * authored to be user-facing (e.g. "cloud route unavailable" when the picker
 * state cannot be read, where silently falling through to another lane would
 * be a routing-integrity bug).
 *
 * This class is the explicit allowlist: only errors constructed as
 * CommandEveShimPublicError may have their message surfaced to the client.
 * Every other throw gets the generic 500.
 */
export class CommandEveShimPublicError extends Error {}

export function isCommandEveShimPublicError(error: unknown): error is CommandEveShimPublicError {
  return error instanceof CommandEveShimPublicError;
}

/**
 * A managed-visual marker is a one-time, seat/session-bound authorization. Its
 * deterministic refusals are client mistakes or stale state, not transient
 * provider failures. Keep the response deliberately generic, but preserve a
 * stable typed code and a content-free request correlation for local diagnosis.
 */
export class CommandEveManagedVisualAuthorizationError extends CommandEveShimPublicError {
  // OpenAI SDK 2.24 retries 409 by default. 422 is a stable semantic refusal
  // outside that retry set, so the exact wheel receives it once and stops.
  readonly statusCode = 422 as const;
  readonly errorCode = 'EVE_MANAGED_VISUAL_AUTHORIZATION_INVALID' as const;
  readonly correlationId = crypto.randomUUID();

  constructor(readonly reasonCode: CommandEveManagedVisualAuthorizationFailureReason) {
    super('Managed visual authorization cannot be verified. Reattach the files and retry.');
    this.name = 'CommandEveManagedVisualAuthorizationError';
  }
}

export function isCommandEveManagedVisualAuthorizationError(
  error: unknown
): error is CommandEveManagedVisualAuthorizationError {
  return error instanceof CommandEveManagedVisualAuthorizationError;
}

/**
 * The exact sentence a HELD lane returns. Deliberately NON-PROVIDER: it names no
 * model, vendor or slug — only the lane the user picked and the reason it is not
 * running yet. (The chat-facing copy for the same state lives in i18n; this is
 * the wire-level message the shim is allowed to echo.)
 */
export const EVE_MAX_ENTITLEMENT_HOLD_MESSAGE =
  'Command EVE MAX is on hold: this seat entitlement could not be verified yet.';

/**
 * MAX intent on an UNVERIFIED seat. A distinct type rather than a bare message,
 * because two callers must tell it apart from every other failure:
 *
 *   - the shim answers it as a public, fail-closed refusal — no request is built,
 *     so no MAX spend can leave the machine;
 *   - the inference-lane-decision bridge turns it into a HOLD receipt, so the
 *     composer paints the neutral "entitlement is being checked" state and holds
 *     submission instead of showing a generic error.
 *
 * It extends CommandEveShimPublicError so the message stays on the allowlist.
 */
export class CommandEveMaxEntitlementHoldError extends CommandEveShimPublicError {
  readonly reasonCode = 'MAX_ENTITLEMENT_UNKNOWN' as const;

  constructor() {
    super(EVE_MAX_ENTITLEMENT_HOLD_MESSAGE);
    this.name = 'CommandEveMaxEntitlementHoldError';
  }
}

export function isCommandEveMaxEntitlementHoldError(error: unknown): error is CommandEveMaxEntitlementHoldError {
  return error instanceof CommandEveMaxEntitlementHoldError;
}
