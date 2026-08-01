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
  EVE_INFERENCE_FUNCTION_URL,
  isEveInferenceSelection,
  resolveEffectiveInferenceSelection,
  resolveEffectiveWireTierFromSelection,
} from '@/common/config/eveInferenceCore';
import { buildEveCloudRoute, type CommandEveEveCloudRoute } from './ollamaOpenAiShim';
import { getActiveSeatId } from './seatContextCore';
import { CommandEveShimPublicError } from './shimPublicError';

const INFERENCE_SELECTION_KEY = 'commandEve.inferenceSelection';

/**
 * Read the persisted EVE inference picker selection from the backend settings
 * store for the currently-active seat. Returns the raw stored string (e.g.
 * `"command-eve-inference:eve-max"`) or `undefined` when absent/unreadable.
 *
 * NOTE: returns the RAW persisted value — apply `resolveEffectiveInferenceSelection`
 * at the call site so an absent value maps to the EVE-Standard default exactly as
 * the renderer's send path does.
 */
async function fetchInferenceSelectionFromBackend(): Promise<string | undefined> {
  let physicalKey = INFERENCE_SELECTION_KEY;
  try {
    physicalKey = seatScopedKey(INFERENCE_SELECTION_KEY, getActiveSeatId());
  } catch {
    // Seat context not resolvable yet → fall back to the un-prefixed (legacy) key.
    physicalKey = INFERENCE_SELECTION_KEY;
  }

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
  return typeof raw === 'string' && raw.trim().length > 0 ? raw : undefined;
}

/**
 * Best-effort read for non-routing metadata. An unreadable backend is represented
 * as unknown; callers must not use this contract to choose an inference lane.
 */
export async function readInferenceSelectionFromBackend(): Promise<string | undefined> {
  try {
    return await fetchInferenceSelectionFromBackend();
  } catch {
    return undefined;
  }
}

/**
 * Fail-loud read for routing and warm-up. A valid but absent setting still returns
 * `undefined` (fresh-user EVE Standard); transport/backend failures reject with a
 * stable public error so the shim returns 500 instead of silently changing lanes.
 */
export async function readInferenceSelectionFromBackendStrict(): Promise<string | undefined> {
  try {
    return await fetchInferenceSelectionFromBackend();
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
 *   readSelection() [backend store] → resolveEffectiveInferenceSelection
 *     → isEveInferenceSelection? → resolveEffectiveWireTierFromSelection
 *     → buildEveCloudRoute
 *
 * A LOCAL selection returns `{ active: false }`. An EVE selection returns an
 * active route carrying the wire tier + license. A rejected `readSelection`
 * deliberately propagates: unreadable state is not equivalent to an absent
 * setting and must never become an implicit Standard or local route.
 *
 * THE NON-BRICK CLAMP: `readMaxEntitled` is OPTIONAL and three-state. When it
 * proves the seat is NOT MAX-entitled, a persisted MAX selection resolves to
 * `standard` for THIS request only — the stored intent is never rewritten here,
 * so it lights up again the moment the seat buys. When it is absent or returns
 * `undefined` the tier travels unchanged and the server stays the binding gate;
 * inferring "unentitled" from an unreadable status would silently downgrade a
 * paying seat, which is the exact failure class this module was written to close.
 */
export async function resolveEveCloudRouteFromBackend(deps: {
  /** Read the raw persisted picker selection (backend store). */
  readSelection: () => Promise<string | undefined>;
  /** Read the CEVE license wire (or undefined when absent). */
  readLicense: () => string | undefined;
  /** Edge Function URL (overridable in tests). */
  functionUrl?: string;
  /** Proven MAX entitlement, or `undefined` when unknown (see the clamp note). */
  readMaxEntitled?: () => boolean | undefined;
}): Promise<CommandEveEveCloudRoute | undefined> {
  const selection = resolveEffectiveInferenceSelection(await deps.readSelection());
  if (!isEveInferenceSelection(selection)) {
    return { active: false };
  }
  const tier = resolveEffectiveWireTierFromSelection(selection, { maxEntitled: deps.readMaxEntitled?.() });
  const license = deps.readLicense();
  return buildEveCloudRoute({
    isEveSelection: true,
    tier,
    functionUrl: deps.functionUrl ?? EVE_INFERENCE_FUNCTION_URL,
    license,
  });
}
