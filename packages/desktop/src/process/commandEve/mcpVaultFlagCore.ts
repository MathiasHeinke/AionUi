/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE MCP-VAULT FLAG (S5 phase 2, arch §6/§8/§9).
 *
 * IT IS ON (1.821.0). The feeder, the reconcile pass and the guided auth flow are
 * finished and already threaded through the bootstrap; the code described itself
 * as "READY for the GATE-NULL flip but INERT", which is the same as saying it was
 * built and then not used.
 *
 * WHAT THE GATE WAS FOR, AND WHY IT COMES OFF. It guarded PER-CLIENT ISOLATION:
 * the promise that a connector approved on seat A can never be spawned on seat B.
 * That promise matters when several paying clients share one install. There are
 * none — every seat today is the founder's, and holding a finished connector
 * surface shut to protect a customer who does not exist is self-restriction, not
 * safety. Same category as the `disabled_toolsets: [vision]` ban dropped a few
 * commits earlier, and the same treatment: open it and run it for real.
 *
 * The isolation itself is NOT what was switched off, and this is the distinction
 * worth keeping straight: the vetted set is read by file POSITION (founder vault
 * ∪ this seat's vault), never by filtering a shared list, so seat A's record has
 * nowhere to appear in seat B's set. The gate was a second belt around a property
 * the read path already has structurally.
 *
 * The env var survives as a KILL SWITCH rather than an opt-in — set
 * `COMMAND_EVE_MCP_VAULT_ENABLED=0` to pull the whole surface back to inert
 * without a rebuild.
 *
 * WHEN THIS FALLS BACK: the first install that serves a second party's seat. At
 * that point per-client isolation stops being a structural property nobody can
 * reach and becomes a claim someone is relying on — and it needs the CI gate the
 * original note described.
 *
 * Resolution precedence:
 *   1. a test-injected override (setMcpVaultEnabledForTests), if set;
 *   2. otherwise the env var, parsed as a strict boolean: an explicit falsey
 *      token ('0'/'false'/'off'/'no') disables; anything else, including unset,
 *      leaves it on.
 */

/** The env var name. Now the kill switch, not the opt-in. */
export const COMMAND_EVE_MCP_VAULT_ENABLED_ENV = 'COMMAND_EVE_MCP_VAULT_ENABLED';

/** Test-injected override. `undefined` = fall through to the env read. */
let injectedFlag: boolean | undefined;

/**
 * Strict parse of the kill switch: ONLY an explicit falsey token disables.
 *
 * Deliberately strict in the same way the old opt-in parse was, just pointed the
 * other way: a typo must not silently turn the surface off any more than it used
 * to silently turn it on. Unset means on, because on is now the product.
 */
function parseStrictDisable(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'off' || value === 'no';
}

/**
 * True iff the MCP vault feeder is enabled — which it is, unless the kill switch
 * is set. Reads a test override first (deterministic under vitest), then the env.
 *
 * `env` is injectable so callers/tests can pass an explicit env map; it defaults
 * to `process.env`.
 */
export function isMcpVaultEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (injectedFlag !== undefined) return injectedFlag;
  return !parseStrictDisable(env[COMMAND_EVE_MCP_VAULT_ENABLED_ENV]);
}

/**
 * TEST-ONLY: force the flag on/off for a single test, or pass `undefined` to
 * clear the override and fall back to the real env read. Mirrors the
 * `setSafeStorageForTesting` / `__reset*ForTests` idiom in this codebase.
 *
 * PRODUCTION MUST NEVER CALL THIS — the kill switch is the env var, and a runtime
 * toggle would be a second, invisible one.
 */
export function setMcpVaultEnabledForTests(value: boolean | undefined): void {
  injectedFlag = value;
}
