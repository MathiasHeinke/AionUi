/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE SEAT CONTEXT core (Phase 4 / ISO-1 / SEAT-TOOL-1, STEP 1 — the
 * PURE path-isolation core).
 *
 * THE KEYSTONE + ITS RISK. Today there is ONE global HERMES_HOME per install:
 * `resolveCommandEveRuntimeBootstrapPaths(userDataPath)`
 * (runtimeBootstrapCore.ts:1056) derives
 *   hermesRoot = <userData>/command-eve-runtime/hermes
 *   hermesHome = <hermesRoot>/home
 * with NO seat dimension; the shim/wrapper hardcode a single
 * `export HERMES_HOME=<that one home>` (:1798, :2025). Seat A's agent could read
 * seat B's MEMORY.md / USER.md / state.db / connectors — the WORST failure
 * (DSGVO + the reseller trust thesis; SOUL.md: "a leak here is the worst failure
 * you can commit").
 *
 * This module is the PURE, INJECTABLE seam the riskier rewire step will consume.
 * It has NO Electron dependency and performs NO fs side-effects in the resolver
 * itself, so it unit-tests in plain node/vitest. It does NOT yet rewire the ~20
 * call-sites — that is the next, gated step.
 *
 * DOCTRINE FOR THIS STEP:
 *   1. The NO-seat / default-seat path is BYTE-IDENTICAL to today's shipped
 *      1.1.3 single-seat path (zero behavior change for existing users).
 *   2. A seatId MUST be sanitized (uuid / safe-slug only) so a crafted id can
 *      NEVER traverse out of the `seats/` subtree — path traversal is a security
 *      bug, not just a bug.
 *   3. The active-seat holder DEFAULTS to the legacy seat so nothing changes
 *      until a seat is explicitly selected.
 */

import os from 'os';
import path from 'path';

/**
 * The legacy single-seat id. Any of `undefined` / `null` / '' / 'default' /
 * 'seat-1' resolve to EXACTLY today's path (no `seats/<id>/` segment at all),
 * preserving byte-identical backward compatibility with the shipped 1.1.3
 * single-seat layout.
 */
export const LEGACY_SEAT_ID = 'seat-1';

/**
 * The set of ids that are treated as "the legacy single-seat" and therefore map
 * to the pre-seat path with NO `seats/<id>/` segment. Kept explicit (not a
 * heuristic) so the byte-identical guarantee is auditable.
 */
const LEGACY_SEAT_ALIASES: ReadonlySet<string> = new Set(['default', LEGACY_SEAT_ID]);

/**
 * The subdirectory under hermesRoot that holds per-seat homes. A sanitized
 * seatId can NEVER escape this subtree.
 */
export const SEATS_SUBDIR = 'seats';

/**
 * Strict allowlist for a real (non-legacy) seat id. Accepts ONLY:
 *  - a canonical UUID (8-4-4-4-12 hex, any case), OR
 *  - a conservative safe slug: lower/upper alnum plus `-` and `_`, 1..64 chars.
 *
 * This is an ALLOWLIST, not a denylist: anything containing '/', '\\', '..',
 * a NUL byte, a leading/trailing dot, whitespace, a drive letter, or any other
 * character is rejected by construction. There is no way for a `..` segment, an
 * absolute path, or a separator to pass — so a sanitized id can never traverse
 * out of `seats/`.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SAFE_SLUG_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Returns true when the given id denotes the legacy single-seat (so the path
 * must omit the `seats/<id>/` segment entirely). `undefined` / `null` / '' all
 * count as legacy.
 *
 * CASE-FOLDED (final-audit fix, 2026-07-05): the alias check compares the
 * LOWER-CASED trimmed id, because `sanitizeSeatId` folds case before it becomes a
 * path segment. Without folding here, a crafted `SEAT-1` / `DEFAULT` would read as
 * NON-legacy (raw, case-sensitive) yet sanitize to the legacy alias `seat-1` /
 * `default` — a split-brain where the SAME seat routes to `seats/seat-1/` via one
 * check and the founder's legacy `home/` via another. Folding makes legacy-ness
 * consistent with the sanitizer everywhere. Real client seats are uuids, so no
 * legitimate seat is affected; a reserved-alias case-variant simply IS the legacy
 * seat, consistently.
 */
export function isLegacySeatId(seatId?: string | null): boolean {
  if (seatId === undefined || seatId === null) return true;
  if (typeof seatId !== 'string') return true;
  const trimmed = seatId.trim();
  if (trimmed.length === 0) return true;
  return LEGACY_SEAT_ALIASES.has(trimmed.toLowerCase());
}

/**
 * Sanitize a candidate seat id.
 *
 * - Legacy ids (`undefined`/`null`/''/'default'/'seat-1') return
 *   `LEGACY_SEAT_ID` — the caller MUST route these to the no-`seats/` legacy
 *   path (use `isLegacySeatId` / `resolveSeatHome`, which do this).
 * - A real id is accepted ONLY if it matches the UUID or safe-slug allowlist
 *   AND contains no traversal/separator/NUL characters.
 * - Anything else returns `null` (rejected) — it must NEVER be turned into a
 *   path segment.
 *
 * Returning `null` (rather than throwing) lets call-sites choose to fail-closed
 * to the legacy seat or to surface an explicit error; `assertSeatId` is the
 * throwing variant for code paths that must hard-stop on a bad id.
 */
export function sanitizeSeatId(seatId?: string | null): string | null {
  if (isLegacySeatId(seatId)) return LEGACY_SEAT_ID;

  // Past this point seatId is a non-empty string (isLegacySeatId handled the
  // nullish/empty/non-string cases).
  const raw = seatId as string;

  // Defense-in-depth explicit rejects BEFORE the allowlist, so the security
  // intent is unmistakable even though the allowlist alone would reject them.
  if (raw.includes('\0')) return null; // NUL byte
  if (raw.includes('/') || raw.includes('\\')) return null; // any separator
  if (raw.includes('..')) return null; // traversal
  if (path.isAbsolute(raw)) return null; // absolute path
  if (raw !== raw.trim()) return null; // leading/trailing whitespace
  if (raw.startsWith('.')) return null; // dotfile / '.'/'..'

  // Canonicalize to lower-case BEFORE it can become a path segment. macOS
  // (APFS) and Windows (NTFS) are case-insensitive-preserving, so 'ABC' and
  // 'abc' would be two distinct seatId strings but ONE on-disk directory — a
  // silent cross-seat leak (seat A reading seat B). Folding to a single case
  // makes the resolver's notion of seat identity match the filesystem's. The
  // allowlist still validates the lower-cased form (both REs are case-tolerant,
  // so folding never turns a previously-valid id invalid).
  const candidate = raw.toLowerCase();
  if (UUID_RE.test(candidate)) return candidate;
  if (SAFE_SLUG_RE.test(candidate)) return candidate;
  return null;
}

/**
 * Throwing variant of `sanitizeSeatId`. Returns the legacy id for legacy inputs;
 * returns the sanitized id for a valid real id; THROWS for anything that would
 * escape the `seats/` subtree. Use this where a bad id must hard-stop.
 */
export function assertSeatId(seatId?: string | null): string {
  const sanitized = sanitizeSeatId(seatId);
  if (sanitized === null) {
    throw new Error(`Command EVE: rejected unsafe seatId (path-traversal guard): ${JSON.stringify(seatId)}`);
  }
  return sanitized;
}

/**
 * The hermes home path shape, mirroring the relevant slice of
 * `resolveCommandEveRuntimeBootstrapPaths`. Kept narrow on purpose: this STEP
 * only owns the home path; the next step threads it back into the full
 * RuntimeBootstrapPaths resolver.
 */
export type SeatHomePaths = {
  /** The sanitized seat id that produced these paths. */
  seatId: string;
  /** True when this is the legacy single-seat (no `seats/<id>/` segment). */
  legacy: boolean;
  /** <userData>/command-eve-runtime/hermes (shared across seats; venv lives here). */
  hermesRoot: string;
  /**
   * The per-seat home. Legacy: <hermesRoot>/home (byte-identical to 1.1.3).
   * Real seat: <hermesRoot>/seats/<sanitized-seatId>/home.
   */
  hermesHome: string;
};

/**
 * Resolve the per-seat hermes home for a given userDataPath + optional seatId.
 *
 * BYTE-IDENTICAL LEGACY COMPAT: when `seatId` is undefined/null/''/'default'/
 * 'seat-1', the returned `hermesHome` is EXACTLY
 *   resolve(userDataPath || ~/.command-eve)/command-eve-runtime/hermes/home
 * i.e. the same value today's `resolveCommandEveRuntimeBootstrapPaths(...).hermesHome`
 * produces — no `seats/` segment is introduced.
 *
 * For a real seatId the home becomes
 *   <hermesRoot>/seats/<sanitized-seatId>/home
 * and a non-sanitizable id THROWS (path-traversal guard) — it can never be
 * turned into a path segment.
 *
 * PURE: no fs access, no Electron. The userData root is resolved with the SAME
 * `path.resolve(userDataPath || join(os-home, '.command-eve'))` precedence as the
 * live resolver, but the os-home default is injectable (`homeDir`) so the
 * function is fully deterministic under test.
 */
export function resolveSeatHome(userDataPath: string, seatId?: string | null, homeDir?: string): SeatHomePaths {
  // Default the os-home to os.homedir() so the NO-inject branch is byte-identical
  // to the live resolver (`path.join(os.homedir(), '.command-eve')`,
  // runtimeBootstrapCore.ts:1057). `homeDir` stays overridable for deterministic
  // unit tests. A literal '~' is NEVER tilde-expanded by path.join, so it must
  // not be the default — that produced a bogus `<cwd>/~/.command-eve` path.
  const resolvedHomeDir = homeDir ?? os.homedir();
  const root = path.resolve(userDataPath || path.join(resolvedHomeDir, '.command-eve'));
  const runtimeRoot = path.join(root, 'command-eve-runtime');
  const hermesRoot = path.join(runtimeRoot, 'hermes');

  if (isLegacySeatId(seatId)) {
    return {
      seatId: LEGACY_SEAT_ID,
      legacy: true,
      hermesRoot,
      // EXACTLY today's shape: <hermesRoot>/home — NO `seats/` segment.
      hermesHome: path.join(hermesRoot, 'home'),
    };
  }

  const sanitized = assertSeatId(seatId);
  return {
    seatId: sanitized,
    legacy: false,
    hermesRoot,
    hermesHome: path.join(hermesRoot, SEATS_SUBDIR, sanitized, 'home'),
  };
}

/**
 * Convenience: just the hermesHome string for a seat (the value the shim/wrapper
 * HERMES_HOME export and the bootstrap resolver will consume in the next step).
 */
export function resolveSeatHermesHome(userDataPath: string, seatId?: string | null, homeDir?: string): string {
  return resolveSeatHome(userDataPath, seatId, homeDir).hermesHome;
}

/**
 * ISO-4 — the storage-root resolver for the getDataPath()/getConfigPath()-derived
 * workspace tree (chat history, the agent workDir / produced deliverables,
 * assistants, user/cron skills, chat/config caches). ISO-1 seat-scoped the
 * HERMES_HOME family; this seat-scopes the *workspace* roots that root at
 * `cacheDir` (=getConfigPath()-derived) and `workDir` (=getDataPath()-derived) —
 * the SUSPECTED REAL REMAINING LEAK (raw client conversation content + produced
 * client deliverables).
 *
 * BYTE-IDENTICAL LEGACY COMPAT: for a legacy/no-seat id (undefined/null/''/
 * 'default'/'seat-1') the returned roots are EXACTLY the inputs — no `seats/`
 * segment, no migration, existing single-seat chat history + produced files stay
 * in place. For a real seat the roots become `<root>/seats/<sanitized-id>` so two
 * seats (two end-clients of a reseller) get DISJOINT chat-history / workDir /
 * assistants / skills trees. A non-sanitizable id THROWS (path-traversal guard)
 * — it can never become a `seats/<id>` path segment.
 *
 * PURE: no fs access, no Electron. The caller passes the already-resolved config
 * and data roots (getConfigPath()/getDataPath(), or the user's stored override)
 * and the active seat; this only computes the seat sub-root. Operates on the
 * inputs verbatim (it does NOT re-derive the userData root) so a user-chosen
 * override directory is seat-scoped just like the default.
 */
export type SeatScopedStorageRoots = {
  /** The sanitized seat id that produced these roots. */
  seatId: string;
  /** True when this is the legacy single-seat (roots returned verbatim). */
  legacy: boolean;
  /**
   * The seat-scoped cache root (chat history / config cache / assistants /
   * skills / cron skills). Legacy: === `configRoot` (byte-identical). Real seat:
   * `<configRoot>/seats/<sanitized-id>`.
   */
  cacheRoot: string;
  /**
   * The seat-scoped work root (the agent's produced deliverables / per-
   * conversation workspace handed to the backend). Legacy: === `dataRoot`
   * (byte-identical). Real seat: `<dataRoot>/seats/<sanitized-id>`.
   */
  workRoot: string;
};

export function resolveSeatScopedStorageRoots(
  configRoot: string,
  dataRoot: string,
  seatId?: string | null
): SeatScopedStorageRoots {
  if (isLegacySeatId(seatId)) {
    return {
      seatId: LEGACY_SEAT_ID,
      legacy: true,
      // Verbatim — EXACTLY today's roots, no `seats/` segment.
      cacheRoot: configRoot,
      workRoot: dataRoot,
    };
  }

  // assertSeatId throws for any id that could traverse out of `seats/`.
  const sanitized = assertSeatId(seatId);
  return {
    seatId: sanitized,
    legacy: false,
    cacheRoot: path.join(configRoot, SEATS_SUBDIR, sanitized),
    workRoot: path.join(dataRoot, SEATS_SUBDIR, sanitized),
  };
}

/**
 * Convenience over `resolveSeatScopedStorageRoots` for the CURRENTLY-active seat
 * (the process-local holder ISO-1 introduced). This is the seam initStorage.ts
 * calls at request time so a seat switch re-homes the workspace roots without a
 * module reload.
 */
export function resolveActiveSeatScopedStorageRoots(configRoot: string, dataRoot: string): SeatScopedStorageRoots {
  return resolveSeatScopedStorageRoots(configRoot, dataRoot, activeSeatId);
}

/**
 * ISO-4 — INVERSE of `resolveSeatScopedStorageRoots`: strip a trailing
 * `seats/<seatId>` segment from a possibly-seat-scoped root so the INSTALL-GLOBAL
 * BASE root can be persisted (e.g. when the operator changes the workspace dir
 * while a non-legacy seat is active — `updateSystemInfo`). Persisting the
 * seat-scoped path verbatim would double-nest (`.../seats/<id>/seats/<id>`) on
 * the next boot's re-scope. Legacy / no trailing seat segment → returned
 * verbatim. Pure; no fs.
 */
export function stripSeatScopeFromRoot(root: string, seatId?: string | null): string {
  if (isLegacySeatId(seatId)) return root;
  const sanitized = sanitizeSeatId(seatId);
  if (sanitized === null) return root; // unsafe id never produced a scoped path
  const suffix = path.join(SEATS_SUBDIR, sanitized);
  // Match only an exact trailing `<sep>seats/<id>` segment.
  if (root.endsWith(path.sep + suffix) || root.endsWith('/' + suffix)) {
    return root.slice(0, root.length - (suffix.length + 1));
  }
  return root;
}

/** Convenience: strip the CURRENTLY-active seat's scope segment from a root. */
export function stripActiveSeatScopeFromRoot(root: string): string {
  return stripSeatScopeFromRoot(root, activeSeatId);
}

/**
 * Minimal active-seat state holder for the current process.
 *
 * DEFAULTS to the legacy seat so NOTHING changes until a seat is explicitly
 * selected — single-seat installs keep using the legacy path with zero behavior
 * change. `setActiveSeatId` sanitizes its input (throws on an unsafe id) so a
 * crafted id can never become "active" and then leak into a path.
 *
 * This is a process-local singleton holder; it is deliberately tiny and pure so
 * it can be reset between tests via `__resetActiveSeatForTests`.
 */
let activeSeatId: string = LEGACY_SEAT_ID;

/**
 * The SEAT CONTEXT REVISION (S81/R1a) — a monotonic, main-owned counter that
 * bumps on EVERY successful `setActiveSeatId` call (i.e. every seat switch,
 * including a defensive same-id re-assert). It lets main-side services reject
 * renderer mutations that were issued against a stale seat context
 * (`assertSeat` in ProjectWorkspaceLifecycleService): after a switch, the old
 * revision no longer matches and the mutation fails closed with
 * `seat.changed` instead of landing in the new seat. The renderer learns the
 * current revision only through the `ProjectWorkspaceListDTO.seat_context_revision`
 * snapshot; it can never mint one. Process-local, monotonic for the process
 * lifetime; reset only by the test/clean-reset helpers below.
 */
let activeSeatContextRevision = 0;

// Paid media/document operations must finish their already-billed local
// persistence under the Seed that started them. This is deliberately a tiny,
// process-local fence: the switch authority lives in this same Main process,
// so no second durable state machine is needed.
let paidArtifactOperationsInFlight = 0;
let paidArtifactSeatTransitionInFlight = false;
let paidArtifactSeatRecoveryRequired = false;

export type CommandEvePaidArtifactBlockReason = 'seat_transition_in_progress' | 'seat_recovery_required' | null;

/** Explain why a paid artifact may not start without weakening the existing fence. */
export function getCommandEvePaidArtifactBlockReason(): CommandEvePaidArtifactBlockReason {
  if (paidArtifactSeatRecoveryRequired) return 'seat_recovery_required';
  if (paidArtifactSeatTransitionInFlight) return 'seat_transition_in_progress';
  return null;
}

/** Switch-watchdog recovery marker. Paid consumers render this state honestly. */
export function setCommandEvePaidArtifactSeatRecoveryRequired(required: boolean): void {
  paidArtifactSeatRecoveryRequired = required;
}

/** Start one paid artifact only while no Seed transition owns this fence. */
export function tryBeginCommandEvePaidArtifactOperation(): (() => void) | null {
  if (paidArtifactSeatRecoveryRequired || paidArtifactSeatTransitionInFlight) return null;
  paidArtifactOperationsInFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    paidArtifactOperationsInFlight = Math.max(0, paidArtifactOperationsInFlight - 1);
  };
}

/** Atomically reserve a Seed transition against new paid artifact starts. */
export function tryBeginCommandEvePaidArtifactSeatTransition(): (() => void) | null {
  if (paidArtifactSeatRecoveryRequired || paidArtifactSeatTransitionInFlight || paidArtifactOperationsInFlight > 0)
    return null;
  paidArtifactSeatTransitionInFlight = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    paidArtifactSeatTransitionInFlight = false;
  };
}

/** Main-process switch guard for paid Video/Image/PDF persistence. */
export function hasCommandEvePaidArtifactOperationInFlight(): boolean {
  return paidArtifactOperationsInFlight > 0;
}

/** Get the current seat context revision (monotonic, bumped on every seat switch). */
export function getActiveSeatContextRevision(): number {
  return activeSeatContextRevision;
}

/**
 * The DISPLAY LABEL of the currently-active seat (Seat-Context-Bridge / B1).
 *
 * This is a PLAIN display name ('Founder' for the legacy/founder home, or the
 * client seat's `name` from the my-seats wire) — NEVER a secret, id or PII
 * beyond what already shows on a chip. It is process-local state, set at the
 * SAME two points the id is set (seat-switch + boot) and only READ in the env
 * bake path — so the env-bake path performs NO network / no seat-record lookup
 * (the label is captured at switch/boot from the wire's seat list the caller
 * already holds). It defaults to 'Founder' so a legacy single-seat install bakes
 * a truthful founder label with zero behavior change.
 */
export const DEFAULT_SEAT_LABEL = 'Founder';
let activeSeatLabel: string = DEFAULT_SEAT_LABEL;

/**
 * The KIND of the currently-active seat (v1.5 K2/K3 / profile.kind). kind
 * conditions ONLY prompt/display texts — NEVER paths, RLS, billing or switch
 * authorization (§5 GATE-NULL: kind is prompt-only). Fail-conservative: the
 * default is 'client' (the strictest doctrine — full client isolation +
 * invisible-delivery), so a legacy/founder home, an absent wire field, or any
 * unknown value all behave exactly as today. It is process-local state set at the
 * SAME set-points as the label (seat-switch + boot) from the wire seat record the
 * caller already holds — no network in the read path.
 */
export type SeatKind = 'client' | 'own_company' | 'department';
export const DEFAULT_SEAT_KIND: SeatKind = 'client';

/**
 * The kind of the founder/legacy home itself.
 *
 * NOT a new fact — the product already states it wherever it describes the
 * founder chip (`seatSwitchCore.ts:566` and `resolveDegradedAdminAccess` :615,
 * `kind: legacy ? 'own_company' : 'client'`). It is named here because the boot
 * restore needs it too, and a third inline literal is how three places start
 * disagreeing. `activeSeatPointerStoreCore.test.ts` pins that the chip sites and
 * this constant still say the same thing.
 *
 * It is deliberately NOT the same as {@link DEFAULT_SEAT_KIND}: the default is
 * what an UNKNOWN seat gets, this is what a KNOWN one is.
 */
export const LEGACY_SEAT_KIND: SeatKind = 'own_company';
let activeSeatKind: SeatKind = DEFAULT_SEAT_KIND;

/** Get the currently-active seat id (defaults to the legacy seat). */
export function getActiveSeatId(): string {
  return activeSeatId;
}

/**
 * Get the currently-active seat's DISPLAY LABEL (defaults to 'Founder' for the
 * legacy home). Set by `setActiveSeatLabel` at the seat-switch + boot set-points;
 * only ever read (never fetched) in the env-bake path.
 */
export function getActiveSeatLabel(): string {
  return activeSeatLabel;
}

/**
 * Set the active seat's DISPLAY LABEL for this process. A blank/whitespace/
 * non-string label resets to the 'Founder' default (fail-truthful — the bake
 * never emits an empty label). The label is a display name only; it is the
 * caller's responsibility to pass a name, never a secret. Returns the resulting
 * label. Kept separate from `setActiveSeatId` so a switch can set the id first
 * (with its sanitize/throw guard) and the label second, from the SAME wire seat
 * record — no second store, no network in the bake path.
 */
export function setActiveSeatLabel(label?: string | null): string {
  const trimmed = typeof label === 'string' ? label.trim() : '';
  activeSeatLabel = trimmed.length > 0 ? trimmed : DEFAULT_SEAT_LABEL;
  return activeSeatLabel;
}

/**
 * Get the currently-active seat's KIND (defaults to 'client'). Set by
 * `setActiveSeatKind` at the seat-switch + boot set-points; only ever read (never
 * fetched) in the prompt/stamp/hint render paths. kind is PROMPT-ONLY (§5).
 */
export function getActiveSeatKind(): SeatKind {
  return activeSeatKind;
}

/**
 * Set the active seat's KIND for this process. DEFAULT-DENY: only the two literals
 * 'own_company' / 'department' are accepted; anything else (absent, null, a
 * typo, a hostile value, or the legacy default) folds to 'client' — the strictest
 * doctrine. Kept separate from `setActiveSeatId`/`setActiveSeatLabel` so a switch
 * sets id → label → kind from the SAME wire seat record. Returns the resulting kind.
 */
export function setActiveSeatKind(kind?: string | null): SeatKind {
  activeSeatKind = kind === 'own_company' || kind === 'department' ? kind : DEFAULT_SEAT_KIND;
  return activeSeatKind;
}

/** True when the active seat is the legacy single-seat (the default). */
export function isActiveSeatLegacy(): boolean {
  return isLegacySeatId(activeSeatId);
}

/**
 * Set the active seat id for this process. The id is sanitized first; an unsafe
 * id THROWS and the active seat is left unchanged (fail-closed). Passing a
 * legacy id (undefined/null/''/'default'/'seat-1') resets to the legacy seat.
 * Returns the resulting active seat id.
 */
export function setActiveSeatId(seatId?: string | null): string {
  const sanitized = assertSeatId(seatId);
  activeSeatId = sanitized;
  activeSeatContextRevision += 1;
  return activeSeatId;
}

/**
 * The board the bundled Hermes wheel + the native kanban bridges write when no
 * explicit per-seat slug is pinned. The wheel's `HERMES_KANBAN_BOARD` env defaults
 * to 'default', and kanbanDbPath maps 'default' → `HERMES_HOME/kanban.db` — the
 * physical per-seat board EVE's native tools author. The `/kanban` page and the
 * seat-context prompt both report THIS slug so the operator's board and EVE's
 * board are the same DB file (H2 board-slug unify). Per-seat isolation stays
 * physical (HERMES_HOME is per-seat) — the slug is the same, the file is not.
 */
export const COMMAND_EVE_DEFAULT_BOARD_SLUG = 'default';

/**
 * Get the KANBAN BOARD SLUG for the currently-active seat (Seat-Context-Bridge /
 * B1). The bundled Hermes wheel natively consumes `HERMES_KANBAN_BOARD` to pin a
 * worker onto a board. Per-seat board PINS are NOT created yet (a later slice, spec
 * §S7), so this returns '' for now — meaning "no explicit pin ⇒ the wheel uses its
 * own 'default' board". The env-bake path only sets the env var when this is
 * non-empty (H5), so the wheel falls back to 'default' cleanly. Kept as a resolver
 * (not a constant) so the later slice fills it from the active seat's record with
 * no bake-path change. For DISPLAY / read use `COMMAND_EVE_DEFAULT_BOARD_SLUG` as
 * the fallback (that is the board EVE actually writes when this is empty).
 */
export function getActiveSeatBoardSlug(): string {
  return '';
}

/** Reset the active seat back to the legacy default (for clean-reset / tests). */
export function clearActiveSeat(): void {
  activeSeatId = LEGACY_SEAT_ID;
  activeSeatContextRevision = 0;
  activeSeatLabel = DEFAULT_SEAT_LABEL;
  activeSeatKind = DEFAULT_SEAT_KIND;
}

/**
 * Resolve the hermes home for the CURRENTLY-active seat. Thin convenience over
 * `resolveSeatHome` using the process-local active seat.
 */
export function resolveActiveSeatHome(userDataPath: string, homeDir?: string): SeatHomePaths {
  return resolveSeatHome(userDataPath, activeSeatId, homeDir);
}

/** Test-only: force-reset the active-seat holder (id + label + kind). */
export function __resetActiveSeatForTests(): void {
  activeSeatId = LEGACY_SEAT_ID;
  activeSeatContextRevision = 0;
  activeSeatLabel = DEFAULT_SEAT_LABEL;
  activeSeatKind = DEFAULT_SEAT_KIND;
  paidArtifactOperationsInFlight = 0;
  paidArtifactSeatTransitionInFlight = false;
  paidArtifactSeatRecoveryRequired = false;
}
