/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE ONLINE entitlement re-verify (§2a — account-first revocation check).
 *
 * WHY this exists: the offline gate (entitlementCore.getEntitlementStatus) trusts
 * a cryptographically-verified, time-valid signed wire. That is correct for the
 * OFFLINE story, but a license that was REFUNDED / a subscription that was
 * CANCELED / an account that was DELETED stays 'entitled' forever offline — the
 * signed code's own expiry is the only re-lock. This core adds a SERVER-side
 * revocation check: it POSTs the stored wire (Bearer) to the `entitlement-status`
 * Edge Function and, on a CONCLUSIVE 'revoked' / 'expired' / account-deleted,
 * lets the caller drop the local entitlement so the gate re-renders.
 *
 * ============================================================================
 * CRITICAL SAFETY — DEFAULT-INERT, NEVER LOCK OUT A VALID OFFLINE USER.
 * ============================================================================
 * This check MUST be non-destructive by default. It only ever returns the
 * `invalidate` action on a CONCLUSIVE 2xx server verdict of revoked/expired/
 * deleted. EVERY other path is NON-CONCLUSIVE and leaves the local entitlement
 * UNTOUCHED (today's exact offline behavior):
 *   - the function URL is not configured (feature OFF / pre-deploy)  -> inert;
 *   - the fetch errors / times out / DNS fails (offline user)        -> inert;
 *   - a non-2xx HTTP status                                          -> inert;
 *   - a 2xx body with decision 'unknown' or an unparseable body      -> inert.
 * A valid offline user whose machine can never reach the function keeps working
 * forever. The enable switch (config + env) defaults to AUTO, which is itself
 * inert until the function URL is configured AND the function returns a
 * conclusive verdict — so this is provably inert until the founder deploys it.
 *
 * The check persists a last-good `{ checked_at, decision }` heartbeat (0600, in
 * the same entitlement dir) ONLY on a conclusive 'valid' response, to power an
 * OFFLINE GRACE window: after a previously-confirmed-valid online check, a later
 * unreachable function is tolerated for GRACE_DAYS without any state change (the
 * heartbeat is informational — it never escalates to a lockout; it exists so a
 * future "you have been offline > N days, please reconnect" nudge has a basis,
 * and to document that we deliberately do NOT lock out within the window).
 *
 * Everything network/fs is injectable, so this is unit-testable in a plain Node
 * (vitest) environment with no Electron and no real network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMAND_EVE_SUPABASE_URL, resolveSupabaseAnonKey } from './desktopAuthLoopback';

export const COMMAND_EVE_ONLINE_CHECK_VERSION = 'command-eve-online-check/v0' as const;

/** Offline-grace window (days) after a confirmed-valid online check. */
export const GRACE_DAYS = 7;

/** The entitlement-status Edge Function path (mirrors my-license URL shape). */
export const ENTITLEMENT_STATUS_FUNCTION_URL = `${COMMAND_EVE_SUPABASE_URL}/functions/v1/entitlement-status`;

/** Default fetch timeout (ms). A hung function must never wedge the check. */
const DEFAULT_TIMEOUT_MS = 8000;

const ENTITLEMENT_STATE_DIR = 'entitlement';
const ONLINE_CHECK_FILE = 'online-check.json';

/**
 * Enable switch. AUTO (the default) means "run only when the function URL is
 * configured AND reachable" — itself inert pre-deploy. OFF hard-disables. ON
 * forces the attempt (still non-destructive unless the verdict is conclusive).
 */
export type OnlineCheckMode = 'auto' | 'off' | 'on';
const ONLINE_CHECK_MODE_ENV = 'COMMAND_EVE_ONLINE_REVERIFY';
/** Optional explicit URL override; absence ⇒ the default function URL. */
const ONLINE_CHECK_URL_ENV = 'COMMAND_EVE_ENTITLEMENT_STATUS_URL';

export function resolveOnlineCheckMode(env: NodeJS.ProcessEnv = process.env): OnlineCheckMode {
  const raw = (env[ONLINE_CHECK_MODE_ENV] ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return 'off';
  if (raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes') return 'on';
  return 'auto';
}

/**
 * Resolve the configured function URL, or '' when not configured. AUTO defers to
 * the default function URL only when the function is the real deployed one; for
 * provable inertness pre-deploy, AUTO returns the URL but the network attempt is
 * still non-destructive (a missing function returns non-2xx ⇒ inert). An explicit
 * env URL always wins.
 */
export function resolveEntitlementStatusUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = (env[ONLINE_CHECK_URL_ENV] ?? '').trim();
  if (fromEnv) return fromEnv;
  return ENTITLEMENT_STATUS_FUNCTION_URL;
}

/** The server's conclusive verdict vocabulary (mirrors the Edge Function). */
export type ServerDecision = 'valid' | 'revoked' | 'expired' | 'unknown';

/** The on-disk heartbeat persisted after a confirmed-valid check. */
interface OnlineCheckHeartbeat {
  version: typeof COMMAND_EVE_ONLINE_CHECK_VERSION;
  checked_at: string;
  decision: ServerDecision;
}

/**
 * The action the CALLER must take. Only `invalidate` is destructive; everything
 * else preserves the offline state. `conclusive` records whether the server gave
 * a definitive verdict (true only for valid/revoked/expired/deleted).
 */
export type OnlineCheckAction = 'none' | 'invalidate';

export interface OnlineCheckResult {
  version: typeof COMMAND_EVE_ONLINE_CHECK_VERSION;
  /** What the caller should do. Default-inert: 'none' unless conclusively invalid. */
  action: OnlineCheckAction;
  /** True only for a conclusive server verdict (valid/revoked/expired/deleted). */
  conclusive: boolean;
  /** The server decision, when we got one. */
  decision?: ServerDecision;
  /**
   * Why the check was non-conclusive (for diagnostics; NEVER affects the gate):
   *  - 'mode-off'        — the enable switch is OFF;
   *  - 'no-wire'         — no wire to check;
   *  - 'url-unconfigured'— no function URL resolvable;
   *  - 'network-error'   — fetch threw / timed out (offline);
   *  - 'http-<status>'   — a non-2xx response;
   *  - 'bad-body'        — a 2xx response we could not parse;
   *  - 'unknown'         — a 2xx 'unknown' verdict;
   *  - 'within-grace'    — informational: still inside the offline-grace window.
   */
  reason_code?: string;
  /** Server-surfaced edition/expiry (informational; never trusted over the wire). */
  edition?: string;
  expires_at?: string | null;
  trial_ends_at?: string | null;
}

export interface CheckEntitlementOnlineArgs {
  /** The raw CEVE wire string (read from the keychain by the caller). */
  wire: string;
  /** Injectable fetch (defaults to global). */
  fetchImpl?: typeof fetch;
  /** Injectable clock. */
  now?: () => Date;
  /** Function URL override (defaults to the resolved env/default URL). */
  baseUrl?: string;
  /** Supabase anon key (defaults to the resolved one). */
  anonKey?: string;
  /** Enable mode (defaults to the env-resolved mode). */
  mode?: OnlineCheckMode;
  /** Fetch timeout (ms). */
  timeoutMs?: number;
  /** userDataPath for the heartbeat persistence (omit ⇒ no heartbeat I/O). */
  userDataPath?: string;
}

// ---------------------------------------------------------------------------
// Heartbeat persistence (last confirmed-valid check) — 0600, local only.
// ---------------------------------------------------------------------------

function entitlementStateDir(userDataPath: string): string {
  const root = path.resolve(userDataPath || path.join(os.homedir(), '.command-eve'));
  return path.join(root, 'command-eve-runtime', ENTITLEMENT_STATE_DIR);
}

function heartbeatPath(userDataPath: string): string {
  return path.join(entitlementStateDir(userDataPath), ONLINE_CHECK_FILE);
}

function writeHeartbeat(userDataPath: string, hb: OnlineCheckHeartbeat): void {
  try {
    const dir = entitlementStateDir(userDataPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = heartbeatPath(userDataPath);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(hb, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // Heartbeat persistence is best-effort; failure never affects the gate.
  }
}

export function readOnlineCheckHeartbeat(userDataPath: string): OnlineCheckHeartbeat | null {
  try {
    const file = heartbeatPath(userDataPath);
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as OnlineCheckHeartbeat;
    if (!raw || typeof raw.checked_at !== 'string') return null;
    return raw;
  } catch {
    return null;
  }
}

/** True iff the last confirmed-valid check is still within GRACE_DAYS of now. */
export function isWithinGrace(userDataPath: string, now: () => Date = () => new Date()): boolean {
  const hb = readOnlineCheckHeartbeat(userDataPath);
  if (!hb || hb.decision !== 'valid') return false;
  const checkedMs = Date.parse(hb.checked_at);
  if (Number.isNaN(checkedMs)) return false;
  const ageMs = now().getTime() - checkedMs;
  return ageMs >= 0 && ageMs < GRACE_DAYS * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

function nonConclusive(reasonCode: string, userDataPath?: string, now?: () => Date): OnlineCheckResult {
  const base: OnlineCheckResult = {
    version: COMMAND_EVE_ONLINE_CHECK_VERSION,
    action: 'none',
    conclusive: false,
    reason_code: reasonCode,
  };
  // Annotate (informational only) when we are within the offline-grace window.
  if (userDataPath && reasonCode !== 'mode-off' && isWithinGrace(userDataPath, now)) {
    return { ...base, reason_code: 'within-grace' };
  }
  return base;
}

/**
 * Run the online re-verify. DEFAULT-INERT (see module header): returns
 * `action:'none'` for every non-conclusive path; returns `action:'invalidate'`
 * ONLY for a conclusive 2xx 'revoked'/'expired'/account-deleted verdict. On a
 * conclusive 'valid' it refreshes the offline-grace heartbeat.
 */
export async function checkEntitlementOnline(args: CheckEntitlementOnlineArgs): Promise<OnlineCheckResult> {
  const now = args.now ?? (() => new Date());
  const mode = args.mode ?? resolveOnlineCheckMode();

  if (mode === 'off') {
    return nonConclusive('mode-off', args.userDataPath, now);
  }
  if (typeof args.wire !== 'string' || args.wire.trim().length === 0) {
    return nonConclusive('no-wire', args.userDataPath, now);
  }

  const baseUrl = (args.baseUrl ?? resolveEntitlementStatusUrl()).trim();
  if (!baseUrl) {
    return nonConclusive('url-unconfigured', args.userDataPath, now);
  }

  const fetchImpl = args.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const anonKey = args.anonKey ?? resolveSupabaseAnonKey();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Bounded fetch: a hung function must never wedge the check.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: anonKey,
        // The wire IS the credential (server verifies its Ed25519 signature).
        Authorization: `Bearer ${args.wire.trim()}`,
        Accept: 'application/json',
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
  } catch {
    // Network error / timeout / abort ⇒ offline ⇒ inert (NEVER lock out).
    return nonConclusive('network-error', args.userDataPath, now);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Any non-2xx (incl. a missing/unauthorized function pre-deploy) ⇒ inert.
    return nonConclusive(`http-${response.status}`, args.userDataPath, now);
  }

  const raw = (await response.json().catch((): null => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') {
    return nonConclusive('bad-body', args.userDataPath, now);
  }

  const decisionRaw = typeof raw.decision === 'string' ? raw.decision.toLowerCase() : '';
  const edition = typeof raw.edition === 'string' ? raw.edition : undefined;
  const expiresAt =
    raw.expires_at === null || typeof raw.expires_at === 'string' ? (raw.expires_at as string | null) : undefined;
  const trialEndsAt =
    raw.trial_ends_at === null || typeof raw.trial_ends_at === 'string'
      ? (raw.trial_ends_at as string | null)
      : undefined;

  if (decisionRaw === 'valid') {
    if (args.userDataPath) {
      writeHeartbeat(args.userDataPath, {
        version: COMMAND_EVE_ONLINE_CHECK_VERSION,
        checked_at: now().toISOString(),
        decision: 'valid',
      });
    }
    return {
      version: COMMAND_EVE_ONLINE_CHECK_VERSION,
      action: 'none',
      conclusive: true,
      decision: 'valid',
      ...(edition !== undefined ? { edition } : {}),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      ...(trialEndsAt !== undefined ? { trial_ends_at: trialEndsAt } : {}),
    };
  }

  // 'revoked' | 'expired' (and 'deleted'/'account_deleted' mapped to revoked) are
  // the ONLY destructive verdicts. A conclusive server NO drops the local
  // entitlement.
  if (decisionRaw === 'revoked' || decisionRaw === 'deleted' || decisionRaw === 'account_deleted') {
    return {
      version: COMMAND_EVE_ONLINE_CHECK_VERSION,
      action: 'invalidate',
      conclusive: true,
      decision: 'revoked',
    };
  }
  if (decisionRaw === 'expired') {
    return {
      version: COMMAND_EVE_ONLINE_CHECK_VERSION,
      action: 'invalidate',
      conclusive: true,
      decision: 'expired',
    };
  }

  // decision 'unknown' or any unrecognized value ⇒ NON-CONCLUSIVE ⇒ inert.
  return nonConclusive('unknown', args.userDataPath, now);
}

// ---------------------------------------------------------------------------
// Boot reconcile (fire-and-reconcile, OFF the critical path)
// ---------------------------------------------------------------------------

export const ENTITLEMENT_FILE = 'entitlement.json';

/**
 * Drop ONLY the local entitlement cache + the license-wire bearer (NOT the
 * registration). After this the gate reads `registered_unlicensed` — the user is
 * still registered but must re-license; this is the correct post-revoke state
 * (distinct from the hard device reset in §2b, which also wipes registration).
 * Idempotent; never throws. The wire-clear is injected (the real clearLicenseWire).
 */
export function dropLocalEntitlement(userDataPath: string, clearLicenseWire: (p: string) => void): void {
  try {
    const file = path.join(entitlementStateDir(userDataPath), ENTITLEMENT_FILE);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch {
    // ignore — best-effort.
  }
  try {
    clearLicenseWire(userDataPath);
  } catch {
    // ignore — best-effort.
  }
}

export interface ReconcileEntitlementOnlineDeps {
  /** Read the stored CEVE wire (inject the real readLicenseWire-backed reader). */
  readWire: (userDataPath: string) => string | null;
  /** Remove the license-wire record (inject the real clearLicenseWire). */
  clearLicenseWire: (userDataPath: string) => void;
  /** Injectable fetch / clock / config for the inner check. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  baseUrl?: string;
  anonKey?: string;
  mode?: OnlineCheckMode;
  timeoutMs?: number;
}

export interface ReconcileEntitlementOnlineResult {
  /** True iff the check was conclusive AND we dropped the local entitlement. */
  invalidated: boolean;
  /** The underlying check result (for diagnostics). */
  check: OnlineCheckResult;
}

/**
 * Boot/periodic reconcile: read the stored wire, run the online check, and on a
 * CONCLUSIVE invalidate verdict drop the local entitlement so the gate re-renders.
 *
 * SAFE BY CONSTRUCTION:
 *  - no wire stored ⇒ nothing to check ⇒ inert;
 *  - the inner check is DEFAULT-INERT (only a conclusive server NO invalidates);
 *  - this is meant to be called fire-and-reconcile (NOT awaited before the gate's
 *    first render) so a slow/failed check never delays or blocks the gate.
 * Never throws (callers ignore rejection).
 */
export async function reconcileEntitlementOnline(
  userDataPath: string,
  deps: ReconcileEntitlementOnlineDeps
): Promise<ReconcileEntitlementOnlineResult> {
  const wire = (() => {
    try {
      return deps.readWire(userDataPath);
    } catch {
      return null;
    }
  })();

  if (!wire) {
    return {
      invalidated: false,
      check: {
        version: COMMAND_EVE_ONLINE_CHECK_VERSION,
        action: 'none',
        conclusive: false,
        reason_code: 'no-wire',
      },
    };
  }

  const check = await checkEntitlementOnline({
    wire,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    baseUrl: deps.baseUrl,
    anonKey: deps.anonKey,
    mode: deps.mode,
    timeoutMs: deps.timeoutMs,
    userDataPath,
  });

  if (check.action === 'invalidate' && check.conclusive) {
    dropLocalEntitlement(userDataPath, deps.clearLicenseWire);
    return { invalidated: true, check };
  }

  return { invalidated: false, check };
}
