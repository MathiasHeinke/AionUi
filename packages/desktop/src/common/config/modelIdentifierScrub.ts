/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scrub upstream model / provider identifiers out of USER-FACING text.
 *
 * WHY THIS EXISTS. The founder mandate is that the chat never renders a model
 * id. The picker and the composer honour that by construction — but ERROR TEXT
 * does not go through either. Three real paths render an upstream string
 * verbatim into the chat:
 *
 *   - the send-failure toast (pinned, `duration: 0`, so it stays on screen),
 *   - the runtime/queue failure toasts,
 *   - the shim's passthrough of a non-OK upstream body, including the 429
 *     handler which quotes the raw upstream message.
 *
 * Any of those can carry a provider slug straight from upstream. This module is
 * the one place that strips it.
 *
 * SHAPE-BASED, not a blacklist. Every upstream model id in this system is a
 * `vendor/model` slug, so the SHAPE is the reliable tell — a blacklist would go
 * stale the day a model is swapped server-side, which is exactly the change this
 * ticket makes. Callers that hold a concrete id table (the renderer does) may
 * pass it as `extraIdentifiers` for defence in depth; nothing is hardcoded here.
 *
 * PURE (no DOM, no Node) so both processes can use it.
 */

/** What a scrubbed identifier is replaced with. Deliberately says nothing. */
export const SCRUBBED_MODEL_PLACEHOLDER = '…';

/**
 * A `vendor/model` provider slug.
 *
 * Anchored on a token boundary so ordinary prose with a slash ("and/or", a unit
 * like "requests/min", a path fragment) is not mangled: both sides must look
 * like an identifier — letters/digits with internal `.`/`_`/`-` — and at least
 * one side must contain a digit or a `-`/`.`, which is what distinguishes a
 * model slug from two plain English words.
 */
const PROVIDER_SLUG = /\b([a-z][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)\b/gi;

function looksLikeModelSlug(vendor: string, model: string): boolean {
  const identifierish = (value: string): boolean => /[0-9]/.test(value) || /[-.]/.test(value);
  return identifierish(vendor) || identifierish(model);
}

/** Escape a literal for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove model/provider identifiers from `text`.
 *
 * Returns the text unchanged when there is nothing to scrub, so a caller can
 * pass any string through unconditionally.
 */
export function scrubModelIdentifiers(text: string, extraIdentifiers: readonly string[] = []): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  let scrubbed = text.replace(PROVIDER_SLUG, (match, vendor: string, model: string) =>
    looksLikeModelSlug(vendor, model) ? SCRUBBED_MODEL_PLACEHOLDER : match
  );

  // Longest first, so a longer id is never left half-scrubbed by a shorter one
  // that happens to be its prefix.
  const ordered = [...extraIdentifiers].filter((id) => id.length > 2).sort((a, b) => b.length - a.length);
  for (const identifier of ordered) {
    scrubbed = scrubbed.replace(new RegExp(escapeRegExp(identifier), 'gi'), SCRUBBED_MODEL_PLACEHOLDER);
  }

  // Collapse the debris a scrub leaves behind ("(…)", " …  …") so the sentence
  // still reads like a sentence rather than obviously-redacted output.
  return scrubbed
    .replace(new RegExp(`(${SCRUBBED_MODEL_PLACEHOLDER}\\s*)+`, 'g'), `${SCRUBBED_MODEL_PLACEHOLDER}`)
    .replace(new RegExp(`[([{]\\s*${SCRUBBED_MODEL_PLACEHOLDER}\\s*[)\\]}]`, 'g'), '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Scrub an unknown thrown value into a user-facing sentence.
 * Non-Error values are stringified first, so nothing bypasses the scrub.
 */
export function scrubErrorText(error: unknown, extraIdentifiers: readonly string[] = []): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return scrubModelIdentifiers(raw, extraIdentifiers);
}
