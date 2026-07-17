/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE — CLI-Keystone worker-assignment PRODUCER unit tests (PURE).
 *
 * Pins the four load-bearing keystone rules:
 *
 *  (A) PRODUCER — buildWorkerAssignment turns a (role, kind) choice into a
 *      PERSISTABLE record, JOINED to the roster: an invented id (the old stub's
 *      'claude-code') and the reserved `eve` are rejected; a non-absolute
 *      cli_path is rejected; a known roster id + valid path produces a record.
 *
 *  (B) CODEX is DEFERRED — an assigned Codex resolves to a DEFERRED routing
 *      (codexDeferReason set, codexRuntime omitted) REGARDLESS of version, and
 *      codexRuntimeForConfig ALWAYS returns "" so Codex contributes ZERO config
 *      (the bundled runtime can't consume codex_app_server, so emitting it would
 *      be a silent no-op).
 *
 *  (C) CLAUDE wiring — a Claude worker resolves to acp_command (bunx adapter or
 *      the operator's bin) + acp_args, provider 'copilot-acp', label "Claude"
 *      (NEVER "Copilot").
 *
 *  (D) NAMESPACE JOIN + GATE — resolveDispatchableWorkerRouting returns routing
 *      ONLY for an assigned worker whose roster status allows dispatch; a
 *      paused/off worker is blocked (reusing evaluateWorkerDispatch); an
 *      unassigned id yields no routing. IMAGE routes to the image_gen/gentmp
 *      proxy, never the ACP seam.
 */

import { describe, expect, it } from 'vitest';

import type { EveTeamWorkerStatusMap } from '@/common/config/eveTeamControlsCore';
import {
  ACP_DELEGATE_PROVIDER,
  CLAUDE_ACP_ADAPTER_PACKAGE,
  CLAUDE_SEAT_BILLING_LANE,
  CLAUDE_SEAT_FALLBACK_POLICY,
  CLAUDE_SEAT_RUNTIME_ROUTE,
  CODEX_APP_SERVER_MIN_VERSION,
  CODEX_DEFER_REASON,
  buildWorkerAssignment,
  claudeDelegatePreflightWarning,
  codexRuntimeForConfig,
  isClaudeSeatDelegateRoute,
  looksLikeAbsolutePath,
  resolveAssignedClaudeDelegate,
  resolveDispatchableWorkerRouting,
  resolveWorkerRouting,
  versionGte,
  workerKindLabel,
  type EveWorkerAssignment,
  type EveWorkerAssignmentMap,
  buildTeamDirectiveRoles,
} from '@/common/config/eveWorkerAssignmentCore';

// A real roster id (the namespace JOIN target). 'eval-research' is a curated role.
const ROSTER_ID = 'eval-research';
const CEO_ID = 'ceo';

describe('eveWorkerAssignmentCore — (A) the agent_id PRODUCER', () => {
  it('rejects an invented (non-roster) agent_id — the old stub bug', () => {
    expect(buildWorkerAssignment({ agent_id: 'claude-code', kind: 'claude' })).toBeNull();
    expect(buildWorkerAssignment({ agent_id: 'codex', kind: 'codex' })).toBeNull();
  });

  it('rejects the reserved system id `eve`', () => {
    expect(buildWorkerAssignment({ agent_id: 'eve', kind: 'claude' })).toBeNull();
  });

  it('rejects a non-absolute cli_path', () => {
    expect(buildWorkerAssignment({ agent_id: ROSTER_ID, kind: 'claude', cli_path: 'claude' })).toBeNull();
    expect(buildWorkerAssignment({ agent_id: ROSTER_ID, kind: 'claude', cli_path: '../claude' })).toBeNull();
  });

  it('produces a JOINED record for a known roster id (path optional)', () => {
    const a = buildWorkerAssignment({ agent_id: ROSTER_ID, kind: 'claude' });
    expect(a).toEqual({ agent_id: ROSTER_ID, kind: 'claude' });

    const b = buildWorkerAssignment({
      agent_id: CEO_ID,
      kind: 'codex',
      cli_path: '/usr/local/bin/codex',
      cli_version: '0.134.0',
    });
    expect(b).toEqual({ agent_id: CEO_ID, kind: 'codex', cli_path: '/usr/local/bin/codex', cli_version: '0.134.0' });
  });

  it('rejects an unknown kind', () => {
    // @ts-expect-error — exercising the runtime guard with a bad kind
    expect(buildWorkerAssignment({ agent_id: ROSTER_ID, kind: 'gemini' })).toBeNull();
  });

  it('looksLikeAbsolutePath accepts POSIX + Windows, rejects relative/empty', () => {
    expect(looksLikeAbsolutePath('/usr/local/bin/claude')).toBe(true);
    expect(looksLikeAbsolutePath('C:\\Tools\\codex.exe')).toBe(true);
    expect(looksLikeAbsolutePath('claude')).toBe(false);
    expect(looksLikeAbsolutePath('')).toBe(false);
    expect(looksLikeAbsolutePath(null)).toBe(false);
  });
});

describe('eveWorkerAssignmentCore — version gate', () => {
  it('versionGte compares correctly and fails closed on garbage', () => {
    expect(versionGte('0.134.0', CODEX_APP_SERVER_MIN_VERSION)).toBe(true);
    expect(versionGte('0.125.0', CODEX_APP_SERVER_MIN_VERSION)).toBe(true);
    expect(versionGte('0.124.9', CODEX_APP_SERVER_MIN_VERSION)).toBe(false);
    expect(versionGte('0.99.0', CODEX_APP_SERVER_MIN_VERSION)).toBe(false);
    expect(versionGte('1.0.0', CODEX_APP_SERVER_MIN_VERSION)).toBe(true);
    expect(versionGte(undefined, CODEX_APP_SERVER_MIN_VERSION)).toBe(false);
    expect(versionGte('not-a-version', CODEX_APP_SERVER_MIN_VERSION)).toBe(false);
    expect(versionGte('v0.130', CODEX_APP_SERVER_MIN_VERSION)).toBe(true);
  });
});

describe('eveWorkerAssignmentCore — (B) CODEX is DEFERRED (no dead config) — the consumability wall', () => {
  // Audit 2026-07-01: EVE runs provider:custom; the bundled wheel ONLY honors
  // model.openai_runtime=codex_app_server for provider in {openai, openai-codex}
  // (runtime_provider.py:297), so emitting it would be a silent no-op. Codex is
  // therefore deferred and emits NO routing. These tests are the consumability
  // assertion: a dead/ignored config shape can never pass green again.

  it('a Codex worker resolves to a DEFERRED routing — no runtime, no acp fields', () => {
    const r = resolveWorkerRouting({ agent_id: CEO_ID, kind: 'codex', cli_version: '0.134.0' });
    expect(r.kind).toBe('codex');
    expect(r.codexDeferred).toBe(true);
    expect(r.codexDeferReason).toBe(CODEX_DEFER_REASON);
    // It must NEVER carry a runtime key (that key is dead on provider:custom)…
    expect((r as Record<string, unknown>).codexRuntime).toBeUndefined();
    // …and it is NOT an ACP delegate either.
    expect(r.acpCommand).toBeUndefined();
    expect(r.provider).toBeUndefined();
  });

  it('a Codex worker is deferred REGARDLESS of version (version is no longer a lever)', () => {
    for (const cli_version of [undefined, '0.124.0', '0.134.0', '99.0.0']) {
      const r = resolveWorkerRouting({ agent_id: CEO_ID, kind: 'codex', cli_version });
      expect(r.codexDeferred).toBe(true);
      expect((r as Record<string, unknown>).codexRuntime).toBeUndefined();
    }
  });

  it('codexRuntimeForConfig ALWAYS returns "" — Codex contributes ZERO config (even a "version-OK" one)', () => {
    const none: EveWorkerAssignmentMap = {};
    expect(codexRuntimeForConfig(none)).toBe('');

    // The exact shape that USED to flip the dead key on — now proven inert.
    const wouldHaveBeenOk: EveWorkerAssignmentMap = {
      [ROSTER_ID]: { agent_id: ROSTER_ID, kind: 'claude' },
      [CEO_ID]: { agent_id: CEO_ID, kind: 'codex', cli_version: '0.134.0' },
    };
    expect(codexRuntimeForConfig(wouldHaveBeenOk)).toBe('');

    // Multiple codex assignments, all versions — still no emit.
    const many: EveWorkerAssignmentMap = {
      a: { agent_id: 'ceo', kind: 'codex', cli_version: '1.0.0' },
      b: { agent_id: 'growth-lead', kind: 'codex' },
    };
    expect(codexRuntimeForConfig(many)).toBe('');
  });
});

describe('eveWorkerAssignmentCore — (C) CLAUDE routing (label is "Claude", not "Copilot")', () => {
  it('resolves the bunx adapter command when no cli_path is given', () => {
    const r = resolveWorkerRouting({ agent_id: ROSTER_ID, kind: 'claude' });
    expect(r.acpCommand).toBe('bunx');
    expect(r.acpArgs).toEqual([CLAUDE_ACP_ADAPTER_PACKAGE]);
    expect(r.provider).toBe(ACP_DELEGATE_PROVIDER);
    expect(r.billingLane).toBe(CLAUDE_SEAT_BILLING_LANE);
    expect(r.runtimeRoute).toBe(CLAUDE_SEAT_RUNTIME_ROUTE);
    expect(r.fallbackPolicy).toBe(CLAUDE_SEAT_FALLBACK_POLICY);
    // The forced provider is copilot-NAMED, but the user-facing label must be Claude.
    expect(r.label.toLowerCase()).toContain('claude');
    expect(r.label.toLowerCase()).not.toContain('copilot');
  });

  it('never misroutes a raw operator Claude CLI path as an ACP adapter', () => {
    const r = resolveWorkerRouting({ agent_id: ROSTER_ID, kind: 'claude', cli_path: '/opt/claude/bin/claude' });
    expect(r.acpCommand).toBe('bunx');
    expect(r.acpArgs).toEqual([CLAUDE_ACP_ADAPTER_PACKAGE]);
    expect(r.provider).toBe(ACP_DELEGATE_PROVIDER);
  });

  it('workerKindLabel never says "Copilot" for the Claude adapter', () => {
    const label = workerKindLabel('claude');
    expect(label).toBe('Claude');
    expect(label.toLowerCase()).not.toContain('copilot');
  });
});

describe('eveWorkerAssignmentCore — (E) IMAGE routes to image_gen/gentmp, NOT the ACP seam', () => {
  it('an image worker carries imageRoute and no ACP/codex fields', () => {
    const r = resolveWorkerRouting({ agent_id: ROSTER_ID, kind: 'image' });
    expect(r.imageRoute).toBe(true);
    expect(r.acpCommand).toBeUndefined();
    expect(r.codexRuntime).toBeUndefined();
    expect(r.provider).toBeUndefined();
  });
});

describe('eveWorkerAssignmentCore — (D) NAMESPACE JOIN + the dispatch GATE', () => {
  const claudeWorker: EveWorkerAssignment = { agent_id: ROSTER_ID, kind: 'claude' };
  const assignments: EveWorkerAssignmentMap = { [ROSTER_ID]: claudeWorker };

  it('returns routing ONLY for an assigned, status-allowed worker', () => {
    const statuses: EveTeamWorkerStatusMap = {}; // default = active
    const d = resolveDispatchableWorkerRouting(ROSTER_ID, assignments, statuses);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('ok-dispatchable');
    expect(d.routing?.acpCommand).toBe('bunx');
    expect(d.gate.allowed).toBe(true);
  });

  it('a PAUSED worker is blocked by the gate — no routing (gate stays authoritative)', () => {
    const statuses: EveTeamWorkerStatusMap = { [ROSTER_ID]: 'paused' };
    const d = resolveDispatchableWorkerRouting(ROSTER_ID, assignments, statuses);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('blocked-by-status');
    expect(d.routing).toBeUndefined();
    expect(d.gate.reason).toBe('blocked-paused');
  });

  it('an OFF worker is blocked by the gate — no routing', () => {
    const statuses: EveTeamWorkerStatusMap = { [ROSTER_ID]: 'off' };
    const d = resolveDispatchableWorkerRouting(ROSTER_ID, assignments, statuses);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('blocked-by-status');
    expect(d.routing).toBeUndefined();
  });

  it('an id with NO assignment yields no routing (nothing to dispatch via the seam)', () => {
    const statuses: EveTeamWorkerStatusMap = {};
    const d = resolveDispatchableWorkerRouting('growth-lead', assignments, statuses);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('no-assignment');
    expect(d.routing).toBeUndefined();
    // The status gate itself allowed it — the block is purely "nothing assigned".
    expect(d.gate.allowed).toBe(true);
  });

  it('the un-delegated `eve` is never a dispatchable CLI worker (no assignment)', () => {
    const d = resolveDispatchableWorkerRouting('eve', assignments, {});
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('no-assignment');
    expect(d.gate.reason).toBe('ok-system-default');
  });
});

describe('eveWorkerAssignmentCore — (F) the LIVE Claude delegate resolver (what makes Claude fire)', () => {
  it('resolves a wheel-CONSUMABLE delegate for an assigned, status-allowed Claude worker', () => {
    const assignments: EveWorkerAssignmentMap = { [ROSTER_ID]: { agent_id: ROSTER_ID, kind: 'claude' } };
    const delegate = resolveAssignedClaudeDelegate(assignments, {});
    expect(delegate).not.toBeNull();
    // CONSUMABILITY: this is exactly the tuple the bundled wheel's delegate_task
    // override_acp_command/override_acp_args + forced provider=copilot-acp consume.
    expect(delegate?.acpCommand).toBe('bunx');
    expect(delegate?.acpArgs).toEqual([CLAUDE_ACP_ADAPTER_PACKAGE]);
    expect(delegate?.provider).toBe(ACP_DELEGATE_PROVIDER);
    expect(delegate?.agent_id).toBe(ROSTER_ID);
    expect(isClaudeSeatDelegateRoute(delegate)).toBe(true);
  });

  it.each([
    ['app-metered billing', { billingLane: 'app_metered' }],
    ['EVE Inference/OpenRouter execution', { runtimeRoute: 'eve_inference_openrouter' }],
    ['cloud fallback', { fallbackPolicy: 'eve_inference' }],
  ])('rejects a Claude-seat delegate carrying %s', (_case, override) => {
    const valid = resolveAssignedClaudeDelegate({ [ROSTER_ID]: { agent_id: ROSTER_ID, kind: 'claude' } }, {})!;
    expect(isClaudeSeatDelegateRoute({ ...valid, ...override })).toBe(false);
  });

  it('retains cli_path only as metadata and resolves the actual ACP adapter', () => {
    const assignments: EveWorkerAssignmentMap = {
      [ROSTER_ID]: { agent_id: ROSTER_ID, kind: 'claude', cli_path: '/opt/claude/bin/claude' },
    };
    const delegate = resolveAssignedClaudeDelegate(assignments, {});
    expect(delegate?.acpCommand).toBe('bunx');
    expect(delegate?.acpArgs).toEqual([CLAUDE_ACP_ADAPTER_PACKAGE]);
  });

  it('returns null for a PAUSED Claude worker (the dispatch gate stays authoritative)', () => {
    const assignments: EveWorkerAssignmentMap = { [ROSTER_ID]: { agent_id: ROSTER_ID, kind: 'claude' } };
    expect(resolveAssignedClaudeDelegate(assignments, { [ROSTER_ID]: 'paused' })).toBeNull();
    expect(resolveAssignedClaudeDelegate(assignments, { [ROSTER_ID]: 'off' })).toBeNull();
  });

  it('returns null when no Claude worker is assigned (a Codex/image assignment is NOT a Claude delegate)', () => {
    expect(resolveAssignedClaudeDelegate({}, {})).toBeNull();
    const codexOnly: EveWorkerAssignmentMap = { [CEO_ID]: { agent_id: CEO_ID, kind: 'codex', cli_version: '0.134.0' } };
    expect(resolveAssignedClaudeDelegate(codexOnly, {})).toBeNull();
    const imageOnly: EveWorkerAssignmentMap = { [ROSTER_ID]: { agent_id: ROSTER_ID, kind: 'image' } };
    expect(resolveAssignedClaudeDelegate(imageOnly, {})).toBeNull();
  });

  it('picks the FIRST status-allowed Claude when several are assigned (paused ones skipped)', () => {
    const assignments: EveWorkerAssignmentMap = {
      ceo: { agent_id: 'ceo', kind: 'claude' },
      'growth-lead': { agent_id: 'growth-lead', kind: 'claude' },
    };
    const delegate = resolveAssignedClaudeDelegate(assignments, { ceo: 'paused' });
    expect(delegate?.agent_id).toBe('growth-lead');
  });
});

describe('eveWorkerAssignmentCore — (G) bunx/claude-agent-acp resolvability preflight (MUST-FIX 4)', () => {
  const claude = (acpCommand: string, acpArgs: string[] = []) => ({
    agent_id: ROSTER_ID,
    label: 'Claude',
    acpCommand,
    acpArgs,
    provider: ACP_DELEGATE_PROVIDER,
  });

  it('no warning when the launcher resolves', () => {
    expect(claudeDelegatePreflightWarning(claude('bunx', [CLAUDE_ACP_ADAPTER_PACKAGE]), () => true)).toBe('');
  });

  it('warns (mentioning bun) when the default bunx launcher is NOT resolvable', () => {
    const w = claudeDelegatePreflightWarning(claude('bunx', [CLAUDE_ACP_ADAPTER_PACKAGE]), () => false);
    expect(w).not.toBe('');
    expect(w.toLowerCase()).toContain('bunx');
    expect(w).toContain(CLAUDE_ACP_ADAPTER_PACKAGE);
  });

  it('warns (mentioning the path) when the resolved transport command is NOT resolvable', () => {
    const w = claudeDelegatePreflightWarning(claude('/opt/claude/bin/claude'), () => false);
    expect(w).not.toBe('');
    expect(w).toContain('/opt/claude/bin/claude');
  });

  it('no warning when no Claude delegate is wired', () => {
    expect(claudeDelegatePreflightWarning(null, () => false)).toBe('');
    expect(claudeDelegatePreflightWarning(undefined, () => false)).toBe('');
  });

  it('a throwing probe is treated as unresolvable (fail-visible, never throws)', () => {
    const w = claudeDelegatePreflightWarning(claude('bunx'), () => {
      throw new Error('probe blew up');
    });
    expect(w).not.toBe('');
  });
});

describe('1.6.3 — buildTeamDirectiveRoles (the SOUL team-directive input)', () => {
  it('emits every roster role in order with live status + honest worker label', () => {
    const assignments = {
      'growth-lead': { agent_id: 'growth-lead', kind: 'claude' as const },
      'seo-lead': { agent_id: 'seo-lead', kind: 'codex' as const },
    };
    const statuses: EveTeamWorkerStatusMap = { 'content-writer': 'paused' };
    const roles = buildTeamDirectiveRoles(assignments, statuses);
    expect(roles.length).toBeGreaterThanOrEqual(8);
    const byName = new Map(roles.map((r) => [r.display_name, r]));
    expect(byName.get('Growth Lead')?.worker).toBe('EVE-Spezialist');
    // Codex must be labelled as NOT dispatchable — EVE may not believe a facade.
    expect(byName.get('SEO')?.worker).toContain('noch nicht');
    expect(byName.get('Autor')?.status).toBe('paused');
    // Unassigned roles run on the EVE-Runtime default (null worker).
    expect(byName.get('EVE')?.worker).toBeNull();
    for (const role of roles) {
      expect(role.outcome.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic for a given settings state (bootstrap byte-stability)', () => {
    const a = JSON.stringify(buildTeamDirectiveRoles({}, {}));
    const b = JSON.stringify(buildTeamDirectiveRoles({}, {}));
    expect(a).toBe(b);
  });
});

describe('1.6.3 review fix — team directive labels only the ROUTED Claude as plainly wired', () => {
  it('second claude assignment reads assigned-but-not-routed (SOUL consistency)', () => {
    const assignments = {
      'growth-lead': { agent_id: 'growth-lead', kind: 'claude' as const },
      'content-writer': { agent_id: 'content-writer', kind: 'claude' as const },
    };
    const roles = buildTeamDirectiveRoles(assignments, {});
    const byName = new Map(roles.map((r) => [r.display_name, r]));
    const workers = [byName.get('Growth Lead')?.worker, byName.get('Autor')?.worker];
    // Exactly ONE of the two is the plainly routed delegate; the other is hedged.
    expect(workers.filter((w) => w === 'EVE-Spezialist').length).toBe(1);
    expect(workers.filter((w) => w?.includes('noch nicht aktiv')).length).toBe(1);
    expect(JSON.stringify(roles)).not.toMatch(/Claude|Codex|CLI/i);
  });
});
