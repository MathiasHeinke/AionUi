/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpPermissionOption, AcpPermissionRequest } from '@/common/types/platform/acpTypes';

/**
 * Desktop-side ACP auto-approve resolver for the YOLO / "Nicht fragen" permission
 * mode.
 *
 * WHY THIS EXISTS (root cause):
 * EVE runs as a Hermes/ACP agent. Hermes emits an ACP `session/request_permission`
 * for every dangerous tool call (write_text_file/edit, terminal, …) and the desktop
 * renders the "Approve edit:" dialog from it. The permission MODE selected in the
 * bottom pill (Standard / Änderungen übernehmen / Nicht-fragen) is persisted on the
 * conversation (`extra.session_mode`) but it NEVER reaches Hermes: the only push
 * path is `acpConversation.setMode` → `PUT /api/conversations/:id/mode`, and that
 * route 404s on the bundled aioncore runtime (verified live on 1.2.19:
 * `{"success":false,"error":"Route not found.","code":"NOT_FOUND"}`). So Hermes is
 * never told to stop asking, and the renderer rendered the dialog unconditionally —
 * "Nicht fragen" had no effect.
 *
 * THE FIX (this module):
 * The desktop honors the mode itself. When an `acp_permission` request arrives AND
 * the conversation's effective mode is the YOLO/auto-approve mode, the desktop
 * auto-responds `allow` (selecting the request's own `allow_once` option) instead of
 * rendering the gating dialog. The gating modes (Standard, Änderungen-übernehmen)
 * still render the dialog and still gate.
 *
 * SECURITY — auto-approve is ONLY the YOLO mode:
 * `isAutoApproveMode` returns true exclusively for the auto-approve / YOLO synonym
 * group (`dont_ask` for Hermes/EVE, plus `yolo` / `bypassPermissions` for the
 * cross-backend synonyms a conversation may have persisted). `default` (Standard) and
 * `accept_edits` / `auto_edit` (Änderungen übernehmen) are deliberately NOT in the set
 * — they keep gating. This is the same intent vocabulary the picker uses
 * (`agentMode.eve.yolo` ⇄ `dont_ask`), kept in lockstep with the MODE_SYNONYM_GROUPS
 * auto-approve row.
 */

/**
 * Canonical set of permission-mode values that mean "auto-approve / YOLO" across the
 * ACP backends. Mirrors the auto-approve synonym row in
 * `renderer/utils/model/agentModes.ts` (MODE_SYNONYM_GROUPS[0]).
 *
 * IMPORTANT: do NOT add `accept_edits`/`auto_edit`/`default` here — those modes must
 * keep gating (they are the non-YOLO modes). Widening this set would silently turn a
 * gating mode into auto-run shell/edits.
 */
const AUTO_APPROVE_MODES: ReadonlySet<string> = new Set(['dont_ask', 'yolo', 'bypassPermissions']);

/**
 * True only for the YOLO / auto-approve permission mode. Everything else (Standard,
 * Änderungen übernehmen, plan, undefined, …) returns false so the desktop keeps
 * gating those modes.
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
export function pickAllowOptionId(
  options: ReadonlyArray<AcpPermissionOption> | undefined | null
): string | null {
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
 * effective permission mode and an incoming permission request, decide whether to
 * auto-allow and with which option.
 *
 * Returns `{ autoApprove: false }` whenever:
 *  - the mode is not the YOLO/auto-approve mode (gating modes keep gating), OR
 *  - the request offers no allow option (we never fabricate an approval).
 */
export function resolveAcpAutoApprove(
  mode: string | undefined | null,
  request: Pick<AcpPermissionRequest, 'options'> | undefined | null
): AutoApproveDecision {
  if (!isAutoApproveMode(mode)) return { autoApprove: false, optionId: null };
  const optionId = pickAllowOptionId(request?.options);
  if (!optionId) return { autoApprove: false, optionId: null };
  return { autoApprove: true, optionId };
}
