/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridge } from '@office-ai/platform';
import { getCommandEveArtifactsChangedEmitter } from '@process/commandEve/artifactsChangedEmitter';
import { app } from 'electron';
import { buildCommandCenterReadModel } from '@process/commandEve/commandCenterReadModelCore';
import {
  buildLocalTitlePrompt,
  pickLocalTitleModel,
  sanitizeGeneratedTitle,
} from '@process/commandEve/commandEveTitleCore';
import { buildConnectorCatalog } from '@process/commandEve/connectorCatalogCore';
import { runConnectorPreflight } from '@process/commandEve/connectorPreflightCore';
import {
  buildCrmOverlay,
  captureCrmConsentLocal,
  changeCrmDealStageLocal,
  createCrmDraftDeal,
  initializeCrmOverlay,
} from '@process/commandEve/crmOverlayCore';
import {
  activateEntitlement,
  getEntitlementStatus,
  readRegistration,
  registerTenant,
  updateRegistrationProfile,
  COMMAND_EVE_ENTITLEMENT_BRIDGE_VERSION,
} from '@process/commandEve/entitlementCore';
import { runDesktopAuthLoopback, type DesktopAuthIntent } from '@process/commandEve/desktopAuthLoopback';
import { passwordGrant } from '@process/commandEve/desktopAuthPassword';
import { hasAccountSession, readAccountSession, revokeAndClearSession } from '@process/commandEve/accountSessionAtRest';
import {
  activateEntitlementFromSession,
  silentResumeAccountAuth,
} from '@process/commandEve/accountAuthOrchestratorCore';
import { resolveCommandEveDisplayIdentity } from '@process/commandEve/accountIdentityCore';
import { resetEntitlement, COMMAND_EVE_ENTITLEMENT_RESET_VERSION } from '@process/commandEve/entitlementResetCore';
import { reconcileEntitlementOnline } from '@process/commandEve/entitlementOnlineCheckCore';
import {
  applyKanbanMarketingCardAction,
  approveKanbanMarketingOutput,
  buildKanbanMarketingBoard,
  checkKanbanMarketingWorkerStartGate,
  createKanbanMarketingCard,
  createKanbanMarketingProofCard,
  generateKanbanMarketingDraft,
  moveKanbanMarketingCard,
  planKanbanMarketingCardDispatch,
  prepareKanbanMarketingWorkerDispatcher,
  promoteKanbanMarketingWorkerExecutor,
  recordKanbanMarketingDispatchApproval,
  recordKanbanMarketingDispatchDecision,
  requestKanbanMarketingWorkerDispatch,
  runKanbanMarketingWorkerObserved,
  runKanbanPreflight,
} from '@process/commandEve/kanbanPreflightCore';
import {
  createHermesNativeKanbanTask,
  ensureHermesNativeKanbanBoard,
  updateHermesNativeKanbanTask,
} from '@process/commandEve/hermesNativeKanbanCore';
import {
  grantCommandEveComputerUsePermissions,
  installCommandEveComputerUseDriver,
  issueCommandEveComputerUseNativeIntent,
  readCommandEveComputerUseStatus,
  revokeCommandEveComputerUsePermissionsGuide,
} from '@process/commandEve/computerUseRuntimeCore';
import {
  COMMAND_EVE_NATIVE_KANBAN_VERSION,
  type CommandEveNativeKanbanCreateRequest,
  type CommandEveNativeKanbanUpdateRequest,
} from '@/common/config/eveNativeKanbanCore';
import {
  captureNativeKanbanSeatScope,
  nativeKanbanSeatScopeStillActive,
} from '@process/commandEve/nativeKanbanSeatScopeCore';
import { buildLocalRuntimeStatus } from '@process/commandEve/localRuntimeStatusCore';
import { ensureCommandEveLocalRuntimeProvider } from '@process/commandEve/providerBootstrap';
import { clearHermesDelegateTransportEnv } from '@process/commandEve/eveWorkerLauncherCore';
import { transcribeLocalSpeech } from '@process/commandEve/localSttCore';
import type { CommandEveLocalSttRequest } from '@/common/types/provider/speech';
import {
  buildCommandEveOnboardingStatus,
  COMMAND_EVE_ONBOARDING_STATUS_BRIDGE_VERSION,
} from '@process/commandEve/onboardingStatusCore';
import { buildSkillLibrary } from '@process/commandEve/skillLibraryCore';
import { readSkillContent } from '@process/commandEve/skillContentCore';
import { listLearnedSkills } from '@process/commandEve/learnedSkillsCore';
import { listAuthoredSkills, COMMAND_EVE_AUTHORED_SKILLS_DIR } from '@process/commandEve/authoredSkillsCore';
import {
  resolveCommandEveRuntimeBootstrapPaths,
  resolveCommandEveRuntimeBootstrapManifestPath,
  loadCommandEveRuntimeBootstrapManifest,
  EVE_STRATEGY_SKILL_IDS,
  COMMAND_EVE_ONBOARDING_SKILL_ID,
  COMMAND_EVE_ARTIFACT_MENU_SKILL_ID,
  syncCommandEveRegistrationIdentityArtifacts,
} from '@process/commandEve/runtimeBootstrapCore';
import { buildCommandEveStatusSurface } from '@process/commandEve/statusSurfaceCore';
import { resolveHonchoRenderForSeat, type HonchoRenderInput } from '@process/commandEve/honchoRuntimeRenderCore';
import { clearLicenseWire, hasLicenseWire, readLicenseWire, storeLicenseWire } from '@/common/config/licenseWireAtRest';
import { resolveEveCloudRouteFromBackend } from '@process/commandEve/inferenceSelectionBackendRead';
import { isCommandEveMaxEntitlementHoldError } from '@process/commandEve/shimPublicError';
import {
  buildEveInferenceProvider,
  isConnectedSelection,
  isEveInferenceSelection,
  parseConnectedSelection,
  parseEveTierIdFromSelection,
  type EveInferenceTierId,
} from '@/common/config/eveInferenceCore';
import { resolveConnectedProviderRoute } from '@/common/config/eveConnectedProviderCore';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import {
  COMMAND_EVE_BONSAI_LOCAL_TIER_ID,
  COMMAND_EVE_BONSAI_RUNTIME_MODEL_ID,
  COMMAND_EVE_COLIBRI_LOCAL_TIER_ID,
  COMMAND_EVE_COLIBRI_RUNTIME_MODEL_ID,
  getCommandEveLocalRuntimeProvider,
  isCommandEveFounderBuildAllowed,
} from '@/common/config/commandEveShell';
import {
  isBonsaiProvisionInFlight,
  readBonsaiInstallStatus,
} from '@process/commandEve/localInference/bonsaiProvisioner';
import { resolveBonsaiPilotPaths } from '@process/commandEve/localInference/bonsaiManifest';
import {
  isColibriProvisionInFlight,
  readColibriInstallStatus,
} from '@process/commandEve/localInference/colibriProvisioner';
import { resolveColibriPaths } from '@process/commandEve/localInference/colibriManifest';
import {
  CREDITS_STATUS_FUNCTION_URL,
  isPaidCreditsTier,
  type ClientSeedInput,
  type CreditsTier,
} from '@/common/config/creditsCore';
import {
  buildCommandEveMultimodalTtsRequest,
  commandEveMediaSeedAttribution,
  commandEveMultimodalTtsFailure,
  COMMAND_EVE_MULTIMODAL_TTS_CONSENT_GET_CHANNEL,
  COMMAND_EVE_MULTIMODAL_TTS_CONSENT_SET_CHANNEL,
  COMMAND_EVE_MULTIMODAL_TTS_MAX_RESPONSE_BYTES,
  COMMAND_EVE_MANAGED_VISION_ENABLED,
  COMMAND_EVE_MANAGED_VISION_GATEWAY_DEPLOYED,
  EVE_MULTIMODAL_FUNCTION_URL,
  parseCommandEveMultimodalTtsResponse,
  resolveCommandEveMultimodalGate,
  resolveCommandEveMultimodalTtsActivationStatus,
  type CommandEveMultimodalTtsActivationStatusRequest,
  type CommandEveMultimodalTtsConsentSetRequest,
  type CommandEveMultimodalTtsRequest,
} from '@/common/config/eveMultimodalGatewayCore';
import {
  buildCommandEvePdfOcrRequest,
  COMMAND_EVE_PDF_INTELLIGENCE_VERSION,
  COMMAND_EVE_PDF_MAX_CLOUD_RESPONSE_BYTES,
  parseCommandEvePdfOcrResponse,
  type CommandEvePdfPrepareRequest,
  type CommandEvePreparedPdfDocument,
} from '@/common/config/evePdfIntelligenceCore';
import {
  evaluateCommandEveMultimodalTtsConsentAllowed,
  readCommandEveMultimodalTtsConsent,
  setCommandEveMultimodalTtsConsent,
  toCommandEveMultimodalTtsConsentBridgeResult,
} from '@process/commandEve/multimodalTtsConsentCore';
import {
  CommandEvePdfPreparationError,
  persistPdfSidecar,
  prepareLocalPdf,
  type LocalPdfPreparation,
} from '@process/commandEve/document/pdfIntelligenceService';
import { parseCloudOcrMarkdownPages } from '@process/commandEve/document/pdfIntelligenceCore';
import { readCommandEveLimitedResponseText } from '@process/commandEve/limitedFetchResponse';
import { handleCommandEveImagePrepare } from '@process/bridge/commandEveImageBridge';
import {
  handleCommandEveArtifactContextEnvelopeBridge,
  handleCommandEveArtifactTurnSteerBridge,
  handleCommandEveVideoArtifactsListBridge,
  handleCommandEveVideoCapabilitiesBridge,
  handleCommandEveVideoEditBridge,
  handleCommandEveVideoGenerateBridge,
} from '@process/bridge/commandEveVideoBridge';
import { listVideoArtifactRecords } from '@process/commandEve/videoArtifactStore';
import {
  handleCommandEveImageArtifactBindBridge,
  handleCommandEveImageArtifactImportLegacyBridge,
  handleCommandEveImageArtifactPreviewBridge,
  handleCommandEveImageArtifactsListBridge,
  handleCommandEveImageGenerateBridge,
} from '@process/bridge/commandEveImageArtifactBridge';
import { handleCommandEvePresentationPrepare } from '@process/bridge/commandEvePresentationBridge';
import { consumeCommandEveFileSelectionPathGrant } from '@process/commandEve/fileSelectionGrantCore';
import { authorizeCommandEveManagedVisualTurn } from '@process/commandEve/managedVisualTurnAuthorizationCore';
import type { CommandEveImageGenerateRequest } from '@/common/config/eveManagedImageGenerationCore';
import {
  issueCommandEveCloudVisualPolicyReceipt,
  readCommandEveCloudVisualPolicy,
  retireCommandEveCloudVisualPolicyReceipt,
  setCommandEveCloudVisualPolicy,
  verifyCommandEveCloudVisualPolicyReceipt,
} from '@process/commandEve/visual/cloudVisualPolicyMain';
import {
  readCommandEveImageModelPreference,
  setCommandEveImageModelPreference,
} from '@process/commandEve/imageModelPreferenceMain';
import { readCommandEveImageModelRegistry } from '@process/commandEve/imageCapabilitiesMain';
import { isCommandEveImageModelPreferenceMutationRequest } from '@/common/config/visual/imageModelPreferenceCore';
import type { CommandEveManagedVisualTurnAuthorizationRequest } from '@/common/config/eveManagedVisualTurnCore';
import type {
  CommandEveCloudVisualPolicyMutationRequest,
  CommandEveCloudVisualPolicyReceiptRequest,
} from '@/common/config/visual/cloudVisualPolicyCore';
import {
  SEAT_USAGE_FUNCTION_URL,
  buildSeatUsageIpcResult,
  currentUsageMonth,
  emptySeatUsage,
  isValidUsageMonth,
  parseSeatUsageResponse,
  partitionSeatUsageForViewer,
} from '@/common/config/seatUsageCore';
import { ProcessConfig, getSkillsDir, getCronSkillsDir } from '@process/utils/initStorage';
import { getDataPath } from '@process/utils/utils';
import {
  getActiveSeatContextRevision,
  getActiveSeatId,
  getActiveSeatKind,
  getCommandEvePaidArtifactBlockReason,
  hasCommandEvePaidArtifactOperationInFlight,
  isActiveSeatLegacy,
  resolveActiveSeatHome,
  resolveSeatHermesHome,
  sanitizeSeatId,
  setCommandEvePaidArtifactSeatRecoveryRequired,
  tryBeginCommandEvePaidArtifactOperation,
  tryBeginCommandEvePaidArtifactSeatTransition,
} from '@process/commandEve/seatContextCore';
import { writeActiveSeatPointer } from '@process/commandEve/activeSeatPointerStore';
import { isSeatSwitchAuthorized, parseMySeats, resolveSeatAccess } from '@process/commandEve/seatSwitchCore';
import { runCommandEveBackendRestartReservation } from '@process/commandEve/seatSwitchRuntime';
import {
  runConnectorAuthorityMutationTransaction,
  sanitizeConnectorAuthorityDiagnostic,
} from '@process/commandEve/reconcileHermesMcpConfigWiring';
import type { GuidedAuthSetupResult } from '@process/commandEve/guidedAuthSetupCore';
import { resolveCanonicalConnectorId } from '@process/commandEve/connectorIdCore';
import { readMySeatsWire as readMySeatsWireCore, type MySeatsWireFailure } from '@process/commandEve/seatWireFetchCore';
import { createSeedSingleFlight, renameSeed } from '@process/commandEve/seedLifecycleFetchCore';
import { readCompanyBrainSeedState, writeCompanyBrainSeed } from '@process/commandEve/companyBrainSeedCore';
import { COMMAND_EVE_HANDOVER_NOTE_RELPATH, HANDOVER_NOTE_MAX_RAW_CHARS } from '@/common/config/startscreenNoteCore';
import nodePath from 'node:path';
import {
  COMMAND_EVE_DAY_ZERO_BRIEF_ID,
  listEntriesWithState,
  mirrorBriefBodyToFile,
  pruneSessionDigests,
  readEntryBody,
  reconcileUnindexedEntries,
  removeEntry,
  SESSION_DIGEST_KIND,
  upsertEntry,
  upsertSystemEntry,
  type CompanyBrainWriteKind,
} from '@process/commandEve/companyBrainStoreCore';
import { runSessionDigest, type SessionDigestDeps } from '@process/commandEve/sessionDigestCore';
import { enforceMemoryBoundary } from '@process/commandEve/memoryBoundaryContractCore';
import {
  createElectronPdfRenderer,
  exportReport,
  RecoveredReportStageError,
  SeatTruthFenceError,
  stageRecoveredMarkdownInWorkspace,
  type ReportContent,
} from '@process/commandEve/reportExportCore';

/** Version tag mirrored onto every credits bridge result (ipcBridge contract). */
const COMMAND_EVE_CREDITS_BRIDGE_VERSION = 'command-eve-credits/v0' as const;
// Keep this true only while the deployed eve-multimodal gateway is live,
// fail-closed on no-secret smoke, and cloud voice output remains protected by
// MAIN-owned consent, license, and residency gates.
const COMMAND_EVE_MULTIMODAL_TTS_CLOUD_EGRESS_ENABLED = true;
// Keep true only while the deployed eve-multimodal function returns a fail-closed
// auth/provider response to no-secret smoke tests instead of 404.
const COMMAND_EVE_MULTIMODAL_TTS_SERVER_GATEWAY_DEPLOYED = true;
// PDF cloud OCR stays independently gated because it uploads customer document
// bytes. Keep both true only after the edge function deployment + no-secret smoke.
const COMMAND_EVE_PDF_CLOUD_OCR_ENABLED = true;
const COMMAND_EVE_PDF_SERVER_GATEWAY_DEPLOYED = true;
/**
 * A SELF-QUIET unavailable status returned when the credits backend cannot be
 * reached. The numeric zeroes satisfy the versioned IPC shape only; `ok:false`
 * makes every field non-authoritative. In particular, no `has_active_topup:false`
 * is emitted: a transport failure must never masquerade as a confirmed free seat
 * and re-lock a customer who already bought credits.
 */
function quietCreditsStatus(spendCapEurCents: number, reasonCode: string, message?: string) {
  return {
    version: COMMAND_EVE_CREDITS_BRIDGE_VERSION,
    ok: false,
    reason_code: reasonCode,
    message,
    tier: 'free' as CreditsTier,
    included_allowance_credits_remaining: 0,
    purchased_credits_remaining: 0,
    spend_cap_eur_cents: Math.max(0, spendCapEurCents),
    free_actions_used_this_period: 0,
    free_cap: 0,
    period_start: '',
  };
}
function finiteCreditNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

type CommandEveStatusSurfaceRequest = { maxRuns?: number; companyOsRoot?: string; eventLedgerPath?: string };
type CommandEveBridgeEnvelope<T> = { data?: T };

function unwrapBridgeRequest<T>(request?: T | CommandEveBridgeEnvelope<T>): T | undefined {
  if (request && typeof request === 'object' && 'data' in request) {
    return (request as CommandEveBridgeEnvelope<T>).data;
  }
  return request as T | undefined;
}

async function refreshBrowserWorkbenchContextBestEffort(): Promise<void> {
  try {
    const { refreshBrowserWorkbenchContext } = await import('@process/commandEve/browserWorkbenchContextMain');
    const descriptor = refreshBrowserWorkbenchContext();
    const { application: applicationIpc } = await import('@/common/adapter/ipcBridge');
    applicationIpc.browserContextChanged.emit(descriptor);
  } catch (error) {
    console.warn('[Command EVE] Browser context refresh failed closed:', error);
  }
}

async function revokeBrowserWorkbenchContextBestEffort(): Promise<Error | null> {
  try {
    const { revokeActiveBrowserWorkbenchContext } = await import('@process/commandEve/browserWorkbenchContextMain');
    await revokeActiveBrowserWorkbenchContext();
    return null;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    console.warn('[Command EVE] Browser context revoke failed closed:', normalized);
    return normalized;
  }
}

async function syncRegistrationIdentityArtifactsBestEffort(userDataPath: string): Promise<void> {
  try {
    const result = await syncCommandEveRegistrationIdentityArtifacts(userDataPath);
    if (!result.ok && result.reason_code !== 'REGISTRATION_MISSING') {
      console.warn(`[Command EVE] Registration identity sync incomplete: ${result.reason_code || 'unknown'}`);
    }
  } catch (error) {
    // Registration/auth itself remains authoritative. A memory/receipt refresh
    // failure is surfaced but must not strand a user after successful login.
    console.warn(
      `[Command EVE] Registration identity sync failed: ${error instanceof Error ? error.message : 'unknown'}`
    );
  }
}

/**
 * Read the raw my-seats wire payload (B3 data contract) from the DEPLOYED
 * my-seats edge function (v5, verify_jwt=true). This is the single place that
 * performs the JWT-bound read: it reuses the desktop's stored account session
 * (accountSessionAtRest.getFreshSession) as the Bearer — the SAME auth chain the
 * my-license read uses — and NEVER accepts a client-supplied account/seat id (the
 * IDOR guard is server-side; the function derives the account+seats from the JWT).
 *
 * Fail-closed by construction (see seatWireFetchCore): no stored session / offline
 * / 401 / non-2xx / malformed / timeout all resolve to `null`, which the bridge
 * already treats as "no seat source" ⇒ a single legacy seat ⇒ rail hidden. So on a
 * legacy/no-account install this is byte-identical to before (returns `null`).
 * NEVER throws into the bridge handler.
 *
 * The wire's active_seat_id is overridden with the desktop's runtime-truth active
 * seat (getActiveSeatId) inside the core — the ring must follow what actually
 * spawned, not a possibly-stale/absent server pointer.
 */
const COMMAND_EVE_E2E_CLIENT_SEAT_ID = '5f22e4d4-7c85-4f9d-bcc3-4d4f8ad8b781';

/**
 * Narrow two-key E2E seam for the real SeatRail → Main switch lifecycle.
 *
 * The synthetic input enters BEFORE the production parser and authorization
 * boundary. Founder remains synthesized by resolveSeatAccess, and every switch
 * still runs through parseMySeats, isSeatSwitchAuthorized, applySeatSwitch,
 * runtime provisioning, backend restart, and config rebind. Neither key alone
 * changes production behavior, and the fixed roster contains no customer data.
 */
function readE2ESyntheticSeatRoster(): unknown | null {
  if (process.env.AIONUI_E2E_TEST !== '1' || process.env.COMMAND_EVE_E2E_SEAT_ROSTER !== 'founder-client') {
    return null;
  }

  const activeSeatId = getActiveSeatId();
  return {
    account: {
      id: 'command-eve-seat-rail-e2e',
      role: 'admin',
    },
    seats: [
      {
        tenant_id: COMMAND_EVE_E2E_CLIENT_SEAT_ID,
        name: 'E2E Kundenplatz',
        kind: 'client',
        role: 'admin',
        is_active: activeSeatId === COMMAND_EVE_E2E_CLIENT_SEAT_ID,
      },
    ],
    active_seat_id: activeSeatId,
  };
}

async function readMySeatsWire(): Promise<unknown | null> {
  const synthetic = readE2ESyntheticSeatRoster();
  if (synthetic) return synthetic;
  const wire = await readMySeatsWireCore(getDataPath(), {
    onFailure: (failure) => {
      commandEveMySeatsWireFailure = failure;
    },
  });
  if (wire !== null) commandEveMySeatsWireFailure = null;
  return wire;
}

/**
 * Persist the active-seat pointer.
 *
 * TWO POINTERS, ONE OF WHICH IS NOW REAL:
 *
 *   - the B3 SERVER pointer (set-active-seat edge function) stays PREPARED and
 *     not deployed — the server-side IDOR guard lives in that function, not here;
 *   - the LOCAL pointer (CEVE-18205) is written HERE, and it is what makes the
 *     next launch come up on this seat instead of the legacy one.
 *
 * The local write closes the boot gap this comment used to describe as "the next
 * launch re-derives the active seat" — nothing re-derived it. `seatContextCore`
 * reset to LEGACY_SEAT_ID on every start, so main read every seat-scoped key
 * un-namespaced (`commandEve.maxEntitled` among them) and the MAX turn parked on
 * "Berechtigung wird geprüft". See `activeSeatPointerStore`.
 *
 * BEST-EFFORT, unchanged: the local runtime switch already succeeded before this
 * runs, so neither write may roll it back (applySeatSwitch treats a throw as
 * persist_failed, not a switch failure).
 *
 * WHAT CHANGED (CEVE-18205 fix pack, S4): `writeActiveSeatPointer` returns
 * `'written' | 'cleared' | 'failed'` and this function THROWS on `'failed'`.
 * Both halves were previously silent — the store returned a boolean and this
 * caller discarded it — so a write that never landed (full disk, permissions,
 * read-only volume) reported a clean switch and the next boot came up on the
 * legacy seat reading every seat-scoped key un-namespaced. That is the bug the
 * pointer exists to close, silently reintroduced. Throwing is the RIGHT signal
 * here precisely because applySeatSwitch already catches it into `persist_failed`
 * without failing the switch: the operator learns the pointer did not stick, and
 * the working local switch stands.
 */
async function persistActiveSeatPointer(seatId: string, label?: string, kind?: string): Promise<void> {
  // The LOCAL pointer: survives a restart, needs no network, and is the only
  // thing that can restore the seat before the boot env bake runs.
  const result = writeActiveSeatPointer(getDataPath(), {
    seatId,
    ...(label === undefined ? {} : { label }),
    ...(kind === undefined ? {} : { kind }),
  });
  if (result === 'failed') {
    // 'cleared' is a SUCCESS (legacy target ⇒ absence is the correct state);
    // only 'failed' means the next boot will disagree with this switch.
    throw new Error(`Command EVE: active-seat pointer write failed for seat ${seatId}.`);
  }
  // PREPARED: no set-active-seat function deployed yet ⇒ server half is a no-op.
}

/**
 * T0 — resolve the CLI-Keystone worker-runtime inputs (codexRuntime + the
 * status-allowed Claude ACP delegate) for a seat-switch provisioning pass. A
 * bridge-local MIRROR of index.ts:resolveCommandEveWorkerRuntimeInputs so the
 * TARGET seat's config.yaml/SOUL.md are shaped identically to the boot path: the
 * worker assignments + team status are RENDERER-written keys living in the BACKEND
 * settings store (not the main-process ProcessConfig), so we read them via the
 * same batch backend reader. FAIL-SOFT: any read/parse failure yields ''/null (no
 * delegate directive — byte-identical to a seat with no assigned worker), and a
 * throw here is caught by the caller so it can never fail the switch.
 */
/**
 * COMPA-624 — the ACTIVE seat's honcho render input for the seat-switch launcher
 * wiring (an active Claude delegate gets the same per-seat memory EVE has). Fail-soft
 * to { ready:false } so a switch is never blocked by a Honcho resolution error.
 */
function resolveActiveSeatHonchoRenderForBridge(): HonchoRenderInput {
  try {
    const dataPath = getDataPath();
    const seatId = getActiveSeatId();
    const hermesVenv = resolveCommandEveRuntimeBootstrapPaths(dataPath, seatId).hermesVenv;
    return resolveHonchoRenderForSeat({ userDataPath: dataPath, seatId, hermesVenv });
  } catch {
    return { ready: false };
  }
}

async function resolveCommandEveWorkerRuntimeInputsForSwitch(): Promise<{
  /**
   * F7 (MEDIUM): FALSE when the settings read THREW (backend unreachable) — as
   * opposed to a reachable-but-empty config. The caller uses this to SKIP a
   * provisioning re-write with degraded inputs (which would otherwise silently
   * strip the Claude-delegate SOUL directive), leaving last-known-good files.
   */
  reachable: boolean;
  codexRuntime: string;
  claudeDelegate: import('@/common/config/eveWorkerAssignmentCore').ResolvedClaudeDelegate | null;
  /** 1.6.3 Team-Realität: roster + live status + worker for the SOUL team directive. */
  teamRoles: import('@/common/config/eveWorkerAssignmentCore').EveTeamDirectiveRole[];
  /**
   * 1.820: the TARGET seat's remembered command grants.
   *
   * P1 (final integrator audit, Codex): the boot path was fixed to read these and
   * this one was not, so a seat SWITCH re-provisioned the target seat with an
   * empty allowlist and silently dropped every grant that seat's human had given.
   * Same defect as the boot path, second call site — which is exactly why the
   * first fix should have been checked against every caller, not one.
   */
  rememberedCommands: readonly import('@/common/config/eveRememberedCommandsCore').EveRememberedCommand[];
}> {
  try {
    const { readCommandEveSettingsFromBackend } = await import('@process/commandEve/commandEveBackendSettingsRead');
    const { rememberedCommandsFromSettings } = await import('@/common/config/eveAuthorityStoreCore');
    const { buildTeamDirectiveRoles, codexRuntimeForConfig, resolveAssignedClaudeDelegate } =
      await import('@/common/config/eveWorkerAssignmentCore');
    const { applyLauncherWiring } = await import('@process/commandEve/eveWorkerLauncherCore');
    // SG-1 isolation (review fix): the shim + registry + team_manage intent live on
    // the MAIN-process singleton, which is NOT torn down on a seat-switch (only the
    // backend child respawns). Drop the previous seat's leases + any pending intent
    // NOW, so nothing accumulates across seats and the switch honours the documented
    // regenerate contract. applyLauncherWiring below re-mints for the (now-active)
    // new seat, so this only clears stale state — it never leaves the new seat bare.
    const { regenerateLeases } = await import('@process/commandEve/eveAgentTaskRegistry');
    const { clearPendingIntent } = await import('@process/commandEve/eveTeamManageBridgeCore');
    // COMPA-626 (Codex re-audit): the kanban pending intent is seat-partitioned but lives
    // on the singleton store, so it MUST also be cleared on a seat switch — otherwise a
    // stale seat-A proposal could be confirmed after switching back to A within its TTL.
    const { clearKanbanPendingIntent } = await import('@process/commandEve/kanbanAcpConfirmStore');
    regenerateLeases();
    clearPendingIntent();
    clearKanbanPendingIntent();
    type EveWorkerAssignmentMap = import('@/common/config/eveWorkerAssignmentCore').EveWorkerAssignmentMap;
    type EveTeamWorkerStatusMap = import('@/common/config/eveTeamControlsCore').EveTeamWorkerStatusMap;
    const bag = await readCommandEveSettingsFromBackend([
      'commandEve.workerAssignments',
      'commandEve.teamWorkerStatus',
      'commandEve.authority',
    ]);
    const assignmentsRaw = bag['commandEve.workerAssignments'];
    const statusesRaw = bag['commandEve.teamWorkerStatus'];
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
      reachable: true,
      codexRuntime: codexRuntimeForConfig(assignments),
      // SG-1 A3: same launcher wiring as the boot path (index.ts) so a seat-switch
      // re-emits the wrapped delegate + refreshes the new seat's status/token mirror.
      claudeDelegate: applyLauncherWiring(resolveAssignedClaudeDelegate(assignments, statuses), assignments, statuses, {
        dataPath: getDataPath(),
        seatId: getActiveSeatId(),
        resourcesPath: process.resourcesPath,
        env: process.env,
        honcho: resolveActiveSeatHonchoRenderForBridge(),
      }),
      teamRoles: buildTeamDirectiveRoles(assignments, statuses),
      // Seat-scoped: this is the TARGET seat's record, never a sibling's.
      rememberedCommands: rememberedCommandsFromSettings(bag),
    };
  } catch (error) {
    clearHermesDelegateTransportEnv(process.env);
    // F7: the settings READ threw → backend unreachable. Report reachable:false so
    // the switch's prepareEnv does NOT re-provision on degraded (empty) inputs.
    console.warn(
      '[Command EVE] seat-switch worker-runtime input read UNREACHABLE; last-known-good runtime files will be kept (no re-provision):',
      error
    );
    // Fail-CLOSED on the grants too: an unreadable store must never be read as
    // "everything this seat once allowed is still allowed".
    return { reachable: false, codexRuntime: '', claudeDelegate: null, teamRoles: [], rememberedCommands: [] };
  }
}

// IN-FLIGHT LOCK for command-eve.switch-seat. A switch is a real STOP+RE-SPAWN of
// the backend under a new HERMES_HOME; two overlapping switches would interleave
// lifecycles (orphaned process, nondeterministic landing seat). The renderer's 45s
// timeout can re-enable the rail BEFORE main finishes, so the renderer disabled
// state is NOT a sufficient guard — this single main-process boolean is the real
// serialization boundary (there is exactly one main process).
let commandEveSwitchSeatInFlight = false;
let commandEveSwitchSeatRecoveryRequired = false;

/** COMPA-626: read the seat-switch write fence from OUTSIDE the bridge (the kanban auto-
 * approve path applies from the shim propose handler, not the confirm IPC, so it must
 * consult the same fence to never write into the wrong seat during a switch). */
export function isCommandEveSeatSwitchInFlight(): boolean {
  return commandEveSwitchSeatInFlight;
}
// EPOCH for the lock. Bumped each time the lock is taken; a release only fires if its
// epoch is still current. The watchdog never reopens the lock: it only changes the
// public diagnosis to recovery-required. The epoch guard remains defense-in-depth for
// a future implementation that supersedes a stuck operation explicitly.
let commandEveSwitchSeatEpoch = 0;

// MAT-1773 — transition flag for the my-seats wire read. The my-seats handler is
// polled (renderer focus + 60s backstop), so the "wire unavailable" diagnostic is
// logged ONCE per down/up transition, never per poll. The wire reader collapses
// EVERY failure mode (no session / offline / 401 / non-2xx / malformed / timeout /
// function not deployed) into `null`; without this log the founder's invisible
// rail left NO trace anywhere.
let commandEveMySeatsWireDown = false;
// The WHY behind the current down-state (MAT-1773 follow-up): the wire reader
// reports every null with a typed failure (session/network/http/malformed), so
// the fallback envelope can carry it to the renderer — a DEAD account session
// (re-login recovers it) is then distinguishable from a transient read failure
// instead of both hiding the rail identically and silently.
let commandEveMySeatsWireFailure: MySeatsWireFailure | null = null;
// WATCHDOG bound for the lock — an OBSERVABILITY BACKSTOP, not a completion guarantee.
// If applySeatSwitch's await never settles (a hung re-spawn whose start() never binds
// its port), the finally never runs. The mutation fences intentionally remain closed,
// but the public reason changes from ordinary "in progress" to "recovery required" so
// the operator is told to relaunch instead of retrying into an unknown Seed context.
//   It is set FAR above any plausible respawn ceiling (5 min), NOT merely above the
// renderer's 45s timeout: 60s > 45s would NOT have guaranteed 60s > respawn time, so a
// legitimately slow respawn could trip it mid-flight and admit a concurrent switch. At
// 5 min the respawn is treated as operationally stuck, but never as safe to supersede
// inside the same process. Relaunch is the bounded recovery path.
const COMMAND_EVE_SWITCH_SEAT_LOCK_TIMEOUT_MS = 300_000;

/**
 * H1 (isolation-critical) — MID-SWITCH KANBAN WRITE-FENCE. The SACRED invariant:
 * a kanban WRITE must never land in the wrong seat's DB while a seat switch is in
 * flight. The switch sets the active-seat pointer (setActiveSeatId) BEFORE the
 * ~seconds-long backend re-spawn await completes; during that window the main
 * event loop still services IPC, so a click on the STILL-VISIBLE seat-A board
 * would resolve its DB path via getActiveSeatId() = seat B and write seat-A's
 * card into seat-B's kanban.db (cross-client contamination, Invariante 1).
 *
 * This is the MAIN-process half of the belt-and-suspenders fix (the renderer
 * disables the buttons too): every kanban MUTATION handler calls this guard FIRST
 * and REFUSES the write with SEAT_SWITCH_IN_PROGRESS while `commandEveSwitchSeat
 * InFlight` is set (the SAME single boolean that serializes the switch itself, so
 * the fence opens/closes exactly with the switch). Reads are never fenced — only
 * writes can contaminate. Returns a fail-closed envelope when a switch is active,
 * else `null` (proceed). The seat pointer is deterministic once the lock clears
 * (last setActiveSeatId wins), so a write after the fence lifts is on the target.
 */
function guardKanbanMutationDuringSwitch<V extends string>(
  version: V
): {
  success: false;
  msg: string;
  data: { version: V; ok: false; status: 'blocked'; reason_code: 'SEAT_SWITCH_IN_PROGRESS'; message: string };
} | null {
  if (!commandEveSwitchSeatInFlight) return null;
  const message = 'A seat switch is in progress — the board write was refused to protect per-seat isolation.';
  return {
    success: false,
    msg: 'SEAT_SWITCH_IN_PROGRESS',
    data: { version, ok: false, status: 'blocked', reason_code: 'SEAT_SWITCH_IN_PROGRESS', message },
  };
}

function nativeKanbanSwitchFence() {
  const fenced = guardKanbanMutationDuringSwitch(COMMAND_EVE_NATIVE_KANBAN_VERSION);
  if (!fenced) return null;
  return {
    success: false,
    msg: fenced.msg,
    data: {
      version: COMMAND_EVE_NATIVE_KANBAN_VERSION,
      ok: false,
      state: 'blocked' as const,
      reason_code: fenced.data.reason_code,
      message: fenced.data.message,
    },
  };
}

async function confirmComputerUseNativeAction(action: 'install' | 'grant') {
  // Lazy MAIN-only lookup keeps this bridge importable in non-Electron tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nativeDialog = (require('electron') as typeof import('electron')).dialog;
  const seatId = getActiveSeatId();
  const revision = getActiveSeatContextRevision();
  const german = app.getLocale().toLowerCase().startsWith('de');
  const install = action === 'install';
  const response = await nativeDialog.showMessageBox({
    type: 'warning',
    title: 'Command EVE — Desktop Use',
    message: install
      ? german
        ? 'Gepinnten Desktop-Use-Treiber installieren?'
        : 'Install the pinned Desktop Use driver?'
      : german
        ? 'macOS-Berechtigungen für CuaDriver anfragen?'
        : 'Request macOS permissions for CuaDriver?',
    detail: install
      ? german
        ? 'Hermes lädt exakt cua-driver 0.12.6. Command EVE prüft danach Release-Hash und Signatur. Abbrechen verändert nichts.'
        : 'Hermes downloads exactly cua-driver 0.12.6. Command EVE verifies its release hash and signature afterward. Cancel changes nothing.'
      : german
        ? 'macOS öffnet Bedienungshilfen und Bildschirmaufnahme für den signierten CuaDriver. Abbrechen erteilt keine Berechtigung.'
        : 'macOS opens Accessibility and Screen Recording for the signed CuaDriver. Cancel grants nothing.',
    buttons: [german ? 'Abbrechen' : 'Cancel', german ? 'Fortfahren' : 'Continue'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response.response !== 1) return { ok: false as const, reasonCode: 'COMPUTER_USE_USER_CANCELLED' };
  if (commandEveSwitchSeatInFlight || seatId !== getActiveSeatId() || revision !== getActiveSeatContextRevision()) {
    return { ok: false as const, reasonCode: 'SEAT_CHANGED_DURING_CONFIRMATION' };
  }
  return { ok: true as const, seatId, revision };
}

/**
 * F4 (HIGH) — MID-SWITCH COMPANY-BRAIN WRITE-FENCE (HOTFIX-A class). Same sacred
 * invariant as the kanban fence, applied to the per-seat Company Brain: a brain
 * WRITE / REMOVE must never land in the WRONG seat's company-brain/ while a seat
 * switch is in flight. The switch sets the active-seat pointer (setActiveSeatId)
 * BEFORE the ~seconds-long backend re-spawn completes; during that window the main
 * loop still services IPC, so a brain mutation resolved via resolveActiveSeatHome()
 * would write seat-A's knowledge into seat-B's home (cross-client contamination).
 * This is the brain twin of guardKanbanMutationDuringSwitch over the SAME single
 * `commandEveSwitchSeatInFlight` boolean, so the fence opens/closes exactly with the
 * switch. Fail-closed with the brain envelope shape { ok:false, reason_code } the T3
 * UI already reads. Reads (list/read) are NOT write-fenced — only writes can
 * contaminate — but list SKIPS its reconcile while a switch is in flight (below).
 */
function guardBrainMutationDuringSwitch(): {
  success: false;
  msg: string;
  data: { ok: false; reason_code: 'SEAT_SWITCH_IN_PROGRESS'; message: string };
} | null {
  if (!commandEveSwitchSeatInFlight) return null;
  const message = 'A seat switch is in progress — the Company-Brain write was refused to protect per-seat isolation.';
  return {
    success: false,
    msg: 'SEAT_SWITCH_IN_PROGRESS',
    data: { ok: false, reason_code: 'SEAT_SWITCH_IN_PROGRESS', message },
  };
}

// -----------------------------------------------------------------------------
// v1.4 T5 — L3 SESSION-DIGEST main-side plumbing.
// -----------------------------------------------------------------------------

// PRE-SWITCH-FLUSH in-flight marker. The digest handler records the CURRENTLY-RUNNING
// digest here (its promise); the seat-switch handler awaits it (hard-capped) BEFORE it
// starts the switch, so an OUTGOING seat's still-running digest completes and lands in
// the CORRECT (outgoing) seat's brain rather than being abandoned or landing wrong. We
// keep only the single most-recent run — the flush awaits AT MOST one run, never starts
// a new Ollama call (spec §4: "nur Abwarten eines laufenden").
let commandEveSessionDigestInFlight: Promise<unknown> | null = null;

const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const SESSION_DIGEST_TIMEOUT_MS = 12_000;
const REPORT_STAGE_WORKSPACE_FETCH_TIMEOUT_MS = 5_000;
// Perf (8GB audit): a session digest is a BACKGROUND nice-to-have. Below this unified-
// memory floor we skip its local inference entirely so it can't compete with the
// foreground turn for RAM on a low-memory machine (e.g. an 8GB Air). Matches the local-
// runtime RAM floor; cloud-only machines already no-op via the Ollama tags probe.
const SESSION_DIGEST_MIN_MEMORY_GB = 10;

/** Resolve the local aioncore backend port the restart hook publishes (main-side). */
function getCommandEveBackendPort(): number | undefined {
  return (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
}

class ReportStageWorkspaceLookupError extends Error {
  readonly reasonCode: string;
  constructor(message: string, reasonCode: string) {
    super(message);
    this.name = 'ReportStageWorkspaceLookupError';
    this.reasonCode = reasonCode;
  }
}

/**
 * Fetch the canonical conversation workspace from AionCore in Main.
 *
 * No renderer workspace value participates. The response id must match the
 * requested conversation and the workspace must be a bounded absolute path;
 * filesystem/seat containment is re-asserted by reportExportCore before write.
 */
export async function fetchConversationWorkspace(conversationId: string): Promise<string> {
  const id = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!id || id.length > 256 || id.includes('\0')) {
    throw new ReportStageWorkspaceLookupError(
      'Conversation id is missing or invalid.',
      'REPORT_STAGE_CONVERSATION_INVALID'
    );
  }
  const port = getCommandEveBackendPort();
  if (!port) {
    throw new ReportStageWorkspaceLookupError('AionCore backend is unavailable.', 'REPORT_STAGE_BACKEND_UNAVAILABLE');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_STAGE_WORKSPACE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(id)}`, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ReportStageWorkspaceLookupError(
        `Conversation workspace lookup failed (${response.status}).`,
        'REPORT_STAGE_CONVERSATION_LOOKUP_FAILED'
      );
    }
    const json = (await response.json()) as {
      data?: { id?: unknown; extra?: { workspace?: unknown } | null } | null;
    };
    const conversation = json?.data;
    if (!conversation || conversation.id !== id) {
      throw new ReportStageWorkspaceLookupError(
        'Conversation workspace response did not match the request.',
        'REPORT_STAGE_CONVERSATION_MISMATCH'
      );
    }
    const workspace = conversation.extra?.workspace;
    if (
      typeof workspace !== 'string' ||
      workspace.trim().length === 0 ||
      workspace.length > 4096 ||
      workspace.includes('\0') ||
      !nodePath.isAbsolute(workspace)
    ) {
      throw new ReportStageWorkspaceLookupError(
        'Conversation has no authoritative workspace.',
        'REPORT_STAGE_WORKSPACE_MISSING'
      );
    }
    return workspace.trim();
  } catch (error) {
    if (error instanceof ReportStageWorkspaceLookupError) throw error;
    throw new ReportStageWorkspaceLookupError(
      'Conversation workspace lookup failed.',
      'REPORT_STAGE_CONVERSATION_LOOKUP_FAILED'
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * T5 — MAIN-side local digest via Ollama. REUSES the generate-local-title pattern
 * (same base URL, 12s timeout, tags-probe → pickLocalTitleModel → non-streaming chat
 * with a num_predict cap) but with a LARGER num_predict (a digest is a paragraph, not
 * a title) and the digest prompt. FAIL-QUIET by contract: any error (Ollama down,
 * model not pulled, timeout, bad JSON) resolves to null so the writer skips the entry
 * — NEVER a raw-text fallback (privacy: no raw transcript in the brain).
 */
async function generateLocalDigest(prompt: string): Promise<string | null> {
  // Perf (8GB audit): skip the background digest inference on a low-RAM machine so it
  // never competes with the foreground turn. Fail-quiet (return null = no digest, never
  // a raw-text fallback), exactly like an Ollama-down probe. A RAM read failure falls
  // through to the tags/model probes below, which still gate on Ollama being present.
  try {
    const os = await import('node:os');
    if (os.totalmem() / 1024 ** 3 < SESSION_DIGEST_MIN_MEMORY_GB) return null;
  } catch {
    /* RAM unreadable — fall through; the Ollama tags probe still gates the cost */
  }
  const withTimeout = async (input: string, init: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_DIGEST_TIMEOUT_MS);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const tagsRes = await withTimeout(`${OLLAMA_BASE_URL}/api/tags`, { method: 'GET' });
    if (!tagsRes.ok) return null;
    const tagsJson = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
    const modelNames = (tagsJson.models || []).map((m) => String(m?.name || ''));
    const model = pickLocalTitleModel(modelNames);
    if (!model) return null;

    const chatRes = await withTimeout(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
        // A digest is ~600 chars; ~300 tokens is plenty and keeps the local call cheap.
        options: { num_predict: 320, temperature: 0.3 },
      }),
    });
    if (!chatRes.ok) return null;
    const chatJson = (await chatRes.json()) as { message?: { content?: string } };
    const content = chatJson.message?.content;
    return typeof content === 'string' && content.trim().length > 0 ? content : null;
  } catch {
    // AbortError / network / JSON — fail-quiet (no digest, never a raw fallback).
    return null;
  }
}

/**
 * T5 — MAIN-side transcript fetch. Raw loopback GET against the local backend
 * (globalThis.__backendPort), the SAME pattern webuiBridge uses; content_mode=compact,
 * a bounded cursor-page window. The backend wraps the payload in { data: { items } };
 * we return the raw items array (sessionDigestCore's extractTranscriptText tolerates
 * the compact shape). No auth (loopback-only routes). Returns [] on any failure.
 */
async function fetchConversationTranscript(conversationId: string, window: number): Promise<unknown> {
  const port = getCommandEveBackendPort();
  if (!port) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SESSION_DIGEST_TIMEOUT_MS);
  try {
    const limit = Math.min(200, Math.max(1, Math.floor(window)));
    const url = `http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}&content_mode=compact`;
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { items?: unknown } | null; items?: unknown };
    return json?.data?.items ?? json?.items ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1.820.3 — reconcile transcript fetch. NOT the digest's compact mode: the
 * backend's compact mode TRUNCATES large acp_tool_call outputs (aioncore
 * service.rs row_to_message_response_compact, its t8_6 test), which could cut
 * a staged handle in half and silently orphan a child forever. content_mode
 * full with a deliberately small window — the staged handle TTL is 30
 * minutes, so anything a reconcile can still bind is recent by construction.
 */
async function fetchConversationTranscriptFull(conversationId: string, window: number): Promise<unknown> {
  // Unlike the digest's fail-quiet compact fetch, this one THROWS on every
  // failure (no port, non-2xx, parse, network/abort): the reconcile must be
  // able to report transcriptFetched=false instead of mistaking a failed read
  // for an empty transcript. Its only caller catches and reports; the list
  // surface stays fail-quiet one level up.
  const port = getCommandEveBackendPort();
  if (!port) throw new Error('backend port unavailable');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SESSION_DIGEST_TIMEOUT_MS);
  try {
    const limit = Math.min(200, Math.max(1, Math.floor(window)));
    const url = `http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}&content_mode=full`;
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) throw new Error(`transcript fetch failed (${res.status})`);
    const json = (await res.json()) as { data?: { items?: unknown } | null; items?: unknown };
    return json?.data?.items ?? json?.items ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 1.820.3 — production reconcile closure for the staged image bind contract.
 * Same transcript substrate as the session digest (loopback messages API, no
 * raw database coupling); the store bind is idempotent, so the renderer fast
 * path racing this is a normal `alreadyBound`, never a conflict. The log line
 * is the visibility the R2 orphan never got: refused binds are reported, not
 * swallowed.
 */
/**
 * MOVED to `commandEve/artifactsChangedEmitter.ts` (1.821.0) so the video-edit
 * lanes can fire the SAME channel instance instead of minting a second one. The
 * local alias keeps every call site below unchanged; the doc on why the channel
 * is named for images but means "all artifacts" now lives with the emitter.
 */
const getImageArtifactsChangedEmitter = getCommandEveArtifactsChangedEmitter;

async function hydrateRemoteVideosForConversation(conversationId: string) {
  const { reconcileConversationRemoteVideos } = await import('../commandEve/videoArtifactHydrationMain');
  return reconcileConversationRemoteVideos(getDataPath(), conversationId, {
    fetchTranscript: (id, window) => fetchConversationTranscriptFull(id, window),
    log: (line) => console.warn(line),
  });
}

async function reconcileOfficeArtifactsForConversation(conversationId: string) {
  const { reconcileConversationOfficeArtifacts } = await import('../commandEve/document/officeArtifactLineageMain');
  return reconcileConversationOfficeArtifacts(getDataPath(), conversationId, {
    fetchTranscript: (id, window) => fetchConversationTranscriptFull(id, window),
    log: (line) => console.warn(line),
    onFreshArtifact: (id) => getImageArtifactsChangedEmitter().emit({ conversation_id: id }),
  });
}

async function reconcileConversationNativeArtifacts(conversationId: string) {
  const [video, office] = await Promise.all([
    hydrateRemoteVideosForConversation(conversationId),
    reconcileOfficeArtifactsForConversation(conversationId),
  ]);
  return { video, office };
}

async function reconcileImageArtifactBindsForConversation(
  conversationId: string,
  expectedSeatId: string = getActiveSeatId(),
  expectedSeatContextRevision: number = getActiveSeatContextRevision()
) {
  const { reconcileConversationImageArtifactBinds } = await import('../commandEve/imageArtifactReconcileMain');
  const { bindStagedImageArtifact, countPendingStagedImageArtifacts } =
    await import('../commandEve/imageArtifactStore');
  return reconcileConversationImageArtifactBinds(getDataPath(), conversationId, expectedSeatId, {
    fetchTranscript: (id, window) => fetchConversationTranscriptFull(id, window),
    bind: bindStagedImageArtifact,
    log: (line) => console.warn(line),
    countPendingStaged: countPendingStagedImageArtifacts,
    seatStillMatches: () =>
      getActiveSeatId() === expectedSeatId && getActiveSeatContextRevision() === expectedSeatContextRevision,
    onFreshBind: (id) => getImageArtifactsChangedEmitter().emit({ conversation_id: id }),
  });
}

/**
 * T5 — resolve a conversation's TITLE (best-effort) for the digest entry title. Reads
 * the same conversations list the sidebar uses; returns the matching row's name, else
 * undefined (the digest core falls back to a dated "Session <datum>").
 */
async function fetchConversationTitle(conversationId: string): Promise<string | undefined> {
  const port = getCommandEveBackendPort();
  if (!port) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SESSION_DIGEST_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations?limit=10000`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      data?: { items?: Array<Record<string, unknown>> } | null;
      items?: Array<Record<string, unknown>>;
    };
    const items = json?.data?.items ?? json?.items ?? [];
    const row = items.find((c) => String(c?.id ?? '') === conversationId);
    const name = row && typeof row.name === 'string' ? row.name.trim() : '';
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function initCommandEveBridge(): void {
  bridge.buildProvider('command-eve.native-kanban-board').provider(async () => {
    try {
      const scope = captureNativeKanbanSeatScope(getDataPath());
      const result = await ensureHermesNativeKanbanBoard(scope);
      if (!nativeKanbanSeatScopeStillActive(scope)) {
        return {
          success: false,
          msg: 'SEAT_CHANGED_DURING_READ',
          data: {
            ...result,
            ok: false,
            state: 'blocked',
            reason_code: 'SEAT_CHANGED_DURING_READ',
            message: 'The active seat changed while the board was loading. Refresh the board.',
            board: undefined,
          },
        };
      }
      return { success: result.ok, msg: result.ok ? undefined : result.reason_code, data: result };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Native Kanban bridge failed.',
      };
    }
  });

  bridge
    .buildProvider('command-eve.native-kanban-task-create')
    .provider(async (request?: CommandEveNativeKanbanCreateRequest) => {
      const fenced = nativeKanbanSwitchFence();
      if (fenced) return fenced;
      if (!request) return { success: false, msg: 'KANBAN_CREATE_INVALID' };
      try {
        const scope = captureNativeKanbanSeatScope(getDataPath());
        const result = await createHermesNativeKanbanTask(request, scope);
        if (!nativeKanbanSeatScopeStillActive(scope)) {
          return {
            success: false,
            msg: 'SEAT_CHANGED_DURING_WRITE',
            data: {
              ...result,
              ok: false,
              state: 'blocked',
              reason_code: 'SEAT_CHANGED_DURING_WRITE',
              message: 'The task stayed in its original seat, but the visible seat changed. Refresh the board.',
              board: undefined,
              task: undefined,
            },
          };
        }
        return { success: result.ok, msg: result.ok ? undefined : result.reason_code, data: result };
      } catch (error) {
        return { success: false, msg: error instanceof Error ? error.message : 'Native Kanban create failed.' };
      }
    });

  bridge
    .buildProvider('command-eve.native-kanban-task-update')
    .provider(async (request?: CommandEveNativeKanbanUpdateRequest) => {
      const fenced = nativeKanbanSwitchFence();
      if (fenced) return fenced;
      if (!request) return { success: false, msg: 'KANBAN_UPDATE_INVALID' };
      try {
        const scope = captureNativeKanbanSeatScope(getDataPath());
        const result = await updateHermesNativeKanbanTask(request, scope);
        if (!nativeKanbanSeatScopeStillActive(scope)) {
          return {
            success: false,
            msg: 'SEAT_CHANGED_DURING_WRITE',
            data: {
              ...result,
              ok: false,
              state: 'blocked',
              reason_code: 'SEAT_CHANGED_DURING_WRITE',
              message: 'The task stayed in its original seat, but the visible seat changed. Refresh the board.',
              board: undefined,
              task: undefined,
            },
          };
        }
        return { success: result.ok, msg: result.ok ? undefined : result.reason_code, data: result };
      } catch (error) {
        return { success: false, msg: error instanceof Error ? error.message : 'Native Kanban update failed.' };
      }
    });

  bridge.buildProvider('command-eve.computer-use-status').provider(async () => {
    const result = await readCommandEveComputerUseStatus({ userDataPath: getDataPath() });
    return { success: result.ok, msg: result.ok ? undefined : result.reason_code, data: result };
  });

  bridge.buildProvider('command-eve.computer-use-install').provider(async () => {
    if (commandEveSwitchSeatInFlight) return { success: false, msg: 'SEAT_SWITCH_IN_PROGRESS' };
    const confirmation = await confirmComputerUseNativeAction('install');
    if (!confirmation.ok) return { success: false, msg: confirmation.reasonCode };
    const result = await installCommandEveComputerUseDriver({
      userDataPath: getDataPath(),
      nativeIntent: issueCommandEveComputerUseNativeIntent('install', confirmation),
    });
    return { success: result.ok, msg: result.ok ? undefined : result.reason_code, data: result };
  });

  bridge.buildProvider('command-eve.computer-use-permissions-grant').provider(async () => {
    if (commandEveSwitchSeatInFlight) return { success: false, msg: 'SEAT_SWITCH_IN_PROGRESS' };
    const confirmation = await confirmComputerUseNativeAction('grant');
    if (!confirmation.ok) return { success: false, msg: confirmation.reasonCode };
    const result = await grantCommandEveComputerUsePermissions({
      userDataPath: getDataPath(),
      nativeIntent: issueCommandEveComputerUseNativeIntent('grant', confirmation),
    });
    return { success: result.ok, msg: result.ok ? undefined : result.reason_code, data: result };
  });

  bridge.buildProvider('command-eve.computer-use-permissions-revoke-guide').provider(async () => {
    const result = revokeCommandEveComputerUsePermissionsGuide();
    return { success: false, msg: result.reason_code, data: result };
  });

  bridge.buildProvider('command-eve.command-center-read-model').provider(async (request?: { maxRuns?: number }) => {
    try {
      const result = await buildCommandCenterReadModel({ maxRuns: request?.maxRuns });
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code || result.message,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE read-model bridge failed.',
        data: {
          version: 'command-eve-command-center-read-model/v0',
          ok: false,
          status: 'failed',
          reason_code: 'COMMAND_CENTER_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : 'Command EVE read-model bridge failed.',
          source: {
            generated_by: 'company-os-read-model-cli',
          },
        },
      };
    }
  });

  bridge
    .buildProvider('command-eve.status-surface')
    .provider(
      async (request?: CommandEveStatusSurfaceRequest | CommandEveBridgeEnvelope<CommandEveStatusSurfaceRequest>) => {
        const payload = unwrapBridgeRequest<CommandEveStatusSurfaceRequest>(request);
        try {
          const result = await buildCommandEveStatusSurface({
            maxRuns: payload?.maxRuns,
            companyOsRoot: payload?.companyOsRoot,
            eventLedgerPath: payload?.eventLedgerPath,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE status surface bridge failed.',
            data: {
              version: 'command-eve-status-surface-bridge/v0',
              ok: false,
              status: 'failed',
              reason_code: 'STATUS_SURFACE_BRIDGE_FAILED',
              message: error instanceof Error ? error.message : 'Command EVE status surface bridge failed.',
              source: {
                generated_by: 'company-os-status-surface-cli',
              },
            },
          };
        }
      }
    );

  bridge.buildProvider('command-eve.connector-catalog').provider(async (request?: { manifestPath?: string }) => {
    try {
      const result = buildConnectorCatalog({ manifestPath: request?.manifestPath });
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code || result.message,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE connector catalog bridge failed.',
        data: {
          version: 'command-eve-connector-catalog/v0',
          ok: false,
          status: 'failed',
          reason_code: 'CONNECTOR_CATALOG_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : 'Command EVE connector catalog bridge failed.',
          source: {
            generated_by: 'command-eve-connector-catalog-core',
          },
        },
      };
    }
  });

  bridge
    .buildProvider('command-eve.connector-preflight')
    .provider(async (request?: { connectorId?: string; manifestPath?: string }) => {
      try {
        const result = runConnectorPreflight({
          connectorId: request?.connectorId || '',
          manifestPath: request?.manifestPath,
        });
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reason_code || result.message,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE connector preflight bridge failed.',
          data: {
            version: 'command-eve-connector-preflight/v0',
            ok: false,
            status: 'failed',
            reason_code: 'CONNECTOR_PREFLIGHT_BRIDGE_FAILED',
            message: error instanceof Error ? error.message : 'Command EVE connector preflight bridge failed.',
          },
        };
      }
    });

  // -------------------------------------------------------------------------
  // GUIDED_AUTH_SETUP (S5 phase 2, arch §6) — the REAL handler for the
  // previously-dead connector action. API-KEY PATH ONLY (OAuth deferred, arch
  // §6.3). Fail-closed FIRST on secure storage: no keychain → refuse, NEVER
  // plaintext, NEVER a record written. Then encrypt → vault record (vetted only
  // WITH a human_gate_receipt) → reconcile so the card flips to `connected`.
  //
  // The card can SHOW "connect", but the actual ENABLE stays behind
  // COMMAND_EVE_MCP_VAULT_ENABLED (a kill switch since 1.821.0, unset = on): the
  // record is written + vetted,
  // but the reconcile re-render emits it into config.yaml ONLY when the flag flips
  // (the separate GATE-NULL slice). connectorCatalogCore's global
  // mcp_enable_allowed / connector_write_allowed stay FALSE (no global flip).
  // -------------------------------------------------------------------------
  bridge
    .buildProvider('command-eve.guided-auth-setup')
    .provider(
      async (request?: {
        connectorId?: string;
        secrets?: Record<string, string>;
        scope?: 'founder' | 'seat';
        seatId?: string;
        humanGateReceipt?: string;
        manifestPath?: string;
      }) => {
        const version = 'command-eve-guided-auth-setup/v0' as const;
        // A switch that already owns the authority boundary blocks a new
        // credential mutation instead of letting it wait and silently target the
        // post-switch seat. When this connector arrives first, the synchronous
        // reservation below is enqueued before any import/seat read/vault write,
        // so a later switch must wait until the response is terminal.
        if (commandEveSwitchSeatInFlight) {
          return {
            success: false,
            msg: 'SEAT_SWITCH_IN_PROGRESS',
            data: { version, ok: false, reason_code: 'SEAT_SWITCH_IN_PROGRESS' },
          };
        }
        try {
          return await runConnectorAuthorityMutationTransaction({
            trigger: 'approve',
            mutate: async () => {
              const { runGuidedApiKeySetup } = await import('@process/commandEve/guidedAuthSetupCore');
              const { referenceMcpInvocationFor } = await import('@process/commandEve/curatedConnectorReference');
              const { readVaultRecordFileSnapshot, restoreVaultRecordFileSnapshot } =
                await import('@process/commandEve/vaultRecordCore');
              const { founderVaultDir, seatVaultDir } = await import('@process/commandEve/vaultDirCore');

              const canonicalRequestId = resolveCanonicalConnectorId(request?.connectorId);
              if (!canonicalRequestId.ok) {
                const result: GuidedAuthSetupResult = {
                  ok: false,
                  reason_code: 'GUIDED_AUTH_CONNECTOR_ID_UNSAFE',
                };
                return {
                  value: result,
                  accepted: false,
                  failureReason: result.reason_code,
                  rollback: () => true,
                  rollbackTrigger: 'revoke' as const,
                };
              }
              const connectorId = canonicalRequestId.connectorId;

              // Resolve the connector's stdio invocation. An explicit manifest is
              // authoritative and must contain the exact canonical request id; only
              // the no-manifest sandbox path may use the pinned reference connector.
              let invocation = request?.manifestPath ? undefined : referenceMcpInvocationFor(connectorId);
              try {
                const catalog = buildConnectorCatalog({ manifestPath: request?.manifestPath });
                if (catalog.model) {
                  const manifestConnector = catalog.model.connectors.find((entry) => entry.id === connectorId);
                  if (manifestConnector?.id === connectorId) invocation = manifestConnector.mcp_invocation;
                  else if (request?.manifestPath) invocation = undefined;
                }
              } catch {
                // An explicit unavailable/malformed manifest stays fail-closed.
              }

              const paths = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
              const scope = request?.scope === 'seat' ? ('seat' as const) : ('founder' as const);
              const seatId = scope === 'seat' ? getActiveSeatId() : undefined;
              const vaultDir =
                scope === 'seat' ? seatVaultDir(paths.hermesRoot, seatId) : founderVaultDir(paths.userDataPath);
              const previousSnapshot = readVaultRecordFileSnapshot(vaultDir, connectorId);
              if (!previousSnapshot.ok || !previousSnapshot.snapshot) {
                const result: GuidedAuthSetupResult = {
                  ok: false,
                  connector_id: connectorId,
                  reason_code: previousSnapshot.reason_code ?? 'VAULT_RECORD_SNAPSHOT_READ_FAILED',
                };
                return {
                  value: result,
                  accepted: false,
                  failureReason: result.reason_code,
                  rollback: () => true,
                  rollbackTrigger: 'revoke' as const,
                };
              }
              const result = runGuidedApiKeySetup({
                connector_id: connectorId,
                mcp_invocation: invocation,
                secrets: request?.secrets ?? {},
                scope,
                seat_id: seatId,
                human_gate_receipt: typeof request?.humanGateReceipt === 'string' ? request.humanGateReceipt : '',
                userDataPath: paths.userDataPath,
                configRoot: paths.hermesRoot,
              });

              return {
                value: result,
                accepted: result.ok,
                failureReason: result.reason_code,
                rollback: () => restoreVaultRecordFileSnapshot(vaultDir, connectorId, previousSnapshot.snapshot!),
                rollbackTrigger: 'revoke' as const,
              };
            },
            finalize: (transaction) => {
              const result = transaction.value;
              if (transaction.ok) {
                return {
                  success: true,
                  data: { version, ...result, reconcile: transaction.reconcile },
                };
              }
              const reasonCode = result.ok
                ? 'GUIDED_AUTH_AUTHORITY_TRANSACTION_FAILED'
                : (result.reason_code ?? 'GUIDED_AUTH_BRIDGE_FAILED');
              return {
                success: false,
                msg: transaction.original_error ?? reasonCode,
                data: {
                  version,
                  ...result,
                  ok: false,
                  reason_code: reasonCode,
                  authority_transaction: {
                    terminal_state: transaction.terminal_state,
                    original_error: transaction.original_error,
                    rollback: transaction.rollback,
                  },
                },
              };
            },
          });
        } catch (error) {
          return {
            success: false,
            msg: sanitizeConnectorAuthorityDiagnostic(error, 'Command EVE guided auth setup bridge failed.'),
            data: { version, ok: false, reason_code: 'GUIDED_AUTH_BRIDGE_FAILED' },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.skill-library')
    .provider(async (request?: { runtimeReconciliationPath?: string; capabilityPackPath?: string }) => {
      try {
        const result = buildSkillLibrary({
          userDataPath: getDataPath(),
          runtimeReconciliationPath: request?.runtimeReconciliationPath,
          capabilityPackPath: request?.capabilityPackPath,
        });
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reason_code || result.message,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE skill library bridge failed.',
          data: {
            version: 'command-eve-skill-library/v0',
            ok: false,
            status: 'failed',
            reason_code: 'SKILL_LIBRARY_BRIDGE_FAILED',
            message: error instanceof Error ? error.message : 'Command EVE skill library bridge failed.',
            source: {
              generated_by: 'command-eve-skill-library-core',
            },
          },
        };
      }
    });

  // 1.2.18 Req 2 — read-only SKILL.md body for the unified Fähigkeiten surface
  // (click-to-read). Reads ONLY the on-disk skill roots the desktop manages
  // (user/custom, EVE-learned cron, managed strategy); traversal-guarded in the
  // core. Pure backend-owned builtins are read by the renderer via the existing
  // /api/skills/builtin-skill endpoint, never here.
  bridge
    .buildProvider('command-eve.skill-content')
    .provider(async (request?: { skill_id?: string; skill_path?: string }) => {
      try {
        const paths = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
        const rootDirs = [getSkillsDir(), getCronSkillsDir(), paths.managedSkillsRoot];
        const result = readSkillContent({
          rootDirs,
          skillPath: request?.skill_path,
          skillName: request?.skill_id,
        });
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reason_code,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE skill-content bridge failed.',
          data: { ok: false, read_only: true as const, reason_code: 'READ_FAILED' as const },
        };
      }
    });

  // 1.2.18 Req 2 — list EVE-learned skills ({cronSkillsDir}/{job_id}/SKILL.md) so
  // the unified surface can show them read-only. Does NOT move the files (the cron
  // runtime reads them in place); a pure scan + frontmatter parse.
  bridge.buildProvider('command-eve.learned-skills').provider(async () => {
    try {
      const cards = listLearnedSkills(getCronSkillsDir());
      return { success: true, data: { ok: true as const, skills: cards } };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE learned-skills bridge failed.',
        data: { ok: false as const, skills: [] },
      };
    }
  });

  // v1.6 — EVE-AUTHORED skills ("der User soll SEHEN, dass EVE sich erweitert
  // hat"). EVE writes her own field skills into the per-seat Hermes default dir
  // {hermesHome}/skills (separate from the app bundle in skills-command-eve), so
  // location IS the honest provenance. Pure read-only scan, per active seat;
  // app-owned ids are excluded as a safety net. Feeds the "Von EVE erstellt"
  // badge + description + mtime "neu"-marker on the Skill Library surface.
  bridge.buildProvider('command-eve.authored-skills').provider(async () => {
    try {
      const paths = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
      const authoredDir = nodePath.join(paths.hermesHome, COMMAND_EVE_AUTHORED_SKILLS_DIR);
      const appOwned = new Set<string>([
        ...EVE_STRATEGY_SKILL_IDS,
        COMMAND_EVE_ONBOARDING_SKILL_ID,
        COMMAND_EVE_ARTIFACT_MENU_SKILL_ID,
      ]);
      const cards = listAuthoredSkills(authoredDir, appOwned);
      return { success: true, data: { ok: true as const, skills: cards } };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE authored-skills bridge failed.',
        data: { ok: false as const, skills: [] },
      };
    }
  });

  bridge
    .buildProvider('command-eve.local-runtime-status')
    .provider(async (request?: { manifestPath?: string; receiptPath?: string }) => {
      try {
        // 1.6.3 probes (each fail-soft): Ollama /api/tags for per-model
        // installed+size (2s cap — a down Ollama yields undefined ⇒ the core
        // emits `ollama_probe_unavailable` instead of a false "not installed"),
        // os.totalmem for the RAM fit, statfs at the runtime root for disk.
        // M-modelcard-baseurl (Codex): probe the SAME loopback the bootstrap/pull
        // path uses (manifest.local_runtime.base_url), not a hardcoded 127.0.0.1:11434.
        // On a manifest with a non-default Ollama port the hardcoded probe reported
        // "Status unbekannt" / a wrong install-state next to a working runtime.
        let ollamaBaseUrl = OLLAMA_BASE_URL;
        try {
          const manifestPath = resolveCommandEveRuntimeBootstrapManifestPath({
            manifestPath: request?.manifestPath,
            resourcesPath: process.resourcesPath,
          });
          const configured = loadCommandEveRuntimeBootstrapManifest(manifestPath).local_runtime?.base_url;
          if (typeof configured === 'string' && configured.trim().length > 0) ollamaBaseUrl = configured.trim();
        } catch {
          /* keep the default loopback */
        }
        let installedModels: Array<{ name: string; size?: number }> | undefined;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2000);
          try {
            const res = await fetch(`${ollamaBaseUrl}/api/tags`, { method: 'GET', signal: controller.signal });
            if (res.ok) {
              const json = (await res.json()) as { models?: Array<{ name?: string; size?: number }> };
              installedModels = (json.models || [])
                .map((m) =>
                  Object.assign({ name: String(m?.name || ``) }, typeof m?.size === `number` ? { size: m.size } : {})
                )
                .filter((m) => m.name.length > 0);
            }
          } finally {
            clearTimeout(timer);
          }
        } catch {
          /* probe unavailable — the core says so honestly */
        }
        let totalMemoryBytes: number | undefined;
        let freeDiskGb: number | undefined;
        try {
          const os = await import('node:os');
          totalMemoryBytes = os.totalmem();
        } catch {
          /* fit defaults to true */
        }
        try {
          const fsNode = await import('node:fs');
          const paths = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
          const stats = fsNode.statfsSync(paths.runtimeRoot);
          freeDiskGb = (stats.bavail * stats.bsize) / 1024 ** 3;
        } catch {
          /* fit defaults to true */
        }
        const bonsaiInstall = readBonsaiInstallStatus(getDataPath());
        const colibriInstall = readColibriInstallStatus(getDataPath());
        const result = buildLocalRuntimeStatus({
          userDataPath: getDataPath(),
          manifestPath: request?.manifestPath,
          receiptPath: request?.receiptPath,
          installedModels,
          totalMemoryBytes,
          freeDiskGb,
          managedTierInstallStatus: {
            [COMMAND_EVE_BONSAI_LOCAL_TIER_ID]: bonsaiInstall,
            [COMMAND_EVE_COLIBRI_LOCAL_TIER_ID]: colibriInstall,
          },
        });
        const progressCandidates = [
          bonsaiInstall.progress
            ? {
                progress: bonsaiInstall.progress,
                model: COMMAND_EVE_BONSAI_RUNTIME_MODEL_ID,
                path: resolveBonsaiPilotPaths(getDataPath()).provisionProgressPath,
                inFlight: isBonsaiProvisionInFlight(getDataPath()),
              }
            : undefined,
          colibriInstall.progress
            ? {
                progress: colibriInstall.progress,
                model: COMMAND_EVE_COLIBRI_RUNTIME_MODEL_ID,
                path: resolveColibriPaths(getDataPath()).provisionProgressPath,
                inFlight: isColibriProvisionInFlight(getDataPath()),
              }
            : undefined,
        ]
          .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
          .toSorted((a, b) => Date.parse(b.progress.updated_at) - Date.parse(a.progress.updated_at));
        const activeProgress = progressCandidates.find(
          (candidate) => candidate.inFlight && ['pulling', 'building'].includes(candidate.progress.status)
        );
        if (result.model && activeProgress) {
          result.model.model_pull = {
            path: activeProgress.path,
            status: activeProgress.progress.status as 'pulling' | 'building',
            model: activeProgress.model,
            total: activeProgress.progress.total,
            completed: activeProgress.progress.completed,
            percent: activeProgress.progress.percent,
            updated_at: activeProgress.progress.updated_at,
          };
        }
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reason_code || result.message,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE local runtime status bridge failed.',
          data: {
            version: 'command-eve-local-runtime-status/v0',
            ok: false,
            status: 'failed',
            reason_code: 'LOCAL_RUNTIME_STATUS_BRIDGE_FAILED',
            message: error instanceof Error ? error.message : 'Command EVE local runtime status bridge failed.',
            source: {
              generated_by: 'command-eve-local-runtime-status-core',
            },
          },
        };
      }
    });

  // Guided Onboarding (SLICE S0). Read-only aggregator over the two
  // machine-written signals (runtime-bootstrap-receipt.json +
  // first-run-profile.json) plus entitlement + license-wire presence. No spawn,
  // no network, no write. First value gates on entitlement + license-wire, NOT
  // on local stages (a cloud-only user is ready).
  bridge.buildProvider('command-eve.onboarding-status').provider(async () => {
    try {
      const result = buildCommandEveOnboardingStatus({ userDataPath: getDataPath() });
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code || result.message,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE onboarding status bridge failed.',
        data: {
          version: COMMAND_EVE_ONBOARDING_STATUS_BRIDGE_VERSION,
          ok: false,
          reason_code: 'ONBOARDING_STATUS_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : 'Command EVE onboarding status bridge failed.',
          source: {
            generated_by: 'command-eve-onboarding-status-core',
          },
        },
      };
    }
  });

  // ISO-3: persist the Day-0 Company-Brain seed into the ACTIVE seat's
  // hermesHome (NOT the global config store). resolveActiveSeatHome inside the
  // core picks up the active seat automatically — no seatId plumbing here, same
  // as the kanban/crm providers. The seed is the client's day-0 truth; it must
  // live per-seat so each reseller client carries its own knowledge.
  bridge.buildProvider('command-eve.company-brain-seed').provider(async (request?: { seed?: ClientSeedInput }) => {
    try {
      const seed = request?.seed;
      if (!seed) {
        return { success: false, msg: 'Missing seed payload.', data: null as unknown };
      }
      const result = writeCompanyBrainSeed({ userDataPath: getDataPath(), seed });
      // F5 (HIGH): on a post-T2 seat the empty day-zero scaffold (brain.json) is
      // ALWAYS created before the first seed, so migrateSeedToBrain is a permanent
      // no-op (it only migrates when brain.json is ABSENT) — the Seed button never
      // produced a brain ENTRY. Fold the seed into a 'brief' entry HERE, right
      // after a successful seed write, under the SAME stable id the migration uses
      // (COMMAND_EVE_DAY_ZERO_BRIEF_ID) so a second seed UPDATES it (no duplicate).
      // Best-effort: the seed write already succeeded; a failed upsert must not turn
      // the seed into an error, so it is logged and swallowed.
      if (result.ok) {
        try {
          // COMPA-625: the seed always writes to the ACTIVE seat (resolveActiveSeatHome),
          // so active===target here; the boundary's real work at this site is the S3 hard
          // floor — a day-0 brief carrying a raw secret/health/finance must not be
          // persisted into the durable per-client brain. Best-effort: a rejected brief is
          // logged + skipped (the seed write itself already succeeded), never an error.
          const seatId = getActiveSeatId();
          const guard = enforceMemoryBoundary({
            operation: 'write',
            store: 'company-brain',
            activeSeatId: seatId,
            targetSeatId: seatId,
            payloadText: result.record.value,
          });
          if (!guard.ok) {
            console.warn('[Command EVE] 625 memory-boundary skipped seed→brain brief:', guard.reasonCode);
          } else {
            upsertEntry(result.hermesHome, {
              id: COMMAND_EVE_DAY_ZERO_BRIEF_ID,
              kind: 'brief',
              title: 'Day-0 Briefing',
              body: result.record.value,
              author: 'user',
              source: 'seed-migration',
            });
          }
        } catch (error) {
          console.warn('[Command EVE] seed→brain brief entry upsert failed (seed itself succeeded):', error);
        }
        await refreshBrowserWorkbenchContextBestEffort();
      }
      return { success: result.ok, data: result as unknown };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE company-brain seed write failed.',
        data: null as unknown,
      };
    }
  });

  bridge.buildProvider('command-eve.company-brain-status').provider(async () => {
    try {
      const state = readCompanyBrainSeedState({ userDataPath: getDataPath() });
      return { success: true, data: state as unknown };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE company-brain status read failed.',
        data: { seeded: false, record: null } as unknown,
      };
    }
  });

  // v1.6 Slice 2 ("Die Hinterlassene Hand") — read EVE's handover note for the
  // start surface. DUMB READER by design: returns the raw file + its mtime; the
  // tolerant parse and all framing live in the pure startscreenNoteCore (the
  // system's mtime is the ONLY timestamp authority, never a claim inside the
  // file). Per-seat via resolveActiveSeatHome (her note never crosses seats).
  // Missing file is a NORMAL state ({ok:true, exists:false} → the claim-free
  // system card), not an error.
  bridge.buildProvider('command-eve.startscreen-note').provider(async () => {
    const version = 'command-eve-startscreen-note/v0';
    try {
      const home = resolveActiveSeatHome(getDataPath()).hermesHome;
      const notePath = nodePath.join(home, ...COMMAND_EVE_HANDOVER_NOTE_RELPATH.split('/'));
      const { promises: fsp } = await import('node:fs');
      let stat;
      try {
        stat = await fsp.stat(notePath);
      } catch {
        return { success: true, data: { version, ok: true, exists: false } as unknown };
      }
      if (!stat.isFile()) {
        return { success: true, data: { version, ok: true, exists: false } as unknown };
      }
      const raw = (await fsp.readFile(notePath, 'utf8')).slice(0, HANDOVER_NOTE_MAX_RAW_CHARS);
      return {
        success: true,
        data: { version, ok: true, exists: true, mtime_ms: stat.mtimeMs, raw } as unknown,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE startscreen note read failed.',
        data: { version, ok: false, reason_code: 'STARTSCREEN_NOTE_READ_FAILED' } as unknown,
      };
    }
  });

  // v1.4 T2: multi-entry Company-Brain store (brain.json v2). All three handlers
  // resolve the ACTIVE seat's hermesHome (resolveActiveSeatHome) — the store is
  // per-seat, never global, never cross-seat. LIST returns the index only (titles,
  // NO bodies); WRITE upserts a user/settings entry (append-first — "Weiteren
  // Client ergänzen" is honest now); REMOVE deletes an entry + its body. Errors
  // surface as { ok:false, reason_code } (the T3 UI reads that shape). No UI here.
  // 1.6.3 — SHELL FLAGS (read-only). The renderer must not read process.env
  // (commandEveShell doc), so build-scope gates cross this tiny bridge. Today:
  // founder_build hides founder-only surfaces (the Assistenten-CRUD tab) from
  // the public build. Fail-soft: any error reads as the PUBLIC shape.
  bridge.buildProvider('command-eve.shell-flags').provider(async () => {
    try {
      return {
        success: true,
        data: {
          ok: true,
          founder_build: isCommandEveFounderBuildAllowed(app.isPackaged),
          is_dev_mode: !app.isPackaged,
        } as unknown,
      };
    } catch {
      return { success: true, data: { ok: true, founder_build: false, is_dev_mode: false } as unknown };
    }
  });

  // SG-1 A3 — manual-panel freshness. There is no main-side push when the renderer
  // writes commandEve.teamWorkerStatus (the panel PUTs it to the aioncore backend
  // store). So after a manual pause/resume, the panel fires this fire-and-forget so
  // main rewrites the DERIVED launcher status files RIGHT NOW — otherwise a role
  // paused mid-session would keep its stale 'active' status file until the next
  // boot/seat-switch, and the delegate lane's pause-gate (which reads that file)
  // would not fire until then. The status file is a read-mirror, never a 2nd truth.
  bridge.buildProvider('command-eve.sync-worker-launcher-state').provider(async () => {
    try {
      const { readCommandEveSettingsFromBackend } = await import('@process/commandEve/commandEveBackendSettingsRead');
      const { syncEveWorkerLauncherFiles } = await import('@process/commandEve/eveWorkerLauncherCore');
      type EveWorkerAssignmentMap = import('@/common/config/eveWorkerAssignmentCore').EveWorkerAssignmentMap;
      type EveTeamWorkerStatusMap = import('@/common/config/eveTeamControlsCore').EveTeamWorkerStatusMap;
      const bag = await readCommandEveSettingsFromBackend([
        'commandEve.workerAssignments',
        'commandEve.teamWorkerStatus',
      ]);
      const assignmentsRaw = bag['commandEve.workerAssignments'];
      const statusesRaw = bag['commandEve.teamWorkerStatus'];
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
      const res = syncEveWorkerLauncherFiles(assignments, statuses, {
        dataPath: getDataPath(),
        seatId: getActiveSeatId(),
      });
      return { success: true, data: { ok: true, tokensWritten: res.tokensWritten.length } as unknown };
    } catch (error) {
      console.warn('[Command EVE] sync-worker-launcher-state failed:', error);
      return { success: true, data: { ok: false } as unknown };
    }
  });

  // SG-1 Design B — team_manage confirm lane. The renderer POLLS -peek for a pending
  // intent (recoverable after a restart; B4), renders a confirm card, and calls
  // -apply (the ONLY settings write) or -reject. All authoritative logic + the
  // receipt live main-side (eveTeamManageMain); these are thin IPC seams.
  bridge.buildProvider('command-eve.team-manage-peek').provider(async () => {
    try {
      const { peekTeamManageForRenderer } = await import('@process/commandEve/eveTeamManageMain');
      return { success: true, data: { ok: true, pending: peekTeamManageForRenderer() } as unknown };
    } catch (error) {
      console.warn('[Command EVE] team-manage-peek failed:', error);
      return { success: true, data: { ok: false, pending: null } as unknown };
    }
  });

  bridge.buildProvider('command-eve.team-manage-apply').provider(async (request?: { intent_id?: string }) => {
    try {
      const intentId = typeof request?.intent_id === 'string' ? request.intent_id : '';
      if (!intentId) return { success: false, msg: 'intent_id required', data: { ok: false } as unknown };
      const { applyTeamManageIntent } = await import('@process/commandEve/eveTeamManageMain');
      const result = await applyTeamManageIntent(intentId);
      return { success: true, data: result as unknown };
    } catch (error) {
      console.warn('[Command EVE] team-manage-apply failed:', error);
      return { success: true, data: { ok: false, reason: 'error' } as unknown };
    }
  });

  bridge.buildProvider('command-eve.team-manage-reject').provider(async (request?: { intent_id?: string }) => {
    try {
      const intentId = typeof request?.intent_id === 'string' ? request.intent_id : '';
      const { rejectTeamManageIntent } = await import('@process/commandEve/eveTeamManageMain');
      return { success: true, data: rejectTeamManageIntent(intentId) as unknown };
    } catch (error) {
      console.warn('[Command EVE] team-manage-reject failed:', error);
      return { success: true, data: { ok: false } as unknown };
    }
  });

  // COMPA-626 — Kanban-ACP confirm bridge (Design-B mirror of team-manage). The renderer
  // polls -peek for a pending kanban proposal, applies via -apply (the ONLY kanban.db
  // write), or dismisses via -reject. No kanban write happens on peek/reject.
  bridge.buildProvider('command-eve.kanban-acp-peek').provider(async () => {
    try {
      const { peekKanbanAcpForRenderer } = await import('@process/commandEve/kanbanAcpMain');
      return { success: true, data: { ok: true, pending: peekKanbanAcpForRenderer() } as unknown };
    } catch (error) {
      console.warn('[Command EVE] kanban-acp-peek failed:', error);
      return { success: true, data: { ok: false, pending: null } as unknown };
    }
  });

  bridge
    .buildProvider('command-eve.kanban-acp-apply')
    .provider(async (request?: { intent_id?: string; mutation_hash?: string }) => {
      // Codex re-audit: the confirmed write must be fenced during a seat switch, exactly
      // like the direct marketing-card mutation IPC — otherwise a confirm click mid-switch
      // could consume a seat-A intent and resolve getDataPath() against seat-B.
      const fenced = guardKanbanMutationDuringSwitch('command-eve-kanban-acp-apply/v0');
      if (fenced) return fenced;
      try {
        const intentId = typeof request?.intent_id === 'string' ? request.intent_id : '';
        const mutationHash = typeof request?.mutation_hash === 'string' ? request.mutation_hash : '';
        if (!intentId) return { success: false, msg: 'intent_id required', data: { ok: false } as unknown };
        const { applyKanbanAcpIntent } = await import('@process/commandEve/kanbanAcpMain');
        const result = await applyKanbanAcpIntent(intentId, mutationHash);
        return { success: true, data: result as unknown };
      } catch (error) {
        console.warn('[Command EVE] kanban-acp-apply failed:', error);
        return { success: true, data: { ok: false, reason: 'error' } as unknown };
      }
    });

  bridge.buildProvider('command-eve.kanban-acp-reject').provider(async (request?: { intent_id?: string }) => {
    try {
      const intentId = typeof request?.intent_id === 'string' ? request.intent_id : '';
      const { rejectKanbanAcpIntent } = await import('@process/commandEve/kanbanAcpMain');
      return { success: true, data: rejectKanbanAcpIntent(intentId) as unknown };
    } catch (error) {
      console.warn('[Command EVE] kanban-acp-reject failed:', error);
      return { success: true, data: { ok: false } as unknown };
    }
  });

  bridge.buildProvider('command-eve.company-brain-list').provider(async () => {
    try {
      const home = resolveActiveSeatHome(getDataPath()).hermesHome;
      // T4: fold any EVE-written note (write_file into entries/<id>.md) into
      // brain.json BEFORE listing, so opening the Company-Brain tab shows EVE's
      // fresh notes immediately. Best-effort + idempotent: never throws, never
      // rewrites an already-indexed entry.
      // F4 (HIGH): reconcile is an INDEX WRITE (it can adopt .md files into
      // brain.json). SKIP it while a seat switch is in flight — resolveActiveSeatHome
      // may already point at the target seat while the backend still re-spawns, so a
      // reconcile in this window could fold one seat's files into another's index.
      // Listing itself is a harmless read and still returns the (un-reconciled) index.
      if (!commandEveSwitchSeatInFlight) {
        reconcileUnindexedEntries(home);
      }
      // 1.6.2: list WITH per-entry fill state read from the bodies (filled +
      // body_mtime_ms, additive fields). The dialog's "leer / N von 10" chips
      // previously guessed from a renderer cache that starts empty on every
      // open — a fully filled brain rendered as 0/10 until each section was
      // clicked. The disk owns the fill truth, so it is computed here.
      const entries = listEntriesWithState(home);
      return { success: true, data: { ok: true, entries } as unknown };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE company-brain list failed.',
        data: { ok: false, reason_code: 'COMPANY_BRAIN_LIST_FAILED', entries: [] } as unknown,
      };
    }
  });

  // v1.4 T3: lazy single-body read. LIST stays index-only; the Settings UI pulls
  // ONE body on demand (open/edit) through here — the id is re-asserted inside the
  // store (readEntryBody → assertEntryId path-traversal guard) before it touches
  // disk. A missing/unreadable body reads as { ok:true, body:null } (an index slot
  // whose .md was lost is not an error); a crafted id throws → { ok:false }.
  bridge.buildProvider('command-eve.company-brain-read').provider(async (request?: { id?: string }) => {
    try {
      if (!request || typeof request.id !== 'string') {
        return {
          success: false,
          msg: 'COMPANY_BRAIN_READ_BAD_REQUEST',
          data: { ok: false, reason_code: 'COMPANY_BRAIN_READ_BAD_REQUEST', body: null } as unknown,
        };
      }
      const home = resolveActiveSeatHome(getDataPath()).hermesHome;
      const body = readEntryBody(home, request.id);
      return { success: true, data: { ok: true, body } as unknown };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE company-brain read failed.',
        data: { ok: false, reason_code: 'COMPANY_BRAIN_READ_FAILED', body: null } as unknown,
      };
    }
  });

  bridge
    .buildProvider('command-eve.company-brain-write')
    .provider(async (request?: { id?: string; kind?: string; title?: string; body?: string }) => {
      // F4 (HIGH): fence FIRST — refuse a brain write while a seat switch is in
      // flight so it can never land in the wrong seat's company-brain/.
      const fenced = guardBrainMutationDuringSwitch();
      if (fenced) return fenced;
      try {
        if (!request || typeof request.kind !== 'string' || typeof request.title !== 'string') {
          return {
            success: false,
            msg: 'COMPANY_BRAIN_WRITE_BAD_REQUEST',
            data: { ok: false, reason_code: 'COMPANY_BRAIN_WRITE_BAD_REQUEST' } as unknown,
          };
        }
        const seatHome = resolveActiveSeatHome(getDataPath());
        const home = seatHome.hermesHome;
        // COMPA-625: enforce the memory-boundary contract before the durable write. This
        // is a user-initiated write, so a rejection is surfaced (not silently skipped) —
        // the S3 hard floor stops a raw secret/health/finance from being persisted into
        // the per-client brain, and the seat check pins it to the active seat.
        const guard = enforceMemoryBoundary({
          operation: 'write',
          store: 'company-brain',
          activeSeatId: seatHome.seatId,
          targetSeatId: seatHome.seatId,
          payloadText: request.body ?? '',
        });
        if (!guard.ok) {
          return {
            success: false,
            msg: `COMPANY_BRAIN_WRITE_BOUNDARY_${guard.reasonCode}`,
            data: { ok: false, reason_code: `memory_boundary_${guard.reasonCode}` } as unknown,
          };
        }
        const result = upsertEntry(home, {
          id: request.id,
          kind: request.kind as CompanyBrainWriteKind, // upsertEntry re-validates against the write allowlist
          title: request.title,
          body: request.body ?? '',
          author: 'user',
          source: 'settings',
        });
        // F8 (MEDIUM): a 'brief'-kind edit must also refresh company-brain/brief.md
        // (the file the §SEAT stamp points the agent at) so it never diverges from
        // the brief entry. Best-effort — mirrorBriefBodyToFile never throws.
        if (result.ok && result.entry.kind === 'brief') {
          mirrorBriefBodyToFile(home, request.body ?? '');
        }
        return { success: result.ok, data: { ok: result.ok, entry: result.entry, created: result.created } as unknown };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE company-brain write failed.',
          data: { ok: false, reason_code: 'COMPANY_BRAIN_WRITE_FAILED' } as unknown,
        };
      }
    });

  bridge.buildProvider('command-eve.company-brain-remove').provider(async (request?: { id?: string }) => {
    // F4 (HIGH): fence FIRST — refuse a brain remove while a seat switch is in
    // flight so it can never delete from the wrong seat's company-brain/.
    const fenced = guardBrainMutationDuringSwitch();
    if (fenced) return fenced;
    try {
      if (!request || typeof request.id !== 'string') {
        return {
          success: false,
          msg: 'COMPANY_BRAIN_REMOVE_BAD_REQUEST',
          data: { ok: false, reason_code: 'COMPANY_BRAIN_REMOVE_BAD_REQUEST' } as unknown,
        };
      }
      const home = resolveActiveSeatHome(getDataPath()).hermesHome;
      const result = removeEntry(home, request.id);
      return { success: result.ok, data: { ok: result.ok, removed: result.removed } as unknown };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE company-brain remove failed.',
        data: { ok: false, reason_code: 'COMPANY_BRAIN_REMOVE_FAILED' } as unknown,
      };
    }
  });

  // v1.4 T5 — L3 SESSION-DIGEST writer. The renderer relay (useSessionDigestRelay)
  // hands us ONLY a conversation id when a turn goes quiet; here in main we fetch the
  // transcript (compact, loopback), summarize it with the LOCAL Ollama model, and
  // write ONE session_digest entry into the ACTIVE seat's Company Brain (stable id ⇒
  // re-digest replaces), then FIFO-prune. The heavy orchestration is the pure
  // runSessionDigest core; this handler only injects the real deps + fences. The run's
  // promise is stashed in commandEveSessionDigestInFlight so the seat-switch handler
  // can FLUSH (await) it before switching. Best-effort/fail-quiet: the outcome is
  // diagnostic; the relay ignores it. The FENCE (isSwitchInFlight) refuses a write
  // while a seat switch is in flight so a digest can never land in the wrong seat.
  bridge.buildProvider('command-eve.session-digest').provider(async (request?: { conversation_id?: string }) => {
    const conversationId = typeof request?.conversation_id === 'string' ? request.conversation_id : '';
    // Resolve the ACTIVE seat home ONCE, up front — the writer/prune close over it, so
    // even if a switch begins mid-run the write targets the home resolved at start; the
    // post-inference fence re-check then refuses the write if a switch is in flight.
    let home = '';
    let seatId = '';
    try {
      const seatHome = resolveActiveSeatHome(getDataPath());
      home = seatHome.hermesHome;
      seatId = seatHome.seatId;
    } catch {
      return {
        success: false,
        msg: 'SESSION_DIGEST_NO_SEAT',
        data: { ok: false, reason_code: 'SESSION_DIGEST_NO_SEAT', outcome: 'error' } as unknown,
      };
    }
    const deps: SessionDigestDeps = {
      isSwitchInFlight: () => commandEveSwitchSeatInFlight,
      fetchTranscript: (id, window) => fetchConversationTranscript(id, window),
      resolveTitle: (id) => fetchConversationTitle(id),
      generateDigest: (prompt) => generateLocalDigest(prompt),
      writeDigestEntry: ({ id, title, body, now }) => {
        // COMPA-625: a digest summarizes a transcript that could echo a raw secret the
        // model repeated. Gate the durable write with the S3 hard floor + seat check
        // before it lands in the per-seat brain. Best-effort — a rejected digest is
        // logged + skipped (no digest is an honest, safe outcome).
        const guard = enforceMemoryBoundary({
          operation: 'write',
          store: 'session-digest',
          activeSeatId: seatId,
          targetSeatId: seatId,
          payloadText: body,
        });
        if (!guard.ok) {
          console.warn('[Command EVE] 625 memory-boundary skipped session digest:', guard.reasonCode);
          return;
        }
        upsertSystemEntry(home, { id, kind: SESSION_DIGEST_KIND, title, body, author: 'eve', source: 'chat', now });
      },
      pruneDigests: () => pruneSessionDigests(home).pruned,
    };
    const run = runSessionDigest(deps, { conversationId });
    // Record for the pre-switch flush (keep only the most recent). Cleared when it
    // settles IF it is still the tracked run (a newer run supersedes it).
    commandEveSessionDigestInFlight = run;
    void run.finally(() => {
      if (commandEveSessionDigestInFlight === run) commandEveSessionDigestInFlight = null;
    });
    const result = await run;
    return {
      success: result.ok,
      msg: result.ok ? undefined : result.outcome,
      data: { ok: result.ok, outcome: result.outcome, id: result.id, pruned: result.pruned } as unknown,
    };
  });

  // On-device speech-to-text. Runs in the main process (which can spawn the bundled
  // venv python); the audio never reaches aioncore or any cloud STT — DSGVO-clean.
  bridge.buildProvider('command-eve.speech-to-text-local').provider(async (request?: CommandEveLocalSttRequest) => {
    try {
      if (!request) {
        return { success: false, msg: 'STT_LOCAL_NO_REQUEST' };
      }
      const data = await transcribeLocalSpeech(request, { userDataPath: getDataPath() });
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'STT_LOCAL_FAILED',
      };
    }
  });

  // Auto session-title (1.2.13): summarize the first task into a short 3-6 word
  // title using the bundled ON-DEVICE Gemma model (Ollama, local only — NEVER the
  // cloud/credits lane). Best-effort + fail-quiet: any error (Ollama not running,
  // model not pulled, timeout) returns ok:false so the renderer keeps the
  // truncated fallback title. Short timeout so a stuck local model never lingers.
  bridge
    .buildProvider('command-eve.generate-local-title')
    .provider(async (request?: { text?: string; locale?: 'de-DE' | 'en-US' }) => {
      const ollamaBaseUrl = 'http://127.0.0.1:11434';
      const TITLE_TIMEOUT_MS = 12_000;
      const text = String(request?.text || '').trim();
      if (!text) return { success: false, msg: 'TITLE_NO_TEXT', data: { ok: false } };

      const withTimeout = async (input: string, init: RequestInit): Promise<Response> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
        try {
          return await fetch(input, { ...init, signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      };

      try {
        // 1) Pick the bundled local model from Ollama's tag list. If Ollama is
        //    down or the model is not pulled, bail quietly (fallback title stays).
        const tagsRes = await withTimeout(`${ollamaBaseUrl}/api/tags`, { method: 'GET' });
        if (!tagsRes.ok) return { success: false, msg: 'TITLE_OLLAMA_TAGS', data: { ok: false } };
        const tagsJson = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
        const modelNames = (tagsJson.models || []).map((m) => String(m?.name || ''));
        const model = pickLocalTitleModel(modelNames);
        if (!model) return { success: false, msg: 'TITLE_NO_LOCAL_MODEL', data: { ok: false } };

        // 2) One-shot, NON-streaming local chat. num_predict is tiny — a title is
        //    a few tokens; keep the local model cheap and fast.
        const prompt = buildLocalTitlePrompt(text, request?.locale === 'en-US' ? 'en-US' : 'de-DE');
        const chatRes = await withTimeout(`${ollamaBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            messages: [{ role: 'user', content: prompt }],
            options: { num_predict: 24, temperature: 0.2 },
          }),
        });
        if (!chatRes.ok) return { success: false, msg: 'TITLE_OLLAMA_CHAT', data: { ok: false } };
        const chatJson = (await chatRes.json()) as { message?: { content?: string } };
        const title = sanitizeGeneratedTitle(chatJson.message?.content);
        if (!title) return { success: false, msg: 'TITLE_EMPTY', data: { ok: false } };
        return { success: true, data: { ok: true, title } };
      } catch (error) {
        // AbortError / network / JSON — stay quiet, keep the fallback title.
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'TITLE_LOCAL_FAILED',
          data: { ok: false },
        };
      }
    });

  // Cloud TTS (1.7.x multimodal seam): MAIN is the only process allowed to call
  // eve-multimodal with the CEVE license bearer. The renderer gets a sanitized
  // audio artifact and never sees the bearer, raw provider keys, or provider
  // response fields outside the desktop contract.
  bridge.buildProvider(COMMAND_EVE_MULTIMODAL_TTS_CONSENT_GET_CHANNEL).provider(async () => {
    const data = toCommandEveMultimodalTtsConsentBridgeResult(readCommandEveMultimodalTtsConsent(getDataPath()), true);
    return { success: true, data };
  });

  bridge
    .buildProvider(COMMAND_EVE_MULTIMODAL_TTS_CONSENT_SET_CHANNEL)
    .provider(
      async (
        request?:
          | CommandEveMultimodalTtsConsentSetRequest
          | CommandEveBridgeEnvelope<CommandEveMultimodalTtsConsentSetRequest>
      ) => {
        const payload = unwrapBridgeRequest<CommandEveMultimodalTtsConsentSetRequest>(request);
        const data = setCommandEveMultimodalTtsConsent(getDataPath(), payload);
        return {
          success: data.persisted === true,
          ...(data.persisted === true ? {} : { msg: 'EVE_MULTIMODAL_TTS_CONSENT_PERSIST_FAILED' }),
          data,
        };
      }
    );

  bridge
    .buildProvider('command-eve.multimodal-tts-status')
    .provider(
      async (
        request?:
          | CommandEveMultimodalTtsActivationStatusRequest
          | CommandEveBridgeEnvelope<CommandEveMultimodalTtsActivationStatusRequest>
      ) => {
        unwrapBridgeRequest<CommandEveMultimodalTtsActivationStatusRequest>(request);
        const consentState = readCommandEveMultimodalTtsConsent(getDataPath());
        const wireResult = readLicenseWire(getDataPath());
        const data = resolveCommandEveMultimodalTtsActivationStatus({
          privacyLane: consentState.privacyLane,
          desktopCloudEgressEnabled: COMMAND_EVE_MULTIMODAL_TTS_CLOUD_EGRESS_ENABLED,
          mainOwnedPrivacyConsentEnabled: evaluateCommandEveMultimodalTtsConsentAllowed(consentState),
          hasServerGateway: Boolean(EVE_MULTIMODAL_FUNCTION_URL) && COMMAND_EVE_MULTIMODAL_TTS_SERVER_GATEWAY_DEPLOYED,
          hasLicense: Boolean(wireResult.ok && wireResult.wire),
        });

        return {
          success: true,
          data,
        };
      }
    );

  bridge
    .buildProvider('command-eve.multimodal-tts')
    .provider(
      async (request?: CommandEveMultimodalTtsRequest | CommandEveBridgeEnvelope<CommandEveMultimodalTtsRequest>) => {
        const TTS_TIMEOUT_MS = 35_000;
        if (!COMMAND_EVE_MULTIMODAL_TTS_CLOUD_EGRESS_ENABLED) {
          const data = commandEveMultimodalTtsFailure(
            'EVE_MULTIMODAL_TTS_NOT_ENABLED',
            'Command EVE cloud TTS is disabled until a dedicated main-owned privacy gate enables it.'
          );
          return { success: false, msg: data.reason_code, data };
        }

        const payload = unwrapBridgeRequest<CommandEveMultimodalTtsRequest>(request);
        const consentState = readCommandEveMultimodalTtsConsent(getDataPath());
        if (!evaluateCommandEveMultimodalTtsConsentAllowed(consentState)) {
          const data = commandEveMultimodalTtsFailure(
            'EVE_MULTIMODAL_TTS_PRIVACY_CONSENT_REQUIRED',
            'Command EVE cloud TTS requires explicit main-owned privacy consent.'
          );
          return { success: false, msg: data.reason_code, data };
        }

        const built = buildCommandEveMultimodalTtsRequest({ ...payload, privacyLane: consentState.privacyLane });
        if (built.ok === false) {
          return { success: false, msg: built.reason_code, data: built };
        }

        const wireResult = readLicenseWire(getDataPath());
        const gate = resolveCommandEveMultimodalGate({
          provider: 'xai',
          capability: 'tts',
          privacyLane: built.privacyLane,
          hasServerGateway: Boolean(EVE_MULTIMODAL_FUNCTION_URL) && COMMAND_EVE_MULTIMODAL_TTS_SERVER_GATEWAY_DEPLOYED,
          hasLicense: Boolean(wireResult.ok && wireResult.wire),
          directProviderKeyPresentInDesktop: false,
        });

        if (gate.ok === false) {
          const data = commandEveMultimodalTtsFailure(gate.reason, gate.message);
          return { success: false, msg: gate.reason, data };
        }

        if (!wireResult.ok || !wireResult.wire) {
          const reason = wireResult.reason_code || 'EVE_MULTIMODAL_TTS_NO_BEARER';
          const data = commandEveMultimodalTtsFailure(reason);
          return { success: false, msg: reason, data };
        }

        const capturedSeatId = getActiveSeatId();
        const capturedSeatContextRevision = getActiveSeatContextRevision();
        const seatStillMatches = () =>
          getActiveSeatId() === capturedSeatId && getActiveSeatContextRevision() === capturedSeatContextRevision;
        const paidArtifactBlockReason = getCommandEvePaidArtifactBlockReason();
        if (paidArtifactBlockReason === 'seat_recovery_required') {
          const reason = 'EVE_MULTIMODAL_TTS_SEAT_RECOVERY_REQUIRED';
          const data = commandEveMultimodalTtsFailure(
            reason,
            'The previous Seat switch did not settle. Relaunch Command EVE before retrying cloud TTS.'
          );
          return { success: false, msg: reason, data };
        }
        if (paidArtifactBlockReason === 'seat_transition_in_progress') {
          const reason = 'EVE_MULTIMODAL_TTS_SEAT_TRANSITION_IN_PROGRESS';
          const data = commandEveMultimodalTtsFailure(reason, 'The active Seat is changing. Retry afterward.');
          return { success: false, msg: reason, data };
        }
        const releasePaidArtifactOperation = tryBeginCommandEvePaidArtifactOperation();
        if (!releasePaidArtifactOperation) {
          const reason = 'EVE_MULTIMODAL_TTS_SEAT_TRANSITION_IN_PROGRESS';
          const data = commandEveMultimodalTtsFailure(reason, 'The active Seat is changing. Retry afterward.');
          return { success: false, msg: reason, data };
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
        try {
          const response = await fetch(gate.functionUrl, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${wireResult.wire}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            redirect: 'error',
            cache: 'no-store',
            body: JSON.stringify({ ...built.body, ...commandEveMediaSeedAttribution(capturedSeatId) }),
            signal: controller.signal,
          });
          const responseText = await readCommandEveLimitedResponseText(
            response,
            COMMAND_EVE_MULTIMODAL_TTS_MAX_RESPONSE_BYTES
          );
          if (responseText.ok === false) {
            const data = commandEveMultimodalTtsFailure(responseText.reason_code);
            return { success: false, msg: data.reason_code, data };
          }
          if (!seatStillMatches()) {
            const reason = 'EVE_MULTIMODAL_TTS_SEAT_CHANGED';
            const data = commandEveMultimodalTtsFailure(reason, 'The active Seat changed before TTS completed.');
            return { success: false, msg: reason, data };
          }

          let raw: unknown = null;
          try {
            raw = JSON.parse(responseText.text);
          } catch {
            raw = null;
          }
          if (!response.ok) {
            const parsed = parseCommandEveMultimodalTtsResponse(
              raw,
              `EVE_MULTIMODAL_TTS_HTTP_${response.status}`,
              built.privacyLane
            );
            if (parsed.ok === false) {
              return {
                success: false,
                msg: parsed.reason_code,
                data: parsed,
              };
            }
            const data = commandEveMultimodalTtsFailure(`EVE_MULTIMODAL_TTS_HTTP_${response.status}`);
            return { success: false, msg: data.reason_code, data };
          }

          const parsed = parseCommandEveMultimodalTtsResponse(raw, 'EVE_MULTIMODAL_TTS_BAD_BODY', built.privacyLane);

          if (parsed.ok === true) {
            return {
              success: true,
              data: parsed,
            };
          }

          return {
            success: false,
            msg: parsed.reason_code,
            data: parsed,
          };
        } catch (error) {
          const errorName =
            error && typeof error === 'object' && 'name' in error ? String((error as { name?: unknown }).name) : '';
          const reason = errorName === 'AbortError' ? 'EVE_MULTIMODAL_TTS_TIMEOUT' : 'EVE_MULTIMODAL_TTS_FAILED';
          const data = commandEveMultimodalTtsFailure(reason);
          return {
            success: false,
            msg: reason,
            data,
          };
        } finally {
          clearTimeout(timer);
          releasePaidArtifactOperation();
        }
      }
    );

  // PDF intelligence (1.814): extract born-digital PDFs locally first. Only
  // scanned/image PDFs may cross the server-side OpenRouter OCR boundary, and
  // only after an explicit per-send renderer confirmation. MAIN owns the CEVE
  // bearer and PDF bytes; the renderer receives private sidecar paths/receipts.
  bridge
    .buildProvider('command-eve.pdf-prepare')
    .provider(async (request?: CommandEvePdfPrepareRequest | CommandEveBridgeEnvelope<CommandEvePdfPrepareRequest>) => {
      const payload = unwrapBridgeRequest<CommandEvePdfPrepareRequest>(request);
      const filePaths = Array.from(
        new Set(
          (Array.isArray(payload?.filePaths) ? payload.filePaths : []).filter((value) => typeof value === 'string')
        )
      );
      const readyDocuments: CommandEvePreparedPdfDocument[] = [];
      const preparedFiles = (): string[] => readyDocuments.map((document) => document.sidecar_path);
      const failure = (
        reasonCode: string,
        message?: string,
        options?: { requiresConsent?: boolean; pendingNames?: string[]; suppressDocuments?: boolean }
      ) => ({
        success: false,
        msg: reasonCode,
        data: {
          version: COMMAND_EVE_PDF_INTELLIGENCE_VERSION,
          ok: false as const,
          reason_code: reasonCode,
          ...(message ? { message } : {}),
          documents: options?.suppressDocuments === true ? [] : readyDocuments,
          prepared_files: options?.suppressDocuments === true ? [] : preparedFiles(),
          requires_cloud_ocr_consent: options?.requiresConsent === true,
          ...(options?.pendingNames?.length ? { pending_source_names: options.pendingNames } : {}),
        },
      });

      if (filePaths.length === 0 || filePaths.length > 5) {
        return failure('EVE_PDF_BAD_FILE_COUNT', 'Select between one and five PDF files per message.');
      }

      let capturedSeatId: string;
      let capturedSeatContextRevision: number;
      let hermesHome: string;
      const dataPath = getDataPath();
      try {
        capturedSeatId = getActiveSeatId();
        capturedSeatContextRevision = getActiveSeatContextRevision();
        hermesHome = resolveSeatHermesHome(dataPath, capturedSeatId);
      } catch {
        return failure('EVE_PDF_SEAT_UNAVAILABLE');
      }
      const seatStillMatches = (): boolean => {
        try {
          return getActiveSeatId() === capturedSeatId && getActiveSeatContextRevision() === capturedSeatContextRevision;
        } catch {
          return false;
        }
      };
      const seatChanged = () => failure('EVE_PDF_SEAT_CHANGED', undefined, { suppressDocuments: true });
      const localPreparations: LocalPdfPreparation[] = [];
      for (const filePath of filePaths) {
        try {
          const prepared = await prepareLocalPdf({
            filePath,
            hermesHome,
            isContextCurrent: seatStillMatches,
          });
          if (!seatStillMatches()) return seatChanged();
          localPreparations.push(prepared);
          if (!prepared.quality.requiresOcr || prepared.document.extraction_mode === 'cloud_ocr') {
            readyDocuments.push(prepared.document);
          }
        } catch (error) {
          const reasonCode =
            error instanceof CommandEvePdfPreparationError ? error.reasonCode : 'EVE_PDF_LOCAL_EXTRACTION_FAILED';
          if (reasonCode === 'EVE_PDF_SEAT_CHANGED') return seatChanged();
          return failure(reasonCode, error instanceof Error ? error.message.slice(0, 300) : undefined);
        }
      }

      const pending = localPreparations.filter(
        (prepared) => prepared.quality.requiresOcr && prepared.document.extraction_mode !== 'cloud_ocr'
      );
      if (pending.length > 0 && payload?.allowCloudOcr !== true) {
        return failure(
          'EVE_PDF_CLOUD_OCR_CONSENT_REQUIRED',
          'One or more PDFs contain too little reliable local text and require explicit cloud OCR consent.',
          {
            requiresConsent: true,
            pendingNames: pending.map((prepared) => prepared.document.source_name),
          }
        );
      }

      let releasePaidArtifactOperation: (() => void) | undefined;
      try {
        if (pending.length > 0) {
          if (!COMMAND_EVE_PDF_CLOUD_OCR_ENABLED) {
            return failure('EVE_PDF_CLOUD_OCR_NOT_ENABLED');
          }
          const privacyLane = payload?.privacyLane ?? 'cloud_auto';
          if (!seatStillMatches()) return seatChanged();
          const wireResult = readLicenseWire(dataPath);
          const gate = resolveCommandEveMultimodalGate({
            provider: 'openrouter',
            capability: 'document_ocr',
            privacyLane,
            hasServerGateway: Boolean(EVE_MULTIMODAL_FUNCTION_URL) && COMMAND_EVE_PDF_SERVER_GATEWAY_DEPLOYED,
            hasLicense: Boolean(wireResult.ok && wireResult.wire),
            directProviderKeyPresentInDesktop: false,
          });
          if (gate.ok === false) {
            return failure(`EVE_PDF_${gate.reason.toUpperCase().replace(/-/g, '_')}`, gate.message);
          }
          if (!wireResult.ok || !wireResult.wire) {
            return failure(wireResult.reason_code || 'EVE_PDF_NO_BEARER');
          }

          const paidArtifactBlockReason = getCommandEvePaidArtifactBlockReason();
          if (paidArtifactBlockReason === 'seat_recovery_required') {
            return failure(
              'EVE_PDF_SEAT_RECOVERY_REQUIRED',
              'The previous Seat switch did not settle. Relaunch Command EVE before retrying cloud OCR.',
              { suppressDocuments: true }
            );
          }
          if (paidArtifactBlockReason === 'seat_transition_in_progress') return seatChanged();
          releasePaidArtifactOperation = tryBeginCommandEvePaidArtifactOperation() ?? undefined;
          if (!releasePaidArtifactOperation) return seatChanged();
          for (const prepared of pending) {
            const built = buildCommandEvePdfOcrRequest({
              fileName: prepared.document.source_name,
              fileSha256: prepared.document.sha256,
              pageCount: prepared.document.page_count,
              fileDataBase64: Buffer.from(prepared.sourceBytes).toString('base64'),
              privacyLane,
              requestId: payload?.requestId,
            });
            if (built.ok === false) {
              return failure(built.reason_code, built.message);
            }
            if (!seatStillMatches()) return seatChanged();

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 90_000);
            try {
              const response = await fetch(gate.functionUrl, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${wireResult.wire}`,
                  'Content-Type': 'application/json',
                  Accept: 'application/json',
                },
                redirect: 'error',
                cache: 'no-store',
                body: JSON.stringify({ ...built.body, ...commandEveMediaSeedAttribution(capturedSeatId) }),
                signal: controller.signal,
              });
              const responseText = await readCommandEveLimitedResponseText(
                response,
                COMMAND_EVE_PDF_MAX_CLOUD_RESPONSE_BYTES
              );
              if (responseText.ok === false) {
                return failure('EVE_PDF_OCR_RESPONSE_TOO_LARGE');
              }
              let raw: unknown = null;
              try {
                raw = JSON.parse(responseText.text);
              } catch {
                raw = null;
              }
              const parsed = parseCommandEvePdfOcrResponse(raw);
              if (!response.ok || parsed.ok === false) {
                return failure(
                  parsed.ok === false ? parsed.reason_code : `EVE_PDF_OCR_HTTP_${response.status}`,
                  parsed.ok === false ? parsed.message : undefined
                );
              }
              const pages = parseCloudOcrMarkdownPages(parsed.data.artifact.text, parsed.data.document.page_count);
              const cloudDocument = persistPdfSidecar({
                hermesHome,
                sourcePath: prepared.document.source_path,
                sha256: prepared.document.sha256,
                bytes: prepared.document.bytes,
                pages,
                extractionMode: 'cloud_ocr',
                requiresOcr: false,
              });
              readyDocuments.push(cloudDocument);
            } catch (error) {
              const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
              return failure(name === 'AbortError' ? 'EVE_PDF_OCR_TIMEOUT' : 'EVE_PDF_OCR_FAILED');
            } finally {
              clearTimeout(timer);
            }
          }
        }

        // Re-read no source bytes and expose no cloud payload. The only files the
        // renderer adds to Hermes are private, deterministic Markdown sidecars.
        return {
          success: true,
          data: {
            version: COMMAND_EVE_PDF_INTELLIGENCE_VERSION,
            ok: true as const,
            documents: readyDocuments,
            prepared_files: preparedFiles(),
            cloud_ocr_used: readyDocuments.some((document) => document.extraction_mode === 'cloud_ocr'),
            requires_cloud_ocr_consent: false as const,
          },
        };
      } finally {
        releasePaidArtifactOperation?.();
      }
    });

  // Presentation intelligence is isolated from this already-large bridge.
  bridge.buildProvider('command-eve.presentation-prepare').provider(handleCommandEvePresentationPrepare);

  bridge.buildProvider('command-eve.image-prepare').provider(handleCommandEveImagePrepare);
  bridge.buildProvider('command-eve.video-generate').provider(handleCommandEveVideoGenerateBridge);
  bridge.buildProvider('command-eve.video-artifacts-list').provider((request?: { conversationId?: string }) =>
    handleCommandEveVideoArtifactsListBridge(request, {
      getDataPath,
      listArtifactRecords: listVideoArtifactRecords,
      hydrateBeforeList: (conversationId) => reconcileConversationNativeArtifacts(conversationId),
    })
  );
  // Turn-end hydration authority (MAT-1773 Package B): the reconcile relay
  // invokes this after a completed turn; the list above hydrates at load. Both
  // best-effort, idempotent and debit-free (the clip was already paid for).
  bridge.buildProvider('command-eve.video-artifact-hydrate').provider(async (request?: { conversationId?: string }) => {
    const conversationId = typeof request?.conversationId === 'string' ? request.conversationId : '';
    if (!conversationId) return { success: false, data: { ok: false, reason: 'invalid-request' } };
    const summary = await reconcileConversationNativeArtifacts(conversationId);
    return { success: true, data: { ok: true, summary: summary.video } };
  });
  // MAT-1753. The renderer asks what the seat may offer; it never decides.
  bridge.buildProvider('command-eve.video-capabilities').provider(handleCommandEveVideoCapabilitiesBridge);
  // MAT-1747. The envelope rides the turn the user was already sending, so it
  // has no side effect on the TRANSCRIPT; the edit below is the only spending
  // path and it accepts a capability handle, never an id. (MAT-1769: the same
  // call durably records THIS turn's attached images as read-only registry
  // entries for later turns — a local manifest write, never a transcript one.)
  bridge.buildProvider('command-eve.artifact-context-envelope').provider(handleCommandEveArtifactContextEnvelopeBridge);
  // A steer never builds an envelope, so this is the only place the outstanding
  // spend permit can be retired when the person corrects a run in flight.
  bridge.buildProvider('command-eve.artifact-turn-steer').provider(handleCommandEveArtifactTurnSteerBridge);
  bridge.buildProvider('command-eve.video-edit').provider(handleCommandEveVideoEditBridge);
  bridge.buildProvider('command-eve.image-generate').provider((request?: CommandEveImageGenerateRequest) =>
    handleCommandEveImageGenerateBridge(request, {
      getDataPath,
      getActiveSeatId,
      getActiveSeatContextRevision,
      onFreshBind: (conversationId) => getImageArtifactsChangedEmitter().emit({ conversation_id: conversationId }),
    })
  );
  // 1.820.3 — the managed IMAGE artifact lane (staged-handle contract): bind
  // (display authority at turn end), list + preview (durable, path-free),
  // legacy import (strictly confined one-time adoption).
  // Same-turn insertion authority: a FRESH bind — from ANY lane (finish fast
  // path, list-reconcile, turn-end reconcile, manual) — emits the renderer
  // event the artifact provider listens to. Renderer-side turn events have
  // proven unreliable here; the store-level bind cannot be missed.
  bridge
    .buildProvider('command-eve.image-artifact-bind')
    .provider((request?: { conversationId?: string; handle?: string; toolCallId?: string }) =>
      handleCommandEveImageArtifactBindBridge(request, {
        getDataPath,
        getActiveSeatId,
        onFreshBind: (conversationId) => getImageArtifactsChangedEmitter().emit({ conversation_id: conversationId }),
      })
    );
  bridge.buildProvider('command-eve.image-artifacts-list').provider((request?: { conversationId?: string }) =>
    handleCommandEveImageArtifactsListBridge(request, {
      getDataPath,
      getActiveSeatId,
      getActiveSeatContextRevision,
      reconcileBeforeList: (conversationId, expectedSeatId, expectedSeatContextRevision) =>
        reconcileImageArtifactBindsForConversation(conversationId, expectedSeatId, expectedSeatContextRevision),
    })
  );
  // Durable re-bind authority: the turnCompleted relay invokes this at turn
  // end; the list above reconciles at load. Both are best-effort, idempotent
  // and debit-free (binding flips display state only).
  bridge
    .buildProvider('command-eve.image-artifact-reconcile')
    .provider(async (request?: { conversationId?: string }) => {
      const conversationId = typeof request?.conversationId === 'string' ? request.conversationId : '';
      if (!conversationId) return { success: false, data: { ok: false, reason: 'invalid-request' } };
      const summary = await reconcileImageArtifactBindsForConversation(conversationId);
      return { success: true, data: { ok: true, summary } };
    });
  bridge.buildProvider('command-eve.image-artifact-preview').provider(handleCommandEveImageArtifactPreviewBridge);
  bridge
    .buildProvider('command-eve.image-artifact-import-legacy')
    .provider(handleCommandEveImageArtifactImportLegacyBridge);

  bridge.buildProvider('command-eve.cloud-visual-policy-read').provider(async () => {
    const policy = await readCommandEveCloudVisualPolicy();
    return { success: policy.status !== 'unavailable', data: policy };
  });

  bridge
    .buildProvider('command-eve.cloud-visual-policy-receipt')
    .provider(async (request?: CommandEveCloudVisualPolicyReceiptRequest) => {
      const result = await issueCommandEveCloudVisualPolicyReceipt(request?.flowId ?? '');
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.policy.reason,
        data: result,
      };
    });

  bridge
    .buildProvider('command-eve.cloud-visual-policy-set')
    .provider(async (request?: CommandEveCloudVisualPolicyMutationRequest) => {
      const result = request
        ? await setCommandEveCloudVisualPolicy(request)
        : { ok: false, policy: await readCommandEveCloudVisualPolicy() };
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.policy.reason,
        data: result,
      };
    });

  // MAT-1769 — the seat's image model preference. Same Main-authoritative seat
  // discipline as the cloud visual policy: the renderer never names a target
  // seat, and a mutation carries expectedSeatId only as a stale-action fence.
  bridge.buildProvider('command-eve.image-model-preference-read').provider(async () => {
    const preference = await readCommandEveImageModelPreference();
    return { success: preference.status === 'resolved', data: preference };
  });

  bridge.buildProvider('command-eve.image-model-preference-set').provider(async (request?: unknown) => {
    if (!isCommandEveImageModelPreferenceMutationRequest(request)) {
      const preference = await readCommandEveImageModelPreference();
      return { success: false, msg: 'malformed_request', data: { ok: false, preference } };
    }
    const result = await setCommandEveImageModelPreference(request);
    return {
      success: result.ok,
      msg: result.ok ? undefined : result.preference.status === 'unavailable' ? result.preference.reason : 'mismatch',
      data: result,
    };
  });

  // MAT-1769 — the SERVER-OWNED image model registry, answered by Main through
  // the non-billable capabilities surface. Fail-closed by construction: any
  // fetch/parse failure is success:false with the reason, and the renderer
  // shows "price unavailable" — there is no client-side fallback rate table.
  bridge.buildProvider('command-eve.image-capabilities').provider(async () => {
    const result = await readCommandEveImageModelRegistry();
    if (!result.ok) {
      return { success: false, msg: result.reason, data: result };
    }
    return { success: true, data: result };
  });

  bridge
    .buildProvider('command-eve.managed-visual-turn-authorize')
    .provider(async (request?: CommandEveManagedVisualTurnAuthorizationRequest) => {
      const userDataPath = getDataPath();
      const seatId = getActiveSeatId();
      const seatContextRevision = getActiveSeatContextRevision();
      const receipt = verifyCommandEveCloudVisualPolicyReceipt(request?.visualPolicyReceipt, request?.flowId ?? '');
      const policy = receipt.ok ? await readCommandEveCloudVisualPolicy() : undefined;
      const freshReceipt =
        receipt.ok &&
        receipt.seatId === seatId &&
        receipt.seatContextRevision === seatContextRevision &&
        policy?.status === 'enabled' &&
        policy.seatId === seatId
          ? {
              seatId: receipt.seatId,
              seatContextRevision: receipt.seatContextRevision,
              flowId: receipt.flowId,
              receiptId: request?.visualPolicyReceipt?.receiptId ?? '',
            }
          : undefined;
      const entitlement = getEntitlementStatus({ userDataPath });
      const wire = readLicenseWire(userDataPath);
      const seatStillMatches = getActiveSeatId() === seatId && getActiveSeatContextRevision() === seatContextRevision;
      const result = authorizeCommandEveManagedVisualTurn({
        request,
        seatId,
        seatContextRevision,
        verifiedReceipt: seatStillMatches ? freshReceipt : undefined,
        hasPaidSeat: entitlement.state === 'entitled' && entitlement.has_paid_seat === true,
        hasLicenseWire: wire.ok && Boolean(wire.wire),
        retireVerifiedReceipt: () =>
          Boolean(
            receipt.ok &&
            freshReceipt &&
            request?.visualPolicyReceipt &&
            retireCommandEveCloudVisualPolicyReceipt(request.visualPolicyReceipt, request.flowId ?? '', receipt)
          ),
      });
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code || result.message,
        data: result,
      };
    });

  bridge.buildProvider('command-eve.kanban-preflight').provider(async (request?: { boardSlug?: string }) => {
    try {
      const result = runKanbanPreflight({
        userDataPath: getDataPath(),
        boardSlug: request?.boardSlug,
      });
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code || result.message,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE Kanban preflight bridge failed.',
        data: {
          version: 'command-eve-kanban-preflight/v0',
          ok: false,
          status: 'failed',
          reason_code: 'KANBAN_PREFLIGHT_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : 'Command EVE Kanban preflight bridge failed.',
          source: {
            generated_by: 'command-eve-kanban-preflight-core',
          },
        },
      };
    }
  });

  bridge.buildProvider('command-eve.kanban-marketing-board').provider(async (request?: { boardSlug?: string }) => {
    try {
      const result = buildKanbanMarketingBoard({
        userDataPath: getDataPath(),
        boardSlug: request?.boardSlug,
      });
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code || result.message,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE marketing Kanban bridge failed.',
        data: {
          version: 'command-eve-kanban-marketing-board/v0',
          ok: false,
          status: 'failed',
          reason_code: 'KANBAN_MARKETING_BOARD_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : 'Command EVE marketing Kanban bridge failed.',
          source: {
            generated_by: 'command-eve-kanban-marketing-board-core',
            hermes_home: '',
          },
        },
      };
    }
  });

  bridge
    .buildProvider('command-eve.kanban-marketing-proof-card')
    .provider(async (request?: { boardSlug?: string; eventLedgerPath?: string }) => {
      const fenced = guardKanbanMutationDuringSwitch('command-eve-kanban-marketing-proof-card/v0');
      if (fenced) return fenced;
      try {
        const result = createKanbanMarketingProofCard({
          userDataPath: getDataPath(),
          boardSlug: request?.boardSlug,
          eventLedgerPath: request?.eventLedgerPath,
        });
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reason_code || result.message,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE marketing proof-card bridge failed.',
          data: {
            version: 'command-eve-kanban-marketing-proof-card/v0',
            ok: false,
            status: 'failed',
            reason_code: 'KANBAN_MARKETING_PROOF_CARD_BRIDGE_FAILED',
            message: error instanceof Error ? error.message : 'Command EVE marketing proof-card bridge failed.',
            source: {
              generated_by: 'command-eve-kanban-marketing-board-core',
              hermes_home: '',
            },
          },
        };
      }
    });

  bridge
    .buildProvider('command-eve.kanban-marketing-card-create')
    .provider(
      async (request?: {
        title?: string;
        description?: string;
        lane_key?: string;
        client_token?: string;
        expectedSeatId?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
      }) => {
        const fenced = guardKanbanMutationDuringSwitch('command-eve-kanban-marketing-card-create/v0');
        if (fenced) return fenced;
        if (request?.expectedSeatId && request.expectedSeatId !== getActiveSeatId()) {
          return {
            success: false,
            msg: 'SEAT_CONTEXT_CHANGED',
            data: {
              version: 'command-eve-kanban-marketing-card-create/v0',
              ok: false,
              status: 'blocked',
              reason_code: 'SEAT_CONTEXT_CHANGED',
              message: 'The active seat changed before the marketing card could be created.',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
        try {
          const result = createKanbanMarketingCard({
            userDataPath: getDataPath(),
            title: request?.title || '',
            description: request?.description,
            lane_key: request?.lane_key || '',
            client_token: request?.client_token || '',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE marketing card-create bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-card-create/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_CARD_CREATE_BRIDGE_FAILED',
              message: error instanceof Error ? error.message : 'Command EVE marketing card-create bridge failed.',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-card-move')
    .provider(
      async (request?: { task_id?: string; to_lane_key?: string; boardSlug?: string; eventLedgerPath?: string }) => {
        const fenced = guardKanbanMutationDuringSwitch('command-eve-kanban-marketing-card-move/v0');
        if (fenced) return fenced;
        try {
          const result = moveKanbanMarketingCard({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            to_lane_key: request?.to_lane_key || '',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE marketing card-move bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-card-move/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_CARD_MOVE_BRIDGE_FAILED',
              message: error instanceof Error ? error.message : 'Command EVE marketing card-move bridge failed.',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-card-action')
    .provider(
      async (request?: {
        task_id?: string;
        action?: 'comment' | 'block' | 'unblock' | 'complete';
        comment?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
      }) => {
        const fenced = guardKanbanMutationDuringSwitch('command-eve-kanban-marketing-card-action/v0');
        if (fenced) return fenced;
        try {
          const result = applyKanbanMarketingCardAction({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            action: request?.action || 'comment',
            comment: request?.comment,
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE marketing card-action bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-card-action/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_CARD_ACTION_BRIDGE_FAILED',
              message: error instanceof Error ? error.message : 'Command EVE marketing card-action bridge failed.',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-dispatch-plan')
    .provider(
      async (request?: {
        task_id?: string;
        command?: 'decompose' | 'specify';
        expectedSeatId?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
      }) => {
        const fenced = guardKanbanMutationDuringSwitch('command-eve-kanban-marketing-dispatch-plan/v0');
        if (fenced) return fenced;
        if (request?.expectedSeatId && request.expectedSeatId !== getActiveSeatId()) {
          return {
            success: false,
            msg: 'SEAT_CONTEXT_CHANGED',
            data: {
              version: 'command-eve-kanban-marketing-dispatch-plan/v0',
              ok: false,
              status: 'blocked',
              reason_code: 'SEAT_CONTEXT_CHANGED',
              reason_codes: ['SEAT_CONTEXT_CHANGED'],
              message: 'The active seat changed before the marketing dispatch plan could be recorded.',
              subprocess_spawned: false,
              data_boundary_checked: false,
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
        try {
          const result = planKanbanMarketingCardDispatch({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            command: request?.command,
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE marketing dispatch-plan bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-dispatch-plan/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_DISPATCH_PLAN_BRIDGE_FAILED',
              reason_codes: ['KANBAN_MARKETING_DISPATCH_PLAN_BRIDGE_FAILED'],
              message: error instanceof Error ? error.message : 'Command EVE marketing dispatch-plan bridge failed.',
              subprocess_spawned: false,
              data_boundary_checked: false,
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-dispatch-approval')
    .provider(
      async (request?: {
        task_id?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
        dispatch_handoff_packet?: Record<string, unknown>;
        review_note?: string;
      }) => {
        try {
          const result = recordKanbanMarketingDispatchApproval({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
            dispatch_handoff_packet: request?.dispatch_handoff_packet,
            review_note: request?.review_note,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE marketing dispatch-approval bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-dispatch-approval/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_DISPATCH_APPROVAL_BRIDGE_FAILED',
              message:
                error instanceof Error ? error.message : 'Command EVE marketing dispatch-approval bridge failed.',
              subprocess_spawned: false,
              release_blocked: true,
              human_gate: 'HG-2.5',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-dispatch-decision')
    .provider(
      async (request?: {
        task_id?: string;
        decision?: 'approved' | 'rejected';
        boardSlug?: string;
        eventLedgerPath?: string;
        dispatch_handoff_packet?: Record<string, unknown>;
        decision_note?: string;
      }) => {
        try {
          const result = recordKanbanMarketingDispatchDecision({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            decision: request?.decision === 'rejected' ? 'rejected' : 'approved',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
            dispatch_handoff_packet: request?.dispatch_handoff_packet,
            decision_note: request?.decision_note,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE marketing dispatch-decision bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-dispatch-decision/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_DISPATCH_DECISION_BRIDGE_FAILED',
              message:
                error instanceof Error ? error.message : 'Command EVE marketing dispatch-decision bridge failed.',
              controller_approved: false,
              subprocess_spawned: false,
              release_blocked: true,
              human_gate: 'HG-2.5',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-draft-generate')
    .provider(
      async (request?: {
        task_id?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
        dispatch_handoff_packet?: Record<string, unknown>;
        generation_note?: string;
      }) => {
        try {
          const result = generateKanbanMarketingDraft({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
            dispatch_handoff_packet: request?.dispatch_handoff_packet,
            generation_note: request?.generation_note,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE marketing draft-generate bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-draft-generate/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_DRAFT_GENERATE_BRIDGE_FAILED',
              reason_codes: ['KANBAN_MARKETING_DRAFT_GENERATE_BRIDGE_FAILED'],
              message: error instanceof Error ? error.message : 'Command EVE marketing draft-generate bridge failed.',
              subprocess_spawned: false,
              data_boundary_checked: false,
              controller_approved: false,
              release_blocked: true,
              human_gate: 'HG-2.5',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  // v15 gated marketing-executor LADDER handlers (additive, fail-closed)
  bridge
    .buildProvider('command-eve.kanban-marketing-output-approve')
    .provider(
      async (request?: {
        task_id?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
        dispatch_handoff_packet?: Record<string, unknown>;
        approval_note?: string;
      }) => {
        try {
          const result = approveKanbanMarketingOutput({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
            dispatch_handoff_packet: request?.dispatch_handoff_packet,
            approval_note: request?.approval_note,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE marketing output-approve bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-output-approve/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_OUTPUT_APPROVE_BRIDGE_FAILED',
              reason_codes: ['KANBAN_MARKETING_OUTPUT_APPROVE_BRIDGE_FAILED'],
              message: error instanceof Error ? error.message : 'Command EVE marketing output-approve bridge failed.',
              subprocess_spawned: false,
              data_boundary_checked: false,
              controller_approved: false,
              release_blocked: true,
              human_gate: 'HG-2.5',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-worker-dispatch-request')
    .provider(
      async (request?: {
        task_id?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
        dispatch_handoff_packet?: Record<string, unknown>;
        request_note?: string;
      }) => {
        try {
          const result = requestKanbanMarketingWorkerDispatch({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
            dispatch_handoff_packet: request?.dispatch_handoff_packet,
            request_note: request?.request_note,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg:
              error instanceof Error ? error.message : 'Command EVE marketing worker-dispatch-request bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-worker-dispatch-request/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_WORKER_DISPATCH_REQUEST_BRIDGE_FAILED',
              reason_codes: ['KANBAN_MARKETING_WORKER_DISPATCH_REQUEST_BRIDGE_FAILED'],
              message:
                error instanceof Error ? error.message : 'Command EVE marketing worker-dispatch-request bridge failed.',
              subprocess_spawned: false,
              data_boundary_checked: false,
              controller_approved: false,
              release_blocked: true,
              human_gate: 'HG-2.5',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-worker-observed-run')
    .provider(
      async (request?: {
        task_id?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
        dispatch_handoff_packet?: Record<string, unknown>;
        observed_note?: string;
      }) => {
        try {
          const result = runKanbanMarketingWorkerObserved({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
            dispatch_handoff_packet: request?.dispatch_handoff_packet,
            observed_note: request?.observed_note,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE marketing worker-observed-run bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-worker-observed-run/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_WORKER_OBSERVED_RUN_BRIDGE_FAILED',
              reason_codes: ['KANBAN_MARKETING_WORKER_OBSERVED_RUN_BRIDGE_FAILED'],
              message:
                error instanceof Error ? error.message : 'Command EVE marketing worker-observed-run bridge failed.',
              subprocess_spawned: false,
              external_calls: false,
              data_boundary_checked: false,
              controller_approved: false,
              release_blocked: true,
              human_gate: 'HG-2.5',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-worker-start-gate')
    .provider(
      async (request?: {
        task_id?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
        dispatch_handoff_packet?: Record<string, unknown>;
        gate_note?: string;
        executor_enabled?: boolean;
        executor_profile?: Record<string, unknown>;
      }) => {
        try {
          const result = checkKanbanMarketingWorkerStartGate({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
            dispatch_handoff_packet: request?.dispatch_handoff_packet,
            gate_note: request?.gate_note,
            executor_enabled: request?.executor_enabled === true,
            executor_profile: request?.executor_profile,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE marketing worker-start-gate bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-worker-start-gate/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_WORKER_START_GATE_BRIDGE_FAILED',
              reason_codes: ['KANBAN_MARKETING_WORKER_START_GATE_BRIDGE_FAILED'],
              message:
                error instanceof Error ? error.message : 'Command EVE marketing worker-start-gate bridge failed.',
              subprocess_spawned: false,
              external_calls: false,
              data_boundary_checked: false,
              controller_approved: false,
              release_blocked: true,
              human_gate: 'HG-3',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-worker-dispatcher-prepare')
    .provider(
      async (request?: {
        task_id?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
        dispatch_handoff_packet?: Record<string, unknown>;
        prepare_note?: string;
      }) => {
        try {
          const result = prepareKanbanMarketingWorkerDispatcher({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
            dispatch_handoff_packet: request?.dispatch_handoff_packet,
            prepare_note: request?.prepare_note,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg:
              error instanceof Error ? error.message : 'Command EVE marketing worker-dispatcher-prepare bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-worker-dispatcher-prepare/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_WORKER_DISPATCHER_PREPARE_BRIDGE_FAILED',
              reason_codes: ['KANBAN_MARKETING_WORKER_DISPATCHER_PREPARE_BRIDGE_FAILED'],
              message:
                error instanceof Error
                  ? error.message
                  : 'Command EVE marketing worker-dispatcher-prepare bridge failed.',
              subprocess_spawned: false,
              external_calls: false,
              data_boundary_checked: false,
              controller_approved: false,
              release_blocked: true,
              human_gate: 'HG-3.5',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge
    .buildProvider('command-eve.kanban-marketing-worker-executor-promotion')
    .provider(
      async (request?: {
        task_id?: string;
        boardSlug?: string;
        eventLedgerPath?: string;
        dispatch_handoff_packet?: Record<string, unknown>;
        promotion_note?: string;
        cao_gate_approved?: boolean;
      }) => {
        try {
          const result = promoteKanbanMarketingWorkerExecutor({
            userDataPath: getDataPath(),
            task_id: request?.task_id || '',
            boardSlug: request?.boardSlug,
            eventLedgerPath: request?.eventLedgerPath,
            dispatch_handoff_packet: request?.dispatch_handoff_packet,
            promotion_note: request?.promotion_note,
            cao_gate_approved: request?.cao_gate_approved === true,
          });
          return {
            success: result.ok,
            msg: result.ok ? undefined : result.reason_code || result.message,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            msg:
              error instanceof Error ? error.message : 'Command EVE marketing worker-executor-promotion bridge failed.',
            data: {
              version: 'command-eve-kanban-marketing-worker-executor-promotion/v0',
              ok: false,
              status: 'failed',
              reason_code: 'KANBAN_MARKETING_WORKER_EXECUTOR_PROMOTION_BRIDGE_FAILED',
              reason_codes: ['KANBAN_MARKETING_WORKER_EXECUTOR_PROMOTION_BRIDGE_FAILED'],
              message:
                error instanceof Error
                  ? error.message
                  : 'Command EVE marketing worker-executor-promotion bridge failed.',
              subprocess_spawned: false,
              external_calls: false,
              data_boundary_checked: false,
              controller_approved: false,
              release_blocked: true,
              human_gate: 'HG-3.5',
              source: {
                generated_by: 'command-eve-kanban-marketing-board-core',
                hermes_home: '',
              },
            },
          };
        }
      }
    );

  bridge.buildProvider('command-eve.crm-overlay').provider(async (request?: { eventLedgerPath?: string }) => {
    try {
      const result = buildCrmOverlay({
        userDataPath: getDataPath(),
        eventLedgerPath: request?.eventLedgerPath,
      });
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code || result.message,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE CRM overlay bridge failed.',
        data: {
          version: 'command-eve-crm-overlay/v0',
          ok: false,
          status: 'failed',
          reason_code: 'CRM_OVERLAY_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : 'Command EVE CRM overlay bridge failed.',
          source: {
            generated_by: 'command-eve-crm-overlay-core',
            hermes_home: '',
          },
        },
      };
    }
  });

  bridge
    .buildProvider('command-eve.crm-overlay-initialize')
    .provider(async (request?: { eventLedgerPath?: string }) => {
      try {
        const result = initializeCrmOverlay({
          userDataPath: getDataPath(),
          eventLedgerPath: request?.eventLedgerPath,
        });
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reason_code || result.message,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE CRM overlay initialize bridge failed.',
          data: {
            version: 'command-eve-crm-overlay-initialize/v0',
            ok: false,
            status: 'failed',
            reason_code: 'CRM_OVERLAY_INITIALIZE_BRIDGE_FAILED',
            message: error instanceof Error ? error.message : 'Command EVE CRM overlay initialize bridge failed.',
            source: {
              generated_by: 'command-eve-crm-overlay-core',
              hermes_home: '',
            },
          },
        };
      }
    });

  bridge.buildProvider('command-eve.crm-draft-create').provider(async (request?: { eventLedgerPath?: string }) => {
    try {
      const result = createCrmDraftDeal({
        userDataPath: getDataPath(),
        eventLedgerPath: request?.eventLedgerPath,
      });
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code || result.message,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE CRM draft create bridge failed.',
        data: {
          version: 'command-eve-crm-draft-create/v0',
          ok: false,
          status: 'failed',
          reason_code: 'CRM_DRAFT_CREATE_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : 'Command EVE CRM draft create bridge failed.',
          source: {
            generated_by: 'command-eve-crm-overlay-core',
            hermes_home: '',
          },
        },
      };
    }
  });

  bridge
    .buildProvider('command-eve.crm-stage-local')
    .provider(async (request?: { dealId?: string; targetStage?: 'qualified'; eventLedgerPath?: string }) => {
      try {
        const result = changeCrmDealStageLocal(
          {
            userDataPath: getDataPath(),
            eventLedgerPath: request?.eventLedgerPath,
          },
          {
            dealId: request?.dealId || '',
            targetStage: request?.targetStage || 'qualified',
          }
        );
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reason_code || result.message,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE CRM local stage bridge failed.',
          data: {
            version: 'command-eve-crm-stage-local/v0',
            ok: false,
            status: 'failed',
            reason_code: 'CRM_STAGE_LOCAL_BRIDGE_FAILED',
            message: error instanceof Error ? error.message : 'Command EVE CRM local stage bridge failed.',
            source: {
              generated_by: 'command-eve-crm-overlay-core',
              hermes_home: '',
            },
          },
        };
      }
    });

  bridge
    .buildProvider('command-eve.crm-consent-local')
    .provider(async (request?: { dealId?: string; eventLedgerPath?: string }) => {
      try {
        const result = captureCrmConsentLocal(
          {
            userDataPath: getDataPath(),
            eventLedgerPath: request?.eventLedgerPath,
          },
          {
            dealId: request?.dealId || '',
          }
        );
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reason_code || result.message,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE CRM local consent bridge failed.',
          data: {
            version: 'command-eve-crm-consent-local/v0',
            ok: false,
            status: 'failed',
            reason_code: 'CRM_CONSENT_LOCAL_BRIDGE_FAILED',
            message: error instanceof Error ? error.message : 'Command EVE CRM local consent bridge failed.',
            source: {
              generated_by: 'command-eve-crm-overlay-core',
              hermes_home: '',
            },
          },
        };
      }
    });

  // -------------------------------------------------------------------------
  // Registration + license gate (W11). Registration PII is S2, stored LOCAL
  // ONLY in userData and never returned beyond the renderer that submitted it.
  // -------------------------------------------------------------------------

  bridge.buildProvider('command-eve.entitlement-status').provider(async () => {
    try {
      const result = getEntitlementStatus({ userDataPath: getDataPath() });
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code || result.message,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE entitlement status bridge failed.',
        data: {
          version: COMMAND_EVE_ENTITLEMENT_BRIDGE_VERSION,
          ok: false,
          required: true,
          state: 'unconfigured',
          reason_code: 'ENTITLEMENT_STATUS_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : 'Command EVE entitlement status bridge failed.',
        },
      };
    }
  });

  bridge
    .buildProvider('command-eve.entitlement-register')
    .provider(async (request?: { name?: string; company?: string; email?: string; consent?: boolean }) => {
      try {
        const result = registerTenant(
          {
            name: request?.name || '',
            company: request?.company || '',
            email: request?.email || '',
            consent: request?.consent === true,
          },
          { userDataPath: getDataPath() }
        );
        if (result.ok) void syncRegistrationIdentityArtifactsBestEffort(getDataPath());
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reason_code || result.message,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE entitlement register bridge failed.',
          data: {
            version: COMMAND_EVE_ENTITLEMENT_BRIDGE_VERSION,
            ok: false,
            reason_code: 'ENTITLEMENT_REGISTER_BRIDGE_FAILED',
            message: error instanceof Error ? error.message : 'Command EVE entitlement register bridge failed.',
          },
        };
      }
    });

  bridge.buildProvider('command-eve.entitlement-activate').provider(async (request?: { code?: string }) => {
    try {
      const code = request?.code || '';
      const result = activateEntitlement({ code }, { userDataPath: getDataPath() });
      // On a successful activation, persist the RAW wire string (keychain at
      // rest, fail-closed) so the EVE Inference cloud lane has a bearer
      // credential. We never return the raw wire to the renderer. A keychain
      // failure here does not fail the activation (the gate already unlocked on
      // the verified payload) — it just means EVE Inference cloud is
      // unavailable until re-activation on a keychain-capable host.
      if (result.ok) {
        try {
          storeLicenseWire(getDataPath(), code);
        } catch {
          // Non-fatal: never let wire persistence break the gate.
        }
      }
      return {
        success: result.ok,
        msg: result.ok ? undefined : (result.reason_code as string) || result.message,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE entitlement activate bridge failed.',
        data: {
          version: COMMAND_EVE_ENTITLEMENT_BRIDGE_VERSION,
          ok: false,
          reason_code: 'ENTITLEMENT_ACTIVATE_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : 'Command EVE entitlement activate bridge failed.',
        },
      };
    }
  });

  // Presence-only: tells the renderer whether the EVE Inference cloud lane has
  // a usable bearer credential. NEVER returns the raw wire string — the EVE
  // Inference client is built in the main process (see eveInferenceCore +
  // ClientFactory), so the renderer only needs to know "available or not".
  bridge.buildProvider('command-eve.license-wire-status').provider(async () => {
    try {
      const available = hasLicenseWire(getDataPath());
      return { success: true, data: { available } };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE license-wire status bridge failed.',
        data: { available: false },
      };
    }
  });

  // -------------------------------------------------------------------------
  // THE MAX VISUAL AUTHORITY. The renderer asks; MAIN decides.
  //
  // This answers exactly one question — "would the shim send `max` for the ACTIVE
  // seat right now?" — using resolveEveCloudRouteFromBackend, which is the SAME
  // resolver `buildCommandEveShimRoutingResolver` hands to the real shim. It owns
  // the lane-state read and the non-brick clamp, so the answer here and the tier
  // on the wire come from one computation, not two that happen to agree.
  //
  // The receipt is SEAT-BOUND: it carries the seat id and that seat's context
  // revision, read BEFORE the await on resolveEveCloudRouteFromBackend — so the
  // receipt names the seat the decision was STARTED for. A seat switch during the
  // await therefore leaves the receipt naming the OLD seat, which is what the
  // renderer's comparison against the independently-read CURRENT context detects;
  // it refuses to paint on any mismatch (see shouldPaintMaxSurface).
  //
  // This paragraph said "read AFTER the decision" until 1.820.1. It was simply
  // false — both reads sit above the await, in their own try/catch blocks — and it
  // described a WEAKER design than the code implements: reading them after the
  // await would stamp the receipt with the seat that is current at completion, and
  // a mid-flight switch would then look consistent. The code was right; the
  // sentence was not.
  //
  // Any failure returns success:false with maxActive:false — the renderer fails
  // visually closed to the unnamed default. Not painting is always safe.
  // -------------------------------------------------------------------------
  // THE INDEPENDENT CURRENT SEAT CONTEXT.
  //
  // Deliberately a SEPARATE channel from the lane decision. The renderer needs a
  // CURRENT revision to compare the receipt's revision against, and taking both
  // from one payload would be comparing a value to itself — which is what the
  // previous "staleness check" actually did. Two reads, taken at different
  // moments, are what make the comparison mean something.
  bridge.buildProvider('command-eve.seat-context').provider(async () => {
    try {
      return {
        success: true,
        data: { seatId: getActiveSeatId(), seatContextRevision: getActiveSeatContextRevision() },
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE seat-context read failed.',
        data: { seatId: '', seatContextRevision: -1 },
      };
    }
  });

  bridge.buildProvider('command-eve.inference-lane-decision').provider(async () => {
    const seatId = (() => {
      try {
        return getActiveSeatId();
      } catch {
        return '';
      }
    })();
    const seatContextRevision = (() => {
      try {
        return getActiveSeatContextRevision();
      } catch {
        return -1;
      }
    })();

    try {
      const route = await resolveEveCloudRouteFromBackend({
        readLicense: () => {
          const wireResult = readLicenseWire(getDataPath());
          return wireResult.ok ? wireResult.wire : undefined;
        },
      });
      const wireTier = route?.active === true ? route.tier : undefined;
      return {
        success: true,
        data: {
          seatId,
          seatContextRevision,
          // The decision, not a re-derivation: `max` on the wire is the only
          // thing that licenses the MAX surface.
          maxActive: wireTier === 'max',
          wireTier,
        },
      };
    } catch (error) {
      // A HELD lane is a DECIDED state, not a failure to decide. Main knows
      // exactly what it will do — nothing — so the receipt says so and the
      // composer can paint the neutral "entitlement is being checked" state and
      // hold submission. Reporting it as a generic error would collapse it into
      // "we could not ask", which paints nothing and holds nothing.
      if (isCommandEveMaxEntitlementHoldError(error)) {
        return {
          success: true,
          data: { seatId, seatContextRevision, maxActive: false, laneHold: 'max-entitlement-unknown' as const },
        };
      }
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE inference-lane decision failed.',
        data: { seatId, seatContextRevision, maxActive: false },
      };
    }
  });

  // -------------------------------------------------------------------------
  // Account auth (browser-loopback, P1). The whole PKCE/loopback/token exchange
  // + post-session orchestration runs HERE in the main process; the renderer
  // only triggers it and reads back the gate status. Tokens never cross the
  // bridge. PREPARED: the web /auth/desktop page + desktop-auth-broker are not
  // live yet, so a real login returns a typed BROKER_HTTP_*/OPEN failure and the
  // UI keeps the paste fallback — this handler is safe to ship now.
  // -------------------------------------------------------------------------
  bridge.buildProvider('command-eve.auth-web-login').provider(async (request?: { intent?: DesktopAuthIntent }) => {
    const version = 'command-eve-account-auth/v0' as const;
    try {
      const intent: DesktopAuthIntent = request?.intent === 'register' ? 'register' : 'login';
      const userDataPath = getDataPath();

      // Open the system browser via Electron shell (lazy require so this module
      // stays importable in non-Electron/test contexts).
      const openExternal = (url: string): Promise<void> => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { shell } = require('electron') as { shell?: { openExternal(u: string): Promise<void> } };
        if (!shell?.openExternal) return Promise.reject(new Error('shell.openExternal unavailable'));
        return shell.openExternal(url);
      };

      const loopback = await runDesktopAuthLoopback(intent, { openExternal });
      if (!loopback.ok || !loopback.session) {
        return {
          success: false,
          msg: loopback.reason_code || 'AUTH_FAILED',
          data: {
            version,
            ok: false,
            entitled: false,
            // The user has no session ⇒ no automatic activation possible; offer
            // the manual paste path so a pre-broker build is still usable.
            needs_paste: true,
            reason_code: loopback.reason_code,
            message: loopback.message,
          },
        };
      }

      const session = loopback.session;
      // Persist the session at rest (keychain, fail-closed) so silent resume
      // works on next launch.
      const { storeAccountSession } = await import('@process/commandEve/accountSessionAtRest');
      storeAccountSession(userDataPath, session);
      await refreshBrowserWorkbenchContextBestEffort();

      const result = await activateEntitlementFromSession(userDataPath, session, {
        storeLicenseWire: (p, wire) => {
          try {
            storeLicenseWire(p, wire);
          } catch {
            // non-fatal
          }
        },
      });
      void syncRegistrationIdentityArtifactsBestEffort(userDataPath);

      return {
        success: result.activated,
        msg: result.activated ? undefined : result.reason_code,
        data: {
          version,
          ok: result.activated,
          entitled: result.status.state === 'entitled',
          needs_paste: result.needsPaste,
          starter_seat_ready: result.starterSeatReady,
          reason_code: result.reason_code,
          status: result.status,
          account: { name: session.user.name, email: session.user.email, company: session.user.company },
        },
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE auth-web-login bridge failed.',
        data: {
          version,
          ok: false,
          entitled: false,
          needs_paste: true,
          reason_code: 'AUTH_WEB_LOGIN_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : undefined,
        },
      };
    }
  });

  // Silent account reconciliation for the trial curtain. This is intentionally
  // a narrow wrapper around the existing startup-resume path: refresh the stored
  // session, fetch my-license, and activate through the normal entitlement core.
  // No browser is opened and no token or license wire crosses the bridge.
  bridge.buildProvider('command-eve.auth-resume').provider(async () => {
    const version = 'command-eve-account-auth/v0' as const;
    try {
      const userDataPath = getDataPath();
      const result = await silentResumeAccountAuth(userDataPath, {
        storeLicenseWire: (p, wire) => {
          try {
            storeLicenseWire(p, wire);
          } catch {
            // Non-fatal: entitlement status remains the source of truth.
          }
        },
      });
      await refreshBrowserWorkbenchContextBestEffort();
      if (readRegistration(userDataPath)) await syncRegistrationIdentityArtifactsBestEffort(userDataPath);

      return {
        success: true,
        data: {
          version,
          ok: true,
          outcome: result.outcome,
          entitled: result.status?.state === 'entitled',
          reason_code: result.reason_code,
          status: result.status,
        },
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE auth-resume bridge failed.',
        data: {
          version,
          ok: false,
          outcome: 'error' as const,
          entitled: false,
          reason_code: 'AUTH_RESUME_BRIDGE_FAILED',
        },
      };
    }
  });

  // -------------------------------------------------------------------------
  // In-app email/password auth (founder HG-4, 2026-06-20). Same MAIN-process
  // posture as the loopback: the renderer passes {intent,email,password}; the
  // GoTrue grant, session and keychain-at-rest stay here. NEVER returns or logs
  // tokens/passwords. A grant failure (bad creds / taken email / weak password /
  // confirmation required) returns needs_paste:false so the UI shows an inline
  // error and the user retries — only a SESSION-obtained-but-license-pending case
  // (result.needsPaste) routes to the code-paste fallback.
  // -------------------------------------------------------------------------
  bridge
    .buildProvider('command-eve.auth-password-login')
    .provider(async (request?: { intent?: DesktopAuthIntent; email?: string; password?: string }) => {
      const version = 'command-eve-account-auth/v0' as const;
      try {
        const intent: DesktopAuthIntent = request?.intent === 'register' ? 'register' : 'login';
        const email = typeof request?.email === 'string' ? request.email : '';
        const password = typeof request?.password === 'string' ? request.password : '';
        const userDataPath = getDataPath();

        const grant = await passwordGrant(intent, email, password);
        if (!grant.ok || !grant.session) {
          // No session ⇒ the user corrects credentials and retries in place; do
          // NOT drop to the paste step (that is for the no-browser loopback case).
          return {
            success: false,
            msg: grant.reason_code || 'AUTH_FAILED',
            data: { version, ok: false, entitled: false, needs_paste: false, reason_code: grant.reason_code },
          };
        }

        const session = grant.session;
        const { storeAccountSession } = await import('@process/commandEve/accountSessionAtRest');
        storeAccountSession(userDataPath, session);
        await refreshBrowserWorkbenchContextBestEffort();

        const result = await activateEntitlementFromSession(userDataPath, session, {
          storeLicenseWire: (p, wire) => {
            try {
              storeLicenseWire(p, wire);
            } catch {
              // non-fatal
            }
          },
        });
        void syncRegistrationIdentityArtifactsBestEffort(userDataPath);

        return {
          success: result.activated,
          msg: result.activated ? undefined : result.reason_code,
          data: {
            version,
            ok: result.activated,
            entitled: result.status.state === 'entitled',
            needs_paste: result.needsPaste,
            starter_seat_ready: result.starterSeatReady,
            reason_code: result.reason_code,
            status: result.status,
            account: { name: session.user.name, email: session.user.email, company: session.user.company },
          },
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE auth-password-login bridge failed.',
          data: {
            version,
            ok: false,
            entitled: false,
            needs_paste: false,
            reason_code: 'AUTH_PASSWORD_LOGIN_BRIDGE_FAILED',
          },
        };
      }
    });

  // Logout: revoke the GoTrue session + delete session.enc + clear memory. Per
  // founder decision the entitlement.json + license-wire are KEPT so the app
  // stays offline-usable after logout.
  bridge.buildProvider('command-eve.auth-logout').provider(async () => {
    const version = 'command-eve-account-auth/v0' as const;
    try {
      const browserCleanupError = await revokeBrowserWorkbenchContextBestEffort();
      await revokeAndClearSession(getDataPath());
      await refreshBrowserWorkbenchContextBestEffort();
      if (browserCleanupError) throw browserCleanupError;
      return { success: true, data: { version, ok: true } };
    } catch (error) {
      // Even on error the local session file is best-effort cleared inside
      // revokeAndClearSession; report ok:false but never throw the chrome.
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE auth-logout bridge failed.',
        data: { version, ok: false, reason_code: 'AUTH_LOGOUT_BRIDGE_FAILED' },
      };
    }
  });

  // -------------------------------------------------------------------------
  // APP→WEB AUTH HANDOFF (money-critical). Open command-eve.com/account (and its
  // /account and ?pack_eur=<n> money deep-links) in the system browser WITH the
  // desktop session carried across, so the user lands LOGGED IN and checkout can
  // start. Before this, the browser had its own empty localStorage session, so the
  // user arrived logged out and the purchase never began (Alois could not buy
  // credits). The refresh token is read HERE in MAIN via getFreshSession (the
  // renderer never holds it), attached to the URL as a FRAGMENT (never a query, so
  // it stays out of server logs + the Referer header), and the website exchanges +
  // rotates it immediately (making the URL value worthless). FAIL-SAFE: any error,
  // or no session, opens the NAKED url (today's behaviour → the site routes to
  // /login); the buy path must NEVER hard-fail. The token is NEVER returned to the
  // renderer and NEVER logged.
  // -------------------------------------------------------------------------
  bridge.buildProvider('command-eve.open-account-web').provider(async (request?: { path?: string }) => {
    const openExternal = (url: string): Promise<void> => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { shell } = require('electron') as { shell?: { openExternal(u: string): Promise<void> } };
      if (!shell?.openExternal) return Promise.reject(new Error('shell.openExternal unavailable'));
      return shell.openExternal(url);
    };

    try {
      const { buildAccountWebHandoffUrl, mintAccountWebHandoffCode, COMMAND_EVE_WEB_ORIGIN } =
        await import('@process/commandEve/accountWebHandoffCore');
      const path = typeof request?.path === 'string' && request.path.startsWith('/') ? request.path : '/account';

      // Read the session at rest (MAIN only). getFreshSession rotates a near-expiry
      // access token. We need ONLY the ACCESS token to mint the reverse-handoff code —
      // the raw refresh_token is NEVER put in a URL (see below).
      let accessToken: string | undefined;
      try {
        const { getFreshSession } = await import('@process/commandEve/accountSessionAtRest');
        const fresh = await getFreshSession(getDataPath());
        if (fresh.ok && fresh.session) {
          accessToken = fresh.session.access_token || undefined;
        }
      } catch {
        // No/failed session → carry nothing; the naked URL below still opens.
        accessToken = undefined;
      }

      // H5/H7: use ONLY the reverse-handoff single-use CODE — the URL carries NO token
      // (`#hc=<code>`), and the website redeems it for a freshly-minted INDEPENDENT
      // session (the desktop's own refresh_token is never consumed/rotated).
      //
      // B2 (full-history re-audit): the previous graceful fallback opened
      // `#h=<refresh_token>` when minting failed — a RAW, long-lived GoTrue refresh
      // token in the browser URL/history until redeemed. Because the account-web-handoff
      // Edge Fn is not yet deployed, that fallback fired on EVERY open = the live H5
      // hole. Removed: a mint failure now opens the NAKED (logged-out) URL — never the
      // raw token. TRADE-OFF: until the Edge Fn is deployed, a logged-in handoff is not
      // possible and the operator lands on /login. The deploy runbook therefore
      // REQUIRES the Edge Fn live before/with the desktop ship (spec:
      // command-eve-account-web-handoff-code-spec-2026-07-04.md).
      let handoffCode: string | null = null;
      if (accessToken) {
        const { resolveSupabaseAnonKey } = await import('@process/commandEve/desktopAuthLoopback');
        handoffCode = await mintAccountWebHandoffCode({
          getAccessToken: async () => accessToken ?? null,
          anonKey: resolveSupabaseAnonKey(),
        });
      }

      // Build the URL in MAIN (any secret stays here); origin is pinned to command-eve.com.
      // On a mint failure buildAccountWebHandoffUrl with no code returns the NAKED url —
      // never a token.
      const url = buildAccountWebHandoffUrl(COMMAND_EVE_WEB_ORIGIN, path, handoffCode ?? undefined);
      await openExternal(url);
      // NEVER return the url (it may carry the fragment code) — only ok + whether a
      // logged-in session was carried (a boolean, never the secret) for the renderer.
      return { success: true, data: { ok: true, carried_session: Boolean(handoffCode) } };
    } catch (error) {
      // Even on a failure to read/build/open with the token, try the NAKED url so
      // the operator still reaches the site (logged out → /login). Never throw the
      // chrome; never log the token (there is none to log on this path).
      const fallbackPath =
        typeof request?.path === 'string' && request.path.startsWith('/') ? request.path : '/account';
      const nakedUrl = `https://command-eve.com${fallbackPath}`;
      try {
        await openExternal(nakedUrl);
      } catch {
        // M-browser-open-masked (Codex): BOTH the token-URL and the naked fallback
        // failed to open a browser. Do NOT mask it as success:true — that made the
        // buy path look like it opened when nothing did and no fallback could fire.
        // Report an honest failure + the (token-free, safe) naked url so the caller
        // can retry its own open path or offer a copy-link.
        return {
          success: false,
          msg: 'OPEN_ACCOUNT_WEB_FAILED',
          data: { ok: false, carried_session: false, reason_code: 'OPEN_ACCOUNT_WEB_FAILED', fallback_url: nakedUrl },
        };
      }
      return {
        success: true,
        data: {
          ok: true,
          carried_session: false,
          reason_code: error instanceof Error ? 'OPEN_ACCOUNT_WEB_FELL_BACK' : undefined,
        },
      };
    }
  });

  // HARD reset ("Abmelden & Gerät zurücksetzen", §2b). Unlike auth-logout (which
  // KEEPS the offline entitlement), this removes the three local trust artifacts —
  // entitlement.json + registration.json + the license-wire bearer — and revokes
  // the account session, so getEntitlementStatus falls back to `unregistered` and
  // the renderer's RegistrationGate renders again. Reuses the SAME
  // revokeAndClearSession the soft logout uses + the new clearLicenseWire. Never
  // returns tokens; never throws the chrome.
  bridge.buildProvider('command-eve.entitlement-reset').provider(async () => {
    try {
      const browserCleanupError = await revokeBrowserWorkbenchContextBestEffort();
      const result = await resetEntitlement(getDataPath(), {
        clearLicenseWire,
        revokeAndClearSession,
      });
      await refreshBrowserWorkbenchContextBestEffort();
      if (browserCleanupError) {
        return {
          success: false,
          msg: browserCleanupError.message,
          data: {
            ...result,
            ok: false,
            reason_code: 'BROWSER_CONTEXT_CLEANUP_FAILED',
            message: browserCleanupError.message,
          },
        };
      }
      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code || result.message,
        data: result,
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE entitlement-reset bridge failed.',
        data: {
          version: COMMAND_EVE_ENTITLEMENT_RESET_VERSION,
          ok: false,
          removed: { entitlement: false, registration: false, license_wire: false, session: false },
          reason_code: 'ENTITLEMENT_RESET_BRIDGE_FAILED',
          message: error instanceof Error ? error.message : undefined,
        },
      };
    }
  });

  // Local registration/session readout for the avatar + account panel. NEVER
  // returns tokens — only the locally-stored name/email/company + presence flags.
  bridge.buildProvider('command-eve.registration-status').provider(async () => {
    const version = 'command-eve-account-auth/v0' as const;
    try {
      const userDataPath = getDataPath();
      const registration = readRegistration(userDataPath);
      const hasSession = hasAccountSession(userDataPath);
      // Prefer the session's user identity when present (it is the source of
      // truth for the logged-in account); fall back to the local registration.
      let email = registration?.email;
      let company = registration?.company;
      let sessionName: string | undefined;
      if (hasSession) {
        const read = readAccountSession(userDataPath);
        if (read.ok && read.session) {
          // Email is the LOGIN identity → the session is authoritative.
          email = read.session.user.email || email;
          sessionName = read.session.user.name;
          company = registration?.company || read.session.user.company || company;
        }
      }
      const identity = resolveCommandEveDisplayIdentity({
        registrationName: registration?.name,
        registrationNameSource: registration?.name_source,
        sessionName,
        email,
      });
      return {
        success: true,
        data: {
          version,
          ok: true,
          registered: Boolean(registration),
          has_session: hasSession,
          ...(identity.name ? { name: identity.name } : {}),
          name_confirmed: identity.nameConfirmed,
          ...(email ? { email } : {}),
          ...(company ? { company } : {}),
          ...(identity.source ? { name_source: identity.source } : {}),
        },
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE registration-status bridge failed.',
        data: { version, ok: false, registered: false, has_session: false },
      };
    }
  });

  // Edit the local registration profile (name + company only; email is the login
  // identity and stays out of this path). Merge-only; requires an existing record.
  bridge
    .buildProvider('command-eve.registration-update')
    .provider(async (request?: { name?: string; company?: string }) => {
      try {
        const result = updateRegistrationProfile(
          {
            ...(request?.name !== undefined ? { name: request.name } : {}),
            ...(request?.company !== undefined ? { company: request.company } : {}),
          },
          { userDataPath: getDataPath() }
        );
        if (result.ok) void syncRegistrationIdentityArtifactsBestEffort(getDataPath());
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reason_code || result.message,
          data: result,
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE registration-update bridge failed.',
          data: {
            version: COMMAND_EVE_ENTITLEMENT_BRIDGE_VERSION,
            ok: false,
            reason_code: 'REGISTRATION_UPDATE_BRIDGE_FAILED',
            message: error instanceof Error ? error.message : 'Command EVE registration-update bridge failed.',
          },
        };
      }
    });

  // -------------------------------------------------------------------------
  // ACTIVE SEAT readout (Phase 4 / ISO-2). The in-process active seat is held
  // ONLY in the main process (seatContextCore.getActiveSeatId, default
  // LEGACY_SEAT_ID). The renderer's per-seat config namespace
  // (seatConfigKeyCore + configService) must namespace its seat-scoped keys with
  // the SAME id the main process uses, so it reads it back over this bridge. No
  // write, no PII; returns just the sanitized active seat id string. Defaults to
  // the legacy seat until a seat switcher (Task #2) calls setActiveSeatId.
  // -------------------------------------------------------------------------
  bridge.buildProvider('command-eve.active-seat').provider(async () => {
    const version = 'command-eve-active-seat/v0' as const;
    try {
      return { success: true, data: { version, ok: true, seat_id: getActiveSeatId() } };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE active-seat bridge failed.',
        data: { version, ok: false, seat_id: 'seat-1', reason_code: 'ACTIVE_SEAT_BRIDGE_FAILED' },
      };
    }
  });

  // -------------------------------------------------------------------------
  // MY-SEATS read (Phase 4 / A5 + B3 data contract). Returns the account, the
  // account's seats, the active seat, and the per-seat role — the payload the
  // admin SeatSwitcher lists and the fail-closed SeatGuard classifies. The
  // my-seats edge function (B3) is AUTHORED but NOT deployed (founder gate), so
  // this handler FAIL-CLOSES to a SINGLE legacy seat (no account, delegate role)
  // until the function is live: a single-seat / legacy install is byte-identical
  // to 1.1.3 (no switcher, hard-pinned). When the function IS reachable, the raw
  // wire is parsed defensively (parseMySeats) so a malformed/hostile payload can
  // never widen access. No seatId/account-id is ever client-supplied — the
  // function binds to the JWT-resolved account (IDOR guard lives server-side).
  // -------------------------------------------------------------------------
  bridge.buildProvider('command-eve.my-seats').provider(async () => {
    const version = 'command-eve-my-seats/v0' as const;
    // Fail-closed contract: one legacy seat, delegate role, pinned. This is the
    // value a legacy/single-seat/no-account install ALWAYS returns.
    const legacyContract = {
      account_id: null as string | null,
      role: 'delegate' as const,
      active_seat_id: getActiveSeatId(),
      seats: [] as Array<{
        seat_id: string;
        name: string;
        kind: 'client' | 'own_company' | 'department';
        role: 'admin' | 'delegate';
        is_active: boolean;
      }>,
    };
    try {
      const wire = await readMySeatsWire();
      if (!wire) {
        // No my-seats source live yet ⇒ fail-closed single legacy seat.
        // MAT-1773: log the transition — and now NAME the cause. The typed
        // failure travels in the envelope too (wire_error), so the renderer can
        // tell a DEAD account session (re-login recovers the rail) from a
        // transient read failure.
        if (!commandEveMySeatsWireDown) {
          commandEveMySeatsWireDown = true;
          console.warn(
            `[Command EVE] my-seats wire unavailable — fail-closed legacy contract. Cause: ${JSON.stringify(
              commandEveMySeatsWireFailure ?? { kind: 'unknown' }
            )}. The SeatRail falls back to local admin evidence in the renderer.`
          );
        }
        return {
          success: true,
          data: {
            version,
            ok: true,
            contract: legacyContract,
            source: 'legacy_fallback',
            wire_error: commandEveMySeatsWireFailure,
          },
        };
      }
      const parsed = parseMySeats(wire);
      if (!parsed) {
        // The wire responded but did not match the {account,seats,active_seat_id}
        // contract — log the TOP-LEVEL KEYS so a contract field mismatch (the
        // silent role='delegate' downgrade class) is diagnosable from the log.
        console.warn(
          `[Command EVE] my-seats wire present but unparseable — top-level keys: ${
            typeof wire === 'object' && wire !== null ? Object.keys(wire).join(',') : typeof wire
          }. Fail-closed legacy contract.`
        );
        return {
          success: true,
          data: {
            version,
            ok: true,
            contract: legacyContract,
            source: 'legacy_fallback',
            wire_error: { kind: 'malformed' } satisfies MySeatsWireFailure,
          },
        };
      }
      if (commandEveMySeatsWireDown) {
        commandEveMySeatsWireDown = false;
        console.info('[Command EVE] my-seats wire read recovered — live contract restored.');
      }
      return {
        success: true,
        data: { version, ok: true, contract: parsed, source: 'my_seats', wire_error: null },
      };
    } catch (error) {
      // ANY failure ⇒ fail-closed single legacy seat (never widen on error).
      return {
        success: true,
        msg: error instanceof Error ? error.message : undefined,
        data: {
          version,
          ok: true,
          contract: legacyContract,
          source: 'legacy_fallback',
          wire_error: commandEveMySeatsWireFailure,
        },
      };
    }
  });

  // MAT-1774 — in-app Seed create/rename. MAIN owns the account session and
  // supplies the verified bearer; the renderer never receives credentials or
  // chooses an account id. createSeedSingleFlight is the second belt behind the
  // disabled UI button and server-side idempotency/advisory lock.
  bridge
    .buildProvider('command-eve.seed-create')
    .provider(async (request?: { displayName?: string; clientRequestId?: string }) => {
      const version = 'command-eve-seed-create/v0' as const;
      try {
        const result = await createSeedSingleFlight(getDataPath(), {
          displayName: request?.displayName ?? '',
          clientRequestId: request?.clientRequestId ?? '',
        });
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reasonCode,
          data: {
            version,
            ok: result.ok,
            ...(result.seedId ? { seed_id: result.seedId } : {}),
            ...(result.created !== undefined ? { created: result.created } : {}),
            ...(result.seedCount !== undefined ? { seed_count: result.seedCount } : {}),
            seed_limit: result.seedLimit,
            ...(result.reasonCode ? { reason_code: result.reasonCode } : {}),
          },
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Seed creation failed.',
          data: {
            version,
            ok: false,
            seed_limit: null,
            reason_code: 'SEED_CREATE_BRIDGE_FAILED',
          },
        };
      }
    });

  bridge
    .buildProvider('command-eve.seed-rename')
    .provider(async (request?: { seedId?: string; displayName?: string }) => {
      const version = 'command-eve-seed-rename/v0' as const;
      try {
        const result = await renameSeed(getDataPath(), {
          seedId: request?.seedId ?? '',
          displayName: request?.displayName ?? '',
        });
        return {
          success: result.ok,
          msg: result.ok ? undefined : result.reasonCode,
          data: {
            version,
            ok: result.ok,
            ...(result.seedId ? { seed_id: result.seedId } : {}),
            ...(result.displayName ? { display_name: result.displayName } : {}),
            ...(result.reasonCode ? { reason_code: result.reasonCode } : {}),
          },
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Seed rename failed.',
          data: { version, ok: false, reason_code: 'SEED_RENAME_BRIDGE_FAILED' },
        };
      }
    });

  // -------------------------------------------------------------------------
  // SWITCH-SEAT (Phase 4 / A5, SLICE C). The GATE-NULL runtime keystone wired
  // over IPC. Drives applySeatSwitch (the pure, ordered, fail-safe lifecycle):
  // setActiveSeatId → prepareEnv → STOP+RE-SPAWN backend → rebindConfig →
  // reseed-status → best-effort persist. The IPC-level ADMIN GATE is enforced
  // HERE in main (a renderer guard alone is not a security boundary): the target
  // is authorized ONLY when isSeatSwitchAuthorized(access, target) — admin, >1
  // seat, target in the authorized list. A delegate, or any target not in the
  // caller's seats, is rejected fail-closed BEFORE any state mutates.
  //   Hotfix-B: on a failed re-spawn, applySeatSwitch's rollback re-invokes THIS
  // handler's restartBackend thunk for the restored prior seat, so a rolled-back
  // switch leaves a LIVE backend (reason_code SEAT_SWITCH_RESPAWN_FAILED). If that
  // prior-seat restart ALSO fails, the result carries backend_down + reason_code
  // SEAT_SWITCH_ROLLED_BACK_BACKEND_DOWN — a DISTINCT fail-closed error (relaunch
  // needed), never a silent dead backend reported as a clean rollback.
  // -------------------------------------------------------------------------
  bridge.buildProvider('command-eve.switch-seat').provider(async (request?: { seatId?: string }) => {
    const version = 'command-eve-switch-seat/v0' as const;
    if (commandEveSwitchSeatRecoveryRequired) {
      return {
        success: false,
        msg: 'The previous Seed switch is still unresolved. Relaunch Command EVE if it does not recover.',
        data: {
          version,
          ok: false,
          reason_code: 'SWITCH_SEAT_RECOVERY_REQUIRED',
          active_seat_id: getActiveSeatId(),
        },
      };
    }
    if (hasCommandEvePaidArtifactOperationInFlight()) {
      return {
        success: false,
        msg: 'A paid artifact is still being stored for the active Seed.',
        data: {
          version,
          ok: false,
          reason_code: 'PAID_ARTIFACT_OPERATION_IN_PROGRESS',
          active_seat_id: getActiveSeatId(),
        },
      };
    }
    // Serialize: reject a second switch while one is mid-flight (see the lock note
    // above). Returned BEFORE any state mutates ⇒ the in-flight switch is untouched.
    if (commandEveSwitchSeatInFlight) {
      return {
        success: false,
        msg: 'A seat switch is already in progress.',
        data: { version, ok: false, reason_code: 'SWITCH_SEAT_IN_PROGRESS', active_seat_id: getActiveSeatId() },
      };
    }

    // T5 — PRE-SWITCH DIGEST FLUSH. If a session digest of the OUTGOING seat is still
    // running, wait for it to finish (hard 3s cap) BEFORE we take the switch lock — so
    // it completes and lands in the CORRECT (outgoing) seat's brain while that seat is
    // still active (the pointer only moves later, inside applySeatSwitch.prepareEnv).
    // We do this BEFORE setting commandEveSwitchSeatInFlight so the digest's own
    // post-inference fence (which keys on that flag) does not refuse the very write we
    // are flushing. We only AWAIT an ALREADY-running run — never start a new Ollama
    // call in the switch path (spec §4). On timeout we skip + log and proceed (a switch
    // must never wedge behind a stuck digest). The paid-artifact transition gate
    // immediately below closes the await window atomically before state mutates.
    const pendingDigest: Promise<unknown> | null = commandEveSessionDigestInFlight;
    if (pendingDigest) {
      const noop = (): void => undefined;
      const settledOrCapped: Promise<void> = pendingDigest.then(noop, noop);
      const cap = new Promise<void>((resolve) => setTimeout(resolve, 3000));
      try {
        await Promise.race([settledOrCapped, cap]);
      } catch {
        /* best-effort — never block the switch on a digest */
      }
    }

    const releasePaidArtifactSeatTransition = tryBeginCommandEvePaidArtifactSeatTransition();
    if (!releasePaidArtifactSeatTransition) {
      return {
        success: false,
        msg: 'A paid artifact is still being stored for the active Seed.',
        data: {
          version,
          ok: false,
          reason_code: 'PAID_ARTIFACT_OPERATION_IN_PROGRESS',
          active_seat_id: getActiveSeatId(),
        },
      };
    }
    commandEveSwitchSeatInFlight = true;
    const myEpoch = ++commandEveSwitchSeatEpoch;
    // Release only if THIS switch still owns the lock (epoch unchanged).
    const releaseLock = () => {
      if (commandEveSwitchSeatEpoch === myEpoch) {
        commandEveSwitchSeatInFlight = false;
        commandEveSwitchSeatRecoveryRequired = false;
        setCommandEvePaidArtifactSeatRecoveryRequired(false);
      }
    };
    const releaseAllSwitchFences = () => {
      releaseLock();
      releasePaidArtifactSeatTransition();
    };
    // A respawn that exceeds the hard bound is no longer described as an
    // ordinary in-flight switch. Recovery remains fail-closed through the
    // explicit recovery marker, while the transition reservation itself is
    // released so paid consumers can distinguish this terminal state from an
    // ordinary retryable transition.
    const lockWatchdog = setTimeout(() => {
      if (commandEveSwitchSeatEpoch === myEpoch) {
        commandEveSwitchSeatRecoveryRequired = true;
        setCommandEvePaidArtifactSeatRecoveryRequired(true);
        releasePaidArtifactSeatTransition();
      }
    }, COMMAND_EVE_SWITCH_SEAT_LOCK_TIMEOUT_MS);
    try {
      const targetSeatId = typeof request?.seatId === 'string' ? request.seatId : '';
      if (!targetSeatId) {
        return {
          success: false,
          msg: 'Missing seatId.',
          data: { version, ok: false, reason_code: 'SWITCH_SEAT_NO_TARGET', active_seat_id: getActiveSeatId() },
        };
      }

      // Re-resolve the caller's access from the SAME my-seats source (never trust
      // a renderer-asserted role). Fail-closed if unreachable ⇒ delegate ⇒ reject.
      const wire = await readMySeatsWire();
      const access = resolveSeatAccess(wire ? parseMySeats(wire) : null);
      if (!isSeatSwitchAuthorized(access, targetSeatId)) {
        return {
          success: false,
          msg: 'Not authorized to switch to this seat.',
          data: { version, ok: false, reason_code: 'SWITCH_SEAT_FORBIDDEN', active_seat_id: getActiveSeatId() },
        };
      }

      const { applySeatSwitch } = await import('@process/commandEve/seatSwitchCore');
      const { restartCommandEveBackendForSeat } = await import('@process/commandEve/seatSwitchRuntime');
      const { prepareCommandEveRuntimeProcessEnv, provisionSeatRuntimeFiles, hasValidSeatRuntimeFiles } =
        await import('@process/commandEve/runtimeBootstrapCore');
      const { reconcileVaultConfigForSeatSwitch } = await import('@process/commandEve/reconcileHermesMcpConfigWiring');

      // Seat-Context-Bridge (B1): the target seat's DISPLAY LABEL comes from the
      // SAME wire seat record already resolved above (access.seats[].name) — no
      // extra fetch. applySeatSwitch captures it into the process-local label
      // holder alongside setActiveSeatId, so the re-spawn env bake carries it.
      const sanitizedTarget = sanitizeSeatId(targetSeatId);
      const targetSeatRecord = access.seats.find((s) => s.seat_id === sanitizedTarget);
      const targetLabel = targetSeatRecord?.name;
      // K2: the target seat's KIND comes from the SAME wire record as its label
      // (access.seats[].kind — already default-denied by parseMySeats/asSeatKind).
      // applySeatSwitch threads it into the kind holder alongside the label so the
      // re-spawn env bake + the tier stamp below carry the correct doctrine.
      const targetKind = targetSeatRecord?.kind;

      // Reserve the shared backend lifecycle BEFORE applySeatSwitch can move the
      // active-seat holder. The lease stays live through target preparation,
      // restart, config rebind, informational refresh and any rollback restart.
      const result = await runCommandEveBackendRestartReservation(
        async (restartLease) => {
          const switchResult = await applySeatSwitch(
            targetSeatId,
            {
              prepareEnv: async () => {
                prepareCommandEveRuntimeProcessEnv(
                  getDataPath(),
                  process.env,
                  process.platform,
                  process.resourcesPath,
                  {
                    requireBundledPython: app.isPackaged && process.platform === 'darwin',
                  }
                );
                // T0 — PROVISION THE TARGET SEAT'S RUNTIME FILES. applySeatSwitch has
                // already run setActiveSeatId(target) (step a), so getActiveSeatId() is the
                // target and prepareCommandEveRuntimeProcessEnv just re-homed HERMES_HOME to
                // the target seat's home. But the boot bootstrap only ever provisions the
                // LEGACY/founder home (there is no boot-restore of a saved seat — index.ts
                // ~1395), so a client seat's home has NO config.yaml/SOUL.md/skills-command-
                // eve — the agent would boot on WHEEL DEFAULTS (memory_enabled=FALSE, no
                // SOUL). Write the Desktop-OWNED files into the target home NOW, before
                // applySeatSwitch's restartBackend re-spawns the agent (which is the very
                // next step), so the fresh agent finds them. Idempotent + safe: it writes
                // ONLY config.yaml/SOUL.md/skills-command-eve (+ wrapper/shim/reconciliation)
                // exactly as boot does and NEVER touches EVE-grown memories/ or the agent's
                // own skills/. BEST-EFFORT: a provisioning error must NOT fail the switch —
                // we log it (founder-self-detection) and let the switch proceed.
                try {
                  const { reachable, ...workerInputs } = await resolveCommandEveWorkerRuntimeInputsForSwitch();
                  // F7 (MEDIUM): if the backend was UNREACHABLE, do NOT re-provision. A
                  // provision run with the degraded (empty) inputs would rewrite the
                  // target seat's SOUL.md/config.yaml WITHOUT the Claude-delegate directive
                  // (silent capability loss). Skipping keeps the last-known-good files that
                  // a prior reachable provisioning wrote. Self-detected via console.warn.
                  if (!reachable) {
                    console.warn(
                      `[Command EVE] Seat-switch runtime provisioning SKIPPED for ${sanitizedTarget ?? targetSeatId}: backend settings unreachable; keeping last-known-good runtime files (no degraded re-write).`
                    );
                  } else {
                    const provisioned = provisionSeatRuntimeFiles({
                      userDataPath: getDataPath(),
                      resourcesPath: process.resourcesPath,
                      // Setting-driven language, identical to the boot bootstrap, so the
                      // target seat's SOUL.md defaults to the operator's UI language.
                      uiLanguage: ProcessConfig.getSync('language'),
                      ...workerInputs,
                    });
                    if (!provisioned.ok) {
                      console.warn(
                        `[Command EVE] Seat-switch runtime provisioning failed for ${sanitizedTarget ?? targetSeatId} (${provisioned.hermes_home || 'no home'}); the target-file validity gate below decides fail-open vs fail-closed. Cause: ${provisioned.error ?? 'unknown'}`
                      );
                    } else if (provisioned.bundled_skill_failures.length) {
                      console.warn(
                        `[Command EVE] Seat-switch runtime provisioning: bundled EVE strategy skills missing/invalid for ${sanitizedTarget ?? targetSeatId}: ${provisioned.bundled_skill_failures.join(', ')}`
                      );
                    }
                  }
                } catch (error) {
                  // Defensive: the resolver / import path itself throwing is caught here so
                  // it does not crash the thunk — but it does NOT decide the switch outcome.
                  // The single fail-closed gate below validates the target's actual files
                  // regardless of HOW provisioning ended (unreachable-skip, ok:false, or a
                  // thrown resolver).
                  console.warn(
                    '[Command EVE] Seat-switch runtime provisioning threw; validating target files before proceeding:',
                    error
                  );
                }
                // H4 (Codex): SINGLE fail-closed gate, OUTSIDE the best-effort try/catch so
                // its throw actually propagates to applySeatSwitch (whose documented
                // FAIL-SAFE rolls the runtime back to the prior seat on a throwing
                // prepareEnv). The invariant regardless of how provisioning ended above
                // (unreachable-skip / ok:false / thrown resolver): a seat switch must NEVER
                // leave the seat booting on WHEEL DEFAULTS (memory_enabled=FALSE, no
                // SOUL.md, no EVE skills) — that silently drops the security / memory /
                // invisible-delivery posture. If the home holds a valid config.yaml +
                // SOUL.md (freshly written, or last-known-good from a prior good pass) the
                // switch proceeds; otherwise it fails closed. The legacy/founder home is
                // always provisioned at boot, so switching home never trips this.
                //
                // Validate getActiveSeatId(), NOT the captured target: applySeatSwitch runs
                // this thunk AGAIN during rollback with the active seat set back to the
                // PRIOR seat (and provisionSeatRuntimeFiles above already keys off the
                // active seat). Using the active seat means the rollback pass validates the
                // prior seat's (valid) files and proceeds to restart its backend — using the
                // captured target here would re-throw on rollback and strand a dead backend.
                const gateSeatId = getActiveSeatId();
                let gateHome = '';
                try {
                  gateHome = resolveSeatHermesHome(getDataPath(), gateSeatId);
                } catch {
                  gateHome = '';
                }
                if (!hasValidSeatRuntimeFiles(gateHome)) {
                  console.warn(
                    `[Command EVE] Seat-switch FAIL-CLOSED for ${gateSeatId}: home (${gateHome || 'unresolved'}) has no valid config.yaml + SOUL.md — rolling back rather than booting on wheel defaults.`
                  );
                  throw new Error(`SEAT_SWITCH_PROVISION_FAILED: ${gateSeatId} has no valid runtime files`);
                }
                // S5-P2 vault reconcile (arch §7): refresh the TARGET seat's config.yaml
                // from the vault BEFORE applySeatSwitch's own restartBackend — so a seat's
                // Founder-connectors are present on entry. respawnAfter:false because the
                // switch lifecycle already owns the single respawn (the step right after
                // this prepareEnv). Behind COMMAND_EVE_MCP_VAULT_ENABLED (a kill
                // switch since 1.821.0, unset = on):
                // while off, the reRenderConfig closure is a no-op returning 0, so seat
                // switch behavior stays BYTE-IDENTICAL to today (no extra bootstrap run).
                // Runs AFTER the base provisioning above so, once the flag is on, the vault
                // re-render layers on top of a config.yaml that already exists.
                await reconcileVaultConfigForSeatSwitch();
              },
              restartBackend: () => restartCommandEveBackendForSeat(restartLease),
              rebindConfig: async (seatId) => {
                // configService lives RENDERER-side, so this MAIN-process seam cannot
                // touch its in-memory cache. The renderer re-homes its cache itself:
                // useSeatAccess.switchTo() calls configService.rebindSeat() with the
                // authoritative active_seat_id this handler returns (the target on
                // success, the prior seat on rollback). This thunk is intentionally a
                // no-op in main; the load-bearing rebind is the renderer call. Kept as a
                // seam so the lifecycle ordering (a→b→c→d) stays explicit and testable.
                void seatId;
              },
              reseedStatus: async (seatId) => {
                // Re-read the per-seat company-brain seed (informational; never fails the switch).
                void readCompanyBrainSeedState({ userDataPath: getDataPath(), seatId });
                // Seat-Context-Bridge (B2, set-point b): re-stamp the target seat's USER.md
                // tier blocks AFTER the re-spawn env bake, so the newly-spawned agent reads a
                // §FOUNDER (+ §SEAT for a seeded real seat) that matches the seat it landed on.
                // Best-effort — a stamp failure is informational and never fails the switch.
                try {
                  const { stampUserMdTiersForSwitch } = await import('@process/commandEve/userMdTierStampCore');
                  // K3: the kind holder was set by applySeatSwitch's structural phase
                  // (from the wire record) BEFORE reseedStatus runs here, so getActiveSeatKind()
                  // is the target seat's kind — the §SEAT block gets the correct doctrine.
                  stampUserMdTiersForSwitch({ userDataPath: getDataPath(), seatId, kind: getActiveSeatKind() });
                } catch {
                  // best-effort: the runtime is already on the new seat.
                }
              },
              persistActiveSeat: async (seatId, label, kind) => {
                // Label + kind ride the SAME wire seat record the switch already
                // resolved, so a restored boot reproduces id → label → kind exactly as
                // this switch left them — no second fetch, no drift between the two.
                //
                // FORWARDED, not closed over: applySeatSwitch now persists from three
                // points, and the ROLLBACK one passes the PRIOR seat. Hardcoding
                // targetLabel/targetKind here would have written the prior seat's id
                // under the failed target's label — a pointer describing a seat that
                // never existed. `?? target…` keeps the happy path byte-identical for
                // any caller that still omits them.
                await persistActiveSeatPointer(seatId, label ?? targetLabel, kind ?? targetKind);
              },
            },
            targetLabel,
            targetKind
          );

          await refreshBrowserWorkbenchContextBestEffort();
          return switchResult;
        },
        { queueWaitTimeoutMs: COMMAND_EVE_SWITCH_SEAT_LOCK_TIMEOUT_MS }
      );

      return {
        success: result.ok,
        msg: result.ok ? undefined : result.reason_code,
        data: { version, ...result },
      };
    } catch (error) {
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE switch-seat bridge failed.',
        data: { version, ok: false, reason_code: 'SWITCH_SEAT_BRIDGE_FAILED', active_seat_id: getActiveSeatId() },
      };
    } finally {
      // Release the lock on EVERY exit (success, rollback, throw) so the rail is never
      // permanently wedged into SWITCH_SEAT_IN_PROGRESS. Cancel the watchdog and release
      // via the epoch-guarded path so a late completion never clears a newer switch's lock.
      clearTimeout(lockWatchdog);
      releaseAllSwitchFences();
    }
  });

  // -------------------------------------------------------------------------
  // ACP EXTERNAL-WRITE RECOVERY (1.820.4). The renderer supplies NO workspace
  // and NO destination path. Main resolves the conversation's canonical
  // workspace from AionCore, captures the active seat + revision across that
  // await, and creates one new direct-child markdown file through the exclusive
  // no-follow staging core. This provider is NOT the native Save-As lane below.
  // -------------------------------------------------------------------------
  bridge
    .buildProvider('command-eve.report-stage-workspace')
    .provider(
      async (request?: {
        conversation_id?: string;
        turn_id?: string;
        tool_call_id?: string;
        markdown?: string;
        suggested_name?: string;
      }) => {
        const version = 'command-eve-report-stage-workspace/v0' as const;
        const conversationId = typeof request?.conversation_id === 'string' ? request.conversation_id.trim() : '';
        const turnId = typeof request?.turn_id === 'string' ? request.turn_id.trim() : '';
        const toolCallId = typeof request?.tool_call_id === 'string' ? request.tool_call_id.trim() : '';
        const markdown = typeof request?.markdown === 'string' ? request.markdown : '';
        const suggestedName = typeof request?.suggested_name === 'string' ? request.suggested_name.trim() : '';
        if (
          !conversationId ||
          conversationId.length > 256 ||
          conversationId.includes('\0') ||
          !turnId ||
          turnId.length > 256 ||
          turnId.includes('\0') ||
          !toolCallId ||
          toolCallId.length > 256 ||
          toolCallId.includes('\0')
        ) {
          return {
            success: false,
            msg: 'Conversation, turn and tool-call identity are required.',
            data: { version, ok: false, reason_code: 'REPORT_STAGE_CONVERSATION_INVALID' },
          };
        }
        if (!markdown.trim()) {
          return {
            success: false,
            msg: 'Markdown content is required.',
            data: { version, ok: false, reason_code: 'REPORT_STAGE_MARKDOWN_REQUIRED' },
          };
        }
        if (
          !suggestedName ||
          suggestedName.length > 255 ||
          suggestedName.includes('\0') ||
          suggestedName.includes('/') ||
          suggestedName.includes('\\')
        ) {
          return {
            success: false,
            msg: 'A report name is required.',
            data: { version, ok: false, reason_code: 'REPORT_STAGE_REQUESTED_NAME_INVALID' },
          };
        }

        const capturedSeatId = getActiveSeatId();
        const capturedSeatRevision = getActiveSeatContextRevision();
        const isSeatCurrent = () =>
          getActiveSeatId() === capturedSeatId && getActiveSeatContextRevision() === capturedSeatRevision;
        try {
          const workspaceRoot = await fetchConversationWorkspace(conversationId);
          const staged = stageRecoveredMarkdownInWorkspace({
            workspaceRoot,
            requestedPath: suggestedName,
            markdown,
            seatId: capturedSeatId,
            conversationId,
            turnId,
            toolCallId,
            activeSeatId: getActiveSeatId(),
            isSeatCurrent,
          });
          return {
            success: true,
            data: {
              version,
              ok: true,
              file_name: staged.relativePath,
              size_bytes: staged.bytesWritten,
            },
          };
        } catch (error) {
          const reasonCode =
            error instanceof RecoveredReportStageError || error instanceof ReportStageWorkspaceLookupError
              ? error.reasonCode
              : 'REPORT_STAGE_FAILED';
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Recovered report staging failed.',
            data: { version, ok: false, reason_code: reasonCode },
          };
        }
      }
    );

  // -------------------------------------------------------------------------
  // REPORT EXPORT (Lane C / RPT-1). Turn the active seat's report markdown into
  // a clean OPERATOR-branded PDF / Word / Markdown deliverable on disk, then open
  // it. The SEAT-TRUTH FENCE is enforced in main, fail-closed: exportReport calls
  // assertSeatTruth(content.seatId === getActiveSeatId()) BEFORE any byte is
  // produced — never a cross-seat store query, never a seat-workspace glob. PDF
  // uses Electron's OWN Chromium (createElectronPdfRenderer → offscreen window +
  // printToPDF; no heavy headless-chrome dep). The output is an inert static file
  // (the recipient never logs in), and the brand is the operator's own, never
  // Command EVE. This explicit native Save-As path intentionally remains able
  // to write Desktop/Downloads after dialog.showSave issued a seat-bound
  // FileSelectionGrant; workspace staging must never narrow that user action.
  // -------------------------------------------------------------------------
  bridge
    .buildProvider('command-eve.report-export')
    .provider(
      async (request?: {
        format?: 'pdf' | 'docx' | 'md';
        markdown?: string;
        seatId?: string;
        outputPath?: string;
        title?: string;
        brand?: { displayName?: string; logoDataUri?: string; footer?: string };
      }) => {
        const version = 'command-eve-report-export/v0' as const;
        try {
          const format = request?.format;
          const outputPath = request?.outputPath;
          if (!format || (format !== 'pdf' && format !== 'docx' && format !== 'md')) {
            return {
              success: false,
              msg: 'Unknown export format.',
              data: { version, ok: false, reason_code: 'REPORT_EXPORT_BAD_FORMAT' },
            };
          }
          if (!outputPath || typeof outputPath !== 'string' || outputPath.trim().length === 0) {
            return {
              success: false,
              msg: 'No output path.',
              data: { version, ok: false, reason_code: 'REPORT_EXPORT_NO_OUTPUT' },
            };
          }
          if (
            !consumeCommandEveFileSelectionPathGrant({
              filePath: outputPath,
              seatId: getActiveSeatId(),
              purpose: 'write',
            })
          ) {
            return {
              success: false,
              msg: 'The export destination was not selected in the current save dialog.',
              data: { version, ok: false, reason_code: 'REPORT_EXPORT_OUTPUT_NOT_USER_SELECTED' },
            };
          }

          const content: ReportContent = {
            markdown: typeof request?.markdown === 'string' ? request.markdown : '',
            // The fence re-asserts this against the in-process active seat. We do
            // NOT trust the body for identity beyond the fence equality check.
            seatId: typeof request?.seatId === 'string' ? request.seatId : '',
            title: request?.title,
          };

          const artifact = await exportReport(format, content, {
            brand: request?.brand,
            // Fence target is the AUTHORITATIVE in-process active seat (not the body).
            activeSeatId: getActiveSeatId(),
            pdfRenderer: format === 'pdf' ? createElectronPdfRenderer() : undefined,
          });

          const { promises: fsp } = await import('node:fs');
          await fsp.writeFile(outputPath, artifact.bytes);

          // Open the finished file in the system default app (best-effort).
          try {
            const { shell } = (await import('electron')) as { shell?: { openPath(p: string): Promise<string> } };
            if (shell?.openPath) await shell.openPath(outputPath);
          } catch {
            // Open is a convenience; the file is already written.
          }

          return { success: true, data: { version, ok: true, format, output_path: outputPath } };
        } catch (error) {
          const reason_code = error instanceof SeatTruthFenceError ? error.reasonCode : 'REPORT_EXPORT_FAILED';
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE report export failed.',
            data: { version, ok: false, reason_code },
          };
        }
      }
    );

  // Resolve a picker selection ("Privat lokal" tier OR "EVE Inference" tier)
  // into the TProviderWithModel used as the conversation `model`.
  //
  // SECURITY (H3): the renderer must NEVER receive the raw CEVE license wire.
  // The actual EVE-inference POST happens entirely in the MAIN process — the
  // Hermes/aionrs agent talks to the local loopback OpenAI shim, and that shim's
  // per-request `eveRouting` resolver (buildCommandEveShimRoutingResolver in
  // index.ts) re-reads the wire from the keychain and attaches
  // `Authorization: Bearer <wire>` itself. So the `api_key` on this returned
  // provider is NOT the live authorization credential — carrying it to the
  // renderer (and into persisted conversation params) was a redundant leak of a
  // live bearer. We therefore VERIFY the wire exists (fail-closed: an EVE
  // selection with no usable wire still returns an error so the renderer's
  // graceful local-lane fallback fires) but return the provider WITHOUT the
  // wire. Main re-injects the real bearer at call time.
  bridge
    .buildProvider('command-eve.resolve-inference-provider')
    .provider(async (request?: { selection?: string; localTierId?: string }) => {
      try {
        const selection = request?.selection || '';

        // EVE Inference (cloud) lane.
        const eveTierId: EveInferenceTierId | undefined = parseEveTierIdFromSelection(selection);
        if (isEveInferenceSelection(selection)) {
          if (!eveTierId) {
            return { success: false, msg: 'EVE_INFERENCE_UNKNOWN_TIER', data: undefined };
          }
          const wireResult = readLicenseWire(getDataPath());
          if (!wireResult.ok || !wireResult.wire) {
            return {
              success: false,
              msg: wireResult.reason_code || 'EVE_INFERENCE_NO_BEARER',
              data: undefined,
            };
          }
          // Build the provider with the wire (the builder fail-louds on an empty
          // bearer), then STRIP the wire before it crosses to the renderer. The
          // loopback shim attaches the real bearer in main; the renderer only
          // needs the provider shape (id/base_url/use_model/capabilities) to seed
          // the conversation `model`.
          const { api_key: _wire, ...providerWithoutWire } = buildEveInferenceProvider({
            tierId: eveTierId,
            licenseWire: wireResult.wire,
          });
          const provider = { ...providerWithoutWire, api_key: '' };
          return { success: true, data: { provider, lane: 'eve' as const, tierId: eveTierId } };
        }

        // Connected (BYOK) lane — the operator's OWN provider row.
        //
        // Baustein 3. Resolved HERE and not in the renderer because the row's
        // `api_key` is the operator's credential: it is read from the backend in
        // main, matched against the persisted selection, and the result is
        // returned WITHOUT it (same discipline as the EVE wire above, which is
        // also verified here and stripped before it crosses).
        //
        // IT SENDS since 1.821.0. The conversation still talks to the loopback
        // SHIM — that is the only endpoint the agent ever addresses — and the
        // shim's fourth lane carries the turn onward to the operator's provider,
        // resolving the row and the key itself per turn. So what this branch
        // returns is the shim provider with the BYOK model name on it; the
        // credential is verified here and deliberately NOT handed back, exactly
        // like the EVE wire above.
        if (isConnectedSelection(selection)) {
          const rows = (await httpRequest<IProvider[]>('GET', '/api/providers')) || [];
          const route = resolveConnectedProviderRoute(parseConnectedSelection(selection), rows);
          if (!route) {
            // The row was deleted, disabled, lost its key, or no longer offers
            // this model. Refusing is the only honest answer: substituting the
            // row's first model would be a different turn at a different price,
            // and falling back to local would be the very lie this fixes.
            return { success: false, msg: 'CONNECTED_PROVIDER_UNAVAILABLE', data: undefined };
          }
          // Re-prove the shim row before handing it back, same as the local lane:
          // the agent addresses the shim, so a stale/rewritten row here would
          // become an opaque upstream failure at send time.
          await ensureCommandEveLocalRuntimeProvider();
          const shimProvider = getCommandEveLocalRuntimeProvider();
          return {
            success: true,
            data: {
              // The model NAME travels so the conversation record is honest about
              // what ran; the base_url stays the shim and the operator's key never
              // leaves main.
              provider: { ...shimProvider, use_model: route.model },
              lane: 'connected' as const,
            },
          };
        }

        // Privat (lokal) lane — reuse the bundled local-runtime provider. The
        // local tier id rides either in the selection ("command-eve-local:<id>")
        // mapped by the renderer, or as an explicit localTierId for the
        // commandEveShell tier.
        //
        // Provider rows live in the active seat's backend DB. Re-prove the row
        // before returning the synthetic provider so a transient boot failure
        // becomes an honest not-ready result instead of a later opaque
        // UNKNOWN_UPSTREAM_ERROR during send.
        await ensureCommandEveLocalRuntimeProvider();
        const provider = getCommandEveLocalRuntimeProvider(request?.localTierId);
        return { success: true, data: { provider, lane: 'local' as const } };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE resolve-inference-provider bridge failed.',
          data: undefined,
        };
      }
    });

  // -------------------------------------------------------------------------
  // Credits / billing (Lane 3). The main process holds the CEVE bearer and is
  // the ONLY side that calls the credits-status Edge Function — the renderer
  // never sees the wire. SELF-QUIET: when there is no license wire OR no
  // function URL OR the call fails, we return an `ok:false` zero-status (the
  // meter renders nothing) instead of throwing. This handler is therefore safe
  // to ship BEFORE the Lane-1+2 backend exists (PREPARED).
  // -------------------------------------------------------------------------
  bridge.buildProvider('command-eve.credits-status').provider(async () => {
    // Read the user's persisted spend cap up-front so it rides on every result
    // (even the quiet pre-deploy one) — the meter/wall reflect a cap the user
    // set locally before the server round-trips it back.
    let spendCapEurCents = 0;
    try {
      const stored = await ProcessConfig.get('commandEve.spendCapEurCents');
      if (typeof stored === 'number' && stored > 0) spendCapEurCents = stored;
    } catch {
      // A config read failure must not break the status read.
    }

    try {
      // No Edge Function URL configured ⇒ nothing to call. Quiet, not a crash.
      if (!CREDITS_STATUS_FUNCTION_URL) {
        return {
          success: false,
          msg: 'CREDITS_STATUS_NO_URL',
          data: quietCreditsStatus(spendCapEurCents, 'CREDITS_STATUS_NO_URL'),
        };
      }

      // No usable CEVE bearer ⇒ the user is not yet licensed / activated. Quiet.
      const wireResult = readLicenseWire(getDataPath());
      if (!wireResult.ok || !wireResult.wire) {
        return {
          success: false,
          msg: wireResult.reason_code || 'CREDITS_STATUS_NO_BEARER',
          data: quietCreditsStatus(spendCapEurCents, wireResult.reason_code || 'CREDITS_STATUS_NO_BEARER'),
        };
      }

      // Proxy GET to the credits-status Edge Function with the CEVE license as a
      // bearer. The wire is sent only in the Authorization HEADER (never logged,
      // never returned to the renderer).
      let response: Response;
      try {
        response = await fetch(CREDITS_STATUS_FUNCTION_URL, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${wireResult.wire}`,
            Accept: 'application/json',
          },
          redirect: 'error',
        });
      } catch (networkError) {
        // Network failure (offline / function not deployed) — stay quiet.
        return {
          success: false,
          msg: networkError instanceof Error ? networkError.message : 'CREDITS_STATUS_NETWORK',
          data: quietCreditsStatus(spendCapEurCents, 'CREDITS_STATUS_NETWORK'),
        };
      }

      if (!response.ok) {
        return {
          success: false,
          msg: `CREDITS_STATUS_HTTP_${response.status}`,
          data: quietCreditsStatus(spendCapEurCents, `CREDITS_STATUS_HTTP_${response.status}`),
        };
      }

      const raw = (await response.json().catch((): null => null)) as Record<string, unknown> | null;
      if (!raw || typeof raw !== 'object') {
        return {
          success: false,
          msg: 'CREDITS_STATUS_BAD_BODY',
          data: quietCreditsStatus(spendCapEurCents, 'CREDITS_STATUS_BAD_BODY'),
        };
      }

      const purchasedCredits = finiteCreditNumber(raw.purchased_credits_remaining);
      // CARRY THE REAL TIER (MAT-1749). This used to fold `trial` — a tier the
      // server has always reported — into `free`, which discarded the one signal
      // the MAX gate needs to tell a promotional trial from a paid plan. The
      // renderer's gate is now an explicit paid ALLOWLIST, so passing the true
      // value through is both honest and safe; folding it was masking a defect,
      // not preventing one.
      const rawTier = raw.tier === 'solo' || raw.tier === 'starter' || raw.tier === 'trial' ? raw.tier : 'free';
      // Purchased credits outrank the reported tier: a seat that BOUGHT credits is
      // never surfaced as credit-less, and buying is exactly what unlocks MAX.
      const tier = (!isPaidCreditsTier(rawTier) && purchasedCredits > 0 ? 'starter' : rawTier) as CreditsTier;
      // The user-set local cap takes precedence when present; otherwise honour
      // whatever the server reports.
      const serverCap = finiteCreditNumber(raw.spend_cap_eur_cents, 0);
      const effectiveCap = spendCapEurCents > 0 ? spendCapEurCents : serverCap;

      return {
        success: true,
        data: {
          version: COMMAND_EVE_CREDITS_BRIDGE_VERSION,
          ok: true,
          tier,
          included_allowance_credits_remaining: finiteCreditNumber(raw.included_allowance_credits_remaining),
          purchased_credits_remaining: purchasedCredits,
          spend_cap_eur_cents: Math.max(0, effectiveCap),
          free_actions_used_this_period: finiteCreditNumber(raw.free_actions_used_this_period),
          free_cap: finiteCreditNumber(raw.free_cap),
          period_start: typeof raw.period_start === 'string' ? raw.period_start : '',
          // v1.5 M7: an active credit subscription (recurring top-up) also unlocks
          // Pro features. Additive: an absent field ⇒ false ⇒ today's behavior.
          has_active_topup: raw.has_active_topup === true,
        },
      };
    } catch (error) {
      // Any unexpected failure: never crash the renderer chrome — go quiet.
      return {
        success: false,
        msg: error instanceof Error ? error.message : 'Command EVE credits-status bridge failed.',
        data: quietCreditsStatus(spendCapEurCents, 'CREDITS_STATUS_BRIDGE_FAILED'),
      };
    }
  });

  // -------------------------------------------------------------------------
  // Per-seat usage attribution (v1.5 A3). The main process holds the CEVE bearer
  // and is the ONLY side that calls the seat-usage Edge Function — the renderer
  // never sees the wire. Opaque seat ids ONLY come back (no names — H3); the
  // LABEL join happens in the renderer against the my-seats wire the operator
  // already holds. SELF-QUIET: no license wire / no URL / a network or 404 error
  // (the seat-usage Edge Function is not deployed yet — version-skew) returns an
  // `ok:false` empty model, so the card renders the honest "Verbrauchsdaten ab
  // dem nächsten Server-Update" resting state instead of throwing.
  // -------------------------------------------------------------------------
  bridge
    .buildProvider('command-eve.seat-usage')
    .provider(async (request?: { month?: string } | CommandEveBridgeEnvelope<{ month?: string }>) => {
      const payload = unwrapBridgeRequest<{ month?: string }>(request);
      const month = isValidUsageMonth(payload?.month) ? (payload!.month as string) : currentUsageMonth();
      // Spread FIRST, then state the refusal. The old order put `ok: false` before
      // `...emptySeatUsage(month)`, so the spread overwrote it — harmless only
      // because `emptySeatUsage` also returns `ok: false` (seatUsageCore.ts:349).
      // A refusal helper whose refusal is decided by a different function is one
      // edit away from quietly reporting success. `emptySeatUsage` carries no
      // `version`, `reason_code` or `message`, so nothing else changes hands.
      const quiet = (reasonCode: string, message?: string) => ({
        ...emptySeatUsage(month),
        version: 'command-eve-seat-usage/v0' as const,
        ok: false,
        reason_code: reasonCode,
        ...(message ? { message } : {}),
      });

      try {
        // No Edge Function URL configured ⇒ nothing to call. Quiet, not a crash.
        if (!SEAT_USAGE_FUNCTION_URL) {
          return { success: false, msg: 'SEAT_USAGE_NO_URL', data: quiet('SEAT_USAGE_NO_URL') };
        }

        // No usable CEVE bearer ⇒ not yet licensed/activated. Quiet.
        const wireResult = readLicenseWire(getDataPath());
        if (!wireResult.ok || !wireResult.wire) {
          const reason = wireResult.reason_code || 'SEAT_USAGE_NO_BEARER';
          return { success: false, msg: reason, data: quiet(reason) };
        }

        // Proxy GET with the CEVE license as a bearer (header only — never logged,
        // never returned to the renderer). Same auth pattern as credits-status.
        let response: Response;
        try {
          const url = `${SEAT_USAGE_FUNCTION_URL}?month=${encodeURIComponent(month)}`;
          response = await fetch(url, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${wireResult.wire}`,
              Accept: 'application/json',
            },
            redirect: 'error',
          });
        } catch (networkError) {
          // Offline / function not deployed — stay quiet (version-skew resting state).
          return {
            success: false,
            msg: networkError instanceof Error ? networkError.message : 'SEAT_USAGE_NETWORK',
            data: quiet('SEAT_USAGE_NETWORK'),
          };
        }

        if (!response.ok) {
          // 404 ⇒ the seat-usage Edge Function is not deployed yet (version-skew).
          return {
            success: false,
            msg: `SEAT_USAGE_HTTP_${response.status}`,
            data: quiet(`SEAT_USAGE_HTTP_${response.status}`),
          };
        }

        const raw = (await response.json().catch((): null => null)) as unknown;
        const parsed = parseSeatUsageResponse(raw, month);
        if (!parsed.ok) {
          return { success: false, msg: 'SEAT_USAGE_BAD_BODY', data: quiet('SEAT_USAGE_BAD_BODY') };
        }

        // C1 (Codex): the wire carries EVERY seat's row + the account-wide total, but
        // only the Founder/Admin-Legacy seat may see the all-seat summary. Partition
        // in MAIN so a client/delegate seat NEVER receives sibling seat ids, calls,
        // tokens or retail/RAW cost over the IPC response — the renderer's own filter
        // (BillingModalContent isFounderSummary) is display-only and cannot protect
        // the wire. The all-seat view is authorized only on the legacy owner seat;
        // any switched-in (client/own-company/department) seat is scoped to its own
        // row. The server-side seat-usage function should ALSO partition by the
        // bearer's account/role (defense in depth) — tracked for the server lane.
        const visibleSeatId = isActiveSeatLegacy() ? null : getActiveSeatId();
        const scoped = partitionSeatUsageForViewer(parsed, visibleSeatId);

        return {
          success: true,
          data: buildSeatUsageIpcResult(scoped),
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE seat-usage bridge failed.',
          data: quiet('SEAT_USAGE_BRIDGE_FAILED'),
        };
      }
    });

  // Persist the user's hard spend cap (EUR cents; 0 ⇒ uncapped) via ProcessConfig.
  // This is a LOCAL persistence write — the binding enforcement is the backend's
  // (Lane-2 debit refuses past the cap); the desktop carries the intent so the
  // meter + a future checkout reflect it. SELF-QUIET on a bad/absent value.
  bridge
    .buildProvider('command-eve.credits-set-spend-cap')
    .provider(
      async (
        request?: { spend_cap_eur_cents?: number } | CommandEveBridgeEnvelope<{ spend_cap_eur_cents?: number }>
      ) => {
        try {
          const payload = unwrapBridgeRequest<{ spend_cap_eur_cents?: number }>(request);
          const requested = payload?.spend_cap_eur_cents;
          if (typeof requested !== 'number' || !Number.isFinite(requested) || requested < 0) {
            return {
              success: false,
              msg: 'CREDITS_SPEND_CAP_INVALID',
              data: {
                version: COMMAND_EVE_CREDITS_BRIDGE_VERSION,
                ok: false,
                reason_code: 'CREDITS_SPEND_CAP_INVALID',
                spend_cap_eur_cents: 0,
              },
            };
          }
          const normalized = Math.round(requested);
          await ProcessConfig.set('commandEve.spendCapEurCents', normalized);
          return {
            success: true,
            data: {
              version: COMMAND_EVE_CREDITS_BRIDGE_VERSION,
              ok: true,
              spend_cap_eur_cents: normalized,
            },
          };
        } catch (error) {
          return {
            success: false,
            msg: error instanceof Error ? error.message : 'Command EVE credits-set-spend-cap bridge failed.',
            data: {
              version: COMMAND_EVE_CREDITS_BRIDGE_VERSION,
              ok: false,
              reason_code: 'CREDITS_SPEND_CAP_BRIDGE_FAILED',
              spend_cap_eur_cents: 0,
            },
          };
        }
      }
    );

  // SILENT REINSTALL / relaunch RESUME (no browser): on bridge init, if a
  // session.enc decrypts AND its refresh token is valid, refresh → register-
  // profile → my-license → activateEntitlement WITHOUT any browser. The renderer
  // gate re-reads entitlement-status on mount, so a resumed entitlement opens the
  // gate automatically. Fire-and-forget + a no-op when no session is stored;
  // never blocks bridge init and never throws the chrome.
  void (async () => {
    try {
      const userDataPath = getDataPath();
      await silentResumeAccountAuth(userDataPath, {
        storeLicenseWire: (p, wire) => {
          try {
            storeLicenseWire(p, wire);
          } catch {
            // non-fatal
          }
        },
      });
      if (readRegistration(userDataPath)) await syncRegistrationIdentityArtifactsBestEffort(userDataPath);
    } catch {
      // A dead refresh / network failure just leaves the gate on Login.
    }
  })();

  // ONLINE RE-VERIFY (§2a) — account-first revocation check, FIRE-AND-RECONCILE
  // and OFF the critical path. We never await this before the gate's first render
  // (the renderer reads entitlement-status on mount independently); a conclusive
  // server 'revoked'/'expired' simply drops the local entitlement + license wire
  // so the NEXT gate read lands on registered_unlicensed.
  //
  // SHIP-INERT: this is DEFAULT-INERT (entitlementOnlineCheckCore) — until the
  // founder deploys the entitlement-status Edge Function AND it returns a
  // conclusive verdict, every path is non-conclusive and the local entitlement is
  // left untouched (a valid offline user is NEVER locked out). The enable mode
  // defaults to AUTO (env COMMAND_EVE_ONLINE_REVERIFY=off|on overrides).
  const readWireString = (p: string): string | null => {
    try {
      const r = readLicenseWire(p);
      return r.ok && r.wire ? r.wire : null;
    } catch {
      return null;
    }
  };
  const runOnlineReverify = async (): Promise<void> => {
    try {
      await reconcileEntitlementOnline(getDataPath(), {
        readWire: readWireString,
        clearLicenseWire,
      });
    } catch {
      // A failed/slow check is non-destructive by construction; never throw.
    }
  };
  // Once at boot...
  void runOnlineReverify();
  // ...then periodically (every 6h) while the process lives. unref() so this
  // timer never keeps the app alive on its own.
  const ONLINE_REVERIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const reverifyTimer = setInterval(() => void runOnlineReverify(), ONLINE_REVERIFY_INTERVAL_MS);
  if (typeof reverifyTimer === 'object' && reverifyTimer && typeof reverifyTimer.unref === 'function') {
    reverifyTimer.unref();
  }
}
