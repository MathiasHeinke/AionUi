/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpPermissionOption, AcpPermissionRequest } from '@/common/types/platform/acpTypes';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';

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
 * Hermes applies its own real session modes. A permission request that still
 * reaches the renderer is an escalation and Command EVE must render it. The
 * renderer has no server-attested HG classification, so it cannot auto-answer.
 *
 * SECURITY:
 * - Every EVE permission request remains manual in the renderer.
 * - Legacy `dont_ask_hg4` state is inert and never grants renderer authority.
 * - Other ACP backends retain their native `yolo` / `bypassPermissions` behavior.
 */

/**
 * Command EVE values are intentionally absent. This set is only for other ACP
 * backends whose native auto mode is already part of their renderer contract.
 */
const AUTO_APPROVE_MODES: ReadonlySet<string> = new Set(['yolo', 'bypassPermissions']);

/**
 * True only for a renderer-approved auto-approve authority. Plain EVE `dont_ask`
 * returns false because its routine-action authority is enforced by Hermes itself.
 */
export function isAutoApproveMode(mode: string | undefined | null): boolean {
  if (!mode) return false;
  return AUTO_APPROVE_MODES.has(mode);
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
 *  - this is any Command EVE permission request, OR
 *  - the mode has no renderer auto-approve authority, OR
 *  - the request offers no allow option (we never fabricate an approval).
 */
export function resolveAcpAutoApprove(
  mode: string | undefined | null,
  request: Pick<AcpPermissionRequest, 'options' | 'tool_call'> | undefined | null,
  backend?: string
): AutoApproveDecision {
  if (isCommandEveAcpConversation(backend)) return { autoApprove: false, optionId: null };
  if (!isAutoApproveMode(mode)) return { autoApprove: false, optionId: null };
  const optionId = pickAllowOptionId(request?.options);
  if (!optionId) return { autoApprove: false, optionId: null };
  return { autoApprove: true, optionId };
}
