/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE CURATOR TICK — the trigger the desktop chat lane never had.
 *
 * `runtimeBootstrapCore` emits `curator: enabled: true` into the Hermes config,
 * and the comment beside it admitted the rest: on the desktop ACP lane
 * `maybe_run_curator` NEVER fires. Measured against the bundled 0.20.0 wheel it
 * has exactly two callers — `cli.py:15052` (interactive CLI start) and
 * `gateway/run.py:25952` (the gateway housekeeping loop) — and `acp_adapter/`
 * contains the string "curator" zero times. The capability was declared and dead.
 *
 * WHY THIS SPAWNS `curator run` AND NOT `maybe_run_curator`. `should_run_now`
 * (`curator.py:233-282`) has a first-observation rule: with no `last_run_at` it
 * SEEDS the timestamp to now and returns False, deferring the first real pass by
 * a full interval — and the default interval is `DEFAULT_INTERVAL_HOURS = 24 * 7`
 * (`curator.py:70`). A tick built on `maybe_run_curator` would therefore be
 * guaranteed silent for its first seven days. `hermes curator run` bypasses that
 * gate: `_cmd_run` (`hermes_cli/curator.py:213-245`) calls `run_curator_review`
 * directly and never consults `should_run_now`.
 *
 * WHY `--synchronous` AND NOT `--background`. This shipped with `--background`
 * for one commit, on the reasoning that the call must not hang our process. That
 * reasoning does not apply: the spawn is detached with `stdio: 'ignore'`, so
 * nothing here waits on it either way — and `--background` cost a receipt.
 *
 * `synchronous = bool(args.synchronous) or not background`
 * (`hermes_cli/curator.py:221`), and with `--background` the run's SECOND state
 * write happens inside a daemon thread started at `curator.py:1747`, which the
 * exiting CLI kills. Measured: `last_run_duration_seconds` and
 * `last_report_path` both came back null. `--synchronous` keeps them, and it
 * costs exactly nothing, because with consolidation off the prune-only branch
 * (`curator.py:1598-1638`) writes its report, saves state and RETURNS before any
 * model call — its own `llm_meta` records an empty model and provider.
 *
 * WHY IT COSTS NOTHING. `--consolidate` is deliberately NOT passed, so the run
 * reads `curator.consolidate` from config, which is OFF by default
 * (`curator.py:204-212`). With it off the run does only the deterministic
 * inactivity prune and skips the forked aux-model review entirely — no model
 * call, no credits. Adding `--consolidate` here is the one edit that would turn
 * this into a cost item.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not gate itself on
 * `curatorSafetyCore.resolveCuratorRuntimeState`. That module returns `disabled`
 * without a staged review and a visible budget, so putting it in front would make
 * the tick inert on the first day — a gate around a lock instead of opening it.
 * It stays where it is for the day the LLM consolidation is switched on; that day
 * is not today.
 */

import path from 'node:path';

/** Slow on purpose: the real schedule lives in the curator, this is only a nudge. */
export const CURATOR_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface CuratorTickPaths {
  hermesVenv: string;
  hermesHome: string;
  platform: NodeJS.Platform;
}

/** Mirrors `hermesConsoleBinary` (runtimeBootstrapCore.ts:3505) for this module's own use. */
export function curatorTickBinary(paths: CuratorTickPaths): string {
  return paths.platform === 'win32'
    ? path.join(paths.hermesVenv, 'Scripts', 'hermes.exe')
    : path.join(paths.hermesVenv, 'bin', 'hermes');
}

/**
 * The argv, as its own exported constant so a test can prove what is NOT in it.
 *
 * `--synchronous` runs the whole pass in the spawned process, which is what keeps
 * `last_run_duration_seconds` and `last_report_path` — see the header for why it
 * is free. `--consolidate` is absent by construction, not by accident: it is the
 * single flag that would turn this tick into a cost item.
 */
export const CURATOR_TICK_ARGS: readonly string[] = ['curator', 'run', '--synchronous'];

export interface CuratorTickDecisionInput {
  /** Wall clock now, injected so the decision is testable without a clock. */
  nowMs: number;
  /** When this process last spawned a tick. `undefined` = never. */
  lastTickAtMs?: number;
  /** Whether the bundled Hermes console binary is actually present. */
  binaryPresent: boolean;
  intervalMs?: number;
}

/**
 * May a tick be spawned right now?
 *
 * Three refusals, each for its own reason rather than as one blanket check: no
 * binary means Hermes is not installed on this box (a debug line, never an
 * error); too soon means the previous nudge is still fresh; and a clock that
 * moved backwards is treated as "too soon" rather than as permission, because a
 * backwards jump must never become a burst of spawns.
 */
export function shouldRunCuratorTick(input: CuratorTickDecisionInput): boolean {
  if (!input.binaryPresent) return false;
  const interval =
    typeof input.intervalMs === 'number' && input.intervalMs > 0 ? input.intervalMs : CURATOR_TICK_INTERVAL_MS;
  if (input.lastTickAtMs === undefined) return true;
  if (!Number.isFinite(input.lastTickAtMs) || !Number.isFinite(input.nowMs)) return false;
  const elapsed = input.nowMs - input.lastTickAtMs;
  if (elapsed < 0) return false;
  return elapsed >= interval;
}

export interface CuratorTickDeps {
  spawnDetached: (command: string, args: readonly string[], options: { env: Record<string, string> }) => void;
  binaryExists: (file: string) => boolean;
  now?: () => number;
  log?: (message: string, error?: unknown) => void;
}

/** Process-local memory of the last spawn. Not persisted: a nudge is not state. */
let lastTickAtMs: number | undefined;

/** Guards against a second timer when both bootstrap completion paths report in. */
let curatorTickTimerStarted = false;

/** TEST-ONLY: forget the last spawn so a suite can drive the decision fresh. */
export function __resetCuratorTickForTests(): void {
  lastTickAtMs = undefined;
  curatorTickTimerStarted = false;
}

/**
 * Spawn one curator pass for the ACTIVE seat, or decline and say why.
 *
 * Never throws and never blocks: a missing binary, a broken venv or a non-zero
 * exit is a debug line. The tick is a convenience, and an app start must not be
 * delayed or broken by one.
 *
 * `HERMES_HOME` is taken from the caller's already seat-aware path set
 * (`runtimeBootstrapCore` resolves it per seat), never assembled here — a second
 * place that composes seat homes is a second place that can get the seat wrong.
 */
export function runCuratorTick(paths: CuratorTickPaths, deps: CuratorTickDeps): boolean {
  const now = (deps.now ?? Date.now)();
  const binary = curatorTickBinary(paths);
  let binaryPresent = false;
  try {
    binaryPresent = deps.binaryExists(binary);
  } catch {
    binaryPresent = false;
  }
  if (!shouldRunCuratorTick({ nowMs: now, lastTickAtMs, binaryPresent })) return false;
  try {
    deps.spawnDetached(binary, CURATOR_TICK_ARGS, { env: { HERMES_HOME: paths.hermesHome } });
    lastTickAtMs = now;
    return true;
  } catch (error) {
    deps.log?.('[Command EVE] curator tick could not be spawned', error);
    return false;
  }
}

/**
 * Start the tick: once now, then on a slow interval while the process lives.
 *
 * IDEMPOTENT BY DESIGN. The boot bootstrap reports completion from two different
 * branches (awaited and deferred), and both should be able to say "runtime is
 * ready" without either having to know whether the other already did. A second
 * call is a no-op rather than a second timer.
 *
 * The interval is `unref`'d for the same reason the online-reverify timer is
 * (`commandEveBridge.ts:5040`): a convenience tick must never be the thing that
 * keeps the app alive.
 */
export function startCuratorTickTimer(paths: CuratorTickPaths, deps: CuratorTickDeps): boolean {
  if (curatorTickTimerStarted) return false;
  curatorTickTimerStarted = true;
  runCuratorTick(paths, deps);
  const timer = setInterval(() => {
    runCuratorTick(paths, deps);
  }, CURATOR_TICK_INTERVAL_MS);
  if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref();
  return true;
}
