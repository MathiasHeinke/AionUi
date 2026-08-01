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
 *   - `readInferenceLaneStateFromBackendBestEffort` is best-effort for descriptive
 *     seed generation where an absent/unreadable value may be rendered as unknown.
 *   - `readInferenceSelectionFromBackendStrict` is mandatory for routing and
 *     warm-up. A backend error must never look like an absent setting because
 *     absence legitimately defaults to EVE Standard while unreadable state must
 *     fail loud instead of silently changing the user's selected lane.
 *
 * BOTH carry `maxEntitled`, and neither may drop it. SEND and PAINT read the same
 * lane state and now AGREE about unknown: neither claims MAX. The descriptive
 * surfaces refuse to SAY "MAX" without a positively-known entitlement
 * (`mayPaintEveMax`), and the router refuses to SEND it — the lane is HELD until
 * the entitlement resolves (`resolveEveWireLaneDecision`). The old split (paint
 * Standard, send MAX) is what let hidden MAX spend leave an unverified seat.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import { seatScopedKey } from '@/common/config/seatConfigKeyCore';
import {
  EVE_DEFAULT_INFERENCE_SELECTION,
  EVE_INFERENCE_FUNCTION_URL,
  EVE_MAX_ENTITLED_SETTINGS_KEY,
  isEveInferenceSelection,
  repairInferenceSelection,
  resolveEveWireLaneDecision,
  resolveWireTierFromSelection,
} from '@/common/config/eveInferenceCore';
import { buildEveCloudRoute, type CommandEveEveCloudRoute } from './ollamaOpenAiShim';
import { getActiveSeatId } from './seatContextCore';
import { CommandEveMaxEntitlementHoldError, CommandEveShimPublicError } from './shimPublicError';

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
 * making the decision real costs no extra request on the per-turn hot path. It is
 * three-state on purpose: `undefined` means the renderer has never written it
 * (fresh install, or a boot before the first renderer mount). An unknown
 * entitlement must NOT be read as "unentitled" — guessing that would silently
 * downgrade a paying seat — and it must NOT be read as "entitled" either, which
 * would spend on an unverified seat. Unknown therefore HOLDS the lane; see
 * `resolveEveWireLaneDecision`.
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
 * Best-effort read for non-routing metadata (the DESCRIPTIVE / paint surfaces). An
 * unreadable backend is represented as unknown; callers must not use this contract
 * to choose an inference lane.
 *
 * IT RETURNS THE WHOLE LANE STATE, AND THAT IS THE 1.820.1 FIX. This used to be
 * `readInferenceSelectionFromBackend(): Promise<string | undefined>` — it fetched
 * `maxEntitled` in the same GET and then dropped it on the floor. The one caller
 * (the assistant-bootstrap seed) therefore painted "EVE Cloud, MAX aktiv" from a
 * persisted selection alone, with the funding authority UNKNOWN — while the
 * renderer's picker, reading the same unknown, correctly LOCKED MAX. Same
 * codebase, opposite answers.
 *
 * The selection-only accessor is deliberately GONE rather than deprecated: a
 * reader that hands back intent without the authority to describe it is the seam
 * the defect lived in, and a seam left standing gets used again.
 *
 * An unreadable backend yields `{}` — selection unknown AND entitlement unknown.
 * Unknown entitlement paints Standard (see `mayPaintEveMax`), so a failed read
 * under-claims instead of over-claiming.
 */
export async function readInferenceLaneStateFromBackendBestEffort(): Promise<CommandEveInferenceLaneState> {
  try {
    return await fetchInferenceLaneStateFromBackend();
  } catch {
    return {};
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
 *     → isEveInferenceSelection? → resolveEveWireLaneDecision(send / hold)
 *     → buildEveCloudRoute
 *
 * A LOCAL selection returns `{ active: false }`. An EVE selection returns an
 * active route carrying the wire tier + license. A rejected `readLaneState`
 * deliberately propagates: unreadable state is not equivalent to an absent
 * setting and must never become an implicit Standard or local route.
 *
 * THE ENTITLEMENT DECISION IS WIRED HERE, NOT INJECTED. `maxEntitled` comes from
 * the SAME settings fetch the selection already needed, so the production path
 * exercises it on every turn. All three states are answered as three states:
 *
 *   TRUE    → `max` travels.
 *   FALSE   → a persisted MAX resolves to `standard` for THIS request only. The
 *             stored intent is never rewritten here, so it lights up again the
 *             moment the seat buys.
 *   UNKNOWN → THE LANE IS HELD. No route is built and no request is made, so no
 *             MAX spend can leave an unverified seat. This is the 1.820.1
 *             correction: unknown used to let `max` travel on the reasoning that
 *             the server is the binding gate — but "upstream will refuse it" is
 *             not a spend control the client may lean on, and the surface was
 *             simultaneously painting Standard for the same unknown. Paint
 *             Standard, send MAX was the defect; holding closes both halves.
 *
 * Substituting `standard` for the unknown case would be equally wrong in the
 * other direction — that is the silent downgrade of a possibly-paying seat. So
 * neither substitution is made: the turn waits for the entitlement to resolve.
 *
 * REPAIR: an EVE-prefixed value that resolves to NO tier previously reached the
 * shim as "no tier" and was answered 500 on every turn. It is repaired here, at
 * the wire, so the seat can always send regardless of whether the renderer hook
 * has ever mounted to rewrite the stored string.
 */
export async function resolveEveCloudRouteFromBackend(deps: {
  /** Read the CEVE license wire (or undefined when absent). */
  readLicense: () => string | undefined;
  /** Edge Function URL (overridable in tests). */
  functionUrl?: string;
}): Promise<CommandEveEveCloudRoute | undefined> {
  // THE LANE-STATE READER IS NOT A PARAMETER, AND THAT IS THE POINT.
  //
  // It used to be injected. index.ts — the ONLY production call site — passed the
  // real reader, and every test passed its own. So the tests could not tell
  // whether production was wired at all: breaking index.ts left the suite green,
  // which is exactly how the clamp shipped as dead code and how the same defect
  // recurred five times on this ticket.
  //
  // Making it a hard dependency of THIS module removes the seam. There is no
  // longer a wiring in index.ts that can be wrong, and a test exercising this
  // function necessarily exercises the real reader — the only thing it can mock
  // is the backend transport underneath it, which is a genuine external
  // dependency rather than a stand-in for our own code.
  const laneState = await readInferenceLaneStateFromBackendStrict();
  const { selection } = repairInferenceSelection(laneState.selection);
  if (!isEveInferenceSelection(selection)) {
    return { active: false };
  }
  const decision = resolveEveWireLaneDecision(selection, { maxEntitled: laneState.maxEntitled });
  // THE HOLD, AT THE WIRE. Deliberately a throw and not a substituted tier: this
  // function's only product is a route, and every route it could return here
  // would be a claim it has no authority to make. `standard` would silently
  // downgrade a possibly-paying seat, `max` would spend on an unverified one, and
  // `{ active: false }` would quietly re-lane a cloud turn onto the local model.
  // Refusing is the only answer that asserts nothing.
  if (decision.status === 'hold') {
    throw new CommandEveMaxEntitlementHoldError();
  }
  // Belt and braces: repairInferenceSelection already guarantees a resolvable
  // EVE selection, so this fallback should be unreachable. It is here because
  // "should be unreachable" is exactly what the 500-every-turn bug believed
  // about itself — an unresolvable cloud selection must degrade to a sendable
  // tier, never to `undefined`.
  const tier =
    decision.status === 'send' ? decision.tier : resolveWireTierFromSelection(EVE_DEFAULT_INFERENCE_SELECTION_FALLBACK);
  const license = deps.readLicense();
  return buildEveCloudRoute({
    isEveSelection: true,
    tier,
    functionUrl: deps.functionUrl ?? EVE_INFERENCE_FUNCTION_URL,
    license,
  });
}
