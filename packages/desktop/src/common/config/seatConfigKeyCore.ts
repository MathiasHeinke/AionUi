/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE PER-SEAT CONFIG NAMESPACE core (Phase 4 / ISO-2).
 *
 * THE GAP THIS CLOSES. ISO-1 (commit 242bed7) seat-scoped the on-disk
 * hermesHome, but the renderer config layer (`configService`) still talks to ONE
 * flat global settings bag via GET/PUT /api/settings/client. So after a seat
 * switch, seat B reads seat A's `commandEve.clientSeeded` ("seeded ✓" for a
 * never-seeded client), plus other per-seat-meaningful flags. That is a
 * cross-seat CONFIG-STATE leak — the worst failure class for the reseller
 * +99€/seat SKU (DSGVO + trust).
 *
 * THE SEAM. This module is a PURE, RENDERER-IMPORTABLE key-namespacing core. It
 * lives under `common/` (NOT under `process/`) precisely so the renderer bundle
 * can import it WITHOUT pulling in any main-process module (seatContextCore lives
 * under `process/` and is main-only). It deliberately RE-IMPLEMENTS the
 * sanitize/validate allowlist that seatContextCore uses (it does not import it),
 * so the two trust roots are independent yet identical in policy: a crafted seat
 * id can NEVER become a key prefix on either side.
 *
 * DOCTRINE (mirrors ISO-1):
 *   1. A LEGACY / no-seat id (`undefined`/`null`/''/'default'/'seat-1') returns
 *      the key UNCHANGED — byte-identical to shipped 1.1.3, ZERO migration for
 *      existing per-install rows.
 *   2. A real seatId is sanitized with the SAME UUID|safe-slug allowlist the
 *      home resolver uses (lower-cased; traversal/separator/NUL/leading-dot
 *      rejected). A non-sanitizable id THROWS — it must never silently pass and
 *      become a key prefix.
 *   3. Only an EXPLICIT, auditable allowlist of seat-sensitive keys is scoped;
 *      install-global keys (theme.*, language, webui.desktop.*, css.*, …) stay
 *      un-namespaced and shared across seats by design.
 */

/**
 * The legacy single-seat id. Any of `undefined` / `null` / '' / 'default' /
 * 'seat-1' map to the UN-prefixed (1.1.3-identical) key. Kept byte-identical to
 * seatContextCore.LEGACY_SEAT_ID.
 */
export const LEGACY_SEAT_ID = 'seat-1';

/**
 * The explicit set of ids treated as "the legacy single-seat" (no `seat:<id>:`
 * prefix). Mirrors seatContextCore's LEGACY_SEAT_ALIASES. Auditable, not a
 * heuristic.
 */
const LEGACY_SEAT_ALIASES: ReadonlySet<string> = new Set(['default', LEGACY_SEAT_ID]);

/**
 * Strict allowlist for a real (non-legacy) seat id — a CARBON COPY of
 * seatContextCore's UUID_RE / SAFE_SLUG_RE so the namespacing policy can never
 * drift from the on-disk seat-home policy:
 *  - a canonical UUID (8-4-4-4-12 hex, any case), OR
 *  - a conservative safe slug: alnum plus `-`/`_`, 1..64 chars.
 *
 * ALLOWLIST, not denylist: '/', '\\', '..', NUL, leading/trailing dot,
 * whitespace, drive letters, and every other character are rejected by
 * construction.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SAFE_SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The EXPLICIT, auditable allowlist of config keys that carry PER-SEAT state and
 * must therefore be namespaced by the active seat. Everything NOT in this set is
 * install-global (shared chrome / license / window bounds / migrations) and
 * stays un-namespaced.
 *
 * Keep this list in sync with the per-seat-meaningful keys in configKeys.ts. The
 * split is the allowlist, never a heuristic on the key string.
 */
export const SEAT_SCOPED_CONFIG_KEYS: ReadonlySet<string> = new Set<string>([
  'commandEve.clientSeeded',
  'commandEve.clientSeedDismissed',
  'commandEve.teamWorkerStatus',
  'commandEve.executionMode',
  'commandEve.inferenceSelection',
  'commandEve.churnSignal',
  'commandEve.valueReceiptHourlyEur',
]);

/** True when this key must be routed through `seatScopedKey`. */
export function isSeatScopedConfigKey(key: string): boolean {
  return SEAT_SCOPED_CONFIG_KEYS.has(key);
}

/**
 * True when the given id denotes the legacy single-seat (so the key must NOT be
 * prefixed). `undefined` / `null` / '' / non-string all count as legacy.
 * Mirrors seatContextCore.isLegacySeatId.
 */
export function isLegacySeatId(seatId?: string | null): boolean {
  if (seatId === undefined || seatId === null) return true;
  if (typeof seatId !== 'string') return true;
  const trimmed = seatId.trim();
  if (trimmed.length === 0) return true;
  return LEGACY_SEAT_ALIASES.has(trimmed);
}

/**
 * Sanitize a candidate seat id for use as a CONFIG-KEY prefix.
 *
 * - Legacy ids return `LEGACY_SEAT_ID` (the caller routes these to the
 *   un-prefixed key).
 * - A real id is accepted ONLY if it matches the UUID or safe-slug allowlist AND
 *   contains no traversal/separator/NUL characters; it is lower-cased first.
 * - Anything else returns `null` (rejected) — it must NEVER become a key prefix.
 *
 * Returning `null` (not throwing) lets `assertSeatId` be the throwing variant.
 * Mirrors seatContextCore.sanitizeSeatId, MINUS the path.isAbsolute() check
 * (this module is renderer-importable and must not import node:path; a leading
 * '/' is already rejected by the separator guard and the allowlist).
 */
export function sanitizeSeatId(seatId?: string | null): string | null {
  if (isLegacySeatId(seatId)) return LEGACY_SEAT_ID;

  const raw = seatId as string;

  // Defense-in-depth explicit rejects BEFORE the allowlist (the allowlist alone
  // would already reject these — the explicit guards make the security intent
  // unmistakable).
  if (raw.includes('\0')) return null; // NUL byte
  if (raw.includes('/') || raw.includes('\\')) return null; // any separator (also rejects absolute '/…')
  if (raw.includes('..')) return null; // traversal
  if (raw !== raw.trim()) return null; // leading/trailing whitespace
  if (raw.startsWith('.')) return null; // dotfile / '.'/'..'

  // Canonicalize to lower-case BEFORE it can become a key prefix — the same
  // case-folding seatContextCore applies so 'ABC' and 'abc' resolve to ONE seat
  // identity (the on-disk home is case-insensitive on APFS/NTFS; the config key
  // namespace must agree). Both REs are case-tolerant, so folding never turns a
  // valid id invalid.
  const candidate = raw.toLowerCase();
  if (UUID_RE.test(candidate)) return candidate;
  if (SAFE_SLUG_RE.test(candidate)) return candidate;
  return null;
}

/**
 * Throwing variant of `sanitizeSeatId`. Returns the legacy id for legacy inputs;
 * returns the sanitized id for a valid real id; THROWS for anything that would
 * otherwise become an unsafe key prefix. Use this where a bad id must hard-stop.
 */
export function assertSeatId(seatId?: string | null): string {
  const sanitized = sanitizeSeatId(seatId);
  if (sanitized === null) {
    throw new Error(`Command EVE: rejected unsafe seatId (config-key prefix guard): ${JSON.stringify(seatId)}`);
  }
  return sanitized;
}

/** The per-seat key prefix shape: `seat:<sanitizedSeatId>:`. */
export const SEAT_KEY_PREFIX = 'seat:';

/**
 * Namespace a config key by seat.
 *
 * - LEGACY / no-seat (`undefined`/`null`/''/'default'/'seat-1'): returns `key`
 *   UNCHANGED (byte-identical to 1.1.3 — existing rows keep working, zero
 *   migration).
 * - A real seat: returns `seat:<sanitizedSeatId>:<key>`. A non-sanitizable id
 *   THROWS via `assertSeatId` (it can never become a key prefix).
 *
 * NOTE: this namespaces UNCONDITIONALLY for a real seat — callers decide WHICH
 * keys to route through it (the SEAT_SCOPED_CONFIG_KEYS allowlist). This keeps
 * the prefix logic pure and the install-global/seat-private split auditable at
 * the call site.
 */
export function seatScopedKey(key: string, seatId?: string | null): string {
  if (isLegacySeatId(seatId)) return key;
  const sanitized = assertSeatId(seatId);
  return `${SEAT_KEY_PREFIX}${sanitized}:${key}`;
}
