/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE CLEAN-RESET core (§2b — "Abmelden & Gerät zurücksetzen").
 *
 * WHY this exists: the soft logout (`auth-logout`) deliberately KEEPS the local
 * entitlement + license wire so the app stays offline-usable after signing out
 * (founder decision). That leaves NO way to return the device to the
 * registration gate — a refunded/handed-down/wrong-account device stays
 * `entitled` forever. This core is the HARD reset: it removes the three local
 * trust artifacts so `getEntitlementStatus` falls back to `unregistered`, then
 * the renderer re-reads the gate and the RegistrationGate renders.
 *
 * It deletes (idempotently, never throwing):
 *   1. entitlement.json   — the (non-authoritative) entitlement cache;
 *   2. registration.json  — the local PII registration record;
 *   3. license-wire.json  — the EVE Inference bearer at rest (via clearLicenseWire);
 * and clears the account SESSION (the GoTrue tokens) by reusing the SAME
 * `revokeAndClearSession` the soft logout uses (best-effort GoTrue sign-out +
 * local session.enc delete).
 *
 * Everything fs/keychain/network is injectable (the session-clear and the
 * wire-clear are passed in by the bridge), so this is unit-testable in a plain
 * Node (vitest) environment with no Electron and no real network. The bridge
 * wires the real `clearLicenseWire` + `revokeAndClearSession`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Mirror of entitlementCore's runtime dir family + record filenames. */
const ENTITLEMENT_STATE_DIR = 'entitlement';
const REGISTRATION_FILE = 'registration.json';
const ENTITLEMENT_FILE = 'entitlement.json';

export const COMMAND_EVE_ENTITLEMENT_RESET_VERSION = 'command-eve-entitlement-reset/v0' as const;

function entitlementStateDir(userDataPath: string): string {
  const root = path.resolve(userDataPath || path.join(os.homedir(), '.command-eve'));
  return path.join(root, 'command-eve-runtime', ENTITLEMENT_STATE_DIR);
}

/** Delete a single file if present. Idempotent; never throws. */
function rmIfExists(file: string): boolean {
  try {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      return true;
    }
  } catch {
    // ignore — a best-effort delete must never throw the reset.
  }
  return false;
}

export interface EntitlementResetDeps {
  /** Remove the license-wire record at rest (inject the real clearLicenseWire). */
  clearLicenseWire: (userDataPath: string) => void;
  /**
   * Revoke + clear the account session (inject the real revokeAndClearSession).
   * Best-effort GoTrue sign-out + local session.enc delete; never throws.
   */
  revokeAndClearSession: (userDataPath: string) => Promise<void>;
}

export interface EntitlementResetResult {
  version: typeof COMMAND_EVE_ENTITLEMENT_RESET_VERSION;
  ok: boolean;
  /** Which local artifacts were present and removed (audit/telemetry-friendly). */
  removed: {
    entitlement: boolean;
    registration: boolean;
    /** True once clearLicenseWire ran (it is itself idempotent). */
    license_wire: boolean;
    /** True once revokeAndClearSession ran (it is itself idempotent). */
    session: boolean;
  };
  reason_code?: string;
  message?: string;
}

/**
 * Perform the hard reset. Removes the three local trust artifacts and clears the
 * account session. Always returns ok:true on a clean run even when nothing was
 * present (idempotent re-reset is a no-op). A thrown injected dependency is
 * caught and reported as ok:false WITHOUT re-throwing (the chrome must never
 * crash on a reset), but the file deletions still ran first.
 */
export async function resetEntitlement(
  userDataPath: string,
  deps: EntitlementResetDeps
): Promise<EntitlementResetResult> {
  const dir = entitlementStateDir(userDataPath);

  // 1 + 2: delete the entitlement cache + the local PII registration record.
  const removedEntitlement = rmIfExists(path.join(dir, ENTITLEMENT_FILE));
  const removedRegistration = rmIfExists(path.join(dir, REGISTRATION_FILE));

  // 3: drop the EVE Inference bearer at rest.
  let licenseWireCleared = false;
  try {
    deps.clearLicenseWire(userDataPath);
    licenseWireCleared = true;
  } catch (error) {
    return {
      version: COMMAND_EVE_ENTITLEMENT_RESET_VERSION,
      ok: false,
      removed: {
        entitlement: removedEntitlement,
        registration: removedRegistration,
        license_wire: false,
        session: false,
      },
      reason_code: 'CLEAR_LICENSE_WIRE_FAILED',
      message: error instanceof Error ? error.message : undefined,
    };
  }

  // 4: revoke + clear the account session (reuses the soft-logout path).
  let sessionCleared = false;
  try {
    await deps.revokeAndClearSession(userDataPath);
    sessionCleared = true;
  } catch (error) {
    return {
      version: COMMAND_EVE_ENTITLEMENT_RESET_VERSION,
      ok: false,
      removed: {
        entitlement: removedEntitlement,
        registration: removedRegistration,
        license_wire: licenseWireCleared,
        session: false,
      },
      reason_code: 'REVOKE_SESSION_FAILED',
      message: error instanceof Error ? error.message : undefined,
    };
  }

  return {
    version: COMMAND_EVE_ENTITLEMENT_RESET_VERSION,
    ok: true,
    removed: {
      entitlement: removedEntitlement,
      registration: removedRegistration,
      license_wire: licenseWireCleared,
      session: sessionCleared,
    },
  };
}
