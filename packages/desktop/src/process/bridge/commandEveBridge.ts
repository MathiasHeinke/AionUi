/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridge } from '@office-ai/platform';
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
import {
  hasAccountSession,
  readAccountSession,
  revokeAndClearSession,
} from '@process/commandEve/accountSessionAtRest';
import {
  activateEntitlementFromSession,
  silentResumeAccountAuth,
} from '@process/commandEve/accountAuthOrchestratorCore';
import {
  resetEntitlement,
  COMMAND_EVE_ENTITLEMENT_RESET_VERSION,
} from '@process/commandEve/entitlementResetCore';
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
import { buildLocalRuntimeStatus } from '@process/commandEve/localRuntimeStatusCore';
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
  EVE_STRATEGY_SKILL_IDS,
  COMMAND_EVE_ONBOARDING_SKILL_ID,
  COMMAND_EVE_ARTIFACT_MENU_SKILL_ID,
} from '@process/commandEve/runtimeBootstrapCore';
import { buildCommandEveStatusSurface } from '@process/commandEve/statusSurfaceCore';
import { clearLicenseWire, hasLicenseWire, readLicenseWire, storeLicenseWire } from '@/common/config/licenseWireAtRest';
import {
  buildEveInferenceProvider,
  isEveInferenceSelection,
  parseEveTierIdFromSelection,
  type EveInferenceTierId,
} from '@/common/config/eveInferenceCore';
import { getCommandEveLocalRuntimeProvider } from '@/common/config/commandEveShell';
import { CREDITS_STATUS_FUNCTION_URL, type ClientSeedInput, type CreditsTier } from '@/common/config/creditsCore';
import {
  SEAT_USAGE_FUNCTION_URL,
  currentUsageMonth,
  emptySeatUsage,
  isValidUsageMonth,
  parseSeatUsageResponse,
} from '@/common/config/seatUsageCore';
import { ProcessConfig, getSkillsDir, getCronSkillsDir } from '@process/utils/initStorage';
import { getDataPath } from '@process/utils/utils';
import { getActiveSeatId, getActiveSeatKind, resolveActiveSeatHome, sanitizeSeatId } from '@process/commandEve/seatContextCore';
import { isSeatSwitchAuthorized, parseMySeats, resolveSeatAccess } from '@process/commandEve/seatSwitchCore';
import { readMySeatsWire as readMySeatsWireCore } from '@process/commandEve/seatWireFetchCore';
import { readCompanyBrainSeedState, writeCompanyBrainSeed } from '@process/commandEve/companyBrainSeedCore';
import { COMMAND_EVE_HANDOVER_NOTE_RELPATH, HANDOVER_NOTE_MAX_RAW_CHARS } from '@/common/config/startscreenNoteCore';
import nodePath from 'node:path';
import { COMMAND_EVE_DAY_ZERO_BRIEF_ID, listEntries, mirrorBriefBodyToFile, pruneSessionDigests, readEntryBody, reconcileUnindexedEntries, removeEntry, SESSION_DIGEST_KIND, upsertEntry, upsertSystemEntry, type CompanyBrainWriteKind } from '@process/commandEve/companyBrainStoreCore';
import { runSessionDigest, type SessionDigestDeps } from '@process/commandEve/sessionDigestCore';
import {
  createElectronPdfRenderer,
  exportReport,
  SeatTruthFenceError,
  type ReportContent,
} from '@process/commandEve/reportExportCore';

/** Version tag mirrored onto every credits bridge result (ipcBridge contract). */
const COMMAND_EVE_CREDITS_BRIDGE_VERSION = 'command-eve-credits/v0' as const;

/**
 * A SELF-QUIET zero-status returned when the credits-status backend is not
 * reachable pre-deploy (no license wire, or the Edge Function is absent / errors).
 * `ok:false` keeps the renderer meter quiet (it renders nothing) instead of
 * crashing the chrome. The persisted spend cap is still merged in so a cap the
 * user already set survives an offline read.
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
    // v1.5 M7: quiet/pre-deploy read ⇒ no active subscription (fail-closed to
    // locked; Pro features stay gated until a real status confirms an unlock).
    has_active_topup: false,
  };
}

type CommandEveStatusSurfaceRequest = { maxRuns?: number; companyOsRoot?: string; eventLedgerPath?: string };
type CommandEveBridgeEnvelope<T> = { data?: T };

function unwrapBridgeRequest<T>(request?: T | CommandEveBridgeEnvelope<T>): T | undefined {
  if (request && typeof request === 'object' && 'data' in request) {
    return (request as CommandEveBridgeEnvelope<T>).data;
  }
  return request as T | undefined;
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
async function readMySeatsWire(): Promise<unknown | null> {
  return readMySeatsWireCore(getDataPath());
}

/**
 * Persist the B3 active-seat pointer via the set-active-seat edge function.
 * BEST-EFFORT: the local runtime switch already succeeded before this runs, so a
 * failure here must NOT roll back a working local switch (applySeatSwitch treats
 * a throw as persist_failed, not a switch failure). PREPARED: the set-active-seat
 * function is AUTHORED-not-deployed, so this is a no-op today (the next launch
 * re-derives the active seat). The server-side IDOR guard (target in the
 * caller's authorized set) is enforced by the function, not here.
 */
async function persistActiveSeatPointer(seatId: string): Promise<void> {
  // PREPARED: no set-active-seat function deployed yet ⇒ no-op (local switch stands).
  void seatId;
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
}> {
  try {
    const { readCommandEveSettingsFromBackend } = await import('@process/commandEve/commandEveBackendSettingsRead');
    const { codexRuntimeForConfig, resolveAssignedClaudeDelegate } = await import('@/common/config/eveWorkerAssignmentCore');
    type EveWorkerAssignmentMap = import('@/common/config/eveWorkerAssignmentCore').EveWorkerAssignmentMap;
    type EveTeamWorkerStatusMap = import('@/common/config/eveTeamControlsCore').EveTeamWorkerStatusMap;
    const bag = await readCommandEveSettingsFromBackend(['commandEve.workerAssignments', 'commandEve.teamWorkerStatus']);
    const assignmentsRaw = bag['commandEve.workerAssignments'];
    const statusesRaw = bag['commandEve.teamWorkerStatus'];
    const assignments =
      assignmentsRaw && typeof assignmentsRaw === 'object'
        ? (Object.fromEntries(
            Object.entries(assignmentsRaw as Record<string, { kind: string; cli_path?: string; cli_version?: string }>).map(
              ([id, v]) => [id, { agent_id: id, ...v }]
            )
          ) as EveWorkerAssignmentMap)
        : ({} as EveWorkerAssignmentMap);
    const statuses =
      statusesRaw && typeof statusesRaw === 'object' ? (statusesRaw as EveTeamWorkerStatusMap) : ({} as EveTeamWorkerStatusMap);
    return {
      reachable: true,
      codexRuntime: codexRuntimeForConfig(assignments),
      claudeDelegate: resolveAssignedClaudeDelegate(assignments, statuses),
    };
  } catch (error) {
    // F7: the settings READ threw → backend unreachable. Report reachable:false so
    // the switch's prepareEnv does NOT re-provision on degraded (empty) inputs.
    console.warn('[Command EVE] seat-switch worker-runtime input read UNREACHABLE; last-known-good runtime files will be kept (no re-provision):', error);
    return { reachable: false, codexRuntime: '', claudeDelegate: null };
  }
}

// IN-FLIGHT LOCK for command-eve.switch-seat. A switch is a real STOP+RE-SPAWN of
// the backend under a new HERMES_HOME; two overlapping switches would interleave
// lifecycles (orphaned process, nondeterministic landing seat). The renderer's 45s
// timeout can re-enable the rail BEFORE main finishes, so the renderer disabled
// state is NOT a sufficient guard — this single main-process boolean is the real
// serialization boundary (there is exactly one main process).
let commandEveSwitchSeatInFlight = false;
// EPOCH for the lock. Bumped each time the lock is taken; a release only fires if its
// epoch is still current. This stops a LATE-completing switch (one whose watchdog
// already force-released the lock, after which a NEW switch took it) from clobbering
// the new switch's lock in its stale finally.
let commandEveSwitchSeatEpoch = 0;
// WATCHDOG bound for the lock — a pure LIVENESS BACKSTOP, not a completion guarantee.
// If applySeatSwitch's await never settles (a hung re-spawn whose start() never binds
// its port), the finally never runs and the lock would stay true for the whole session,
// wedging EVERY future switch behind a misleading "kurz warten". The watchdog force-
// releases the lock so a hung switch degrades to retryable.
//   It is set FAR above any plausible respawn ceiling (5 min), NOT merely above the
// renderer's 45s timeout: 60s > 45s would NOT have guaranteed 60s > respawn time, so a
// legitimately slow respawn could trip it mid-flight and admit a concurrent switch. At
// 5 min the respawn is provably dead, so a retry is correct.
//   Safety on the rare post-watchdog retry does NOT rest on the bound: a NEW switch's
// restartBackend ALWAYS runs backendManager.stop() FIRST, which SIGTERMs→SIGKILLs (5s)
// the existing process tree before its start() — so two backends never truly coexist.
// The SEAT pointer is then deterministic (last setActiveSeatId wins). The GLOBAL respawn
// state the restart hook publishes (__backendPort, cron-resume bridge, assistant prompt)
// is NOT seat-pointer state, so a stale superseded respawn could clobber it on its late
// return; that is closed separately by the respawn-generation guard in index.ts (the hook
// bails its post-start writes if a newer respawn ran). This lock comment does not claim
// to cover that global state.
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
): { success: false; msg: string; data: { version: V; ok: false; status: 'blocked'; reason_code: 'SEAT_SWITCH_IN_PROGRESS'; message: string } } | null {
  if (!commandEveSwitchSeatInFlight) return null;
  const message = 'A seat switch is in progress — the board write was refused to protect per-seat isolation.';
  return {
    success: false,
    msg: 'SEAT_SWITCH_IN_PROGRESS',
    data: { version, ok: false, status: 'blocked', reason_code: 'SEAT_SWITCH_IN_PROGRESS', message },
  };
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
function guardBrainMutationDuringSwitch(): { success: false; msg: string; data: { ok: false; reason_code: 'SEAT_SWITCH_IN_PROGRESS'; message: string } } | null {
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

/** Resolve the local aioncore backend port the restart hook publishes (main-side). */
function getCommandEveBackendPort(): number | undefined {
  return (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
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
 * a bounded page_size window. The backend wraps the payload in { data: { items } };
 * we return the raw items array (sessionDigestCore's extractTranscriptText tolerates
 * the compact shape). No auth (loopback-only routes). Returns [] on any failure.
 */
async function fetchConversationTranscript(conversationId: string, window: number): Promise<unknown> {
  const port = getCommandEveBackendPort();
  if (!port) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SESSION_DIGEST_TIMEOUT_MS);
  try {
    const url = `http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(conversationId)}/messages?page=1&page_size=${Math.max(1, Math.floor(window))}&content_mode=compact`;
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
    const res = await fetch(`http://127.0.0.1:${port}/api/conversations?limit=10000`, { method: 'GET', signal: controller.signal });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: { items?: Array<Record<string, unknown>> } | null; items?: Array<Record<string, unknown>> };
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
  // COMMAND_EVE_MCP_VAULT_ENABLED (default false): the record is written + vetted,
  // but the reconcile re-render emits it into config.yaml ONLY when the flag flips
  // (the separate GATE-NULL slice). connectorCatalogCore's global
  // mcp_enable_allowed / connector_write_allowed stay FALSE (no global flip).
  // -------------------------------------------------------------------------
  bridge.buildProvider('command-eve.guided-auth-setup').provider(
    async (request?: {
      connectorId?: string;
      secrets?: Record<string, string>;
      scope?: 'founder' | 'seat';
      seatId?: string;
      humanGateReceipt?: string;
      manifestPath?: string;
    }) => {
      const version = 'command-eve-guided-auth-setup/v0' as const;
      try {
        const { runGuidedApiKeySetup } = await import('@process/commandEve/guidedAuthSetupCore');
        const { referenceMcpInvocationFor } = await import('@process/commandEve/curatedConnectorReference');
        const { reconcileVaultConfigAfterConnectorChange } = await import(
          '@process/commandEve/reconcileHermesMcpConfigWiring'
        );

        const connectorId = typeof request?.connectorId === 'string' ? request.connectorId.trim() : '';
        if (!connectorId) {
          return { success: false, msg: 'GUIDED_AUTH_CONNECTOR_ID_MISSING', data: { version, ok: false } };
        }

        // Resolve the connector's stdio mcp_invocation: prefer the authoritative
        // manifest (buildConnectorCatalog), fall back to the sandbox reference for
        // the reference LIVE connector (Notion) so it can be set up sandbox-alone.
        let invocation = referenceMcpInvocationFor(connectorId);
        try {
          const catalog = buildConnectorCatalog({ manifestPath: request?.manifestPath });
          const fromManifest = catalog.model?.connectors.find((c) => c.id === connectorId)?.mcp_invocation;
          if (fromManifest) invocation = fromManifest;
        } catch {
          // manifest unavailable — keep the reference fallback (Notion) if any.
        }

        const paths = resolveCommandEveRuntimeBootstrapPaths(getDataPath());
        const result = runGuidedApiKeySetup({
          connector_id: connectorId,
          mcp_invocation: invocation,
          secrets: request?.secrets ?? {},
          scope: request?.scope === 'seat' ? 'seat' : 'founder',
          seat_id: request?.scope === 'seat' ? getActiveSeatId() : undefined,
          human_gate_receipt: typeof request?.humanGateReceipt === 'string' ? request.humanGateReceipt : '',
          userDataPath: paths.userDataPath,
          configRoot: paths.hermesRoot,
        });

        if (!result.ok) {
          return { success: false, msg: result.reason_code, data: { version, ...result } };
        }

        // Reconcile (re-render config.yaml from the vault + respawn). Behind the
        // flag this is a NO-OP receipt today (byte-identical config.yaml).
        const reconcile = await reconcileVaultConfigAfterConnectorChange('approve');
        return {
          success: true,
          data: { version, ...result, reconcile },
        };
      } catch (error) {
        return {
          success: false,
          msg: error instanceof Error ? error.message : 'Command EVE guided auth setup bridge failed.',
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
  bridge
    .buildProvider('command-eve.learned-skills')
    .provider(async () => {
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
  bridge
    .buildProvider('command-eve.authored-skills')
    .provider(async () => {
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
        const result = buildLocalRuntimeStatus({
          userDataPath: getDataPath(),
          manifestPath: request?.manifestPath,
          receiptPath: request?.receiptPath,
        });
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
  bridge
    .buildProvider('command-eve.company-brain-seed')
    .provider(async (request?: { seed?: ClientSeedInput }) => {
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
            upsertEntry(result.hermesHome, {
              id: COMMAND_EVE_DAY_ZERO_BRIEF_ID,
              kind: 'brief',
              title: 'Day-0 Briefing',
              body: result.record.value,
              author: 'user',
              source: 'seed-migration',
            });
          } catch (error) {
            console.warn('[Command EVE] seed→brain brief entry upsert failed (seed itself succeeded):', error);
          }
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
      const entries = listEntries(home);
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
        return { success: false, msg: 'COMPANY_BRAIN_READ_BAD_REQUEST', data: { ok: false, reason_code: 'COMPANY_BRAIN_READ_BAD_REQUEST', body: null } as unknown };
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
          return { success: false, msg: 'COMPANY_BRAIN_WRITE_BAD_REQUEST', data: { ok: false, reason_code: 'COMPANY_BRAIN_WRITE_BAD_REQUEST' } as unknown };
        }
        const home = resolveActiveSeatHome(getDataPath()).hermesHome;
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
        return { success: false, msg: 'COMPANY_BRAIN_REMOVE_BAD_REQUEST', data: { ok: false, reason_code: 'COMPANY_BRAIN_REMOVE_BAD_REQUEST' } as unknown };
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
    try {
      home = resolveActiveSeatHome(getDataPath()).hermesHome;
    } catch {
      return { success: false, msg: 'SESSION_DIGEST_NO_SEAT', data: { ok: false, reason_code: 'SESSION_DIGEST_NO_SEAT', outcome: 'error' } as unknown };
    }
    const deps: SessionDigestDeps = {
      isSwitchInFlight: () => commandEveSwitchSeatInFlight,
      fetchTranscript: (id, window) => fetchConversationTranscript(id, window),
      resolveTitle: (id) => fetchConversationTitle(id),
      generateDigest: (prompt) => generateLocalDigest(prompt),
      writeDigestEntry: ({ id, title, body, now }) => {
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
        boardSlug?: string;
        eventLedgerPath?: string;
      }) => {
        const fenced = guardKanbanMutationDuringSwitch('command-eve-kanban-marketing-card-create/v0');
        if (fenced) return fenced;
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
        boardSlug?: string;
        eventLedgerPath?: string;
      }) => {
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
  // Account auth (browser-loopback, P1). The whole PKCE/loopback/token exchange
  // + post-session orchestration runs HERE in the main process; the renderer
  // only triggers it and reads back the gate status. Tokens never cross the
  // bridge. PREPARED: the web /auth/desktop page + desktop-auth-broker are not
  // live yet, so a real login returns a typed BROKER_HTTP_*/OPEN failure and the
  // UI keeps the paste fallback — this handler is safe to ship now.
  // -------------------------------------------------------------------------
  bridge
    .buildProvider('command-eve.auth-web-login')
    .provider(async (request?: { intent?: DesktopAuthIntent }) => {
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

        const result = await activateEntitlementFromSession(userDataPath, session, {
          storeLicenseWire: (p, wire) => {
            try {
              storeLicenseWire(p, wire);
            } catch {
              // non-fatal
            }
          },
        });

        return {
          success: result.activated,
          msg: result.activated ? undefined : result.reason_code,
          data: {
            version,
            ok: result.activated,
            entitled: result.status.state === 'entitled',
            needs_paste: result.needsPaste,
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

        const result = await activateEntitlementFromSession(userDataPath, session, {
          storeLicenseWire: (p, wire) => {
            try {
              storeLicenseWire(p, wire);
            } catch {
              // non-fatal
            }
          },
        });

        return {
          success: result.activated,
          msg: result.activated ? undefined : result.reason_code,
          data: {
            version,
            ok: result.activated,
            entitled: result.status.state === 'entitled',
            needs_paste: result.needsPaste,
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
      await revokeAndClearSession(getDataPath());
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
  // ?intent=add_seat / ?pack_eur=<n> deep-links) in the system browser WITH the
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
      const { buildAccountWebUrl, COMMAND_EVE_WEB_ORIGIN } = await import('@process/commandEve/accountWebHandoffCore');
      const path = typeof request?.path === 'string' && request.path.startsWith('/') ? request.path : '/account';

      // Read the session at rest (MAIN only). getFreshSession rotates a near-expiry
      // access token; we only need the refresh_token, which the website exchanges.
      let refreshToken: string | undefined;
      try {
        const { getFreshSession } = await import('@process/commandEve/accountSessionAtRest');
        const fresh = await getFreshSession(getDataPath());
        if (fresh.ok && fresh.session?.refresh_token) {
          refreshToken = fresh.session.refresh_token;
        }
      } catch {
        // No/failed session → carry no token; the naked URL below still opens.
        refreshToken = undefined;
      }

      // Build the URL in MAIN (token stays here); origin is pinned to command-eve.com.
      const url = buildAccountWebUrl(COMMAND_EVE_WEB_ORIGIN, path, refreshToken);
      await openExternal(url);
      // NEVER return the url (it may carry the fragment token) — only ok + whether
      // a session was carried (a boolean, not the token) for the renderer's UX.
      return { success: true, data: { ok: true, carried_session: Boolean(refreshToken) } };
    } catch (error) {
      // Even on a failure to read/build/open with the token, try the NAKED url so
      // the operator still reaches the site (logged out → /login). Never throw the
      // chrome; never log the token (there is none to log on this path).
      try {
        const path = typeof request?.path === 'string' && request.path.startsWith('/') ? request.path : '/account';
        await openExternal(`https://command-eve.com${path}`);
      } catch {
        // opening the browser genuinely failed — still report ok:true so the buy
        // path never hard-fails; the renderer keeps its own copy-link fallback.
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
      const result = await resetEntitlement(getDataPath(), {
        clearLicenseWire,
        revokeAndClearSession,
      });
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
      let name = registration?.name;
      let email = registration?.email;
      let company = registration?.company;
      if (hasSession) {
        const read = readAccountSession(userDataPath);
        if (read.ok && read.session) {
          // Email is the LOGIN identity → the session is authoritative.
          email = read.session.user.email || email;
          // Name + company are LOCALLY EDITABLE (account panel, 1.2.13). A present
          // local registration value is the user's explicit edit and OUTRANKS the
          // session-derived value for display; only fall back to the session when
          // the local record has none.
          name = registration?.name || read.session.user.name || name;
          company = registration?.company || read.session.user.company || company;
        }
      }
      return {
        success: true,
        data: {
          version,
          ok: true,
          registered: Boolean(registration),
          has_session: hasSession,
          ...(name ? { name } : {}),
          ...(email ? { email } : {}),
          ...(company ? { company } : {}),
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
      seats: [] as Array<{ seat_id: string; name: string; kind: 'client' | 'own_company' | 'department'; role: 'admin' | 'delegate'; is_active: boolean }>,
    };
    try {
      const wire = await readMySeatsWire();
      if (!wire) {
        // No my-seats source live yet ⇒ fail-closed single legacy seat.
        return { success: true, data: { version, ok: true, contract: legacyContract, source: 'legacy_fallback' } };
      }
      const parsed = parseMySeats(wire);
      if (!parsed) {
        return { success: true, data: { version, ok: true, contract: legacyContract, source: 'legacy_fallback' } };
      }
      return { success: true, data: { version, ok: true, contract: parsed, source: 'my_seats' } };
    } catch (error) {
      // ANY failure ⇒ fail-closed single legacy seat (never widen on error).
      return {
        success: true,
        msg: error instanceof Error ? error.message : undefined,
        data: { version, ok: true, contract: legacyContract, source: 'legacy_fallback' },
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
    // must never wedge behind a stuck digest). Doing this before the lock leaves a tiny
    // window for a second switch to enter concurrently; that is acceptable — a second
    // switch during a ≤3s flush is vanishingly rare and still hits the lock below.
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

    commandEveSwitchSeatInFlight = true;
    const myEpoch = ++commandEveSwitchSeatEpoch;
    // Release only if THIS switch still owns the lock (epoch unchanged) — never clobber
    // a newer switch that took the lock after our watchdog force-released it.
    const releaseLock = () => {
      if (commandEveSwitchSeatEpoch === myEpoch) commandEveSwitchSeatInFlight = false;
    };
    // Arm the watchdog (see the bound above) so a never-settling respawn cannot leave
    // the lock stuck. Cleared in finally on every normal/error exit.
    const lockWatchdog = setTimeout(releaseLock, COMMAND_EVE_SWITCH_SEAT_LOCK_TIMEOUT_MS);
    try {
      const targetSeatId = typeof request?.seatId === 'string' ? request.seatId : '';
      if (!targetSeatId) {
        return { success: false, msg: 'Missing seatId.', data: { version, ok: false, reason_code: 'SWITCH_SEAT_NO_TARGET', active_seat_id: getActiveSeatId() } };
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
      const { prepareCommandEveRuntimeProcessEnv, provisionSeatRuntimeFiles } = await import('@process/commandEve/runtimeBootstrapCore');
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

      const result = await applySeatSwitch(targetSeatId, {
        prepareEnv: async () => {
          prepareCommandEveRuntimeProcessEnv(getDataPath());
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
                  `[Command EVE] Seat-switch runtime provisioning failed for ${sanitizedTarget ?? targetSeatId} (${provisioned.hermes_home}); the switch proceeds on best-effort. Cause: ${provisioned.error ?? 'unknown'}`
                );
              } else if (provisioned.bundled_skill_failures.length) {
                console.warn(
                  `[Command EVE] Seat-switch runtime provisioning: bundled EVE strategy skills missing/invalid for ${sanitizedTarget ?? targetSeatId}: ${provisioned.bundled_skill_failures.join(', ')}`
                );
              }
            }
          } catch (error) {
            // Defensive: the resolver / import path itself failing must not fail the switch.
            console.warn('[Command EVE] Seat-switch runtime provisioning threw; the switch proceeds on best-effort:', error);
          }
          // S5-P2 vault reconcile (arch §7): refresh the TARGET seat's config.yaml
          // from the vault BEFORE applySeatSwitch's own restartBackend — so a seat's
          // Founder-connectors are present on entry. respawnAfter:false because the
          // switch lifecycle already owns the single respawn (the step right after
          // this prepareEnv). Behind COMMAND_EVE_MCP_VAULT_ENABLED (default false):
          // while off, the reRenderConfig closure is a no-op returning 0, so seat
          // switch behavior stays BYTE-IDENTICAL to today (no extra bootstrap run).
          // Runs AFTER the base provisioning above so, once the flag is on, the vault
          // re-render layers on top of a config.yaml that already exists.
          await reconcileVaultConfigForSeatSwitch();
        },
        restartBackend: () => restartCommandEveBackendForSeat(),
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
        persistActiveSeat: async (seatId) => {
          await persistActiveSeatPointer(seatId);
        },
      }, targetLabel, targetKind);

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
      releaseLock();
    }
  });

  // -------------------------------------------------------------------------
  // REPORT EXPORT (Lane C / RPT-1). Turn the active seat's report markdown into
  // a clean OPERATOR-branded PDF / Word / Markdown deliverable on disk, then open
  // it. The SEAT-TRUTH FENCE is enforced in main, fail-closed: exportReport calls
  // assertSeatTruth(content.seatId === getActiveSeatId()) BEFORE any byte is
  // produced — never a cross-seat store query, never a seat-workspace glob. PDF
  // uses Electron's OWN Chromium (createElectronPdfRenderer → offscreen window +
  // printToPDF; no heavy headless-chrome dep). The output is an inert static file
  // (the recipient never logs in), and the brand is the operator's own, never
  // Command EVE.
  // -------------------------------------------------------------------------
  bridge.buildProvider('command-eve.report-export').provider(
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
          return { success: false, msg: 'Unknown export format.', data: { version, ok: false, reason_code: 'REPORT_EXPORT_BAD_FORMAT' } };
        }
        if (!outputPath || typeof outputPath !== 'string' || outputPath.trim().length === 0) {
          return { success: false, msg: 'No output path.', data: { version, ok: false, reason_code: 'REPORT_EXPORT_NO_OUTPUT' } };
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

        // Privat (lokal) lane — reuse the bundled local-runtime provider. The
        // local tier id rides either in the selection ("command-eve-local:<id>")
        // mapped by the renderer, or as an explicit localTierId for the
        // commandEveShell tier.
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
        return { success: false, msg: 'CREDITS_STATUS_NO_URL', data: quietCreditsStatus(spendCapEurCents, 'CREDITS_STATUS_NO_URL') };
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
        return { success: false, msg: 'CREDITS_STATUS_BAD_BODY', data: quietCreditsStatus(spendCapEurCents, 'CREDITS_STATUS_BAD_BODY') };
      }

      const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
      const tier = (raw.tier === 'solo' || raw.tier === 'starter' ? raw.tier : 'free') as CreditsTier;
      // The user-set local cap takes precedence when present; otherwise honour
      // whatever the server reports.
      const serverCap = num(raw.spend_cap_eur_cents, 0);
      const effectiveCap = spendCapEurCents > 0 ? spendCapEurCents : serverCap;

      return {
        success: true,
        data: {
          version: COMMAND_EVE_CREDITS_BRIDGE_VERSION,
          ok: true,
          tier,
          included_allowance_credits_remaining: num(raw.included_allowance_credits_remaining),
          purchased_credits_remaining: num(raw.purchased_credits_remaining),
          spend_cap_eur_cents: Math.max(0, effectiveCap),
          free_actions_used_this_period: num(raw.free_actions_used_this_period),
          free_cap: num(raw.free_cap),
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
      const quiet = (reasonCode: string, message?: string) => ({
        version: 'command-eve-seat-usage/v0' as const,
        ok: false,
        reason_code: reasonCode,
        ...(message ? { message } : {}),
        ...emptySeatUsage(month),
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
          return { success: false, msg: `SEAT_USAGE_HTTP_${response.status}`, data: quiet(`SEAT_USAGE_HTTP_${response.status}`) };
        }

        const raw = (await response.json().catch((): null => null)) as unknown;
        const parsed = parseSeatUsageResponse(raw, month);
        if (!parsed.ok) {
          return { success: false, msg: 'SEAT_USAGE_BAD_BODY', data: quiet('SEAT_USAGE_BAD_BODY') };
        }

        return {
          success: true,
          data: {
            version: 'command-eve-seat-usage/v0' as const,
            ok: true,
            month: parsed.month,
            seats: parsed.seats,
            total: parsed.total,
          },
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
    .provider(async (request?: { spend_cap_eur_cents?: number } | CommandEveBridgeEnvelope<{ spend_cap_eur_cents?: number }>) => {
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
    });

  // SILENT REINSTALL / relaunch RESUME (no browser): on bridge init, if a
  // session.enc decrypts AND its refresh token is valid, refresh → register-
  // profile → my-license → activateEntitlement WITHOUT any browser. The renderer
  // gate re-reads entitlement-status on mount, so a resumed entitlement opens the
  // gate automatically. Fire-and-forget + a no-op when no session is stored;
  // never blocks bridge init and never throws the chrome.
  void (async () => {
    try {
      await silentResumeAccountAuth(getDataPath(), {
        storeLicenseWire: (p, wire) => {
          try {
            storeLicenseWire(p, wire);
          } catch {
            // non-fatal
          }
        },
      });
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
