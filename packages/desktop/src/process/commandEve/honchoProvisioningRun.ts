/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE HONCHO PROVISIONING RUN (1.7.0 / COMPA-624 Inc.3 — the thin adapter
 * that drives the built orchestration brain runHonchoBootstrap for ONE seat).
 *
 * This wires the pieces: resolve the per-seat config → inject the detected deps →
 * build the plan → build the command set → run the fail-safe bootstrap. It is
 * DELIBERATELY NOT spliced into the synchronous boot path: provisioning installs
 * machine deps (Homebrew/Postgres) which is heavy and slow, so the caller runs it
 * in the BACKGROUND behind the operator opt-in — never blocking first value.
 *
 * FACT BOUNDARY (honest): the exact system command STRINGS in buildHonchoCommandSet
 * and the dep-detection probes are the ONE part that must be VERIFIED ON A REAL MAC
 * against the live honcho-ai wheel (there is no honcho/postgres in a headless CI).
 * They are marked MAC-VERIFY-PENDING. Everything else here — the wiring, the
 * opt-in/consent gate, the fail-safety (a Honcho miss is always 'skip', never
 * blocks) — is unit-tested with fakes, so the Mac step is "verify the strings +
 * flip the opt-in", not "build the orchestration".
 */

import { resolveSeatHome } from './seatContextCore';
import { buildHonchoRuntimeConfig, HONCHO_DERIVER_BRANCH_LOCAL, type HonchoRuntimeConfig } from './honchoRuntimeConfigCore';
import {
  HONCHO_STEP_DB,
  HONCHO_STEP_HOMEBREW,
  HONCHO_STEP_PACKAGE,
  HONCHO_STEP_PGVECTOR,
  HONCHO_STEP_POSTGRES,
  HONCHO_STEP_PROCESS,
  HONCHO_STEP_PYTHON,
  buildHonchoProvisionPlan,
  type HonchoConsentState,
  type HonchoDepDetection,
  type HonchoProvisionMode,
} from './honchoProvisionPlanCore';
import { runHonchoBootstrap, type HonchoBootstrapResult, type HonchoCommandSet } from './honchoBootstrapCore';
import { HONCHO_REASON_PROCESS_DOWN, reduceHonchoReadiness } from './honchoReadinessCore';
import { writeHonchoReadyState } from './honchoReadyStateFile';
import type { RuntimeBootstrapRunner, RuntimeBootstrapDetachedSpawner } from './runtimeBootstrapCore';

/**
 * MAC-VERIFY-PENDING — the exact provisioning commands. Structure is FACT (the
 * step order + the venv/db targets come from the config); the precise brew formula
 * names + the honcho serve/mcp invocation must be confirmed against the installed
 * honcho-ai wheel on a real machine before this path is opt-in-enabled for users.
 * Until then a wrong string fails its step → the chain stops → Honcho stays not-ready
 * → memory falls back to Company Brain (never a crash, never a blocked boot).
 */
export function buildHonchoCommandSet(input: { cfg: HonchoRuntimeConfig; hermesVenv: string }): HonchoCommandSet {
  const venvPython = `${input.hermesVenv}/bin/python`;
  const venvPip = `${input.hermesVenv}/bin/pip`;
  const dbName = input.cfg.dbName || '';
  return {
    // Presence/install of the package manager. brew's own bootstrap is a curl
    // script (needs its own consent) — MAC-VERIFY-PENDING whether we detect-only or
    // run the official install here.
    [HONCHO_STEP_HOMEBREW]: { command: 'brew', args: ['--version'], timeoutMs: 20000 },
    [HONCHO_STEP_POSTGRES]: { command: 'brew', args: ['install', 'postgresql@16'], timeoutMs: 300000 },
    [HONCHO_STEP_PGVECTOR]: { command: 'brew', args: ['install', 'pgvector'], timeoutMs: 300000 },
    // Python runtime is the existing hermes venv (uv is a 1.8 concern). PYTHON is a
    // presence check; PACKAGE installs honcho-ai INTO that venv.
    [HONCHO_STEP_PYTHON]: { command: venvPython, args: ['--version'], timeoutMs: 20000 },
    [HONCHO_STEP_PACKAGE]: { command: venvPip, args: ['install', 'honcho-ai'], timeoutMs: 300000 },
    // Per-seat DB + the vector extension. createdb is idempotent-ish; a second run
    // errors "already exists" (handled as pass by the runner's own idempotency, or
    // detection marks dbProvisioned=true so this step is skipped as satisfied).
    [HONCHO_STEP_DB]: { command: 'createdb', args: [dbName], timeoutMs: 60000 },
    // The long-running local Honcho server (detached — no result awaited). The exact
    // `honcho serve` flags (port, --db-url, deriver base) are MAC-VERIFY-PENDING.
    [HONCHO_STEP_PROCESS]: { command: venvPython, args: ['-m', 'honcho', 'serve'], timeoutMs: 0 },
  };
}

/** What the seat's consent implies for the config's deriver branch + readiness. */
function deriverInputsFromConsent(consent: HonchoConsentState): {
  localModelOptedIn?: boolean;
  localModelReady?: boolean;
  hasLicense?: boolean;
} {
  // Local branch ONLY when the operator opted into the local model AND it is ready;
  // otherwise the cloud-flash deriver (which needs the CEVE license) is the default.
  const local = consent.localModelOptedIn === true && consent.localModelReady === true;
  return { localModelOptedIn: local, localModelReady: local, hasLicense: consent.hasLicense === true };
}

export interface RunHonchoProvisioningInput {
  userDataPath: string;
  seatId?: string | null;
  hermesVenv: string;
  consent: HonchoConsentState;
  mode?: HonchoProvisionMode;
}

export interface RunHonchoProvisioningDeps {
  /** Detect installed deps + machine capacity (MAC-VERIFY-PENDING real impl; injected in tests). */
  detectDeps: () => HonchoDepDetection | Promise<HonchoDepDetection>;
  runner: RuntimeBootstrapRunner;
  detachedSpawner: RuntimeBootstrapDetachedSpawner;
  probeServer: () => Promise<boolean>;
  probeDeriver: () => Promise<boolean>;
  /** Defaults to the real readiness writer. */
  writeReadiness?: (honchoHome: string, state: Parameters<typeof writeHonchoReadyState>[1]) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  buildCommands?: (input: { cfg: HonchoRuntimeConfig; hermesVenv: string }) => HonchoCommandSet;
}

/**
 * Provision Honcho for ONE seat. NEVER throws — the whole body (setup + bootstrap) is
 * fail-soft, so a background trigger can fire-and-forget it without an unhandled
 * rejection. It is a NO-OP install when the consent/mode/disk/RAM plan is disabled
 * (buildHonchoProvisionPlan) — the runner is never even reached in that case. On the
 * happy path runHonchoBootstrap writes the readiness snapshot; on a setup error it
 * returns a not-ready off result (no file write when the home could not be resolved).
 * The caller (a post-boot background trigger) gates the WHOLE call on the operator opt-in.
 */
export async function runHonchoProvisioningForSeat(
  input: RunHonchoProvisioningInput,
  deps: RunHonchoProvisioningDeps
): Promise<HonchoBootstrapResult> {
  // FULLY fail-soft (Codex tight-audit): runHonchoBootstrap is the inner fail-safe, but the
  // SETUP before it (resolveSeatHome/buildHonchoRuntimeConfig throw on an unsafe seat id;
  // detectDeps/buildCommands may throw or reject) must NOT escape into the background trigger.
  // Any setup error degrades to a not-ready off result — never an unhandled rejection.
  try {
    const seatHome = resolveSeatHome(input.userDataPath, input.seatId);
    const cfg = buildHonchoRuntimeConfig({ seatId: input.seatId ?? undefined, seatHome, ...deriverInputsFromConsent(input.consent) });
    const detection = await deps.detectDeps();
    const plan = buildHonchoProvisionPlan({ detection, consent: input.consent, mode: input.mode, config: cfg });
    const buildCommands = deps.buildCommands || buildHonchoCommandSet;
    const commands = buildCommands({ cfg, hermesVenv: input.hermesVenv });
    return await runHonchoBootstrap({
      plan,
      config: cfg,
      commands,
      runner: deps.runner,
      detachedSpawner: deps.detachedSpawner,
      probeServer: deps.probeServer,
      probeDeriver: deps.probeDeriver,
      writeReadiness: deps.writeReadiness || writeHonchoReadyState,
      env: deps.env,
      now: deps.now,
    });
  } catch (error) {
    const now = typeof deps.now === 'function' ? deps.now() : undefined;
    return {
      stages: [{ id: 'honcho-provision', status: 'skip', code: HONCHO_REASON_PROCESS_DOWN, detail: `provisioning setup error: ${error instanceof Error ? error.message : String(error)}` }],
      readiness: reduceHonchoReadiness({ provisioned: false, seatId: input.seatId ?? undefined, now }),
      honchoEnabled: false,
    };
  }
}

/** Marker so the local-branch derivation stays legible at call sites. */
export const HONCHO_LOCAL_BRANCH = HONCHO_DERIVER_BRANCH_LOCAL;
