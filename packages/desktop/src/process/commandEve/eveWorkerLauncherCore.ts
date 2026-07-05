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
import { honchoMcpServerForSeat, isCanonicalLoopbackDbUri } from './honchoMcpServerCore';
import type { HonchoRenderInput } from './honchoRuntimeRenderCore';
import { assertSeatId, isLegacySeatId, LEGACY_SEAT_ID } from './seatContextCore';

/**
 * COMPA-624 (2026-07-05) — the env var the Claude ACP adapter reads to load an
 * external MCP config file, so a delegated worker gets the per-seat `honcho` memory
 * tool. MAC-VERIFY-PENDING: the exact name (Claude Code discovers `.mcp.json` in the
 * cwd; the ACP adapter may honor a `CLAUDE_MCP_CONFIG`-style pointer instead) must be
 * confirmed against the installed @agentclientprotocol/claude-agent-acp adapter. The
 * launcher exports the PATH under this name; the HONCHO_* values stay in the 0600
 * file, never in argv. A wrong name here = the delegate silently lacks the tool (a
 * dead feature, not a crash), correctable in one line.
 */
export const CLAUDE_DELEGATE_MCP_CONFIG_ENV = 'CLAUDE_MCP_CONFIG';

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
 * Returns the FIRST existing ABSOLUTE candidate, or '' when none is found. On '',
 * the runtime entry (applyLauncherWiring) FAILS CLOSED — it returns null and wires
 * NO delegate rather than an unwrapped one (H13); see applyLauncherWiring below.
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
  /** COMPA-624 — the per-(seat,role) honcho MCP config file the delegate loads. */
  readonly honchoMcpConfigFile: string;
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
    honchoMcpConfigFile: path.join(dir, `${fsSafe(agentId)}.honcho.mcp.json`),
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
  /**
   * COMPA-624 — when set, the launcher gets `--mcp-config <path>` so it exports the
   * per-seat honcho MCP config pointer to the delegate adapter. A FILE PATH only
   * (never a secret; A4-safe even though acp_args are model-visible in SOUL).
   */
  readonly honchoMcpConfigFile?: string;
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
 * (via /bin/sh) in front of the real adapter. This is a PURE wrap helper: it returns
 * the delegate UNCHANGED when the launcher path is missing/non-absolute. That branch
 * is NOT the runtime fail-open — the sole runtime caller (applyLauncherWiring) checks
 * the launcher path FIRST and FAILS CLOSED (returns null, wires no delegate) on a
 * missing launcher (H13), so in production this unchanged-return is never reached with
 * an absent launcher. The token itself is NEVER placed in acp_args (A4): only the
 * token FILE PATH is, and acp_args are model-visible in SOUL.
 */
export function wrapClaudeDelegateWithLauncher(
  delegate: ResolvedClaudeDelegate,
  config: LauncherWrapConfig
): ResolvedClaudeDelegate {
  const launcherPath = compact(config.launcherPath);
  if (!launcherPath || !path.isAbsolute(launcherPath)) return delegate;
  const honchoMcpConfigFile = compact(config.honchoMcpConfigFile);
  const wrappedArgs = [
    launcherPath,
    '--role',
    delegate.agent_id,
    '--status-file',
    config.statusFile,
    '--token-file',
    config.tokenFile,
    // COMPA-624 — the per-seat honcho MCP config pointer (a PATH, not a secret). The
    // launcher exports it to the delegate adapter; the launcher's own readability
    // check makes an absent file a no-op, so this stays inert until Honcho is ready.
    ...(honchoMcpConfigFile ? ['--mcp-config', honchoMcpConfigFile] : []),
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
/**
 * Best-effort remove a per-role honcho MCP config (revocation). A missing file is
 * fine; never throws — a stale honcho config for a paused/reassigned role must be
 * gone so the delegate can not re-load a memory tool it should no longer have.
 */
function removeDelegateHonchoMcpConfig(honchoMcpConfigFile: string): void {
  try {
    fs.rmSync(honchoMcpConfigFile, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Write (or remove) the per-(seat,role) honcho MCP config a delegated Claude worker
 * loads, so it reads/writes the SAME per-seat local memory EVE does. Built from the
 * IDENTICAL honchoMcpServerForSeat tuple (per-seat dbUri/workspace/home, passwordless
 * loopback — never a secret). Returns true when a config was written. When Honcho is
 * not fresh-ready (or no launcher), the file is REMOVED (the delegate gets no honcho
 * tool that launch) — never a stale/half config.
 */
function writeDelegateHonchoMcpConfig(honchoMcpConfigFile: string, expectedSeatId: string, honcho?: HonchoRenderInput): boolean {
  // FULLY self-contained + fail-soft (Codex): the WHOLE body (incl. honchoMcpServerForSeat
  // + the seat-binding + secret checks) is guarded, so it can NEVER throw into the sync
  // loop and any anomaly REMOVES the config rather than leaving a stale/wrong one.
  try {
    // (a) SEAT BINDING (Codex cross-seat): the cfg's OWN seat must be the seat we are
    // writing the path for — never write seat-B's memory config under seat-A's path.
    // cfg.seatId is already the sanitized id; compare against the sanitized target.
    const sanitizedTarget = isLegacySeatId(expectedSeatId) ? LEGACY_SEAT_ID : assertSeatId(expectedSeatId);
    if (honcho?.cfg?.seatId && honcho.cfg.seatId !== sanitizedTarget) {
      removeDelegateHonchoMcpConfig(honchoMcpConfigFile);
      return false;
    }

    const server = honchoMcpServerForSeat(honcho?.cfg, honcho?.ready === true, honcho?.launcher);
    if (!server) {
      removeDelegateHonchoMcpConfig(honchoMcpConfigFile);
      return false;
    }

    // (b) SECRET-FREE (Codex defense-in-depth): re-assert the dbUri is a passwordless
    // canonical-loopback URI at the WRITE boundary too (honchoMcpServerForSeat already
    // enforces it, but a delegate gets DIRECT db access — belt AND braces).
    const env = (server.env || {}) as Record<string, string>;
    if (!isCanonicalLoopbackDbUri(env.HONCHO_DB_URI)) {
      removeDelegateHonchoMcpConfig(honchoMcpConfigFile);
      return false;
    }

    const config = { mcpServers: { [server.id]: { command: server.command, args: server.args, env: server.env } } };
    fs.writeFileSync(honchoMcpConfigFile, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (error) {
    console.warn('[Command EVE] delegate honcho MCP config write failed:', error);
    removeDelegateHonchoMcpConfig(honchoMcpConfigFile);
    return false;
  }
}

export function syncEveWorkerLauncherFiles(
  assignments: EveWorkerAssignmentMap,
  statuses: EveTeamWorkerStatusMap,
  ctx: { dataPath: string; seatId: string; honcho?: HonchoRenderInput },
  roster: readonly { agent_id: string }[] = EVE_TEAM_ROSTER
): { tokensWritten: string[] } {
  const tokensWritten: string[] = [];
  const dataPath = compact(ctx.dataPath);
  if (!dataPath) return { tokensWritten };
  const seatId = compact(ctx.seatId) || 'seat-1';

  for (const role of roster) {
    const agentId = role.agent_id;
    const paths = computeLauncherStatePaths(dataPath, seatId, agentId);

    // H12 (revocation cleanup): a role that is NOT (or no longer) a Claude delegate
    // must carry NO launcher state. Remove any stale status/token so a prior
    // directive's launcher fail-CLOSES (a missing EXPECTED status file → exit 3, see
    // eve-acp-launcher.sh) and no lease token lingers on disk — a role switched back
    // to EVE-Runtime can never be silently re-run via its old launcher.
    if (assignments[agentId]?.kind !== 'claude') {
      try {
        fs.rmSync(paths.statusFile, { force: true });
        fs.rmSync(paths.tokenFile, { force: true });
      } catch {
        /* best-effort */
      }
      // A non-Claude role carries no honcho config either (revocation symmetry).
      removeDelegateHonchoMcpConfig(paths.honchoMcpConfigFile);
      continue;
    }

    // Status is a PURE read of the map (no fs) — compute it up front so the honcho
    // config can be resolved INDEPENDENTLY of the status/token writes below.
    const status = renderLauncherStatus((statuses as Record<string, unknown>)[agentId]);

    // COMPA-624 honcho config — handled BEFORE (and independent of) the throwing
    // status/token writes (Codex: an fs throw there must never leave a stale honcho
    // config for a now-paused/not-ready role). Active+ready ⇒ write; else ⇒ remove.
    // writeDelegateHonchoMcpConfig is fully self-contained + never throws.
    if (status === 'active') {
      try {
        fs.mkdirSync(paths.dir, { recursive: true });
      } catch {
        /* best-effort — writeDelegateHonchoMcpConfig fails soft if the dir is absent */
      }
      writeDelegateHonchoMcpConfig(paths.honchoMcpConfigFile, seatId, ctx.honcho);
    } else {
      removeDelegateHonchoMcpConfig(paths.honchoMcpConfigFile);
    }

    try {
      fs.mkdirSync(paths.dir, { recursive: true });
      // Status file — bare word, no JSON (the sh launcher matches `paused`/`off`
      // exactly; a JSON blob would silently read as "active" = fail-open).
      fs.writeFileSync(paths.statusFile, status, { encoding: 'utf8', mode: 0o600 });

      // Token file — only for an ACTIVE, non-free, roster role (the registry
      // enforces the free/system exclusion).
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
      } else {
        // M1: paused/off role is not spawned — remove any previously-active lease
        // token so it never lingers at a SOUL-known path (minimal token surface).
        try {
          fs.rmSync(paths.tokenFile, { force: true });
        } catch {
          /* best-effort */
        }
        // (the paused/off honcho config was already removed robustly above, before
        // this throwing block — no duplicate cleanup here.)
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
 * resourcesPath, env — so it stays unit-testable without electron `app`).
 *
 * FAIL-CLOSED (audit H13): the launcher is the ONLY dynamic pause-gate + env
 * boundary for the delegate lane. If the bundled launcher cannot be resolved (a
 * packaging/resource failure), we do NOT wire an UNWRAPPED delegate that would run
 * without the pause-gate + without the env scrub — we return null (no delegate this
 * launch) and warn. A missing launcher in a shipped build is a packaging bug to fix,
 * not a reason to silently drop the security boundary. Never throws — a state-write
 * glitch must not block the whole resolve.
 */
export function applyLauncherWiring(
  delegate: ResolvedClaudeDelegate | null,
  assignments: EveWorkerAssignmentMap,
  statuses: EveTeamWorkerStatusMap,
  ctx: { dataPath: string; seatId: string; resourcesPath?: string; env: NodeJS.ProcessEnv; honcho?: HonchoRenderInput }
): ResolvedClaudeDelegate | null {
  try {
    // Pass the per-seat honcho render input so ACTIVE Claude delegates get the SAME
    // local memory EVE has (per-seat, revocation-symmetric). Absent/not-ready ⇒ no
    // delegate honcho config (byte-identical to before this lane existed).
    syncEveWorkerLauncherFiles(assignments, statuses, { dataPath: ctx.dataPath, seatId: ctx.seatId, honcho: ctx.honcho });
  } catch (error) {
    console.warn('[Command EVE] launcher state sync failed:', error);
  }
  if (!delegate) return null;
  const launcherPath = resolveBundledLauncherPath(ctx.env, ctx.resourcesPath);
  if (!launcherPath) {
    // H13 fail-closed: never wire an unwrapped delegate (no pause-gate, no env scrub).
    console.warn('[Command EVE] eve-acp-launcher not found — refusing to wire an unwrapped delegate (fail-closed).');
    return null;
  }
  const paths = computeLauncherStatePaths(ctx.dataPath, ctx.seatId, delegate.agent_id);
  return wrapClaudeDelegateWithLauncher(delegate, {
    launcherPath,
    statusFile: paths.statusFile,
    tokenFile: paths.tokenFile,
    // Only point at the honcho config when Honcho is fresh-ready for this seat (the
    // config file was written for the active role in the sync above). The launcher
    // re-checks readability, so a race that removes it degrades to no-honcho, not a fail.
    honchoMcpConfigFile: ctx.honcho?.ready === true ? paths.honchoMcpConfigFile : undefined,
  });
}
