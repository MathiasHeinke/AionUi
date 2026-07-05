/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE HONCHO BOOTSTRAP core (1.7.0 / COMPA-624 Inc.3 / O1 — the testable
 * provisioning ORCHESTRATION brain).
 *
 * This is the fail-safe sequencing that the thin runtimeBootstrapCore splice
 * drives: given the P1 plan + the Inc.1 config + an INJECTED command set +
 * injected runner/spawner/probes, it executes the not-yet-satisfied provisioning
 * steps IN ORDER, stops the chain the instant a prerequisite step does not
 * complete, probes /health + the deriver, reduces the readiness (P2) and writes it
 * (P6). The exact system command STRINGS (brew / pg_ctl / honcho serve) are
 * injected — verified on a real machine at wiring time — so THIS module tests the
 * invariants that must never regress, independent of the exact commands:
 *
 *   - EVERY miss is 'skip' — never 'blocked'/'failed' — so a Honcho failure can not
 *     flip the runtime-bootstrap receipt off 'ready' or block first value.
 *   - A prerequisite failure STOPS the chain (remaining steps skip) and ends
 *     not-ready; Honcho falls back to Company Brain + MEMORY.md.
 *   - readiness is ALWAYS written (even on disable/failure), carries the seat +
 *     branch, and is 'ready' ONLY when BOTH probes pass (P2's two-fact rule).
 *   - No throw escapes (a spawner/probe/writer error degrades to not-ready).
 */

import type { RuntimeBootstrapRunner, RuntimeBootstrapDetachedSpawner } from './runtimeBootstrapCore';
import {
  HONCHO_REASON_MODE_OFF,
  HONCHO_STEP_PROCESS,
  HONCHO_STEP_READY,
  type HonchoProvisionPlan,
} from './honchoProvisionPlanCore';
import {
  HONCHO_REASON_DECLINED,
  HONCHO_REASON_DEP_MISSING,
  HONCHO_REASON_DERIVER_UNREACHABLE,
  HONCHO_REASON_PROBE_TIMEOUT,
  HONCHO_REASON_PROCESS_DOWN,
  HONCHO_STATE_OFF,
  reduceHonchoReadiness,
  type HonchoReadinessState,
} from './honchoReadinessCore';
import type { HonchoRuntimeConfig } from './honchoRuntimeConfigCore';

/** An injected shell command for one provisioning step. `spawn` ⇒ detached (server). */
export interface HonchoShellCommand {
  command?: string;
  args?: string[];
  timeoutMs?: number;
  /**
   * Per-step env OVERLAY, merged over deps.env for THIS step only (e.g. the honcho
   * serve process carries the deriver LLM base_url/model so it derives against the
   * LOCAL Ollama). Never a secret — the local deriver key is an Ollama placeholder.
   */
  env?: NodeJS.ProcessEnv;
}

/** The exact commands per step id (HONCHO_STEP_*), verified on the live machine. */
export type HonchoCommandSet = Record<string, HonchoShellCommand | undefined>;

/** A Honcho bootstrap stage (id is a plain string; the splice maps it into the receipt). */
export interface HonchoBootstrapStage {
  id?: string;
  /** ALWAYS 'pass' or 'skip' here — never 'blocked'/'failed' (source-pinned invariant). */
  status?: string;
  code?: string;
  detail?: string;
  command?: string;
  duration_ms?: number;
}

export interface HonchoBootstrapDeps {
  plan: HonchoProvisionPlan;
  config: HonchoRuntimeConfig;
  commands: HonchoCommandSet;
  runner: RuntimeBootstrapRunner;
  detachedSpawner: RuntimeBootstrapDetachedSpawner;
  /** Probe the local Honcho /health (true when it answered on loopback). */
  probeServer: () => Promise<boolean>;
  /** Probe the deriver reachability (local warm / cloud shim reachable + licensed). */
  probeDeriver: () => Promise<boolean>;
  /** The P6 bridge writer (best-effort — a write error must not throw the bootstrap). */
  writeReadiness: (honchoHome: string, state: HonchoReadinessState) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  defaultTimeoutMs?: number;
}

export interface HonchoBootstrapResult {
  stages: HonchoBootstrapStage[];
  readiness: HonchoReadinessState;
  honchoEnabled: boolean;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function safeProbe(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await probe()) === true;
  } catch {
    return false; // a throwing probe is NOT reachable — fail-safe to not-ready
  }
}

/**
 * Run the Honcho provisioning chain. Pure control flow over injected I/O; never
 * throws. Returns the stages (each pass/skip), the reduced readiness (also written
 * via the P6 bridge), and whether the plan enabled Honcho at all.
 */
export async function runHonchoBootstrap(deps: HonchoBootstrapDeps): Promise<HonchoBootstrapResult> {
  const plan: HonchoProvisionPlan = (deps && deps.plan) || {};
  const config: HonchoRuntimeConfig = (deps && deps.config) || {};
  const branch = config.deriver ? config.deriver.branch : undefined;
  const seatId = config.seatId;
  const stages: HonchoBootstrapStage[] = [];

  const finalize = (readiness: HonchoReadinessState): HonchoBootstrapResult => {
    try {
      if (config.honchoHome && deps && typeof deps.writeReadiness === 'function') {
        deps.writeReadiness(config.honchoHome, readiness);
      }
    } catch {
      /* best-effort: a readiness-write failure must never throw the bootstrap. */
    }
    return { stages, readiness, honchoEnabled: plan.honchoEnabled === true };
  };

  try {
    const nowMs = (): number => (deps && typeof deps.now === 'function' ? deps.now() : Date.now());

    // (0) A config with no on-disk home can not be provisioned OR persisted — a
    // clean not-ready (Codex #2), rather than a silent no-write that could leave a
    // prior ready snapshot visible.
    if (!config.honchoHome) {
      stages.push({ id: 'honcho-provision', status: 'skip', code: HONCHO_REASON_DEP_MISSING, detail: 'no per-seat honcho home in the config' });
      return { stages, readiness: reduceHonchoReadiness({ provisioned: false, seatId, branch, now: nowMs() }), honchoEnabled: false };
    }

    // (1) The plan disabled Honcho ⇒ one skip stage + an off/declined readiness.
    if (plan.honchoEnabled !== true) {
      const reason = plan.skipReason || HONCHO_REASON_DEP_MISSING;
      stages.push({ id: 'honcho-provision', status: 'skip', code: reason, detail: 'Local memory is off — using Company Brain + MEMORY.md.' });
      const declined = reason === HONCHO_REASON_DECLINED || reason === HONCHO_REASON_MODE_OFF;
      return finalize(reduceHonchoReadiness({ provisioned: false, declined, seatId, branch, now: nowMs() }));
    }

    // (2) Execute the ordered steps. A real step's failure stops the chain.
    let ok = true;
    let serverStarted = false;
    for (const planStep of plan.steps || []) {
      const id = planStep.id || 'honcho-step';
      if (id === HONCHO_STEP_READY) continue; // the probe is handled once, after the loop
      // Chain-stop BEFORE any per-step handling (Codex #4): once a prerequisite
      // failed, EVERY remaining step skips — including already-satisfied ones.
      if (!ok) {
        stages.push({ id, status: 'skip', code: HONCHO_REASON_DEP_MISSING, detail: 'skipped (a prerequisite step did not complete)' });
        continue;
      }
      if (planStep.alreadySatisfied === true) {
        stages.push({ id, status: 'pass', detail: 'already present' });
        continue;
      }
      const cmd = deps.commands ? deps.commands[id] : undefined;
      if (!cmd || !cmd.command) {
        stages.push({ id, status: 'skip', code: HONCHO_REASON_DEP_MISSING, detail: 'no command provided for this step' });
        ok = false;
        continue;
      }
      const started = nowMs();
      if (id === HONCHO_STEP_PROCESS) {
        // The long-running server — detached spawn, no result to await.
        try {
          deps.detachedSpawner(cmd.command, cmd.args || [], { env: { ...deps.env, ...(cmd.env || {}) } });
          serverStarted = true;
          stages.push({ id, status: 'pass', detail: 'honcho serve started', command: cmd.command, duration_ms: nowMs() - started });
        } catch (error) {
          stages.push({ id, status: 'skip', code: HONCHO_REASON_PROCESS_DOWN, detail: `serve failed: ${errText(error)}`, command: cmd.command });
          ok = false;
        }
        continue;
      }
      // A one-shot install/provision step. Sequential BY DESIGN — each step depends
      // on the prior (postgres before pgvector before createdb before serve), so the
      // await-in-loop is intentional, not a missed parallelization.
      let res;
      try {
        // eslint-disable-next-line no-await-in-loop -- steps are strictly ordered + dependent
        res = await deps.runner(cmd.command, cmd.args || [], { env: { ...deps.env, ...(cmd.env || {}) }, timeoutMs: cmd.timeoutMs || deps.defaultTimeoutMs || 120000 });
      } catch (error) {
        stages.push({ id, status: 'skip', code: HONCHO_REASON_DEP_MISSING, detail: `runner threw: ${errText(error)}`, command: cmd.command });
        ok = false;
        continue;
      }
      if (res && res.ok) {
        stages.push({ id, status: 'pass', detail: `${id} ok`, command: cmd.command, duration_ms: nowMs() - started });
      } else {
        stages.push({ id, status: 'skip', code: HONCHO_REASON_DEP_MISSING, detail: `${id} did not complete`, command: cmd.command, duration_ms: nowMs() - started });
        ok = false;
      }
    }

    // (3) The readiness probe. Only probe if provisioning completed AND the server
    // was actually started (Codex #1) — an enabled-but-empty/malformed plan that
    // spawned nothing can NEVER read ready off a coincidentally-live loopback.
    if (!ok || !serverStarted) {
      stages.push({ id: HONCHO_STEP_READY, status: 'skip', code: HONCHO_REASON_DEP_MISSING, detail: !serverStarted ? 'honcho server was never started' : 'provisioning did not complete' });
      return finalize(reduceHonchoReadiness({ provisioned: false, seatId, branch, now: nowMs() }));
    }
    const serverOk = await safeProbe(deps.probeServer);
    const deriverOk = await safeProbe(deps.probeDeriver);
    const readyNow = serverOk && deriverOk;
    stages.push({
      id: HONCHO_STEP_READY,
      status: readyNow ? 'pass' : 'skip',
      code: readyNow ? undefined : serverOk ? HONCHO_REASON_DERIVER_UNREACHABLE : HONCHO_REASON_PROBE_TIMEOUT,
      detail: readyNow ? 'Honcho ready (/health + deriver reachable)' : 'Honcho not reachable yet — using Company Brain in the meantime',
    });
    return finalize(
      reduceHonchoReadiness({ provisioned: true, serverProbe: { ok: serverOk }, deriverProbe: { ok: deriverOk }, seatId, branch, now: nowMs() })
    );
  } catch (error) {
    // ULTIMATE fail-safe (Codex #3): NOTHING may throw into the bootstrap loop — a
    // throwing injected dep (now/runner/probe) degrades to a not-ready off result.
    if (!stages.length) {
      stages.push({ id: 'honcho-provision', status: 'skip', code: HONCHO_REASON_PROCESS_DOWN, detail: `bootstrap error: ${errText(error)}` });
    }
    const readiness: HonchoReadinessState = { seatId, branch, state: HONCHO_STATE_OFF, serverUp: false, deriverReachable: false, reasonCode: HONCHO_REASON_PROCESS_DOWN };
    try {
      if (config.honchoHome && deps && typeof deps.writeReadiness === 'function') deps.writeReadiness(config.honchoHome, readiness);
    } catch {
      /* best-effort */
    }
    return { stages, readiness, honchoEnabled: false };
  }
}
