/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

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
