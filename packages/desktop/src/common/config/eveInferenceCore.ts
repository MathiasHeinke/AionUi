/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE inference picker — pure core (STUFEN / level model).
 *
 * The founder mandate is "nothing confusing": a user picks a STUFE (level), NOT
 * a raw model id. So the picker is EXACTLY TWO groups and NOTHING else (no raw
 * CLI/agent picker, no raw provider/model list, no raw "DeepSeek"/"GLM" id in
 * the primary row):
 *
 *   - Privat (lokal):   Standard = Gemma 4 E4B, Hoch = Gemma 4 12B
 *                       (the bundled local tiers from commandEveShell.ts).
 *   - EVE Inference:    Standard, Hoch, Max (cloud, OpenAI-compatible Edge fn).
 *                       The user sees a level; the backend resolves the concrete
 *                       model from that level via a registry. Both lanes share
 *                       the entry word "Standard" (founder choice 2026-06-27).
 *
 * THE THREE EVE LEVELS (STUFEN):
 *   - Standard  — FREE. DeepSeek V4 Flash. The default for a fresh chat.
 *   - Hoch      — PAID. DeepSeek V4 Pro. Consumes credits ("mehr Credits").
 *   - Max / "härteste Aufgabe" — PAID + GATED. GLM 5.2. The highest cost level:
 *     it carries a VISIBLE higher-cost badge ("höchste Kosten") so the rate vs
 *     Hoch is obvious before the user picks it.
 *
 * FREE-TIER RULES (entitlement trialing/free per entitlementCore):
 *   - EVE Hoch + EVE Max are GREYED OUT (disabled, "im Paid-Tarif" hint).
 *   - BYOK is GREYED OUT in settings (handled at the settings surface using
 *     {@link isByokDisabledForEntitlement} from this module).
 *   - Only EVE Standard + the two local tiers are selectable.
 *
 * BACKEND LEVEL REGISTRY (no tier→level shift): the eve-inference Edge Function
 * resolves the concrete upstream model from a user-facing LEVEL via a registry
 * (levels: standard [free], high [free], max [DeepSeek V4 Pro, paid], maximum
 * [GLM 5.2, paid, gated]). After the backend wire-contract fix the wire `tier`
 * this module sends IS the registry level verbatim — there is NO tier→level
 * bridge/shift any more: Standard→`standard`, Hoch→`high`, Max→`max`,
 * Maximum→`maximum`. The function looks the value up in the registry directly.
 *
 * EVE ROUTING (all levels): every EVE Inference level routes through the
 * Command EVE backend Edge Function as an OpenAI-compatible client. We model an
 * EVE level as a synthetic {@link TProviderWithModel} pointed at the function
 * URL with the stored CEVE license WIRE STRING as the bearer credential
 * (`api_key`), then hand it to the existing `ClientFactory` so the existing
 * OpenAIRotatingClient + egress-boundary enforcement apply UNCHANGED. The
 * client never holds an OpenRouter/provider key — only the license.
 *
 * This module is PURE (no Electron, no fs, no network) so the gating + routing
 * shape is unit-testable in a plain Node (vitest) environment.
 */

import type { TProviderWithModel } from './storage';
import { COMMAND_EVE_LOCAL_MODEL_TIERS, type CommandEveLocalModelTier } from './commandEveShell';

// ---------------------------------------------------------------------------
// EVE Inference (cloud) — backend Edge Function
// ---------------------------------------------------------------------------

/**
 * The Command EVE inference Edge Function. OpenAI-compatible: POST a body of
 * `{ messages, stream, tier }` with `Authorization: Bearer <CEVE license wire>`.
 * The function (server side) resolves the actual upstream free/paid model — the
 * desktop never sees a provider key.
 */
export const EVE_INFERENCE_FUNCTION_URL =
  'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-inference';

/** Synthetic provider id for the EVE Inference cloud lane (one per tier). */
export const EVE_INFERENCE_PROVIDER_ID_PREFIX = 'command-eve-inference';
/** Stable provider name surfaced in receipts / egress provider tagging. */
export const EVE_INFERENCE_PROVIDER_NAME = 'EVE Inference';

/**
 * HONEST CLOUD LABELING (founder-mandated). EVE Inference is an EXTERNAL cloud
 * lane (OpenRouter free/paid models via the backend Edge Function) — it is NOT
 * private/local. The picker group heading and the in-conversation chip therefore
 * carry an explicit "(Cloud)" marker so a user can never mistake an EVE tier for
 * the private/local Gemma lane. The local group keeps its "(lokal)" marker.
 */
export const EVE_INFERENCE_GROUP_TITLE = `${EVE_INFERENCE_PROVIDER_NAME} (Cloud)`;
/**
 * Sublabel for EVE tiers (mirrors the local tiers' model-label sublabel). Makes
 * the cloud/external nature explicit on every EVE row, not just the heading.
 */
export const EVE_INFERENCE_TIER_SUBLABEL = 'EVE Cloud';

/**
 * EVE Inference cloud LEVELS (Stufen). `tier` is the wire value POSTed in the
 * body; it IS the backend registry level verbatim (no tier→level bridge/shift)
 * and the function maps it straight to a concrete model. `model` is the OpenAI
 * `model` field the client sends —
 * the function accepts a sentinel and routes by this value, so we send it as
 * the model too for a stable, self-describing request.
 *
 * Per-level UI economics (so the picker never surprises a user about cost):
 *   - `paidOnly`        — greyed out while trialing (free tiers stay open).
 *   - `consumesCredits` — show a "verbraucht Credits" marker on the row.
 *   - `gated`           — highest cost, server-gated; show the high-cost badge.
 *   - `costBadge`       — short, non-secret UI badge text (e.g. "~5× Kosten").
 *
 * The two FREE levels (Standard + Hoch) carry NO cost badge; the user can pick
 * them on a trial with no card.
 */
export const EVE_INFERENCE_TIERS = [
  {
    id: 'eve-standard',
    // STUFE: Standard — the entry rung. Same model as the FREE lane (DeepSeek V4
    // Flash): on a trial it is EVE Free (100/Tag, €0); for a paying user it is
    // EVE Pro's cheapest, metered rung. The wire `tier` is `standard` either way;
    // the SERVER decides free-cap vs credit-meter by the entitlement.
    label: 'Standard',
    tier: 'standard',
    /** Free-tier-eligible: selectable on a trial (capped, not metered). The Pro
     *  lane renders this same model as the cheapest METERED rung — that cost
     *  marker is injected by the lane builder, not carried on the free-clean tier. */
    paidOnly: false,
    consumesCredits: false,
    gated: false,
    /** User-facing CAPABILITY descriptor (sublabel only; NEVER a model name — founder mandate). */
    modelLabel: 'großer Kontext',
  },
  {
    id: 'eve-high',
    // STUFE: Hoch — DeepSeek V4 Pro, paid, more credits than Standard.
    label: 'Hoch',
    // The wire `high` IS the registry level (no tier→level bridge/shift); the
    // backend looks `high` up directly. The German label "Hoch" is UI-only.
    tier: 'high',
    paidOnly: true,
    consumesCredits: true,
    gated: false,
    modelLabel: 'intelligenter',
    costBadge: 'mehr Credits',
  },
  {
    id: 'eve-max',
    // STUFE: Max / "härteste Aufgabe" — GLM 5.2, paid, highest cost.
    label: 'Max',
    tier: 'max',
    paidOnly: true,
    consumesCredits: true,
    gated: true,
    modelLabel: 'höchste Intelligenz',
    /** Highest-cost badge so the rate vs Hoch is obvious before picking. */
    costBadge: 'höchste Kosten',
  },
] as const;

export type EveInferenceTier = (typeof EVE_INFERENCE_TIERS)[number];
export type EveInferenceTierId = EveInferenceTier['id'];
export type EveInferenceWireTier = EveInferenceTier['tier'];

/**
 * User-facing cloud-row labels (founder mandate 1.2.13): the EVE Inference rows
 * read "EVE Standard / EVE High / EVE Max" in the picker. The raw `tier.label`
 * ("Standard" / "Hoch" / "Max") stays the wire-aligned internal label; this map
 * is presentation-only and does NOT change any selection value or wire `tier`.
 */
export const EVE_INFERENCE_TIER_DISPLAY_LABELS: Record<EveInferenceWireTier, string> = {
  standard: 'EVE Standard',
  high: 'EVE High',
  max: 'EVE Max',
};

export const EVE_INFERENCE_DEFAULT_TIER_ID: EveInferenceTierId = EVE_INFERENCE_TIERS[0].id;

// ---------------------------------------------------------------------------
// Local (privat) tiers — exactly the two the founder spec lists. We REUSE the
// bundled commandEveShell tiers and intentionally surface only Standard (E4B,
// `default`) + High (12B, `opt_in`). The 31B `pro` tier is NOT part of the
// 2-group picker spec, so it is excluded here on purpose.
// ---------------------------------------------------------------------------

export interface EveLocalPickerTier {
  /** Stable picker id. */
  id: string;
  /** Display label, e.g. "Standard". */
  label: string;
  /** Underlying bundled model label, e.g. "Gemma 4 E4B". */
  modelLabel: string;
  /** commandEveShell local tier id (drives ensure/warm + acp model id). */
  localTierId: CommandEveLocalModelTier['id'];
}

/**
 * The two local picker entries. Bound by `state` to the bundled tiers so a
 * rename in commandEveShell.ts stays in sync (default ⇒ Standard, opt_in ⇒
 * Hoch). Fails loudly (throws at module load) if those states ever go missing.
 */
function resolveLocalTier(state: CommandEveLocalModelTier['state']): CommandEveLocalModelTier {
  const tier = COMMAND_EVE_LOCAL_MODEL_TIERS.find((t) => t.state === state);
  if (!tier) {
    throw new Error(`eveInferenceCore: no bundled local tier with state="${state}"`);
  }
  return tier;
}

export const EVE_LOCAL_PICKER_TIERS: EveLocalPickerTier[] = [
  {
    id: 'local-standard',
    label: 'Standard',
    modelLabel: resolveLocalTier('default').label,
    localTierId: resolveLocalTier('default').id,
  },
  {
    id: 'local-high',
    // STUFE label aligned with the cloud lane: "Hoch" (not "High").
    label: 'Hoch',
    modelLabel: resolveLocalTier('opt_in').label,
    localTierId: resolveLocalTier('opt_in').id,
  },
];

// ---------------------------------------------------------------------------
// The two-group picker model (the ONLY thing the UI renders).
// ---------------------------------------------------------------------------

export type EvePickerGroupKind = 'local' | 'eve';

export interface EvePickerItem {
  /** Unique selection value across both groups. */
  value: string;
  /** Group this item belongs to. */
  group: EvePickerGroupKind;
  /** Primary label (STUFE), e.g. "Standard" / "Hoch" / "Max" / "Maximum". */
  label: string;
  /** Secondary descriptor, e.g. "Gemma 4 E4B" (local) or "DeepSeek V4 Pro". */
  sublabel?: string;
  /** True when this item is disabled for the current entitlement (greyed). */
  disabled: boolean;
  /** Non-secret reason the item is disabled (UI hint). */
  disabledReasonCode?: 'PAID_TIER_REQUIRED';
  /** True iff this is a paid level that consumes credits (show a credit marker). */
  consumesCredits?: boolean;
  /** True iff this is the highest-cost, server-gated level (show high-cost badge). */
  gated?: boolean;
  /** Short, non-secret cost badge text, e.g. "verbraucht Credits" / "~5× Kosten". */
  costBadge?: string;
}

export interface EvePickerGroup {
  kind: EvePickerGroupKind;
  /** Group heading, e.g. "Privat (lokal)" / "EVE Inference". */
  title: string;
  items: EvePickerItem[];
}

/** Stable selection value for an EVE tier (so the UI + router agree). */
export function eveTierValue(tierId: EveInferenceTierId): string {
  return `${EVE_INFERENCE_PROVIDER_ID_PREFIX}:${tierId}`;
}

/**
 * The DEFAULT picker selection for a fresh chat. Founder mandate (software-first
 * GTM): the out-of-the-box experience is Hermes + EVE Standard (OpenRouter free
 * models, cloud) — local Gemma is opt-in. So an absent/empty persisted
 * selection resolves to EVE Standard, not the local default tier.
 */
export const EVE_DEFAULT_INFERENCE_SELECTION: string = eveTierValue(EVE_INFERENCE_DEFAULT_TIER_ID);

/**
 * Normalize a persisted selection to an effective one: an empty/absent value
 * falls back to EVE Standard (the new default). A present value is returned
 * verbatim (the picker still re-resolves a now-disabled paid tier to Standard
 * at render time). Pure, so both the picker and the send path share one rule.
 */
export function resolveEffectiveInferenceSelection(persisted: string | null | undefined): string {
  return typeof persisted === 'string' && persisted.trim().length > 0
    ? persisted
    : EVE_DEFAULT_INFERENCE_SELECTION;
}

/** Stable selection value for a local picker tier. */
export function localTierValue(id: string): string {
  return `command-eve-local:${id}`;
}

const EVE_SELECTION_PREFIX = `${EVE_INFERENCE_PROVIDER_ID_PREFIX}:`;
const LOCAL_SELECTION_PREFIX = 'command-eve-local:';

/** True iff a picker selection value belongs to the EVE Inference (cloud) group. */
export function isEveInferenceSelection(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(EVE_SELECTION_PREFIX);
}

/** True iff a picker selection value belongs to the Privat (lokal) group. */
export function isLocalSelection(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(LOCAL_SELECTION_PREFIX);
}

/**
 * Parse an EVE tier id out of a selection value (e.g.
 * "command-eve-inference:eve-standard" → "eve-standard"). Returns undefined
 * when the value is not a known EVE selection.
 */
export function parseEveTierIdFromSelection(value: string | null | undefined): EveInferenceTierId | undefined {
  if (!isEveInferenceSelection(value)) return undefined;
  const tierId = (value as string).slice(EVE_SELECTION_PREFIX.length);
  return findEveInferenceTier(tierId)?.id;
}

/**
 * Parse a local picker tier out of a selection value (e.g.
 * "command-eve-local:local-standard" → its EveLocalPickerTier). Returns
 * undefined when the value is not a known local selection.
 */
export function parseLocalTierFromSelection(value: string | null | undefined): EveLocalPickerTier | undefined {
  if (!isLocalSelection(value)) return undefined;
  const id = (value as string).slice(LOCAL_SELECTION_PREFIX.length);
  return EVE_LOCAL_PICKER_TIERS.find((tier) => tier.id === id);
}

// ---------------------------------------------------------------------------
// Startup warm-up lane selection. The shim warms whichever lane the user will
// actually hit first; we never warm the inactive lane.
// ---------------------------------------------------------------------------

/**
 * Which lane the startup warm-up should target, derived from the SAME effective
 * picker selection the send path resolves. EVE-tier selection ⇒ warm the cloud
 * route (TLS/edge + license/reachability preflight); local selection ⇒ warm the
 * bundled Ollama model. Pure + sync so it can be unit-tested and shares the
 * exact discriminant the routing resolver uses (no second source of truth).
 *
 * For an EVE selection the resolved wire `tier` is included so the preflight
 * POSTs the right tier; `undefined` tier falls back to the function default.
 */
export type CommandEveWarmupLane = { lane: 'eve'; tier?: EveInferenceWireTier } | { lane: 'local' };

export function resolveCommandEveWarmupLane(persisted: string | null | undefined): CommandEveWarmupLane {
  const selection = resolveEffectiveInferenceSelection(persisted);
  if (!isEveInferenceSelection(selection)) {
    return { lane: 'local' };
  }
  const tierId = parseEveTierIdFromSelection(selection);
  const tier = tierId ? findEveInferenceTier(tierId)?.tier : undefined;
  return { lane: 'eve', tier };
}

// ---------------------------------------------------------------------------
// Entitlement → gating. The ONLY input the gating needs is the trial flag, so
// callers pass a minimal shape (mirrors entitlementCore's status surface).
// ---------------------------------------------------------------------------

/**
 * Minimal entitlement view the picker needs. `trial_ends_at` present + non-null
 * ⇒ this is a TRIAL/free entitlement (entitlementCore CEVE.v2 contract); a paid
 * (non-trial) license keeps it null/absent.
 *
 * `has_paid_seat` (1.2.18) is the explicit, main-process-derived paid-tier hint
 * (see entitlementCore: `entitled && trial_ends_at == null`). It is the single
 * authoritative discriminant for paid-only UI affordances (BYOK / add-own-model);
 * absent/false ⇒ free tier. Carried here so the pure gate helpers can consume it.
 */
export interface EveEntitlementView {
  trial_ends_at?: string | null;
  has_paid_seat?: boolean;
}

/**
 * True iff the entitlement is a free/trial tier. Conservative & explicit: only
 * a NON-NULL `trial_ends_at` counts as trialing. Absent/null ⇒ treat as paid
 * (the gate already proved the user is `entitled`; a paid license simply omits
 * trial_ends_at).
 */
export function isTrialingEntitlement(entitlement: EveEntitlementView | null | undefined): boolean {
  const t = entitlement?.trial_ends_at;
  return typeof t === 'string' && t.trim().length > 0;
}

/** True iff BYOK (bring-your-own-key) must be greyed out for this entitlement. */
export function isByokDisabledForEntitlement(entitlement: EveEntitlementView | null | undefined): boolean {
  return isTrialingEntitlement(entitlement);
}

/**
 * True iff the user MAY add their own model / API key (BYOK) — the paid-seat gate
 * (1.2.18, founder Req 4). Authoritative discriminant is the main-process-derived
 * `has_paid_seat` (entitled && non-trial). A trialing OR free OR unknown
 * entitlement returns false. This is the inverse the Settings→Modell "Add
 * Platform" / api_key affordances gate on (it SUPERSEDES the trial-only
 * `isByokDisabledForEntitlement`, which locked trial but left a hypothetical
 * free-perpetual tier unlocked). Defense-in-depth: even if a caller passes a
 * stale view, a present-and-true `has_paid_seat` is required AND it must not be
 * trialing — both conditions, so a malformed view can never wrongly unlock.
 */
export function isModelByokAllowed(entitlement: EveEntitlementView | null | undefined): boolean {
  return entitlement?.has_paid_seat === true && !isTrialingEntitlement(entitlement);
}

/**
 * Whether a given EVE tier is selectable for the entitlement. Standard is
 * always selectable; High/Max are paid-only and disabled while trialing.
 */
export function isEveTierSelectable(
  tier: Pick<EveInferenceTier, 'paidOnly'>,
  entitlement: EveEntitlementView | null | undefined
): boolean {
  if (!tier.paidOnly) return true;
  return !isTrialingEntitlement(entitlement);
}

/**
 * Build the full two-group picker model (STUFEN) for the current entitlement.
 * Local tiers are never gated; the PAID EVE levels (Max, Maximum) are greyed
 * (disabled, PAID_TIER_REQUIRED) while trialing. The FREE levels (Standard,
 * Hoch) always stay selectable. Paid levels carry their model label as the
 * sublabel plus a visible cost badge; the GATED Maximum level carries the
 * highest-cost badge so the ~5× rate is obvious. Free levels keep the
 * cloud/external sublabel.
 */
export function buildEvePickerGroups(entitlement: EveEntitlementView | null | undefined): EvePickerGroup[] {
  const trialing = isTrialingEntitlement(entitlement);

  const localGroup: EvePickerGroup = {
    kind: 'local',
    title: 'Privat (lokal)',
    items: EVE_LOCAL_PICKER_TIERS.map((tier) => ({
      value: localTierValue(tier.id),
      group: 'local',
      label: tier.label,
      sublabel: tier.modelLabel,
      disabled: false,
    })),
  };

  const eveGroup: EvePickerGroup = {
    kind: 'eve',
    // Honest cloud labeling: "(Cloud)" in the heading so EVE is never mistaken
    // for the private/local lane.
    title: EVE_INFERENCE_GROUP_TITLE,
    items: EVE_INFERENCE_TIERS.map((tier) => {
      const disabled = tier.paidOnly && trialing;
      const consumesCredits = tier.consumesCredits === true;
      const gated = tier.gated === true;
      // Paid levels surface their model label (DeepSeek V4 Pro / GLM 5.2);
      // free levels keep the cloud/external sublabel.
      const modelLabel = 'modelLabel' in tier ? (tier.modelLabel as string) : undefined;
      const sublabel = modelLabel ?? EVE_INFERENCE_TIER_SUBLABEL;
      return {
        value: eveTierValue(tier.id),
        group: 'eve' as const,
        // Cloud rows read "EVE Standard / EVE High / EVE Max" (the group header
        // "EVE Inference (Cloud)" already conveys the lane). Founder mandate:
        // tone down the cost/upsell — the per-row cost badges ("mehr Credits",
        // "höchste Kosten") are intentionally NOT surfaced here. `consumesCredits`
        // / `gated` flags are still carried for any non-picker logic.
        label: EVE_INFERENCE_TIER_DISPLAY_LABELS[tier.tier],
        sublabel,
        disabled,
        ...(disabled ? { disabledReasonCode: 'PAID_TIER_REQUIRED' as const } : {}),
        consumesCredits,
        gated,
      };
    }),
  };

  return [localGroup, eveGroup];
}

// ---------------------------------------------------------------------------
// Lane axis (presentation-only) — the founder's "pick a lane, then a strength"
// model: Lokal · EVE Free · EVE Pro. This is a VIEW over the existing tiers; it
// changes NO wire `tier`, NO selection value, and NOT the router contract
// (tier === backend registry level). It only regroups + gates for display.
// ---------------------------------------------------------------------------

export type PickerLane = 'local' | 'free' | 'pro';

export interface PickerLaneView {
  lane: PickerLane;
  /** Lane heading, e.g. "Lokal" | "EVE Free" | "EVE Pro". */
  title: string;
  /** UI accent for the lane chip/pill. */
  accent: 'grey' | 'blue' | 'gold';
  /**
   * available — selectable now.
   * locked    — shown (strengths render greyed) but not selectable; carries an
   *             upgrade affordance (the visible-but-not-pushy upsell).
   * hidden    — not offered at all (the EVE Free lane for a paying user).
   */
  state: 'available' | 'locked' | 'hidden';
  /** The strengths in this lane (reuses the EvePickerItem shape). */
  items: EvePickerItem[];
}

/** The local strengths as picker items (never gated). */
function buildLocalLaneItems(): EvePickerItem[] {
  return EVE_LOCAL_PICKER_TIERS.map((tier) => ({
    value: localTierValue(tier.id),
    group: 'local' as const,
    label: tier.label,
    sublabel: tier.modelLabel,
    disabled: false,
  }));
}

/**
 * One EVE-cloud tier as a Pro-lane item (model label + relative-cost badge). EVERY
 * Pro rung is metered; the free-eligible rung (Standard) carries no tier badge — it
 * is the cheapest METERED rung here, so we surface a "günstigste" marker. The paid
 * rungs use their own ascending badge ("mehr Credits" / "höchste Kosten").
 */
function eveTierToProItem(tier: EveInferenceTier, forceDisabled: boolean): EvePickerItem {
  const modelLabel = 'modelLabel' in tier ? (tier.modelLabel as string) : undefined;
  const costBadge = tier.paidOnly ? ('costBadge' in tier ? (tier.costBadge as string) : undefined) : 'günstigste';
  return {
    value: eveTierValue(tier.id),
    group: 'eve' as const,
    label: tier.label,
    sublabel: modelLabel ?? EVE_INFERENCE_TIER_SUBLABEL,
    disabled: forceDisabled,
    ...(forceDisabled ? { disabledReasonCode: 'PAID_TIER_REQUIRED' as const } : {}),
    consumesCredits: true,
    gated: tier.gated === true,
    ...(costBadge ? { costBadge } : {}),
  };
}

/**
 * The EVE Free lane = the single free-eligible model (DeepSeek V4 Flash), rendered
 * as FREE (capped 100/Tag, no credit/cost badge). It is the SAME model as EVE Pro's
 * cheapest rung ("Standard") — only the billing differs (free-cap vs credit-meter),
 * which the server decides by entitlement.
 */
function buildFreeLaneItems(): EvePickerItem[] {
  return EVE_INFERENCE_TIERS.filter((tier) => !tier.paidOnly).map((tier) => {
    const modelLabel = 'modelLabel' in tier ? (tier.modelLabel as string) : undefined;
    return {
      value: eveTierValue(tier.id),
      group: 'eve' as const,
      label: tier.label,
      sublabel: modelLabel ? `${modelLabel} · 100/Tag` : EVE_INFERENCE_TIER_SUBLABEL,
      disabled: false,
    };
  });
}

/**
 * Build the three-lane picker view (Lokal · EVE Free · EVE Pro) for the current
 * entitlement. Founder rules (2026-06-27): Lokal is offered to EVERYONE (the
 * privacy lane, downloadable models); a TRIAL/free user gets Lokal + EVE Free
 * selectable and EVE Pro LOCKED (all three rungs shown greyed, with an upgrade
 * affordance); a PAYING user no longer sees EVE Free (hidden) and EVE Pro becomes
 * selectable. EVE Pro = Standard (DeepSeek V4 Flash, cheapest) · Hoch (DeepSeek V4
 * Pro) · Max (GLM 5.2), increasing credit cost — pick the intelligence, the server
 * meters it. Pure presentation over the existing tiers — no wire/tier change.
 */
export function buildEveLaneViews(entitlement: EveEntitlementView | null | undefined): PickerLaneView[] {
  const trialing = isTrialingEntitlement(entitlement);
  return [
    {
      lane: 'local',
      title: 'Lokal',
      accent: 'grey',
      state: 'available',
      items: buildLocalLaneItems(),
    },
    {
      lane: 'free',
      title: 'EVE Free',
      accent: 'blue',
      // Paying (non-trial) users no longer see the Free lane.
      state: trialing ? 'available' : 'hidden',
      items: buildFreeLaneItems(),
    },
    {
      lane: 'pro',
      title: 'EVE Pro',
      accent: 'gold',
      // Trial/free: all three rungs SHOWN but greyed + upgrade. Paid: selectable.
      // EVE Pro includes the Standard rung (same model as Free) so the full
      // intelligence ladder lives in one lane.
      state: trialing ? 'locked' : 'available',
      items: EVE_INFERENCE_TIERS.map((tier) => eveTierToProItem(tier, trialing)),
    },
  ];
}

/** The lane a selection value belongs to (for the active-pill accent + open-to-lane). */
export function laneOfSelection(value: string | null | undefined): PickerLane {
  if (isLocalSelection(value)) return 'local';
  const tierId = parseEveTierIdFromSelection(value);
  const tier = tierId ? findEveInferenceTier(tierId) : undefined;
  return tier?.paidOnly ? 'pro' : 'free';
}

/**
 * Honest, MODEL-FREE self-description of the active inference lane for EVE's own
 * system context (founder mandate: EVE must NEVER name a concrete model — it used
 * to claim "Gemma 4" because the bootstrap receipt's local model ref leaked into
 * the prompt). Maps a (effective) picker selection to a capability descriptor —
 * lane + Stufe + a context hint — with NO vendor/model/version name. ASCII-
 * transliterated to match the surrounding assistant-prompt strings. Pass the
 * EFFECTIVE selection (resolveEffectiveInferenceSelection) so an absent value
 * resolves to the EVE Cloud default rather than "not verified".
 */
export function commandEveActiveModeLabel(
  selection: string | null | undefined,
  locale: 'de-DE' | 'en-US'
): string {
  const de = locale === 'de-DE';
  if (isLocalSelection(selection)) {
    // Offline/local models ARE named (founder 2026-06-28) — they run openly on the
    // user's own device, so EVE states the concrete local model. Only the CLOUD
    // lane stays model-abstract.
    const localModel = parseLocalTierFromSelection(selection)?.modelLabel;
    if (de) {
      return localModel
        ? `lokal & privat, Modell ${localModel} (laeuft vollstaendig auf dem Geraet des Nutzers, nichts verlaesst den Rechner)`
        : 'lokal & privat (laeuft vollstaendig auf dem Geraet des Nutzers, nichts verlaesst den Rechner)';
    }
    return localModel
      ? `local & private, model ${localModel} (runs fully on the user device, nothing leaves the machine)`
      : 'local & private (runs fully on the user device, nothing leaves the machine)';
  }
  if (isEveInferenceSelection(selection)) {
    const tierId = parseEveTierIdFromSelection(selection);
    const stufe = tierId ? findEveInferenceTier(tierId)?.label : undefined;
    if (de) {
      return stufe ? `EVE-Cloud, Stufe ${stufe} (grosser Kontext)` : 'EVE-Cloud (grosser Kontext)';
    }
    return stufe ? `EVE Cloud, level ${stufe} (large context)` : 'EVE Cloud (large context)';
  }
  return de ? 'nicht verifiziert' : 'not verified';
}

// ---------------------------------------------------------------------------
// EVE tier → synthetic provider for ClientFactory. The license wire string is
// the BEARER credential (OpenAI SDK sends `api_key` as `Authorization: Bearer`).
// ---------------------------------------------------------------------------

export function findEveInferenceTier(tierId: string): EveInferenceTier | undefined {
  return EVE_INFERENCE_TIERS.find((t) => t.id === tierId);
}

/**
 * Build the OpenAI-compatible request body for an EVE Inference call. The
 * function routes by `tier`; `messages`/`stream` are OpenAI-standard.
 *
 * `agent_id` is OPTIONAL and ADDITIVE: when the call is on behalf of a
 * delegated "Dein Team" role, the desktop passes that role's stable id so the
 * backend ledger `agent_id` column attributes the spend to the character.
 * When omitted the field is left off entirely (the backend defaults it to the
 * system `eve`), so an un-delegated call's body keeps its exact prior shape.
 */
export function buildEveInferenceRequestBody(args: {
  tier: EveInferenceWireTier;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  agent_id?: string;
}): {
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  tier: EveInferenceWireTier;
  agent_id?: string;
} {
  const agentId = typeof args.agent_id === 'string' ? args.agent_id.trim() : '';
  return {
    messages: args.messages,
    stream: args.stream === true,
    tier: args.tier,
    ...(agentId.length > 0 ? { agent_id: agentId } : {}),
  };
}

export interface BuildEveInferenceProviderArgs {
  /** EVE tier id to route (e.g. 'eve-standard'). */
  tierId: EveInferenceTierId;
  /**
   * The stored CEVE license WIRE STRING (e.g. "CEVE.v2.<payload>.<sig>"). Used
   * verbatim as the bearer credential. NOT an OpenRouter/provider key.
   */
  licenseWire: string;
}

/**
 * Build a synthetic {@link TProviderWithModel} for an EVE Inference tier,
 * pointed at the Edge Function with the license wire string as the bearer
 * `api_key`. Hand the result to `ClientFactory.createRotatingClient` — that
 * preserves the existing OpenAIRotatingClient + egress-boundary enforcement
 * (ClientFactory sets `commandEveEgressPolicyAction: 'block'` when the Command
 * EVE shell is enabled). This keeps the egress boundary on this path.
 *
 * THROWS when the license wire string is empty — a missing bearer must be a
 * hard error, never a silent unauthenticated request.
 */
export function buildEveInferenceProvider(args: BuildEveInferenceProviderArgs): TProviderWithModel {
  const tier = findEveInferenceTier(args.tierId);
  if (!tier) {
    throw new Error(`buildEveInferenceProvider: unknown EVE tier "${args.tierId}"`);
  }
  const wire = typeof args.licenseWire === 'string' ? args.licenseWire.trim() : '';
  if (wire.length === 0) {
    throw new Error('buildEveInferenceProvider: missing CEVE license wire string for bearer credential');
  }

  return {
    id: `${EVE_INFERENCE_PROVIDER_ID_PREFIX}-${tier.id}`,
    // 'openai' ⇒ ClientFactory routes through OpenAIRotatingClient (the
    // OpenAI-compatible path with the egress boundary).
    platform: 'openai',
    name: `${EVE_INFERENCE_PROVIDER_NAME} ${tier.label}`,
    base_url: EVE_INFERENCE_FUNCTION_URL,
    // The OpenAI SDK uses api_key as the Authorization: Bearer token.
    api_key: wire,
    // The function routes by the body `tier`; send the tier as model for a
    // stable, self-describing request.
    use_model: tier.tier,
    capabilities: [{ type: 'text' }, { type: 'function_calling' }],
  };
}
