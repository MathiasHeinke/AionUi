/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';
import { CODEX_MODE_NATIVE_FULL_ACCESS, normalizeCodexMode } from '@/common/types/codex/codexModes';
import type { AgentSource } from '@/renderer/utils/model/agentTypes';
import { getAgentModes, resolveModeForBackend, type AgentModeOption } from '@/renderer/utils/model/agentModes';
import { EVE_AUTHORITY_FAIL_CLOSED, isEveAuthorityGrant } from '@/common/config/eveAuthorityCore';
import { backendModeForGrant, ladderFromBackendMode, withLadder } from '@/common/config/eveAuthorityStoreCore';

type ModePreference = {
  preferredMode?: string;
  yoloMode?: boolean;
};

const LEGACY_YOLO_MODE_MAP: Partial<Record<string, string>> = {
  claude: 'bypassPermissions',
  codex: CODEX_MODE_NATIVE_FULL_ACCESS,
  hermes: 'dont_ask',
  qwen: 'yolo',
};

/**
 * The mode preference for one backend.
 *
 * EXPORTED because the start screen must resolve it the same way the session
 * does. It previously read `acp.config` raw, so a seat's own ladder governed the
 * session while the install-global value governed the start screen — the two
 * surfaces the founder explicitly required to agree could disagree inside a
 * single seat.
 */
export function getModePreference(agentKey: string): ModePreference | undefined {
  if (agentKey === 'aionrs') {
    return configService.get('aionrs.config');
  }

  // P1 (independent review, Grok; re-found and sharpened by Kimi): the grant is
  // seat-scoped, `acp.config` is NOT. Seat A picking "Arbeiten" (`dont_ask`)
  // must never govern a client's seat that chose nothing.
  //
  // Two halves, and only both together close it:
  //   1. the seat-scoped grant WINS whenever one exists (here), and
  //   2. the Command EVE lane NEVER WRITES `acp.config` any more (see
  //      `savePreferredMode` and the Freigaben panel).
  //
  // With (2) in place this fallback can only ever hold a value that predates
  // 1.820 — an install-wide setting that already governed every seat before the
  // upgrade. Reading it keeps existing users on the mode they chose (dropping
  // them to "ask" is caught by the pre-existing EVE-permission-authority tests);
  // it can no longer carry one seat's fresh decision into another.
  if (isCommandEveAcpConversation(agentKey)) {
    const stored = configService.get('commandEve.authority');
    if (isEveAuthorityGrant(stored)) {
      const seatMode = backendModeForGrant(stored);
      if (seatMode) return { preferredMode: seatMode };
    }
  }

  return configService.get('acp.config')?.[agentKey];
}

/** Resolve the persisted preference to a mode the selected backend actually supports. */
export function resolveStoredPreferredMode(
  agentKey: string | undefined,
  availableModes?: AgentModeOption[]
): string | undefined {
  if (!agentKey) return undefined;

  const modes = availableModes ?? getAgentModes(agentKey);
  if (modes.length === 0) return undefined;

  const preference = getModePreference(agentKey);
  const preferredMode =
    agentKey === 'codex' ? normalizeCodexMode(preference?.preferredMode) : preference?.preferredMode;
  const resolvedPreferredMode = isCommandEveAcpConversation(agentKey)
    ? resolveModeForBackend(preferredMode, modes)
    : modes.find((mode) => mode.value === preferredMode)?.value;
  if (resolvedPreferredMode) return resolvedPreferredMode;

  const legacyMode = LEGACY_YOLO_MODE_MAP[agentKey];
  return preference?.yoloMode ? resolveModeForBackend(legacyMode, modes) : undefined;
}

/**
 * Resolve the mode shown for an existing conversation.
 *
 * EVE's founder-selected preference is global and therefore overrides a stale
 * per-conversation value. Other agents retain their existing session-local mode.
 */
export function resolveConversationMode(
  backend: string | undefined,
  sessionMode: string | undefined,
  availableModes: AgentModeOption[]
): string | undefined {
  const resolvedSessionMode = resolveModeForBackend(sessionMode, availableModes);
  if (!backend || !isCommandEveAcpConversation(backend)) return resolvedSessionMode;
  return resolveStoredPreferredMode(backend, availableModes) ?? resolvedSessionMode;
}

/** Save preferred mode to the agent's own config key */
export async function savePreferredMode(agentKey: string, mode: string): Promise<void> {
  try {
    if (agentKey === 'aionrs') {
      const config = configService.get('aionrs.config');
      await configService.set('aionrs.config', { ...config, preferredMode: mode });
    } else if (agentKey !== 'custom') {
      // P1 (final integrator audit, Codex): the reader prefers the seat-scoped
      // grant, so writing ONLY the legacy key made an in-chat RESTRICTION vanish
      // on restart — pick "Fragen" in a session whose grant says rung 3, and the
      // next session silently reopens at `dont_ask`. Silent re-widening is exactly
      // the consent break this whole layer exists to prevent, and my own reader
      // change introduced it.
      //
      // So for the Command EVE lane the pill writes the RECORD the reader reads,
      // and mirrors the legacy key for anything still consulting it directly.
      if (isCommandEveAcpConversation(agentKey)) {
        const rung = ladderFromBackendMode(mode);
        if (rung !== null) {
          const stored = configService.get('commandEve.authority');
          const grant = isEveAuthorityGrant(stored) ? stored : EVE_AUTHORITY_FAIL_CLOSED;
          await configService.set('commandEve.authority', withLadder(grant, rung));
        }
        // And NOTHING else. The legacy mirror used to be written here too, which
        // is how one seat's choice reached every seat that had never chosen
        // (P1, Kimi): `acp.config` is install-global, the grant is not. Every
        // Command EVE reader now goes through `getModePreference`, so the mirror
        // bought nothing and leaked authority sideways.
        //
        // A mode this lane cannot express as a rung leaves NO record, so the
        // reader keeps whatever it had. That direction is safe — it can only
        // hold or narrow, never widen — and it stays inside this seat.
        return;
      }
      const config = configService.get('acp.config');
      const backendConfig = config?.[agentKey as string] || {};
      await configService.set('acp.config', { ...config, [agentKey]: { ...backendConfig, preferredMode: mode } });
    }
  } catch {
    /* silent */
  }
}

/** Save preferred model ID to the agent's acp.config key */
export async function savePreferredModelId(agentKey: string, model_id: string): Promise<void> {
  try {
    const config = configService.get('acp.config');
    const backendConfig = config?.[agentKey as string] || {};
    await configService.set('acp.config', { ...config, [agentKey]: { ...backendConfig, preferredModelId: model_id } });
  } catch {
    /* silent */
  }
}

/** Save default aionrs provider/model so the Guid page restores it next session. */
export async function saveAionrsDefaultModel(provider_id: string, use_model: string): Promise<void> {
  try {
    await configService.set('aionrs.defaultModel', { id: provider_id, use_model });
  } catch {
    /* silent */
  }
}

/**
 * Get agent key for selection.
 *
 * Rows that are row-scoped (custom ACP / remote agents) use `agent.id` directly
 * as the key — no namespace prefix. Builtin / internal agents keep `backend` or
 * `agent_type` as the key since there is only one row per type.
 *
 * Note: preset *assistants* (not agents) still use a `custom:<assistantId>`
 * form produced inline by `AssistantSelectionArea`. That is a separate
 * selection path that points at the backend-merged assistant catalog, not
 * `AgentRegistry`.
 */
export const getAgentKey = (agent: {
  agent_type: string;
  agent_source?: AgentSource;
  backend?: string;
  id?: string;
  is_preset?: boolean;
}): string => {
  const rowScoped = agent.agent_type === 'remote' || agent.agent_source === 'custom';
  if (rowScoped && agent.id) return agent.id;
  return agent.backend || agent.agent_type;
};
