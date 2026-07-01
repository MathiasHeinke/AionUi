/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE MCP-VAULT BUILD FLAG (S5 phase 2, arch §6/§8/§9 — the safety gate).
 *
 * The ENTIRE vault feeder + reconcile + guided-auth surface stays behind this
 * ONE flag, which defaults to **false**. While false:
 *   - `resolveVettedMcpServersForBootstrap` returns `[]` (byte-identical to today);
 *   - the emitted config.yaml stays `mcp_servers: {}` (ZERO live-behavior change);
 *   - reconcile re-renders with an empty vetted list (a no-op in practice).
 *
 * The flip to `true` is a SEPARATE, GATE-NULL-gated slice (arch §9, after the
 * per-seat isolation CI is green). This module NEVER flips it — it only READS the
 * default-false flag and exposes a TEST-ONLY override so the flag-TRUE branches are
 * exercisable in unit tests without touching production posture.
 *
 * Resolution precedence:
 *   1. a test-injected override (setMcpVaultEnabledForTests), if set;
 *   2. otherwise the env var `COMMAND_EVE_MCP_VAULT_ENABLED` parsed as a strict
 *      boolean ('1'/'true'/'on'/'yes' → true; ANYTHING else, incl. unset → false).
 *
 * Fail-closed: any unrecognized / missing value resolves to `false`. The security
 * posture is the DEFAULT, not an option (arch §11.5).
 */

/** The env var name that (in a future GATE-NULL slice) flips the vault on. */
export const COMMAND_EVE_MCP_VAULT_ENABLED_ENV = 'COMMAND_EVE_MCP_VAULT_ENABLED';

/** Test-injected override. `undefined` = fall through to the env read. */
let injectedFlag: boolean | undefined;

/** Strict boolean parse: only an explicit truthy token enables. Else false. */
function parseStrictBool(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

/**
 * True iff the MCP vault feeder is enabled. Default-false. Reads a test override
 * first (deterministic under vitest), then the env var, fail-closed to false.
 *
 * `env` is injectable so callers/tests can pass an explicit env map; it defaults
 * to `process.env`.
 */
export function isMcpVaultEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (injectedFlag !== undefined) return injectedFlag;
  return parseStrictBool(env[COMMAND_EVE_MCP_VAULT_ENABLED_ENV]);
}

/**
 * TEST-ONLY: force the flag on/off for a single test, or pass `undefined` to
 * clear the override and fall back to the real env read. Mirrors the
 * `setSafeStorageForTesting` / `__reset*ForTests` idiom in this codebase.
 *
 * PRODUCTION MUST NEVER CALL THIS — the flip to true is the GATE-NULL slice, not
 * a runtime toggle.
 */
export function setMcpVaultEnabledForTests(value: boolean | undefined): void {
  injectedFlag = value;
}
