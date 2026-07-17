/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE — CLI-Keystone worker-assignment PRODUCER (PURE).
 *
 * THE agent_id PRODUCER HOLE this closes (seam proven 2026-06-30, both CLIs):
 *
 *   - {@link WorkerAssignmentCard} was a NO-OP stub: it invented an agent_id
 *     ('claude-code' | 'codex') with NO Hermes counterpart and persisted nothing.
 *   - EVE's REAL roster ids ({@link EVE_TEAM_ROSTER}: ceo / growth-lead / …) are
 *     BILLING/ledger keys that map to EVE-Inference TIERS — they are NOT runnable
 *     CLI handles. Two unjoined namespaces.
 *   - Hermes routes GLOBALLY (one delegation.provider/model) with NO per-worker
 *     registry in the bundled wheel. Command EVE's security-backported wheel
 *     intentionally exposes NO model-controlled ACP command/argv fields: Desktop
 *     selects the fixed `copilot-acp` provider and supplies its transport through
 *     trusted process environment only.
 *
 * This module is the JOIN. It is the dependency-light, framework-free brain that:
 *   1. turns a (role → CLI worker) choice into a PERSISTED worker record (so the
 *      card is no longer a no-op — see {@link buildWorkerAssignment});
 *   2. TRANSLATES that record into the Hermes routing the runtime actually
 *      consumes — the transports the seam proved (see {@link resolveWorkerRouting}):
 *        • CLAUDE → a per-task DELEGATE worker (the LIVE transport): resolve the
 *          `@agentclientprotocol/claude-agent-acp` adapter (bunx or a resolved
 *          bin) and its args, then bind the wrapped launcher tuple to
 *          Desktop-owned `HERMES_COPILOT_ACP_*` process env. Hermes uses the fixed
 *          "copilot-acp" provider (generic ACP); UX label "Claude" (NOT
 *          "Copilot"). Auth = the machine-local `claude` login. SOUL receives
 *          only a role/capability hint, never transport data.
 *        • CODEX  → DEFERRED, honestly (audit 2026-07-01). The seam idea was a
 *          RUNTIME-MODE toggle (`model.openai_runtime=codex_app_server`), but the
 *          bundled wheel ONLY honors that key for `provider in {openai,
 *          openai-codex}` (FACT hermes_cli/runtime_provider.py
 *          _maybe_apply_codex_app_server_runtime:297). EVE runs `provider: custom`
 *          (loopback shim -> eve-inference cloud lane), so the key is INERT —
 *          emitting it is a silent no-op. The only working Codex delegate path
 *          (`delegation.provider: openai-codex`) needs a local @openai/codex /
 *          ChatGPT login EVE does not provision and would route delegated work OFF
 *          the EVE billing lane (FACT hermes_cli/auth.py
 *          resolve_codex_runtime_credentials:3760). So Codex is DEFERRED: the
 *          producer emits NO `openai_runtime` key (no dead config) and the card
 *          shows Codex as "bald verfügbar / not yet". See {@link CODEX_DEFER_REASON}.
 *   3. JOINS the desktop assignment to the roster + the dispatch gate
 *      ({@link evaluateWorkerDispatch}) so a chosen worker resolves to its
 *      routing tuple AND is status-gated (active / paused / off) — see
 *      {@link resolveDispatchableWorkerRouting}.
 *
 * NOT in scope (founder-confirmed buildable-now subset (A)): the larger Hermes
 * `delegation.workers[]` registry (true simultaneous multi-CLI workers) does NOT
 * exist in the wheel and is the LARGER lift. And the IMAGE role is NOT a CLI-ACP
 * worker — it routes to the Hermes image_gen + gentmp OpenRouter proxy (a
 * tool/tier route); {@link resolveWorkerRouting} returns that explicitly so a
 * caller can never force an image worker through the ACP seam.
 *
 * PURE: no React, no IPC, no fs. The renderer persists the record through the
 * existing config service; the bootstrapper reads {@link codexRuntimeForConfig}
 * to decide the `openai_runtime` line; the main process reads
 * {@link resolveDispatchableWorkerRouting} to bind a wrapped Claude delegate to
 * trusted runtime env. The unit tests share these exact rules.
 */

import {
  EVE_SYSTEM_AGENT_ID,
  EVE_TEAM_ROSTER,
  findEveTeamRole,
  isEveTeamAgentId,
  type EveTeamRole,
} from './eveTeamRoster';
import {
  evaluateWorkerDispatch,
  statusForRole,
  type EveTeamWorkerStatusMap,
  type WorkerDispatchDecision,
} from './eveTeamControlsCore';

/**
 * The KIND of external runnable a roster role is bound to. This is the runtime
 * namespace — distinct from the role's billing tier.
 *   - 'claude' : a per-task ACP delegate worker via the claude-agent-acp adapter
 *                (the LIVE transport).
 *   - 'codex'  : DEFERRED on the EVE custom-provider cloud build (see the module
 *                header + {@link CODEX_DEFER_REASON}). The kind is still accepted
 *                so an existing/forward assignment persists, but it resolves to a
 *                deferred routing that emits NO Hermes config (no dead key).
 *   - 'image'  : NOT a CLI worker — the Hermes image_gen + gentmp proxy route.
 */
export type EveWorkerKind = 'claude' | 'codex' | 'image';

/** The minimum codex-cli version whose `app-server` runtime mode Hermes supports (kept for the card/version display). */
export const CODEX_APP_SERVER_MIN_VERSION = '0.125.0';

/** The Hermes `model.openai_runtime` value that WOULD switch the main turn to codex app-server (NOT emitted on EVE — see CODEX_DEFER_REASON). */
export const CODEX_APP_SERVER_RUNTIME = 'codex_app_server';

/**
 * Why Codex is deferred on the shipped EVE build (the honest, audit-confirmed
 * reason the card shows). EVE runs `model.provider: custom` (the loopback shim →
 * eve-inference cloud lane); the bundled wheel only honors
 * `model.openai_runtime=codex_app_server` for `provider in {openai, openai-codex}`
 * (FACT runtime_provider.py:297), so emitting it on `custom` is a silent no-op,
 * and the only working delegate path (`delegation.provider: openai-codex`) needs a
 * local @openai/codex login EVE doesn't provision and would bill OFF the EVE lane.
 * Until a clean delegate path exists, Codex stays "bald verfügbar".
 */
export const CODEX_DEFER_REASON = 'eve-custom-provider-no-codex-app-server-rewrite' as const;

/** The exact Claude ACP adapter version also embedded in AionCore managed resources. */
export const CLAUDE_ACP_ADAPTER_VERSION = '0.39.0' as const;
/** Exact dev-only bunx target. Packaged builds resolve the embedded adapter instead. */
export const CLAUDE_ACP_ADAPTER_PACKAGE =
  `@agentclientprotocol/claude-agent-acp@${CLAUDE_ACP_ADAPTER_VERSION}` as const;

/**
 * The fixed Hermes delegate provider for Command EVE's external ACP worker. It
 * is the GENERIC ACP client, only Copilot-NAMED. Desktop points its trusted
 * process env at the Claude adapter; the UX label is fixed to "Claude" so the
 * operator never sees "Copilot".
 */
export const ACP_DELEGATE_PROVIDER = 'copilot-acp';

/** Immutable production route for every Claude-seat worker (Claude, Opus, Fable). */
export const CLAUDE_SEAT_BILLING_LANE = 'seat' as const;
export const CLAUDE_SEAT_RUNTIME_ROUTE = 'claude_cli_acp' as const;
export const CLAUDE_SEAT_FALLBACK_POLICY = 'none' as const;

/**
 * A PERSISTED worker assignment — the record the (formerly no-op) card now
 * writes. The KEY is the roster `agent_id` (the namespace JOIN: a runnable CLI is
 * bound to a real EVE role, not an invented id). `cli_path` is an OPTIONAL
 * operator-supplied absolute path to the CLI; when absent the routing falls back
 * to the documented launcher (bunx for Claude, `codex` on PATH for Codex).
 */
export interface EveWorkerAssignment {
  /** The roster role this CLI worker is bound to (the JOIN key). Never an invented id. */
  agent_id: string;
  /** Which runnable kind the role is bound to. */
  kind: EveWorkerKind;
  /** Optional operator-supplied absolute path to the CLI binary. */
  cli_path?: string;
  /**
   * The detected CLI version, if the operator's environment reported one (e.g.
   * "0.134.0" for codex). Drives the codex runtime-mode version gate. Optional:
   * absent => the gate treats the version as unknown (codex stays OFF, honestly).
   */
  cli_version?: string;
}

/** The persisted map of roster agent_id → assignment. Absent ids = no CLI worker bound. */
export type EveWorkerAssignmentMap = Readonly<Record<string, EveWorkerAssignment>>;

/**
 * The routing tuple the runtime actually consumes for one worker. Exactly ONE of
 * the transport shapes is populated, keyed off {@link EveWorkerKind}:
 *   - kind 'claude': { acpCommand, acpArgs, provider, label } — the per-task
 *                    delegate tuple (the LIVE transport).
 *   - kind 'codex' : { codexDeferred: true, codexDeferReason } — NO runtime is
 *                    emitted (see CODEX_DEFER_REASON). NEVER carries a runtime key.
 *   - kind 'image' : { imageRoute: true } — routes to image_gen/gentmp, NOT ACP.
 */
export interface EveWorkerRouting {
  agent_id: string;
  kind: EveWorkerKind;
  /** User-facing label. Always "Claude" for the claude adapter (never "Copilot"). */
  label: string;
  /**
   * CODEX: true — Codex is DEFERRED on this build and emits NO Hermes runtime.
   * The field exists so a caller can NEVER read a (now non-existent) codexRuntime
   * by accident; the consumability test asserts no codex routing reaches config.
   */
  codexDeferred?: true;
  /** CODEX: the honest defer reason ({@link CODEX_DEFER_REASON}); for the card copy + tests. */
  codexDeferReason?: typeof CODEX_DEFER_REASON;
  /** CLAUDE: the ACP adapter command (dev fallback `bunx`; packaged builds replace it with bundled Node). */
  acpCommand?: string;
  /** CLAUDE: ACP adapter args (the exact package target for the dev fallback). */
  acpArgs?: string[];
  /** CLAUDE: the forced generic-ACP provider ("copilot-acp"). */
  provider?: typeof ACP_DELEGATE_PROVIDER;
  /** CLAUDE: operator subscription billing only; never EVE credits/app metering. */
  billingLane?: typeof CLAUDE_SEAT_BILLING_LANE;
  /** CLAUDE: the only allowed runtime route for Claude/Opus/Fable seat work. */
  runtimeRoute?: typeof CLAUDE_SEAT_RUNTIME_ROUTE;
  /** CLAUDE: a failed seat launch never falls back to EVE Inference/OpenRouter. */
  fallbackPolicy?: typeof CLAUDE_SEAT_FALLBACK_POLICY;
  /** IMAGE: true iff this worker routes to the Hermes image_gen + gentmp proxy (NOT the ACP seam). */
  imageRoute?: true;
}

const compact = (value: unknown): string => String(value ?? '').trim();

/** POSIX/Windows absolute-path sanity (the card's client-side check, shared here). */
export function looksLikeAbsolutePath(raw: string | null | undefined): boolean {
  const value = compact(raw);
  if (!value) return false;
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Parse a "major.minor.patch[-...]" version into a comparable numeric triple, or
 * null when it is not a recognizable semver-ish string. Dependency-light (no
 * semver import) so this core stays trivially unit-testable in plain Node.
 */
function parseVersionTriple(version: string | null | undefined): [number, number, number] | null {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(compact(version));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? '0')];
}

/** True iff `version` >= `min` (both "x.y.z"-ish). Unknown/garbage version => false (fail-closed). */
export function versionGte(version: string | null | undefined, min: string): boolean {
  const a = parseVersionTriple(version);
  const b = parseVersionTriple(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true; // equal
}

/**
 * Build a PERSISTABLE worker assignment from a (role, kind) choice + the
 * operator's optional CLI path/version. Returns null when the inputs are not a
 * valid, JOINABLE assignment — the card must NOT persist garbage:
 *   - the agent_id MUST be a known roster role (the namespace JOIN; an invented
 *     id like the old stub's 'claude-code' is rejected, as is the reserved `eve`);
 *   - a supplied cli_path MUST look like an absolute path.
 * This is the single rule the (formerly no-op) card calls to produce the record.
 */
export function buildWorkerAssignment(input: {
  agent_id: string | null | undefined;
  kind: EveWorkerKind;
  cli_path?: string | null;
  cli_version?: string | null;
}): EveWorkerAssignment | null {
  const agentId = compact(input.agent_id);
  if (!isEveTeamAgentId(agentId) || agentId === EVE_SYSTEM_AGENT_ID) return null;
  if (input.kind !== 'claude' && input.kind !== 'codex' && input.kind !== 'image') return null;
  const cliPath = compact(input.cli_path);
  if (cliPath && !looksLikeAbsolutePath(cliPath)) return null;
  const assignment: EveWorkerAssignment = { agent_id: agentId, kind: input.kind };
  if (cliPath) assignment.cli_path = cliPath;
  const version = compact(input.cli_version);
  if (version) assignment.cli_version = version;
  return assignment;
}

/** The display label for a worker kind (Claude adapter is "Claude", never "Copilot"). */
export function workerKindLabel(kind: EveWorkerKind, role?: EveTeamRole): string {
  const base = kind === 'claude' ? 'Claude' : kind === 'codex' ? 'Codex' : 'Bildgenerator';
  return role ? `${role.displayName} · ${base}` : base;
}

/**
 * TRANSLATE a persisted assignment into the routing tuple the runtime consumes.
 * Pure — no IO. The three transports, exactly as the seam proved:
 *
 *   - CLAUDE : per-task delegate (LIVE). The pure routing tuple uses an exact
 *     versioned `bunx` target for development. The main process replaces this with
 *     the signed, bundled Node + ACP entrypoint in packaged builds. `cli_path` is
 *     retained only as legacy assignment metadata and is never executed as ACP: a
 *     raw Claude CLI does not implement the ACP stdio contract.
 *   - CODEX  : DEFERRED — codexDeferred true, NO runtime key (see CODEX_DEFER_REASON).
 *   - IMAGE  : imageRoute true — routes to image_gen/gentmp, never the ACP seam.
 */
export function resolveWorkerRouting(assignment: EveWorkerAssignment): EveWorkerRouting {
  const role = findEveTeamRole(assignment.agent_id);
  const label = workerKindLabel(assignment.kind, role);
  const base: EveWorkerRouting = { agent_id: assignment.agent_id, kind: assignment.kind, label };

  if (assignment.kind === 'image') {
    // Image-creator role = the Hermes image_gen + gentmp OpenRouter proxy route,
    // a tool/tier route — explicitly NOT the ACP seam.
    return { ...base, imageRoute: true };
  }

  if (assignment.kind === 'codex') {
    // DEFERRED on the EVE custom-provider cloud build: emit NO runtime (the wheel
    // ignores model.openai_runtime when provider=custom — a silent no-op). Honest,
    // not faked: the card surfaces this as "bald verfügbar".
    return { ...base, codexDeferred: true, codexDeferReason: CODEX_DEFER_REASON };
  }

  // CLAUDE — per-task ACP delegate. Never execute assignment.cli_path directly:
  // the value historically points at `claude`, which is not an ACP adapter.
  return {
    ...base,
    acpCommand: 'bunx',
    acpArgs: [CLAUDE_ACP_ADAPTER_PACKAGE],
    provider: ACP_DELEGATE_PROVIDER,
    billingLane: CLAUDE_SEAT_BILLING_LANE,
    runtimeRoute: CLAUDE_SEAT_RUNTIME_ROUTE,
    fallbackPolicy: CLAUDE_SEAT_FALLBACK_POLICY,
  };
}

/**
 * The `model.openai_runtime` value the bootstrapper should emit, given the FULL
 * assignment map.
 *
 * DEFERRED (audit 2026-07-01): this ALWAYS returns '' now. Codex-app-server is a
 * dead key on EVE's `provider: custom` build — the bundled wheel only rewrites
 * api_mode for `provider in {openai, openai-codex}` (FACT runtime_provider.py
 * _maybe_apply_codex_app_server_runtime:297), so emitting it would be a SILENT
 * no-op (the exact "assign Codex does nothing" defect). The producer therefore
 * emits NO routing for Codex until a clean delegate path exists. Kept as a
 * function (not deleted) so the bootstrap wiring + the consumability test have a
 * single, honest source of truth that Codex contributes ZERO config.
 *
 * @returns always '' — Codex is deferred, no key emitted (see CODEX_DEFER_REASON).
 */
export function codexRuntimeForConfig(_assignments: EveWorkerAssignmentMap): string {
  return '';
}

/**
 * The resolved Claude delegate the bootstrap should make EVE aware of (the LIVE
 * half of the keystone). Given the FULL assignment map + the live worker-status
 * map, returns the FIRST assigned Claude worker that is BOTH bound and
 * status-allowed (dispatch gate), with its resolved ACP adapter command/args —
 * or null when none is dispatchable.
 *
 * This is what makes Claude actually FIRE: the main process wraps this tuple in
 * the platform launcher and binds it to Desktop-owned `HERMES_COPILOT_ACP_*`
 * process env. The bootstrap selects the fixed `copilot-acp` provider and emits
 * only a role/capability hint into SOUL; the model can neither see nor override
 * command/argv. Without the trusted env binding the fixed provider has no
 * runnable transport and delegation fails closed.
 *
 * SECURITY: reuses {@link resolveDispatchableWorkerRouting}, so a paused/off
 * Claude worker yields null. Binding a transport is NOT a grant to run — the
 * human-gate/permission path still applies before any spawn.
 */
export interface ResolvedClaudeDelegate {
  agent_id: string;
  label: string;
  acpCommand: string;
  acpArgs: string[];
  provider: typeof ACP_DELEGATE_PROVIDER;
  billingLane: typeof CLAUDE_SEAT_BILLING_LANE;
  runtimeRoute: typeof CLAUDE_SEAT_RUNTIME_ROUTE;
  fallbackPolicy: typeof CLAUDE_SEAT_FALLBACK_POLICY;
}

/** Runtime guard for the trusted Claude CLI/ACP seat lane. Unknown/missing fields fail closed. */
export function isClaudeSeatDelegateRoute(value: unknown): value is ResolvedClaudeDelegate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ResolvedClaudeDelegate>;
  return (
    compact(candidate.agent_id).length > 0 &&
    compact(candidate.label).length > 0 &&
    compact(candidate.acpCommand).length > 0 &&
    Array.isArray(candidate.acpArgs) &&
    candidate.acpArgs.length > 0 &&
    candidate.acpArgs.every((arg) => typeof arg === 'string' && arg.trim().length > 0) &&
    candidate.provider === ACP_DELEGATE_PROVIDER &&
    candidate.billingLane === CLAUDE_SEAT_BILLING_LANE &&
    candidate.runtimeRoute === CLAUDE_SEAT_RUNTIME_ROUTE &&
    candidate.fallbackPolicy === CLAUDE_SEAT_FALLBACK_POLICY
  );
}

export function resolveAssignedClaudeDelegate(
  assignments: EveWorkerAssignmentMap,
  statuses: EveTeamWorkerStatusMap
): ResolvedClaudeDelegate | null {
  for (const [agentId, assignment] of Object.entries(assignments)) {
    if (assignment.kind !== 'claude') continue;
    const decision = resolveDispatchableWorkerRouting(agentId, assignments, statuses);
    if (!decision.allowed || !decision.routing) continue;
    const r = decision.routing;
    if (!r.acpCommand || !r.provider) continue;
    const delegate = {
      agent_id: r.agent_id,
      label: r.label,
      acpCommand: r.acpCommand,
      acpArgs: r.acpArgs ?? [],
      provider: r.provider,
      billingLane: r.billingLane,
      runtimeRoute: r.runtimeRoute,
      fallbackPolicy: r.fallbackPolicy,
    };
    if (isClaudeSeatDelegateRoute(delegate)) return delegate;
  }
  return null;
}

/**
 * CLI-Keystone CLAUDE PREFLIGHT (MUST-FIX 4). When a Claude delegate is wired but
 * its launcher is NOT resolvable on this machine, the operator should SEE a
 * warning rather than discover it only when a delegation silently fails (the
 * founder-self-detection standard).
 *
 * PURE: it does not probe the filesystem — the caller passes a `resolvable`
 * predicate (the bootstrap supplies a `which`-style probe via its runner). Two
 * cases:
 *   - a managed transport command: warn if that command is not resolvable.
 *   - the development-only `bunx` launcher: warn if `bunx` is not on PATH (then
 *     the adapter cannot be fetched). Acceptable to only WARN — the
 *     founder-as-operator-#1 box may not have bun yet; this is a
 *     pre-BYOK/multi-operator guard, not a gate.
 *
 * Returns a human-facing warning string, or '' when the launcher resolves (or no
 * Claude delegate is wired). NEVER throws.
 */
export function claudeDelegatePreflightWarning(
  // Structural: accepts the resolved delegate OR the looser bootstrap-option shape
  // (provider typed as string). Only acpCommand + label are read here.
  delegate: { label: string; acpCommand: string } | null | undefined,
  resolvable: (command: string) => boolean
): string {
  if (!delegate) return '';
  const command = compact(delegate.acpCommand);
  if (!command) return '';
  try {
    if (resolvable(command)) return '';
  } catch {
    // A failing probe is treated as "unknown" -> warn (fail-visible, not silent).
  }
  if (command === 'bunx') {
    return (
      `Claude-Worker (${delegate.label}) zugewiesen, aber \`bunx\` ist auf diesem Rechner nicht auffindbar — ` +
      `der Claude-ACP-Adapter (${CLAUDE_ACP_ADAPTER_PACKAGE}) kann ohne bun nicht gestartet werden. ` +
      `Installiere bun (oder hinterlege im Worker einen absoluten Pfad zur Claude-CLI), sonst läuft eine Delegation ins Leere.`
    );
  }
  return (
    `Claude-Worker (${delegate.label}) zugewiesen, aber die angegebene CLI \`${command}\` ist nicht auffindbar/ausführbar — ` +
    `eine Delegation würde fehlschlagen. Prüfe den Pfad oder lass ihn leer (Standard-Launcher bunx).`
  );
}

/** The decision of resolving a worker for dispatch: its routing PLUS the status gate. */
export interface DispatchableWorkerDecision {
  /** True iff the worker is both assigned AND its roster status allows dispatch. */
  allowed: boolean;
  /** The status-gate decision (the existing {@link evaluateWorkerDispatch} rule). */
  gate: WorkerDispatchDecision;
  /** The routing tuple — present only when an assignment exists for the id. */
  routing?: EveWorkerRouting;
  /** Stable reason code (UI copy + tests key off this). */
  reason:
    | 'ok-dispatchable' //     assigned worker, status active -> routing returned
    | 'blocked-by-status' //   assigned worker, but paused/off (gate blocked it)
    | 'no-assignment'; //      no CLI worker bound to this id (nothing to dispatch)
}

/**
 * The NAMESPACE JOIN + the GATE in one call. Resolve a chosen worker (by roster
 * agent_id) to its routing tuple, but ONLY when the existing dispatch gate
 * ({@link evaluateWorkerDispatch}) allows it. This is the single rule the
 * execution/send-path reads so:
 *   - a paused/off worker is NEVER dispatched (the gate stays authoritative — the
 *     CLI seam reuses the SAME permission/status path, it does not bypass it);
 *   - a worker with no assignment yields no routing (nothing to run).
 *
 * SECURITY: this returns routing ONLY for an allowed, assigned worker. A caller
 * must still apply the human-gate/permission path before actually spawning the
 * CLI (terminal/YOLO = auto-run shell); resolving routing is NOT a grant to run.
 */
export function resolveDispatchableWorkerRouting(
  agentId: string | null | undefined,
  assignments: EveWorkerAssignmentMap,
  statuses: EveTeamWorkerStatusMap
): DispatchableWorkerDecision {
  const gate = evaluateWorkerDispatch(agentId, statuses);
  const id = compact(agentId);
  const assignment = id ? assignments[id] : undefined;

  if (!gate.allowed) {
    return { allowed: false, gate, reason: 'blocked-by-status' };
  }
  if (!assignment) {
    // Allowed by status, but no CLI worker is bound -> nothing to dispatch via
    // the seam (EVE answers on its normal lane). Not an error.
    return { allowed: false, gate, reason: 'no-assignment' };
  }
  return { allowed: true, gate, routing: resolveWorkerRouting(assignment), reason: 'ok-dispatchable' };
}

/** One roster line for the SOUL team directive (1.6.3 Team-Realität). */
export interface EveTeamDirectiveRole {
  display_name: string;
  /** Plain-German outcome the role owns (roster constant). */
  outcome: string;
  /** Live status at resolve time: active | paused | off. */
  status: string;
  /** Brand-neutral EVE label for an assigned specialist, or null = EVE runtime. */
  worker: string | null;
}

/**
 * 1.6.3 (Team-Realität Schritt 2) — build the roster lines the SOUL team
 * directive emits, from the SAME inputs the delegate resolver reads
 * (`commandEve.workerAssignments` + `commandEve.teamWorkerStatus`). Pure and
 * deterministic (roster order), so the bootstrap stays byte-stable for a given
 * settings state. Codex is labelled honestly as deferred — the runtime cannot
 * dispatch it yet, and EVE must not believe otherwise.
 */
export function buildTeamDirectiveRoles(
  assignments: EveWorkerAssignmentMap,
  statuses: EveTeamWorkerStatusMap,
  roster: readonly EveTeamRole[] = EVE_TEAM_ROSTER
): EveTeamDirectiveRole[] {
  // Review fix (SOUL consistency): the routing directive carries exactly ONE
  // dispatchable Claude delegate (resolveAssignedClaudeDelegate, first match) —
  // so only THAT role may claim a plainly routed specialist. Transport brands
  // stay internal; the operator and EVE's team model only see Command EVE roles.
  const routedClaudeId = resolveAssignedClaudeDelegate(assignments, statuses)?.agent_id ?? null;
  return roster.map((role) => {
    const assignment = assignments[role.agent_id];
    const worker =
      assignment?.kind === 'claude'
        ? role.agent_id === routedClaudeId
          ? 'EVE-Spezialist'
          : 'EVE-Spezialist (zugewiesen, noch nicht aktiv)'
        : assignment?.kind === 'codex'
          ? 'EVE-Spezialist (noch nicht verfuegbar)'
          : null;
    return {
      display_name: role.displayName,
      outcome: role.outcome,
      status: statusForRole(role, statuses),
      worker,
    };
  });
}
