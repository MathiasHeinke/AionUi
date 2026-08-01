/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read the live `commandEve.inferenceSelection` picker value FROM THE BACKEND
 * settings store — the single source of truth the renderer actually writes to.
 *
 * WHY THIS EXISTS (the 1.2.19 EVE-Max-routes-as-Flash root cause):
 *
 *   The renderer's `configService.set('commandEve.inferenceSelection', value)`
 *   PUTs to `/api/settings/client`, which the aioncore backend persists in its
 *   SQLite `client_preferences` table. It does NOT write the main-process
 *   `ProcessConfig` JSON file (`command-eve-config.txt`).
 *
 *   The main-process EVE routing resolver + warm-up lane previously read the
 *   selection via `ProcessConfig.getSync('commandEve.inferenceSelection')` — a
 *   store that NEVER receives the picker value. So that read ALWAYS returned
 *   `undefined`, which `resolveEffectiveInferenceSelection` defaults to EVE
 *   Standard → wire tier `standard` → DeepSeek V4 Flash. A user who picked EVE
 *   High/Max was silently billed/served Flash (OpenRouter logs: 100% Flash, GLM
 *   5.2 + V4 Pro never called). Because `standard` is a VALID wire tier, the
 *   shim's fail-loud (500 on unknown tier) never fired — the symptom was a clean
 *   `ok` + Flash, never an error.
 *
 *   This is the EXACT same store-split bug already fixed once for
 *   `webui.desktop.enabled` (see webuiConfig.ts: "renderer's configService was
 *   migrated to the backend HTTP store, but this main-process path was not").
 *
 * SEAT SCOPING: `commandEve.inferenceSelection` is a seat-scoped key
 * (SEAT_SCOPED_CONFIG_KEYS). The renderer persists it under the seat-physical
 * key (`seatScopedKey(logicalKey, activeSeatId)`); a legacy/no-seat holder uses
 * the un-prefixed key verbatim. We resolve the SAME physical key here so we read
 * the value the renderer actually wrote for the active seat.
 *
 * Two read contracts intentionally coexist:
 *   - `readInferenceSelectionFromBackend` is best-effort for descriptive seed
 *     generation where an absent/unreadable value may be rendered as unknown.
 *   - `readInferenceSelectionFromBackendStrict` is mandatory for routing and
 *     warm-up. A backend error must never look like an absent setting because
 *     absence legitimately defaults to EVE Standard while unreadable state must
 *     fail loud instead of silently changing the user's selected lane.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';
import {
  EVE_DEFAULT_INFERENCE_SELECTION,
  EVE_INFERENCE_FUNCTION_URL,
  EVE_MAX_ENTITLED_SETTINGS_KEY,
  isEveInferenceSelection,
  repairInferenceSelection,
  resolveEffectiveWireTierFromSelection,
  resolveWireTierFromSelection,
} from '@/common/config/eveInferenceCore';
import { buildEveCloudRoute, type CommandEveEveCloudRoute } from './ollamaOpenAiShim';
import { getActiveSeatId } from './seatContextCore';
import { CommandEveShimPublicError } from './shimPublicError';

const INFERENCE_SELECTION_KEY = 'commandEve.inferenceSelection';
/** The documented default selection, used as the last-resort sendable fallback. */
const EVE_DEFAULT_INFERENCE_SELECTION_FALLBACK = EVE_DEFAULT_INFERENCE_SELECTION;

/**
 * Read the persisted EVE inference picker selection from the backend settings
 * store for the currently-active seat. Returns the raw stored string (e.g.
 * `"command-eve-inference:eve-max"`) or `undefined` when absent/unreadable.
 *
 * NOTE: returns the RAW persisted value — apply `resolveEffectiveInferenceSelection`
 * at the call site so an absent value maps to the EVE-Standard default exactly as
 * the renderer's send path does.
 */
/**
 * The lane state the routing decision needs, read from ONE settings fetch.
 *
 * `maxEntitled` rides along in the SAME GET the selection already required, so
 * making the clamp real costs no extra request on the per-turn hot path. It is
 * three-state on purpose: `undefined` means the renderer has never written it
 * (fresh install, or a boot before the first renderer mount), and an unknown
 * entitlement must NOT be read as "unentitled" — guessing that would silently
 * downgrade a paying seat, which is the exact bug class this file exists to
 * close. Unknown therefore lets the tier travel and leaves the server as the
 * binding gate.
 */
export type CommandEveInferenceLaneState = {
  selection?: string;
  maxEntitled?: boolean;
};

function physicalSettingsKey(logicalKey: string): string {
  try {
    return seatScopedKey(logicalKey, getActiveSeatId());
  } catch {
    // Seat context not resolvable yet → fall back to the un-prefixed (legacy) key.
    return logicalKey;
  }
}

async function fetchInferenceLaneStateFromBackend(): Promise<CommandEveInferenceLaneState> {
  const physicalKey = physicalSettingsKey(INFERENCE_SELECTION_KEY);
  const maxEntitledKey = physicalSettingsKey(EVE_MAX_ENTITLED_SETTINGS_KEY);

  const settings = await httpRequest<Record<string, unknown>>('GET', '/api/settings/client');
  // Read the seat-physical key ONLY — do NOT fall back to the un-prefixed key on a
  // REAL seat (C1/C3 class, full-history re-audit). The un-prefixed value is the
  // FOUNDER/legacy seat's selection; a real client seat that never picked a model
  // would otherwise INHERIT the founder's tier (e.g. paid EVE Max) and silently
  // route the client's chats to the metered cloud lane, while the renderer — which
  // already refuses the un-prefixed read for a real seat — shows EVE Standard. An
  // absent scoped value maps (via resolveEffectiveInferenceSelection at the call
  // site) to the intended EVE-Standard default, matching the renderer. On the
  // legacy seat physicalKey === INFERENCE_SELECTION_KEY (un-prefixed), so this
  // still reads the founder's own value there; ditto for an unresolvable seat.
  const raw = settings?.[physicalKey];
  const rawMaxEntitled = settings?.[maxEntitledKey];
  return {
    selection: typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined,
    // ONLY an explicit boolean counts. A missing key, a string, or anything else
    // stays `undefined` = unknown, never `false`.
    maxEntitled: typeof rawMaxEntitled === 'boolean' ? rawMaxEntitled : undefined,
  };
}

/**
 * Best-effort read for non-routing metadata. An unreadable backend is represented
 * as unknown; callers must not use this contract to choose an inference lane.
 */
export async function readInferenceSelectionFromBackend(): Promise<string | undefined> {
  try {
    return (await fetchInferenceLaneStateFromBackend()).selection;
  } catch {
    return undefined;
  }
}

/**
 * Fail-loud read of the FULL lane state for routing and warm-up. A valid but
 * absent setting still yields `undefined` (fresh-user EVE Standard);
 * transport/backend failures reject with a stable public error so the shim
 * returns 500 instead of silently changing lanes.
 */
export async function readInferenceLaneStateFromBackendStrict(): Promise<CommandEveInferenceLaneState> {
  try {
    return await fetchInferenceLaneStateFromBackend();
  } catch {
    // Deliberately user-facing (fail-closed lane guard), same contract as the
    // selection-only reader below.
    throw new CommandEveShimPublicError('Command EVE cloud route unavailable: inference selection could not be read.');
  }
}

/**
 * Fail-loud read for callers that only need the selection string (warm-up).
 */
export async function readInferenceSelectionFromBackendStrict(): Promise<string | undefined> {
  try {
    return (await fetchInferenceLaneStateFromBackend()).selection;
  } catch {
    // Deliberately user-facing (fail-closed lane guard): constructed as a
    // CommandEveShimPublicError so the shim may echo this exact message while
    // every arbitrary throw gets the generic 500 (F-14, Kimi 1.819 audit).
    throw new CommandEveShimPublicError('Command EVE cloud route unavailable: inference selection could not be read.');
  }
}

/**
 * The COMPLETE main-process EVE-cloud route resolution chain, dependency-injected
 * so the full picker-selection → wire-tier mapping is unit-testable end-to-end
 * (the previous 1.2.19 unit tests only covered `resolveWireTierFromSelection` in
 * isolation; they passed while the LIVE chain still produced Standard because the
 * selection was read from the wrong store).
 *
 * Chain (exactly what the shim's per-request routing resolver runs):
 *   readLaneState() [ONE backend GET] → repairInferenceSelection
 *     → isEveInferenceSelection? → resolveEffectiveWireTierFromSelection(clamp)
 *     → buildEveCloudRoute
 *
 * A LOCAL selection returns `{ active: false }`. An EVE selection returns an
 * active route carrying the wire tier + license. A rejected `readLaneState`
 * deliberately propagates: unreadable state is not equivalent to an absent
 * setting and must never become an implicit Standard or local route.
 *
 * THE NON-BRICK CLAMP IS WIRED HERE, NOT INJECTED. `maxEntitled` comes from the
 * SAME settings fetch the selection already needed, so the production path
 * exercises it on every turn. When it proves the seat is NOT MAX-entitled, a
 * persisted MAX selection resolves to `standard` for THIS request only — the
 * stored intent is never rewritten here, so it lights up again the moment the
 * seat buys. When it is unknown the tier travels unchanged and the server stays
 * the binding gate; inferring "unentitled" from a missing flag would silently
 * downgrade a paying seat, the exact failure class this module exists to close.
 *
 * REPAIR: an EVE-prefixed value that resolves to NO tier previously reached the
 * shim as "no tier" and was answered 500 on every turn. It is repaired here, at
 * the wire, so the seat can always send regardless of whether the renderer hook
 * has ever mounted to rewrite the stored string.
 */
export async function resolveEveCloudRouteFromBackend(deps: {
  /** Read the persisted lane state (selection + MAX entitlement) in ONE fetch. */
  readLaneState: () => Promise<CommandEveInferenceLaneState>;
  /** Read the CEVE license wire (or undefined when absent). */
  readLicense: () => string | undefined;
  /** Edge Function URL (overridable in tests). */
  functionUrl?: string;
}): Promise<CommandEveEveCloudRoute | undefined> {
  const laneState = await deps.readLaneState();
  const { selection } = repairInferenceSelection(laneState.selection);
  if (!isEveInferenceSelection(selection)) {
    return { active: false };
  }
  // Belt and braces: repairInferenceSelection already guarantees a resolvable
  // EVE selection, so this fallback should be unreachable. It is here because
  // "should be unreachable" is exactly what the 500-every-turn bug believed
  // about itself — an unresolvable cloud selection must degrade to a sendable
  // tier, never to `undefined`.
  const tier =
    resolveEffectiveWireTierFromSelection(selection, { maxEntitled: laneState.maxEntitled }) ??
    resolveWireTierFromSelection(EVE_DEFAULT_INFERENCE_SELECTION_FALLBACK);
  const license = deps.readLicense();
  return buildEveCloudRoute({
    isEveSelection: true,
    tier,
    functionUrl: deps.functionUrl ?? EVE_INFERENCE_FUNCTION_URL,
    license,
  });
}
