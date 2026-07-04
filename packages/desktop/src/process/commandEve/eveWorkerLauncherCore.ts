/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE 1.7.0 — eve-acp-launcher wiring (SG-1 Design A, gates A3/A4).
 *
 * The bundled POSIX-sh launcher (resources/eve-acp-launcher/eve-acp-launcher.sh)
 * sits transparently in front of the real Claude ACP adapter so the delegate lane
 * gets a REAL pause-gate + attribution env WITHOUT a wheel bump. This module is the
 * main-side glue that:
 *
 *   1. resolves the bundled launcher path (dev + packaged),
 *   2. computes the per-(seat, role) status/token file paths — OUTSIDE hermesHome,
 *      so EVE's own file tools never see them,
 *   3. WRAPS a resolved Claude delegate so `delegate_task`'s `acp_command` becomes
 *      the launcher and `acp_args` carry `--role/--status-file/--token-file` in
 *      FRONT of the original adapter argv,
 *   4. writes the DERIVED status files (a read-mirror of commandEve.teamWorkerStatus
 *      — never a second source of truth) + the 0600 token files.
 *
 * A4 (token visibility): the wrapped `acp_args` carry the token FILE PATH, never the
 * token itself — `acp_args` are echoed verbatim into SOUL prose (model-visible). The
 * token lives only in the 0600 file the launcher reads.
 *
 * A3 (spawn-pause): the launcher refuses `exec` (exit 3) when the status file reads
 * `paused`/`off`. The delegate lane runs on the operator's subscription and never
 * hits the shim's 409 gate, so this launcher is the ONLY enforcement point there.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EVE_TEAM_ROSTER } from '../../common/config/eveTeamRoster';
import type { EveTeamWorkerStatusMap } from '../../common/config/eveTeamControlsCore';
import type { EveWorkerAssignmentMap, ResolvedClaudeDelegate } from '../../common/config/eveWorkerAssignmentCore';
import { currentLeaseFor, mintLeaseToken } from './eveAgentTaskRegistry';

/** Env override so tests / dev boxes can point at the source launcher. */
export const COMMAND_EVE_LAUNCHER_DIR_ENV = 'COMMAND_EVE_LAUNCHER_DIR';
const BUNDLED_LAUNCHER_DIR = 'eve-acp-launcher';
const LAUNCHER_SCRIPT = 'eve-acp-launcher.sh';

function compact(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve the bundled launcher script path. Mirrors resolveBundledSkillsDir:
 *   1) explicit COMMAND_EVE_LAUNCHER_DIR env (dev / tests),
 *   2) packaged: <resourcesPath>/eve-acp-launcher/eve-acp-launcher.sh,
 *   3) dev: <cwd>/resources/eve-acp-launcher/eve-acp-launcher.sh.
 * Returns the FIRST existing ABSOLUTE candidate, or '' when none is found (callers
 * then fall back to the UNWRAPPED delegate — availability over the pause-gate,
 * which is defense-in-depth and only ever needed for a role active at boot).
 */
export function resolveBundledLauncherPath(env: NodeJS.ProcessEnv, resourcesPath?: string): string {
  const explicitDir = compact(env[COMMAND_EVE_LAUNCHER_DIR_ENV]);
  const candidates = [
    explicitDir ? path.join(explicitDir, LAUNCHER_SCRIPT) : '',
    resourcesPath ? path.join(resourcesPath, BUNDLED_LAUNCHER_DIR, LAUNCHER_SCRIPT) : '',
    path.join(process.cwd(), 'resources', BUNDLED_LAUNCHER_DIR, LAUNCHER_SCRIPT),
  ].filter(Boolean);
  const found = candidates.find((candidate) => {
    try {
      return path.isAbsolute(candidate) && fs.existsSync(candidate);
    } catch {
      return false;
    }
  });
  return found || '';
}

/**
 * Filesystem-safe fragment for a seat id ('seat-1' | uuid) or an agent id (kebab).
 * Dots are NOT allowed (they never appear in a kebab agent_id or a 'seat-1'/uuid),
 * so a `..` traversal sequence can never survive — defense-in-depth even though the
 * seat id is already format-validated upstream.
 */
function fsSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface LauncherStatePaths {
  /** The per-seat directory holding all of this seat's launcher state files. */
  readonly dir: string;
  readonly statusFile: string;
  readonly tokenFile: string;
}

/**
 * Compute the status/token file paths for a role on a seat. Rooted at
 * <dataPath>/eve-acp-launcher/<seat>/ — under userData but OUTSIDE any seat's
 * hermesHome (which is <dataPath>/seats/<seat>/hermes/home), so EVE's sandboxed
 * file tools can never read the token.
 */
export function computeLauncherStatePaths(dataPath: string, seatId: string, agentId: string): LauncherStatePaths {
  const dir = path.join(dataPath, BUNDLED_LAUNCHER_DIR, fsSafe(compact(seatId) || 'seat-1'));
  return {
    dir,
    statusFile: path.join(dir, `${fsSafe(agentId)}.status`),
    tokenFile: path.join(dir, `${fsSafe(agentId)}.token`),
  };
}

/** Normalize a stored team status to the BARE launcher status word the sh script matches. */
export function renderLauncherStatus(status: unknown): 'active' | 'paused' | 'off' {
  return status === 'paused' ? 'paused' : status === 'off' ? 'off' : 'active';
}

export interface LauncherWrapConfig {
  readonly launcherPath: string;
  readonly statusFile: string;
  readonly tokenFile: string;
}

/**
 * The interpreter the launcher runs under. Invoking `/bin/sh <launcher>` rather
 * than the launcher directly means the script does NOT need its executable bit —
 * so a DMG-package step that drops the +x mode can never break delegation (Fable
 * audit auflage: don't depend on the exec bit surviving packaging). `/bin/sh` is
 * always present on macOS (Command EVE is Apple-Silicon-macOS-only). stdio pass-
 * through is identical: sh runs the script, the script `exec`s the real adapter.
 */
export const LAUNCHER_INTERPRETER = '/bin/sh';

/**
 * Wrap a resolved Claude delegate so `delegate_task` launches the eve-acp-launcher
 * (via /bin/sh) in front of the real adapter. Returns the delegate UNCHANGED when
 * the launcher path is missing/non-absolute (fail-open availability — the same
 * guard the raw cli_path path applies). The token itself is NEVER placed in
 * acp_args (A4): only the token FILE PATH is, and acp_args are model-visible in SOUL.
 */
export function wrapClaudeDelegateWithLauncher(
  delegate: ResolvedClaudeDelegate,
  config: LauncherWrapConfig
): ResolvedClaudeDelegate {
  const launcherPath = compact(config.launcherPath);
  if (!launcherPath || !path.isAbsolute(launcherPath)) return delegate;
  const wrappedArgs = [
    launcherPath,
    '--role',
    delegate.agent_id,
    '--status-file',
    config.statusFile,
    '--token-file',
    config.tokenFile,
    '--',
    delegate.acpCommand,
    ...delegate.acpArgs,
  ];
  return { ...delegate, acpCommand: LAUNCHER_INTERPRETER, acpArgs: wrappedArgs };
}

/**
 * Write the DERIVED launcher state for every Claude-assigned role on the active
 * seat: a bare status file (read-mirror of teamWorkerStatus) for each, plus a 0600
 * token file for each active, non-free role (the registry refuses free/system
 * roles, so those stay token-less = un-attributable, A7a). Best-effort per role:
 * one role's failure never blocks the others. Returns the roles it wrote tokens for.
 */
export function syncEveWorkerLauncherFiles(
  assignments: EveWorkerAssignmentMap,
  statuses: EveTeamWorkerStatusMap,
  ctx: { dataPath: string; seatId: string },
  roster: readonly { agent_id: string }[] = EVE_TEAM_ROSTER
): { tokensWritten: string[] } {
  const tokensWritten: string[] = [];
  const dataPath = compact(ctx.dataPath);
  if (!dataPath) return { tokensWritten };
  const seatId = compact(ctx.seatId) || 'seat-1';

  for (const role of roster) {
    const agentId = role.agent_id;
    if (assignments[agentId]?.kind !== 'claude') continue;
    const paths = computeLauncherStatePaths(dataPath, seatId, agentId);
    try {
      fs.mkdirSync(paths.dir, { recursive: true });
      // Status file — bare word, no JSON (the sh launcher matches `paused`/`off`
      // exactly; a JSON blob would silently read as "active" = fail-open).
      const status = renderLauncherStatus((statuses as Record<string, unknown>)[agentId]);
      fs.writeFileSync(paths.statusFile, status, { encoding: 'utf8', mode: 0o600 });

      // Token file — only for an ACTIVE, non-free, roster role (the registry
      // enforces the free/system exclusion). Paused/off roles are not spawned, so
      // they need no token; minting only for active keeps the token surface minimal.
      if (status === 'active') {
        const lease = currentLeaseFor(agentId, seatId) ?? mintLeaseToken(agentId, seatId);
        if (lease) {
          fs.writeFileSync(paths.tokenFile, lease.token, { encoding: 'utf8', mode: 0o600 });
          tokensWritten.push(agentId);
        } else {
          // Not attributable (free/system) — ensure no stale token lingers.
          try {
            fs.rmSync(paths.tokenFile, { force: true });
          } catch {
            /* best-effort */
          }
        }
      }
    } catch (error) {
      console.warn(`[Command EVE] launcher state write failed for role ${agentId}:`, error);
    }
  }
  return { tokensWritten };
}

/**
 * Main-side composition used at every delegate-resolve point (boot + seat-switch):
 * refresh the DERIVED status/token mirror for all Claude roles, then WRAP the
 * currently-resolved delegate (if any) so `delegate_task` launches through the
 * eve-acp-launcher. Pure over its inputs (takes resolved values — dataPath, seatId,
 * resourcesPath, env — so it stays unit-testable without electron `app`). Fail-open:
 * with no bundled launcher the delegate is returned UNWRAPPED (availability over the
 * pause-gate, which is defense-in-depth). Never throws — a state-write glitch must
 * not block delegation.
 */
export function applyLauncherWiring(
  delegate: ResolvedClaudeDelegate | null,
  assignments: EveWorkerAssignmentMap,
  statuses: EveTeamWorkerStatusMap,
  ctx: { dataPath: string; seatId: string; resourcesPath?: string; env: NodeJS.ProcessEnv }
): ResolvedClaudeDelegate | null {
  try {
    syncEveWorkerLauncherFiles(assignments, statuses, { dataPath: ctx.dataPath, seatId: ctx.seatId });
  } catch (error) {
    console.warn('[Command EVE] launcher state sync failed:', error);
  }
  if (!delegate) return null;
  const launcherPath = resolveBundledLauncherPath(ctx.env, ctx.resourcesPath);
  if (!launcherPath) return delegate;
  const paths = computeLauncherStatePaths(ctx.dataPath, ctx.seatId, delegate.agent_id);
  return wrapClaudeDelegateWithLauncher(delegate, {
    launcherPath,
    statusFile: paths.statusFile,
    tokenFile: paths.tokenFile,
  });
}
