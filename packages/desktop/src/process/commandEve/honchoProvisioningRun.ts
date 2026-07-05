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

import fs from 'fs';
import path from 'path';
import { resolveSeatHome } from './seatContextCore';
import { buildHonchoRuntimeConfig, HONCHO_DEFAULT_LOCAL_MODEL_REF, HONCHO_DERIVER_BRANCH_LOCAL, type HonchoDeriverMode, type HonchoRuntimeConfig } from './honchoRuntimeConfigCore';
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
/**
 * MAC-VERIFY-PENDING — the env-var NAMES honcho-ai's deriver reads for its LLM
 * route. The VALUES are FACT (cfg.deriver.baseUrl already resolves to the loopback
 * Ollama /v1 for the local branch, the loopback shim /v1 for cloud); only these key
 * names must be confirmed against the installed wheel (OpenAI-style is the guess).
 * Gated behind one constant so the wheel-verified literal is a one-line correction.
 */
export const HONCHO_DERIVER_ENV_KEYS = {
  baseUrl: 'OPENAI_BASE_URL',
  apiKey: 'OPENAI_API_KEY',
  model: 'HONCHO_DERIVER_MODEL',
} as const;

/**
 * The deriver env OVERLAY for the honcho serve process, straight from cfg.deriver.
 * For the LOCAL branch this points honcho at loopback Ollama (behindEgressBoundary:
 * false — nothing leaves the machine); for CLOUD it points at the loopback shim
 * (the shim owns the bearer). Never a real secret (local key = 'ollama' placeholder;
 * cloud key = '' because the shim injects the Authorization header).
 */
export function buildHonchoDeriverEnv(cfg: HonchoRuntimeConfig): NodeJS.ProcessEnv {
  const d = cfg.deriver || {};
  const env: NodeJS.ProcessEnv = {};
  if (d.baseUrl) env[HONCHO_DERIVER_ENV_KEYS.baseUrl] = d.baseUrl;
  // DEFENSE-IN-DEPTH (Codex): NEVER bake a key on the CLOUD branch — the loopback
  // shim owns the bearer (Authorization header only). Only the LOCAL branch carries
  // its harmless 'ollama' placeholder. So even a future cfg that wrongly held a
  // bearer in deriver.apiKey can not serialize it into a cloud-lane env.
  if (d.behindEgressBoundary !== true && typeof d.apiKey === 'string') env[HONCHO_DERIVER_ENV_KEYS.apiKey] = d.apiKey;
  if (d.model) env[HONCHO_DERIVER_ENV_KEYS.model] = d.model;
  return env;
}

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
    // `honcho serve` flags (port, --db-url) are MAC-VERIFY-PENDING; the deriver LLM
    // route rides the per-step env overlay (buildHonchoDeriverEnv) so honcho derives
    // against the LOCAL Ollama (local branch) and never the cloud unless mode=cloud.
    [HONCHO_STEP_PROCESS]: { command: venvPython, args: ['-m', 'honcho', 'serve'], timeoutMs: 0, env: buildHonchoDeriverEnv(input.cfg) },
  };
}

/** Normalize a model ref for comparison (case/whitespace-insensitive). */
function normalizeModelRef(ref?: string): string {
  return typeof ref === 'string' ? ref.trim().toLowerCase() : '';
}

/**
 * The REAL local-model-ready signal for the AUTO deriver mode: true ONLY when the
 * machine's model-warmup receipt (`<runtimeRoot>/model-warmup-receipt.json`) has
 * status:'ready' AND its model is the honcho local deriver ref (a genuine warm proof
 * — the warmup posts a real 1-token completion through Ollama, index.ts:665-682).
 * Fail-soft to false on any read/parse error (default-deny ⇒ AUTO falls to cloud).
 * The receipt is machine-global (the model is), NOT per-seat — the caller must keep
 * it distinct from per-seat serverUp/deriverReachable.
 */
export function resolveLocalModelReadyFromWarmupReceipt(runtimeRoot: string, localModelRef: string = HONCHO_DEFAULT_LOCAL_MODEL_REF): boolean {
  try {
    const raw = fs.readFileSync(path.join(runtimeRoot, 'model-warmup-receipt.json'), 'utf8');
    const r = JSON.parse(raw) as { status?: string; model?: string } | null;
    return !!r && r.status === 'ready' && normalizeModelRef(r.model) === normalizeModelRef(localModelRef) && normalizeModelRef(localModelRef).length > 0;
  } catch {
    return false;
  }
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
  /** The user's deriver switch (auto|local|cloud). Absent ⇒ 'auto'. */
  deriverMode?: HonchoDeriverMode;
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
    const cfg = buildHonchoRuntimeConfig({ seatId: input.seatId ?? undefined, seatHome, ...deriverInputsFromConsent(input.consent), deriverMode: input.deriverMode });
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
    // The catch itself must NEVER throw (Codex confirm): do NOT call deps.now() here (a
    // bad injected clock could throw), and read input defensively. reduceHonchoReadiness
    // falls back to its own clock when no `now` is passed.
    const detail = `provisioning setup error: ${error instanceof Error ? error.message : String(error)}`;
    return {
      stages: [{ id: 'honcho-provision', status: 'skip', code: HONCHO_REASON_PROCESS_DOWN, detail }],
      readiness: reduceHonchoReadiness({ provisioned: false, seatId: input?.seatId ?? undefined }),
      honchoEnabled: false,
    };
  }
}

/** Marker so the local-branch derivation stays legible at call sites. */
export const HONCHO_LOCAL_BRANCH = HONCHO_DERIVER_BRANCH_LOCAL;
