/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// configureChromium sets app name (dev isolation) and Chromium flags — must run before
// ANY module that calls app.getPath('userData'), because Electron caches the path on first call.
import './process/utils/configureChromium';
import { installGpuCrashHandler } from './process/utils/gpuRecovery';
import { closeSentry, initSentry, scheduleStartupLogReport, setSentryDeviceId } from './sentry';
import {
  isTelemetryAllowed,
  readConsent,
  setConsent,
  TELEMETRY_CONSENT_GET_CHANNEL,
  TELEMETRY_CONSENT_SET_CHANNEL,
  type TelemetryConsentBridgeResult,
} from './process/commandEve/telemetryConsentCore';
import { bridge } from '@office-ai/platform';

// Telemetry is opt-in (default OFF). Sentry is only ever initialized when the
// user has explicitly consented in the privacy settings — fail CLOSED.
if (isTelemetryAllowed()) {
  initSentry();
}

import './process/utils/configureConsoleLog';
import { app, BrowserWindow, ipcMain, nativeImage, powerMonitor, shell } from 'electron';
import fixPath from 'fix-path';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initMainAdapterWithWindow, isTrustedAdapterIpcSender } from './common/adapter/main';
import { ipcBridge } from './common';
import { initializeProcess } from './process';
import { ProcessConfig } from './process/utils/initStorage';
import { EVE_INFERENCE_FUNCTION_URL, resolveCommandEveWarmupLane } from './common/config/eveInferenceCore';
import {
  COMMAND_EVE_SHELL_ENABLED,
  COMMAND_EVE_BONSAI_ACP_MODEL_ID,
  COMMAND_EVE_BONSAI_RUNTIME_MODEL_ID,
  COMMAND_EVE_COLIBRI_ACP_MODEL_ID,
  COMMAND_EVE_COLIBRI_RUNTIME_MODEL_ID,
  getCommandEveLocalModelTier,
  getCommandEveLocalModelTierForRuntimeModel,
  normalizeCommandEveLocalModelTierId,
} from './common/config/commandEveShell';
import { readLicenseWire } from './common/config/licenseWireAtRest';
import type { EveTeamWorkerStatusMap } from './common/config/eveTeamControlsCore';
import {
  buildTeamDirectiveRoles,
  codexRuntimeForConfig,
  resolveAssignedClaudeDelegate,
  type EveTeamDirectiveRole,
  type EveWorkerAssignmentMap,
} from './common/config/eveWorkerAssignmentCore';
import type {
  CommandEveEveCloudRoute,
  CommandEveHonchoDeriverRoute,
  CommandEveHonchoDeriverRouteResolver,
  CommandEveLocalOpenAiRoute,
  CommandEveLocalOpenAiRoutingResolver,
} from './process/commandEve/ollamaOpenAiShim';
import { applyLauncherWiring, clearHermesDelegateTransportEnv } from './process/commandEve/eveWorkerLauncherCore';
import { resolveDispatchAgentId } from './process/commandEve/eveAgentTaskRegistry';
import { resolveTeamManageBearer, teamManageProposeHandler } from './process/commandEve/eveTeamManageMain';
import {
  artifactCapabilityCallHandler,
  resolveArtifactCapabilityBearer,
} from './process/commandEve/artifactCapabilityLoopback';
import {
  kanbanAcpProposeHandler,
  readKanbanAcpBoard,
  resolveKanbanAcpBearer,
  setKanbanAcpSeatSwitchResolver,
} from './process/commandEve/kanbanAcpMain';
import { isCommandEveSeatSwitchInFlight } from './process/bridge/commandEveBridge';
import { buildCommandEveShimHonchoDeriverRouteResolver } from './process/commandEve/honchoDeriverRouteCore';
import { resolveHonchoHomeForSeat } from './process/commandEve/honchoRuntimeConfigCore';
import { resolveHonchoRenderForSeat, type HonchoRenderInput } from './process/commandEve/honchoRuntimeRenderCore';
import {
  resolveCommandEveRuntimeBootstrapPaths,
  runtimeReceiptAllowsLocalModelRequest,
  runtimeReceiptAllowsLocalModelWarmup,
  type RuntimeBootstrapReceipt,
} from './process/commandEve/runtimeBootstrapCore';
import { shouldRestartWindowsBackendAfterRuntimeBootstrap } from './process/commandEve/windows/runtimeActivationCore';
import { readHonchoReadyState } from './process/commandEve/honchoReadyStateFile';
import { getActiveSeatContextRevision, getActiveSeatId } from './process/commandEve/seatContextCore';
import {
  failCommandEveBackendAuthorityClosed,
  restartCommandEveBackendForSeat,
  runCommandEveBackendCrashRecovery,
  runCommandEveBackendRespawnAfterStop,
  setCommandEveBackendAuthorityFailClosed,
  setCommandEveBackendRestart,
} from './process/commandEve/seatSwitchRuntime';
import { getCdpBridgeHandle } from './process/resources/builtinMcp/cdpBridgeRegistry';
import { restoreActiveSeatFromPointer } from './process/commandEve/activeSeatPointerStore';
import {
  readInferenceSelectionFromBackendStrict,
  resolveEveCloudRouteFromBackend,
} from './process/commandEve/inferenceSelectionBackendRead';
import { resolveCommandEveManagedVisualTurn } from './process/commandEve/managedVisualTurnAuthorizationCore';
import { CommandEveManagedVisualAuthorizationError } from './process/commandEve/shimPublicError';
import { readCommandEveSettingsFromBackend } from './process/commandEve/commandEveBackendSettingsRead';
import { readCommandEveCloudVisualPolicy } from './process/commandEve/visual/cloudVisualPolicyMain';
import { type EveRememberedCommand } from '@/common/config/eveRememberedCommandsCore';
import { rememberedCommandsFromSettings } from '@/common/config/eveAuthorityStoreCore';
import { createTeamWorkerStatusResolver } from './process/commandEve/teamWorkerStatusResolverCore';
import childProcess from 'node:child_process';
import { startCuratorTickTimer } from './process/commandEve/curatorTickCore';
import { EVE_AUTHORITY_FAIL_CLOSED, readEveAuthorityGrant } from './common/config/eveAuthorityCore';
import { parseConnectedSelection, repairInferenceSelection } from './common/config/eveInferenceCore';
import { resolveConnectedProviderRoute } from './common/config/eveConnectedProviderCore';
import { readInferenceLaneStateFromBackendStrict } from './process/commandEve/inferenceSelectionBackendRead';
import { httpRequest } from './common/adapter/httpBridge';
import type { IProvider } from './common/config/storage';
import type { TMessage } from './common/chat/chatLib';
import type { CommandEveConnectedProviderRoute } from './process/commandEve/ollamaOpenAiShim';
import {
  appendMainOwnedTypedUIProviderCompletionReceipt,
  type MainOwnedTypedUIProviderCompletionInput,
} from './process/commandEve/typedUIProvenanceAttestationCore';
import { attestDurableTypedUIArtifact } from './process/commandEve/typedUIArtifactAttestationMain';
import { renderEveAuthorityRuntime, type EveAuthorityRuntime } from './common/config/eveAuthorityRuntimeCore';
import { createEgressRedactionModeResolver } from './process/commandEve/egressRedactionModeResolverCore';
import { createCommandEveRegisteredProcessIdentityProbeProvider } from './process/commandEve/registeredProcessIdentityProbeCore';
import {
  buildCompanyOsRootCandidates,
  COMPANY_OS_ROOT_MARKER,
  resolveCompanyOsRoot,
} from './process/commandEve/companyOsRootResolveCore';
import { getDataPath } from '@process/utils/utils';
import { registerWindowMaximizeListeners } from '@process/bridge';
import { COMMAND_EVE_BACKEND_TERMINATION_UNPROVEN, BackendLifecycleManager } from '@aionui/web-host';
import { resolveBinaryPath } from '@process/backend';
import './process/bridge/feedbackBridge';
import './process/bridge/desktopShellBridge';
import { wasLaunchedAtLogin } from '@process/bridge/applicationBridge';
import { onLanguageChanged } from './process/bridge/systemSettingsBridge';
import { setInitialLanguage } from '@process/services/i18n';
import { setupApplicationMenu, setupEditableContextMenu } from './process/utils/appMenu';
import {
  hardenAttachedWebviewPreferences,
  isAllowedWebviewSource,
  isAllowedWebviewNavigation,
  isSafeExternalNavigationUrl,
  isTrustedMainRendererUrl,
} from './process/security/mainWindowSecurityCore';
import { configureMainRendererSessionPermissions } from './process/security/sessionPermissionCore';
import { installQuitCleanup } from './process/startup/quitCleanup';
import {
  configureMainRendererBackendCapability,
  installMainProcessLocalBackendCapability,
} from './process/security/localBackendCapabilityCore';
import { classifyBackendStartupFailure } from './process/startup/backendStartupFailure';
import { startWebHost } from '@aionui/web-host';
import { initializeZoomFactor, setupZoomForWindow } from './process/utils/zoom';
import {
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  attachWindowBoundsPersistence,
  loadSavedWindowBounds,
  resolveInitialBounds,
} from './process/utils/windowBounds';
import { deliverDeepLink, handleDeepLinkUrl, PROTOCOL_SCHEME, takePendingDeepLink } from './process/utils/deepLink';
import {
  bindMainWindowReferences,
  showAndFocusMainWindow,
  showOrCreateMainWindow,
} from './process/utils/mainWindowLifecycle';
import {
  loadUserWebUIConfig,
  resolveRemoteAccess,
  resolveWebUIPort,
  restoreDesktopWebUIFromPreferences,
} from './process/utils/webuiConfig';
import {
  createOrUpdateTray,
  destroyTray,
  getCloseToTrayEnabled,
  getIsQuitting,
  refreshTrayMenu,
  setCloseToTrayEnabled,
  setIsQuitting,
} from './process/utils/tray';
// @ts-expect-error - electron-squirrel-startup doesn't have types
import electronSquirrelStartup from 'electron-squirrel-startup';

// ============ Command EVE license-key resolution (COMPA-593) ============
// In the packaged app, electron-builder `extraResources: { from: public, to: . }`
// copies public/ — including the founder AND server license public keys — into
// Contents/Resources. entitlementCore's resolver already documents
// COMMAND_EVE_RESOURCES_PATH as the packaged-app key location, but nothing ever
// set it, so resolution fell through to `process.cwd()/public` — which is '/'
// for a Finder launch, where no key exists. Point the resolver at the real
// resources root so BOTH trusted keys load and server-minted (SaaS) CEVE.v1
// codes verify offline. Overwrite any ambient value unconditionally: a signed
// build must never accept a caller-selected key directory. Dev
// (app.isPackaged === false) keeps the cwd/public path and test seams.
if (app.isPackaged) {
  process.env.COMMAND_EVE_RESOURCES_PATH = process.resourcesPath;
}

// ============ Single Instance Lock ============
// Acquire lock early so the second instance quits before doing unnecessary work.
// When a second instance starts (e.g. from protocol URL), it sends its data
// to the first instance via second-instance event, then quits.
const isE2ETestMode = process.env.AIONUI_E2E_TEST === '1';
const skipSingleInstanceLock = isE2ETestMode || process.env.AIONUI_MULTI_INSTANCE === '1';
const shouldBlockStartupForCommandEveRuntimeBootstrap =
  process.env.COMMAND_EVE_RUNTIME_BOOTSTRAP_WAIT === '1' &&
  process.env.COMMAND_EVE_ALLOW_STARTUP_BLOCKING === '1' &&
  !isE2ETestMode;
const deepLinkArgIndex = process.argv.findIndex((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
let deepLinkFromArgv = deepLinkArgIndex >= 0 ? process.argv[deepLinkArgIndex] : undefined;
const gotTheLock = skipSingleInstanceLock
  ? true
  : app.requestSingleInstanceLock(deepLinkFromArgv ? { deepLinkUrl: deepLinkFromArgv } : {});
if (deepLinkArgIndex >= 0) process.argv[deepLinkArgIndex] = `${PROTOCOL_SCHEME}://redacted`;
deepLinkFromArgv = undefined;
if (!gotTheLock) {
  console.warn('[CommandEVE] Another instance is already running; current process will exit.');
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    // Prefer additionalData (reliable on all platforms), fallback to argv scan
    const deepLinkUrl =
      (additionalData as { deepLinkUrl?: string })?.deepLinkUrl ||
      argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
    if (deepLinkUrl) {
      handleDeepLinkUrl(deepLinkUrl);
    }
    // Focus existing window or recreate one if needed.
    if (isWebUIMode || isResetPasswordMode) {
      return;
    }

    // Skip window creation if app hasn't finished initializing
    if (!appReadyDone) return;

    if (app.isReady()) {
      showOrCreateMainWindow({
        mainWindow,
        createWindow: () => {
          console.log('[CommandEVE] second-instance received with no active main window, recreating main window');
          createWindow();
        },
      });
    }
  });
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
// 修复 macOS 和 Linux 下 GUI 应用的 PATH 环境变量,使其与命令行一致
if (process.platform === 'darwin' || process.platform === 'linux') {
  fixPath();

  // Supplement nvm paths that fix-path might miss (nvm is often only in .zshrc, not .zshenv)
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
  const nvmVersionsDir = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(nvmVersionsDir)) {
    try {
      const versions = fs.readdirSync(nvmVersionsDir);
      const nvmPaths = versions.map((v) => path.join(nvmVersionsDir, v, 'bin')).filter((p) => fs.existsSync(p));
      if (nvmPaths.length > 0) {
        const currentPath = process.env.PATH || '';
        const missingPaths = nvmPaths.filter((p) => !currentPath.includes(p));
        if (missingPaths.length > 0) {
          process.env.PATH = [...missingPaths, currentPath].join(path.delimiter);
        }
      }
    } catch {
      // Ignore errors when reading nvm directory
    }
  }
}

// Handle Squirrel startup events (Windows installer)
if (electronSquirrelStartup) {
  app.quit();
}

// Global error handlers for main process
// Sentry automatically captures these, but we keep the handlers to prevent Electron's default error dialog
process.on('uncaughtException', (_error) => {
  // Sentry captures this automatically
});

process.on('unhandledRejection', (_reason, _promise) => {
  // Sentry captures this automatically
});

const hasSwitch = (flag: string) => process.argv.includes(`--${flag}`) || app.commandLine.hasSwitch(flag);
const getSwitchValue = (flag: string): string | undefined => {
  const withEqualsPrefix = `--${flag}=`;
  const equalsArg = process.argv.find((arg) => arg.startsWith(withEqualsPrefix));
  if (equalsArg) {
    return equalsArg.slice(withEqualsPrefix.length);
  }

  const argIndex = process.argv.indexOf(`--${flag}`);
  if (argIndex !== -1) {
    const nextArg = process.argv[argIndex + 1];
    if (nextArg && !nextArg.startsWith('--')) {
      return nextArg;
    }
  }

  const cliValue = app.commandLine.getSwitchValue(flag);
  return cliValue || undefined;
};
const hasCommand = (cmd: string) => process.argv.includes(cmd);

const isWebUIMode = hasSwitch('webui');
const isRemoteMode = hasSwitch('remote');
const isResetPasswordMode = hasCommand('--resetpass');
const isVersionMode = hasCommand('--version') || hasCommand('-v');

// Flag to distinguish intentional quit from unexpected exit in WebUI mode
let isExplicitQuit = false;

// Guard against premature window creation (e.g. macOS 'activate' firing during init).
// The activate event fires on first launch before handleAppReady finishes initializeProcess(),
// causing the renderer to load and compete with initStorage on the serial configFile queue,
// which blocks startup for 100-265 seconds.
let appReadyDone = false;

let mainWindow: BrowserWindow;
const backendManager = new BackendLifecycleManager(
  {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
  },
  resolveBinaryPath,
  createCommandEveRegisteredProcessIdentityProbeProvider({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    arch: process.arch,
  })
);
const COMMAND_EVE_CRASH_RECOVERY_QUEUE_WAIT_MS = 60_000;
const COMMAND_EVE_DEFERRED_RUNTIME_RESTART_QUEUE_WAIT_MS = 300_000;
const runCommandEveCrashRestartUnderReservation = async (crash: {
  claimIfCurrent: () => boolean;
}): Promise<number | undefined> =>
  runCommandEveBackendCrashRecovery({
    claimIfCurrent: crash.claimIfCurrent,
    recover: async (restartLease) => {
      // Command EVE owns the complete recovery transaction. Reuse the same
      // packaged admission, mutable-artifact recheck, assistant-storage repair,
      // spawn and port publication hook as every seat/connector restart; the
      // web-host crash supervisor never receives a direct start capability.
      await restartCommandEveBackendForSeat(restartLease);
      return backendManager.status === 'running' && backendManager.port > 0 ? backendManager.port : undefined;
    },
    clearDeadBackendPort: () => {
      delete (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    },
    // Bound only the safe pre-entry wait. Once acquired, the admission runner,
    // SQLite repair and backend launcher each have their own terminal timeout;
    // the FIFO never expires a still-mutating transaction.
    queueWaitTimeoutMs: COMMAND_EVE_CRASH_RECOVERY_QUEUE_WAIT_MS,
  });
const commandEveBackendStartOptions = {
  // Explicitly preserve the previous false/default behavior while giving the
  // workspace package's newer runtime an injected crash-restart owner. Keeping
  // one established option also remains structurally compatible with an older
  // installed @aionui/web-host declaration during local baseline typechecks.
  allowPendingOnHealthTimeout: false,
  restartAfterCrash: runCommandEveCrashRestartUnderReservation,
};
installMainProcessLocalBackendCapability({
  getPort: () => backendManager.port,
  getCapability: () => backendManager.localCapability,
});
let disposeCronResumeListener: (() => void) | null = null;

// Flag tracking whether the backend subprocess started successfully. Read by
// the deferred runBackendMigrations trigger in createWindow().
let backendStartedOk = false;
let rendererInitialLanguage: string | null = null;
let backendStartupFailed = false;
let backendStartupFailureInfo: unknown = null;
let backendMigrationsScheduled = false;
let runDeferredCommandEveRuntimeBootstrap: (() => void) | undefined;
let commandEveAutomaticRuntimeRepairRequired = false;
let ensureCommandEveRuntimeAdmissionForRespawn:
  | ((allowFullBootstrapRepair: boolean) => Promise<() => void>)
  | undefined;
let commandEvePackagedRuntimeExistedAtBoot = false;

ipcMain.on('get-backend-port', (event) => {
  if (!isTrustedAdapterIpcSender(event)) {
    event.returnValue = 0;
    return;
  }
  const bootBackendPort = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  event.returnValue = backendManager.port > 0 ? backendManager.port : (bootBackendPort ?? 0);
});

ipcMain.on('get-initial-language', (event) => {
  if (!isTrustedAdapterIpcSender(event)) {
    event.returnValue = null;
    return;
  }
  event.returnValue = rendererInitialLanguage;
});

ipcMain.on('get-backend-startup-failed', (event) => {
  if (!isTrustedAdapterIpcSender(event)) {
    event.returnValue = true;
    return;
  }
  event.returnValue = backendStartupFailed;
});

ipcMain.on('get-backend-startup-failure', (event) => {
  if (!isTrustedAdapterIpcSender(event)) {
    event.returnValue = null;
    return;
  }
  event.returnValue = backendStartupFailureInfo;
});

type CommandEveWarmupReceipt = {
  status?: string;
  default_model?: string;
  runtime_root?: string;
  stages?: RuntimeBootstrapReceipt['stages'];
};

type CommandEveRuntimeStatusPayload = {
  status: string;
  default_model?: string;
  base_model?: string;
  provider?: string;
  execution_mode?: string;
  next_action?: string;
  receipt_path?: string;
  gate_audit_path?: string;
  prompt_proof?: {
    ok: boolean;
    observed_at?: string;
    model?: string;
    message_count?: number;
    system_message_count?: number;
    marker?: string;
    prompt_sha256?: string;
    receipt_path?: string;
  };
  egress_boundary?: {
    receipt_path: string;
    decision?: string;
    observed_at?: string;
    finding_count?: number;
    policy_action?: string;
  };
  model_warmup?: CommandEveModelWarmupReceipt & {
    receipt_path: string;
  };
  stages?: Array<{
    id: string;
    status: string;
    code?: string;
    detail?: string;
    duration_ms?: number;
  }>;
};

type CommandEveModelWarmupReceipt = {
  version: 'command-eve-model-warmup/v0';
  status: 'running' | 'ready' | 'failed' | 'skipped';
  model: string;
  base_url: string;
  started_at: string;
  completed_at?: string;
  elapsed_ms: number;
  error?: string;
};

type CommandEveGateAction =
  | 'edit_code'
  | 'prepare_pr'
  | 'run_local_tests'
  | 'merge_main'
  | 'prod_write'
  | 'money'
  | 'external_send'
  | 'schema_auth_secret'
  | 'truth_gate';

type CommandEveAssistantEnsureResult = {
  status: 'ready';
  assistant_id: string;
  preset_agent_type: string;
  enabled_skills: string[];
  custom_skill_names: string[];
  skill_count: number;
};

const COMMAND_EVE_GATE_ACTIONS = new Set<CommandEveGateAction>([
  'edit_code',
  'prepare_pr',
  'run_local_tests',
  'merge_main',
  'prod_write',
  'money',
  'external_send',
  'schema_auth_secret',
  'truth_gate',
]);

type CommandEveWarmup = (options: {
  baseUrl?: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
}) => Promise<{ ok: boolean; elapsedMs: number; model: string; error?: string }>;

let commandEveRuntimeBridgeRegistered = false;
let commandEveOllamaShimUrl = '';
let commandEveOllamaShimStartFailure: unknown;
let commandEveWarmupInFlight: Promise<CommandEveModelWarmupReceipt> | undefined;
let commandEveAssistantBootstrapInFlight: Promise<CommandEveAssistantEnsureResult> | undefined;

function rememberCommandEveOllamaShimUrl(shimUrl: string): string {
  const normalized = shimUrl.trim().replace(/\/$/, '');
  commandEveOllamaShimUrl = normalized;
  // The seat-switch provisioner lives in another module and may run long after
  // boot. A non-secret process-local URL keeps every rewritten Hermes home on
  // this process's actual shim instead of the manifest's fixed default port.
  process.env.COMMAND_EVE_EGRESS_PROXY_URL = normalized;
  return normalized;
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (error) {
    console.warn(`[Command EVE] Failed to read ${filePath}:`, error);
    return undefined;
  }
}

function commandEveRuntimeBootstrapNeedsStartupWait(receiptPath: string, appVersion: string): boolean {
  if (!app.isPackaged) return true;
  const receipt = readJsonFile<RuntimeBootstrapReceipt>(receiptPath);
  if (!receipt) return true;
  if (receipt.status !== 'ready') return true;
  if (receipt.app_release !== appVersion) return true;
  const hermesStage = receipt.stages.find((stage) => stage.id === 'hermes');
  if (!hermesStage || hermesStage.status !== 'pass') return true;
  return false;
}

function commandEvePromptProofPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'last-prompt-proof.json');
}

function commandEveEgressBoundaryReceiptPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'last-egress-boundary-receipt.json');
}

function commandEveGateAuditPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'audit', 'gate-decisions.jsonl');
}

function commandEveTypedUIActionAuditPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'audit', 'typed-ui-actions.jsonl');
}

function commandEveTypedUIActionIntentDirectory(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'audit', 'typed-ui-action-intents');
}

function commandEveTypedUIProvenanceAuditPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'audit', 'typed-ui-provenance.jsonl');
}

function commandEveTypedUIGenerationReceiptPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'audit', 'typed-ui-generations.jsonl');
}

function commandEveTypedUIProviderCompletionReceiptPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'audit', 'typed-ui-provider-completions.jsonl');
}

function recordCommandEveTypedUIProviderCompletion(input: MainOwnedTypedUIProviderCompletionInput): void {
  const paths = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
  appendMainOwnedTypedUIProviderCompletionReceipt(
    commandEveTypedUIProviderCompletionReceiptPath(paths.runtimeRoot),
    input
  );
}

/**
 * Build the EVE cloud routing resolver passed to the Ollama OpenAI shim. The
 * resolver runs PER request (sync) so it always reflects the live picker
 * selection and the keychain-at-rest CEVE license:
 *
 *   - reads `commandEve.inferenceSelection` FROM THE BACKEND settings store
 *     (the renderer writes the picker value there via /api/settings/client, NOT
 *     to the main-process ProcessConfig JSON — reading ProcessConfig always
 *     returned undefined and silently defaulted EVE Max/High to Standard/Flash),
 *   - returns `{ active: false }` for any local (Privat lokal) selection,
 *   - for an EVE tier, parses the wire tier and reads the license, returning a
 *     route the shim POSTs to the eve-inference Edge Function (bearer = license).
 *
 * ASYNC: the selection lives in the backend SQLite store, so the resolver reads
 * it over HTTP per request. The shim awaits it.
 *
 * Fail-loud: an unreadable picker state rejects into the shim's HTTP boundary,
 * which returns 500. It must not become local or EVE Standard because either
 * fallback silently changes the lane the user selected. The shim likewise
 * fail-closes (401/500) if the license/URL is missing.
 */
function buildCommandEveShimRoutingResolver(): (
  body?: Record<string, unknown>
) => Promise<CommandEveEveCloudRoute | undefined> {
  return async (body) => {
    const seatId = getActiveSeatId();
    const seatContextRevision = getActiveSeatContextRevision();
    const managedVisualTurn = resolveCommandEveManagedVisualTurn(body, seatId, seatContextRevision);
    if (managedVisualTurn.status === 'invalid') {
      throw new CommandEveManagedVisualAuthorizationError(managedVisualTurn.reason_code);
    }
    if (managedVisualTurn.status === 'authorized') {
      const wireResult = readLicenseWire(getDataPath());
      const claim = managedVisualTurn.visualPolicyClaim;
      return {
        active: true,
        functionUrl: EVE_INFERENCE_FUNCTION_URL,
        license: wireResult.ok ? wireResult.wire : undefined,
        tier: managedVisualTurn.tier,
        authorizeManagedVisualEgress: async () => {
          const policy = await readCommandEveCloudVisualPolicy();
          return (
            policy.status === 'enabled' &&
            policy.seatId === claim.seatId &&
            getActiveSeatId() === claim.seatId &&
            getActiveSeatContextRevision() === claim.seatContextRevision
          );
        },
      };
    }

    // The lane-state read (picker selection + proven MAX entitlement, one fetch)
    // is OWNED by resolveEveCloudRouteFromBackend and is deliberately NOT passed
    // in from here. It used to be injected, which meant this call site was the
    // only place the real reader was ever wired — and no test could tell whether
    // it still was. Removing the seam is what makes the clamp impossible to
    // orphan again. Only the license read, which needs Electron's data path,
    // stays a dependency.
    return resolveEveCloudRouteFromBackend({
      readLicense: () => {
        const wireResult = readLicenseWire(getDataPath());
        return wireResult.ok ? wireResult.wire : undefined;
      },
      functionUrl: EVE_INFERENCE_FUNCTION_URL,
    });
  };
}

/**
 * Managed non-Ollama local routes. Only explicit managed model ids activate
 * them; every Gemma request remains byte-identical on the Ollama path.
 * The server never downloads from a chat request: installation is owned by the
 * model settings/bootstrap flow and every runtime artifact is pinned there.
 */
function buildCommandEveManagedLocalOpenAiRoutingResolver(): CommandEveLocalOpenAiRoutingResolver {
  return async (requestedModel): Promise<CommandEveLocalOpenAiRoute | undefined> => {
    const normalizedModel = requestedModel.trim();
    const requestedTier = getCommandEveLocalModelTierForRuntimeModel(normalizedModel);
    if (requestedTier) {
      const settings = await readCommandEveSettingsFromBackend(['commandEve.localModelTierId']);
      const selectedTier = getCommandEveLocalModelTier(
        normalizeCommandEveLocalModelTierId(settings['commandEve.localModelTierId'] as string | undefined)
      );
      if (selectedTier.id !== requestedTier.id) {
        throw new Error('The requested local EVE model is no longer the selected model tier.');
      }
      const receiptPath = resolveCommandEveRuntimeBootstrapPaths(getDataPath()).receiptPath;
      const receipt = readJsonFile<RuntimeBootstrapReceipt>(receiptPath);
      if (!receipt || !runtimeReceiptAllowsLocalModelRequest(receipt, app.getVersion(), normalizedModel)) {
        throw new Error('The selected local EVE model is still being verified for this app release.');
      }
    }
    if (
      normalizedModel === COMMAND_EVE_COLIBRI_RUNTIME_MODEL_ID ||
      normalizedModel === COMMAND_EVE_COLIBRI_ACP_MODEL_ID
    ) {
      const [{ stopBonsaiPilotServer }, { ensureColibriServer }] = await Promise.all([
        import('./process/commandEve/localInference/bonsaiServer'),
        import('./process/commandEve/localInference/colibriServer'),
      ]);
      await stopBonsaiPilotServer();
      const server = await ensureColibriServer({
        userDataPath: getDataPath(),
        autoProvision: false,
        contextSize: 65_536,
      });
      return {
        active: true,
        baseUrl: server.baseUrl,
        model: server.model,
        apiKey: server.apiKey,
        providerName: 'colibri-glm-5-2-local',
        payloadProfile: 'colibri',
      };
    }
    if (
      normalizedModel !== COMMAND_EVE_BONSAI_RUNTIME_MODEL_ID &&
      normalizedModel !== COMMAND_EVE_BONSAI_ACP_MODEL_ID
    ) {
      const [{ stopBonsaiPilotServer }, { stopColibriServer }] = await Promise.all([
        import('./process/commandEve/localInference/bonsaiServer'),
        import('./process/commandEve/localInference/colibriServer'),
      ]);
      await Promise.all([stopBonsaiPilotServer(), stopColibriServer()]);
      return { active: false };
    }
    const { stopColibriServer } = await import('./process/commandEve/localInference/colibriServer');
    await stopColibriServer();
    const { ensureBonsaiPilotServer } = await import('./process/commandEve/localInference/bonsaiServer');
    const server = await ensureBonsaiPilotServer({
      userDataPath: getDataPath(),
      autoProvision: false,
      contextSize: 65_536,
    });
    return {
      active: true,
      baseUrl: server.baseUrl,
      model: server.model,
      apiKey: server.apiKey,
      providerName: 'bonsai-27b-local',
    };
  };
}

/**
 * COMPA-624 Inc.3 / O3 — the shim `honchoDeriverRoute` resolver. Built ONCE and
 * injected at EVERY shim start site (H-INT-1). It stays INERT (`{active:false}`,
 * the shim's /honcho/deriver lane 503s) on every seat where Honcho is not
 * provisioned — so a seat without a Honcho readiness file is byte-identical to
 * before this lane existed (H-INT-3). Its per-seat readiness is read through the
 * SAME `resolveHonchoHomeForSeat` the writer uses (H-INT-2, drift-proof by
 * construction), and the CEVE license is read FRESH per call (header-only, never a
 * body/log). The resolver core is fully fail-closed (buildCommandEveShimHoncho…).
 */
function buildCommandEveShimHonchoDeriverRoute(): CommandEveHonchoDeriverRouteResolver {
  const resolve = buildCommandEveShimHonchoDeriverRouteResolver({
    functionUrl: EVE_INFERENCE_FUNCTION_URL,
    readLicenseWire: () => {
      const wireResult = readLicenseWire(getDataPath());
      return wireResult.ok ? wireResult.wire : '';
    },
    getActiveSeatId,
    readHonchoSeatReady: (seatId: string) => {
      const honchoHome = resolveHonchoHomeForSeat(getDataPath(), seatId);
      return honchoHome ? readHonchoReadyState(honchoHome) : undefined;
    },
    onError: (error: unknown) =>
      console.warn('[Command EVE] Honcho deriver route resolver error (staying inert):', error),
  });
  // Normalize to the shim's route shape (active is a guaranteed boolean; the core
  // always sets it, but its result type keeps it optional). Fail-closed to inert.
  return (): CommandEveHonchoDeriverRoute => {
    const r = resolve();
    return { active: r.active === true, functionUrl: r.functionUrl, license: r.license };
  };
}

/**
 * COMPA-624 — resolve the ACTIVE seat's honcho render input for the launcher wiring
 * (so an active Claude delegate gets the same per-seat memory EVE has). Fail-soft to
 * { ready:false } on any error so the (synchronous) worker-runtime resolver never
 * throws and a seat with no Honcho is byte-identical to before.
 */
function resolveActiveSeatHonchoRender(): HonchoRenderInput {
  try {
    const dataPath = getDataPath();
    const seatId = getActiveSeatId();
    const hermesVenv = resolveCommandEveRuntimeBootstrapPaths(dataPath, seatId).hermesVenv;
    return resolveHonchoRenderForSeat({ userDataPath: dataPath, seatId, hermesVenv });
  } catch {
    return { ready: false };
  }
}

/**
 * S10 — set `COMMAND_EVE_COMPANY_OS_ROOT` in the main-process env at startup so
 * the command-center / status-surface cores can find the Company.OS dev-monorepo
 * CLIs they invoke — BUT ONLY when a plausible checkout actually exists. On an
 * end-user machine there is no Company.OS checkout (the scripts are a separate,
 * un-bundled monorepo), so we leave the env UNSET and the cores fail-closed with
 * their existing clean `COMPANY_OS_ROOT_MISSING` — we NEVER invent a path.
 *
 * MUST run BEFORE initializeProcess() (which registers the bridge providers that
 * invoke those cores). Idempotent + fail-soft: any error is logged and swallowed.
 * The resolution/marker logic lives in the pure, unit-tested
 * `companyOsRootResolveCore`; here we only wire the real fs probe + candidates and
 * perform the single env mutation for a `detected` root.
 */
function setCommandEveCompanyOsRootEnv(): void {
  try {
    const candidates = buildCompanyOsRootCandidates(app.getAppPath(), process.cwd(), os.homedir());
    const resolution = resolveCompanyOsRoot({
      env: process.env,
      candidates,
      markerExists: (root) => {
        try {
          return fs.existsSync(path.join(root, COMPANY_OS_ROOT_MARKER));
        } catch {
          return false;
        }
      },
    });
    if (resolution.action === 'respect-existing') {
      console.info(
        `[Command EVE] COMPANY_OS_ROOT already set via ${resolution.envKey} (respecting): ${resolution.root}`
      );
      return;
    }
    if (resolution.action === 'detected') {
      process.env.COMMAND_EVE_COMPANY_OS_ROOT = resolution.root;
      console.info(`[Command EVE] COMPANY_OS_ROOT auto-detected (dev checkout): ${resolution.root}`);
      return;
    }
    // action === 'unset': no checkout found. Leave the env unset — the
    // command-center / status-surface cores fail-closed cleanly (this is the
    // correct, honest end-user behavior — the operator SKU never ships the CLIs).
    console.info(
      '[Command EVE] No Company.OS checkout found; leaving COMPANY_OS_ROOT unset ' +
        '(command-center/status-surface fail-closed as designed).'
    );
  } catch (error) {
    console.warn('[Command EVE] COMPANY_OS_ROOT resolution failed (non-blocking):', error);
  }
}

/**
 * Build the "Dein Team" worker-status resolver passed to the Ollama OpenAI shim
 * (DUX-4 / S9 #1 — THE MONEY BUG). The resolver runs PER dispatch evaluation and
 * reads the live pause/throttle/fire state FRESH from the BACKEND settings store
 * — the store the panel actually writes to (`commandEve.teamWorkerStatus` via
 * `/api/settings/client`) — so a fire is effective on the very next dispatch. The
 * shim awaits it and refuses to dispatch a paused/off worker.
 *
 * The fresh-read + last-known-good fail-direction lives in the pure, injectable
 * `createTeamWorkerStatusResolver` core (unit-tested end-to-end against a mocked
 * backend). Here we only wire the REAL backend batch reader + a console.warn
 * side-channel. See teamWorkerStatusResolverCore.ts for the full rationale.
 */
function buildCommandEveShimTeamStatusResolver(): () => Promise<EveTeamWorkerStatusMap | undefined> {
  // Pass getActiveSeatId so the last-known-good roster is keyed PER SEAT (the shim is
  // a seat-switch-surviving singleton; a single snapshot would let one seat's roster
  // be served for another on a hiccup — full-history re-audit).
  return createTeamWorkerStatusResolver(readCommandEveSettingsFromBackend, getActiveSeatId, (error) =>
    console.warn('[Command EVE] EVE shim team-status backend read failed; using last-known-good roster:', error)
  );
}

/**
 * Build the PER-SEAT PII/DSGVO egress-redaction-mode resolver passed to the shim
 * (S11). Runs PER cloud request and reads the live `commandEve.egressRedactionMode`
 * switch FRESH from the BACKEND settings store (the store the settings card writes
 * to) so a toggle flip takes effect on the very next turn.
 *
 * FAIL-SAFE: any backend read error resolves to 'on' (always redact) — Privacy
 * needs NO last-known-good; the safe direction is always redact (see
 * egressRedactionModeResolverCore.ts). Only a conscious, successfully-read 'off'
 * disables redaction, and only for the active seat's cloud lane.
 */
function buildCommandEveShimEgressRedactionModeResolver(): () => Promise<'on' | 'off'> {
  return createEgressRedactionModeResolver(readCommandEveSettingsFromBackend, (error) =>
    console.warn('[Command EVE] EVE shim egress-redaction-mode backend read failed; failing SAFE (redact):', error)
  );
}

/**
 * Build the OPAQUE active-seat-id resolver passed to the shim (A3 per-seat usage
 * attribution). Runs PER cloud request and returns the in-process active seat id
 * (`seatContextCore.getActiveSeatId` — 'seat-1' legacy/founder or a sanitized
 * seat UUID). It is a SYNCHRONOUS in-memory read of the process-local holder
 * `applySeatSwitch` maintains — NO network, NO backend read — so it never adds
 * latency and can never fail (the holder defaults to 'seat-1'). The shim spreads
 * the value into the outbound body as `seat_id`; the display LABEL is NEVER read
 * or sent here (H3).
 */
function buildCommandEveShimActiveSeatIdResolver(): () => string {
  return () => getActiveSeatId();
}

/**
 * Build the LIVE approval-authority resolver passed to the shim (CEVE-1821).
 *
 * Runs PER approval question and reads `commandEve.authority` FRESH from the
 * backend settings store — the same store the Freigaben panel writes. That
 * freshness is the point: a ladder or seal the human just changed has to bind on
 * the next decision, not on the next boot. A grant that is stored and only takes
 * effect after a restart is the same defect as one that never takes effect.
 *
 * FAIL-CLOSED in every direction: an unreadable store, a malformed grant or a
 * thrown read all resolve to `EVE_AUTHORITY_FAIL_CLOSED` (rung 1, no seals),
 * whose rendering answers `ask` to everything. There is no last-known-good here
 * on purpose — "what this seat allowed a minute ago" is not authority.
 */
/**
 * Build the BYOK provider-route resolver passed to the shim (Baustein 2).
 *
 * Runs per turn, reads the ACTIVE picker selection and the operator's own
 * `/api/providers` rows FRESH, and returns the route only when the selection is
 * a connected one that still resolves. The operator's key is read HERE, in main,
 * and handed straight to the shim — it never crosses the bridge and never enters
 * a renderer, a log or a conversation record.
 *
 * FAIL-CLOSED to `{ active: false }`: an unreadable store, a deleted row or a
 * model that no longer exists means "not this lane", and the shim then takes the
 * lanes it always took. It does NOT mean "run it somewhere else" — that decision
 * belongs to the send path, which refuses out loud.
 */
/**
 * CURATOR TICK (CEVE-1821) — the trigger the desktop chat lane never had.
 *
 * `curator: enabled: true` is emitted into the Hermes config, but on this lane
 * `maybe_run_curator` has no caller at all: in the bundled 0.20.0 wheel it is
 * invoked only from `cli.py:15052` and `gateway/run.py:25952`, and `acp_adapter/`
 * never mentions the curator. So the capability was declared and dead.
 *
 * Spawned detached, best-effort, after the runtime reports ready — the tick may
 * never delay or break a start. `curatorTickCore` explains why it runs
 * `curator run` rather than `maybe_run_curator`, and why it costs nothing.
 */
function startCommandEveCuratorTick(paths: {
  hermesVenv: string;
  hermesHome: string;
  platform: NodeJS.Platform;
}): void {
  try {
    startCuratorTickTimer(paths, {
      spawnDetached: (command, args, options) => {
        const child = childProcess.spawn(command, [...args], {
          env: { ...process.env, ...options.env },
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      },
      binaryExists: (file) => fs.existsSync(file),
      log: (message, error) => console.debug(message, error),
    });
  } catch (error) {
    // A tick that cannot even be scheduled is a debug line, never a boot failure.
    console.debug('[Command EVE] curator tick not scheduled', error);
  }
}

function buildCommandEveShimConnectedProviderResolver(): () => Promise<CommandEveConnectedProviderRoute> {
  return async () => {
    try {
      const laneState = await readInferenceLaneStateFromBackendStrict();
      const selection = repairInferenceSelection(laneState.selection).selection;
      const parsed = parseConnectedSelection(selection);
      if (!parsed) return { active: false };
      const rows = (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
      const route = resolveConnectedProviderRoute(parsed, rows);
      if (!route) return { active: false };
      return {
        active: true,
        baseUrl: route.baseUrl,
        model: route.model,
        apiKey: route.apiKey,
        providerName: route.providerName,
      };
    } catch (error) {
      console.warn('[Command EVE] Connected provider route read failed; lane inactive:', error);
      return { active: false };
    }
  };
}

function buildCommandEveShimApprovalResolver(): () => Promise<EveAuthorityRuntime> {
  return async () => {
    try {
      const bag = await readCommandEveSettingsFromBackend(['commandEve.authority']);
      return renderEveAuthorityRuntime(readEveAuthorityGrant(bag['commandEve.authority']));
    } catch (error) {
      console.warn('[Command EVE] approval-authority backend read failed; failing CLOSED (ask):', error);
      return renderEveAuthorityRuntime(EVE_AUTHORITY_FAIL_CLOSED);
    }
  };
}

/**
 * CLI-Keystone runtime glue (the wiring the audit found MISSING). Reads the
 * PERSISTED worker assignments + the live team-status map and resolves them into
 * the two bootstrap inputs that make the keystone ALIVE:
 *   - codexRuntime: the `model.openai_runtime` value — DEFERRED, always '' now
 *     (Codex is a dead key on EVE's provider:custom build; see
 *     eveWorkerAssignmentCore.codexRuntimeForConfig). Kept wired so a future clean
 *     Codex path flips on here with no re-plumbing.
 *   - claudeDelegate: the resolved + status-allowed Claude ACP delegate (or null).
 *     The main process wraps and binds its transport in trusted process env; the
 *     bootstrap writes only a role/capability hint into SOUL.md.
 *
 * Fail-soft: any read/resolve error yields { codexRuntime: '', claudeDelegate:
 * null } so a config glitch can NEVER block startup — it just means no external
 * worker is wired this launch (EVE answers on its normal lane).
 *
 * SECURITY: resolving routing is NOT a grant to run. resolveAssignedClaudeDelegate
 * reuses the dispatch gate (paused/off => null); the human-gate/permission path
 * still applies before any CLI worker spawns shell.
 */
async function resolveCommandEveWorkerRuntimeInputs(): Promise<{
  codexRuntime: string;
  claudeDelegate: ReturnType<typeof resolveAssignedClaudeDelegate>;
  /** 1.6.3 Team-Realität: roster + live status + worker for the SOUL team directive. */
  teamRoles: EveTeamDirectiveRole[];
  /**
   * 1.820: the commands THIS SEAT's human said EVE may always run.
   *
   * P1 (independent review, Grok): the emitter accepted this and the tests passed
   * it explicitly, but no production caller ever read it — so a user could tick
   * "always allow this command", see it listed in Freigaben, and Hermes would
   * never learn about it. Green feature, no effect. It is resolved HERE because
   * both provisioning call sites already spread this object.
   */
  rememberedCommands: readonly EveRememberedCommand[];
}> {
  try {
    // S9 #3 store-split fix: worker assignments + team status are RENDERER-written
    // keys — the panel/keystone UI persists them to the BACKEND settings store
    // (`/api/settings/client`), NOT the main-process ProcessConfig JSON this used
    // to read (which never held them, so neither the trusted transport binding nor
    // the SOUL role hint rendered). Read BOTH keys in ONE backend GET. Fail-soft:
    // absent/unreadable ⇒ undefined ⇒ no directive (today's behavior).
    const bag = await readCommandEveSettingsFromBackend([
      'commandEve.workerAssignments',
      'commandEve.teamWorkerStatus',
      'commandEve.authority',
    ]);
    const assignmentsRaw = bag['commandEve.workerAssignments'];
    const statusesRaw = bag['commandEve.teamWorkerStatus'];
    // Seat-scoped by `SEAT_SCOPED_CONFIG_KEYS`, so this reads THIS seat's grants
    // and never a sibling client's. Re-validated on read: a row that reached the
    // store by another route is not trusted for already being there.
    const rememberedCommands = rememberedCommandsFromSettings(bag);
    const assignments =
      assignmentsRaw && typeof assignmentsRaw === 'object'
        ? (Object.fromEntries(
            Object.entries(
              assignmentsRaw as Record<string, { kind: string; cli_path?: string; cli_version?: string }>
            ).map(([id, v]) => [id, { agent_id: id, ...v }])
          ) as EveWorkerAssignmentMap)
        : ({} as EveWorkerAssignmentMap);
    const statuses =
      statusesRaw && typeof statusesRaw === 'object'
        ? (statusesRaw as EveTeamWorkerStatusMap)
        : ({} as EveTeamWorkerStatusMap);
    return {
      codexRuntime: codexRuntimeForConfig(assignments),
      // SG-1 A3: wrap the resolved delegate so delegate_task launches through the
      // eve-acp-launcher (real pause-gate + attribution env), and refresh the
      // DERIVED per-role status/token mirror. FAIL-CLOSED if no launcher (H13):
      // applyLauncherWiring returns null and wires NO delegate rather than an
      // unwrapped one (no pause-gate, no env scrub).
      claudeDelegate: applyLauncherWiring(resolveAssignedClaudeDelegate(assignments, statuses), assignments, statuses, {
        dataPath: getDataPath(),
        seatId: getActiveSeatId(),
        resourcesPath: process.resourcesPath,
        env: process.env,
        honcho: resolveActiveSeatHonchoRender(),
        packaged: app.isPackaged,
      }),
      teamRoles: buildTeamDirectiveRoles(assignments, statuses),
      rememberedCommands,
    };
  } catch (error) {
    clearHermesDelegateTransportEnv(process.env);
    console.warn('[Command EVE] worker-runtime input resolver failed; no external worker wired:', error);
    // Fail-soft on the TEAM directive too: with no readable settings the roster
    // defaults still describe the team truthfully (default statuses, no worker).
    // Fail-CLOSED on the grants: unreadable settings must never be read as
    // "everything the user once allowed is still allowed" — an empty list simply
    // means EVE asks again.
    return {
      codexRuntime: '',
      claudeDelegate: null,
      teamRoles: buildTeamDirectiveRoles({}, {}),
      rememberedCommands: [],
    };
  }
}

function writeCommandEveModelWarmupReceipt(runtimeRoot: string, receipt: CommandEveModelWarmupReceipt): void {
  try {
    if (!runtimeRoot) return;
    const receiptPath = path.join(runtimeRoot, 'model-warmup-receipt.json');
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
    const tempFile = `${receiptPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempFile, receiptPath);
  } catch (error) {
    console.warn('[Command EVE] Failed to write model warm-up receipt:', error);
  }
}

async function runCommandEveLocalModelWarmup(
  receipt: CommandEveWarmupReceipt,
  shimUrl: string,
  warmup: CommandEveWarmup,
  mark?: (label: string) => void
): Promise<CommandEveModelWarmupReceipt> {
  const model = receipt.default_model || '';
  const runtimeRoot = receipt.runtime_root || '';
  const disabledNow = new Date().toISOString();

  if (!runtimeReceiptAllowsLocalModelWarmup(receipt)) {
    const skipped: CommandEveModelWarmupReceipt = {
      version: 'command-eve-model-warmup/v0',
      status: 'skipped',
      model,
      base_url: shimUrl,
      started_at: disabledNow,
      completed_at: disabledNow,
      elapsed_ms: 0,
      error: 'local model runtime not ready',
    };
    writeCommandEveModelWarmupReceipt(runtimeRoot, skipped);
    return skipped;
  }

  if (process.env.COMMAND_EVE_DISABLE_MODEL_WARMUP === '1') {
    const skipped: CommandEveModelWarmupReceipt = {
      version: 'command-eve-model-warmup/v0',
      status: 'skipped',
      model,
      base_url: shimUrl,
      started_at: disabledNow,
      completed_at: disabledNow,
      elapsed_ms: 0,
      error: 'disabled by COMMAND_EVE_DISABLE_MODEL_WARMUP',
    };
    writeCommandEveModelWarmupReceipt(runtimeRoot, skipped);
    return skipped;
  }

  // S9 #6 store-split fix: `modelWarmupEnabled` is a RENDERER-written key (the
  // settings toggle persists it to the BACKEND store, not the main-process
  // ProcessConfig this used to read). Read it from the backend so the user's
  // opt-out is actually honored. Fail-direction unchanged: absent OR unreadable ⇒
  // `?? true` (warm-up ON by default) — the reader THROWS on a backend error, so
  // we fail-soft to an empty bag here to preserve the old default-on behavior.
  const warmupBag = await readCommandEveSettingsFromBackend(['commandEve.modelWarmupEnabled']).catch(
    (): Record<string, unknown> => ({})
  );
  const enabled = (warmupBag['commandEve.modelWarmupEnabled'] as boolean | undefined) ?? true;
  if (!enabled) {
    console.info('[Command EVE] Local model warm-up skipped by user preference.');
    const skipped: CommandEveModelWarmupReceipt = {
      version: 'command-eve-model-warmup/v0',
      status: 'skipped',
      model,
      base_url: shimUrl,
      started_at: disabledNow,
      completed_at: disabledNow,
      elapsed_ms: 0,
      error: 'disabled by user preference',
    };
    writeCommandEveModelWarmupReceipt(runtimeRoot, skipped);
    return skipped;
  }

  const startedAt = new Date().toISOString();
  writeCommandEveModelWarmupReceipt(runtimeRoot, {
    version: 'command-eve-model-warmup/v0',
    status: 'running',
    model,
    base_url: shimUrl,
    started_at: startedAt,
    elapsed_ms: 0,
  });

  const result = await warmup({
    baseUrl: shimUrl,
    model,
    timeoutMs: 90_000,
    maxTokens: 1,
  });
  const completed: CommandEveModelWarmupReceipt = {
    version: 'command-eve-model-warmup/v0',
    status: result.ok ? 'ready' : 'failed',
    model: result.model,
    base_url: shimUrl,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    elapsed_ms: result.elapsedMs,
    ...(result.error ? { error: result.error } : {}),
  };
  writeCommandEveModelWarmupReceipt(runtimeRoot, completed);
  if (result.ok) {
    console.info(`[Command EVE] Local model warm-up ready: ${result.model} (${result.elapsedMs}ms)`);
    mark?.(`commandEveModelWarmup (${result.elapsedMs}ms)`);
  } else {
    console.warn(`[Command EVE] Local model warm-up failed: ${result.error || 'unknown error'}`);
  }
  return completed;
}

function ensureCommandEveLocalModelWarmup(
  receipt: CommandEveWarmupReceipt,
  shimUrl: string,
  warmup: CommandEveWarmup,
  mark?: (label: string) => void
): Promise<CommandEveModelWarmupReceipt> {
  if (commandEveWarmupInFlight) return commandEveWarmupInFlight;
  commandEveWarmupInFlight = runCommandEveLocalModelWarmup(receipt, shimUrl, warmup, mark).finally(() => {
    commandEveWarmupInFlight = undefined;
  });
  return commandEveWarmupInFlight;
}

async function waitForCommandEveBackendPort(timeoutMs = 90_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bootBackendPort = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    const port = backendManager.port > 0 ? backendManager.port : (bootBackendPort ?? 0);
    if (port > 0) return port;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Command EVE assistant readiness blocked: backend port not available after ${timeoutMs}ms.`);
}

function commandEveAuthorityDiagnostic(error: unknown, fallback: string): string {
  return (error instanceof Error ? error.message : typeof error === 'string' ? error : fallback)
    .replace(/\b(keychain:v1:)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\b(authorization)(\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/\b([a-z0-9_-]*(?:api[_-]?key|token|secret))(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .slice(0, 600);
}

function commandEveAuthorityErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function ensureCommandEveAssistantReadiness(): Promise<CommandEveAssistantEnsureResult> {
  if (commandEveAssistantBootstrapInFlight) return commandEveAssistantBootstrapInFlight;
  commandEveAssistantBootstrapInFlight = (async () => {
    const bootBackendPort = await waitForCommandEveBackendPort();
    const { getDataPath } = await import('./process/utils/utils');
    const { ensureCommandEveAssistant } = await import('./process/commandEve/assistantBootstrap');
    return ensureCommandEveAssistant(bootBackendPort, app.getVersion(), { userDataPath: getDataPath() });
  })().finally(() => {
    commandEveAssistantBootstrapInFlight = undefined;
  });
  return commandEveAssistantBootstrapInFlight;
}

async function getCommandEveRuntimeStatusPayload(): Promise<CommandEveRuntimeStatusPayload> {
  const { getDataPath } = await import('./process/utils/utils');
  const { resolveCommandEveRuntimeBootstrapPaths } = await import('./process/commandEve/runtimeBootstrapCore');
  const { normalizeCommandEveExecutionMode } = await import('./process/commandEve/executionModeCore');
  const paths = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
  const receipt = readJsonFile<Record<string, unknown>>(paths.receiptPath);
  const promptProofFile = commandEvePromptProofPath(paths.runtimeRoot);
  const promptProof = readJsonFile<CommandEveRuntimeStatusPayload['prompt_proof']>(promptProofFile);
  const egressBoundaryFile = commandEveEgressBoundaryReceiptPath(paths.runtimeRoot);
  const egressBoundary = readJsonFile<Record<string, unknown>>(egressBoundaryFile);
  const modelWarmup = readJsonFile<CommandEveModelWarmupReceipt>(paths.modelWarmupReceiptPath);
  // S9 #8 (DEFER): `commandEve.executionMode` has NO renderer writer today — the
  // ProcessConfig read below therefore always resolves to the fixed default
  // 'observed' (normalizeCommandEveExecutionMode). That is intentional for this
  // slice: the writer is an autonomy regler (observed/delegated/autonomous) —
  // effectively the HG-ladder as UI — and is a deliberate open PRODUCT decision
  // for the Founder, NOT a store-split bug to silently wire tonight. Tracked as
  // sweep #8 for the 1.3 plan. Do NOT convert this to the backend batch reader
  // until the writer + its gating semantics are decided.
  const executionMode = normalizeCommandEveExecutionMode(
    await ProcessConfig.get('commandEve.executionMode').catch((): undefined => undefined)
  );
  const gateAuditPath = commandEveGateAuditPath(paths.runtimeRoot);
  if (!receipt) {
    return {
      status: 'missing',
      execution_mode: executionMode,
      receipt_path: paths.receiptPath,
      gate_audit_path: gateAuditPath,
      next_action: 'Command EVE runtime receipt has not been written yet.',
      ...(modelWarmup ? { model_warmup: { ...modelWarmup, receipt_path: paths.modelWarmupReceiptPath } } : {}),
      ...(promptProof ? { prompt_proof: { ...promptProof, receipt_path: promptProofFile } } : {}),
      ...(egressBoundary
        ? {
            egress_boundary: {
              receipt_path: egressBoundaryFile,
              decision: typeof egressBoundary.decision === 'string' ? egressBoundary.decision : undefined,
              observed_at: typeof egressBoundary.observed_at === 'string' ? egressBoundary.observed_at : undefined,
              finding_count:
                typeof egressBoundary.finding_count === 'number' ? egressBoundary.finding_count : undefined,
              policy_action:
                typeof egressBoundary.policy_action === 'string' ? egressBoundary.policy_action : undefined,
            },
          }
        : {}),
    };
  }
  return {
    status: String(receipt.status || 'unknown'),
    default_model: typeof receipt.default_model === 'string' ? receipt.default_model : undefined,
    base_model: typeof receipt.base_model === 'string' ? receipt.base_model : undefined,
    provider: typeof receipt.provider === 'string' ? receipt.provider : undefined,
    execution_mode: executionMode,
    next_action: typeof receipt.next_action === 'string' ? receipt.next_action : undefined,
    receipt_path: paths.receiptPath,
    gate_audit_path: gateAuditPath,
    prompt_proof: promptProof ? { ...promptProof, receipt_path: promptProofFile } : undefined,
    model_warmup: modelWarmup ? { ...modelWarmup, receipt_path: paths.modelWarmupReceiptPath } : undefined,
    egress_boundary: egressBoundary
      ? {
          receipt_path: egressBoundaryFile,
          decision: typeof egressBoundary.decision === 'string' ? egressBoundary.decision : undefined,
          observed_at: typeof egressBoundary.observed_at === 'string' ? egressBoundary.observed_at : undefined,
          finding_count: typeof egressBoundary.finding_count === 'number' ? egressBoundary.finding_count : undefined,
          policy_action: typeof egressBoundary.policy_action === 'string' ? egressBoundary.policy_action : undefined,
        }
      : undefined,
    stages: Array.isArray(receipt.stages) ? (receipt.stages as CommandEveRuntimeStatusPayload['stages']) : undefined,
  };
}

function registerCommandEveRuntimeBridge(): void {
  if (commandEveRuntimeBridgeRegistered) return;
  commandEveRuntimeBridgeRegistered = true;

  ipcBridge.commandEve.runtimeStatus.provider(async () => {
    try {
      return { success: true, data: await getCommandEveRuntimeStatusPayload() };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.commandEve.ensureAssistant.provider(async () => {
    try {
      return { success: true, data: await ensureCommandEveAssistantReadiness() };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.commandEve.ensureLocalModelTier.provider(async (request) => {
    try {
      const { getCanonicalDataPath, getDataPath } = await import('./process/utils/utils');
      const { ensureCommandEveRuntimeBootstrap, resolveCommandEveRuntimeBootstrapPaths } =
        await import('./process/commandEve/runtimeBootstrapCore');
      const { startCommandEveOllamaOpenAiShim, warmCommandEveLocalModel } =
        await import('./process/commandEve/ollamaOpenAiShim');
      const tierId = typeof request?.tierId === 'string' ? request.tierId : '';
      const userDataPath = getDataPath();
      const canonicalUserDataPath = getCanonicalDataPath();
      const requireBundledPython = app.isPackaged && process.platform === 'darwin';
      const paths = resolveCommandEveRuntimeBootstrapPaths(
        userDataPath,
        undefined,
        process.platform,
        canonicalUserDataPath
      );
      const shimUrl = rememberCommandEveOllamaShimUrl(
        commandEveOllamaShimUrl ||
          (await startCommandEveOllamaOpenAiShim({
            promptProofPath: commandEvePromptProofPath(paths.runtimeRoot),
            egressReceiptPath: commandEveEgressBoundaryReceiptPath(paths.runtimeRoot),
            eveRouting: buildCommandEveShimRoutingResolver(),
            localOpenAiRouting: buildCommandEveManagedLocalOpenAiRoutingResolver(),
            teamWorkerStatus: buildCommandEveShimTeamStatusResolver(),
            egressRedactionMode: buildCommandEveShimEgressRedactionModeResolver(),
            activeSeatId: buildCommandEveShimActiveSeatIdResolver(),
            activeSeatContext: () => ({
              seatId: getActiveSeatId(),
              seatContextRevision: getActiveSeatContextRevision(),
            }),
            typedUIProviderCompletion: recordCommandEveTypedUIProviderCompletion,
            attributionAgentId: (token, seatId) => resolveDispatchAgentId(token, seatId),
            teamManageBearer: resolveTeamManageBearer,
            teamManagePropose: teamManageProposeHandler,
            honchoDeriverRoute: buildCommandEveShimHonchoDeriverRoute(),
            kanbanAcpBearer: resolveKanbanAcpBearer,
            kanbanAcpPropose: kanbanAcpProposeHandler,
            kanbanAcpRead: readKanbanAcpBoard,
            // CEVE-1821 — injected at EVERY shim start site. A site that forgot it
            // would fall back to the fail-closed default and silently pin that seat
            // to "always ask" for the whole session, with no other symptom.
            commandEveApproval: buildCommandEveShimApprovalResolver(),
            connectedProviderRouting: buildCommandEveShimConnectedProviderResolver(),
            // MAT-1747: the app-owned artifact capability. Injected at EVERY shim
            // start site — the bearer is per-boot, so a site that forgets it would
            // 404 the route for the whole session with no other symptom.
            artifactCapabilityBearer: resolveArtifactCapabilityBearer,
            artifactCapabilityCall: artifactCapabilityCallHandler,
          }))
      );
      let warmupReceipt: CommandEveModelWarmupReceipt | undefined;
      let status: CommandEveRuntimeStatusPayload | undefined;
      const receipt = await ensureCommandEveRuntimeBootstrap({
        userDataPath,
        canonicalUserDataPath,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        requireBundledPython,
        mode: 'auto',
        allowColibriDownload: true,
        env: tierId ? { COMMAND_EVE_LOCAL_MODEL_TIER: tierId } : undefined,
        egressProxyUrl: shimUrl,
        // Setting-driven language: thread the operator's selected UI language into
        // the soul so EVE defaults to it (bootstrap re-runs, so it self-corrects).
        uiLanguage: ProcessConfig.getSync('language'),
        // CLI-Keystone runtime glue: read commandEve.workerAssignments + team status
        // and thread codexRuntime ('' — Codex deferred) + the resolved Claude ACP
        // delegate so Desktop binds transport and bootstrap emits the role hint.
        ...(await resolveCommandEveWorkerRuntimeInputs()),
        afterBootstrapExclusive: async (terminalReceipt) => {
          // A warm-up receipt is historical evidence, not current residency.
          // `warmCommandEveLocalModel` performs the bounded live `/api/ps`
          // check and skips the synthetic ping when the exact model is still
          // resident.
          warmupReceipt = await ensureCommandEveLocalModelWarmup(terminalReceipt, shimUrl, warmCommandEveLocalModel);
          status = await getCommandEveRuntimeStatusPayload();
        },
      });
      const warmupOk = ['ready', 'skipped'].includes(warmupReceipt?.status || '');
      return {
        success: receipt.status === 'ready' && warmupOk,
        data: status ?? (await getCommandEveRuntimeStatusPayload()),
        msg:
          receipt.status !== 'ready'
            ? receipt.next_action
            : warmupOk
              ? undefined
              : warmupReceipt?.error || 'local model warm-up failed',
      };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.commandEve.warmLocalModel.provider(async (request) => {
    try {
      const { getCanonicalDataPath, getDataPath } = await import('./process/utils/utils');
      const { ensureCommandEveRuntimeBootstrap, resolveCommandEveRuntimeBootstrapPaths } =
        await import('./process/commandEve/runtimeBootstrapCore');
      const { startCommandEveOllamaOpenAiShim, warmCommandEveLocalModel } =
        await import('./process/commandEve/ollamaOpenAiShim');
      const tierId = typeof request?.tierId === 'string' ? request.tierId : '';
      const userDataPath = getDataPath();
      const canonicalUserDataPath = getCanonicalDataPath();
      const requireBundledPython = app.isPackaged && process.platform === 'darwin';
      const paths = resolveCommandEveRuntimeBootstrapPaths(
        userDataPath,
        undefined,
        process.platform,
        canonicalUserDataPath
      );
      const shimUrl = rememberCommandEveOllamaShimUrl(
        commandEveOllamaShimUrl ||
          (await startCommandEveOllamaOpenAiShim({
            promptProofPath: commandEvePromptProofPath(paths.runtimeRoot),
            egressReceiptPath: commandEveEgressBoundaryReceiptPath(paths.runtimeRoot),
            eveRouting: buildCommandEveShimRoutingResolver(),
            localOpenAiRouting: buildCommandEveManagedLocalOpenAiRoutingResolver(),
            teamWorkerStatus: buildCommandEveShimTeamStatusResolver(),
            egressRedactionMode: buildCommandEveShimEgressRedactionModeResolver(),
            activeSeatId: buildCommandEveShimActiveSeatIdResolver(),
            activeSeatContext: () => ({
              seatId: getActiveSeatId(),
              seatContextRevision: getActiveSeatContextRevision(),
            }),
            typedUIProviderCompletion: recordCommandEveTypedUIProviderCompletion,
            attributionAgentId: (token, seatId) => resolveDispatchAgentId(token, seatId),
            teamManageBearer: resolveTeamManageBearer,
            teamManagePropose: teamManageProposeHandler,
            honchoDeriverRoute: buildCommandEveShimHonchoDeriverRoute(),
            kanbanAcpBearer: resolveKanbanAcpBearer,
            kanbanAcpPropose: kanbanAcpProposeHandler,
            kanbanAcpRead: readKanbanAcpBoard,
            // CEVE-1821 — injected at EVERY shim start site. A site that forgot it
            // would fall back to the fail-closed default and silently pin that seat
            // to "always ask" for the whole session, with no other symptom.
            commandEveApproval: buildCommandEveShimApprovalResolver(),
            connectedProviderRouting: buildCommandEveShimConnectedProviderResolver(),
            // MAT-1747: the app-owned artifact capability. Injected at EVERY shim
            // start site — the bearer is per-boot, so a site that forgets it would
            // 404 the route for the whole session with no other symptom.
            artifactCapabilityBearer: resolveArtifactCapabilityBearer,
            artifactCapabilityCall: artifactCapabilityCallHandler,
          }))
      );
      let warmupReceipt: CommandEveModelWarmupReceipt | undefined;
      let status: CommandEveRuntimeStatusPayload | undefined;
      const receipt = await ensureCommandEveRuntimeBootstrap({
        userDataPath,
        canonicalUserDataPath,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        requireBundledPython,
        mode: 'auto',
        env: tierId ? { COMMAND_EVE_LOCAL_MODEL_TIER: tierId } : undefined,
        egressProxyUrl: shimUrl,
        // Setting-driven language: thread the operator's selected UI language into
        // the soul so EVE defaults to it (bootstrap re-runs, so it self-corrects).
        uiLanguage: ProcessConfig.getSync('language'),
        // CLI-Keystone runtime glue: read commandEve.workerAssignments + team status
        // and thread codexRuntime ('' — Codex deferred) + the resolved Claude ACP
        // delegate so Desktop binds transport and bootstrap emits the role hint.
        ...(await resolveCommandEveWorkerRuntimeInputs()),
        afterBootstrapExclusive: async (terminalReceipt) => {
          warmupReceipt = await ensureCommandEveLocalModelWarmup(terminalReceipt, shimUrl, warmCommandEveLocalModel);
          status = await getCommandEveRuntimeStatusPayload();
        },
      });
      const warmupOk = ['ready', 'skipped'].includes(warmupReceipt?.status || '');
      return {
        success: receipt.status === 'ready' && warmupOk,
        data: status ?? (await getCommandEveRuntimeStatusPayload()),
        msg:
          receipt.status !== 'ready'
            ? receipt.next_action
            : warmupOk
              ? undefined
              : warmupReceipt?.error || 'local model warm-up failed',
      };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.commandEve.evaluateGateDecision.provider(async (request) => {
    try {
      const { getDataPath } = await import('./process/utils/utils');
      const { resolveCommandEveRuntimeBootstrapPaths } = await import('./process/commandEve/runtimeBootstrapCore');
      const { appendCommandEveGateDecision, evaluateCommandEveGateDecision } =
        await import('./process/commandEve/executionModeCore');
      const action = request?.action;
      if (typeof action !== 'string' || !COMMAND_EVE_GATE_ACTIONS.has(action as CommandEveGateAction)) {
        return { success: false, msg: 'Invalid or missing Command EVE gate action.' };
      }
      const paths = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
      // S9 #8 (DEFER): no renderer writer for `commandEve.executionMode` yet, so
      // this ProcessConfig read resolves to the fixed default 'observed'. The
      // writer (observed/delegated/autonomous autonomy regler = the HG-ladder as
      // UI) is a deliberate open Founder product decision, NOT a store-split bug.
      // Keep on ProcessConfig until the writer is decided (sweep #8, 1.3 plan).
      const mode = await ProcessConfig.get('commandEve.executionMode').catch((): undefined => undefined);
      const decision = evaluateCommandEveGateDecision({ mode, action: action as CommandEveGateAction });
      appendCommandEveGateDecision(commandEveGateAuditPath(paths.runtimeRoot), decision);
      return { success: true, data: decision };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.commandEve.typedUIActionReceipt.provider(async (request) => {
    try {
      const { getDataPath } = await import('./process/utils/utils');
      const { resolveCommandEveRuntimeBootstrapPaths } = await import('./process/commandEve/runtimeBootstrapCore');
      const { authorizeTypedUIAction, finalizeTypedUIAction } =
        await import('./process/commandEve/typedUIActionReceiptCore');
      const paths = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
      const common = {
        attestationAuditPath: commandEveTypedUIProvenanceAuditPath(paths.runtimeRoot),
        activeSeatId: getActiveSeatId(),
        seatContextRevision: getActiveSeatContextRevision(),
        intentClaimDirectory: commandEveTypedUIActionIntentDirectory(paths.runtimeRoot),
      };
      const record =
        request?.request?.phase === 'authorize'
          ? authorizeTypedUIAction(commandEveTypedUIActionAuditPath(paths.runtimeRoot), request.request, {
              ...common,
              executionMode: await ProcessConfig.get('commandEve.executionMode').catch((): undefined => undefined),
              gateAuditPath: commandEveGateAuditPath(paths.runtimeRoot),
            })
          : finalizeTypedUIAction(commandEveTypedUIActionAuditPath(paths.runtimeRoot), request?.request, common);
      return { success: true, data: record };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcBridge.commandEve.typedUIProvenanceAttestation.provider(async (request) => {
    try {
      const { getDataPath } = await import('./process/utils/utils');
      const { resolveCommandEveRuntimeBootstrapPaths } = await import('./process/commandEve/runtimeBootstrapCore');
      const paths = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
      const record = await attestDurableTypedUIArtifact(
        {
          attestationAuditPath: commandEveTypedUIProvenanceAuditPath(paths.runtimeRoot),
          generationLedgerPath: commandEveTypedUIGenerationReceiptPath(paths.runtimeRoot),
          providerCompletionLedgerPath: commandEveTypedUIProviderCompletionReceiptPath(paths.runtimeRoot),
        },
        request?.request,
        {
          activeSeatId: getActiveSeatId(),
          seatContextRevision: getActiveSeatContextRevision(),
        },
        {
          readMessage: (conversationId, sourceMessageId) =>
            httpRequest<TMessage>(
              'GET',
              `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(sourceMessageId)}`,
              undefined,
              { timeoutMs: 5000 }
            ),
        }
      );
      return { success: true, data: record };
    } catch (error) {
      return { success: false, msg: error instanceof Error ? error.message : String(error) };
    }
  });

  // Telemetry consent (opt-in). The renderer privacy toggle reads/writes the
  // consent store through these bridge channels. Sentry stays gated on the
  // persisted value via isTelemetryAllowed() — fail CLOSED on any error.
  bridge.buildProvider<TelemetryConsentBridgeResult, void>(TELEMETRY_CONSENT_GET_CHANNEL).provider(async () => {
    const state = readConsent();
    return { consent: state.consent === true, updatedAt: state.updatedAt };
  });

  bridge
    .buildProvider<TelemetryConsentBridgeResult, { consent: boolean }>(TELEMETRY_CONSENT_SET_CHANNEL)
    .provider(async (request) => {
      const state = setConsent(request?.consent === true);
      // F-11 (Kimi 1.819 audit): dropping consent must also close the Sentry
      // client so already-queued envelopes cannot flush after opt-out. The
      // beforeSend gate alone leaves the offline/retry buffer alive.
      if (state.consent !== true) closeSentry();
      return { consent: state.consent === true, updatedAt: state.updatedAt };
    });
}

/*
 * MAT-1749 — THE CLOUD STARTUP PREFLIGHT IS GONE, NOT MERELY REFUSED.
 *
 * There used to be a `scheduleCommandEveEveLaneWarmup` here that fired a light EVE
 * Inference preflight at startup to warm the TLS/edge path. Its own payload comment
 * said it was shaped so the request "is NOT classified as a local warm-up and is
 * routed through the EVE cloud lane instead" — which is to say every launch on a
 * cloud tier issued a real metered turn. Launching the app is not a user-authorised
 * billable action, so the charge was never ours to make.
 *
 * Deleting the scheduler rather than leaning on the shim's 403 is deliberate. A
 * refusal still costs an authenticated request and still produced a console warning
 * on EVERY cloud-tier start, which trains operators to ignore warnings. No request
 * is the only version of this with nothing to explain away.
 *
 * Edge warming can come back the moment there is a dedicated NON-METERED health
 * endpoint to warm it against. `warmCommandEveEveLane` is kept (as a no-request
 * skip) so that future wiring has something to attach to.
 *
 * The LOCAL model warm-up below is untouched.
 */

/**
 * Lane-aware startup warm-up dispatcher. Reads the SAME effective inference
 * selection the send path resolves, and warms at most the LOCAL lane:
 *
 *   - EVE tier active  → NOTHING is warmed. Not the bundled local model, which the
 *     user will not use — and not the cloud lane either, because warming that meant
 *     sending a real METERED turn at every launch, a charge nobody authorised
 *     (MAT-1749). Silent on purpose: a warning here would announce a decision, not a
 *     fault, on every single cloud-tier start.
 *   - Local selected   → the existing bundled-Ollama model warm-up, unchanged.
 *
 * Fail-soft (nothing here can block app start or throw to the user); the local
 * warm-up keeps its existing receipt/in-flight gating.
 */
function scheduleCommandEveLocalModelWarmup(
  receipt: CommandEveWarmupReceipt,
  shimUrl: string,
  warmup: CommandEveWarmup,
  mark?: (label: string) => void
): void {
  // Resolve the warm-up lane from the LIVE picker selection in the BACKEND store
  // (same source the per-request routing resolver reads), not the main-process
  // ProcessConfig the renderer never writes to. Async + fire-and-forget so boot
  // is not blocked. Wait for the backend settings store before resolving; a
  // speculative local fallback can load a multi-GB model even when the user
  // selected cloud and can make low-memory Macs unresponsive.
  void (async () => {
    if (backendStartupFailed) return;

    let lane: ReturnType<typeof resolveCommandEveWarmupLane>;
    try {
      await waitForCommandEveBackendPort(30_000);
      lane = resolveCommandEveWarmupLane(await readInferenceSelectionFromBackendStrict());
    } catch (error) {
      console.warn('[Command EVE] Could not resolve warm-up lane; skipping speculative warm-up:', error);
      return;
    }

    if (lane.lane === 'eve') {
      // EVE is the active lane, so we do NOTHING at startup. We must not load Gemma
      // into VRAM the user will not use, and we must not warm the cloud lane either:
      // that warming was a metered turn the user never asked for (MAT-1749). Silent
      // on purpose — a warning here would fire on every cloud-tier launch and would
      // describe a decision, not a problem.
      return;
    }

    // Local lane: keep the existing bundled-model warm-up (receipt-gated).
    if (!runtimeReceiptAllowsLocalModelWarmup(receipt)) return;
    void ensureCommandEveLocalModelWarmup(receipt, shimUrl, warmup, mark);
  })();
}

function registerCronResumeBridge(backendPort: number): void {
  disposeCronResumeListener?.();

  const onResume = () => {
    void fetch(`http://127.0.0.1:${backendPort}/api/cron/internal/system-resume`, {
      method: 'POST',
      headers: {
        'x-aionui-internal': '1',
      },
    }).catch((error) => {
      console.error('[CommandEVE] Failed to notify backend about system resume:', error);
    });
  };

  powerMonitor.on('resume', onResume);
  disposeCronResumeListener = () => {
    powerMonitor.removeListener('resume', onResume);
  };
}

/**
 * Run one-shot backend migrations after the renderer has loaded. Some steps
 * (ConfigStorage.get, ipcBridge.listProviders) route through the renderer via
 * BroadcastChannel, so invoking them before the renderer exists deadlocks the
 * main process. Called from did-finish-load.
 */
const scheduleBackendMigrations = (): void => {
  if (backendMigrationsScheduled || !backendStartedOk) return;
  backendMigrationsScheduled = true;
  void (async () => {
    try {
      const { runBackendMigrations } = await import('./process/utils/runBackendMigrations');
      await runBackendMigrations(ProcessConfig, { userDataPath: getDataPath() });
      console.info('[CommandEVE] runBackendMigrations completed');
    } catch (error) {
      console.error('[CommandEVE] Backend migration hook threw:', error);
    }
  })();
};

async function ensureCommandEveLocalProviderAfterBackendStart(context: 'boot' | 'seat-respawn'): Promise<void> {
  const { ensureCommandEveLocalRuntimeProvider } = await import('./process/commandEve/providerBootstrap');
  const result = await ensureCommandEveLocalRuntimeProvider();
  if (result.status === 'disabled') {
    console.info(`[CommandEVE] Local runtime provider bootstrap skipped during ${context} (upstream shell).`);
    return;
  }
  console.info(
    `[CommandEVE] Local runtime provider ready during ${context} (attempts=${result.attempts}, created=${result.created}, conflict=${result.conflict}).`
  );
}

const createWindow = ({ showOnReady = true }: { showOnReady?: boolean } = {}): void => {
  console.log('[CommandEVE] Creating main window...');
  const { x: windowX, y: windowY, width: windowWidth, height: windowHeight } = resolveInitialBounds();

  // Get app icon for development mode (Windows/Linux need icon in BrowserWindow)
  // In production, icons are set via forge.config.ts packagerConfig
  let devIcon: Electron.NativeImage | undefined;
  if (!app.isPackaged) {
    try {
      // Windows: app.ico (no dev version), Linux: app_dev.png (with padding)
      const iconFile = process.platform === 'win32' ? 'app.ico' : 'app_dev.png';
      const iconPath = path.join(process.cwd(), 'resources', iconFile);
      if (fs.existsSync(iconPath)) {
        devIcon = nativeImage.createFromPath(iconPath);
        if (devIcon.isEmpty()) devIcon = undefined;
      }
    } catch {
      // Ignore icon loading errors in development
    }
  }

  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    ...(windowX !== undefined && windowY !== undefined ? { x: windowX, y: windowY } : {}),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false, // Hide until CSS is loaded to prevent FOUC
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    // Set icon for Windows/Linux in development mode
    ...(devIcon && process.platform !== 'darwin' ? { icon: devIcon } : {}),
    // Custom titlebar configuration / 自定义标题栏配置
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          // Align traffic-light vertical center with the titlebar button centers.
          // Titlebar is 45px; buttons are 36px flex-centered → button center y≈22.5.
          // Empirically y=13 places the traffic lights on the same horizontal line
          // as the sidebar / back / forward icons.
          // NOTE: requires a full app restart to take effect (BrowserWindow option).
          trafficLightPosition: { x: 10, y: 13 },
        }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
      enableWebSQL: false,
      webviewTag: true, // 启用 webview 标签用于 HTML 预览 / Enable webview tag for HTML preview
    },
  });
  console.log(`[CommandEVE] Main window created (id=${mainWindow.id})`);
  configureMainRendererSessionPermissions(mainWindow);
  configureMainRendererBackendCapability(mainWindow, {
    getPort: () => backendManager.port,
    getCapability: () => backendManager.localCapability,
  });
  setupEditableContextMenu(mainWindow.webContents);

  if (isTelemetryAllowed()) {
    scheduleStartupLogReport(mainWindow);
  }

  // Show window after content is ready to prevent FOUC (Flash of Unstyled Content)
  // Use 'ready-to-show' which fires when renderer has painted first frame,
  // combined with 'did-finish-load' as belt-and-suspenders approach.
  if (showOnReady) {
    const showWindow = () => {
      if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        console.log('[CommandEVE] Showing main window');
        mainWindow.show();
        mainWindow.focus();
      }
    };
    mainWindow.once('ready-to-show', () => {
      console.log('[CommandEVE] Window ready-to-show');
      showWindow();
    });
    // Belt-and-suspenders: also show on did-finish-load in case ready-to-show already fired
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('[CommandEVE] Renderer did-finish-load');
      showWindow();
      scheduleBackendMigrations();
    });
    // Fallback: show window after 5s even if events don't fire (e.g. loadURL failure)
    setTimeout(showWindow, 5000);
  } else if (process.platform === 'darwin' && app.dock) {
    void app.dock.hide();
  }

  initMainAdapterWithWindow(mainWindow);
  bindMainWindowReferences(mainWindow);

  setupApplicationMenu();

  setupZoomForWindow(mainWindow);
  registerWindowMaximizeListeners(mainWindow);
  attachWindowBoundsPersistence(mainWindow, (bounds) => ProcessConfig.set('window.bounds', bounds));

  // Initialize auto-updater service (skip when disabled via env, e.g. E2E / CI)
  // 初始化自动更新服务（通过环境变量禁用时跳过，例如 E2E / CI 场景）
  const isCiRuntime = process.env.CI === 'true' || process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true';
  const isAutoUpdateE2E = process.env.AIONUI_AUTO_UPDATE_E2E === '1';
  const disableAutoUpdater =
    process.env.AIONUI_DISABLE_AUTO_UPDATE === '1' ||
    (process.env.AIONUI_E2E_TEST === '1' && !isAutoUpdateE2E) ||
    isCiRuntime;
  if (!disableAutoUpdater) {
    Promise.all([import('./process/services/autoUpdaterService'), import('./process/bridge/updateBridge')])
      .then(([{ autoUpdaterService }, { createAutoUpdateStatusBroadcast }]) => {
        // Create status broadcast callback that emits via ipcBridge (pure emitter, no window binding)
        const statusBroadcast = createAutoUpdateStatusBroadcast();
        autoUpdaterService.initialize(statusBroadcast);
        // Check for updates after 3 seconds delay
        // 3秒后检查更新
        setTimeout(() => {
          void autoUpdaterService.checkForUpdatesAndNotify();
        }, 3000);
      })
      .catch((error) => {
        console.error('[App] Failed to initialize autoUpdaterService:', error);
      });
  } else {
    console.log('[CommandEVE] Auto-updater disabled via env/CI guard');
  }

  // Load the renderer: dev server URL in development, built HTML file in production
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  const fallbackFile = path.join(__dirname, '../renderer/index.html');
  const rendererUrlPolicy = { isPackaged: app.isPackaged, rendererUrl, fallbackFile };
  const openExternalNavigation = (targetUrl: string): void => {
    if (!isSafeExternalNavigationUrl(targetUrl)) return;
    void shell.openExternal(targetUrl).catch((error) => {
      console.error('[CommandEVE] Failed to open external navigation:', error);
    });
  };

  const guardMainFrameNavigation = (event: Electron.Event, targetUrl: string): void => {
    if (isTrustedMainRendererUrl(targetUrl, rendererUrlPolicy)) return;
    event.preventDefault();
    openExternalNavigation(targetUrl);
  };

  mainWindow.webContents.on('will-navigate', guardMainFrameNavigation);
  mainWindow.webContents.on('will-redirect', guardMainFrameNavigation);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalNavigation(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    hardenAttachedWebviewPreferences(webPreferences as unknown as Record<string, unknown>);
    if (!isAllowedWebviewSource(params.src)) event.preventDefault();
  });
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    const registration = getCdpBridgeHandle()?.registerGuest(guest);
    if (registration?.ok === false) {
      console.warn('[CommandEVE][BrowserControl] Refused guest registration:', registration.reason);
    }
    const guardGuestNavigation = (event: Electron.Event, targetUrl: string): void => {
      if (isAllowedWebviewNavigation(guest.getURL(), targetUrl)) return;
      event.preventDefault();
    };

    guest.on('will-navigate', (event) => guardGuestNavigation(event, event.url));
    guest.on('will-redirect', (event) => guardGuestNavigation(event, event.url));
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  if (!app.isPackaged && rendererUrl) {
    console.log(`[CommandEVE] Loading renderer URL: ${rendererUrl}`);
    mainWindow.loadURL(rendererUrl).catch((error) => {
      console.error('[CommandEVE] loadURL failed, falling back to file:', error.message || error);
      mainWindow.loadFile(fallbackFile).catch((e2) => {
        console.error('[CommandEVE] loadFile fallback also failed:', e2.message || e2);
      });
    });
  } else {
    console.log(`[CommandEVE] Loading renderer file: ${fallbackFile}`);
    mainWindow.loadFile(fallbackFile).catch((error) => {
      console.error('[CommandEVE] loadFile failed:', error.message || error);
    });
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error('[CommandEVE] did-fail-load:', { errorCode, errorDescription, validatedURL, isMainFrame });
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[CommandEVE] render-process-gone:', details);
    getCdpBridgeHandle()?.detachActiveTarget('main renderer process exited');

    // Reload the renderer to recover from the crash.
    // The isDestroyed() guard in adapter/main.ts prevents further sends
    // to the dead webContents while the reload is in progress.
    if (!mainWindow.isDestroyed()) {
      console.log('[CommandEVE] Attempting to recover from renderer crash by reloading...');

      if (!app.isPackaged && rendererUrl) {
        mainWindow.loadURL(rendererUrl).catch((error) => {
          console.error('[CommandEVE] Recovery loadURL failed:', error.message || error);
        });
      } else {
        mainWindow.loadFile(fallbackFile).catch((error) => {
          console.error('[CommandEVE] Recovery loadFile failed:', error.message || error);
        });
      }
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[CommandEVE] Renderer became unresponsive');
  });

  mainWindow.on('closed', () => {
    console.log('[CommandEVE] Main window closed');
  });

  // DevTools is no longer auto-opened at startup.
  // Use the DevTools toggle in Settings > System (dev mode only) to open it.

  // Listen to DevTools state changes and notify Renderer
  mainWindow.webContents.on('devtools-opened', () => {
    ipcBridge.application.devToolsStateChanged.emit({ isOpen: true });
  });

  mainWindow.webContents.on('devtools-closed', () => {
    ipcBridge.application.devToolsStateChanged.emit({ isOpen: false });
  });

  // 关闭拦截：当启用"关闭到托盘"时，隐藏窗口而非关闭
  // Close interception: hide window instead of closing when "close to tray" is enabled
  mainWindow.on('close', (event) => {
    if (mainWindow.isDestroyed()) return;
    if (getCloseToTrayEnabled() && !getIsQuitting()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
};

const handleAppReady = async (): Promise<void> => {
  const t0 = performance.now();
  const mark = (label: string) => console.log(`[CommandEVE:ready] ${label} +${Math.round(performance.now() - t0)}ms`);
  mark('start');

  // S10: resolve + set COMMAND_EVE_COMPANY_OS_ROOT BEFORE initializeProcess()
  // registers the bridge providers that read it (command-center / status-surface).
  // Honest: sets it only when a real Company.OS checkout is detectable; otherwise
  // leaves it unset so those cores fail-closed cleanly on end-user installs.
  setCommandEveCompanyOsRootEnv();
  mark('companyOsRootEnv');

  if (!app.isPackaged && process.env.AIONUI_DISABLE_DEVTOOLS !== '1') {
    // Developer tooling is optional. A slow or unavailable extension source must
    // never hold the renderer and the rest of the runtime behind a network wait.
    void (async () => {
      try {
        const { default: installExtension, REACT_DEVELOPER_TOOLS } = await import('electron-devtools-installer');
        await installExtension(REACT_DEVELOPER_TOOLS);
        console.log('[DevTools] React Developer Tools installed');
      } catch (e) {
        console.warn('[DevTools] Failed to install React DevTools:', e);
      }
    })();
  }

  // CLI mode: print app version and exit immediately (used by CI smoke tests)
  if (isVersionMode) {
    console.log(app.getVersion());
    app.exit(0);
    return;
  }

  // Set dock icon in development mode on macOS
  // In production, the icon is set via forge.config.ts packagerConfig.icon
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    try {
      const iconPath = path.join(process.cwd(), 'resources', 'app_dev.png');
      if (fs.existsSync(iconPath)) {
        const icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
          app.dock.setIcon(icon);
        }
      }
    } catch {
      // Ignore dock icon errors in development
    }
  }

  if (isTelemetryAllowed()) {
    setSentryDeviceId();
  }

  try {
    await initializeProcess();
    mark('initializeProcess');
    registerCommandEveRuntimeBridge();
  } catch (error) {
    console.error('Failed to initialize process:', error);
    app.exit(1);
    return;
  }

  // Command EVE exposes exactly the visible workbench browser to Hermes. The
  // bridge and account+seed context start before runtime provisioning/backend
  // spawn so Hermes inherits the owner-only dynamic context-file path. Failure
  // is fail-closed: no endpoint is exported.
  if (COMMAND_EVE_SHELL_ENABLED && !isWebUIMode && !isResetPasswordMode) {
    try {
      const { startCdpBridge } = await import('./process/resources/builtinMcp/cdpBridge');
      const { setCdpBridgeHandle } = await import('./process/resources/builtinMcp/cdpBridgeRegistry');
      const { initializeBrowserWorkbenchContext } = await import('./process/commandEve/browserWorkbenchContextMain');
      const browserBridge = await startCdpBridge();
      setCdpBridgeHandle(browserBridge);
      initializeBrowserWorkbenchContext(getDataPath());
      process.env.AIONUI_CDP_ACTIVE_PORT = String(browserBridge.port);
      app.once('will-quit', () => {
        void browserBridge.close();
        setCdpBridgeHandle(null);
      });
      mark(`browserWorkbenchBridge (port=${browserBridge.port})`);
    } catch (error) {
      delete process.env.BROWSER_CDP_URL;
      delete process.env.COMMAND_EVE_BROWSER_CONTEXT_FILE;
      delete process.env.AIONUI_CDP_ACTIVE_PORT;
      console.error('[CommandEVE] Visible browser bridge failed; Hermes browser control stays disabled.', error);
    }
  }

  try {
    // Until the packaged-runtime preflight itself succeeds, every early error
    // in this block is treated as a possible ABI-repair failure. This is set
    // before dynamic imports, shim startup, seat restoration or config reads so
    // none of those paths can accidentally let AionCore start unverified.
    commandEveAutomaticRuntimeRepairRequired = app.isPackaged;
    const requirePackagedHermesRuntime = app.isPackaged && process.platform === 'darwin';
    const { getCanonicalDataPath, getDataPath } = await import('./process/utils/utils');
    const { startCommandEveOllamaOpenAiShim, warmCommandEveLocalModel } =
      await import('./process/commandEve/ollamaOpenAiShim');
    const {
      commandEveRuntimeBootstrapStartupWaitReason,
      commandEveRuntimeHasPreexistingArtifacts,
      commandEveRuntimeManagedAncestryIsSafe,
      commandEveRuntimeMutableArtifactsMatchAdmissionProof,
      ensureCommandEveRuntimeBootstrap,
      ensureCommandEveRuntimeBackendAdmission,
      inspectCommandEveRuntimeBackendAdmission,
      prepareCommandEveRuntimeProcessEnv,
      provisionSeatRuntimeFiles,
      resolveCommandEveRuntimeBootstrapPaths,
    } = await import('./process/commandEve/runtimeBootstrapCore');
    const runtimeUserDataPath = getDataPath();
    const canonicalRuntimeUserDataPath = getCanonicalDataPath();
    const runtimePaths = resolveCommandEveRuntimeBootstrapPaths(
      runtimeUserDataPath,
      undefined,
      process.platform,
      canonicalRuntimeUserDataPath
    );
    commandEvePackagedRuntimeExistedAtBoot =
      requirePackagedHermesRuntime && commandEveRuntimeHasPreexistingArtifacts(runtimePaths);
    let automaticRuntimeRepairReason: ReturnType<typeof commandEveRuntimeBootstrapStartupWaitReason> = null;
    if (app.isPackaged) {
      try {
        automaticRuntimeRepairReason = commandEveRuntimeBootstrapStartupWaitReason({
          userDataPath: runtimeUserDataPath,
          canonicalUserDataPath: canonicalRuntimeUserDataPath,
          resourcesPath: process.resourcesPath,
          env: process.env,
          requireBundledPython: requirePackagedHermesRuntime,
        });
      } catch (error) {
        automaticRuntimeRepairReason = 'python_venv_recovery';
        console.error('[Command EVE] Runtime repair preflight failed closed:', error);
      }
    }
    commandEveAutomaticRuntimeRepairRequired = automaticRuntimeRepairReason !== null;
    if (
      app.isPackaged &&
      !commandEveRuntimeManagedAncestryIsSafe({
        userDataPath: runtimeUserDataPath,
        canonicalUserDataPath: canonicalRuntimeUserDataPath,
      })
    ) {
      throw new Error('Command EVE managed runtime ancestry is unsafe; refusing any runtime write or backend start.');
    }
    const shimUrl = rememberCommandEveOllamaShimUrl(
      await startCommandEveOllamaOpenAiShim({
        promptProofPath: commandEvePromptProofPath(runtimePaths.runtimeRoot),
        egressReceiptPath: commandEveEgressBoundaryReceiptPath(runtimePaths.runtimeRoot),
        eveRouting: buildCommandEveShimRoutingResolver(),
        localOpenAiRouting: buildCommandEveManagedLocalOpenAiRoutingResolver(),
        teamWorkerStatus: buildCommandEveShimTeamStatusResolver(),
        egressRedactionMode: buildCommandEveShimEgressRedactionModeResolver(),
        activeSeatId: buildCommandEveShimActiveSeatIdResolver(),
        activeSeatContext: () => ({
          seatId: getActiveSeatId(),
          seatContextRevision: getActiveSeatContextRevision(),
        }),
        typedUIProviderCompletion: recordCommandEveTypedUIProviderCompletion,
        // SG-1 A1: the real seat-partitioned attribution resolver (still yields `eve`
        // in 1.7.0 until the 1.8 header producer, but now wired + testable end-to-end).
        attributionAgentId: (token, seatId) => resolveDispatchAgentId(token, seatId),
        // SG-1 Design B: team_manage propose route — bearer + handler are ISO-6-gated
        // (resolveTeamManageBearer returns "" on a client seat, making the route inert).
        teamManageBearer: resolveTeamManageBearer,
        teamManagePropose: teamManageProposeHandler,
        // COMPA-626 kanban-ACP (the cold-boot shim start — this is the normal path, so it
        // MUST inject the kanban handlers or EVE's routes 404 despite the SOUL clause).
        honchoDeriverRoute: buildCommandEveShimHonchoDeriverRoute(),
        kanbanAcpBearer: resolveKanbanAcpBearer,
        kanbanAcpPropose: kanbanAcpProposeHandler,
        kanbanAcpRead: readKanbanAcpBoard,
        commandEveApproval: buildCommandEveShimApprovalResolver(),
        connectedProviderRouting: buildCommandEveShimConnectedProviderResolver(),
        artifactCapabilityBearer: resolveArtifactCapabilityBearer,
        artifactCapabilityCall: artifactCapabilityCallHandler,
      })
    );
    commandEveOllamaShimStartFailure = undefined;
    mark(`commandEveOllamaShim (${shimUrl})`);
    // CEVE-18205 — THE BOOT-TIME SEAT RESTORE, and it must run HERE: the bake
    // below reads getActiveSeatId()/getActiveSeatLabel() to home HERMES_HOME and
    // the seat env trio for every child process, so a restore that happened after
    // it would describe one seat while the children ran in another.
    //
    // This is the restore the comment below used to say did not exist. Without it
    // every launch came up on LEGACY_SEAT_ID, and because `seatScopedKey` returns
    // the key UNCHANGED on the legacy seat, main read `commandEve.maxEntitled`
    // UN-NAMESPACED while the renderer had written `seat:<uuid>:commandEve.maxEntitled`.
    // The value existed and was simply not looked at, so `maxEntitled` resolved to
    // `undefined` and the turn parked on "Berechtigung wird geprüft" instead of
    // routing MAX or Standard. The renderer could not compensate: it asks MAIN for
    // the id over `command-eve.active-seat`, so both sides agreed on the wrong seat.
    //
    // FAIL-CLOSED: an absent/unreadable/malformed pointer leaves the holder on the
    // legacy seat — byte-identical to the previous behaviour. See
    // `activeSeatPointerStore.restoreActiveSeatFromPointer`.
    const restoredSeat = restoreActiveSeatFromPointer(getDataPath());
    if (restoredSeat.source === 'pointer') {
      mark(`commandEveActiveSeatRestore (${restoredSeat.seatId})`);
    }
    // Seat-Context-Bridge (B1): this bakes the env trio (COMMAND_EVE_ACTIVE_SEAT /
    // _SEAT_LABEL / HERMES_KANBAN_BOARD) alongside HERMES_HOME. The active seat is
    // whatever the restore above resolved: a saved seat when this install has one,
    // otherwise the legacy/founder home with the 'Founder' label default. A real
    // seat's label/kind ride the same pointer, and are re-captured at
    // applySeatSwitch and re-baked on the switch re-spawn.
    prepareCommandEveRuntimeProcessEnv(getDataPath(), process.env, process.platform, process.resourcesPath, {
      requireBundledPython: requirePackagedHermesRuntime,
    });
    // S9 #5 store-split fix: `localModelTierId` is a RENDERER-written key (the
    // local-model tier picker persists it to the BACKEND store, not the
    // main-process ProcessConfig this used to read). Read it from the backend so
    // the picked tier actually reaches the bootstrap env. Fail-direction
    // unchanged: absent OR unreadable ⇒ undefined ⇒ bootstrap's own tier default
    // (the reader THROWS on a backend error, so fail-soft to an empty bag here).
    const localModelTierBag = await readCommandEveSettingsFromBackend(['commandEve.localModelTierId']).catch(
      (): Record<string, unknown> => ({})
    );
    const localModelTierId = localModelTierBag['commandEve.localModelTierId'] as string | undefined;
    // CLI-Keystone runtime glue: resolve codexRuntime ('' — Codex deferred) + the
    // status-allowed Claude ACP delegate from commandEve.workerAssignments BEFORE the
    // bootstrap so trusted transport and the SOUL role hint agree.
    const workerRuntimeInputs = await resolveCommandEveWorkerRuntimeInputs();
    const provisionedRuntimeFiles = provisionSeatRuntimeFiles({
      userDataPath: getDataPath(),
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      env: localModelTierId ? { COMMAND_EVE_LOCAL_MODEL_TIER: localModelTierId } : undefined,
      egressProxyUrl: shimUrl,
      uiLanguage: ProcessConfig.getSync('language'),
      ...workerRuntimeInputs,
    });
    if (!provisionedRuntimeFiles.ok) {
      console.warn(
        `[Command EVE] Runtime file provisioning skipped: ${provisionedRuntimeFiles.error || 'unknown error'}`
      );
    } else if (provisionedRuntimeFiles.bundled_skill_failures.length > 0) {
      console.warn(
        `[Command EVE] Runtime file provisioning completed with ${provisionedRuntimeFiles.bundled_skill_failures.length} bundled skill warning(s).`
      );
    } else {
      mark('commandEveRuntimeFilesProvisioned');
    }
    const bootstrapOptions = {
      userDataPath: runtimeUserDataPath,
      canonicalUserDataPath: canonicalRuntimeUserDataPath,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath,
      requireBundledPython: requirePackagedHermesRuntime,
      mode: 'auto',
      env: localModelTierId ? { COMMAND_EVE_LOCAL_MODEL_TIER: localModelTierId } : undefined,
      egressProxyUrl: shimUrl,
      // Setting-driven language: thread the operator's selected UI language into
      // the soul so EVE defaults to it (bootstrap re-runs, so it self-corrects).
      uiLanguage: ProcessConfig.getSync('language'),
      ...workerRuntimeInputs,
    } satisfies Parameters<typeof ensureCommandEveRuntimeBootstrap>[0];
    ensureCommandEveRuntimeAdmissionForRespawn = requirePackagedHermesRuntime
      ? async (allowFullBootstrapRepair) => {
          const proof = await ensureCommandEveRuntimeBackendAdmission(bootstrapOptions, process.env, {
            allowFullBootstrapRepair,
          });
          return () => {
            if (
              !commandEveRuntimeMutableArtifactsMatchAdmissionProof({
                paths: proof.paths,
                resourcesPath: process.resourcesPath,
                admission: proof.admission,
              })
            ) {
              throw new Error('COMMAND_EVE_RUNTIME_MUTABLE_ARTIFACTS_CHANGED_BEFORE_START');
            }
          };
        }
      : undefined;
    const deferRemainingRuntimeBootstrap = (hermesReadyBeforeBootstrap: boolean): void => {
      runDeferredCommandEveRuntimeBootstrap = () => {
        setTimeout(() => {
          void ensureCommandEveRuntimeBootstrap(bootstrapOptions)
            .then(async (receipt) => {
              console.info(`[Command EVE] Runtime bootstrap ${receipt.status}: ${receipt.next_action}`);
              if (
                shouldRestartWindowsBackendAfterRuntimeBootstrap({
                  platform: process.platform,
                  surface: isWebUIMode ? 'webui' : 'desktop',
                  runtimeProfile: receipt.runtime_profile,
                  receiptStatus: receipt.status,
                  hermesReadyBeforeBootstrap,
                  hermesReadyAfterBootstrap: fs.existsSync(runtimePaths.hermesShim),
                })
              ) {
                const {
                  restartCommandEveBackendForSeat: restartCommandEveBackendAfterWindowsBootstrap,
                  runCommandEveBackendRestartReservation: reserveCommandEveBackendAfterWindowsBootstrap,
                } = await import('./process/commandEve/seatSwitchRuntime');
                await reserveCommandEveBackendAfterWindowsBootstrap(
                  (restartLease) => restartCommandEveBackendAfterWindowsBootstrap(restartLease),
                  { queueWaitTimeoutMs: COMMAND_EVE_DEFERRED_RUNTIME_RESTART_QUEUE_WAIT_MS }
                );
                mark('commandEveBackendRestartAfterRuntimeBootstrap');
              }
              scheduleCommandEveLocalModelWarmup(receipt, shimUrl, warmCommandEveLocalModel, mark);
              startCommandEveCuratorTick(runtimePaths);
            })
            .catch((error) => {
              console.error('[Command EVE] Runtime bootstrap failed:', error);
            });
        }, 1000);
      };
      mark('commandEveRuntimeBootstrap deferred');
    };
    // Inspect the last completed receipt before starting the next bootstrap.
    // ensureCommandEveRuntimeBootstrap writes partial receipts synchronously up
    // to its first await; checking afterwards made every warm launch look stale
    // and forced the full Hermes/Ollama probe back onto the startup path.
    // First-run runtime provisioning can legitimately spend a minute installing
    // Hermes. Keep a cold install interactive. An EXISTING venv that needs an
    // ABI swap/recovery is different: the canonical Hermes entry point is moved
    // during that transaction, so it must finish before AionCore can admit work.
    const mustWaitForRuntimeBootstrap =
      commandEveAutomaticRuntimeRepairRequired ||
      (shouldBlockStartupForCommandEveRuntimeBootstrap &&
        commandEveRuntimeBootstrapNeedsStartupWait(runtimePaths.receiptPath, app.getVersion()));
    if (mustWaitForRuntimeBootstrap) {
      const receipt = await ensureCommandEveRuntimeBootstrap({
        ...bootstrapOptions,
        stopAfterHermesRuntimeReady: commandEveAutomaticRuntimeRepairRequired,
      });
      const repairedAdmission = commandEveAutomaticRuntimeRepairRequired
        ? inspectCommandEveRuntimeBackendAdmission({
            userDataPath: runtimeUserDataPath,
            canonicalUserDataPath: canonicalRuntimeUserDataPath,
            resourcesPath: process.resourcesPath,
            env: bootstrapOptions.env,
            requireBundledPython: requirePackagedHermesRuntime,
          })
        : undefined;
      if (repairedAdmission?.ok === false) {
        throw new Error(
          `Command EVE automatic Python runtime repair did not reach a backend-admissible state (${repairedAdmission.reason}).`
        );
      }
      mark(`commandEveRuntimeBootstrap (${receipt.status})`);
      if (commandEveAutomaticRuntimeRepairRequired) {
        deferRemainingRuntimeBootstrap(true);
      } else {
        scheduleCommandEveLocalModelWarmup(receipt, shimUrl, warmCommandEveLocalModel, mark);
        startCommandEveCuratorTick(runtimePaths);
      }
    } else {
      const hermesReadyBeforeBootstrap = fs.existsSync(runtimePaths.hermesShim);
      deferRemainingRuntimeBootstrap(hermesReadyBeforeBootstrap);
    }
  } catch (error) {
    if (!commandEveOllamaShimUrl || commandEveAutomaticRuntimeRepairRequired) {
      commandEveOllamaShimStartFailure = error;
    }
    console.error('[Command EVE] Runtime bootstrap could not be scheduled:', error);
  }

  // Start aioncore only after initializeProcess(). initStorage may open
  // the legacy Electron SQLite catalog for a one-shot v26 migration and must
  // close it before the backend touches the same file.
  try {
    const { getSystemDir, getBackendDataDir } = await import('./process/utils/initStorage');
    const sysDir = getSystemDir();
    if (commandEveOllamaShimStartFailure) {
      const detail =
        commandEveOllamaShimStartFailure instanceof Error
          ? commandEveOllamaShimStartFailure.message
          : String(commandEveOllamaShimStartFailure);
      throw new Error(
        `Command EVE loopback shim failed to start; refusing to start Hermes backend because it would otherwise talk to a stale or foreign shim. ${detail}`
      );
    }
    // Synchronous seat provisioning runs after the early warm-start probe and
    // intentionally cannot carry a signed Resources proof. Re-prove and repair
    // an EXISTING packaged runtime at the actual backend-admission boundary so
    // a marker-retaining or mode-only launcher mutation cannot reach AionCore.
    // A genuinely clean cold install has no managed runtime artifacts and keeps
    // the existing interactive/deferred bootstrap behaviour. A stale root,
    // shim, wrapper or receipt without a venv is not cold and must repair here.
    const recheckCommandEveRuntimeBeforeInitialStart =
      ensureCommandEveRuntimeAdmissionForRespawn && commandEvePackagedRuntimeExistedAtBoot
        ? await ensureCommandEveRuntimeAdmissionForRespawn(true)
        : undefined;
    // ISO-4 CRITICAL: the FIRST positional arg is the backend --data-dir (the
    // live conversation+message SQLite). It MUST be seat-scoped to the ACTIVE
    // seat — NOT the global getDataPath() — else seat B's renderer reads seat A's
    // conversation list / message bodies / full-text search. getBackendDataDir()
    // returns getDataPath() byte-identical for the legacy seat (existing chat DB
    // preserved in place) and <getDataPath()>/seats/<id> for a real seat. Kept
    // consistent with sysDir.cacheDir/workDir, which are scoped the same way.
    // Pre-flight: heal any orphaned (soft-deleted) EVE assistant_definition
    // BEFORE aioncore boots. Otherwise its router.assistant.bootstrap crashes on
    // the active-assistant ↔ soft-deleted-definition inconsistency left by the
    // de-founder-ize re-seed's DELETE+POST → "incomplete installation" brick on
    // every restart. Fail-open (never blocks the spawn). See assistantStorageRepair.ts.
    try {
      const { repairCommandEveAssistantStorage } = await import('./process/commandEve/assistantStorageRepair');
      const runtimePathsForRepair = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
      const repair = await repairCommandEveAssistantStorage(getBackendDataDir(), {
        hermesCommandPath: runtimePathsForRepair.hermesShim,
        nativeSkillsDirs: [runtimePathsForRepair.managedSkillsRoot],
      });
      if (repair.repaired > 0) {
        console.warn(
          `[CommandEVE] Pre-flight assistant-storage repair: re-activated ${repair.repaired} orphaned definition(s).`
        );
      }
      if (repair.rebound && repair.rebound > 0) {
        console.warn(
          `[CommandEVE] Pre-flight assistant-storage repair: re-bound ${repair.rebound} EVE definition(s) aionrs→hermes.`
        );
      }
      if (repair.registryRebound && repair.registryRebound > 0) {
        console.warn(
          `[CommandEVE] Pre-flight assistant-storage repair: pinned ${repair.registryRebound} Hermes registry row(s) to the app-managed shim.`
        );
      }
      if (repair.nativeSkillsRebound && repair.nativeSkillsRebound > 0) {
        console.warn(
          `[CommandEVE] Pre-flight assistant-storage repair: enabled native Hermes skill discovery for ${repair.nativeSkillsRebound} registry row(s).`
        );
      }
      if (repair.reseeded && repair.reseeded > 0) {
        console.warn(
          `[CommandEVE] Pre-flight assistant-storage repair: cleared ${repair.reseeded} orphaned EVE mirror row(s) with no live definition (will re-seed via POST).`
        );
      }
    } catch (error) {
      console.warn('[CommandEVE] Pre-flight assistant-storage repair skipped:', error);
    }
    recheckCommandEveRuntimeBeforeInitialStart?.();
    const backendPort = await backendManager.start(
      getBackendDataDir(),
      sysDir.logDir,
      {
        cacheDir: sysDir.cacheDir,
        workDir: sysDir.workDir,
        logDir: sysDir.logDir,
      },
      commandEveBackendStartOptions
    );
    mark(`backendManager.start (port=${backendPort})`);
    // Expose the backend port to main-process callers of httpBridge (e.g. the
    // one-shot assistant migration hook below). Must land BEFORE any
    // ipcBridge.* invoke from the main process — the renderer side reads
    // window.__backendPort via preload, but main has no `window`.
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = backendPort;
    registerCronResumeBridge(backendPort);
    try {
      await ensureCommandEveLocalProviderAfterBackendStart('boot');
    } catch (error) {
      // Cloud and upstream-compatible surfaces remain usable, but the local
      // lane must not claim readiness. The on-demand bridge retries this
      // bounded bootstrap before returning a local provider.
      console.error('[CommandEVE] Local runtime provider is not ready after backend boot:', error);
    }
    backendStartedOk = true;

    // A5 / SLICE B — register the seat-switch backend re-spawn hook. A seat
    // switch MUST stop + re-spawn aioncore so the new ACP agent inherits the
    // freshly-baked process.env.HERMES_HOME (a running agent's HERMES_HOME is
    // env-frozen at spawn — runtimeBootstrapCore.ts:1144). The hook re-runs the
    // SAME prepareEnv→start sequence as boot, for the now-active seat.
    // RESPAWN GENERATION — guards the GLOBAL post-start writes below (__backendPort,
    // cron-resume bridge, assistant prompt). The bridge's in-flight lock + 300s watchdog
    // can, in the worst case (a respawn whose start() lives past 300s), let a NEWER switch
    // run fully while this one is still parked on its own start(). When this stale switch
    // finally returns, it must NOT clobber the newer switch's global state with its own
    // (already SIGKILLed) port. Captured at hook entry; re-checked after start().
    let commandEveRespawnGeneration = 0;
    setCommandEveBackendAuthorityFailClosed(async () => {
      const cleanupErrors: string[] = [];
      let terminationError: unknown;
      // Remove external truth before the destructive stop. The manager clears
      // its own port synchronously at stop entry, even if registry cleanup later
      // throws after the child is already dead.
      delete (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
      try {
        disposeCronResumeListener?.();
      } catch (error) {
        cleanupErrors.push(commandEveAuthorityDiagnostic(error, 'cron listener cleanup failed'));
      } finally {
        disposeCronResumeListener = null;
      }
      try {
        await backendManager.stop();
      } catch (error) {
        if (commandEveAuthorityErrorCode(error) === COMMAND_EVE_BACKEND_TERMINATION_UNPROVEN) {
          terminationError = error;
        } else {
          cleanupErrors.push(commandEveAuthorityDiagnostic(error, 'backend stop cleanup failed'));
        }
      } finally {
        delete (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
        backendStartedOk = false;
      }
      if (terminationError) throw terminationError;
      if (cleanupErrors.length > 0) {
        throw Object.assign(
          new Error(`Command EVE backend fail-closed stop completed with cleanup errors: ${cleanupErrors.join(' | ')}`),
          { code: 'COMMAND_EVE_BACKEND_FAIL_CLOSED_PROVEN_WITH_CLEANUP_ERROR' }
        );
      }
    });
    setCommandEveBackendRestart(async (restartLease) => {
      const myRespawnGen = ++commandEveRespawnGeneration;
      const { getDataPath: getDataPathForRestart } = await import('./process/utils/utils');
      const { getSystemDir: getSystemDirForRestart, getBackendDataDir: getBackendDataDirForRestart } =
        await import('./process/utils/initStorage');
      const { prepareCommandEveRuntimeProcessEnv, resolveCommandEveRuntimeBootstrapPaths } =
        await import('./process/commandEve/runtimeBootstrapCore');
      const runtimePathsForRestart = resolveCommandEveRuntimeBootstrapPaths(getDataPathForRestart());
      const sysDirForRestart = getSystemDirForRestart();
      let recheckCommandEveRuntimeBeforeRespawn: (() => void) | undefined;
      const respawnPort = await runCommandEveBackendRespawnAfterStop({
        // Prove or repair BEFORE stop. A cold/deferred runtime and every deeper
        // non-artifact failure therefore leave the existing backend and its
        // published port alive instead of attempting a synchronous bootstrap
        // with stale boot-seat authority inputs while the backend is down.
        beforeStop: async () => {
          if (ensureCommandEveRuntimeAdmissionForRespawn) {
            recheckCommandEveRuntimeBeforeRespawn = await ensureCommandEveRuntimeAdmissionForRespawn(false);
          } else {
            // Dev/Windows preserve the existing lightweight env bake.
            prepareCommandEveRuntimeProcessEnv(
              getDataPathForRestart(),
              process.env,
              process.platform,
              process.resourcesPath,
              { requireBundledPython: false }
            );
          }
        },
        // STOP only after admission succeeds. From the moment stop() resolves,
        // every await-gap recheck failure clears the now-dead published port.
        stop: () => backendManager.stop(),
        clearDeadBackendPort: () => {
          if (myRespawnGen === commandEveRespawnGeneration) {
            delete (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
          }
        },
        afterStop: async () => {
          // Same pre-flight assistant-storage repair as boot, for the now-active
          // seat's DB (fail-open). The exact mutable-runtime proof is checked
          // again after this await and immediately before backend start.
          try {
            const { repairCommandEveAssistantStorage } = await import('./process/commandEve/assistantStorageRepair');
            const repair = await repairCommandEveAssistantStorage(getBackendDataDirForRestart(), {
              hermesCommandPath: runtimePathsForRestart.hermesShim,
              nativeSkillsDirs: [runtimePathsForRestart.managedSkillsRoot],
            });
            if (repair.repaired > 0) {
              console.warn(
                `[CommandEVE] Pre-flight assistant-storage repair (respawn): re-activated ${repair.repaired} orphaned definition(s).`
              );
            }
            if (repair.rebound && repair.rebound > 0) {
              console.warn(
                `[CommandEVE] Pre-flight assistant-storage repair (respawn): re-bound ${repair.rebound} EVE definition(s) aionrs→hermes.`
              );
            }
            if (repair.registryRebound && repair.registryRebound > 0) {
              console.warn(
                `[CommandEVE] Pre-flight assistant-storage repair (respawn): pinned ${repair.registryRebound} Hermes registry row(s) to the app-managed shim.`
              );
            }
            if (repair.nativeSkillsRebound && repair.nativeSkillsRebound > 0) {
              console.warn(
                `[CommandEVE] Pre-flight assistant-storage repair (respawn): enabled native Hermes skill discovery for ${repair.nativeSkillsRebound} registry row(s).`
              );
            }
            if (repair.reseeded && repair.reseeded > 0) {
              console.warn(
                `[CommandEVE] Pre-flight assistant-storage repair (respawn): cleared ${repair.reseeded} orphaned EVE mirror row(s) with no live definition (will re-seed via POST).`
              );
            }
          } catch (error) {
            console.warn('[CommandEVE] Pre-flight assistant-storage repair (respawn) skipped:', error);
          }
          recheckCommandEveRuntimeBeforeRespawn?.();
          return backendManager.start(
            getBackendDataDirForRestart(),
            sysDirForRestart.logDir,
            {
              cacheDir: sysDirForRestart.cacheDir,
              workDir: sysDirForRestart.workDir,
              logDir: sysDirForRestart.logDir,
            },
            commandEveBackendStartOptions
          );
        },
      });
      // ISO-4 CRITICAL: re-spawn the backend with the SAME seat-scoped --data-dir
      // as boot, now for the NEW active seat (set by applySeatSwitch step a). This
      // is what re-homes the conversation+message SQLite on a seat switch — the
      // renderer's conversation list / message bodies / full-text search follow
      // the active seat. getBackendDataDir() reads the active seat at call time.
      //
      // Hotfix-B: stop() above ALREADY SIGTERM/SIGKILLed the pre-switch backend, so
      // __backendPort now points at a DEAD pid. If start() throws (port bind fail,
      // spawn error, corrupted venv), we MUST clear __backendPort BEFORE the throw
      // propagates — otherwise every httpBridge / cron-resume consumer keeps calling
      // the dead pre-switch port, and applySeatSwitch's rollback would present a
      // silent dead backend as a clean rollback. Clearing it makes the backend HONESTLY
      // unavailable; the rollback then re-invokes this hook to restart the PRIOR seat
      // (which republishes a live port on success), or surfaces the fail-closed
      // SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN state if that restart also throws.
      // SUPERSEDED-RESPAWN GUARD: if a newer switch ran while we were parked on start()
      // (only reachable on a >300s-hung respawn the watchdog force-released), bail BEFORE
      // publishing any global state — our respawnPort points at a process the newer
      // switch's stop() already SIGKILLed, so writing __backendPort / cron-bridge /
      // assistant here would point cron resume + every __backendPort consumer at a dead
      // backend. The newer switch already published the live state.
      if (myRespawnGen !== commandEveRespawnGeneration) {
        console.warn(
          '[Command EVE] Superseded seat respawn (gen',
          myRespawnGen,
          'of',
          commandEveRespawnGeneration,
          ') — skipping stale global-state publish.'
        );
        return;
      }
      (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = respawnPort;
      registerCronResumeBridge(respawnPort);
      // Seat DBs are physically distinct. Do not complete the switch until the
      // newly-active DB can read back its own provider row. A hard failure
      // propagates into the existing seat-switch rollback path.
      try {
        await ensureCommandEveLocalProviderAfterBackendStart('seat-respawn');
      } catch (error) {
        const providerError = commandEveAuthorityDiagnostic(error, 'provider validation failed');
        let failClosedError: unknown;
        try {
          await failCommandEveBackendAuthorityClosed(restartLease);
        } catch (cleanupError) {
          failClosedError = cleanupError;
        }
        throw new Error(
          failClosedError
            ? `Command EVE post-start provider validation failed (${providerError}); backend was stopped with cleanup errors (${commandEveAuthorityDiagnostic(failClosedError, 'cleanup failed')}).`
            : `Command EVE post-start provider validation failed (${providerError}); backend was stopped fail-closed.`,
          { cause: error }
        );
      }
      backendStartedOk = true;
      // ISO-6: the EVE assistant skill prompt is a function of the ACTIVE seat —
      // regenerate it so the new seat's client entity (its ISO-3 seed), not the
      // prior seat's nor the admin's, is what the agent runs with. The single
      // global COMMAND_EVE_ASSISTANT_ID prompt is overwritten per switch; without
      // this re-run the freshly-spawned backend would serve the previous seat's
      // baked skill prompt. Best-effort: a write failure must NOT fail the switch.
      try {
        const { ensureCommandEveAssistant } = await import('./process/commandEve/assistantBootstrap');
        await ensureCommandEveAssistant(respawnPort, app.getVersion(), { userDataPath: getDataPathForRestart() });
      } catch (err) {
        console.error('[Command EVE] Per-seat assistant prompt regeneration failed after seat switch:', err);
      }
    });
  } catch (error) {
    console.error('[CommandEVE] Failed to start aioncore:', error);
    backendStartupFailed = true;
    backendStartupFailureInfo = classifyBackendStartupFailure(error);
    runDeferredCommandEveRuntimeBootstrap = undefined;
  }

  // One-shot WebUI admin credential migration. Must run after the backend is
  // up (__backendPort set) and before any mode branch below that might log the
  // user in. Swallows its own errors; the next boot retries.
  const bootBackendPort = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  if (bootBackendPort) {
    try {
      const { ensureAdminUser } = await import('./process/utils/ensureAdminUser');
      await ensureAdminUser(bootBackendPort);
    } catch (err) {
      console.error('[WebUI] ensureAdminUser failed:', err);
    }
  }

  // One-shot backend migrations are deferred until after the renderer finishes
  // loading. Some migration steps (ConfigStorage.get, ipcBridge.listProviders)
  // route through the renderer via BroadcastChannel; running them here would
  // deadlock because the renderer does not exist yet. See scheduleBackendMigrations().

  try {
    initializeZoomFactor(ProcessConfig.getSync('ui.zoomFactor'));
    mark('initializeZoomFactor');
  } catch (error) {
    console.error('[CommandEVE] Failed to restore zoom factor:', error);
    initializeZoomFactor(undefined);
  }

  try {
    loadSavedWindowBounds(await ProcessConfig.get('window.bounds'));
    mark('restoreWindowBounds');
  } catch (error) {
    console.error('[CommandEVE] Failed to restore window bounds:', error);
    loadSavedWindowBounds(undefined);
  }

  if (isResetPasswordMode) {
    // Handle password reset without creating window
    try {
      const { resetPasswordCLI, resolveResetPasswordUsername } = await import('./process/utils/resetPasswordCLI');
      const username = resolveResetPasswordUsername(process.argv);

      await resetPasswordCLI(username);

      app.quit();
    } catch {
      app.exit(1);
    }
  } else if (isWebUIMode) {
    const userConfigInfo = loadUserWebUIConfig();
    if (userConfigInfo.exists && userConfigInfo.path) {
      // Config file loaded from user directory
    }
    const resolvedPort = resolveWebUIPort(userConfigInfo.config, getSwitchValue);
    const allowRemote = resolveRemoteAccess(userConfigInfo.config, isRemoteMode);
    try {
      // Inside Electron (`AionUi --webui` or packaged `aionui-web` mode that
      // launches via the Electron shell), reuse the desktop app's data-dir so
      // that conversations / cron jobs created in any path show up everywhere.
      // Matches the desktop IPC path at line 493 above.
      const { getDataPath } = await import('./process/utils/utils');
      const { getSystemDir } = await import('./process/utils/initStorage');
      const sysDirWebUI = getSystemDir();
      // M6: Switch to @aionui/web-host
      const handle = await startWebHost({
        app: {
          version: app.getVersion(),
          isPackaged: app.isPackaged,
          resourcesPath: app.getAppPath(),
          // Same reason as dataDir below: webui.config.json must live next to
          // the DB under the CLI-safe symlink path, so every password-change
          // entry point (CLI --resetpass, settings-toggle IPC, browser login)
          // reads the same file.
          userDataPath: getDataPath(),
        },
        staticDir: path.join(__dirname, '../renderer'),
        port: resolvedPort,
        allowRemote,
        dataDir: getDataPath(),
        logDir: sysDirWebUI.logDir,
        // Expose the same AIONUI_{CACHE,WORK,LOG}_DIR env the desktop IPC path
        // passes at line 493, so /api/system/info reports the symlink workDir
        // instead of the path-with-spaces userData root.
        dirs: {
          cacheDir: sysDirWebUI.cacheDir,
          workDir: sysDirWebUI.workDir,
          logDir: sysDirWebUI.logDir,
        },
        backend: {
          kind: 'useExistingBackend',
          getLocalCapability: () => backendManager.localCapability,
          port: (() => {
            // Reuse the backend already spawned by backendManager.start() above.
            // Spawning a second backend here would race the first on SQLite.
            const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
            if (!port) {
              throw new Error('[WebUI] Cannot start: aioncore is not running (globalThis.__backendPort unset)');
            }
            return port;
          })(),
        },
      });
      console.log(`[WebUI] Headless server started (port=${handle.port}, backendPort=${handle.backendPort})`);
      runDeferredCommandEveRuntimeBootstrap?.();
      runDeferredCommandEveRuntimeBootstrap = undefined;
    } catch (err) {
      console.error(`[WebUI] Failed to start server on port ${resolvedPort}:`, err);
      app.exit(1);
      return;
    }

    // Keep the process alive in WebUI mode by preventing default quit behavior.
    // On Linux headless (systemd), Electron may attempt to quit when no windows exist.
    app.on('will-quit', (event) => {
      // Only prevent quit if this is an unexpected exit (server still running).
      // Explicit app.exit() calls bypass will-quit, so they are unaffected.
      if (!isExplicitQuit) {
        event.preventDefault();
        console.warn('[WebUI] Prevented unexpected quit — server is still running');
      }
    });
  } else {
    // 初始化关闭到托盘设置 / Initialize close-to-tray setting
    if (isE2ETestMode) {
      setCloseToTrayEnabled(false);
      destroyTray();
    } else {
      try {
        const savedCloseToTray = await ProcessConfig.get('system.closeToTray');
        setCloseToTrayEnabled(savedCloseToTray ?? false);
        if (getCloseToTrayEnabled()) {
          createOrUpdateTray();
        }
      } catch {
        // Ignore storage read errors, default to false
      }
    }

    const showMainWindowOnReady = !(wasLaunchedAtLogin() && getCloseToTrayEnabled());

    createWindow({ showOnReady: showMainWindowOnReady });
    appReadyDone = true;
    mark('createWindow');
    runDeferredCommandEveRuntimeBootstrap?.();
    runDeferredCommandEveRuntimeBootstrap = undefined;

    if (bootBackendPort) {
      setTimeout(() => {
        void ensureCommandEveAssistantReadiness()
          .then(() => {
            mark('commandEveAssistantBootstrap');
          })
          .catch((err) => {
            console.error('[Command EVE] Assistant bootstrap failed:', err);
          });
      }, 3_000);
    }

    // Initialize desktop pet (delayed to not block main window)
    setTimeout(() => {
      void (async () => {
        try {
          const petEnabled = await ProcessConfig.get('pet.enabled');
          if (petEnabled === true) {
            // Read pet sub-settings before creating the pet so flags are honored
            // on the first createPetWindow() call (which is sync).
            const confirmEnabled = (await ProcessConfig.get('pet.confirmEnabled')) ?? true;
            const { createPetWindow, setPetConfirmEnabled } = await import('./process/pet/petManager');
            setPetConfirmEnabled(confirmEnabled);
            createPetWindow();
          }
        } catch (error) {
          console.error('[Pet] Failed to initialize:', error);
        }
      })();
    }, 3000);

    // 读取语言设置并初始化主进程 i18n，然后刷新托盘菜单
    // Read language setting and initialize main process i18n, then refresh tray menu
    try {
      const savedLanguage = await ProcessConfig.get('language');
      rendererInitialLanguage = typeof savedLanguage === 'string' ? savedLanguage : null;
      await setInitialLanguage(savedLanguage);
      // After language is set, refresh tray menu if it exists
      await refreshTrayMenu();
    } catch (error) {
      console.error('[index] Failed to initialize i18n language:', error);
    }

    // 监听语言变更，刷新托盘菜单文案 / Listen for language changes to refresh tray menu labels
    onLanguageChanged(() => {
      void refreshTrayMenu();
    });

    if (!isE2ETestMode) {
      // 窗口创建后异步恢复 WebUI，不阻塞 UI / Restore WebUI async after window creation, non-blocking
      restoreDesktopWebUIFromPreferences().catch((error) => {
        console.error('[WebUI] Failed to auto-restore:', error);
      });
    }

    // Flush pending deep-link URL (received before window was ready)
    const pendingDeepLink = takePendingDeepLink();
    if (pendingDeepLink) {
      mainWindow.webContents.once('did-finish-load', () => {
        deliverDeepLink(pendingDeepLink);
      });
    }
  }

  // Verify CDP is ready and log status
  const { cdpPort, verifyCdpReady } = await import('./process/utils/configureChromium');
  if (cdpPort) {
    const cdpReady = await verifyCdpReady(cdpPort);
    if (cdpReady) {
      console.log(`[CDP] Remote debugging server ready at http://127.0.0.1:${cdpPort}`);
      console.log(
        `[CDP] MCP chrome-devtools: npx chrome-devtools-mcp@0.16.0 --browser-url=http://127.0.0.1:${cdpPort}`
      );
    } else {
      console.warn(`[CDP] Warning: Remote debugging port ${cdpPort} not responding`);
    }
  }
};

// ============ Protocol Registration ============
// Register aionui:// as the default protocol client
if (process.defaultApp) {
  // Dev mode: need to pass execPath explicitly
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

// macOS: handle aionui:// URLs via the open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLinkUrl(url);
  if (isWebUIMode || isResetPasswordMode || !app.isReady()) {
    return;
  }
  // Focus existing window so user sees the result
  showOrCreateMainWindow({ mainWindow, createWindow });
});

// 监听 GPU 子进程崩溃，连续多次后下次启动自动关闭硬件加速（参见 ELECTRON-9A / ELECTRON-9D）。
installGpuCrashHandler();

// COMPA-626 auto-approve fence: inject the seat-switch resolver so the kanban-ACP
// write path (BOTH the confirm-IPC and the auto-approve shim path) refuses a write
// mid seat-switch. Injected (not dynamic-imported) so there is no fail-open window.
setKanbanAcpSeatSwitchResolver(isCommandEveSeatSwitchInFlight);

// Ensure we don't miss the ready event when running in CLI/WebUI mode
void app
  .whenReady()
  .then(handleAppReady)
  .catch((error) => {
    // App initialization failed
    console.error('[CommandEVE] App initialization failed:', error);
    app.quit();
  });

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // 当关闭到托盘启用时，不退出应用 / Don't quit when close-to-tray is enabled
  if (getCloseToTrayEnabled()) {
    return;
  }
  // In WebUI mode, don't quit when windows are closed since we're running a web server
  if (!isWebUIMode && process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  // Skip if handleAppReady hasn't finished — it will create the window itself.
  if (!appReadyDone) return;
  if (!isWebUIMode && app.isReady()) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 从托盘恢复隐藏的窗口 / Restore hidden window from tray
      showAndFocusMainWindow(mainWindow);
      if (process.platform === 'darwin' && app.dock) {
        void app.dock.show();
      }
    } else {
      createWindow();
    }
  }
});

installQuitCleanup({
  onBeforeQuit: (handler) => app.on('before-quit', (event) => handler(event)),
  quitApp: () => app.quit(),
  setIsQuitting,
  markExplicitQuit: () => {
    isExplicitQuit = true;
  },
  destroyTray,
  disposeCronResumeListener: () => {
    disposeCronResumeListener?.();
    disposeCronResumeListener = null;
  },
  stopBackend: async () => {
    // Stop aioncore subprocess — backend shutdown kills all agent
    // children transitively. The quit controller keeps Electron alive until
    // this resolves, so active ACP sessions can deliver cancel/shutdown.
    await backendManager.stop().catch((err) => console.error('[App] Failed to stop backend:', err));

    const { stopBonsaiPilotServer } = await import('./process/commandEve/localInference/bonsaiServer');
    await stopBonsaiPilotServer().catch((err) => console.error('[App] Failed to stop local Bonsai model:', err));
    const { stopColibriServer } = await import('./process/commandEve/localInference/colibriServer');
    await stopColibriServer().catch((err) => console.error('[App] Failed to stop local Colibrì model:', err));
  },
  destroyPetWindow: async () => {
    const { destroyPetWindow } = await import('./process/pet/petManager');
    destroyPetWindow();
  },
  logInfo: console.log,
  logWarn: console.warn,
  logError: console.error,
});

app.on('will-quit', () => {
  console.log('[CommandEVE] will-quit — all cleanup should be complete');
});

app.on('quit', (_event, exitCode) => {
  console.log(`[CommandEVE] quit (exitCode=${exitCode})`);
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
