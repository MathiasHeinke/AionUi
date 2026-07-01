/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credential-Vault DIRECTORY resolver (S5 phase 1, arch §1/§2).
 *
 * The vault is COMPOSITION, not a new build: encryption is the `keychain.ts`
 * seam (orthogonal — an opaque ref carries NO scope), and SCOPING is the file
 * POSITION. This module owns ONLY the position half — WHERE a vault dir lives —
 * exactly the way `accountSessionAtRest.ts` isolates its entitlement dir by
 * position and `resolveSeatScopedStorageRoots` isolates per-seat roots.
 *
 * Two tiers (arch §1 — the memory-tree in credentials):
 *   FOUNDER vault (global, 1×):   <userData>/command-eve-runtime/vault/founder
 *   SEAT vault    (per seat, n×): <seat cacheRoot>/vault
 *
 * The FOUNDER dir mirrors `accountSessionAtRest.entitlementStateDir` precedence
 * (`path.resolve(userDataPath || ~/.command-eve)/command-eve-runtime/...`) so it
 * never drifts from the shipped runtime root. The SEAT dir is built on the
 * ALREADY-PROVEN `resolveSeatScopedStorageRoots` sanitizer (imported, never
 * edited) so a crafted seatId can never traverse out of the `seats/` subtree —
 * an unsanitizable id THROWS there (path-traversal guard, arch §11.4).
 *
 * PURE resolvers (no fs). `ensureVaultDir` is the ONLY fs side-effect and it
 * creates the dir 0o700 (arch §2). Injectable so this unit-tests in plain node.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSeatScopedStorageRoots } from './seatContextCore';

/** The runtime root family the entitlement + account-session records live in. */
const RUNTIME_SUBDIR = 'command-eve-runtime';
/** The vault subtree under the runtime root (founder tier). */
const VAULT_SUBDIR = 'vault';
/** The founder tier dir name. */
const FOUNDER_SUBDIR = 'founder';
/** The per-seat vault dir name (appended to the seat's cacheRoot). */
const SEAT_VAULT_SUBDIR = 'vault';

/**
 * FOUNDER-vault dir. Global, 1× per install:
 *   <resolved root>/command-eve-runtime/vault/founder
 *
 * Resolves the userData root with the SAME precedence as
 * `accountSessionAtRest.entitlementStateDir` (`path.resolve(userDataPath ||
 * join(os-home, '.command-eve'))`) so the vault never drifts from the runtime
 * root the rest of the app writes into. The os-home default is injectable so the
 * resolver is deterministic under test. PURE — no fs.
 */
export function founderVaultDir(userDataPath: string, homeDir?: string): string {
  const resolvedHomeDir = homeDir ?? os.homedir();
  const root = path.resolve(userDataPath || path.join(resolvedHomeDir, '.command-eve'));
  return path.join(root, RUNTIME_SUBDIR, VAULT_SUBDIR, FOUNDER_SUBDIR);
}

/**
 * SEAT-vault dir for a given configRoot + seatId:
 *   <seat cacheRoot>/vault
 *
 * Built on `resolveSeatScopedStorageRoots(configRoot, _, seatId).cacheRoot` —
 * the PROVEN sanitizer. A legacy/no-seat id maps to the legacy cacheRoot (the
 * founder home; no `seats/` segment), a real seat to
 * `<configRoot>/seats/<sanitized-id>`. An UNSANITIZABLE seatId makes the
 * underlying `assertSeatId` THROW (path-traversal guard) — this function
 * propagates that throw (fail-closed, arch §11.4). PURE — no fs.
 *
 * NOTE: the second (`dataRoot`) arg to `resolveSeatScopedStorageRoots` is
 * irrelevant here (we only take `cacheRoot`); we pass `configRoot` verbatim so
 * no bogus root is invented.
 */
export function seatVaultDir(configRoot: string, seatId?: string | null): string {
  const roots = resolveSeatScopedStorageRoots(configRoot, configRoot, seatId);
  return path.join(roots.cacheRoot, SEAT_VAULT_SUBDIR);
}

/**
 * Ensure a vault dir exists, created 0o700 (owner-only — arch §2). Idempotent.
 * The ONLY fs side-effect in this module. Returns the dir path.
 */
export function ensureVaultDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
