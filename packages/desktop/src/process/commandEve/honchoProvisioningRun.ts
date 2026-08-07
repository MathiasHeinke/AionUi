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
 * MEASURED ON A REAL MAC, 2026-08-07 — AND THE PREMISE DID NOT HOLD.
 *
 * The open work was described here as "verify the strings + flip the opt-in".
 * That framing is now measurably wrong, and leaving it would send the next
 * measurement down the same path:
 *
 *   `honcho-ai` 2.2.0 is the "Official DX Optimized Python SDK for Honcho"
 *   (PyPI metadata), and its only runtime dependencies are httpx and pydantic.
 *   It is a CLIENT. It ships no server, no ASGI runner, no database driver —
 *   there is no uvicorn, fastapi, sqlalchemy or psycopg anywhere in its
 *   dependency set. `honcho-cli` 0.1.2 ("a terminal for Honcho") is a client too.
 *
 * So HONCHO_STEP_PACKAGE installs a client and HONCHO_STEP_PROCESS then tries to
 * `serve` with it, and the Postgres/pgvector steps exist for a server this venv
 * never receives. The Honcho SERVER lives in the plastic-labs/honcho repository
 * and is deployed separately; it is not a `pip install` away.
 *
 * That is a wrong PREMISE, not a wrong string, so the strings below are left
 * exactly as they are rather than repaired on a guess — see each step's note for
 * what was verified and what it depends on. The wiring, the opt-in/consent gate
 * and the fail-safety (a Honcho miss is always 'skip', never blocks) remain
 * unit-tested and unaffected; this path is still not spliced into boot, so
 * nothing here can fire today.
 *
 * WHAT THE NEXT SLICE HAS TO DECIDE, before any string is worth fixing: how the
 * server is obtained at all (vendored container, repo checkout, or dropping the
 * local-server idea and pointing the SDK at a hosted instance). Everything below
 * follows from that answer.
 */

import fs from 'fs';
import path from 'path';
import { resolveSeatHome } from './seatContextCore';
import {
  buildHonchoRuntimeConfig,
  HONCHO_DEFAULT_LOCAL_MODEL_REF,
  HONCHO_DERIVER_BRANCH_LOCAL,
  type HonchoDeriverMode,
  type HonchoRuntimeConfig,
} from './honchoRuntimeConfigCore';
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
import { ensureCommandEveShimAuthToken } from './ollamaOpenAiShim';
import type { RuntimeBootstrapRunner, RuntimeBootstrapDetachedSpawner } from './runtimeBootstrapCore';

/**
 * MEASURED 2026-08-07 on the founder's Mac (Homebrew 6.0.9, Apple Silicon).
 * Nothing was installed; every line below is a read.
 *
 * VERIFIED: `brew` exists at /opt/homebrew/bin/brew. Both formula NAMES resolve —
 * `postgresql@16` (stable 16.14) and `pgvector` (stable 0.8.6) exist in
 * homebrew-core today, so neither name has rotted.
 *
 * WRONG, and provable without installing:
 *
 *  1. VERSION MISMATCH. `pgvector` 0.8.6 declares its build dependencies as
 *     postgresql@17 and postgresql@18 — NOT @16. Installing this pair yields a
 *     vector extension built for a server generation the @16 cluster cannot load,
 *     so `CREATE EXTENSION vector` fails after both steps report success.
 *
 *  2. `createdb` WILL NOT BE ON PATH. `postgresql@16` is keg-only (brew info says
 *     so, and `brew --prefix postgresql@16` is /opt/homebrew/opt/postgresql@16),
 *     so Homebrew never links its binaries into /opt/homebrew/bin. Confirmed on
 *     this machine: createdb, psql, initdb and pg_ctl are all absent from PATH.
 *     The DB step below would fail with ENOENT even after a perfect install.
 *
 * Both are left UNCHANGED on purpose. The right postgres generation and the right
 * absolute binary path both follow from which Honcho SERVER we end up running, and
 * that question is open (see the module header). Correcting them now would mean
 * guessing twice and calling it verification.
 *
 * Fail-safety is unaffected either way: a wrong string fails its step → the chain
 * stops → Honcho stays not-ready → memory falls back to Company Brain.
 */
/**
 * STILL OPEN, and now for a clearer reason — the env-var NAMES a Honcho DERIVER
 * reads for its LLM route.
 *
 * This could not be settled on 2026-08-07: the names belong to the SERVER, and
 * `honcho-ai` is the client SDK (see the module header), so installing it would
 * not have answered the question either. Reading them off a wheel was never going
 * to work; they have to come from whichever server deployment we choose.
 *
 * The VALUES remain FACT: cfg.deriver.baseUrl already resolves to loopback Ollama
 * /v1 on the local branch and the loopback shim /v1 on cloud. Only the key names
 * are a guess (OpenAI-style), and they stay behind this one constant so the
 * correction remains a single line whenever the server is decided.
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
 * (the shim owns the cloud bearer). Never a real cloud secret: local uses the
 * harmless 'ollama' placeholder; cloud uses only the process-local shim nonce.
 */
export function buildHonchoDeriverEnv(cfg: HonchoRuntimeConfig): NodeJS.ProcessEnv {
  const d = cfg.deriver || {};
  const env: NodeJS.ProcessEnv = {};
  if (d.baseUrl) env[HONCHO_DERIVER_ENV_KEYS.baseUrl] = d.baseUrl;
  // The cloud branch receives only the random local shim nonce. The CEVE license
  // remains inside the shim and can never be serialized into Honcho's environment.
  if (d.behindEgressBoundary === true) {
    env[HONCHO_DERIVER_ENV_KEYS.apiKey] = ensureCommandEveShimAuthToken();
  } else if (typeof d.apiKey === 'string') {
    env[HONCHO_DERIVER_ENV_KEYS.apiKey] = d.apiKey;
  }
  if (d.model) env[HONCHO_DERIVER_ENV_KEYS.model] = d.model;
  return env;
}

export function buildHonchoCommandSet(input: { cfg: HonchoRuntimeConfig; hermesVenv: string }): HonchoCommandSet {
  const venvPython = `${input.hermesVenv}/bin/python`;
  const venvPip = `${input.hermesVenv}/bin/pip`;
  const dbName = input.cfg.dbName || '';
  return {
    // VERIFIED 2026-08-07: `brew --version` answers on this machine (Homebrew
    // 6.0.9, /opt/homebrew/bin/brew). Still OPEN by policy, not by measurement:
    // whether we ever run brew's own curl bootstrap for an operator who has no
    // Homebrew — that needs its own consent and is not decided here.
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
    // BLOCKED, measured 2026-08-07: this cannot work as written, and not because
    // of a flag. `honcho-ai` is the Honcho CLIENT SDK (httpx + pydantic, no server
    // stack), so the package the step above installs provides nothing to `serve`.
    // The flags were never the open question; the server's origin is. Left as-is
    // rather than replaced by a guess — see the module header.
    //
    // The deriver env overlay (buildHonchoDeriverEnv) is unaffected and stays
    // correct for whatever server we end up running: it points the deriver at the
    // LOCAL Ollama on the local branch and never at the cloud unless mode=cloud.
    [HONCHO_STEP_PROCESS]: {
      command: venvPython,
      args: ['-m', 'honcho', 'serve'],
      timeoutMs: 0,
      env: buildHonchoDeriverEnv(input.cfg),
    },
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
export function resolveLocalModelReadyFromWarmupReceipt(
  runtimeRoot: string,
  localModelRef: string = HONCHO_DEFAULT_LOCAL_MODEL_REF
): boolean {
  try {
    const raw = fs.readFileSync(path.join(runtimeRoot, 'model-warmup-receipt.json'), 'utf8');
    const r = JSON.parse(raw) as { status?: string; model?: string } | null;
    return (
      !!r &&
      r.status === 'ready' &&
      normalizeModelRef(r.model) === normalizeModelRef(localModelRef) &&
      normalizeModelRef(localModelRef).length > 0
    );
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
    const cfg = buildHonchoRuntimeConfig({
      seatId: input.seatId ?? undefined,
      seatHome,
      ...deriverInputsFromConsent(input.consent),
      deriverMode: input.deriverMode,
    });
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
