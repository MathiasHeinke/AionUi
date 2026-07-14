/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE HONCHO RUNTIME RENDER core (1.7.0 / COMPA-624 Inc.3 / O2 + O5 — the
 * seat-render seam between the built cores and writeHermesRuntimeFiles).
 *
 * The built Honcho integration is an MCP SERVER (honchoMcpServerForSeat), NOT a
 * `memory.provider` + honcho.json client config. This module resolves, for one
 * seat, the SINGLE render input writeHermesRuntimeFiles consumes:
 *   - `ready`     — the seat's readiness snapshot passes the fresh two-fact guard,
 *   - `cfg`       — the per-seat Honcho runtime config (db uri / workspace / home),
 *   - `launcher`  — the venv command that launches the honcho MCP server (O2).
 *
 * DEFAULT-DENY: any missing/partial/stale/mismatched/error input yields
 * `{ ready: false }`, so a seat that was never provisioned renders NOTHING (the
 * emitted config.yaml + SOUL stay byte-identical to before Honcho existed). BOTH
 * the boot cadence (ensureCommandEveRuntimeBootstrap) and the seat-switch cadence
 * (provisionSeatRuntimeFiles) resolve through THIS one helper with the TARGET
 * seatId — so there is no active-seat drift and no path divergence (H-INT-2/10).
 */

import path from 'path';
import fs from 'fs';
import { resolveSeatHome } from './seatContextCore';
import {
  buildHonchoRuntimeConfig,
  HONCHO_DERIVER_BRANCH_LOCAL,
  type HonchoRuntimeConfig,
} from './honchoRuntimeConfigCore';
import { readHonchoReadyState } from './honchoReadyStateFile';
import { honchoReadyFromSnapshot, type HonchoReadinessState } from './honchoReadinessCore';
import type { HonchoMcpLauncher } from './honchoMcpServerCore';

/** The per-seat Honcho render input writeHermesRuntimeFiles consumes. */
export interface HonchoRenderInput {
  /** The seat's readiness snapshot passed the fresh two-fact guard AT RESOLVE TIME. */
  ready: boolean;
  /** The per-seat Honcho runtime config (only set when a home could be resolved). */
  cfg?: HonchoRuntimeConfig;
  /** The venv launcher for the honcho MCP server (only when ready + the venv exists). */
  launcher?: HonchoMcpLauncher;
}

/** Injected I/O so the resolver stays unit-testable with fakes. */
export interface ResolveHonchoRenderDeps {
  /** Read the per-seat readiness snapshot (defaults to the real file reader). */
  readReadiness?: (honchoHome: string) => HonchoReadinessState | undefined;
  /** Does the venv python exist on disk? (defaults to fs.existsSync). */
  fileExists?: (p: string) => boolean;
  /** Freshness clock for the two-fact guard (tests). */
  now?: () => number;
  maxAgeMs?: number;
}

/** The honcho MCP entrypoint the venv python runs (`python -m honcho.mcp`). */
export const HONCHO_MCP_ENTRY_ARGS: string[] = ['-m', 'honcho.mcp'];

/**
 * Resolve the Honcho render input for ONE seat. Fail-soft to `{ ready: false }` on
 * any error (an unsafe seat id throws in buildHonchoRuntimeConfig; a read error;
 * a missing venv). The launcher is set ONLY when the seat is fresh-ready AND the
 * venv python actually exists — otherwise honchoMcpServerForSeat refuses to
 * advertise (an un-spawnable server is never emitted).
 */
export function resolveHonchoRenderForSeat(
  input: { userDataPath: string; seatId?: string | null; hermesVenv?: string },
  deps: ResolveHonchoRenderDeps = {}
): HonchoRenderInput {
  try {
    const seatHome = resolveSeatHome(input.userDataPath, input.seatId);
    // First build a MINIMAL config purely to resolve the seat's honchoHome (the
    // readiness path). The deriver-branch inputs are threaded only AFTER we know the
    // snapshot's branch (below), so cfg.ready stays consistent with proven readiness.
    const homeProbe = buildHonchoRuntimeConfig({ seatId: input.seatId ?? undefined, seatHome });
    if (!homeProbe.honchoHome) return { ready: false };
    const readReadiness = deps.readReadiness || readHonchoReadyState;
    const snapshot = readReadiness(homeProbe.honchoHome);
    const now = typeof deps.now === 'function' ? deps.now() : Date.now();
    const ready = honchoReadyFromSnapshot(snapshot, { now, maxAgeMs: deps.maxAgeMs });
    if (!ready) return { ready: false, cfg: homeProbe };

    // A fresh-ready snapshot PROVES the deriver probe passed at provisioning time, so
    // rebuild the config with the branch-appropriate ready inputs — otherwise the
    // runtime default (cloud, no license) would leave cfg.ready=false and
    // honchoMcpServerForSeat (Codex #5) would refuse to advertise a proven-ready seat.
    const isLocalBranch = snapshot?.branch === HONCHO_DERIVER_BRANCH_LOCAL;
    const cfg = buildHonchoRuntimeConfig({
      seatId: input.seatId ?? undefined,
      seatHome,
      localModelOptedIn: isLocalBranch,
      localModelReady: isLocalBranch,
      hasLicense: !isLocalBranch, // cloud branch was reachable ⇒ it authenticated
    });

    // O2 launcher: `<hermesVenv>/bin/python -m honcho.mcp`. Only when the python
    // actually exists — otherwise the MCP entry would point at a dead binary.
    let launcher: HonchoMcpLauncher | undefined;
    const venv = typeof input.hermesVenv === 'string' ? input.hermesVenv.trim() : '';
    if (venv.length > 0) {
      const python = path.join(venv, 'bin', 'python');
      const fileExists = deps.fileExists || ((p: string) => fs.existsSync(p));
      if (fileExists(python)) {
        launcher = { command: python, args: [...HONCHO_MCP_ENTRY_ARGS] };
      }
    }
    return { ready: true, cfg, launcher };
  } catch {
    return { ready: false };
  }
}

/**
 * O5 — the SOUL clause that teaches EVE she has a DURABLE per-seat memory (the
 * honcho MCP tool) once it is really live. Returns '' unless ready, so on every
 * un-provisioned seat SOUL.md is byte-identical to today (EVE never claims a
 * memory she does not have). Per-client isolation is restated (the sacred rule).
 */
export function eveHonchoMemoryDirective(ready: boolean): string {
  if (ready !== true) return '';
  return [
    '',
    '## Dauerhaftes Gedächtnis (Honcho)',
    'Du hast für diesen Seat ein dauerhaftes, lokales Gedächtnis (das `honcho`-Werkzeug).',
    'Nutze es, um Wichtiges über den/die Kund:in und laufende Arbeit über Sitzungen hinweg',
    'zu behalten und gezielt abzurufen — nicht als Notizzettel für Belangloses.',
    'Es liegt ausschließlich lokal auf diesem Rechner und verlässt ihn nie.',
    'Absolut: Das Gedächtnis eines Seats bleibt in diesem Seat — kein Kontext eines Kunden',
    'sickert je in einen anderen. Ein Leck hier ist der schwerste Fehler.',
    '',
  ].join('\n');
}
