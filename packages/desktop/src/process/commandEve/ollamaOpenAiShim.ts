/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'crypto';
import fs from 'fs';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import path from 'path';
import {
  evaluateCommandEveEgressBoundary,
  redactCommandEveSensitiveTextAtOrAbove,
  writeCommandEveEgressBoundaryReceipt,
  type CommandEveEgressPolicyAction,
  type CommandEveSensitivityClass,
} from './egressBoundaryCore';
import {
  COMMAND_EVE_OPERATION_DECISION_HEADER,
  commandEvePaidSeamRefusalBody,
  readCommandEveDeclaredOperation,
  resolveCommandEvePaidSeam,
  type CommandEvePaidSeamSource,
} from './paidOperationRegistryCore';
import { isLegacySeatId, sanitizeSeatId } from './seatContextCore';
import {
  CommandEveManagedVisualAuthorizationError,
  isCommandEveManagedVisualAuthorizationError,
  isCommandEveShimPublicError,
  type CommandEveManagedVisualRefusalReason,
} from './shimPublicError';
import { EVE_AUTHORITY_FAIL_CLOSED } from '../../common/config/eveAuthorityCore';
import {
  decideCommandApproval,
  decideHermesToolApproval,
  renderEveAuthorityRuntime,
  type EveAuthorityRuntime,
} from '../../common/config/eveAuthorityRuntimeCore';
import { evaluateWorkerDispatch, type EveTeamWorkerStatusMap } from '../../common/config/eveTeamControlsCore';
import { EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS } from '../../common/config/eveInferenceCore';
import { scrubModelIdentifiers } from '../../common/config/modelIdentifierScrub';
import { EVE_SERVED_MODEL_IDENTIFIERS } from '@/common/config/cloudModelIdentifiers';
import { buildCommandEveContextPolicy, type CommandEveContextPolicy } from '../../common/config/eveContextPolicyCore';
import {
  COMMAND_EVE_BONSAI_ACP_MODEL_ID,
  COMMAND_EVE_BONSAI_LOCAL_TIER_ID,
  COMMAND_EVE_BONSAI_RUNTIME_MODEL_ID,
  getCommandEveLocalModelTier,
  normalizeCommandEveLocalRuntimeModelId,
} from '../../common/config/commandEveShell';
import { HONCHO_DERIVER_FORCED_TIER } from './honchoRuntimeConfigCore';
import { stripCommandEveManagedVisualTurnMarkers } from '../../common/config/eveManagedVisualTurnCore';
import { executeCommandEveManagedImageGeneration } from './managedImageGenerationService';
import {
  extractOllamaCompletedTypedUIPublishCalls,
  extractOpenAICompletedTypedUIPublishCalls,
  newTypedUIProviderRequestId,
  OpenAITypedUIPublishSseCapture,
  reportCapturedTypedUIProviderCompletions,
} from './typedUIProviderCompletionCapture';
import type { MainOwnedTypedUIProviderCompletionInput } from './typedUIProvenanceAttestationCore';

/**
 * The wire tiers this shim will forward — the SERVER's allow-list, not the whole
 * registry.
 *
 * Deriving it from EVE_INFERENCE_TIERS made every registry rung valid here,
 * including ones the Edge Function refuses. Such a tier passed this check, went
 * upstream, and came back 403 — after the request had already been made. Gating
 * on what the server accepts turns that into a local refusal BEFORE any call, so
 * a tier the server would reject can never reach it (HONEST TIER ROUTING,
 * 1.2.19).
 */
const KNOWN_EVE_WIRE_TIERS: ReadonlySet<string> = new Set(EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS);

const DEFAULT_SHIM_PORT = 25811;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_NUM_CTX = 32_768;
const DEFAULT_MAX_TOKENS = 512;
// Keep the selected local model resident through normal chat pauses, while
// still releasing its memory after a bounded idle window. `-1` would retain
// it indefinitely and is deliberately not used.
export const COMMAND_EVE_LOCAL_MODEL_KEEP_ALIVE = '30m';
const COMMAND_EVE_OLLAMA_RESIDENCY_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_UPSTREAM_FIRST_BYTE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
let bootShimAuthToken = '';

export function resolveCommandEveShimListenPort(
  requestedPort: number | undefined,
  env: NodeJS.ProcessEnv = process.env
): number {
  if (requestedPort !== undefined) return requestedPort;
  return env.AIONUI_E2E_TEST === '1' ? 0 : DEFAULT_SHIM_PORT;
}

/** A process-local nonce that protects the predictable loopback inference port. */
export function ensureCommandEveShimAuthToken(): string {
  if (!bootShimAuthToken) bootShimAuthToken = crypto.randomBytes(32).toString('hex');
  return bootShimAuthToken;
}

/**
 * OpenAI-compatible URL of the shim owned by this Electron main process.
 *
 * Normal packaged launches use the canonical 25811 port. Explicit E2E mode
 * binds port 0 so parallel/dev instances cannot collide; in that mode a URL is
 * unsafe until the server has actually selected its ephemeral port.
 */
export function getCommandEveOllamaOpenAiShimBaseUrl(): string {
  if (serverUrl) return `${serverUrl.replace(/\/+$/, '')}/v1`;
  if (resolveCommandEveShimListenPort(undefined) === 0) {
    throw new Error('Command EVE loopback shim has not selected its E2E port yet.');
  }
  return `http://127.0.0.1:${DEFAULT_SHIM_PORT}/v1`;
}

export function commandEveShimAuthTokenFilePath(dataPath: string): string {
  return path.join(path.resolve(dataPath), 'command-eve-runtime', 'shim-auth-token');
}

/**
 * File-deliver the local nonce to Hermes. Only the path enters the shared child
 * environment; no cloud credential is stored or exposed here.
 */
export function provisionCommandEveShimAuthTokenFile(dataPath: string): string {
  const file = commandEveShimAuthTokenFilePath(dataPath);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ensureCommandEveShimAuthToken(), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return file;
  } catch (error) {
    console.warn('[Command EVE] shim auth token file provisioning failed:', error);
    return '';
  }
}

/**
 * Resolved EVE Inference (cloud) route for the CURRENT chat. The shim is the
 * single OpenAI-compatible egress chokepoint Hermes points its inference at
 * (config.yaml `model.base_url` = this shim). Hermes always sends the same
 * local model ref, so it cannot itself signal "the user picked an EVE cloud
 * tier" — therefore the shim asks this resolver, per request, whether to route
 * the call to the eve-inference Edge Function instead of local Ollama.
 *
 * The resolver is injected at shim startup (main process) so it can read the
 * live picker selection + the keychain-at-rest CEVE license; the shim core
 * itself stays pure and unit-testable (the resolver is a plain function).
 *
 * Returning `undefined` (or `{ active: false }`) keeps the request on the local
 * Ollama lane. Returning `{ active: true, functionUrl, license, tier }` routes
 * it to the function with `Authorization: Bearer <license>` and `tier` in body.
 */
export type CommandEveManagedVisualPolicyClaim = Readonly<{
  seatId: string;
  seatContextRevision: number;
  flowId: string;
  receiptId: string;
}>;

export type CommandEveEveCloudRoute = {
  active: boolean;
  /** Absolute https URL of the eve-inference Edge Function. */
  functionUrl?: string;
  /** The CEVE license wire string used verbatim as the bearer credential. */
  license?: string;
  /** Wire tier value POSTed in the body (e.g. "standard"). */
  tier?: string;
  /**
   * Main-only final egress gate for a consumed managed-visual marker. Ordinary
   * cloud chat and Honcho routes omit this callback and remain unchanged.
   */
  authorizeManagedVisualEgress?: () => boolean | Promise<boolean>;
};

/**
 * Per-request resolver: is the active selection an EVE cloud tier?
 *
 * MAY be async: the live picker selection lives in the aioncore BACKEND settings
 * store (the renderer's configService writes `commandEve.inferenceSelection` to
 * `/api/settings/client`, NOT to the main-process ProcessConfig JSON), so the
 * resolver reads it over HTTP per request. The shim awaits the result. A sync
 * resolver (returning the route directly) is still accepted for tests / the
 * no-op default.
 */
export type CommandEveEveRoutingResolver = (
  body?: Record<string, unknown>
) => CommandEveEveCloudRoute | undefined | Promise<CommandEveEveCloudRoute | undefined>;

export type CommandEveLocalOpenAiRoute = {
  active: boolean;
  /** Strict IPv4 loopback OpenAI base URL, including `/v1`. */
  baseUrl?: string;
  /** Provider-owned model alias sent upstream instead of Hermes' stable local ref. */
  model?: string;
  /** Per-boot bearer used only between the EVE shim and the managed local server. */
  apiKey?: string;
  /** Receipt-only provider label. Never rendered as a user-facing backend selector. */
  providerName?: string;
  /** Provider-specific request allowlist. Colibrì rejects several llama.cpp extensions. */
  payloadProfile?: 'default' | 'colibri';
};

export type CommandEveLocalOpenAiRoutingResolver = (
  requestedModel: string
) => CommandEveLocalOpenAiRoute | undefined | Promise<CommandEveLocalOpenAiRoute | undefined>;

/**
 * The operator's OWN provider (BYOK), resolved in main from `/api/providers`.
 *
 * Unlike {@link CommandEveLocalOpenAiRoute} this one leaves the machine, so the
 * base URL is NOT loopback and the key is the operator's real credential. It
 * rides here and nowhere else: never in a body, never in a log, never in an
 * error message.
 */
export type CommandEveConnectedProviderRoute = {
  active: boolean;
  /** Non-loopback OpenAI-compatible base URL. See {@link classifyConnectedProviderHost}. */
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Display label for the receipt. Never a user-facing backend selector. */
  providerName?: string;
};

export type CommandEveConnectedProviderRoutingResolver = () =>
  | CommandEveConnectedProviderRoute
  | undefined
  | Promise<CommandEveConnectedProviderRoute | undefined>;

/**
 * Per-request resolver for the persisted "Dein Team" worker-status map
 * (`commandEve.teamWorkerStatus`). Injected at shim startup (main process) so
 * the shim can READ the live pause/throttle/fire state and actually gate a
 * delegated worker's dispatch (DUX-4). Returns the status map, or `undefined`
 * when there is none — in which case every worker defaults to active (no-op
 * gating, exactly as before this resolver existed).
 *
 * MONEY-BUG NOTE (S9 #1): this resolver is now allowed to be ASYNC. The live
 * status map is persisted by the renderer to the BACKEND settings store, so the
 * main-process resolver must do a per-request backend READ to reflect a fire the
 * instant it happens (a fired worker must stop spending on the VERY NEXT
 * dispatch). The shim `await`s it. A sync resolver (tests / the no-op default)
 * is still accepted — awaiting a plain value is a no-op.
 */
export type CommandEveTeamStatusResolver = () =>
  | EveTeamWorkerStatusMap
  | undefined
  | Promise<EveTeamWorkerStatusMap | undefined>;

/**
 * Per-request resolver for the PER-SEAT PII/DSGVO egress-redaction mode
 * (`commandEve.egressRedactionMode`) — S11. Injected at shim startup (main
 * process) so the shim can READ the live on/off switch the settings card writes
 * to the BACKEND store. Returns `'on'` (redact — the default) or `'off'` (the
 * operator turned the filter off for this seat; skip redaction, but record it on
 * the receipt).
 *
 * MAY be async (the value is a per-request backend read, seat-scoped-aware) — the
 * shim `await`s it. When omitted, the shim behaves EXACTLY as before this switch
 * existed: it always redacts (the default resolver returns `'on'`), so the toggle
 * is purely additive and fail-SAFE by construction.
 */
export type CommandEveEgressRedactionModeResolver = () => 'on' | 'off' | Promise<'on' | 'off'>;

/**
 * Per-request resolver for the OPAQUE active-seat id (A3 per-seat usage
 * attribution). Returns `getActiveSeatId()` = `'seat-1'` (legacy/founder) or a
 * sanitized seat UUID — NEVER the display LABEL (H3: the seat name must never
 * leave the device). The shim spreads the returned id into the cloud outbound
 * body as `seat_id` so `usage_events.seat_id` can attribute the spend per seat;
 * the server allowlist keeps `seat_id` upstream-invisible (it is NOT in
 * FORWARDABLE_BODY_KEYS).
 *
 * MAY be async. When omitted, the default resolver returns the legacy
 * `'seat-1'`, so a build without the id injected behaves byte-identically to
 * before this field existed (the server treats `'seat-1'` and absent alike).
 */
export type CommandEveActiveSeatIdResolver = () => string | Promise<string>;

export type CommandEveActiveSeatContext = Readonly<{
  seatId: string;
  seatContextRevision: number;
}>;

export type CommandEveActiveSeatContextResolver = () =>
  | CommandEveActiveSeatContext
  | Promise<CommandEveActiveSeatContext>;

export type CommandEveTypedUIProviderCompletionReporter = (input: MainOwnedTypedUIProviderCompletionInput) => void;

/**
 * Optional dispatch-attribution resolver (SG-1 A1 — spoof-close). Maps the
 * inbound `X-EVE-Dispatch` header token to a TRUSTED roster `agent_id`,
 * seat-partitioned. The shim NEVER trusts a client-sent `body.agent_id` again:
 * identity is carried by this CODE-minted token only (eveAgentTaskRegistry). When
 * omitted, the default returns the system default `eve` — which is also the 1.7.0
 * steady state, because the header PRODUCER (Hermes stamping the token on each
 * model call) is the 1.8 wheel train. Fail-open by design: any token that does
 * not resolve returns `eve` so the main lane never breaks.
 */
export type CommandEveDispatchAttributionResolver = (
  dispatchToken: string | undefined,
  seatId: string
) => string | Promise<string>;

/**
 * SG-1 Design B — the per-boot bearer the `POST /eve/team/propose` route requires.
 * Returns '' when team_manage is NOT provisioned for the active seat (a client seat
 * — ISO-6 non-provisioning): an empty expected bearer makes the route INERT (404),
 * so it never even reveals itself on a client seat. Read live per request (the shim
 * is a singleton that outlives seat-switches).
 */
export type CommandEveTeamManageBearerResolver = () => string;

/**
 * SG-1 Design B — the main-side propose handler. The shim is a thin HTTP front:
 * it authenticates, then hands the raw proposal to this injected callback, which
 * validates + stores the pending intent + returns the HTTP status/payload. NO
 * settings write happens here (B1 — the write is the confirm IPC handler's job).
 */
export type CommandEveTeamManageProposeHandler = (proposal: unknown) => Promise<{ status: number; payload: unknown }>;

/**
 * COMPA-626 — the main-side READ-ONLY board digest resolver for `GET /eve/kanban/read`.
 * Returns the board EVE may SEE (cards/lanes, capped + sanitized, operator-only). Carries
 * NO write path, no intent, no mutation hash — so exposing read can never grant write.
 */
export type CommandEveKanbanAcpReadResolver = () => unknown;
/** CEVE-1821 — the seat's live approval authority, rendered from the stored grant. */
export type CommandEveApprovalResolver = () => EveAuthorityRuntime | Promise<EveAuthorityRuntime>;

/**
 * COMPA-624 — the Honcho DERIVER cloud lane route resolver. The local Honcho
 * memory server's deriver LLM (the dialectical user-model reasoning, NOT the
 * user's chat) rides a DEDICATED loopback ingress (`POST /honcho/deriver/...`)
 * that is picker-INDEPENDENT and always the METERED Standard/Flash ENTRY rung.
 *
 * This resolver returns ONLY the transport identity — the eve-inference function
 * URL + the CEVE license bearer — and DELIBERATELY carries NO `tier`: the shim
 * forces {@link HONCHO_DERIVER_FORCED_TIER} ('standard') itself, so no caller,
 * picker, or future edit can make EVE's memory-derivation bill a FRONTIER tier
 * (the money invariant, enforced server-side to match honchoRuntimeConfigCore).
 * 'standard' is the CHEAPEST metered rung, never an unbilled one: it declares
 * consumesCredits: true, and this lane's turns are debited like any chat turn.
 *
 * `active: false` / omitted ⇒ the deriver lane is INERT (503) — a build without
 * Honcho provisioned behaves byte-identically to before this lane existed.
 */
export type CommandEveHonchoDeriverRoute = {
  active: boolean;
  /** Absolute https URL of the eve-inference Edge Function (same lane as chat). */
  functionUrl?: string;
  /** The CEVE license wire string used verbatim as the bearer credential. */
  license?: string;
};

export type CommandEveHonchoDeriverRouteResolver = () =>
  | CommandEveHonchoDeriverRoute
  | undefined
  | Promise<CommandEveHonchoDeriverRoute | undefined>;

export type CommandEveUpstreamOutcome =
  | 'completed'
  | 'client_closed'
  | 'first_byte_timeout'
  | 'idle_timeout'
  | 'upstream_error';

/**
 * Content-free receipt for the desktop transport boundary only.
 *
 * This proves how the shim-side request ended. It deliberately carries no
 * prompt/model/provider data and makes no claim about server-side reservations,
 * billing, credits, or settlement.
 */
export type CommandEveUpstreamOutcomeReceipt = {
  version: 'command-eve-upstream-outcome/v2';
  boundary: 'desktop_upstream_transport';
  request_id: string;
  started_at: string;
  headers_received_at: string | null;
  first_body_chunk_at: string | null;
  observed_at: string;
  outcome: CommandEveUpstreamOutcome;
  response_started: boolean;
};

/**
 * Content-free evidence for a deterministic managed-visual refusal. Unlike an
 * upstream outcome receipt, this proves the request stopped at the desktop
 * authorization boundary before a provider request, billing, or prompt egress.
 */
export type CommandEveManagedVisualAuthorizationFailureReceipt = {
  version: 'command-eve-managed-visual-authorization-failure/v1';
  boundary: 'desktop_managed_visual_authorization';
  observed_at: string;
  status_code: 422;
  /** The public code is stable and generic; the exact reason stays local. */
  error_code: 'EVE_MANAGED_VISUAL_AUTHORIZATION_INVALID';
  authorization_reason_code: CommandEveManagedVisualRefusalReason;
  request_correlation_id: string;
};

export type CommandEveOllamaShimOptions = {
  port?: number;
  /** Override for tests. Production defaults to a random per-process nonce. */
  authToken?: string;
  ollamaBaseUrl?: string;
  numCtx?: number;
  maxTokens?: number;
  /** No total generation cap: only abort when the upstream produces no first byte. */
  upstreamFirstByteTimeoutMs?: number;
  /** Rolling inactivity watchdog; every upstream chunk resets it. */
  upstreamIdleTimeoutMs?: number;
  promptProofPath?: string;
  egressReceiptPath?: string;
  /**
   * Defaults beside `egressReceiptPath` when that production receipt is enabled.
   * The file contains transport outcome metadata only, never model content.
   */
  upstreamOutcomeReceiptPath?: string;
  /**
   * Defaults beside `egressReceiptPath` when production egress evidence is
   * enabled. This failure receipt contains no prompt, attachment, bearer, or
   * provider data.
   */
  managedVisualAuthorizationFailureReceiptPath?: string;
  /** Bounded JSONL history for correlating every content-free upstream call. */
  upstreamOutcomeHistoryPath?: string;
  /** Test/diagnostic observer for the same content-free transport receipt. */
  upstreamOutcomeReporter?: (receipt: CommandEveUpstreamOutcomeReceipt) => void;
  egressPolicyAction?: CommandEveEgressPolicyAction;
  /**
   * Optional EVE cloud routing resolver. When omitted, the shim behaves exactly
   * as before (local Ollama only) — EVE routing is purely additive.
   */
  eveRouting?: CommandEveEveRoutingResolver;
  /**
   * Optional provider-neutral local OpenAI route. Cloud routing still wins;
   * inactive/omitted keeps the existing Ollama conversion byte-identical.
   */
  localOpenAiRouting?: CommandEveLocalOpenAiRoutingResolver;
  /**
   * Optional "Dein Team" worker-status resolver (DUX-4). When provided, the
   * EVE-cloud send path checks the delegated worker's status BEFORE dispatch and
   * refuses to dispatch a paused/off worker. When omitted, no gating is applied
   * (every worker is treated as active), so this is purely additive.
   */
  teamWorkerStatus?: CommandEveTeamStatusResolver;
  /**
   * Optional PER-SEAT PII/DSGVO egress-redaction-mode resolver (S11). When it
   * resolves to `'off'` the shim SKIPS redaction on the CLOUD lane for this seat
   * and stamps the egress receipt `redaction: 'disabled_by_operator'` (evidence,
   * never silent). `'on'`/omitted ⇒ redact as before (fail-safe). The LOCAL lane
   * never egresses, so it is never gated by this resolver.
   */
  egressRedactionMode?: CommandEveEgressRedactionModeResolver;
  /**
   * Optional OPAQUE active-seat-id resolver (A3 per-seat usage attribution).
   * Read ONCE at the start of a cloud request and spread into the outbound body
   * as `seat_id` (opaque id only, never the label — H3). When omitted, the
   * default resolver returns the legacy `'seat-1'` ⇒ byte-identical to before.
   */
  activeSeatId?: CommandEveActiveSeatIdResolver;
  /** Immutable seat snapshot used by Main-owned Typed UI generation receipts. */
  activeSeatContext?: CommandEveActiveSeatContextResolver;
  /** Main-only terminal receipt writer. Omitted means Typed UI attestation stays closed. */
  typedUIProviderCompletion?: CommandEveTypedUIProviderCompletionReporter;
  /**
   * Optional dispatch-attribution resolver (SG-1 A1 spoof-close). Given the
   * inbound `X-EVE-Dispatch` header token + the active seat, returns the TRUSTED
   * roster `agent_id`. The old spoofable `body.agent_id` channel is closed — this
   * is the ONLY attribution source now. Omitted ⇒ always `eve`.
   */
  attributionAgentId?: CommandEveDispatchAttributionResolver;
  /**
   * Optional team_manage per-boot bearer resolver (SG-1 Design B). Omitted / '' ⇒
   * the `POST /eve/team/propose` route is inert (404). Set by main only on an
   * operator seat (ISO-6 non-provisioning).
   */
  teamManageBearer?: CommandEveTeamManageBearerResolver;
  /**
   * Optional team_manage propose handler (SG-1 Design B). Omitted ⇒ the route is
   * inert. When provided (operator seat), it validates + stores the pending intent.
   */
  teamManagePropose?: CommandEveTeamManageProposeHandler;
  /**
   * COMPA-626 kanban-ACP surface. bearer + propose mirror team_manage (bearer-gated
   * `POST /eve/kanban/propose`, inert 404 without a bearer / on a client seat). read is
   * the operator-only READ-ONLY board digest for `GET /eve/kanban/read` — no write path,
   * no intent, no mutation hash. All omitted ⇒ inert until main injects them.
   */
  kanbanAcpBearer?: CommandEveTeamManageBearerResolver;
  kanbanAcpPropose?: CommandEveTeamManageProposeHandler;
  kanbanAcpRead?: CommandEveKanbanAcpReadResolver;
  /**
   * BYOK (Baustein 2): the operator's OWN provider for the active selection, or
   * inactive. Resolved in MAIN from `/api/providers` so the credential never
   * crosses the bridge. Omitted ⇒ the lane is inert and every turn takes the
   * lanes it took before.
   */
  connectedProviderRouting?: CommandEveConnectedProviderRoutingResolver;
  /**
   * CEVE-1821 — the seat's LIVE approval authority, for `GET
   * /v1/command-eve/approval`.
   *
   * The Hermes-side approval patch cannot read Electron settings and must not
   * carry a second copy of the ladder, so it asks here and obeys the answer.
   * Routing the question through the loopback shim (rather than baking the
   * grant into a file at provisioning) is what makes a ladder change take
   * effect on the next approval instead of the next boot.
   *
   * Omitted ⇒ the fail-closed grant, i.e. every answer is `ask`. A shim that
   * main has not wired must never be more permissive than one it has.
   */
  commandEveApproval?: CommandEveApprovalResolver;
  /**
   * Optional Honcho deriver cloud-lane route resolver (COMPA-624). Provides the
   * eve-inference URL + license for the picker-independent `POST /honcho/deriver`
   * lane. Omitted / `{ active: false }` ⇒ the deriver lane is inert (503), so the
   * shim is byte-identical to before until Honcho is provisioned for the seat.
   */
  honchoDeriverRoute?: CommandEveHonchoDeriverRouteResolver;
  /**
   * MAT-1747 — the app-owned artifact capability surface the built-in MCP child
   * loops back to. `artifactCapabilityBearer` mirrors the kanban/team pattern
   * exactly (empty ⇒ the route 404s, so it is inert until main provisions it),
   * and `artifactCapabilityCall` is the single bounded entry point behind it:
   * one route, one JSON body naming an operation and the credentials for it.
   *
   * The MCP child gets NO credential of its own: it reads the 0600 bearer file
   * and calls back here, where the CEVE licence lives. Provider keys, credit
   * authority and idempotency stay on this side of the loopback.
   */
  artifactCapabilityBearer?: CommandEveTeamManageBearerResolver;
  artifactCapabilityCall?: CommandEveTeamManageProposeHandler;
};

export function commandEveCacheScope(sessionId: unknown, seatId: unknown): string | undefined {
  if (typeof sessionId !== 'string') return undefined;
  const normalized = sessionId.trim();
  if (!normalized || normalized.length > 512) return undefined;
  if (typeof seatId !== 'string') return undefined;
  if (!seatId.trim() || seatId.length > 64) return undefined;
  const normalizedSeatId = sanitizeSeatId(seatId);
  if (!normalizedSeatId) return undefined;
  return crypto.createHash('sha256').update(`command-eve-cache:${normalizedSeatId}:${normalized}`).digest('hex');
}

export type CommandEveModelWarmupOptions = {
  baseUrl?: string;
  /** Direct loopback Ollama URL. Production uses the URL bound to the running shim. */
  ollamaBaseUrl?: string;
  authToken?: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
};

export type CommandEveModelWarmupResult = {
  ok: boolean;
  elapsedMs: number;
  model: string;
  error?: string;
};

export type CommandEveEveLaneWarmupOptions = {
  /** Loopback shim base URL the request is sent through (defaults to the running shim). */
  baseUrl?: string;
  authToken?: string;
  /** Wire tier value (e.g. "standard") POSTed so the function routes correctly. */
  tier?: string;
  timeoutMs?: number;
};

export type CommandEveEveLaneWarmupResult = {
  ok: boolean;
  elapsedMs: number;
  /** Wire tier the preflight exercised. */
  tier: string;
  /** HTTP status the shim/function returned, when a response was received. */
  status?: number;
  error?: string;
  /**
   * MAT-1749: the preflight declined to run and issued NO request at all.
   *
   * A first-class outcome, not a failure. `ok: false` on its own reads as "the
   * cloud lane is broken" and gets logged as a warning on every launch; `skipped`
   * says nothing was attempted, nothing was billed, and there is nothing to
   * investigate.
   */
  skipped?: boolean;
};

export type CommandEvePromptProof = {
  version: 'command-eve-prompt-proof/v0';
  ok: boolean;
  observed_at: string;
  model: string;
  message_count: number;
  system_message_count: number;
  marker:
    | 'eve_you_are_here'
    | 'eve_soul'
    | 'eve_operating_rule'
    | 'command_eve_chief_of_staff'
    | 'command_eve_founder_intent'
    | 'none';
  prompt_sha256: string;
  roles: string[];
};

/**
 * Pure builder for the per-request EVE cloud route. Given the active picker
 * selection, the function URL, and the resolved EVE tier + license, return a
 * route the shim acts on. Kept pure (no fs, no config singletons) so it is
 * unit-testable; the main process supplies the live selection / license / URL.
 *
 * Returns `{ active: false }` for any non-EVE (local) selection, so the shim
 * falls through to the local Ollama lane.
 */
/**
 * Scrub provider/model identifiers out of a NON-OK upstream body before it is
 * forwarded to the chat.
 *
 * A 200 body is a completion and is passed through byte-identically — scrubbing
 * model output would corrupt the user's own content. Only the error path, whose
 * text this product did not author and cannot vouch for, is rewritten. A body
 * that is not JSON-shaped is scrubbed as plain text rather than trusted.
 *
 * IT WAS SHAPE-ONLY, AND THAT WAS HALF A SCRUB (1.820.1). Both calls below used to
 * be `scrubModelIdentifiers(text)` with no deny-list, so the shape rule caught
 * `moonshotai/kimi-k3` while the BARE `kimi-k3` — the form an upstream body uses
 * when it names the model without its vendor prefix — went through untouched, on
 * the single path in the product that carries the most upstream text. The
 * renderer's list could not be imported here (main must never import renderer), so
 * the contract moved to `common/config/cloudModelIdentifiers.ts` and both sides
 * import it from there.
 */
export function scrubUpstreamErrorBody(text: string, upstreamOk: boolean): string {
  if (upstreamOk || typeof text !== 'string' || text.length === 0) return text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (parsed && typeof parsed === 'object' && typeof parsed.error?.message === 'string') {
      parsed.error.message = scrubModelIdentifiers(parsed.error.message, EVE_SERVED_MODEL_IDENTIFIERS);
      return JSON.stringify(parsed);
    }
  } catch {
    // Not JSON — fall through to the plain-text scrub below.
  }
  return scrubModelIdentifiers(text, EVE_SERVED_MODEL_IDENTIFIERS);
}

/**
 * Recover the structured Lane-1 `quota_exhausted` contract from a raw 402 body.
 *
 * The wallet answers `{error:'quota_exhausted', credits_needed, packs}` directly,
 * or wraps it inside `error.message` as embedded JSON (OpenAI-style). Returns the
 * verbatim structured body when recoverable, otherwise `null` — the caller then
 * falls back to the warm, provider-independent credit wall. NEVER returns the raw
 * upstream text, so an exhausted OpenRouter/upstream account can never leak into
 * the user-facing message (the user's own credit balance is the only thing shown).
 */
export function recoverQuotaExhaustedBody(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const err = parsed?.error;
    // Shape 1: the wallet answers `{error:'quota_exhausted', credits_needed, packs}`
    // directly (top-level `error` is the STRING discriminator).
    if (err === 'quota_exhausted') {
      return JSON.stringify(parsed);
    }
    // Shape 2: `error` is an OBJECT — either `{error:'quota_exhausted', …}` (flatten it
    // to top-level) or `{message:'…quota_exhausted…'}` (recover embedded JSON).
    if (err && typeof err === 'object') {
      const errObj = err as Record<string, unknown>;
      if (errObj.error === 'quota_exhausted') {
        // Drop the outer wrapper so the renderer's parseQuotaExhaustedBody sees the
        // top-level contract it expects.
        return JSON.stringify(errObj);
      }
      const errMsg =
        typeof errObj.message === 'string'
          ? errObj.message
          : typeof parsed.message === 'string'
            ? (parsed.message as string)
            : '';
      const embedded = errMsg.match(/\{[\s\S]*\}/)?.[0];
      if (embedded) {
        const direct = JSON.parse(embedded) as Record<string, unknown>;
        if (direct.error === 'quota_exhausted') return JSON.stringify(direct);
      }
    }
  } catch {
    /* not JSON / no contract → null */
  }
  return null;
}

export function buildEveCloudRoute(args: {
  /** True iff the active picker selection is an EVE Inference (cloud) tier. */
  isEveSelection: boolean;
  /** Wire tier value (e.g. "standard") parsed from the selection. */
  tier?: string;
  /** Absolute https URL of the eve-inference Edge Function. */
  functionUrl?: string;
  /** The CEVE license wire string (bearer credential), or undefined if absent. */
  license?: string;
}): CommandEveEveCloudRoute {
  if (!args.isEveSelection) return { active: false };
  return {
    active: true,
    functionUrl: args.functionUrl,
    license: args.license,
    tier: args.tier,
  };
}

let server: http.Server | undefined;
let serverUrl = '';
let serverStartInFlight: Promise<string> | undefined;
let activeOllamaBaseUrl = DEFAULT_OLLAMA_BASE_URL;

export function commandEveOllamaPsHasModel(payload: unknown, requestedModel: string): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return false;
  const expected = normalizeCommandEveLocalRuntimeModelId(requestedModel);
  if (!expected) return false;
  return models.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as { name?: unknown; model?: unknown };
    return [record.name, record.model].some(
      (value) => typeof value === 'string' && normalizeCommandEveLocalRuntimeModelId(value) === expected
    );
  });
}

async function commandEveLocalModelIsResident(model: string, ollamaBaseUrl: string): Promise<boolean> {
  if (!isLoopbackHttpUrl(ollamaBaseUrl)) return false;
  try {
    const response = await fetch(`${ollamaBaseUrl.replace(/\/+$/, '')}/api/ps`, {
      redirect: 'error',
      signal: AbortSignal.timeout(COMMAND_EVE_OLLAMA_RESIDENCY_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    return commandEveOllamaPsHasModel(await response.json(), model);
  } catch {
    return false;
  }
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname) && Boolean(url.port)
    );
  } catch {
    return false;
  }
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return `${normalized.endsWith('/v1') ? normalized : `${normalized}/v1`}/chat/completions`;
}

function isStrictIpv4LoopbackOpenAiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Boolean(url.port) &&
      (url.pathname === '/' || url.pathname === '/v1' || url.pathname === '/v1/')
    );
  } catch {
    return false;
  }
}

/** Why a BYOK base URL was refused. Named so the operator can read what happened. */
export type ConnectedHostRefusal =
  | 'CONNECTED_HOST_UNPARSEABLE'
  | 'CONNECTED_HOST_LOOPBACK'
  | 'CONNECTED_HOST_INSECURE_PUBLIC';

export type ConnectedHostVerdict =
  | { ok: true; transport: 'https' | 'http_private_network' }
  | { ok: false; reason: ConnectedHostRefusal };

/** RFC1918 + link-local: the operator's own LAN, where cleartext is their call. */
function isPrivateNetworkHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const match = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

/**
 * MAY THIS BYOK BASE URL BE CALLED? Three rules, and each is a different kind of
 * reason — which is why they are three checks and not one allowlist.
 *
 * 1. LOOPBACK IS REFUSED, and not out of caution. The shim itself listens on
 *    loopback, so a loopback BYOK target can point the shim at ITSELF and spin
 *    the lane in a loop. Loopback is `handleLocalOpenAiCompletions`' job; this
 *    check is the exact inverse of `isStrictIpv4LoopbackOpenAiBaseUrl`, widened
 *    to every loopback spelling because the loop does not care about the port.
 * 2. A PUBLIC HOST MUST BE `https:`. A cleartext turn to a third party is OUR
 *    OWN data loss — the conversation, and the key in the Authorization header.
 *    This one protects us, not a hypothetical future user, so it does not fall
 *    with the visibility gate.
 * 3. A PRIVATE NETWORK (RFC1918) MAY USE `http:`. An operator running their own
 *    box in the LAN has to be able to test. The receipt records that the turn
 *    went out in cleartext — evidence, not a veto.
 */
export function classifyConnectedProviderHost(value: string): ConnectedHostVerdict {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'CONNECTED_HOST_UNPARSEABLE' };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback =
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host.endsWith('.localhost');
  if (isLoopback) return { ok: false, reason: 'CONNECTED_HOST_LOOPBACK' };
  if (url.protocol === 'https:') return { ok: true, transport: 'https' };
  if (url.protocol === 'http:' && isPrivateNetworkHostname(host)) {
    return { ok: true, transport: 'http_private_network' };
  }
  return { ok: false, reason: 'CONNECTED_HOST_INSECURE_PUBLIC' };
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 25_000_000) {
        reject(new Error('request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

async function handleManagedImageGeneration(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    jsonResponse(response, 400, { error: { code: 'invalid_json', message: 'Invalid managed image request.' } });
    return;
  }
  const result = await executeCommandEveManagedImageGeneration(body);
  jsonResponse(response, result.status, result.body);
}

function asMessages(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stripManagedVisualTurnAuthorization(message: unknown): unknown {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  if (typeof record.content === 'string') {
    return { ...record, content: stripCommandEveManagedVisualTurnMarkers(record.content) };
  }
  if (!Array.isArray(record.content)) return record;
  return {
    ...record,
    content: record.content.map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
      const contentPart = part as Record<string, unknown>;
      if (typeof contentPart.text !== 'string') return contentPart;
      return { ...contentPart, text: stripCommandEveManagedVisualTurnMarkers(contentPart.text) };
    }),
  };
}

// SG-1 A1: read the X-EVE-Dispatch header value as a single trimmed token. Node
// lowercases header names and may give an array for repeated headers; take the
// first. Empty/whitespace → undefined (treated as "no token" → attribution `eve`).
function headerToken(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return headerToken(value[0]);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Constant-time bearer comparison (SG-1 Design B, EVE-cloud audit secondary). The route
// is loopback-only, but a length-INDEPENDENT, non-short-circuiting compare is the correct
// hygiene for a secret. Codex re-audit: a raw length check short-circuits and leaks the
// expected token's length via timing. Hash BOTH to a fixed 32-byte sha256 digest first,
// then timingSafeEqual the digests — the compare time no longer depends on input length,
// and sha256's collision resistance keeps it true iff a === b.
function constantTimeEquals(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a, 'utf8').digest();
  const bh = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ah, bh);
}

function hasValidShimAuth(request: IncomingMessage, expectedToken: string): boolean {
  const authHeader = headerToken(request.headers.authorization);
  const match = authHeader ? /^bearer\s+(.+)$/i.exec(authHeader) : null;
  const token = match ? match[1].trim() : '';
  return Boolean(token && constantTimeEquals(token, expectedToken));
}

function requireShimAuth(request: IncomingMessage, response: ServerResponse, expectedToken: string): boolean {
  if (hasValidShimAuth(request, expectedToken)) return true;
  jsonResponse(response, 401, { error: { message: 'Unauthorized local Command EVE inference request.' } });
  return false;
}

type UpstreamAbortReason = Extract<CommandEveUpstreamOutcome, 'client_closed' | 'first_byte_timeout' | 'idle_timeout'>;

type UpstreamRequestScope = {
  signal: AbortSignal;
  markHeadersReceived: () => void;
  markBodyChunk: () => void;
  markUpstreamError: () => void;
  reason: () => UpstreamAbortReason | undefined;
  dispose: () => void;
};

function writeUpstreamOutcomeReceipt(receiptPath: string, receipt: CommandEveUpstreamOutcomeReceipt): void {
  if (!receiptPath) return;
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const tempFile = `${receiptPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, receiptPath);
}

function writeManagedVisualAuthorizationFailureReceipt(
  receiptPath: string,
  receipt: CommandEveManagedVisualAuthorizationFailureReceipt
): void {
  if (!receiptPath) return;
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const tempFile = `${receiptPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, receiptPath);
}

function appendUpstreamOutcomeHistory(historyPath: string, receipt: CommandEveUpstreamOutcomeReceipt): void {
  if (!historyPath) return;
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  fs.chmodSync(historyPath, 0o600);
  if (fs.statSync(historyPath).size <= 256 * 1024) return;
  const lines = fs.readFileSync(historyPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-128);
  const tempFile = `${historyPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, historyPath);
}

function createUpstreamRequestScope(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): UpstreamRequestScope {
  const controller = new AbortController();
  const requestId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let headersReceivedAt: string | null = null;
  let firstBodyChunkAt: string | null = null;
  let abortReason: UpstreamAbortReason | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcomeRecorded = false;

  const recordOutcome = (outcome: CommandEveUpstreamOutcome): void => {
    if (outcomeRecorded) return;
    outcomeRecorded = true;
    const receipt: CommandEveUpstreamOutcomeReceipt = {
      version: 'command-eve-upstream-outcome/v2',
      boundary: 'desktop_upstream_transport',
      request_id: requestId,
      started_at: startedAt,
      headers_received_at: headersReceivedAt,
      first_body_chunk_at: firstBodyChunkAt,
      observed_at: new Date().toISOString(),
      outcome,
      response_started: response.headersSent,
    };
    let evidenceFailed = false;
    for (const sink of [
      () => writeUpstreamOutcomeReceipt(options.upstreamOutcomeReceiptPath, receipt),
      () => appendUpstreamOutcomeHistory(options.upstreamOutcomeHistoryPath, receipt),
      () => options.upstreamOutcomeReporter(receipt),
    ]) {
      try {
        sink();
      } catch {
        evidenceFailed = true;
      }
    }
    if (evidenceFailed) {
      // Evidence must never turn a completed or cancelled inference into a
      // transport failure. Keep the warning content-free as well.
      console.warn('[Command EVE] Upstream outcome receipt could not be recorded.');
    }
  };

  const abort = (reason: UpstreamAbortReason): void => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort(new Error(reason));
    recordOutcome(reason);
  };
  const arm = (reason: UpstreamAbortReason, timeoutMs: number): void => {
    if (timer) clearTimeout(timer);
    if (controller.signal.aborted) {
      timer = undefined;
      return;
    }
    timer = timeoutMs > 0 ? setTimeout(() => abort(reason), timeoutMs) : undefined;
  };
  const onClientClosed = (): void => abort('client_closed');
  const onResponseClosed = (): void => {
    if (!response.writableEnded) onClientClosed();
  };

  request.once('aborted', onClientClosed);
  response.once('close', onResponseClosed);
  // `IncomingMessage.destroyed` also becomes true after a completely normal,
  // fully-consumed request body. Only `aborted` means the client actually cut
  // the upload before completion; treating `destroyed` as cancellation leaves
  // the downstream fetch aborted and the client waiting forever for a response.
  if (request.aborted || response.destroyed) onClientClosed();
  else arm('first_byte_timeout', options.upstreamFirstByteTimeoutMs);

  return {
    signal: controller.signal,
    markHeadersReceived: () => {
      headersReceivedAt ||= new Date().toISOString();
    },
    markBodyChunk: () => {
      firstBodyChunkAt ||= new Date().toISOString();
      arm('idle_timeout', options.upstreamIdleTimeoutMs);
    },
    markUpstreamError: () => recordOutcome('upstream_error'),
    reason: () => abortReason,
    dispose: () => {
      if (timer) clearTimeout(timer);
      request.off('aborted', onClientClosed);
      response.off('close', onResponseClosed);
      recordOutcome('completed');
    },
  };
}

function writeUpstreamAbortResponse(response: ServerResponse, reason: UpstreamAbortReason | undefined): void {
  if (!reason || reason === 'client_closed') return;
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  const message =
    reason === 'first_byte_timeout'
      ? 'The model upstream did not produce a first byte before the inactivity limit.'
      : 'The model upstream stopped producing data before the inactivity limit.';
  jsonResponse(response, 504, { error: { message, type: reason } });
}

function messageRole(message: unknown): string {
  if (!message || typeof message !== 'object') return 'unknown';
  const role = (message as Record<string, unknown>).role;
  return typeof role === 'string' && role.trim() ? role.trim().slice(0, 40) : 'unknown';
}

// The function-call arguments the model echoes back (e.g. crm_lookup({phone:"+49…"}))
// are part of the egress payload but live in tool_calls[].function.arguments, NOT in
// .content — so the scan must read them and the redactor must strip them, else a phone
// the user gave (redacted out of .content) re-leaks via the tool the model called with it.
function toolCallArgsText(message: Record<string, unknown>): string {
  const toolCalls = message.tool_calls;
  if (!Array.isArray(toolCalls)) return '';
  return toolCalls
    .map((tc) => {
      const fn = tc && typeof tc === 'object' ? (tc as Record<string, unknown>).function : undefined;
      const args = fn && typeof fn === 'object' ? (fn as Record<string, unknown>).arguments : undefined;
      return typeof args === 'string' ? args : '';
    })
    .filter(Boolean)
    .join('\n');
}

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const msg = message as Record<string, unknown>;
  const argsText = toolCallArgsText(msg);
  const content = msg.content;
  let contentText = '';
  if (typeof content === 'string') {
    contentText = content;
  } else if (Array.isArray(content)) {
    contentText = content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const text = (part as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return [contentText, argsText].filter(Boolean).join('\n');
}

const COMMAND_EVE_IMAGE_OMITTED_TEXT =
  '[Image attachment omitted: Command EVE vision is disabled until a vetted vision lane is configured.]';
const COMMAND_EVE_LOCAL_VISION_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const COMMAND_EVE_LOCAL_VISION_MODEL = /^minicpm-v(?::[^/]+)?$/i;

function stripNativeImageHintText(text: string): string {
  return text.replace(/\n?\[Image attached(?: at)?: [^\]\n]+\]/g, '').trim();
}

function isNativeImageContentPart(part: Record<string, unknown>): boolean {
  return part.type === 'image_url' || Object.prototype.hasOwnProperty.call(part, 'image_url');
}

function stripNativeImageHintsOnly(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  const nextMessage = { ...(message as Record<string, unknown>) };
  const content = nextMessage.content;
  if (typeof content === 'string') {
    nextMessage.content = stripNativeImageHintText(content) || content;
    return nextMessage;
  }
  if (!Array.isArray(content)) return nextMessage;
  nextMessage.content = content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    const nextPart = { ...(part as Record<string, unknown>) };
    if (typeof nextPart.text === 'string') {
      nextPart.text = stripNativeImageHintText(nextPart.text) || nextPart.text;
    }
    return nextPart;
  });
  return nextMessage;
}

function stripUnsupportedImageContent(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  const nextMessage = { ...(message as Record<string, unknown>) };
  const content = nextMessage.content;
  if (typeof content === 'string') {
    nextMessage.content = stripNativeImageHintText(content) || content;
    return nextMessage;
  }
  if (!Array.isArray(content)) return nextMessage;
  nextMessage.content = content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    const nextPart = { ...(part as Record<string, unknown>) };
    if (isNativeImageContentPart(nextPart)) {
      return { type: 'text', text: COMMAND_EVE_IMAGE_OMITTED_TEXT };
    }
    if (typeof nextPart.text === 'string') {
      nextPart.text = stripNativeImageHintText(nextPart.text) || nextPart.text;
    }
    return nextPart;
  });
  return nextMessage;
}

/**
 * Redact PII from a message. `minClass` (S12) selects the class THRESHOLD:
 * `'S1'` (default) redacts everything (legacy / toggle-on behaviour); `'S3'`
 * redacts ONLY the hard-floor classes (secret/financial/health) so a toggle-off
 * turn still strips credentials while passing waived S1/S2 through.
 */
function redactMessageContent(
  message: unknown,
  minClass: CommandEveSensitivityClass = 'S1',
  preserveLocalImages = false
): unknown {
  const safeMessage = preserveLocalImages ? stripNativeImageHintsOnly(message) : stripUnsupportedImageContent(message);
  if (!safeMessage || typeof safeMessage !== 'object') return safeMessage;
  const nextMessage = { ...(safeMessage as Record<string, unknown>) };
  // Redact tool-call arguments too (the model can echo PII into a tool call it makes).
  const toolCalls = nextMessage.tool_calls;
  if (Array.isArray(toolCalls)) {
    nextMessage.tool_calls = toolCalls.map((tc) => {
      if (!tc || typeof tc !== 'object') return tc;
      const nextTc = { ...(tc as Record<string, unknown>) };
      const fn = nextTc.function;
      if (fn && typeof fn === 'object') {
        const nextFn = { ...(fn as Record<string, unknown>) };
        if (typeof nextFn.arguments === 'string') {
          nextFn.arguments = redactCommandEveSensitiveTextAtOrAbove(nextFn.arguments, minClass);
        }
        nextTc.function = nextFn;
      }
      return nextTc;
    });
  }
  const content = nextMessage.content;
  if (typeof content === 'string') {
    nextMessage.content = redactCommandEveSensitiveTextAtOrAbove(content, minClass);
    return nextMessage;
  }
  if (!Array.isArray(content)) return nextMessage;
  nextMessage.content = content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    const nextPart = { ...(part as Record<string, unknown>) };
    if (typeof nextPart.text === 'string') {
      nextPart.text = redactCommandEveSensitiveTextAtOrAbove(nextPart.text, minClass);
    }
    return nextPart;
  });
  return nextMessage;
}

/**
 * THE single source of truth for "is this model ref the local vision lane?".
 *
 * Exported (1.821.0) so the runtime bootstrapper can decide whether to emit
 * `auxiliary.vision` WITHOUT copying the pattern. Two copies of this regex would
 * drift, and the failure mode of drift here is silent: the config advertises a
 * vision route the shim then refuses to keep local, which sends screenshots down
 * the paid lane instead of to the local model.
 */
export function isCommandEveLocalVisionModel(model: string): boolean {
  return COMMAND_EVE_LOCAL_VISION_MODEL.test(model.trim());
}

function imageDataUrlPayload(part: Record<string, unknown>): string | undefined {
  const imageUrl = part.image_url;
  const url =
    typeof imageUrl === 'string'
      ? imageUrl
      : imageUrl && typeof imageUrl === 'object' && typeof (imageUrl as Record<string, unknown>).url === 'string'
        ? String((imageUrl as Record<string, unknown>).url)
        : '';
  const match = url.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match || match[2].length % 4 !== 0) return undefined;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > COMMAND_EVE_LOCAL_VISION_MAX_IMAGE_BYTES) return undefined;
  const mime = match[1].toLowerCase();
  const hasExpectedMagic =
    (mime === 'png' &&
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (mime === 'jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (mime === 'webp' &&
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') ||
    (mime === 'gif' && bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')));
  if (!hasExpectedMagic) return undefined;
  return match[2];
}

function prepareLocalOllamaVisionMessages(messages: unknown[]): {
  messages: unknown[];
  imageCount: number;
  invalidImageCount: number;
} {
  let imageCount = 0;
  let invalidImageCount = 0;
  const prepared = messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const nextMessage = { ...(message as Record<string, unknown>) };
    const content = nextMessage.content;
    if (!Array.isArray(content)) return nextMessage;
    const textParts: string[] = [];
    const images: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;
      if (isNativeImageContentPart(record)) {
        const payload = imageDataUrlPayload(record);
        if (payload) {
          images.push(payload);
          imageCount += 1;
        } else {
          invalidImageCount += 1;
        }
        continue;
      }
      if (typeof record.text === 'string') {
        const text = stripNativeImageHintText(record.text);
        if (text) textParts.push(text);
      }
    }
    nextMessage.content = textParts.join('\n\n');
    if (images.length > 0) nextMessage.images = images;
    return nextMessage;
  });
  return { messages: prepared, imageCount, invalidImageCount };
}

function classifyPromptMarker(promptText: string): CommandEvePromptProof['marker'] {
  // T4 YOU-ARE-HERE: the wheel appends `agent.environment_hint` VERBATIM to the
  // system prompt's environment-hints block (FACT hermes prompt_builder.py:989-1000
  // build_environment_hints). We anchor on the FIXED marker phrase both hint
  // variants carry (COMMAND_EVE_YOU_ARE_HERE_MARKER = "Company Brain (Index:
  // brain.json)") — it names the LIVE index file, so it can only come from OUR hint
  // (never from SOUL.md, the operating rule, or a user turn). Checked FIRST as the
  // most-specific signal: a missing hint is now self-detected (the marker downgrades
  // to eve_soul), matching the founder self-detection standard. A SOUL-only prompt
  // (no hint) does NOT contain this phrase, so it still falls through to eve_soul
  // below (backward-compatible).
  //
  // T7 (2026-07-02): the marker is now PATH-FREE (was "…: company-brain/ (Index…"),
  // because the relative `company-brain/` mis-anchored the agent to its workspace
  // cwd. The absolute brain path now rides in a separate hint clause; this anchor
  // only matches the fixed index-file phrase.
  if (/Company Brain \(Index: brain\.json\)/.test(promptText)) {
    return 'eve_you_are_here';
  }
  // SOUL.md now carries the doctrine voice (FACT runtimeBootstrapCore.ts:183
  // EVE_SOUL_MARKDOWN). Match its distinctive identity cues FIRST so the prompt-
  // proof self-detection gate stays green when the soul is in the system prompt
  // instead of (or alongside) the thin internal operating rule. Without this the
  // soul text would classify as 'none' and silently blind the gate.
  if (
    /\bEVE SOUL\b/i.test(promptText) ||
    /The Operator/i.test(promptText) ||
    /JARVIS for making money/i.test(promptText)
  ) {
    return 'eve_soul';
  }
  if (/\bEVE Operating Rule\b/i.test(promptText)) return 'eve_operating_rule';
  if (/Command EVE'?s Chief-of-Staff/i.test(promptText) || /Command EVE Chief of Staff/i.test(promptText)) {
    return 'command_eve_chief_of_staff';
  }
  if (/Founder Intent/i.test(promptText) && /\bEVE\b/.test(promptText)) return 'command_eve_founder_intent';
  return 'none';
}

export function buildCommandEvePromptProof(body: Record<string, unknown>): CommandEvePromptProof {
  const messages = asMessages(body.messages);
  const roles = messages.map(messageRole);
  const promptText = messages.map(messageText).join('\n\n');
  const marker = classifyPromptMarker(promptText);
  return {
    version: 'command-eve-prompt-proof/v0',
    ok: marker !== 'none',
    observed_at: new Date().toISOString(),
    model: String(body.model || ''),
    message_count: messages.length,
    system_message_count: roles.filter((role) => role === 'system').length,
    marker,
    prompt_sha256: crypto.createHash('sha256').update(promptText).digest('hex'),
    roles,
  };
}

export function isCommandEveWarmupRequest(body: Record<string, unknown>): boolean {
  const messages = asMessages(body.messages);
  if (messages.length !== 1) return false;
  const onlyMessage = messages[0] as Record<string, unknown> | undefined;
  const content = typeof onlyMessage?.content === 'string' ? onlyMessage.content.trim().toLowerCase() : '';
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 0;
  return messageRole(onlyMessage) === 'user' && content === 'ping' && maxTokens > 0 && maxTokens <= 4;
}

function writePromptProof(promptProofPath: string, proof: CommandEvePromptProof): void {
  if (!promptProofPath) return;
  fs.mkdirSync(path.dirname(promptProofPath), { recursive: true });
  const tempFile = `${promptProofPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, promptProofPath);
}

function contextLengthFromModel(model: string, fallback: number): number {
  const match = model.match(/-(\d+)k(?::|$)/i);
  if (!match) return fallback;
  const contextLength = Number(match[1]) * 1024;
  if (!Number.isFinite(contextLength)) return fallback;
  return Math.max(4_096, Math.min(262_144, Math.floor(contextLength)));
}

export async function resolveCommandEveShimContextPolicy(
  requestedModel: string,
  options: Pick<Required<CommandEveOllamaShimOptions>, 'eveRouting' | 'numCtx'>
): Promise<CommandEveContextPolicy> {
  try {
    const route = await options.eveRouting();
    if (route?.active) return buildCommandEveContextPolicy('cloud');
  } catch (error) {
    console.warn('[Command EVE] context policy route lookup failed; keeping the local hardware cap:', error);
  }
  const bonsaiTier = getCommandEveLocalModelTier(COMMAND_EVE_BONSAI_LOCAL_TIER_ID);
  const localContextLength =
    requestedModel === COMMAND_EVE_BONSAI_RUNTIME_MODEL_ID || requestedModel === COMMAND_EVE_BONSAI_ACP_MODEL_ID
      ? bonsaiTier.contextLength
      : contextLengthFromModel(requestedModel, options.numCtx);
  return buildCommandEveContextPolicy('local', localContextLength);
}

async function handleContextPolicy(
  requestUrl: URL,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): Promise<void> {
  const requestedModel = requestUrl.searchParams.get('model') ?? '';
  const policy = await resolveCommandEveShimContextPolicy(requestedModel, options);
  response.setHeader('cache-control', 'no-store');
  jsonResponse(response, 200, policy);
}

function normalizeOpenAiMessagesForNativeOllama(messages: unknown[]): unknown[] {
  const toolNamesByCallId = new Map<string, string>();
  return messages.map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const record = message as Record<string, unknown>;
    let nextMessage = { ...record };
    if (Array.isArray(record.tool_calls)) {
      nextMessage.tool_calls = record.tool_calls.map((toolCall) => {
        if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) return toolCall;
        const call = toolCall as Record<string, unknown>;
        const fn = call.function;
        if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return toolCall;
        const functionCall = fn as Record<string, unknown>;
        const callId = typeof call.id === 'string' ? call.id : '';
        const functionName = typeof functionCall.name === 'string' ? functionCall.name : '';
        if (callId && functionName) toolNamesByCallId.set(callId, functionName);

        let nativeArguments = functionCall.arguments;
        if (typeof nativeArguments === 'string') {
          try {
            const parsed = JSON.parse(nativeArguments) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) nativeArguments = parsed;
          } catch {
            // Keep malformed model output byte-exact so Ollama rejects it rather
            // than silently changing the requested tool action.
          }
        }
        const { type: _openAiType, ...nativeCall } = call;
        return {
          ...nativeCall,
          function: { ...functionCall, arguments: nativeArguments },
        };
      });
    }
    if (record.role === 'tool' && typeof record.tool_call_id === 'string' && typeof record.tool_name !== 'string') {
      const toolName = toolNamesByCallId.get(record.tool_call_id);
      if (toolName) nextMessage = { ...nextMessage, tool_name: toolName };
    }
    return nextMessage;
  });
}

function nativeChatPayload(body: Record<string, unknown>, options: Required<CommandEveOllamaShimOptions>): unknown {
  // `custom:` is the ACP namespace used by AionUI/AionCore, not part of the
  // actual Ollama model name. Keep the public/receipt model untouched, but send
  // only the normalized runtime id to Ollama. Newer Ollama versions reject the
  // ACP-prefixed value as an invalid model name.
  const model = normalizeCommandEveLocalRuntimeModelId(String(body.model || ''));
  const maxTokens =
    typeof body.max_tokens === 'number' && Number.isFinite(body.max_tokens)
      ? Math.max(1, Math.min(Math.floor(body.max_tokens), options.maxTokens))
      : options.maxTokens;
  return {
    model,
    // Hermes speaks the OpenAI compatibility shape: function.arguments is a
    // JSON string and tool results correlate with tool_call_id. Ollama's native
    // /api/chat contract requires an arguments object and tool_name on history
    // results. Convert only at this private boundary; the public ACP/OpenAI
    // history and receipts stay unchanged.
    messages: normalizeOpenAiMessagesForNativeOllama(asMessages(body.messages)),
    stream: Boolean(body.stream),
    think: false,
    keep_alive: COMMAND_EVE_LOCAL_MODEL_KEEP_ALIVE,
    ...(Array.isArray(body.tools) ? { tools: body.tools } : {}),
    options: {
      num_ctx: contextLengthFromModel(model, options.numCtx),
      num_predict: maxTokens,
    },
  };
}

async function fetchOllama(
  path: string,
  init: RequestInit,
  options: Required<CommandEveOllamaShimOptions>
): Promise<Response> {
  // F-05 (Kimi 1.819 audit): never follow redirects on upstream lanes. A 30x
  // from a compromised upstream must not re-POST request bodies cross-origin;
  // no shim lane has a legitimate redirect.
  return fetch(`${options.ollamaBaseUrl.replace(/\/+$/, '')}${path}`, { ...init, redirect: 'error' });
}

async function handleModels(response: ServerResponse, options: Required<CommandEveOllamaShimOptions>): Promise<void> {
  const upstream = await fetchOllama('/api/tags', { method: 'GET' }, options);
  const data = (await upstream.json()) as { models?: Array<{ name?: string; modified_at?: string }> };
  jsonResponse(response, 200, {
    object: 'list',
    data: (data.models || []).map((model) => ({
      id: model.name || '',
      object: 'model',
      created: model.modified_at ? Math.floor(Date.parse(model.modified_at) / 1000) : 0,
      owned_by: 'ollama',
    })),
  });
}

function writeStreamChunk(response: ServerResponse, model: string, content: string, toolCalls?: unknown): void {
  const delta: Record<string, unknown> = {};
  if (content) delta.content = content;
  if (toolCalls) delta.tool_calls = toolCalls;
  response.write(
    `data: ${JSON.stringify({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`
  );
}

type OllamaToolCallIdState = { nextOrdinal: number };

/**
 * Ollama's native tool-call DTO has no call id and may carry arguments as an
 * object. This route is an OpenAI-compatibility boundary, so Main mints the id
 * once and forwards that exact normalized call to Hermes and the private
 * completion recorder. The model/provider cannot choose this correlation id.
 */
function normalizeOllamaToolCallsForOpenAI(
  value: unknown,
  providerRequestId: string,
  state: OllamaToolCallIdState
): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    const ordinal = state.nextOrdinal;
    state.nextOrdinal += 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const toolCall = item as Record<string, unknown>;
    const fn = toolCall.function;
    if (!fn || typeof fn !== 'object' || Array.isArray(fn)) return item;
    const functionCall = fn as Record<string, unknown>;
    const argumentsJson =
      typeof functionCall.arguments === 'string'
        ? functionCall.arguments
        : (JSON.stringify(functionCall.arguments ?? {}) ?? '{}');
    const id = `call_${crypto
      .createHash('sha256')
      .update(
        [
          'command-eve.ollama-tool-call/v1',
          providerRequestId,
          String(ordinal),
          String(functionCall.name || ''),
          argumentsJson,
        ].join('\u0000'),
        'utf8'
      )
      .digest('hex')
      .slice(0, 48)}`;
    return {
      ...toolCall,
      id,
      type: 'function',
      function: { ...functionCall, arguments: argumentsJson },
    };
  });
}

/**
 * The EVE function URL must be https in production. A loopback http URL is also
 * accepted (same trust model as the local-runtime loopback key) so the routing
 * is testable and a self-hosted loopback proxy stays possible; any other plain
 * http (a real remote host over cleartext) is rejected.
 */
function isAllowedEveFunctionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return Boolean(url.hostname);
    if (url.protocol === 'http:') {
      return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * EVE Inference (cloud) lane. The same egress-boundary enforcement that guards
 * the local Ollama path runs FIRST (provider.kind: 'cloud' so the receipt is
 * truthful), then the OpenAI-compatible body — with the `tier` the function
 * routes on — is POSTed to the eve-inference Edge Function with the CEVE license
 * as the bearer credential. The function returns an OpenAI-compatible
 * completion (or SSE stream), the exact shape the local path already emits, so
 * we can passthrough verbatim.
 *
 * The license is sent ONLY in the Authorization header (never in the body,
 * never logged) — the egress redactor scans message CONTENT, not headers.
 */
async function handleEveCloudCompletions(
  request: IncomingMessage,
  body: Record<string, unknown>,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>,
  route: CommandEveEveCloudRoute,
  dispatchToken: string | undefined,
  seatContext: CommandEveActiveSeatContext,
  providerRequestId: string,
  // COMPA-624 / Codex #1: when true (the Honcho deriver lane) the S3 secret HARD
  // FLOOR is NEVER waived, even on the founder's own legacy seat. The chat lane's
  // S13 waiver is a CONSCIOUS per-message founder choice; the deriver is AUTOMATIC
  // background reasoning, so it must never auto-send raw secrets/finance/health to
  // the cloud LLM. Omitted/false ⇒ chat behaviour is byte-identical.
  neverWaiveSecretFloor = false,
  // MAT-1749: the operation this metered call is being made FOR. Defaults to '' so a
  // call site added later that forgets to declare one fails CLOSED here rather than
  // inheriting the right to spend.
  operation = '',
  // WHO named the operation: 'client' when it was read out of a request body (the
  // general lane), 'shim' when this process minted it from the ingress the caller
  // reached (the deriver lane). Defaults to the stricter of the two.
  operationSource: CommandEvePaidSeamSource = 'client'
): Promise<void> {
  // THE MONEY CHOKEPOINT — AND THE ONLY PLACE THE PAYABILITY DECISION IS TAKEN.
  //
  // This used to be a SECOND copy of a decision the router had already made, and
  // that is precisely why it could be defeated: the router refused first, so
  // rewriting this as `false && …` left every test green (Sol, zange on e40c3396).
  // A guard whose neutralisation nothing can observe is a guard nobody can prove.
  //
  // The router now decides only the LANE — local_only never arrives here — and
  // delegates the money question to this function, the single thing standing between
  // a request and a metered provider. Neutralise it by any means and an undeclared
  // turn reaches the recorder, which committed tests observe as a debit.
  const seam = resolveCommandEvePaidSeam(operation, operationSource);
  if (seam.disposition !== 'paid') {
    response.setHeader(COMMAND_EVE_OPERATION_DECISION_HEADER, `refused:${seam.reason ?? 'not_payable'}`);
    jsonResponse(response, 403, commandEvePaidSeamRefusalBody(seam));
    return;
  }
  // Content-free route proof consumed by the bounded compression receipt. Set only
  // AFTER the money question is settled, so a refusal never claims a cloud lane.
  response.setHeader('x-command-eve-inference-lane', 'eve_cloud');
  response.setHeader(COMMAND_EVE_OPERATION_DECISION_HEADER, `paid:${seam.operation}`);
  const functionUrl = typeof route.functionUrl === 'string' ? route.functionUrl.trim() : '';
  const license = typeof route.license === 'string' ? route.license.trim() : '';
  // HONEST TIER ROUTING (1.2.19): the wire tier is the user's ACTUAL selection,
  // forwarded VERBATIM for both OFFERED rungs — NO silent fall-through. The
  // routing resolver derives it from the live selection: eve-standard→'standard',
  // eve-max→'max'; a no-longer-offered rung is MIGRATED first (eve-high→
  // 'standard', eve-xhigh/eve-ultra→'max'), so what travels is what the UI names.
  //
  // If an ACTIVE EVE route still arrives without a known wire tier the chain is
  // broken and we FAIL LOUD (500) rather than metering the cheapest model — the
  // old `: 'standard'` fallback was exactly the bug that silently billed a paid
  // seat the cheapest lane (upstream logs: 100% cheapest tier, nothing else ever
  // called). MAT-1749 note: resolveEveCloudRouteFromBackend now REPAIRS an
  // unresolvable selection upstream of here, so this 500 is a genuine
  // last-resort invariant rather than the everyday outcome for a corrupt value.
  const tier = typeof route.tier === 'string' ? route.tier.trim() : '';
  const stream = Boolean(body.stream);

  // Fail closed: never make an unauthenticated request, never POST to a
  // disallowed (cleartext-remote) function URL.
  if (!isAllowedEveFunctionUrl(functionUrl)) {
    jsonResponse(response, 500, {
      error: { message: 'EVE Inference function URL is missing or not an allowed (https/loopback) URL.' },
    });
    return;
  }
  if (license.length === 0) {
    jsonResponse(response, 401, {
      error: { message: 'EVE Inference is unavailable: no CEVE license bearer credential.' },
    });
    return;
  }
  // HONEST TIER ROUTING (1.2.19): refuse an active EVE route with a missing or
  // unknown wire tier rather than silently downgrading to the cheapest model.
  // A correct route always carries one of the SERVER-ACCEPTED tiers
  // (standard/high/xhigh/max); a missing, unknown or retired value means the
  // selection→tier resolution broke upstream, or the rung is one the server
  // refuses — either way it must not travel.
  if (!KNOWN_EVE_WIRE_TIERS.has(tier)) {
    jsonResponse(response, 500, {
      error: {
        message:
          'EVE Inference routing error: the selected level could not be resolved to a billing tier. ' +
          'Re-pick the EVE level and try again.',
      },
    });
    return;
  }

  // PER-SEAT PII/DSGVO egress switch (S11). Read the live mode FRESH per request
  // BEFORE the boundary runs. FAIL-SAFE by construction: the resolver returns 'on'
  // on any read error (always redact — no last-known-good), so only a conscious,
  // successfully-read 'off' disables redaction, and only for THIS seat's cloud
  // lane. The local lane never egresses and is never reached here.
  const egressRedactionMode = await options.egressRedactionMode();
  const redactionDisabledByOperator = egressRedactionMode === 'off';

  // A3 per-seat usage attribution: resolve the OPAQUE active-seat id ONCE, here
  // at the request start, so BOTH terminal log paths (stream + non-stream) ride
  // it for free. Opaque id only ('seat-1' | uuid) — never the label (H3). It is
  // spread into the outbound body below; the server persists it to
  // usage_events.seat_id and keeps it upstream-invisible (not in
  // FORWARDABLE_BODY_KEYS). A default 'seat-1' keeps attribution byte-stable.
  // A receipt snapshot failure must not misattribute an otherwise valid paid
  // turn. Billing keeps using the older live seat resolver, while the empty
  // receipt context below remains deliberately unattestable.
  const seatId = seatContext.seatId || (await options.activeSeatId());

  // Egress boundary — same gate as local, but the provider is a CLOUD lane.
  //
  // SENSITIVITY-GATE (S12) WRAPS S11 here. Instead of forcing 'allow' wholesale
  // when the operator disabled the filter (which would have leaked EVERYTHING,
  // including raw credentials/health/finance), we thread the toggle MODE into the
  // boundary. The boundary then applies the class-aware gate: toggle 'off' waives
  // S1/S2 (operator responsibility) but the S3 HARD FLOOR still redacts (or blocks)
  // credentials/health/finance — the DSGVO grantee the operator cannot switch off.
  // S11's structure (fresh per-request read, receipt stamp, off-badge header) is
  // untouched; only the wholesale 'allow' is replaced by the gate.
  let outboundMessages = asMessages(body.messages).map((message) => stripUnsupportedImageContent(message));
  const egressBoundary = await evaluateCommandEveEgressBoundary({
    text: outboundMessages.map(messageText).join('\n\n'),
    provider: {
      kind: 'cloud',
      name: 'EVE Inference',
      model: tier,
      baseUrl: functionUrl,
    },
    policyAction: options.egressPolicyAction,
    toggleMode: egressRedactionMode,
    // S13 — on the FOUNDER's OWN (legacy) seat, `off` means truly OFF: the S3 hard
    // floor (secrets/finance/health) is waivable because the data is the founder's
    // own (a founder posting their OWN api key to test is their choice), not a
    // client's. A real CLIENT seat has a uuid id (never legacy) ⇒ waivable=false ⇒
    // the Auftragsverarbeiter floor still protects the client's credentials.
    secretFloorWaivable: isLegacySeatId(seatId) && neverWaiveSecretFloor !== true,
  });
  // Stamp the honest evidence onto the receipt when the operator turned the filter
  // off — this is the audit trail for a deliberate DSGVO control-waiver.
  const egressReceipt = redactionDisabledByOperator
    ? { ...egressBoundary.receipt, redaction: 'disabled_by_operator' as const }
    : egressBoundary.receipt;
  try {
    writeCommandEveEgressBoundaryReceipt(options.egressReceiptPath, egressReceipt);
  } catch (error) {
    console.warn('[Command EVE] Failed to write egress boundary receipt:', error);
  }
  response.setHeader('x-command-eve-egress-decision', egressBoundary.decision);
  if (redactionDisabledByOperator) {
    response.setHeader('x-command-eve-egress-redaction', 'disabled_by_operator');
  }
  if (egressBoundary.decision === 'block') {
    jsonResponse(response, 451, {
      error: {
        message:
          'Command EVE blocked sensitive data before model egress. Move secrets into settings, an env file, or an approved vault flow.',
        receipt: egressReceipt,
      },
    });
    return;
  }
  if (egressBoundary.decision === 'redact') {
    // S12: redact the OUTBOUND messages at the SAME class threshold the boundary
    // used. Toggle 'off' + S3 hard floor ⇒ redact ONLY S3 here (S1/S2 waived);
    // toggle 'on' ⇒ redact all S1+ (identical to legacy). Deriving the threshold
    // from the toggle keeps the messages and the boundary decision consistent —
    // we never over-redact a waived S1/S2 nor under-redact an S3.
    const messageRedactThreshold: CommandEveSensitivityClass = redactionDisabledByOperator ? 'S3' : 'S1';
    outboundMessages = outboundMessages.map((message) => redactMessageContent(message, messageRedactThreshold));
  }

  // MAXIMUM EXECUTION PROFILE. This is injected at the trusted Main-process
  // boundary on EVERY Maximum request, so it also takes effect when the user
  // switches lanes mid-session. It asks Hermes to use the worker slots already
  // available under the live hardware cap for genuinely complex work; it does
  // not increase that cap and explicitly preserves all privacy, permission,
  // spend, publish and deploy gates. Simple work remains direct to avoid costly
  // delegation theatre.
  // Bound to `max`, the highest rung the server accepts. The profile used to
  // hang off a rung the Edge Function refuses, so it could never actually run —
  // the capability was real, the route to it was not. Moving it here keeps the
  // behaviour and drops only the unusable level.
  if (tier === 'max') {
    outboundMessages = [
      {
        role: 'system',
        content:
          '## EVE Maximum execution profile\n' +
          'For genuinely complex tasks, proactively use delegate_task and all worker slots already available under the current Hermes hardware cap. Parallelize independent read-only or reversible research, review, and implementation work; synthesize and verify the results before answering. Never invent unavailable workers, never bypass privacy, permission, or credit limits, and never self-approve sending, spending, publishing, purchasing, or deploying. Existing human gates remain binding. For simple tasks, answer directly instead of spawning workers.',
      },
      ...outboundMessages,
    ];
  }

  const proof = buildCommandEvePromptProof({ ...body, messages: outboundMessages });
  try {
    writePromptProof(options.promptProofPath, proof);
  } catch (error) {
    console.warn('[Command EVE] Failed to write prompt proof receipt:', error);
  }
  response.setHeader('x-command-eve-persona-proof', proof.ok ? proof.prompt_sha256 : 'missing');

  // Forward only OpenAI-standard fields + the tier the function routes on. The
  // function STRIPS model/models/user/license itself, so the local Gemma model
  // ref Hermes sent is harmless, but we omit it to keep the request clean.
  //
  // agent_id (Dein Team attribution) — SG-1 A1 SPOOF-CLOSE. Identity is carried
  // by CODE, never by the model: the trusted source is the X-EVE-Dispatch header
  // TOKEN (minted per roster role by eveAgentTaskRegistry), resolved here to a
  // known roster id, SEAT-PARTITIONED against the live seat. A client-sent
  // `body.agent_id` is IGNORED entirely (the old spoof channel at :694). Anything
  // that does not resolve — including the 1.7.0 steady state, where no header
  // producer exists yet (that is the 1.8 wheel train) — degrades to the system
  // default `eve` (fail-open; the main lane never breaks). We only forward the id
  // for a delegated (non-default) role, so an un-delegated call's body keeps its
  // prior shape. The id is a kebab role string, never a secret — safe to forward.
  const attributionAgentId = await options.attributionAgentId(dispatchToken, seatId);
  // Hermes provides its local session id to the loopback shim. Bind it to the
  // canonical active seat before hashing, so identical local ids on two seats
  // cannot share a cache scope. The server HMACs this opaque scope again before
  // OpenRouter sees it; neither raw id nor the conversation title leaves the Mac.
  const cacheScope = commandEveCacheScope(body.session_id, seatId);

  // DUX-4 — ENFORCE the "Dein Team" pause/throttle/fire controls. The panel
  // WRITES `commandEve.teamWorkerStatus`; here is the ONE place the execution
  // path READS it. A delegated worker the user paused (throttled) or stopped /
  // let go (off) is NOT dispatched — we fail-closed with a clear, non-secret
  // error instead of silently spending on a worker the user turned off. The
  // un-delegated EVE (`eve`) and any unknown id are always allowed (fail-open),
  // so only a positively-known paused/off roster worker is blocked.
  // Fresh READ per dispatch evaluation (money control): the resolver reads the
  // live status map from the backend store the panel writes to, so a fired /
  // paused worker is refused on the very next dispatch — no TTL, no cache-warm
  // grace. `await` because the resolver is now backend-backed (async); a sync
  // resolver awaits to itself.
  const teamStatuses = (await options.teamWorkerStatus()) ?? {};
  const dispatch = evaluateWorkerDispatch(attributionAgentId, teamStatuses);
  if (!dispatch.allowed) {
    response.setHeader('x-command-eve-worker-dispatch', dispatch.reason);
    jsonResponse(response, 409, {
      error: {
        code: dispatch.reason,
        message:
          dispatch.reason === 'blocked-paused'
            ? `Dieser Mitarbeiter ist gedrosselt (pausiert) und wird nicht eingesetzt. Setze ihn in "Dein Team" fort, um ihn wieder arbeiten zu lassen.`
            : `Dieser Mitarbeiter ist aus (gestoppt bzw. entlassen) und wird nicht eingesetzt. Stelle ihn in "Dein Team" wieder ein, um ihn arbeiten zu lassen.`,
      },
    });
    return;
  }

  // AGENT TOOL-USE: forward the function-calling fields too. The Hermes agent
  // sends OpenAI-style `tools` so the model can actually call file/terminal/skill/
  // delegate tools. Previously this body was {messages,stream,tier} only, so the
  // model received ZERO tools on the cloud lane and could only emit prose
  // (tool_turns=0) — it would narrate a <bash>…</bash> string instead of calling a
  // tool. The local lane already forwards tools (nativeChatPayload); this brings
  // the cloud lane to parity. Conditional spreads so a tool-less turn stays
  // byte-identical to before.
  //
  // DOWNSTREAM CONTRACT: the DEPLOYED eve-inference re-filters by its own
  // FORWARDABLE_BODY_KEYS allowlist, which (verified 2026-06-24 on prod
  // unvbeothoimlzlolxucl) ALREADY includes tools/tool_choice/parallel_tool_calls/
  // response_format — so these survive to the model. NOTE: keep the Company.OS
  // eve-inference deploy line in sync; if a redeploy ships a FORWARDABLE_BODY_KEYS
  // that lacks these keys, tools get re-stripped server-side and EVE goes "deaf"
  // again. (supabase/functions/_shared/eve-inference-core.ts FORWARDABLE_BODY_KEYS)
  const outboundBody: Record<string, unknown> = {
    messages: outboundMessages,
    stream,
    tier,
    ...(attributionAgentId !== 'eve' ? { agent_id: attributionAgentId } : {}),
    // A3 per-seat attribution: the opaque active-seat id. Only emitted when a
    // non-empty id resolved (always true with the default 'seat-1' resolver);
    // a blank id is omitted so an old app + new server stays NULL ("Nicht
    // zugeordnet") rather than writing an empty-string seat. The server
    // sanitizes and persists it to usage_events.seat_id; it is NEVER in
    // FORWARDABLE_BODY_KEYS so it stays invisible to OpenRouter.
    ...(typeof seatId === 'string' && seatId.length > 0 ? { seat_id: seatId } : {}),
    ...(cacheScope ? { cache_scope: cacheScope } : {}),
    ...(Array.isArray(body.tools) && body.tools.length > 0 ? { tools: body.tools } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice } : {}),
    ...(body.parallel_tool_calls !== undefined ? { parallel_tool_calls: body.parallel_tool_calls } : {}),
    ...(body.response_format !== undefined ? { response_format: body.response_format } : {}),
  };

  if (route.authorizeManagedVisualEgress) {
    // A boolean `false` is the deliberate final policy revocation. Do not
    // collapse callback faults into that deterministic claim: unknown faults
    // must reach the generic redacted 500 boundary and must not mint a stale
    // policy receipt.
    const authorized = await route.authorizeManagedVisualEgress();
    if (authorized === false) {
      // A consumed marker remains subject to final Main-owned policy
      // revalidation. This is a deterministic managed-visual refusal, not a
      // conflict: the shared 422 boundary prevents OpenAI 2.24 retries and
      // keeps the exact local cause receipt-only.
      throw new CommandEveManagedVisualAuthorizationError('POLICY_STALE');
    }
    if (authorized !== true) {
      // The typed callback promises a boolean. A malformed runtime value is
      // an implementation fault, never a claim that the seat policy is stale.
      throw new Error('Managed visual policy callback returned a non-boolean result.');
    }
  }

  const upstreamScope = createUpstreamRequestScope(request, response, options);
  try {
    const upstream = await fetch(functionUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The license rides ONLY here — never in the body, never logged.
        authorization: `Bearer ${license}`,
      },
      redirect: 'error',
      body: JSON.stringify(outboundBody),
      signal: upstreamScope.signal,
    });
    upstreamScope.markHeadersReceived();

    // Stream passthrough: the function already emits OpenAI-compatible SSE.
    if (stream && upstream.ok && upstream.body) {
      response.writeHead(200, {
        'content-type': upstream.headers.get('content-type') || 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const reader = upstream.body.getReader();
      const typedUICapture = new OpenAITypedUIPublishSseCapture();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.byteLength > 0) upstreamScope.markBodyChunk();
        typedUICapture.push(value);
        response.write(value);
      }
      reportCapturedTypedUIProviderCompletions(typedUICapture.finish(), {
        sessionId: body.session_id,
        provider: 'EVE Inference',
        model: tier,
        providerRequestId,
        route: 'eve_cloud',
        seatId: seatContext.seatId,
        seatContextRevision: seatContext.seatContextRevision,
        terminal: 'openai_sse',
        report: options.typedUIProviderCompletion,
      });
      response.end();
      return;
    }

    // Non-streaming (or upstream error): passthrough the JSON. On 200 the
    // function returns OpenAI-compatible completions.
    //
    // On a NON-OK status the body is an error we do not control. The previous
    // comment here called those bodies "sanitized" — that was a guarantee about
    // code in another repo, asserted from this one, i.e. trust dressed as a
    // property. An upstream error can name the concrete model as a
    // `vendor/model` slug, and this passthrough puts it straight into the chat,
    // which the founder mandate forbids. We therefore scrub the user-facing
    // message ourselves rather than assuming someone else did.
    const text = await upstream.text();
    if (text.length > 0) upstreamScope.markBodyChunk();
    // F-14 (Kimi 1.819 audit): a non-OK upstream status is an upstream error in
    // the outcome receipt, not a silent "completed" — otherwise the receipt is
    // worthless as watchdog evidence.
    if (!upstream.ok) upstreamScope.markUpstreamError();
    if (upstream.ok) {
      try {
        reportCapturedTypedUIProviderCompletions(
          extractOpenAICompletedTypedUIPublishCalls(JSON.parse(text) as unknown),
          {
            sessionId: body.session_id,
            provider: 'EVE Inference',
            model: tier,
            providerRequestId,
            route: 'eve_cloud',
            seatId: seatContext.seatId,
            seatContextRevision: seatContext.seatContextRevision,
            terminal: 'openai_json',
            report: options.typedUIProviderCompletion,
          }
        );
      } catch {
        // The completion still reaches Hermes; missing receipt keeps Typed UI closed.
      }
    }

    // Friendly daily-cap (429): the raw upstream body is a terse
    // "rate_limit"/"daily cap reached" JSON that surfaces in chat as a cold
    // error. Rewrite it to a warm, operator-facing message that names WHY and the
    // way forward, WITHOUT inventing a cap number — if the function reported a
    // concrete reset/limit we keep its text, otherwise a generic friendly line.
    // Stays OpenAI-error-shaped so the chat renders message verbatim.
    //
    // AND IT IS NOT A DAILY CAP EITHER, BECAUSE THERE IS NO LONGER ONE (1.820.2).
    // The first fix replaced "EVE hat ihr kostenloses Tageskontingent für heute
    // erreicht … morgen läuft es automatisch wieder" with a fair-use-cap wording,
    // because there is no free quota. That removed the free-lane lie but kept a
    // second one: it still named a per-user DAILY CAP as the thing that fired. The
    // server-side cap it referred to has since been deleted — it sat behind an
    // `if (deps.usage)` guard the production entrypoint never satisfied, so it had
    // never once executed and could not have produced this 429.
    //
    // A 429 on this path therefore comes from UPSTREAM rate limiting, which is about
    // request RATE, not a daily allowance and not the wallet. So the copy names that
    // and nothing else: no cap number, no reset time, no promise that credits lift it.
    // (The wallet has its own refusal and it is a 402, not this.)
    if (upstream.status === 429) {
      let upstreamMessage = '';
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
        upstreamMessage = (parsed?.error?.message || parsed?.message || '').trim();
      } catch {
        upstreamMessage = '';
      }
      // Scrubbed: the quoted upstream sentence is the exact place a provider
      // slug reaches the chat on a rate-limited turn.
      // Same deny-list as the body scrub — this quoted sentence is echoed into the
      // chat verbatim, so shape-only would leak a bare model name here too.
      const safeUpstreamMessage = scrubModelIdentifiers(upstreamMessage, EVE_SERVED_MODEL_IDENTIFIERS);
      const friendly =
        'EVE wurde gerade vom Anbieter ausgebremst (zu viele Anfragen in kurzer Zeit). ' +
        'Versuch es gleich noch einmal — Anfragen laufen wie immer über deine Credits.' +
        (safeUpstreamMessage ? ` (${safeUpstreamMessage})` : '');
      response.writeHead(429, { 'content-type': 'application/json' });
      // The `eve_daily_cap` DISCRIMINATOR keeps its name deliberately. It is an
      // internal signal the renderer switches on (creditsCore.detectDailyCapReached ->
      // useQuotaWall -> the warm wall), not copy anybody reads, and its BEHAVIOUR —
      // show a warm wall instead of a raw error on any upstream 429 — is correct and
      // wanted. Renaming it touches eight files and a set of i18n keys for no change in
      // what the user is told. It is naming debt, and it is named as such rather than
      // half-renamed: what the user READS is fixed above and in DailyCapWall.
      response.end(JSON.stringify({ error: { message: friendly, type: 'eve_daily_cap', code: 429 } }));
      return;
    }

    // HTTP 402 quota_exhausted — the metered-credits wallet is empty (Lane-1
    // credit-wall contract, NOT an UpstreamError). Mirror the 429 handling: a
    // warm, structured body the renderer's credit wall switches on, and never
    // leak that it was OUR upstream provider (OpenRouter) that is empty. The
    // user's own credit balance is the only thing they should be told about.
    if (upstream.status === 402) {
      // The upstream body IS the `{error:'quota_exhausted', credits_needed, packs}`
      // shape (or embedded in it). Forward it verbatim so the renderer's
      // creditsCore.detectQuotaExhausted + useQuotaWall can surface the framed
      // "buy credits" wall instead of an UNKNOWN_UPSTREAM_ERROR chat bubble.
      response.writeHead(402, { 'content-type': 'application/json' });
      // Try to recover the structured quota_exhausted contract from the raw body
      // (the wallet responds with `{error:'quota_exhausted', credits_needed, packs}`,
      // sometimes wrapped in `error.message` as embedded JSON). If we cannot, hand
      // back a warm minimal quota_exhausted so the renderer still shows the credit
      // wall — never the raw provider text, and never a leak that OUR OpenRouter
      // account is empty.
      const structured = recoverQuotaExhaustedBody(text);
      response.end(
        structured ||
          JSON.stringify({
            // Top-level Lane-1 contract the renderer's parseQuotaExhaustedBody reads:
            // `{ error:'quota_exhausted', credits_needed, packs }`. The wall renders
            // this as the "buy credits" surface; the message below is the warm fallback
            // copy shown by the wall when the wall body has no user-visible text.
            error: 'quota_exhausted',
            credits_needed: 1,
            packs: [],
            message:
              'Deine Command-EVE-Credits sind aufgebraucht. Lade in den Einstellungen neue Credits auf, um weiterzumachen.',
          })
      );
      return;
    }

    response.writeHead(upstream.status || 502, {
      'content-type': upstream.headers.get('content-type') || 'application/json',
    });
    response.end(
      scrubUpstreamErrorBody(text, upstream.ok) ||
        JSON.stringify({ error: { message: `EVE Inference request failed (${upstream.status}).` } })
    );
  } catch {
    const abortReason = upstreamScope.reason();
    if (abortReason) {
      writeUpstreamAbortResponse(response, abortReason);
    } else {
      upstreamScope.markUpstreamError();
      // Generic 502 — never echo the error (could surface the bearer in some
      // runtimes), matching the function's own upstream-failure discipline.
      jsonResponse(response, 502, { error: { message: 'EVE Inference upstream unreachable.' } });
    }
  } finally {
    upstreamScope.dispose();
  }
}

/**
 * COMPA-624 — the Honcho DERIVER cloud lane. A DEDICATED ingress the local Honcho
 * memory server points its deriver LLM at when it CANNOT run locally (no local
 * Gemma). It is deliberately SEPARATE from the chat lane:
 *
 * EVERY CLOUD TURN ON THIS PATH IS METERED, AND THIS BLOCK USED TO SAY OTHERWISE.
 * Four places in this handler — the summary line, the wire-tier bullet, the
 * fail-closed comment, and the 503 message an operator actually SEES — described this
 * path and its route with the vocabulary of a lane that costs nothing. The routing is
 * unchanged and correct; what was false is what it was called. The retired wording is
 * not reproduced here, because this file is what the next person to edit this handler
 * reads, and a quoted phrase travels just as well as an asserted one (a source guard
 * in honchoDeriverLane.test.ts enforces that). The rung this pins, Standard, declares
 * `consumesCredits: true` in eveInferenceCore: the deriver's turns reserve, call and
 * debit exactly like a chat turn. Calling the entry rung "free" is how a metered lane
 * comes to look like an entitlement, and it is the same ghost this repo has now
 * exorcised from the server, the funnel and the account page.
 *
 * WHAT IS GENUINELY UNBILLED IS THE LOCAL LANE, and nothing here touches it: with
 * `deriverMode: 'local'` (or 'auto' with a warm opted-in Gemma) derivation never
 * reaches this handler at all — it goes to loopback Ollama, nothing egresses, and no
 * credit moves. That is a fact about WHERE the work runs, not a free tier of ours.
 * BYOK is the same shape on the chat lane. Both survive untouched.
 *
 *  - PICKER-GATED, AND IT USED TO BE PICKER-INDEPENDENT. THAT WAS THE DEFECT. This
 *    handler never called options.eveRouting(), so an operator sitting on the private
 *    local lane — who has chosen to spend nothing — still had EVE's memory derivation
 *    reaching this METERED rung on every turn where the bundled Gemma was not warm.
 *    No surface could stop it either: the `deriverMode` switch is not user-selectable
 *    (honchoRuntimeConfigCore says so in its own doc) and defaults to 'auto'. So
 *    "the operator picked the lane that costs nothing" was true of chat and false of
 *    the machine underneath it, which is the whole claim in a different place.
 *
 *    NOW: this path is taken ONLY when the chat lane is PROVEN to be the metered
 *    cloud one (`eveRouting()` answers an active route). EVERY other answer — a local
 *    selection, a BYOK selection, a resolver that throws (the R4 unknown-entitlement
 *    hold), or no picker wired at all — is answered 503 with NOTHING forwarded.
 *    Derivation then does not succeed on this path; per honchoRuntimeConfigCore that
 *    is the DESIGNED degradation (memory falls back to Company Brain), not an outage.
 *    One sentence: EVE's background memory work may never put a seat on a metered
 *    rung the operator did not pick.
 *
 *    The coupling is ONE-WAY by construction. It can only make this path REFUSE. It
 *    can never make derivation ride a stronger tier, because the wire tier below is
 *    still the literal forced constant and is never read from a selection.
 *  - ENTRY-RUNG FORCED: the wire tier is the literal HONCHO_DERIVER_FORCED_TIER
 *    ('standard' — the CHEAPEST METERED rung, not a free one), set HERE, never read
 *    from a selection. An operator on eve-max can never make EVE's memory-derivation
 *    bill a frontier tier (the money invariant runs in that direction: the cap is on
 *    what a background task may SPEND, not a promise that it spends nothing).
 *  - EGRESS-SAFE: it delegates to handleEveCloudCompletions, so the SAME S11/S13
 *    egress boundary (PII redaction + receipt) runs before any byte leaves the
 *    machine — identical guarantee to chat, per the founder DSGVO requirement.
 *  - NOT A WARMUP: on its own path there is no isCommandEveWarmupRequest ambiguity
 *    (a 'ping' deriver call is a real request here, never silently routed local).
 *
 * No dispatch token: the deriver is EVE's OWN memory reasoning, not a delegated
 * team worker, so attribution defaults to `eve` (and team pause/fire gating,
 * which only blocks positively-known delegated roles, is a no-op for it).
 */
async function handleHonchoDeriverCompletions(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): Promise<void> {
  const rawBody = await readBody(request);
  // ALLOWLIST the outbound body (Codex #2 + re-audit HIGH). The deriver is
  // REASONING-ONLY, so forward ONLY the fields it needs: `messages` — which the
  // egress boundary scans + redacts (S11/S13) — plus `stream` and the harmless
  // `model` ref. EVERY other field is dropped: tools / tool_choice /
  // parallel_tool_calls / response_format (which handleEveCloudCompletions would
  // otherwise pass through UN-scanned — the boundary only inspects `messages`), and
  // any future OpenAI field. This is robust BY CONSTRUCTION, not a denylist, so no
  // un-scanned field can ever egress on this lane.
  //
  // NOTE for the Inc.3 wiring: if Honcho's deriver requires `response_format` for
  // structured output, DO NOT just re-add it here — either configure the deriver to
  // parse free text, or extend the egress scan to cover the added field first.
  const body: Record<string, unknown> = {
    messages: rawBody.messages,
    stream: rawBody.stream,
    model: rawBody.model,
  };
  // THE OPERATOR'S OWN LANE CHOICE DECIDES WHETHER BACKGROUND MEMORY MAY SPEND.
  // Read BEFORE the route/licence checks so a seat on a zero-cost selection can not
  // reach the metered egress even when Honcho is fully provisioned and licensed.
  // Default-deny in every direction: a thrown resolver (the R4 unknown-entitlement
  // hold) and an absent resolver both land on `false`, never on "go ahead".
  let chatLaneIsMeteredCloud = false;
  try {
    // No body: this is background reasoning, never a one-turn managed visual grant.
    const chatRoute = await options.eveRouting();
    chatLaneIsMeteredCloud = chatRoute?.active === true;
  } catch {
    chatLaneIsMeteredCloud = false;
  }
  if (!chatLaneIsMeteredCloud) {
    jsonResponse(response, 503, {
      error: {
        message:
          'Honcho memory derivation stays on the selected private lane; the metered cloud path is not available for it.',
      },
    });
    return;
  }
  const deriverRoute = await options.honchoDeriverRoute();
  const functionUrl = typeof deriverRoute?.functionUrl === 'string' ? deriverRoute.functionUrl.trim() : '';
  const license = typeof deriverRoute?.license === 'string' ? deriverRoute.license.trim() : '';
  // Fail CLOSED: without an active METERED cloud route + license the deriver has no
  // way to authenticate — never egress half-configured. The config core's
  // `ready` gate should already have kept the deriver from starting on this path.
  if (!deriverRoute?.active || functionUrl.length === 0 || license.length === 0) {
    jsonResponse(response, 503, {
      error: { message: 'Honcho deriver cloud lane is unavailable (no cloud route or license).' },
    });
    return;
  }
  // FORCE the Standard/Flash ENTRY rung — the cheapest METERED tier, a literal from
  // honchoRuntimeConfigCore, NEVER the user's picker tier. handleEveCloudCompletions
  // validates it against KNOWN_EVE_WIRE_TIERS, so a future rename that broke the
  // constant fails loud.
  const forcedRoute: CommandEveEveCloudRoute = {
    active: true,
    functionUrl,
    license,
    tier: HONCHO_DERIVER_FORCED_TIER,
  };
  // neverWaiveSecretFloor=true (Codex #1): the deriver is automatic background
  // reasoning, so the S3 secret floor holds even on the founder's own legacy seat.
  // MAT-1749: the deriver's registry membership is STRUCTURAL. It is declared here,
  // by the shim, because the caller reached the dedicated deriver ingress — not by
  // anything the client sent. `body` above is a fresh allowlisted object, so a
  // client-supplied `eve_operation` was already dropped and cannot borrow this rung.
  // 'shim' source: this process minted the rung from the ingress the caller reached,
  // so it is not a claim anyone made in a body and cannot be borrowed from the
  // general lane.
  await handleEveCloudCompletions(
    request,
    body,
    response,
    options,
    forcedRoute,
    undefined,
    await options.activeSeatContext(),
    newTypedUIProviderRequestId(),
    true,
    'honcho_deriver',
    'shim'
  );
}

export function localOpenAiPayload(
  body: Record<string, unknown>,
  route: CommandEveLocalOpenAiRoute
): Record<string, unknown> {
  if (route.payloadProfile === 'colibri') {
    const requestedEffort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase() : 'low';
    const reasoningEffort =
      requestedEffort === 'off' || requestedEffort === 'none'
        ? 'none'
        : requestedEffort === 'minimal'
          ? 'minimal'
          : requestedEffort === 'medium'
            ? 'medium'
            : requestedEffort === 'high'
              ? 'high'
              : requestedEffort === 'max' || requestedEffort === 'xhigh'
                ? 'xhigh'
                : 'low';
    const payload: Record<string, unknown> = {
      model: route.model,
      messages: asMessages(body.messages),
      stream: Boolean(body.stream),
      reasoning_effort: reasoningEffort,
      enable_thinking: reasoningEffort !== 'none',
    };
    const maxTokens = body.max_completion_tokens ?? body.max_tokens;
    if (maxTokens !== undefined) payload.max_completion_tokens = maxTokens;
    for (const key of ['temperature', 'top_p', 'tools', 'tool_choice'] as const) {
      if (body[key] !== undefined) payload[key] = body[key];
    }
    return payload;
  }
  const optionalKeys = [
    'max_tokens',
    'max_completion_tokens',
    'temperature',
    'top_p',
    'top_k',
    'min_p',
    'seed',
    'stop',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'response_format',
    'stream_options',
  ] as const;
  const payload: Record<string, unknown> = {
    model: route.model,
    messages: asMessages(body.messages),
    stream: Boolean(body.stream),
    ...resolveLocalOpenAiReasoningConfig(body),
  };
  for (const key of optionalKeys) {
    if (body[key] !== undefined) payload[key] = body[key];
  }
  return payload;
}

export function resolveLocalOpenAiReasoningConfig(body: Record<string, unknown>): Record<string, unknown> {
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase() : 'low';
  const maxTokensRaw = Number(body.max_completion_tokens ?? body.max_tokens);
  const maxTokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0 ? Math.floor(maxTokensRaw) : undefined;
  const requestedBudget =
    effort === 'off' || effort === 'none'
      ? 0
      : effort === 'minimal'
        ? 128
        : effort === 'medium'
          ? 2_048
          : effort === 'high'
            ? 8_192
            : effort === 'max'
              ? Number.POSITIVE_INFINITY
              : 512;
  const finalAnswerReserve = maxTokens ? Math.min(1_024, Math.max(64, Math.floor(maxTokens * 0.5))) : undefined;
  const budget =
    maxTokens && finalAnswerReserve !== undefined
      ? Math.min(requestedBudget, Math.max(0, maxTokens - finalAnswerReserve))
      : Number.isFinite(requestedBudget)
        ? requestedBudget
        : 8_192;
  const enableThinking = budget > 0;
  return {
    reasoning_format: enableThinking ? 'auto' : 'none',
    thinking_budget_tokens: budget,
    reasoning_control: true,
    chat_template_kwargs: { enable_thinking: enableThinking },
  };
}

async function handleLocalOpenAiCompletions(
  request: IncomingMessage,
  body: Record<string, unknown>,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>,
  route: CommandEveLocalOpenAiRoute,
  seatContext: CommandEveActiveSeatContext,
  providerRequestId: string
): Promise<void> {
  const baseUrl = typeof route.baseUrl === 'string' ? route.baseUrl.trim() : '';
  const apiKey = typeof route.apiKey === 'string' ? route.apiKey.trim() : '';
  const model = typeof route.model === 'string' ? route.model.trim() : '';
  if (!isStrictIpv4LoopbackOpenAiBaseUrl(baseUrl) || !apiKey || !model) {
    jsonResponse(response, 503, { error: { message: 'The selected local EVE model is not ready.' } });
    return;
  }

  const upstreamScope = createUpstreamRequestScope(request, response, options);
  try {
    const upstream = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      redirect: 'error',
      body: JSON.stringify(localOpenAiPayload(body, route)),
      signal: upstreamScope.signal,
    });
    upstreamScope.markHeadersReceived();

    const contentType = upstream.headers.get('content-type') || 'application/json';
    if (Boolean(body.stream) && upstream.body) {
      response.writeHead(upstream.status || 502, {
        'content-type': contentType,
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const reader = upstream.body.getReader();
      const typedUICapture = new OpenAITypedUIPublishSseCapture();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.byteLength > 0) upstreamScope.markBodyChunk();
        if (upstream.ok) typedUICapture.push(value);
        response.write(value);
      }
      if (upstream.ok) {
        reportCapturedTypedUIProviderCompletions(typedUICapture.finish(), {
          sessionId: body.session_id,
          provider: route.providerName || 'managed-local-openai',
          model,
          providerRequestId,
          route: 'managed_local',
          seatId: seatContext.seatId,
          seatContextRevision: seatContext.seatContextRevision,
          terminal: 'openai_sse',
          report: options.typedUIProviderCompletion,
        });
      }
      response.end();
      return;
    }

    const text = await upstream.text();
    if (text.length > 0) upstreamScope.markBodyChunk();
    // F-14 (Kimi 1.819 audit): non-OK upstream status must land in the outcome
    // receipt as upstream_error, not as a silent "completed".
    if (!upstream.ok) upstreamScope.markUpstreamError();
    if (upstream.ok) {
      try {
        reportCapturedTypedUIProviderCompletions(
          extractOpenAICompletedTypedUIPublishCalls(JSON.parse(text) as unknown),
          {
            sessionId: body.session_id,
            provider: route.providerName || 'managed-local-openai',
            model,
            providerRequestId,
            route: 'managed_local',
            seatId: seatContext.seatId,
            seatContextRevision: seatContext.seatContextRevision,
            terminal: 'openai_json',
            report: options.typedUIProviderCompletion,
          }
        );
      } catch {
        // The completion still reaches Hermes; missing receipt keeps Typed UI closed.
      }
    }
    response.writeHead(upstream.status || 502, { 'content-type': contentType });
    response.end(text || JSON.stringify({ error: { message: 'The selected local EVE model returned no result.' } }));
  } catch {
    const abortReason = upstreamScope.reason();
    if (abortReason) {
      writeUpstreamAbortResponse(response, abortReason);
    } else {
      upstreamScope.markUpstreamError();
      jsonResponse(response, 502, { error: { message: 'The selected local EVE model is unavailable.' } });
    }
  } finally {
    upstreamScope.dispose();
  }
}

/**
 * BYOK LANE (Baustein 2). The operator's own provider, their own key, their own
 * bill — funding-neutral for us, which is why the ladder never gates it.
 *
 * Shaped after `handleLocalOpenAiCompletions` (guard, upstream scope,
 * redirect:'error', stream passthrough, F-14 upstream-error marking, dispose in
 * finally) and after the CLOUD lane for its egress boundary, because that is what
 * this is: a turn that leaves the machine.
 *
 * IT REFUSES OUT LOUD. There is no warm-up, no fallback to local, no fallback to
 * cloud. Every refusal carries its own reason code so the operator can read what
 * happened instead of guessing at a 502 — silently routing a BYOK turn somewhere
 * else would be the exact falsehood this whole chain has been removing.
 */
async function handleConnectedProviderCompletions(
  request: IncomingMessage,
  body: Record<string, unknown>,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>,
  route: CommandEveConnectedProviderRoute,
  seatContext: CommandEveActiveSeatContext,
  providerRequestId: string
): Promise<void> {
  const baseUrl = typeof route.baseUrl === 'string' ? route.baseUrl.trim() : '';
  const apiKey = typeof route.apiKey === 'string' ? route.apiKey.trim() : '';
  const model = typeof route.model === 'string' ? route.model.trim() : '';
  if (!baseUrl || !apiKey || !model) {
    jsonResponse(response, 503, {
      error: { code: 'CONNECTED_PROVIDER_INCOMPLETE', message: 'The selected provider is not fully configured.' },
    });
    return;
  }
  const host = classifyConnectedProviderHost(baseUrl);
  if (host.ok !== true) {
    // A named refusal, never a generic failure and never a reroute.
    const reason = host.reason;
    jsonResponse(response, 502, {
      error: {
        code: reason,
        message:
          reason === 'CONNECTED_HOST_LOOPBACK'
            ? 'A loopback address is handled by the local lane, not by a connected provider.'
            : reason === 'CONNECTED_HOST_INSECURE_PUBLIC'
              ? 'A connected provider on a public host must use https.'
              : 'The connected provider base URL could not be read.',
      },
    });
    return;
  }

  // THE BOUNDARY RUNS BEFORE A BYTE LEAVES. Same guarantee as the cloud lane and
  // for the same reason — this egresses to a third party. `kind: 'cloud'` is the
  // honest classification: it is not our cloud, but it is not this machine either.
  const outboundMessages = asMessages(body.messages).map((message) => stripUnsupportedImageContent(message));
  const egressBoundary = await evaluateCommandEveEgressBoundary({
    text: outboundMessages.map(messageText).join('\n\n'),
    provider: {
      kind: 'cloud',
      name: route.providerName || 'connected-provider',
      model,
      baseUrl,
    },
    policyAction: options.egressPolicyAction,
  });
  // `transport` is the cleartext evidence rule 3 owes the operator: a private-network
  // turn is allowed to be http, and the receipt says so rather than staying quiet.
  const egressReceipt = { ...egressBoundary.receipt, transport: host.transport };
  try {
    writeCommandEveEgressBoundaryReceipt(options.egressReceiptPath, egressReceipt);
  } catch (error) {
    console.warn('[Command EVE] Failed to write egress boundary receipt:', error);
  }
  response.setHeader('x-command-eve-egress-decision', egressBoundary.decision);
  response.setHeader('x-command-eve-connected-transport', host.transport);
  if (egressBoundary.decision === 'block') {
    jsonResponse(response, 451, {
      error: {
        code: 'CONNECTED_EGRESS_BLOCKED',
        message:
          'Command EVE blocked sensitive data before model egress. Move secrets into settings, an env file, or an approved vault flow.',
        receipt: egressReceipt,
      },
    });
    return;
  }
  const sendMessages =
    egressBoundary.decision === 'redact'
      ? outboundMessages.map((message) => redactMessageContent(message, 'S1', false))
      : outboundMessages;

  const upstreamScope = createUpstreamRequestScope(request, response, options);
  try {
    const upstream = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The ONLY place the operator's key appears.
        authorization: `Bearer ${apiKey}`,
      },
      // A 30x from an upstream must never re-POST this body — with the key on it —
      // to a host the operator did not name.
      redirect: 'error',
      body: JSON.stringify({ ...body, model, messages: sendMessages }),
      signal: upstreamScope.signal,
    });
    upstreamScope.markHeadersReceived();

    const contentType = upstream.headers.get('content-type') || 'application/json';
    if (Boolean(body.stream) && upstream.body) {
      response.writeHead(upstream.status || 502, {
        'content-type': contentType,
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const reader = upstream.body.getReader();
      const typedUICapture = new OpenAITypedUIPublishSseCapture();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value.byteLength > 0) upstreamScope.markBodyChunk();
        if (upstream.ok) typedUICapture.push(value);
        response.write(value);
      }
      if (upstream.ok) {
        reportCapturedTypedUIProviderCompletions(typedUICapture.finish(), {
          sessionId: body.session_id,
          provider: route.providerName || 'connected-provider',
          model,
          providerRequestId,
          route: 'connected',
          seatId: seatContext.seatId,
          seatContextRevision: seatContext.seatContextRevision,
          terminal: 'openai_sse',
          report: options.typedUIProviderCompletion,
        });
      }
      response.end();
      return;
    }

    const text = await upstream.text();
    if (text.length > 0) upstreamScope.markBodyChunk();
    if (!upstream.ok) upstreamScope.markUpstreamError();
    if (upstream.ok) {
      try {
        reportCapturedTypedUIProviderCompletions(
          extractOpenAICompletedTypedUIPublishCalls(JSON.parse(text) as unknown),
          {
            sessionId: body.session_id,
            provider: route.providerName || 'connected-provider',
            model,
            providerRequestId,
            route: 'connected',
            seatId: seatContext.seatId,
            seatContextRevision: seatContext.seatContextRevision,
            terminal: 'openai_json',
            report: options.typedUIProviderCompletion,
          }
        );
      } catch {
        // The completion still reaches Hermes; missing receipt keeps Typed UI closed.
      }
    }
    response.writeHead(upstream.status || 502, { 'content-type': contentType });
    response.end(
      text ||
        JSON.stringify({ error: { code: 'CONNECTED_PROVIDER_EMPTY', message: 'The provider returned no result.' } })
    );
  } catch {
    const abortReason = upstreamScope.reason();
    if (abortReason) {
      writeUpstreamAbortResponse(response, abortReason);
    } else {
      upstreamScope.markUpstreamError();
      // Unreachable is unreachable. It is NOT a reason to run the turn locally.
      jsonResponse(response, 502, {
        error: { code: 'CONNECTED_PROVIDER_UNREACHABLE', message: 'The selected provider could not be reached.' },
      });
    }
  } finally {
    upstreamScope.dispose();
  }
}

async function handleChatCompletions(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): Promise<void> {
  const body = await readBody(request);
  const model = String(body.model || '');
  const stream = Boolean(body.stream);
  const forceLocalVision = isCommandEveLocalVisionModel(model);
  const providerRequestId = newTypedUIProviderRequestId();
  let seatContext: CommandEveActiveSeatContext;
  try {
    seatContext = await options.activeSeatContext();
  } catch {
    // Chat may continue, but an invalid empty snapshot cannot be persisted as
    // a provider completion and therefore can never verify a Typed UI artifact.
    seatContext = { seatId: '', seatContextRevision: -1 };
  }

  // EVE Inference (cloud) lane takes precedence over the local Ollama path when
  // the active picker selection is an EVE tier. A warm-up ping ("ping") stays
  // local — it only ever exercises the bundled local model. The one vetted
  // MiniCPM vision identifier is also explicitly local: auxiliary vision must
  // not inherit the user's cloud chat picker or require a CEVE bearer.
  if (!isCommandEveWarmupRequest(body)) {
    // The resolver sees the original hidden one-turn authorization marker. An
    // invalid/expired marker rejects here and therefore fails closed instead of
    // falling through to Ollama. Strip the opaque marker before either cloud or
    // local model handling so it never becomes model-visible or leaves the Mac.
    const eveRoute = forceLocalVision ? { active: false } : await options.eveRouting(body);
    body.messages = asMessages(body.messages).map(stripManagedVisualTurnAuthorization);
    if (eveRoute?.active) {
      // MAT-1749 — THE PAID SEAM. Authenticating WHO called is not authorising WHAT
      // FOR. Everything above proved the caller holds the loopback nonce; only the
      // registry decides whether this OPERATION may spend the customer's money.
      //
      // Consulted HERE, before any cloud handling, so a refusal costs nothing: no
      // provider request, no reservation, no debit. Local lanes stay permissive —
      // this branch is only reached when the resolved route is the METERED one.
      const declaredOperation = readCommandEveDeclaredOperation(body);
      const seam = resolveCommandEvePaidSeam(declaredOperation);
      if (seam.disposition !== 'local_only') {
        // NOT the money decision — that belongs to handleEveCloudCompletions, which
        // is the only function that can actually spend. This branch decides LANE
        // only: anything not routed to local is handed to the egress function, which
        // refuses an absent or unclaimable operation itself (403, no upstream call).
        //
        // Duplicating the payability test here is what made the egress guard
        // unprovable: with the router refusing first, neutralising the real guard
        // changed nothing any test could see.
        //
        // SG-1 A1: the attribution token rides the X-EVE-Dispatch HEADER, never the
        // body — so a client that stuffs `body.agent_id` cannot spoof a role.
        const dispatchToken = headerToken(request.headers['x-eve-dispatch']);
        await handleEveCloudCompletions(
          request,
          body,
          response,
          options,
          eveRoute,
          dispatchToken,
          seatContext,
          providerRequestId,
          false,
          declaredOperation,
          'client'
        );
        return;
      }
      // local_only — the operation may RUN but may not SPEND. Two ways to land here:
      // a registered non-billable rung (title_generation, compression), or a named
      // operation nobody registered — including one a future Hermes adds. Both fall
      // through to the local lanes below and must NEVER reach the paid one: if local
      // derivation is unavailable the user simply gets no auto-title, exactly as
      // d5135ec6 decided for the title path AionUi owned. Silently borrowing the paid
      // lane is the bug; running for free is not.
      //
      // The reason rides the receipt so an operator can tell "known and deliberately
      // free" from "unknown, so we declined to bill for it".
      response.setHeader(
        COMMAND_EVE_OPERATION_DECISION_HEADER,
        seam.reason ? `local_only:${seam.reason}:${seam.operation}` : `local_only:${seam.operation}`
      );
    }
  }

  // BYOK lane, resolved BEFORE the local block on purpose: it runs its own
  // cloud-class egress boundary, and letting the local block run first would
  // classify a third-party turn as `kind: 'local'` — a receipt that says the
  // opposite of what happened. A warm-up ping is never BYOK.
  if (!isCommandEveWarmupRequest(body) && !forceLocalVision) {
    let connectedRoute: CommandEveConnectedProviderRoute | undefined;
    try {
      connectedRoute = await options.connectedProviderRouting();
    } catch (error) {
      console.warn('[Command EVE] Connected provider route failed:', error);
      // Refusing is a valid answer; falling through to a local turn the operator
      // did not choose is not.
      jsonResponse(response, 503, {
        error: { code: 'CONNECTED_PROVIDER_UNRESOLVED', message: 'The selected provider could not be resolved.' },
      });
      return;
    }
    if (connectedRoute?.active) {
      response.setHeader('x-command-eve-inference-lane', 'connected');
      await handleConnectedProviderCompletions(
        request,
        body,
        response,
        options,
        connectedRoute,
        seatContext,
        providerRequestId
      );
      return;
    }
  }

  let localOpenAiRoute: CommandEveLocalOpenAiRoute | undefined;
  try {
    localOpenAiRoute = await options.localOpenAiRouting(model);
  } catch (error) {
    console.warn('[Command EVE] Managed local OpenAI route failed:', error);
    jsonResponse(response, 503, { error: { message: 'The selected local EVE model is not ready.' } });
    return;
  }

  const useLocalOllamaVision = !localOpenAiRoute?.active && forceLocalVision;
  let localMessages = asMessages(body.messages).map((message) =>
    useLocalOllamaVision ? stripNativeImageHintsOnly(message) : stripUnsupportedImageContent(message)
  );
  body.messages = localMessages;

  if (!isCommandEveWarmupRequest(body)) {
    const egressBoundary = await evaluateCommandEveEgressBoundary({
      text: localMessages.map(messageText).join('\n\n'),
      provider: {
        kind: 'local',
        name: localOpenAiRoute?.active ? localOpenAiRoute.providerName || 'managed-local-openai' : 'ollama',
        model: localOpenAiRoute?.active ? localOpenAiRoute.model || model : model,
        baseUrl: localOpenAiRoute?.active ? localOpenAiRoute.baseUrl || '' : options.ollamaBaseUrl,
      },
      policyAction: options.egressPolicyAction,
    });
    try {
      writeCommandEveEgressBoundaryReceipt(options.egressReceiptPath, egressBoundary.receipt);
    } catch (error) {
      console.warn('[Command EVE] Failed to write egress boundary receipt:', error);
    }
    response.setHeader('x-command-eve-egress-decision', egressBoundary.decision);
    if (egressBoundary.decision === 'block') {
      jsonResponse(response, 451, {
        error: {
          message:
            'Command EVE blocked sensitive data before model egress. Move secrets into settings, an env file, or an approved vault flow.',
          receipt: egressBoundary.receipt,
        },
      });
      return;
    }
    if (egressBoundary.decision === 'redact') {
      // Local lane never egresses and never carries a toggle context, so it always
      // redacts at the full S1 threshold (legacy behaviour). Wrap so Array.map's
      // (value,index,array) never leaks the index into the minClass parameter.
      localMessages = localMessages.map((message) => redactMessageContent(message, 'S1', useLocalOllamaVision));
      body.messages = localMessages;
    }

    const proof = buildCommandEvePromptProof(body);
    try {
      writePromptProof(options.promptProofPath, proof);
    } catch (error) {
      console.warn('[Command EVE] Failed to write prompt proof receipt:', error);
    }
    response.setHeader('x-command-eve-persona-proof', proof.ok ? proof.prompt_sha256 : 'missing');
    if (!proof.ok) {
      console.warn(`[Command EVE] Prompt proof missing EVE marker for model ${model || 'unknown'}.`);
    }
  }
  if (localOpenAiRoute?.active) {
    response.setHeader('x-command-eve-inference-lane', 'managed_local');
    await handleLocalOpenAiCompletions(
      request,
      body,
      response,
      options,
      localOpenAiRoute,
      seatContext,
      providerRequestId
    );
    return;
  }
  if (useLocalOllamaVision) {
    const preparedVision = prepareLocalOllamaVisionMessages(asMessages(body.messages));
    if (preparedVision.invalidImageCount > 0) {
      jsonResponse(response, 400, {
        error: { message: 'The local vision request contained an invalid or unsupported embedded image.' },
      });
      return;
    }
    body.messages = preparedVision.messages;
  }
  response.setHeader('x-command-eve-inference-lane', 'ollama_local');
  const upstreamScope = createUpstreamRequestScope(request, response, options);
  try {
    const upstream = await fetchOllama(
      '/api/chat',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(nativeChatPayload(body, options)),
        signal: upstreamScope.signal,
      },
      options
    );
    upstreamScope.markHeadersReceived();

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      if (text.length > 0) upstreamScope.markBodyChunk();
      jsonResponse(response, upstream.status || 502, { error: { message: text || 'Ollama request failed' } });
      return;
    }

    if (!stream) {
      const data = (await upstream.json()) as {
        message?: { content?: string; tool_calls?: unknown };
        done?: boolean;
        done_reason?: string;
      };
      upstreamScope.markBodyChunk();
      const normalizedToolCalls = normalizeOllamaToolCallsForOpenAI(data.message?.tool_calls, providerRequestId, {
        nextOrdinal: 0,
      });
      const normalizedData = {
        ...data,
        message: { ...data.message, ...(normalizedToolCalls === undefined ? {} : { tool_calls: normalizedToolCalls }) },
      };
      reportCapturedTypedUIProviderCompletions(extractOllamaCompletedTypedUIPublishCalls(normalizedData), {
        sessionId: body.session_id,
        provider: 'ollama',
        model,
        providerRequestId,
        route: 'ollama_local',
        seatId: seatContext.seatId,
        seatContextRevision: seatContext.seatContextRevision,
        terminal: 'ollama_json',
        report: options.typedUIProviderCompletion,
      });
      jsonResponse(response, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: data.message?.content || '',
              ...(normalizedToolCalls ? { tool_calls: normalizedToolCalls } : {}),
            },
            finish_reason: data.done_reason === 'length' ? 'length' : 'stop',
          },
        ],
      });
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason = 'stop';
    let sawOllamaTerminal = false;
    let ollamaStreamInvalid = false;
    const normalizedToolCalls: unknown[] = [];
    const toolCallIdState: OllamaToolCallIdState = { nextOrdinal: 0 };
    const processOllamaLine = (line: string): void => {
      if (!line.trim()) return;
      if (sawOllamaTerminal) {
        ollamaStreamInvalid = true;
        return;
      }
      const chunk = JSON.parse(line) as {
        message?: { content?: string; tool_calls?: unknown };
        done?: boolean;
        done_reason?: string;
      };
      const nextToolCalls = normalizeOllamaToolCallsForOpenAI(
        chunk.message?.tool_calls,
        providerRequestId,
        toolCallIdState
      );
      if (chunk.done) {
        sawOllamaTerminal = true;
        finishReason = chunk.done_reason === 'length' ? 'length' : 'stop';
        if (finishReason !== 'length') {
          if (Array.isArray(nextToolCalls)) normalizedToolCalls.push(...nextToolCalls);
          if (chunk.message?.content || nextToolCalls) {
            writeStreamChunk(response, model, chunk.message?.content || '', nextToolCalls);
          }
        }
        return;
      }
      if (Array.isArray(nextToolCalls)) normalizedToolCalls.push(...nextToolCalls);
      writeStreamChunk(response, model, chunk.message?.content || '', nextToolCalls);
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > 0) upstreamScope.markBodyChunk();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) processOllamaLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) processOllamaLine(buffer);

    const typedUIExtraction = ollamaStreamInvalid
      ? ({ ok: false, reason: 'jsonl_data_after_terminal' } as const)
      : extractOllamaCompletedTypedUIPublishCalls({
          done: sawOllamaTerminal,
          done_reason: finishReason,
          message: { tool_calls: normalizedToolCalls },
        });
    reportCapturedTypedUIProviderCompletions(typedUIExtraction, {
      sessionId: body.session_id,
      provider: 'ollama',
      model,
      providerRequestId,
      route: 'ollama_local',
      seatId: seatContext.seatId,
      seatContextRevision: seatContext.seatContextRevision,
      terminal: 'ollama_jsonl',
      report: options.typedUIProviderCompletion,
    });

    response.write(
      `data: ${JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      })}\n\n`
    );
    response.write('data: [DONE]\n\n');
    response.end();
  } catch {
    const abortReason = upstreamScope.reason();
    if (abortReason) {
      writeUpstreamAbortResponse(response, abortReason);
    } else if (response.headersSent) {
      upstreamScope.markUpstreamError();
      if (!response.writableEnded) response.end();
    } else {
      upstreamScope.markUpstreamError();
      jsonResponse(response, 502, { error: { message: 'Ollama upstream unreachable.' } });
    }
  } finally {
    upstreamScope.dispose();
  }
}

/**
 * SG-1 Design B — `POST /eve/team/propose`. A THIN HTTP front: authenticate with
 * the per-boot bearer, then hand the raw proposal to the injected main-side handler.
 *
 * ISO-6 + auth: an empty expected bearer (a client seat, or team_manage simply not
 * provisioned) makes the route respond 404 — it does not even reveal itself, and no
 * proposal is ever accepted. Only a request carrying the exact per-boot bearer
 * reaches `options.teamManagePropose`. No settings write happens on this path (B1).
 */
async function handleTeamManagePropose(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): Promise<void> {
  const expected = options.teamManageBearer();
  const authHeader = headerToken(request.headers['authorization']);
  const match = authHeader ? /^bearer\s+(.+)$/i.exec(authHeader) : null;
  const token = match ? match[1].trim() : authHeader;
  // Empty expected ⇒ inert; a mismatch ⇒ inert. Never treat an empty token as a
  // match. Constant-time compare (EVE-cloud audit): no early-exit timing oracle.
  if (!expected || !token || !constantTimeEquals(token, expected)) {
    jsonResponse(response, 404, { error: { message: 'Unsupported Command EVE Ollama shim path: /eve/team/propose' } });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    jsonResponse(response, 400, { error: { message: 'Invalid JSON body.' } });
    return;
  }
  const result = await options.teamManagePropose(body);
  jsonResponse(response, result.status, result.payload);
}

/**
 * COMPA-626 — `POST /eve/kanban/propose`. Bearer-gated thin front (mirror of team_manage):
 * authenticate with the per-boot kanban bearer, then hand the raw proposal to the injected
 * main-side handler which validates + stores a pending intent. NO kanban.db write here (K1).
 */
async function handleKanbanAcpPropose(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): Promise<void> {
  const expected = options.kanbanAcpBearer();
  const authHeader = headerToken(request.headers['authorization']);
  const match = authHeader ? /^bearer\s+(.+)$/i.exec(authHeader) : null;
  const token = match ? match[1].trim() : authHeader;
  if (!expected || !token || !constantTimeEquals(token, expected)) {
    jsonResponse(response, 404, {
      error: { message: 'Unsupported Command EVE Ollama shim path: /eve/kanban/propose' },
    });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readBody(request);
  } catch {
    jsonResponse(response, 400, { error: { message: 'Invalid JSON body.' } });
    return;
  }
  const result = await options.kanbanAcpPropose(body);
  jsonResponse(response, result.status, result.payload);
}

/**
 * COMPA-626 — `GET /eve/kanban/read`. Bearer-gated (same per-boot kanban bearer, so it is
 * inert on a client seat / when unprovisioned). Returns the READ-ONLY board digest. There
 * is NO mutation handler on this path — reading the board can never grant a write.
 */
/**
 * Answer ONE approval question by reading the same rendered seat grant the
 * settings panel writes. No policy lives here; this is a transport.
 *
 * Fail-closed on every unclear input: a missing command, an unreadable grant or
 * a thrown resolver all answer `ask`. The caller (the Hermes patch) also treats
 * any non-200 as `ask`, so there are two independent ways to end up asking and
 * none to accidentally end up allowing.
 */
async function handleApprovalDecision(
  requestUrl: URL,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): Promise<void> {
  const command = requestUrl.searchParams.get('command') ?? '';
  // Absent/anything-but-0 means "inside" is NOT established ⇒ treated as outside,
  // which is the stricter reading.
  const insideWorkspace = requestUrl.searchParams.get('inside') === '1';
  try {
    const runtime = await options.commandEveApproval();
    const decision = decideCommandApproval({ command, insideWorkspace }, runtime);
    jsonResponse(response, 200, {
      decision,
      edit_policy: runtime.edit_policy,
      ladder: runtime.ladder,
    });
  } catch {
    jsonResponse(response, 200, { decision: 'ask', edit_policy: 'ask', ladder: 0 });
  }
}

/**
 * Structured authority seam for native Hermes tools that do not already have
 * the terminal/file ACP authority callbacks.
 * The provider hook sends only the tool/action identity — never typed text,
 * page content, credentials or screenshots. Unknown/oversized values ask.
 */
async function handleHermesToolApprovalDecision(
  requestUrl: URL,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): Promise<void> {
  const toolName = requestUrl.searchParams.get('tool') ?? '';
  const action = requestUrl.searchParams.get('action') ?? '';
  if (!toolName || toolName.length > 128 || action.length > 128) {
    jsonResponse(response, 200, { decision: 'ask', ladder: 0 });
    return;
  }
  try {
    const runtime = await options.commandEveApproval();
    const decision = decideHermesToolApproval({ toolName, action }, runtime);
    jsonResponse(response, 200, { decision, ladder: runtime.ladder });
  } catch {
    jsonResponse(response, 200, { decision: 'ask', ladder: 0 });
  }
}

async function handleKanbanAcpRead(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): Promise<void> {
  const expected = options.kanbanAcpBearer();
  const authHeader = headerToken(request.headers['authorization']);
  const match = authHeader ? /^bearer\s+(.+)$/i.exec(authHeader) : null;
  const token = match ? match[1].trim() : authHeader;
  if (!expected || !token || !constantTimeEquals(token, expected)) {
    jsonResponse(response, 404, { error: { message: 'Unsupported Command EVE Ollama shim path: /eve/kanban/read' } });
    return;
  }
  jsonResponse(response, 200, options.kanbanAcpRead());
}

/**
 * The artifact capability route carries an operation name, two opaque
 * credentials and an instruction of at most 2000 characters. 64 KB is generous
 * by two orders of magnitude and still refuses a body that could only be an
 * attempt to push bytes through a local port that was never meant to carry them.
 * The shim's general `readBody` bound is 25 MB, which is right for an inference
 * request and wrong for this.
 */
const ARTIFACT_CAPABILITY_MAX_BODY_BYTES = 64 * 1024;

/**
 * Read a bounded JSON body.
 *
 * The cap is enforced WHILE reading rather than after: a 25 MB body checked at
 * the end has already been in memory. The distinct error lets the route answer
 * 413 rather than a misleading "invalid JSON".
 */
function readBoundedJsonBody(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let aborted = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (aborted) return;
      raw += chunk;
      if (raw.length > maxBytes) {
        aborted = true;
        reject(new Error('ARTIFACT_CAPABILITY_BODY_TOO_LARGE'));
        // Consume rather than destroy: destroying mid-flight makes the client
        // see a transport error instead of the 413 we are about to send, which
        // turns a clear refusal into an unexplained failure.
        request.resume();
      }
    });
    request.on('end', () => {
      if (aborted) return;
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

/**
 * MAT-1747 — `POST /eve/artifact/call`. Bearer-gated exactly like the kanban
 * routes, so it is a 404 on an unprovisioned seat rather than an open endpoint.
 *
 * ONE route rather than one per operation: the surface an MCP child can reach
 * should be as small as the thing it needs to do, and every capability here is
 * "present a handle, name an operation". Routing by operation INSIDE main keeps
 * the authority decision in one place instead of spread across a handler per
 * operation that could drift apart. Two operations exist today
 * (`artifact_get`, `video_edit`) and anything else is a 400.
 */
async function handleArtifactCapabilityCall(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<CommandEveOllamaShimOptions>
): Promise<void> {
  const expected = options.artifactCapabilityBearer();
  const authHeader = headerToken(request.headers['authorization']);
  const match = authHeader ? /^bearer\s+(.+)$/i.exec(authHeader) : null;
  const token = match ? match[1].trim() : authHeader;
  if (!expected || !token || !constantTimeEquals(token, expected)) {
    jsonResponse(response, 404, {
      error: { message: 'Unsupported Command EVE Ollama shim path: /eve/artifact/call' },
    });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJsonBody(request, ARTIFACT_CAPABILITY_MAX_BODY_BYTES);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'ARTIFACT_CAPABILITY_BODY_TOO_LARGE';
    jsonResponse(response, tooLarge ? 413 : 400, {
      error: { message: tooLarge ? 'Request body too large.' : 'Invalid JSON body.' },
    });
    return;
  }
  const result = await options.artifactCapabilityCall(body);
  jsonResponse(response, result.status, result.payload);
}

export function startCommandEveOllamaOpenAiShim(shimOptions: CommandEveOllamaShimOptions = {}): Promise<string> {
  if (server?.listening) return Promise.resolve(serverUrl || `http://127.0.0.1:${DEFAULT_SHIM_PORT}`);
  if (serverStartInFlight) return serverStartInFlight;

  const startPromise = startCommandEveOllamaOpenAiShimOnce(shimOptions);
  serverStartInFlight = startPromise;
  const clearStart = () => {
    if (serverStartInFlight === startPromise) serverStartInFlight = undefined;
  };
  void startPromise.then(clearStart, clearStart);
  return startPromise;
}

async function startCommandEveOllamaOpenAiShimOnce(shimOptions: CommandEveOllamaShimOptions): Promise<string> {
  // F-04 (Kimi 1.819 audit): an explicitly supplied ollamaBaseUrl must stay on
  // loopback. No production caller passes this option today, but any future
  // config plumbing must fail closed instead of silently creating off-host
  // egress from the shim lane.
  if (shimOptions.ollamaBaseUrl && !isLoopbackHttpUrl(shimOptions.ollamaBaseUrl)) {
    throw new Error('Command EVE ollamaBaseUrl must be a loopback http URL (127.0.0.1/localhost/::1 with port).');
  }
  const options: Required<CommandEveOllamaShimOptions> = {
    // Parallel E2E workers must not mistake another test/dev instance for a
    // production port conflict. Port 0 is limited to the explicit test mode;
    // normal desktop launches remain pinned to the documented 25811 endpoint.
    port: resolveCommandEveShimListenPort(shimOptions.port),
    authToken: shimOptions.authToken?.trim() || ensureCommandEveShimAuthToken(),
    ollamaBaseUrl: shimOptions.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
    numCtx: shimOptions.numCtx || DEFAULT_NUM_CTX,
    maxTokens: shimOptions.maxTokens || DEFAULT_MAX_TOKENS,
    upstreamFirstByteTimeoutMs: shimOptions.upstreamFirstByteTimeoutMs ?? DEFAULT_UPSTREAM_FIRST_BYTE_TIMEOUT_MS,
    upstreamIdleTimeoutMs: shimOptions.upstreamIdleTimeoutMs ?? DEFAULT_UPSTREAM_IDLE_TIMEOUT_MS,
    promptProofPath: shimOptions.promptProofPath || '',
    egressReceiptPath: shimOptions.egressReceiptPath || '',
    upstreamOutcomeReceiptPath:
      shimOptions.upstreamOutcomeReceiptPath ||
      (shimOptions.egressReceiptPath
        ? path.join(path.dirname(shimOptions.egressReceiptPath), 'last-upstream-outcome-receipt.json')
        : ''),
    managedVisualAuthorizationFailureReceiptPath:
      shimOptions.managedVisualAuthorizationFailureReceiptPath ||
      (shimOptions.egressReceiptPath
        ? path.join(path.dirname(shimOptions.egressReceiptPath), 'last-managed-visual-authorization-failure.json')
        : ''),
    upstreamOutcomeHistoryPath:
      shimOptions.upstreamOutcomeHistoryPath ||
      (shimOptions.egressReceiptPath
        ? path.join(path.dirname(shimOptions.egressReceiptPath), 'upstream-outcome-history.jsonl')
        : ''),
    upstreamOutcomeReporter: shimOptions.upstreamOutcomeReporter || (() => undefined),
    // Redact-and-continue by default (see egressBoundaryCore): a hard block 451s
    // non-retryably and hangs the turn. PII is stripped before egress, never leaked.
    egressPolicyAction: shimOptions.egressPolicyAction || 'redact',
    // Default resolver keeps every request on the local lane.
    eveRouting: shimOptions.eveRouting || ((): undefined => undefined),
    // Default resolver keeps the existing Ollama conversion untouched. A managed
    // OpenAI-local provider is opt-in and branches before nativeChatPayload().
    localOpenAiRouting: shimOptions.localOpenAiRouting || ((): undefined => undefined),
    // Default resolver returns no status map ⇒ every worker is treated active
    // (gating is a no-op until the main process injects the live status map).
    teamWorkerStatus: shimOptions.teamWorkerStatus || ((): undefined => undefined),
    // Default resolver returns 'on' ⇒ always redact (fail-SAFE). The switch is a
    // no-op (redaction unchanged) until the main process injects the live mode.
    egressRedactionMode: shimOptions.egressRedactionMode || ((): 'on' => 'on'),
    // Default resolver returns the legacy 'seat-1' ⇒ attribution is byte-stable
    // (server treats 'seat-1' and absent alike) until main injects getActiveSeatId.
    activeSeatId: shimOptions.activeSeatId || ((): string => 'seat-1'),
    activeSeatContext:
      shimOptions.activeSeatContext ||
      (async (): Promise<CommandEveActiveSeatContext> => ({
        seatId: await (shimOptions.activeSeatId || ((): string => 'seat-1'))(),
        seatContextRevision: 0,
      })),
    // Inert by default: no private producer means provenance remains rejected.
    typedUIProviderCompletion: shimOptions.typedUIProviderCompletion || (() => undefined),
    // SG-1 A1: default attribution is the system `eve` (no header producer until
    // the 1.8 wheel train) ⇒ the un-delegated shape, byte-identical to before.
    attributionAgentId: shimOptions.attributionAgentId || ((): string => 'eve'),
    // SG-1 Design B: default team_manage is UNPROVISIONED — empty bearer + a 404
    // handler, so the propose route is inert until main injects it on an operator seat.
    teamManageBearer: shimOptions.teamManageBearer || ((): string => ''),
    teamManagePropose:
      shimOptions.teamManagePropose ||
      (async (): Promise<{ status: number; payload: unknown }> => ({
        status: 404,
        payload: { error: { message: 'team_manage is not available on this seat.' } },
      })),
    // COMPA-626: default kanban-ACP is UNPROVISIONED — empty bearer + inert
    // propose/read, so the routes are 404 until main injects them.
    //
    // "ON AN OPERATOR SEAT" WAS THE MISLEADING HALF (corrected 1.821.0). Main
    // injects these unconditionally at every shim start site; what actually
    // decided whether they answered was the BEARER FILE, and that file is deleted
    // on a seat whose kind reads 'client' (kanbanAcpMain.ts:86). Until now the
    // founder's own seat folded to 'client' on every switch
    // (seatSwitchCore.ts:204/:295), so the routes were dark on the one seat that
    // owns the board — and the comment pointed the reader at an injection that
    // was never missing. The fold is gone; the defaults below stay, because an
    // un-wired shim must still answer 404 rather than guess.
    kanbanAcpBearer: shimOptions.kanbanAcpBearer || ((): string => ''),
    kanbanAcpPropose:
      shimOptions.kanbanAcpPropose ||
      (async (): Promise<{ status: number; payload: unknown }> => ({
        status: 404,
        payload: { error: { message: 'kanban_manage is not available on this seat.' } },
      })),
    kanbanAcpRead: shimOptions.kanbanAcpRead || ((): unknown => ({ ok: false, reason: 'not-available' })),
    // Inert default: no BYOK route ⇒ nothing changes for any existing lane.
    connectedProviderRouting:
      shimOptions.connectedProviderRouting || ((): CommandEveConnectedProviderRoute => ({ active: false })),
    // Fail-CLOSED default: the fail-closed grant answers every question with
    // "ask", so an un-wired shim asks about everything.
    commandEveApproval:
      shimOptions.commandEveApproval ||
      ((): EveAuthorityRuntime => renderEveAuthorityRuntime(EVE_AUTHORITY_FAIL_CLOSED)),
    // COMPA-624: default is an INERT deriver lane (503) until main injects the
    // METERED cloud route on a seat where Honcho is provisioned — purely additive.
    honchoDeriverRoute: shimOptions.honchoDeriverRoute || ((): CommandEveHonchoDeriverRoute => ({ active: false })),
    // MAT-1747: default is UNPROVISIONED — empty bearer + inert handler, so
    // `/eve/artifact/call` is a 404 until main injects it. Byte-identical shim
    // behaviour for every seat that has not enabled the capability.
    artifactCapabilityBearer: shimOptions.artifactCapabilityBearer || ((): string => ''),
    artifactCapabilityCall:
      shimOptions.artifactCapabilityCall ||
      (async (): Promise<{ status: number; payload: unknown }> => ({
        status: 404,
        payload: { error: { message: 'artifact capabilities are not available on this seat.' } },
      })),
  };
  const nextServer = http.createServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
      const requestPath = requestUrl.pathname;
      if (request.method === 'GET' && requestPath === '/health') {
        jsonResponse(response, 200, { ok: true });
        return;
      }
      if (request.method === 'GET' && requestPath === '/v1/models') {
        if (!requireShimAuth(request, response, options.authToken)) return;
        await handleModels(response, options);
        return;
      }
      if (request.method === 'GET' && requestPath === '/v1/command-eve/context-policy') {
        if (!requireShimAuth(request, response, options.authToken)) return;
        await handleContextPolicy(requestUrl, response, options);
        return;
      }
      // CEVE-1821 — the approval question. Authenticated like every other
      // /v1/command-eve/* route, so an unauthenticated caller cannot ask the
      // product what it is allowed to do, let alone be told "allow".
      if (request.method === 'GET' && requestPath === '/v1/command-eve/approval') {
        if (!requireShimAuth(request, response, options.authToken)) return;
        await handleApprovalDecision(requestUrl, response, options);
        return;
      }
      if (request.method === 'GET' && requestPath === '/v1/command-eve/tool-approval') {
        if (!requireShimAuth(request, response, options.authToken)) return;
        await handleHermesToolApprovalDecision(requestUrl, response, options);
        return;
      }
      if (request.method === 'POST' && requestPath === '/v1/chat/completions') {
        if (!requireShimAuth(request, response, options.authToken)) return;
        await handleChatCompletions(request, response, options);
        return;
      }
      if (request.method === 'POST' && requestPath === '/v1/images') {
        if (!requireShimAuth(request, response, options.authToken)) return;
        await handleManagedImageGeneration(request, response);
        return;
      }
      // COMPA-624 — the Honcho deriver's dedicated METERED cloud lane. Separate path
      // so it is picker-independent + entry-rung-forced + never a warmup-ping.
      if (request.method === 'POST' && requestPath === '/honcho/deriver/v1/chat/completions') {
        if (!requireShimAuth(request, response, options.authToken)) return;
        await handleHonchoDeriverCompletions(request, response, options);
        return;
      }
      if (request.method === 'POST' && requestPath === '/eve/team/propose') {
        await handleTeamManagePropose(request, response, options);
        return;
      }
      if (request.method === 'POST' && requestPath === '/eve/kanban/propose') {
        await handleKanbanAcpPropose(request, response, options);
        return;
      }
      if (request.method === 'GET' && requestPath === '/eve/kanban/read') {
        await handleKanbanAcpRead(request, response, options);
        return;
      }
      if (request.method === 'POST' && requestPath === '/eve/artifact/call') {
        await handleArtifactCapabilityCall(request, response, options);
        return;
      }
      jsonResponse(response, 404, { error: { message: `Unsupported Command EVE Ollama shim path: ${requestPath}` } });
    })().catch((error) => {
      if (isCommandEveManagedVisualAuthorizationError(error)) {
        const receipt: CommandEveManagedVisualAuthorizationFailureReceipt = {
          version: 'command-eve-managed-visual-authorization-failure/v1',
          boundary: 'desktop_managed_visual_authorization',
          observed_at: new Date().toISOString(),
          status_code: error.statusCode,
          error_code: error.errorCode,
          authorization_reason_code: error.reasonCode,
          request_correlation_id: error.correlationId,
        };
        try {
          writeManagedVisualAuthorizationFailureReceipt(options.managedVisualAuthorizationFailureReceiptPath, receipt);
        } catch {
          // Failure evidence is diagnostic only; it must not turn a deterministic
          // non-retryable refusal into a generic, retryable server failure.
          console.warn('[Command EVE] Managed visual authorization failure receipt could not be recorded.');
        }
        console.warn(
          `[Command EVE] Managed visual authorization refused (${error.errorCode}; correlation=${error.correlationId}).`
        );
        response.setHeader('x-command-eve-error-correlation', error.correlationId);
        jsonResponse(response, error.statusCode, {
          error: {
            message: error.message,
            type: 'command_eve_managed_visual_authorization_error',
            code: error.errorCode,
          },
        });
        return;
      }
      // F-14 (Kimi 1.819 audit): never echo raw error.message to the client —
      // a latent throw source must not become a credential channel. Only errors
      // explicitly constructed as CommandEveShimPublicError carry client-safe,
      // deliberately authored fail-closed messages; everything else gets the
      // generic 500. Log content-free either way.
      console.warn('[Command EVE] Shim request failed with an internal error.');
      const message = isCommandEveShimPublicError(error) ? error.message : 'Command EVE shim internal error.';
      jsonResponse(response, 500, { error: { message } });
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      nextServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      nextServer.off('error', onError);
      resolve();
    };
    nextServer.once('error', onError);
    nextServer.once('listening', onListening);
    nextServer.listen(options.port, '127.0.0.1');
  });
  const address = nextServer.address();
  const port = address && typeof address !== 'string' ? address.port : options.port;
  activeOllamaBaseUrl = options.ollamaBaseUrl;
  server = nextServer;
  serverUrl = `http://127.0.0.1:${port}`;
  return serverUrl;
}

export async function stopCommandEveOllamaOpenAiShimForTest(): Promise<void> {
  await serverStartInFlight?.catch((): undefined => undefined);
  const activeServer = server;
  if (!activeServer) return;
  await new Promise<void>((resolve, reject) => {
    activeServer.close((error) => (error ? reject(error) : resolve()));
  });
  if (server === activeServer) {
    server = undefined;
    serverUrl = '';
    activeOllamaBaseUrl = DEFAULT_OLLAMA_BASE_URL;
  }
}

export async function warmCommandEveLocalModel(
  warmupOptions: CommandEveModelWarmupOptions
): Promise<CommandEveModelWarmupResult> {
  const startedAt = Date.now();
  const baseUrl = warmupOptions.baseUrl || serverUrl || `http://127.0.0.1:${DEFAULT_SHIM_PORT}`;
  const ollamaBaseUrl = warmupOptions.ollamaBaseUrl || activeOllamaBaseUrl;
  const maxTokens = warmupOptions.maxTokens ?? 1;
  if (!warmupOptions.model.trim()) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      model: warmupOptions.model,
      error: 'missing model',
    };
  }
  if (!isLoopbackHttpUrl(baseUrl)) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      model: warmupOptions.model,
      error: 'Command EVE model warm-up is local-only and requires a loopback URL.',
    };
  }
  if (!isLoopbackHttpUrl(ollamaBaseUrl)) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      model: warmupOptions.model,
      error: 'Command EVE model residency probe is local-only and requires a loopback Ollama URL.',
    };
  }

  // A receipt is historical evidence, not residency truth. Ask Ollama first;
  // if the exact normalized model is still loaded, avoid a synthetic prompt.
  if (await commandEveLocalModelIsResident(warmupOptions.model, ollamaBaseUrl)) {
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      model: warmupOptions.model,
    };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), warmupOptions.timeoutMs ?? 60_000);
  try {
    const response = await fetch(chatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${warmupOptions.authToken || ensureCommandEveShimAuthToken()}`,
      },
      redirect: 'error',
      signal: abortController.signal,
      body: JSON.stringify({
        model: warmupOptions.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: Math.max(1, Math.min(4, Math.floor(maxTokens))),
        stream: false,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        elapsedMs: Date.now() - startedAt,
        model: warmupOptions.model,
        error: text || `warm-up request failed (${response.status})`,
      };
    }
    await response.arrayBuffer().catch((): undefined => undefined);
    // The completed native chat response is already authoritative proof that
    // Ollama loaded and served this exact model. `/api/ps` is only the cheap
    // preflight that lets us skip this ping; a delayed or older inventory API
    // must not turn a successful warmup into a blocked user send.
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      model: warmupOptions.model,
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      model: warmupOptions.model,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * EVE Inference (cloud) lane preflight — RETIRED. THIS ISSUES NO REQUEST.
 *
 * It used to warm the TLS/edge path to the eve-inference Edge Function at
 * startup, and it did that by sending a minimal *real* EVE-persona chat (tiny
 * system + user message, max_tokens 1) shaped precisely so
 * `isCommandEveWarmupRequest` would NOT match and the shim would route it
 * through the live, METERED cloud lane. Every launch on an EVE tier therefore
 * bought a warm lane with the customer's credits for something nobody asked
 * for (MAT-1749). Starting an app is not a user-authorised billable action.
 *
 * What happens now: the loopback guard still rejects a non-loopback base URL
 * with an error result, and everything after it returns a first-class SKIP —
 * `{ ok: false, skipped: true }`, and no `status`, because nothing was
 * contacted. `skipped` exists so a caller cannot mistake this for a broken
 * cloud lane: `ok: false` alone reads as a fault and gets logged as a warning,
 * and a warning on every single launch is how operators learn to ignore
 * warnings.
 *
 * Refusing it at the shim's operation allowlist was considered and rejected: a
 * refusal is still an authenticated request, and it still produced that
 * per-launch warning. Declining before any I/O is the only version with nothing
 * to explain away.
 *
 * Fail-soft, unchanged: this never throws and never blocks app start.
 *
 * NO CALLER TODAY — `scheduleCommandEveEveLaneWarmup` was deleted along with the
 * charge. The function is kept as the landing spot for a dedicated NON-METERED
 * health endpoint; restoring edge warming means replacing the early return below
 * with a call to that endpoint, never re-registering this as a payable
 * operation.
 */
export async function warmCommandEveEveLane(
  warmupOptions: CommandEveEveLaneWarmupOptions = {}
): Promise<CommandEveEveLaneWarmupResult> {
  const startedAt = Date.now();
  const baseUrl = warmupOptions.baseUrl || serverUrl || `http://127.0.0.1:${DEFAULT_SHIM_PORT}`;
  const tier = warmupOptions.tier && warmupOptions.tier.trim() ? warmupOptions.tier.trim() : 'standard';

  if (!isLoopbackHttpUrl(baseUrl)) {
    return {
      ok: false,
      elapsedMs: Date.now() - startedAt,
      tier,
      error: 'Command EVE preflight must go through the loopback shim (no direct cloud egress).',
    };
  }

  // MAT-1749 — NO REQUEST IS ISSUED. There is deliberately no fetch below this line.
  //
  // This used to POST a one-token turn shaped, in its own words, so that it "is NOT
  // classified as a local warm-up and is routed through the EVE cloud lane instead".
  // That made every launch on a cloud tier a metered turn. Starting an app is not a
  // user-authorised billable action, so warming the edge is not a cost we may pass on.
  //
  // Letting the shim's operation allowlist refuse it was not good enough: a refusal
  // still sends an authenticated request and still produced a startup warning every
  // time. Declining here, before any I/O, is the only version with nothing to explain.
  //
  // The function is KEPT rather than deleted so a future NON-METERED health endpoint
  // has an obvious place to land — at which point this early return is what changes.
  return {
    ok: false,
    skipped: true,
    elapsedMs: Date.now() - startedAt,
    tier,
    error: 'Cloud preflight is disabled: app start is not a user-authorised billable action.',
  };
}
