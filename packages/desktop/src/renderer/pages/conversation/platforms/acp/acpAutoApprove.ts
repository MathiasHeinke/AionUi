/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpPermissionOption, AcpPermissionRequest } from '@/common/types/platform/acpTypes';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';
import { COMMAND_EVE_HG4_DELEGATED_MODE } from '@/renderer/utils/model/agentModes';

/**
 * Desktop-side ACP auto-approve resolver.
 *
 * WHY THIS EXISTS:
 * EVE runs as a Hermes/ACP agent. Hermes emits an ACP `session/request_permission`
 * for every dangerous tool call (write_text_file/edit, terminal, …) and the desktop
 * renders the "Approve edit:" dialog from it. The permission MODE selected in the
 * bottom pill (Standard / Änderungen übernehmen / Nicht-fragen) is persisted on the
 * conversation (`extra.session_mode`) and is also synchronized through AionCore's
 * stable config-options API. The renderer still answers a replayed permission event
 * as defense in depth: reconnects may redeliver an already-emitted gate after Hermes
 * accepted the mode, and that must not strand a running turn behind a stale dialog.
 *
 * THE RENDERER FALLBACK (this module):
 * Hermes already applies the founder's global `dont_ask` authority to routine
 * actions. A permission request that still reaches the renderer is therefore an
 * escalation, not another routine action. Plain `dont_ask` must render that gate.
 * The renderer may answer it only when the user explicitly delegated HG4 authority
 * for this conversation through HG3.5.
 *
 * SECURITY:
 * - EVE `dont_ask` keeps routine backend authority but does NOT renderer-auto-allow.
 * - `dont_ask_hg4` is a renderer-only, conversation-scoped grant through HG3.5.
 * - A request explicitly marked HG4 always remains gated.
 * - Other ACP backends retain their native `yolo` / `bypassPermissions` behavior.
 */

/**
 * Plain EVE `dont_ask` is intentionally absent: Hermes owns routine approvals and
 * every permission request it still emits is an escalation requiring either a dialog
 * or the explicit scoped HG4 grant.
 */
const AUTO_APPROVE_MODES: ReadonlySet<string> = new Set([COMMAND_EVE_HG4_DELEGATED_MODE, 'yolo', 'bypassPermissions']);

/**
 * True only for a renderer-approved auto-approve authority. Plain EVE `dont_ask`
 * returns false because its routine-action authority is enforced by Hermes itself.
 */
export function isAutoApproveMode(mode: string | undefined | null): boolean {
  if (!mode) return false;
  return AUTO_APPROVE_MODES.has(mode);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** Detect an explicit final-HG4 marker without guessing from paths or tool names. */
function requiresFinalHg4(request: Pick<AcpPermissionRequest, 'tool_call'> | undefined | null): boolean {
  if (!request) return false;
  const requestRecord = request as unknown as Record<string, unknown>;
  const rawInput = recordValue(request.tool_call?.raw_input);
  const risk = recordValue(rawInput?.risk) ?? recordValue(requestRecord.risk);
  const policy = recordValue(rawInput?.permission) ?? recordValue(requestRecord.permission);
  const metadata = recordValue(rawInput?.metadata) ?? recordValue(requestRecord.metadata);
  const candidates = [
    requestRecord.human_gate,
    requestRecord.humanGate,
    requestRecord.human_gate_level,
    requestRecord.humanGateLevel,
    requestRecord.required_human_gate,
    requestRecord.requiredHumanGate,
    rawInput?.human_gate,
    rawInput?.humanGate,
    rawInput?.human_gate_level,
    rawInput?.humanGateLevel,
    rawInput?.required_human_gate,
    rawInput?.requiredHumanGate,
    risk?.human_gate,
    risk?.humanGate,
    risk?.human_gate_level,
    risk?.humanGateLevel,
    policy?.human_gate,
    policy?.humanGate,
    policy?.human_gate_level,
    policy?.humanGateLevel,
    metadata?.human_gate,
    metadata?.humanGate,
    metadata?.human_gate_level,
    metadata?.humanGateLevel,
    metadata?.required_human_gate,
    metadata?.requiredHumanGate,
  ];
  return candidates.some((value) => {
    if (typeof value === 'number') return Number.isFinite(value) && value === 4;
    if (typeof value !== 'string') return false;
    const normalized = value.trim();
    return normalized === '4' || /\bHG\s*-?\s*4\b/i.test(normalized);
  });
}

/**
 * Pick the option_id the desktop should send to AUTO-ALLOW a permission request.
 *
 * Prefers `allow_once` (allow this one call) over `allow_always` (allow for the
 * session) — auto-approve should grant the minimum each time, not silently escalate
 * the agent's standing permissions. Returns null when the request carries no allow
 * option at all, in which case the caller MUST fall back to rendering the dialog (we
 * never fabricate an approval the agent didn't offer).
 */
export function pickAllowOptionId(options: ReadonlyArray<AcpPermissionOption> | undefined | null): string | null {
  if (!options || options.length === 0) return null;
  const once = options.find((o) => o.kind === 'allow_once');
  if (once) return once.option_id;
  const always = options.find((o) => o.kind === 'allow_always');
  if (always) return always.option_id;
  return null;
}

export interface AutoApproveDecision {
  /** Whether the desktop should auto-respond allow instead of showing the dialog. */
  autoApprove: boolean;
  /** The option_id to send when autoApprove is true (null otherwise). */
  optionId: string | null;
}

/**
 * Single decision point used by the ACP message handler: given the conversation's
 * effective permission authority and an incoming permission request, decide whether
 * to auto-allow and with which option.
 *
 * Returns `{ autoApprove: false }` whenever:
 *  - the mode has no renderer auto-approve authority, OR
 *  - the scoped EVE delegation receives a request explicitly marked HG4, OR
 *  - the request offers no allow option (we never fabricate an approval).
 */
export function resolveAcpAutoApprove(
  mode: string | undefined | null,
  request: Pick<AcpPermissionRequest, 'options' | 'tool_call'> | undefined | null,
  backend?: string
): AutoApproveDecision {
  if (isCommandEveAcpConversation(backend) && mode !== COMMAND_EVE_HG4_DELEGATED_MODE) {
    return { autoApprove: false, optionId: null };
  }
  if (!isAutoApproveMode(mode)) return { autoApprove: false, optionId: null };
  if (mode === COMMAND_EVE_HG4_DELEGATED_MODE && requiresFinalHg4(request)) {
    return { autoApprove: false, optionId: null };
  }
  const optionId = pickAllowOptionId(request?.options);
  if (!optionId) return { autoApprove: false, optionId: null };
  return { autoApprove: true, optionId };
}
