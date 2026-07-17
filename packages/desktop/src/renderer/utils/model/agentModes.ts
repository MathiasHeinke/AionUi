/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CODEX_MODE_NATIVE_DEFAULT,
  CODEX_MODE_NATIVE_FULL_ACCESS,
  CODEX_MODE_READ_ONLY,
} from '@/common/types/codex/codexModes';
import { COMMAND_EVE_DEFAULT_ACP_BACKEND } from '@/common/config/commandEveShell';
import { configService } from '@/common/config/configService';

/**
 * Agent mode option interface
 * 代理模式选项接口
 */
export interface AgentModeOption {
  /** Mode value sent to agent / 发送给代理的模式值 */
  value: string;
  /** Display label matching CLI display / 与 CLI 显示一致的标签 */
  label: string;
  /** Optional description / 可选描述 */
  description?: string;
}

/**
 * Agent modes configuration
 * Maps backend type to available modes
 * Labels match CLI display text exactly — no i18n.
 *
 * Note:
 * - Claude: supports session/set_mode via ACP
 *   - Modes: default, acceptEdits, plan, auto, bypassPermissions, dontAsk
 * - Qwen: ACP session/set_mode returns success but does not enforce plan mode behavior.
 *   Plan mode disabled until upstream fix. See https://github.com/QwenLM/qwen-code/issues/1806
 * - OpenCode: plan/build modes via ACP session/set_mode (no yolo support)
 * - Hermes (Command EVE): advertises default/accept_edits/dont_ask via ACP
 *   session/new (acp_adapter server _session_modes). These are the permission
 *   modes that gate Hermes tool execution — Hermes issues ACP
 *   session/request_permission for dangerous calls and the desktop renders the
 *   approval (allow once/session/always, deny). The static entry below is a
 *   label fallback; mergeWithCapabilities overrides it with the live ACP modes.
 * - Gemini: supports default/autoEdit/yolo (auto-approve at manager layer, not via ACP)
 * - Codex: ACP currently advertises `read-only` / `auto` / `full-access`
 * - Goose: mode set at startup only, not during session
 * - Cursor: agent/plan/ask modes via ACP session/set_mode (verified via `agent acp` session/new response)
 */
export const AGENT_MODES: Record<string, AgentModeOption[]> = {
  claude: [
    { value: 'default', label: 'Default' },
    { value: 'acceptEdits', label: 'Accept Edits', description: 'Auto-approve file edits, prompt for commands' },
    { value: 'plan', label: 'Plan' },
    { value: 'bypassPermissions', label: 'Auto' },
    { value: 'dontAsk', label: "Don't Ask", description: 'Block all actions except pre-approved rules' },
  ],
  // Qwen: ACP session/set_mode returns success but does not enforce plan mode behavior.
  // Plan mode disabled until upstream fix. See https://github.com/QwenLM/qwen-code/issues/1806
  qwen: [
    { value: 'default', label: 'Default' },
    { value: 'yolo', label: 'Auto' },
  ],
  opencode: [
    { value: 'build', label: 'Build' },
    { value: 'plan', label: 'Plan' },
  ],
  // Command EVE's agent. IDs match Hermes' ACP-advertised session modes
  // (acp_adapter server _session_modes); the live capability list overrides
  // these labels via mergeWithCapabilities when the ACP session reports them.
  hermes: [
    { value: 'default', label: 'Ask every time', description: 'Ask before edits and sensitive actions.' },
    {
      value: 'accept_edits',
      label: 'Semi-autonomous',
      description: 'Auto-allow workspace and /tmp edits; still asks for sensitive paths.',
    },
    {
      value: 'dont_ask',
      label: 'Auto',
      description: 'Auto-allow file edits for this session except sensitive paths.',
    },
  ],
  gemini: [
    { value: 'default', label: 'Default' },
    { value: 'autoEdit', label: 'Auto-Accept Edits' },
    { value: 'yolo', label: 'Auto' },
  ],
  aionrs: [
    { value: 'default', label: 'Default' },
    { value: 'auto_edit', label: 'Auto-Accept Edits' },
    { value: 'yolo', label: 'Auto' },
  ],
  codex: [
    { value: CODEX_MODE_READ_ONLY, label: 'Read Only' },
    { value: CODEX_MODE_NATIVE_DEFAULT, label: 'Default' },
    { value: CODEX_MODE_NATIVE_FULL_ACCESS, label: 'Full Access' },
  ],
  cursor: [
    { value: 'agent', label: 'Agent', description: 'Full agent capabilities with tool access' },
    { value: 'plan', label: 'Plan', description: 'Read-only mode for planning and designing before implementation' },
    { value: 'ask', label: 'Ask', description: 'Q&A mode - no edits or command execution' },
  ],
  snow: [
    { value: 'default', label: 'Agent', description: 'Full agent mode with tool access' },
    { value: 'yolo', label: 'Auto', description: 'Auto-approve permitted operations under configured guards' },
  ],
};

/** Renderer-only mode that records an explicit HG4 delegation for one EVE conversation. */
export const COMMAND_EVE_HG4_DELEGATED_MODE = 'dont_ask_hg4';

/** The delegated ceiling: EVE may decide through HG3.5; actions marked HG4 still ask. */
export const COMMAND_EVE_HG4_DELEGATION_AUTHORITY = 'through_hg3_5';

/** Conservative persisted scope. A broader grant requires a separate explicit UI choice. */
export const COMMAND_EVE_HG4_DELEGATION_SCOPE = 'conversation';

const COMMAND_EVE_BACKEND_MODE_ORDER = ['default', 'accept_edits', 'dont_ask'] as const;
const COMMAND_EVE_MODE_AUTHORITY_RANK: Readonly<Record<string, number>> = {
  default: 0,
  accept_edits: 1,
  dont_ask: 2,
  [COMMAND_EVE_HG4_DELEGATED_MODE]: 3,
};

const COMMAND_EVE_HG4_MODE_OPTION: AgentModeOption = {
  value: COMMAND_EVE_HG4_DELEGATED_MODE,
  label: 'Auto through HG3.5 (this chat)',
  description:
    'Explicit HG4 delegation for this conversation. Warned sensitive actions through HG3.5 may run; HG4 actions still ask.',
};

type EveHg4DelegationRecord = {
  active: boolean;
  scope: typeof COMMAND_EVE_HG4_DELEGATION_SCOPE;
  authority: typeof COMMAND_EVE_HG4_DELEGATION_AUTHORITY;
  conversationId: string;
  backendMode: 'dont_ask';
  grantedAt?: string;
  riskAcknowledgedAt?: string;
  revokedAt?: string;
  updatedAt: string;
};

type EveHg4DelegationAuditEntry = {
  event: 'granted' | 'revoked';
  scope: typeof COMMAND_EVE_HG4_DELEGATION_SCOPE;
  authority: typeof COMMAND_EVE_HG4_DELEGATION_AUTHORITY;
  conversationId: string;
  backendMode: 'dont_ask';
  timestamp: string;
};

type EvePermissionBackendConfig = {
  preferredMode?: string;
  hg4Delegations?: Record<string, EveHg4DelegationRecord>;
  hg4DelegationAudit?: EveHg4DelegationAuditEntry[];
};

const EVE_HG4_AUDIT_LIMIT = 50;

/** Validate a durable, explicitly acknowledged grant for exactly one EVE conversation. */
export function hasActiveEveHg4Delegation(backend: string, conversationId: string): boolean {
  const config = configService.get('acp.config');
  const backendConfig = config?.[backend] as EvePermissionBackendConfig | undefined;
  const grant = backendConfig?.hg4Delegations?.[conversationId];
  return Boolean(
    backendConfig?.preferredMode === 'dont_ask' &&
    grant?.active === true &&
    grant.scope === COMMAND_EVE_HG4_DELEGATION_SCOPE &&
    grant.authority === COMMAND_EVE_HG4_DELEGATION_AUTHORITY &&
    grant.conversationId === conversationId &&
    grant.backendMode === 'dont_ask' &&
    typeof grant.grantedAt === 'string' &&
    typeof grant.riskAcknowledgedAt === 'string'
  );
}

/** Persist or revoke one conversation-scoped HG4 delegation and append its audit event. */
export async function persistEvePermissionAuthority(input: {
  backend: string;
  conversationId: string;
  preferredMode: string;
  hg4Delegated: boolean;
}): Promise<void> {
  const config = configService.get('acp.config');
  const backendConfig = (config?.[input.backend] ?? {}) as EvePermissionBackendConfig;
  const previousGrant = backendConfig.hg4Delegations?.[input.conversationId];
  const timestamp = new Date().toISOString();
  const nextDelegations = { ...backendConfig.hg4Delegations };
  const nextAudit = Array.isArray(backendConfig.hg4DelegationAudit) ? [...backendConfig.hg4DelegationAudit] : [];

  if (input.hg4Delegated) {
    nextDelegations[input.conversationId] = {
      active: true,
      scope: COMMAND_EVE_HG4_DELEGATION_SCOPE,
      authority: COMMAND_EVE_HG4_DELEGATION_AUTHORITY,
      conversationId: input.conversationId,
      backendMode: 'dont_ask',
      grantedAt: timestamp,
      riskAcknowledgedAt: timestamp,
      updatedAt: timestamp,
    };
    nextAudit.push({
      event: 'granted',
      scope: COMMAND_EVE_HG4_DELEGATION_SCOPE,
      authority: COMMAND_EVE_HG4_DELEGATION_AUTHORITY,
      conversationId: input.conversationId,
      backendMode: 'dont_ask',
      timestamp,
    });
  } else if (previousGrant) {
    nextDelegations[input.conversationId] = {
      ...previousGrant,
      active: false,
      revokedAt: timestamp,
      updatedAt: timestamp,
    };
    if (previousGrant.active) {
      nextAudit.push({
        event: 'revoked',
        scope: COMMAND_EVE_HG4_DELEGATION_SCOPE,
        authority: COMMAND_EVE_HG4_DELEGATION_AUTHORITY,
        conversationId: input.conversationId,
        backendMode: 'dont_ask',
        timestamp,
      });
    }
  }

  const nextConfig = {
    ...config,
    [input.backend]: {
      ...backendConfig,
      preferredMode: input.preferredMode,
      hg4Delegations: nextDelegations,
      hg4DelegationAudit: nextAudit.slice(-EVE_HG4_AUDIT_LIMIT),
    },
  } as unknown as NonNullable<typeof config>;
  await configService.set('acp.config', nextConfig);
}

/**
 * Bound the EVE selector to the three real Hermes modes plus the explicit,
 * conversation-scoped HG4 delegation. Runtime/cached values outside this
 * allowlist never become clickable permission modes.
 */
export function boundCommandEveModeMenu(
  modes: ReadonlyArray<AgentModeOption>,
  includeHg4Delegation: boolean
): AgentModeOption[] {
  const offeredValues = new Set(modes.map((mode) => mode.value));
  const staticModes = new Map(AGENT_MODES.hermes.map((mode) => [mode.value, mode]));
  const bounded = COMMAND_EVE_BACKEND_MODE_ORDER.flatMap((value) => {
    // Keep the restrictive escape available even when runtime/cached capability
    // data is incomplete. Wider modes still require an explicit backend offer.
    if (value !== 'default' && !offeredValues.has(value)) return [];
    const mode = staticModes.get(value);
    return mode ? [{ ...mode }] : [];
  });

  if (includeHg4Delegation && offeredValues.has('dont_ask')) {
    bounded.push({ ...COMMAND_EVE_HG4_MODE_OPTION });
  }
  return bounded;
}

/** Map the renderer-only HG4 grant back to the real mode understood by Hermes. */
export function commandEveBackendMode(mode: string): string {
  return mode === COMMAND_EVE_HG4_DELEGATED_MODE ? 'dont_ask' : mode;
}

/** True when a requested EVE mode widens authority and therefore requires backend acknowledgement first. */
export function isCommandEveModeExpansion(currentMode: string, requestedMode: string): boolean {
  const currentRank = COMMAND_EVE_MODE_AUTHORITY_RANK[currentMode];
  const requestedRank = COMMAND_EVE_MODE_AUTHORITY_RANK[requestedMode];
  if (requestedRank === undefined) return true;
  if (currentRank === undefined) return requestedRank > 0;
  return requestedRank > currentRank;
}

/**
 * Get available modes for a given backend
 * Returns empty array if backend doesn't support mode switching
 *
 * @param backend - Agent backend type
 * @returns Array of available modes
 */
export function getAgentModes(backend: string | undefined): AgentModeOption[] {
  if (!backend) return [];
  return AGENT_MODES[backend] || [];
}

/**
 * Cross-backend permission-mode synonyms. Different ACP backends spell the same
 * intent differently: hermes' auto-approve is `dont_ask`, gemini/qwen/aionrs call
 * it `yolo`, claude `bypassPermissions`; "accept edits" is `accept_edits` (hermes)
 * vs `auto_edit` (aionrs). A conversation created under one vocabulary (e.g. the
 * start screen saved `session_mode: 'yolo'`) must resolve to THIS backend's
 * equivalent instead of silently snapping back to the default — that mismatch is
 * exactly the "auto mode jumps to Standard after the first send" bug.
 */
const MODE_SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['yolo', 'dont_ask', 'bypassPermissions'], // auto-approve
  ['default', 'ask'], // ask every time
  ['accept_edits', 'acceptEdits', 'auto_edit', 'autoEdit'], // semi-autonomous
];

/**
 * Resolve a (possibly foreign-vocabulary) mode value to a mode this backend
 * actually offers. Exact match wins; otherwise map via the synonym groups;
 * returns undefined when nothing matches so the caller can fall back to default.
 */
export function resolveModeForBackend(value: string | undefined, modes: AgentModeOption[]): string | undefined {
  if (!value) return undefined;
  if (modes.some((m) => m.value === value)) return value;
  const group = MODE_SYNONYM_GROUPS.find((g) => g.includes(value));
  if (group) {
    const match = modes.find((m) => group.includes(m.value));
    if (match) return match.value;
  }
  return undefined;
}

/**
 * Maps Hermes' ACP-advertised EVE permission-mode IDs to the clean, founder-
 * approved EVE labels (i18n keys under `agentMode.eve.*`). EVE honestly enforces
 * exactly these three real Hermes modes — no fake Plan-Modus and no extra buttons
 * the runtime can't honour. Any mode value not in this map (e.g. a future Hermes
 * mode) falls through to the generic `agentMode.<value>` key so nothing renders blank.
 *
 * default      → "Fragen"        (ask before edits / sensitive actions)
 * accept_edits → "Auto-Edits"    (auto-allow workspace edits)
 * dont_ask     → "Auto"          (auto-allow edits this session)
 * (1.7.91 removed internal "YOLO" wording from the user-facing labels.)
 */
const EVE_MODE_I18N_KEY: Record<string, string> = {
  default: 'agentMode.eve.ask',
  accept_edits: 'agentMode.eve.acceptEdits',
  dont_ask: 'agentMode.eve.yolo',
  [COMMAND_EVE_HG4_DELEGATED_MODE]: 'agentMode.eve.autoThroughHg35',
};

const EVE_MODE_DESCRIPTION_I18N_KEY: Record<string, string> = {
  default: 'agentMode.eve.askDescription',
  accept_edits: 'agentMode.eve.acceptEditsDescription',
  dont_ask: 'agentMode.eve.yoloDescription',
  [COMMAND_EVE_HG4_DELEGATED_MODE]: 'agentMode.eve.autoThroughHg35Description',
};

/**
 * Minimal translator signature (matches react-i18next's `t`). Kept local so the
 * formatter factory does not pull a UI dependency into this pure util.
 */
type TranslateFn = (key: string, opts?: { defaultValue?: string }) => string;

/**
 * Build a `modeLabelFormatter` for `AgentModeSelector` that is EVE-aware.
 *
 * - For the Command EVE (Hermes) backend it maps the three honest permission
 *   modes to the clean EVE labels via `agentMode.eve.*`.
 * - For every other backend it preserves the existing behaviour: translate the
 *   raw mode value via `agentMode.<value>`, falling back to the static label.
 *
 * Apply this at the EVE call sites only so other backends' labels are untouched.
 */
export function createModeLabelFormatter(
  backend: string | undefined,
  t: TranslateFn
): (mode: AgentModeOption) => string {
  const isEve = backend === COMMAND_EVE_DEFAULT_ACP_BACKEND;
  return (mode: AgentModeOption): string => {
    if (isEve) {
      const eveKey = EVE_MODE_I18N_KEY[mode.value];
      if (eveKey) return t(eveKey, { defaultValue: mode.label });
    }
    return t(`agentMode.${mode.value}`, { defaultValue: mode.label });
  };
}

/** Translate EVE permission explanations while preserving native labels for other ACP backends. */
export function createModeDescriptionFormatter(
  backend: string | undefined,
  t: TranslateFn
): (mode: AgentModeOption) => string | undefined {
  const isEve = backend === COMMAND_EVE_DEFAULT_ACP_BACKEND;
  return (mode: AgentModeOption): string | undefined => {
    if (!mode.description) return undefined;
    if (isEve) {
      const eveKey = EVE_MODE_DESCRIPTION_I18N_KEY[mode.value];
      if (eveKey) return t(eveKey, { defaultValue: mode.description });
    }
    return mode.description;
  };
}

/**
 * Convert a snake_case mode value to a title-cased label.
 * e.g. 'auto_edit' -> 'Auto Edit', 'plan' -> 'Plan'
 */
function toTitleCase(value: string): string {
  return value
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Merge static mode definitions with dynamic capabilities from the agent.
 * - If capabilityModes is null/empty, return static modes (fallback).
 * - Otherwise, return only modes reported by capabilities, preserving
 *   static labels when available and title-casing unknown modes.
 *
 * @param backend - Agent backend type
 * @param capabilityModes - Dynamic modes from capabilities.modes (null = not available)
 */
export function mergeWithCapabilities(
  backend: string | undefined,
  capabilityModes: string[] | null
): AgentModeOption[] {
  const staticModes = getAgentModes(backend);
  if (!capabilityModes || capabilityModes.length === 0) {
    return staticModes;
  }

  const staticMap = new Map(staticModes.map((m) => [m.value, m]));
  return capabilityModes.map((value) => staticMap.get(value) ?? { value, label: toTitleCase(value) });
}

/**
 * Check if a backend supports mode switching during session
 *
 * @param backend - Agent backend type
 * @returns true if mode switching is supported
 */
export function supportsModeSwitch(backend: string | undefined): boolean {
  if (!backend) return false;
  return backend in AGENT_MODES && AGENT_MODES[backend].length > 0;
}

/**
 * Full-auto mode value per backend.
 * Re-exported from common for backward compatibility.
 */
export { getFullAutoMode } from '@/common/types/agent/agentModes';
