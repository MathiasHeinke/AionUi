import type { AcpInitializeResult, AcpSessionConfigOption, AcpSessionModes } from '@/common/types/platform/acpTypes';
import type { SpeechToTextConfig } from '@/common/types/provider/speech';
import type { ICssTheme, IMcpServer, TProviderWithModel } from '@/common/config/storage';
import type { Theme } from '@/common/theme/types';

export type ConfigKeyMap = {
  'google.config': {
    proxy?: string;
  };
  'codex.config':
    | { cli_path?: string; yoloMode?: boolean; sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' }
    | undefined;
  'acp.config': {
    [backend: string]: {
      auth_methodId?: string;
      authToken?: string;
      lastAuthTime?: number;
      cli_path?: string;
      yoloMode?: boolean;
      preferredMode?: string;
      preferredModelId?: string;
      promptTimeout?: number;
    };
  };
  'acp.promptTimeout': number | undefined;
  'acp.agentIdleTimeout': number | undefined;
  'acp.cachedInitializeResult': Record<string, AcpInitializeResult> | undefined;
  'acp.cached_config_options': Record<string, AcpSessionConfigOption[]> | undefined;
  'acp.cachedModes': Record<string, AcpSessionModes> | undefined;
  'mcp.config': IMcpServer[];
  language: string;
  theme: string;
  colorScheme: string;
  'ui.zoomFactor': number | undefined;
  'ui.fontSize.chat': number | undefined;
  'ui.fontSize.markdown': number | undefined;
  'ui.fontSize.code': number | undefined;
  'window.bounds': { x?: number; y?: number; width: number; height: number } | undefined;
  'webui.desktop.enabled': boolean | undefined;
  'webui.desktop.allowRemote': boolean | undefined;
  'webui.desktop.port': number | undefined;
  customCss: string;
  'css.themes': ICssTheme[];
  'css.activeThemeId': string;
  'theme.activeId': string;
  'theme.userThemes': Theme[];
  'aionrs.config': { preferredMode?: string } | undefined;
  'aionrs.defaultModel': { id: string; use_model: string } | undefined;
  'tools.imageGenerationModel': TProviderWithModel & { switch?: boolean };
  'tools.speechToText': SpeechToTextConfig | undefined;
  'workspace.pasteConfirm': boolean | undefined;
  'upload.saveToWorkspace': boolean | undefined;
  'guid.lastSelectedAgent': string | undefined;
  'system.closeToTray': boolean | undefined;
  'system.notificationEnabled': boolean | undefined;
  'system.cronNotificationEnabled': boolean | undefined;
  'system.keepAwake': boolean | undefined;
  'system.autoPreviewOfficeFiles': boolean | undefined;
  'commandEve.runtimeStatusVisible': boolean | undefined;
  // Show the data-boundary (egress) signal in the runtime status strip. Only ever
  // surfaces a REAL action (EVE redacted/blocked an outbound secret); it never
  // claims "all clear" (we can't prove a negative). Founder 2026-06-26 is skeptical
  // of any reassuring claim, so this is an off-switch; default ON so a real
  // redaction stays visible to the operator. undefined => treated as true.
  'commandEve.egressStatusVisible': boolean | undefined;
  'commandEve.modelWarmupEnabled': boolean | undefined;
  'commandEve.localModelTierId': string | undefined;
  /**
   * The single EVE inference picker selection (two-group picker). One of:
   *   - 'command-eve-local:<localTierId>'        (Privat lokal)
   *   - 'command-eve-inference:<eveTierId>'       (EVE Inference cloud)
   * Absent ⇒ fall back to the local default tier.
   */
  'commandEve.inferenceSelection': string | undefined;
  'commandEve.executionMode': 'observed' | 'delegated' | 'autonomous' | undefined;
  /**
   * "Dein Team" per-worker active/paused state. A map of stable roster
   * `agent_id` → 'active' | 'paused' | 'off'. Absent ids fall back to the
   * roster default (active). The non-empty-floor guard (eveTeamControlsCore)
   * enforces that this map can never describe an empty company — at least one
   * free local always-on worker stays active.
   */
  'commandEve.teamWorkerStatus': Record<string, 'active' | 'paused' | 'off'> | undefined;
  /**
   * CLI-Keystone worker assignments. A map of stable roster `agent_id` →
   * { kind: 'claude' | 'codex' | 'image', cli_path?, cli_version? } — the
   * PERSISTED record the worker-assignment card writes (it is no longer a no-op
   * stub). This is the namespace JOIN: a runnable CLI worker is bound to a real
   * EVE role, never an invented id. The producer (eveWorkerAssignmentCore)
   * translates these into the Hermes routing the runtime consumes — Codex flips
   * `model.openai_runtime` (version-gated), Claude resolves an `acp_command` ACP
   * delegate — and is status-gated by the existing dispatch rule. Absent =
   * no CLI worker bound (EVE answers on its normal lane).
   */
  'commandEve.workerAssignments':
    | Record<string, { kind: 'claude' | 'codex' | 'image'; cli_path?: string; cli_version?: string }>
    | undefined;
  // --- Credits / billing UX (Lane 3, WG#3 credits-billing spec) ---
  /**
   * Day-0 onboarding seed flag: set true once the user has provided ONE real
   * client input (connect a client / paste a brief) that seeds the Company-Brain.
   * Once set, the force-onboarding prompt never re-nags. (creditsCore
   * `shouldForceDayZeroOnboarding`.)
   */
  'commandEve.clientSeeded': boolean | undefined;
  /**
   * STICKY dismissal of the forced Day-0 onboarding modal. Set true when the user
   * clicks "Later" / closes the seed modal WITHOUT seeding. Once set, the forced
   * modal never re-pops on a later launch (the user can still seed any time from
   * Settings → Company Brain). Distinct from `clientSeeded`: dismissed ≠ seeded,
   * so the Settings panel still shows "not yet seeded". (useDayZeroOnboarding.)
   */
  'commandEve.clientSeedDismissed': boolean | undefined;
  /**
   * The blended €/h rate used to monetize the €-value receipt ("≈ ~Nh / ~M€ of
   * your work"). Founder-overridable; defaults to DEFAULT_VALUE_RECEIPT_HOURLY_EUR.
   */
  'commandEve.valueReceiptHourlyEur': number | undefined;
  /**
   * Whether a churn signal has surfaced — gates the hidden Solo-49 plan into the
   * pricing list / save-offer (spec §1, §6). Default absent ⇒ Solo stays hidden.
   */
  'commandEve.churnSignal': boolean | undefined;
  /**
   * Per-OPERATOR report brand (RPT-1 / RPT-3). Intentionally INSTALL-GLOBAL, NOT
   * seat-scoped: the brand is the operator's own (their agency), seat-independent,
   * and contains ZERO client data — it is the only non-seat-A content allowed on a
   * report deliverable, and it is NEVER Command EVE's. Absent ⇒ neutral, unbranded
   * output. `logoDataUri` MUST be a self-contained `data:` URI (no remote asset;
   * keeps the print HTML CSP-safe).
   */
  'commandEve.reportBrand': { displayName?: string; logoDataUri?: string; footer?: string } | undefined;
  'assistant.telegram.defaultModel': { id: string; use_model: string } | undefined;
  'assistant.telegram.agent':
    | { agent_type: string; backend?: string; id?: string; custom_agent_id?: string; name?: string }
    | undefined;
  'assistant.lark.defaultModel': { id: string; use_model: string } | undefined;
  'assistant.lark.agent':
    | { agent_type: string; backend?: string; id?: string; custom_agent_id?: string; name?: string }
    | undefined;
  'assistant.dingtalk.defaultModel': { id: string; use_model: string } | undefined;
  'assistant.dingtalk.agent':
    | { agent_type: string; backend?: string; id?: string; custom_agent_id?: string; name?: string }
    | undefined;
  'assistant.weixin.defaultModel': { id: string; use_model: string } | undefined;
  'assistant.weixin.agent':
    | { agent_type: string; backend?: string; id?: string; custom_agent_id?: string; name?: string }
    | undefined;
  'assistant.wecom.defaultModel': { id: string; use_model: string } | undefined;
  'assistant.wecom.agent':
    | { agent_type: string; backend?: string; id?: string; custom_agent_id?: string; name?: string }
    | undefined;
  'skillsMarket.enabled': boolean | undefined;
  'pet.enabled': boolean | undefined;
  'pet.size': number | undefined;
  'pet.dnd': boolean | undefined;
  'pet.confirmEnabled': boolean | undefined;
  // One-shot completion flags for legacy → backend migrations. Kept in the
  // local config file (not the backend client-preferences bag) so a downgrade
  // to a pre-flag build still re-reads the legacy data unchanged. See
  // `migrateProviders` / `migrateAssistantsToBackend` (ELECTRON-1KT).
  'migration.providersMigrated_v1': boolean | undefined;
  'migration.assistantsMigrated_v1': boolean | undefined;
};

export type ConfigKey = keyof ConfigKeyMap;
