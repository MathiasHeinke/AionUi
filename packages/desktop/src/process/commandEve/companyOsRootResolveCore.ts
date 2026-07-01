/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S10 — HONEST resolution of the Company.OS repo root the command-center /
 * status-surface cores need, set into the main-process env at startup.
 *
 * THE GAP (investigated): `commandCenterReadModelCore` + `statusSurfaceCore` read
 * `process.env.COMMAND_EVE_COMPANY_OS_ROOT` and JOIN onto DEVELOPMENT-MONOREPO
 * scripts that live ONLY in the founder's Company.OS checkout and are NEVER
 * bundled into the desktop app:
 *   - scripts/command-center/command-center-read-model.mjs   (read-model CLI)
 *   - scripts/command-center/command-center-read-model-core.mjs (reducer)
 *   - scripts/operator-shell/command-eve-status-surface.mjs  (status CLI)
 * The env var is NEVER set in prod (only E2E), so those cores silently fail-closed
 * with a `COMPANY_OS_ROOT_MISSING` reason code on every install.
 *
 * WHY WE DO NOT JUST "SET A PATH": on an END-USER machine there is NO Company.OS
 * checkout, and no reliable way to know where (or whether) one exists — the repo
 * is a SEPARATE monorepo, not bundled, not even present in the desktop app's own
 * dev tree. Inventing a path would be a lie that turns a clean "missing" into a
 * confusing "failed at /some/guessed/dir". (The CRM overlay + kanban event-ledger
 * consumers do NOT depend on this: they already fall back to the per-install
 * runtime dir when the root is unset, so they are intentionally out of scope.)
 *
 * THE HONEST FIX (this core):
 *   1. If the env var is ALREADY set (E2E, or a founder who exports it), RESPECT
 *      it verbatim — never override an explicit choice.
 *   2. Otherwise probe a small, ordered set of well-known DEV candidate roots and
 *      accept the FIRST that actually CONTAINS the read-model CLI marker (proof
 *      the checkout is really there). This auto-wires the founder's dev box
 *      without a hardcoded absolute path.
 *   3. If nothing validates (the normal end-user case), return `undefined` and
 *      leave the env UNSET — the cores keep their clean `COMPANY_OS_ROOT_MISSING`
 *      fail-closed. We NEVER invent a path.
 *
 * PURE + injectable: the fs probe (`markerExists`) and candidate list are injected
 * so the whole decision is unit-testable without touching a real filesystem.
 */

import path from 'path';

/** The env vars the cores read for the root, in precedence order. */
export const COMPANY_OS_ROOT_ENV_KEYS = [
  'COMMAND_EVE_COMPANY_OS_ROOT',
  'COMPANY_OS_ROOT',
  'COMMAND_EVE_SOURCE_ROOT',
] as const;

/**
 * The relative marker that PROVES a candidate dir is a real Company.OS checkout
 * with the command-center CLIs the cores invoke. If this file is not present, the
 * cores would fail anyway — so it is the correct acceptance test.
 */
export const COMPANY_OS_ROOT_MARKER = path.join(
  'scripts',
  'command-center',
  'command-center-read-model.mjs'
);

export type CompanyOsRootResolveInput = {
  /** The current env (read-only; we DECIDE, the caller mutates process.env). */
  env: NodeJS.ProcessEnv;
  /** Ordered candidate roots to probe (dev/well-known locations). */
  candidates: readonly string[];
  /** True iff `path.join(root, COMPANY_OS_ROOT_MARKER)` exists (injected fs probe). */
  markerExists: (root: string) => boolean;
};

export type CompanyOsRootResolution =
  | { action: 'respect-existing'; root: string; envKey: string }
  | { action: 'detected'; root: string }
  | { action: 'unset'; checked: readonly string[] };

/** The env value already set for the root (first non-empty by precedence), if any. */
function existingRootFromEnv(env: NodeJS.ProcessEnv): { root: string; envKey: string } | undefined {
  for (const key of COMPANY_OS_ROOT_ENV_KEYS) {
    const value = String(env[key] || '').trim();
    if (value) return { root: value, envKey: key };
  }
  return undefined;
}

/**
 * Decide the Company.OS root WITHOUT mutating anything. Returns a discriminated
 * resolution the caller acts on (set the env only for `detected`).
 */
export function resolveCompanyOsRoot(input: CompanyOsRootResolveInput): CompanyOsRootResolution {
  const existing = existingRootFromEnv(input.env);
  if (existing) {
    return { action: 'respect-existing', root: existing.root, envKey: existing.envKey };
  }

  const checked: string[] = [];
  for (const candidate of input.candidates) {
    const root = String(candidate || '').trim();
    if (!root || checked.includes(root)) continue;
    checked.push(root);
    if (input.markerExists(root)) {
      return { action: 'detected', root };
    }
  }
  return { action: 'unset', checked };
}

/**
 * Build the ordered candidate root list from the app's dev locations. Marker-
 * validated later, so a non-existent candidate is harmless. We walk UP from the
 * app path and cwd (the founder's Company.OS is typically a sibling/ancestor of
 * the desktop checkout in dev), plus a couple of conventional sibling names. We
 * NEVER include an absolute hardcoded founder path.
 *
 * @param appPath  app.getAppPath() (the desktop app dir).
 * @param cwd      process.cwd().
 * @param home     the user home dir (os.homedir()) — for conventional dev roots.
 */
export function buildCompanyOsRootCandidates(appPath: string, cwd: string, home: string): string[] {
  const bases = [appPath, cwd].filter((b) => typeof b === 'string' && b.length > 0);
  const candidates: string[] = [];

  const pushUnique = (p: string) => {
    const t = String(p || '').trim();
    if (t && !candidates.includes(t)) candidates.push(t);
  };

  for (const base of bases) {
    // Walk up a few levels; at each, try the level itself and a `Company.OS`
    // sibling. This catches the common layout where the desktop app checkout and
    // the Company.OS monorepo are siblings under a shared parent (e.g.
    // ~/Developer/<app> and ~/Developer/Company.OS).
    let dir = base;
    for (let i = 0; i < 6; i += 1) {
      pushUnique(dir);
      pushUnique(path.join(dir, 'Company.OS'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // A conventional dev location under the home dir (marker-validated, so this is
  // only ACCEPTED if it genuinely holds a Company.OS checkout).
  if (home) {
    pushUnique(path.join(home, 'Developer', 'Company.OS'));
  }

  return candidates;
}
