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

function getModePreference(agentKey: string): ModePreference | undefined {
  if (agentKey === 'aionrs') {
    return configService.get('aionrs.config');
  }

  // P1 (independent review, Grok): `commandEve.authority` is seat-scoped,
  // `acp.config` is NOT. Reading the mode only from `acp.config` let one seat's
  // ladder choice govern every other seat — seat A picking "Arbeiten"
  // (`dont_ask`) would open the same autonomy inside a client's seat whose own
  // grant was narrower. The seat-scoped grant therefore WINS when it exists;
  // `acp.config` remains the fallback for installs that have never opened the
  // Freigaben page and for every non-Command-EVE backend.
  if (isCommandEveAcpConversation(agentKey)) {
    // Only a REAL stored grant may win. `readEveAuthorityGrant` falls back to the
    // fail-closed default, and using that here would have silently dropped every
    // existing install from its chosen mode to "ask" on upgrade — caught by the
    // pre-existing EVE-permission-authority tests, which is exactly what they
    // are for. No grant on disk ⇒ nothing has changed for that user.
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
