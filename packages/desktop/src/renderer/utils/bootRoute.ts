/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fresh-launch landing normalization (fix #3).
 *
 * The desktop renderer is a HashRouter. When the user quits while inside a chat
 * (`#/conversation/<id>`) the window's `location.hash` is preserved across the
 * relaunch/reload, so the app re-opens straight into that old conversation
 * instead of the EVE home / new-chat surface. Founder ask: a FRESH launch must
 * land on the main/home screen, not the last chat.
 *
 * `normalizeBootHash` runs ONCE at module load — before React Router reads the
 * initial location — and rewrites a stale per-conversation/per-team deep-link
 * hash to the home route (`#/guid`, the EVE welcome / new-chat surface). It does
 * NOT touch in-session navigation: notification/tray/user deep-links happen
 * later via React Router `navigate(...)`, long after this one-shot boot pass.
 *
 * It is intentionally conservative — it only redirects the *chat surfaces*
 * (`/conversation/...`, `/team/...`). Everything else (empty hash, `/`, `/guid`,
 * `/settings/...`, `/login`, and any other top-level route) is left untouched,
 * so deep-launches the app explicitly performs (e.g. opening About) still work,
 * and the entitlement gate — which renders for ALL protected routes including
 * `/guid` — is unaffected (an unentitled user still sees the gate first).
 */

/** The home / new-chat surface a fresh launch should land on. */
export const BOOT_HOME_HASH = '#/guid';

/** Route hash prefixes that represent a *specific chat* and must not survive a fresh boot. */
const STALE_CHAT_HASH_PREFIXES = ['#/conversation/', '#/team/'];

/**
 * Given the raw initial `location.hash`, return the hash the app should boot
 * into. Returns the home hash when the initial hash points at a specific chat;
 * otherwise returns the input unchanged.
 */
export function normalizeBootHash(rawHash: string | undefined | null): string {
  const hash = (rawHash ?? '').trim();
  if (!hash || hash === '#' || hash === '#/') return hash;
  const isStaleChat = STALE_CHAT_HASH_PREFIXES.some((prefix) => hash.startsWith(prefix));
  return isStaleChat ? BOOT_HOME_HASH : hash;
}

/**
 * One-shot boot side-effect: if the renderer started inside a stale chat hash,
 * rewrite it to the home surface BEFORE the router mounts. Safe to call on a
 * non-DOM host (no-op) and idempotent (a home/other hash is left as-is).
 */
export function applyBootRouteNormalization(): void {
  if (typeof window === 'undefined' || !window.location) return;
  const current = window.location.hash;
  const next = normalizeBootHash(current);
  if (next !== current) {
    window.location.hash = next;
  }
}
