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
 * dont_ask     → "Nicht fragen"  (auto-allow edits this session)
 * (1.2.16 shortened the labels to keep the start screen and in-session pill identical.)
 */
const EVE_MODE_I18N_KEY: Record<string, string> = {
  default: 'agentMode.eve.ask',
  accept_edits: 'agentMode.eve.acceptEdits',
  dont_ask: 'agentMode.eve.yolo',
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
