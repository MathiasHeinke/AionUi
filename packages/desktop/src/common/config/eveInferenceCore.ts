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
 *   - EVE Inference:    Standard, Hoch, Sehr hoch, Maximum, Ultra
 *                       (cloud, OpenAI-compatible Edge fn).
 *                       The user sees a level; the backend resolves the concrete
 *                       model from that level via a registry. Both lanes share
 *                       the entry word "Standard" (founder choice 2026-06-27).
 *
 * THE FIVE EVE LEVELS (STUFEN):
 *   - Standard  — FREE. DeepSeek V4 Flash. The default for a fresh chat.
 *   - Hoch      — PAID. DeepSeek V4 Pro. Consumes credits ("mehr Credits").
 *   - Sehr hoch — PAID. GLM 5.2 with high reasoning.
 *   - Maximum   — PAID. Kimi K2.6 with maximum reasoning.
 *   - Ultra     — PAID. Experimental Kimi K3 with maximum reasoning and
 *                 proactive worker orchestration for genuinely complex work.
 *
 * FREE-TIER RULES (entitlement trialing/free per entitlementCore):
 *   - EVE Hoch + Sehr hoch + Maximum + Ultra are disabled unless a paid seat,
 *     active top-up, or spendable metered credit balance exists.
 *   - BYOK is GREYED OUT in settings (handled at the settings surface using
 *     {@link isByokDisabledForEntitlement} from this module).
 *   - Only EVE Standard + the two local tiers are selectable.
 *
 * BACKEND LEVEL REGISTRY (no tier→level shift): the eve-inference Edge Function
 * resolves the concrete upstream model from a user-facing LEVEL via a registry
 * (levels: standard, high, xhigh, max, ultra). The wire `tier`
 * this module sends IS the registry level verbatim — there is NO tier→level
 * bridge/shift any more: Standard→`standard`, Hoch→`high`, Sehr hoch→`xhigh`,
 * Maximum→`max`, Ultra→`ultra`. The function looks the value up in the registry
 * directly.
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
export const EVE_INFERENCE_FUNCTION_URL = 'https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-inference';

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
 *   - `gated`           — experimental/highest-cost marker; access still keys on
 *                         paid inference entitlement, never this cosmetic flag.
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
    id: 'eve-xhigh',
    // STUFE: Sehr hoch — GLM 5.2 at HIGH reasoning effort.
    label: 'Sehr hoch',
    tier: 'xhigh',
    paidOnly: true,
    consumesCredits: true,
    gated: false,
    modelLabel: 'tiefes Reasoning',
    costBadge: 'hohe Kosten',
  },
  {
    id: 'eve-max',
    // STUFE: Maximum / "härteste Aufgabe" — stable Kimi K2.6 at MAX reasoning.
    // This remains the strongest predictable, cost-bounded frontier lane.
    label: 'Maximum',
    tier: 'max',
    paidOnly: true,
    consumesCredits: true,
    gated: false,
    modelLabel: 'starkes Agenten-Reasoning',
    costBadge: 'sehr hohe Kosten',
  },
  {
    id: 'eve-ultra',
    // STUFE: Ultra — experimental Kimi K3 at MAX reasoning. The Main-process
    // request boundary adds the Ultra execution profile so Hermes proactively
    // uses the worker slots already available under the current hardware cap for
    // genuinely complex tasks. Existing privacy, side-effect and human gates
    // remain binding; Ultra is more execution power, never fewer safeguards.
    label: 'Ultra',
    tier: 'ultra',
    paidOnly: true,
    consumesCredits: true,
    gated: true,
    modelLabel: 'maximale Agenten-Power · experimentell',
    costBadge: 'Ultra-Kosten',
  },
] as const;

export type EveInferenceTier = (typeof EVE_INFERENCE_TIERS)[number];
export type EveInferenceTierId = EveInferenceTier['id'];
export type EveInferenceWireTier = EveInferenceTier['tier'];

/**
 * User-facing cloud-row labels: the 5-STUFEN ladder reads
 * "Standard / Hoch / Sehr hoch / Maximum / Ultra" in the picker (the group header "EVE
 * Inference (Cloud)" already conveys the lane, so the rows drop the "EVE" prefix).
 * Sehr hoch = GLM 5.2 @ high reasoning, Maximum = Kimi K2.6 @ max reasoning,
 * Ultra = experimental Kimi K3 @ max reasoning plus proactive orchestration.
 * This map is presentation-only and does NOT change any selection value or wire
 * `tier`.
 */
export const EVE_INFERENCE_TIER_DISPLAY_LABELS: Record<EveInferenceWireTier, string> = {
  standard: 'Standard',
  high: 'Hoch',
  xhigh: 'Sehr hoch',
  max: 'Maximum',
  ultra: 'Ultra',
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
  /** Secondary capability descriptor; concrete cloud model names stay server-owned. */
  sublabel?: string;
  /** True when this item is disabled for the current entitlement (greyed). */
  disabled: boolean;
  /** Non-secret reason the item is disabled (UI hint). */
  disabledReasonCode?: 'PAID_TIER_REQUIRED';
  /** True iff this is a paid level that consumes credits (show a credit marker). */
  consumesCredits?: boolean;
  /** True iff this is the experimental/highest-cost level (show high-cost treatment). */
  gated?: boolean;
  /** Short, non-secret cost badge text, e.g. "verbraucht Credits" / "Ultra-Kosten". */
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
  return typeof persisted === 'string' && persisted.trim().length > 0 ? persisted : EVE_DEFAULT_INFERENCE_SELECTION;
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
 * Resolve the WIRE TIER an EVE picker selection POSTs to the eve-inference Edge
 * Function (HONEST TIER ROUTING, 1.2.19). Maps a selection value straight to the
 * registry wire value VERBATIM via `parseEveTierIdFromSelection →
 * findEveInferenceTier → .tier`, so:
 *
 *   command-eve-inference:eve-standard → 'standard'
 *   command-eve-inference:eve-high     → 'high'
 *   command-eve-inference:eve-max      → 'max'
 *   command-eve-inference:eve-ultra    → 'ultra'
 *
 * Returns `undefined` for a LOCAL selection or any value that does not resolve
 * to a known EVE tier (so a caller can fail-loud rather than silently meter the
 * cheapest model). This is the ONE place the selection→wire-tier mapping lives,
 * shared by the main-process shim routing resolver AND the warm-up lane, so the
 * tier a paid user picked (Hoch/Max) can never silently degrade to Standard.
 *
 * ROOT CAUSE this closes (OpenRouter logs: 100% Flash, GLM+Pro never called):
 * the shim previously derived the tier inline and fell back to 'standard' on any
 * empty value. Centralizing + verbatim-mapping here makes "EVE Max → max" a
 * unit-tested contract instead of an inline expression nobody asserted.
 */
export function resolveWireTierFromSelection(selection: string | null | undefined): EveInferenceWireTier | undefined {
  const tierId = parseEveTierIdFromSelection(selection);
  if (!tierId) return undefined;
  return findEveInferenceTier(tierId)?.tier;
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
// HONEST SELF-DESCRIPTION of the ACTIVE inference lane (founder mandate, Task
// #50 closeout for the cloud lanes).
//
// THE BUG THIS FIXES: the Hermes/ACP agent is always *configured* against the
// local Ollama-compatible SHIM model id (`command-eve-gemma4-e4b-64k:latest`,
// see commandEveShell.ts). On an EVE *cloud* lane the shim transparently routes
// that request to the eve-inference Edge Function (GLM etc.) — but the raw shim
// model name still leaks into the "model header" and the local bootstrap
// receipt (`provider: 'ollama'`, `default_model: <shim id>`). So when EVE was
// asked "what model are you?" on EVE Cloud Max it read that local receipt line
// and (truthfully per what it was shown, but WRONGLY) said "local Gemma E4B via
// Ollama", contradicting its own (now-correct) "EVE Cloud, Max" lane line.
//
// THE FIX: the active lane/tier is fully determined by the SAME persisted
// picker selection the router uses (`commandEve.inferenceSelection`) — never by
// the shim model id. This pure resolver turns that selection into an honest,
// shim-free self-description string EVE can read:
//   - EVE cloud lane  → "EVE Cloud, <Tier>-Stufe (…)" — NO shim id, NO "local".
//   - Private/local   → the real local model name (honest, unchanged).
// It NEVER surfaces `command-eve-gemma4-e4b-64k` on a cloud lane.
//
// 1.2.19 STORE-SPLIT RECONCILE: in this release line the persisted selection
// lives in the BACKEND settings store, NOT ProcessConfig (see
// inferenceSelectionBackendRead.ts — the same trap that mis-routed EVE Max as
// Flash). The caller therefore feeds the selection it read from the backend
// store (one read shared by the router tier AND this self-description lane);
// these pure resolvers only consume that already-read string.
// ---------------------------------------------------------------------------

export type CommandEveActiveLane =
  | { kind: 'eve'; tierId: EveInferenceTierId; tierLabel: string; wireTier: EveInferenceWireTier }
  | { kind: 'local'; tierId: string; modelLabel: string };

/**
 * Resolve the ACTIVE inference lane from the persisted picker selection (the
 * single source of truth the send-path router also reads). Pure + sync so the
 * self-description and the router share one discriminant.
 *
 * Falls back to the EVE Standard default for an absent/empty selection (the same
 * default the renderer + router apply), so a fresh user is described as the
 * cloud lane they actually hit, not the unused local model.
 */
export function resolveCommandEveActiveLane(persisted: string | null | undefined): CommandEveActiveLane {
  const selection = resolveEffectiveInferenceSelection(persisted);

  if (isEveInferenceSelection(selection)) {
    const tierId = parseEveTierIdFromSelection(selection) ?? EVE_INFERENCE_DEFAULT_TIER_ID;
    const tier = findEveInferenceTier(tierId) ?? EVE_INFERENCE_TIERS[0];
    return { kind: 'eve', tierId: tier.id, tierLabel: tier.label, wireTier: tier.tier };
  }

  const localTier = parseLocalTierFromSelection(selection);
  if (localTier) {
    return { kind: 'local', tierId: localTier.id, modelLabel: localTier.modelLabel };
  }
  // An unknown non-EVE value: treat as the local default tier (honest local
  // model name), never the cloud lane.
  const fallback = EVE_LOCAL_PICKER_TIERS[0];
  return { kind: 'local', tierId: fallback.id, modelLabel: fallback.modelLabel };
}

/**
 * Short, honest per-tier quality blurb for the EVE cloud tiers — describes the
 * lane by its USER-FACING tier properties (context size + quality), never by the
 * upstream provider model id (which the user never picked and must never see).
 */
const EVE_CLOUD_TIER_BLURB: Record<EveInferenceTierId, { de: string; en: string }> = {
  'eve-standard': {
    de: 'solide Qualität, schnelle Antworten',
    en: 'solid quality, fast answers',
  },
  'eve-high': {
    de: 'höhere Qualität, größerer Kontext',
    en: 'higher quality, larger context',
  },
  'eve-xhigh': {
    de: 'tiefes Reasoning, große Aufgaben',
    en: 'deep reasoning, hard tasks',
  },
  'eve-max': {
    de: 'maximales Reasoning, starke Agentenarbeit',
    en: 'maximum reasoning, strong agent work',
  },
  'eve-ultra': {
    de: 'maximales Reasoning, proaktive Worker-Orchestrierung',
    en: 'maximum reasoning, proactive worker orchestration',
  },
};

/**
 * Build the honest self-description string for the active lane, in the given
 * locale. This is what EVE reads to answer "which model/lane are you running?".
 *
 * CLOUD: "EVE Cloud, <Tier>-Stufe (<blurb>)" — describes the active tier; NEVER
 * the shim model id and NEVER claims a local model.
 * LOCAL: the real local model name (e.g. "Lokal · Gemma 4 E4B (privat, auf
 * deinem Mac)") — honest about running locally.
 */
export function describeCommandEveActiveLane(persisted: string | null | undefined, locale: 'de-DE' | 'en-US'): string {
  const lane = resolveCommandEveActiveLane(persisted);
  const de = locale === 'de-DE';

  if (lane.kind === 'eve') {
    const blurb = EVE_CLOUD_TIER_BLURB[lane.tierId]?.[de ? 'de' : 'en'] ?? '';
    return de
      ? `EVE Cloud, ${lane.tierLabel}-Stufe${blurb ? ` (${blurb})` : ''}`
      : `EVE Cloud, ${lane.tierLabel} tier${blurb ? ` (${blurb})` : ''}`;
  }

  return de
    ? `Lokal · ${lane.modelLabel} (privat, läuft auf deinem Mac)`
    : `Local · ${lane.modelLabel} (private, runs on your Mac)`;
}

// ---------------------------------------------------------------------------
// Entitlement → gating. The ONLY input the gating needs is the trial flag, so
// callers pass a minimal shape (mirrors entitlementCore's status surface).
// ---------------------------------------------------------------------------

/**
 * Minimal entitlement view the picker needs. `trial_ends_at` present + non-null
 * ⇒ this is a TRIAL entitlement (entitlementCore CEVE.v2 contract). NOTE: both a
 * PAID license AND the PERMANENT FREE seat keep trial_ends_at null/absent, so
 * trial_ends_at ALONE cannot tell free from paid — that is exactly why the BYOK
 * gate keys off `has_paid_seat`, not trial_ends_at.
 *
 * `has_paid_seat` (1.2.18 + free-seat 2026-06-30) is the explicit, main-process-
 * derived paid-tier hint (see entitlementCore.isPaidSeatEdition: `entitled &&
 * trial_ends_at == null && edition != 'free'`). It is ONE authoritative
 * discriminant for paid-only UI affordances (BYOK / add-own-model / client seats);
 * absent/false ⇒ free or trial tier. Carried here so the pure gate helpers consume it.
 *
 * `has_active_topup` (v1.5 M7) is the SECOND unlock path: an active credit
 * SUBSCRIPTION (recurring top-up, from 25 €/month) that grants Pro features WITHOUT
 * a paid client seat. It is sourced from the credits-status contract (additive; an
 * absent field ⇒ false ⇒ today's behavior). Either signal unlocks BYOK; cancelling
 * the subscription flips it back off for free (the gate re-reads the live status).
 */
export interface EveEntitlementView {
  trial_ends_at?: string | null;
  has_paid_seat?: boolean;
  has_active_topup?: boolean;
  /** Live credits truth: purchased/included metered credits can fund cloud inference. */
  has_metered_credits?: boolean;
  /** Distinguishes an authoritative zero-credit response from an unavailable response. */
  metered_credit_access_known?: boolean;
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
 * True iff the user MAY add their own model / API key (BYOK) — the Pro-feature
 * gate (1.2.18 Req 4 + v1.5 M7). Unlocked by EITHER paid path:
 *   - `has_paid_seat` (a paid client seat), OR
 *   - `has_active_topup` (an active credit subscription, from 25 €/month, M7).
 * AND it must not be trialing (a trial never unlocks Pro features). A free OR
 * trial OR unknown entitlement returns false. This is what the Settings→Modell
 * "Add Platform" / api_key affordances gate on; it SUPERSEDES the trial-only
 * `isByokDisabledForEntitlement`. Defense-in-depth: a present-and-true unlock
 * signal is REQUIRED and it must not be trialing — both conditions — so a
 * malformed/stale view can never wrongly unlock. Cancelling the subscription
 * flips `has_active_topup` off on the next live status read, re-locking for free.
 */
export function isModelByokAllowed(entitlement: EveEntitlementView | null | undefined): boolean {
  const paidUnlock = entitlement?.has_paid_seat === true || entitlement?.has_active_topup === true;
  return paidUnlock && !isTrialingEntitlement(entitlement);
}

/**
 * Whether metered EVE cloud levels are available. This is intentionally wider
 * than BYOK: bought credits must remain spendable even when a stale trial flag
 * is still present, while adding arbitrary provider keys stays a Pro-only gate.
 */
export function hasEvePaidInferenceAccess(entitlement: EveEntitlementView | null | undefined): boolean {
  if (
    entitlement?.has_paid_seat === true ||
    entitlement?.has_active_topup === true ||
    entitlement?.has_metered_credits === true
  ) {
    return true;
  }

  if (entitlement?.metered_credit_access_known === true) {
    return false;
  }

  // Compatibility for an unavailable credits endpoint: retain the previously
  // proven entitlement behavior instead of revoking access on a transient read.
  return !isTrialingEntitlement(entitlement);
}

/**
 * UI-only BYOK lock decision with three-state credits truth. A confirmed trial
 * always locks. Otherwise an authoritative credits response may confirm that no
 * paid path exists; an unavailable response must stay unknown and cannot revoke
 * an already-purchased unlock. The server remains the binding authorization gate.
 */
export function shouldDisableModelByok(
  entitlement: EveEntitlementView | null | undefined,
  creditsStatusAuthoritative: boolean
): boolean {
  if (isTrialingEntitlement(entitlement)) return true;
  if (isModelByokAllowed(entitlement)) return false;
  return creditsStatusAuthoritative;
}

/**
 * Whether a given EVE tier is selectable for the entitlement. Standard is
 * always selectable; metered levels require paid inference access.
 */
export function isEveTierSelectable(
  tier: Pick<EveInferenceTier, 'paidOnly'>,
  entitlement: EveEntitlementView | null | undefined
): boolean {
  if (!tier.paidOnly) return true;
  return hasEvePaidInferenceAccess(entitlement);
}

/**
 * Build the full two-group picker model (STUFEN) for the current entitlement.
 * Local tiers are never gated. EVE Standard is always selectable; Hoch, Sehr
 * hoch, Maximum and Ultra require a paid seat, active top-up, or spendable metered
 * credits. Cloud rows expose capability descriptors rather than concrete model
 * names because the server owns provider and model routing.
 */
export function buildEvePickerGroups(entitlement: EveEntitlementView | null | undefined): EvePickerGroup[] {
  const paidInferenceAccess = hasEvePaidInferenceAccess(entitlement);

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
      const disabled = tier.paidOnly && !paidInferenceAccess;
      const consumesCredits = tier.consumesCredits === true;
      const gated = tier.gated === true;
      // Cloud rows expose capability labels; concrete model routing remains
      // server-owned and may change without a desktop release.
      const modelLabel = 'modelLabel' in tier ? (tier.modelLabel as string) : undefined;
      const sublabel = modelLabel ?? EVE_INFERENCE_TIER_SUBLABEL;
      const costBadge = gated && 'costBadge' in tier ? (tier.costBadge as string) : undefined;
      return {
        value: eveTierValue(tier.id),
        group: 'eve' as const,
        // The group header already conveys the EVE cloud lane. Founder mandate:
        // Keep routine metered rows quiet. Ultra alone exposes its explicit
        // high-cost warning because it is experimental and materially dearer.
        label: EVE_INFERENCE_TIER_DISPLAY_LABELS[tier.tier],
        sublabel,
        disabled,
        ...(disabled ? { disabledReasonCode: 'PAID_TIER_REQUIRED' as const } : {}),
        ...(costBadge ? { costBadge } : {}),
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
 * selectable and EVE Pro LOCKED (all five rungs shown greyed, with an upgrade
 * affordance); a PAYING user no longer sees EVE Free (hidden) and EVE Pro becomes
 * selectable. EVE Pro = Standard · Hoch · Sehr hoch · Maximum · Ultra with increasing
 * reasoning/cost; the server owns the concrete model registry and metering.
 */
export function buildEveLaneViews(entitlement: EveEntitlementView | null | undefined): PickerLaneView[] {
  const paidInferenceAccess = hasEvePaidInferenceAccess(entitlement);
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
      state: paidInferenceAccess ? 'hidden' : 'available',
      items: buildFreeLaneItems(),
    },
    {
      lane: 'pro',
      title: 'EVE Pro',
      accent: 'gold',
      // Trial/free: all five rungs SHOWN but greyed + upgrade. Paid: selectable.
      // EVE Pro includes the Standard rung (same model as Free) so the full
      // intelligence ladder lives in one lane.
      state: paidInferenceAccess ? 'available' : 'locked',
      items: EVE_INFERENCE_TIERS.map((tier) => eveTierToProItem(tier, !paidInferenceAccess)),
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
export function commandEveActiveModeLabel(selection: string | null | undefined, locale: 'de-DE' | 'en-US'): string {
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
