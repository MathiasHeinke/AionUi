/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE inference picker — pure core (STUFEN / level model).
 *
 * The founder mandate is "nothing confusing": a user picks a STUFE (level), NOT
 * a raw model id. No upstream model name, vendor or slug is ever surfaced from
 * this module — the server owns the registry that turns a level into a model.
 *
 *   - Privat (lokal):   Standard / Hoch — the bundled local tiers from
 *                       commandEveShell.ts. These ARE named, because they run
 *                       openly on the user's own machine.
 *   - EVE Inference:    the CLOUD lane, reached through the OpenAI-compatible
 *                       Edge Function. Levels only; no model names.
 *
 * THE OFFERED SURFACE IS EXACTLY TWO CHOICES (MAT-1749):
 *   - Standard — the unnamed default. Free-eligible; the default for a fresh chat.
 *   - MAX      — the strong lane. Paid: it unlocks on a qualifying paid plan or on
 *                REAL purchased credits. Promotional/allowance credits do NOT
 *                unlock it (see {@link hasEveMaxAccess}).
 *
 * The intermediate rungs are no longer OFFERED. They are NOT deleted from
 * {@link EVE_INFERENCE_TIERS}: the managed-visual / media turn contract
 * (eveManagedVisualTurnCore.ts) is a separate wallet consumer that still keys on
 * the `high` / `xhigh` / `ultra` wire tiers, so the wire substrate must survive.
 * What collapses is the OFFER, not the substrate — a persisted selection on a
 * retired rung is MIGRATED (see {@link normalizeLegacyEveTierId}) rather than
 * stranded.
 *
 * The offer is DERIVED (see {@link EVE_INFERENCE_OFFERED_WIRE_TIERS}) from the
 * server allow-list rather than hand-listed, so a rung the Edge Function refuses
 * cannot become offerable by construction — not merely by a rule someone has to
 * remember.
 *
 * FREE-TIER RULES (entitlement trialing/free per entitlementCore):
 *   - MAX is disabled unless a paid seat/plan OR a REAL purchased-credit balance
 *     exists. An active top-up is NOT in that list: it is a BYOK signal only, and
 *     a subscription that has been fully spent has no purchased balance — treating
 *     it as a MAX unlock made the client offer a lane the server answers with 402.
 *   - BYOK is GREYED OUT in settings (handled at the settings surface using
 *     {@link isByokDisabledForEntitlement} from this module).
 *   - EVE Standard + the two local tiers always stay selectable.
 *
 * BACKEND LEVEL REGISTRY (no tier→level shift): the eve-inference Edge Function
 * resolves the concrete upstream model from a user-facing LEVEL via a registry
 * (accepted levels: standard, high, xhigh, max). The wire `tier` this module
 * sends IS the registry level verbatim — there is NO tier→level bridge/shift:
 * Standard→`standard`, MAX→`max`. The function looks the value up in the
 * registry directly. A persisted retired rung is migrated before it can travel.
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
 *   - `costBadge`       — short, non-secret UI badge text. It is emitted for any
 *                         OFFERED rung that declares one (today: MAX). It used to
 *                         be emitted only when `gated` was true, which — once the
 *                         gated rung was retired — made it dead affordance code.
 *
 * The free level (Standard) carries NO cost badge; the user can pick it on a
 * trial with no card.
 */
export const EVE_INFERENCE_TIERS = [
  {
    id: 'eve-standard',
    // STUFE: Standard — the OFFERED entry rung, and the unnamed default.
    //
    // IT IS METERED. There is no free cap and no un-metered lane any more: every
    // cloud turn reserves, calls and debits, standard included. The old metadata
    // said `consumesCredits: false` and described a "100/Tag, €0" trial cap —
    // the free-lane ghost surviving in the client after the server deleted it.
    // A trial seat spends its promotional ALLOWANCE on these turns; that is a
    // funding source, not a free lane.
    label: 'Standard',
    tier: 'standard',
    /** Selectable without a purchase — but still metered, see above. `paidOnly`
     *  gates SELECTABILITY, `consumesCredits` describes what a turn costs; the
     *  two are independent and only the first is false here. */
    paidOnly: false,
    consumesCredits: true,
    gated: false,
    /** User-facing CAPABILITY descriptor (sublabel only; NEVER a model name — founder mandate). */
    modelLabel: 'großer Kontext',
  },
  {
    id: 'eve-high',
    // RETIRED FROM THE OFFER (MAT-1749) — still a valid WIRE tier.
    //
    // Not deleted: the managed-visual / media turn contract keys on `high`, and a
    // persisted selection has to be recognisable in order to be migrated (this
    // one migrates DOWN to Standard — see normalizeLegacyEveTierId). It is absent
    // from EVE_INFERENCE_SELECTABLE_TIERS, so it never reaches the picker.
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
    // RETIRED FROM THE OFFER (MAT-1749) — still a valid WIRE tier for the
    // managed-visual / media turn contract. A persisted selection migrates UP to
    // MAX, because that is the lane the user was reaching for.
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
    // STUFE: MAX — the strong lane, and the only user-visible name for it. This
    // is one of the exactly two OFFERED rungs. Everything about which upstream
    // model serves it is server-owned and never surfaced here.
    label: 'MAX',
    tier: 'max',
    paidOnly: true,
    consumesCredits: true,
    gated: false,
    modelLabel: 'starkes Agenten-Reasoning',
    costBadge: 'sehr hohe Kosten',
  },
  {
    id: 'eve-ultra',
    // RETIRED COMPATIBILITY METADATA — not an offered level.
    //
    // Kept ONLY so a persisted `command-eve-inference:eve-ultra` can still be
    // recognised and migrated to MAX; it is excluded from
    // EVE_INFERENCE_SELECTABLE_TIERS, so it never reaches the picker, and its
    // wire tier is not one the Edge Function accepts on the CHAT path. The
    // bounded worker profile this rung used to carry now rides on MAX.
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
 * User-facing cloud-row labels. The OFFERED surface reads "Standard · MAX"; the
 * remaining entries exist only so a non-offered wire tier can still be named in
 * a diagnostic/self-description context without falling back to a raw id.
 *
 * This map is presentation-only and does NOT change any selection value or wire
 * `tier`.
 */
export const EVE_INFERENCE_TIER_DISPLAY_LABELS: Record<EveInferenceWireTier, string> = {
  standard: 'Standard',
  high: 'Hoch',
  xhigh: 'Sehr hoch',
  max: 'MAX',
  ultra: 'Ultra',
};

export const EVE_INFERENCE_DEFAULT_TIER_ID: EveInferenceTierId = EVE_INFERENCE_TIERS[0].id;

/**
 * Where the renderer publishes the seat's proven MAX entitlement so the MAIN
 * process can apply the non-brick clamp.
 *
 * The main process has no cheap authoritative entitlement read: the credits
 * status is a network call behind an IPC handler, and putting that on the
 * per-turn hot path would add both latency and a new failure mode to every
 * message. The renderer already computes this authoritatively, and it already
 * writes {@link EVE_INFERENCE_PROVIDER_ID_PREFIX}-scoped settings to the same
 * backend store the routing resolver reads — so publishing one boolean there
 * makes the clamp real at ZERO extra cost per turn (it rides the GET that was
 * already happening).
 *
 * Seat-scoped exactly like the selection. Absent ⇒ unknown ⇒ no clamp.
 */
export const EVE_MAX_ENTITLED_SETTINGS_KEY = 'commandEve.maxEntitled';

/** The Standard rung — the unnamed default half of the two-choice offer. */
export const EVE_INFERENCE_STANDARD_TIER_ID: EveInferenceTierId = 'eve-standard';
/** The MAX rung — the strong half of the two-choice offer. */
export const EVE_INFERENCE_MAX_TIER_ID: EveInferenceTierId = 'eve-max';

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
// Picker presentation model. Local + EVE are the only built-in groups. A future
// routed provider adapter may explicitly append `connected` groups; this core
// never discovers provider settings or ACP/CLI agents on its own.
// ---------------------------------------------------------------------------

export type EvePickerGroupKind = 'local' | 'eve' | 'connected';

export type EvePickerUnavailableReasonCode =
  | 'PAID_TIER_REQUIRED'
  | 'OFFLINE'
  | 'AUTH_REQUIRED'
  | 'HARDWARE_UNSUPPORTED'
  | 'NOT_INSTALLED'
  | 'VERIFICATION_REQUIRED'
  | 'UNAVAILABLE';

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
  disabledReasonCode?: EvePickerUnavailableReasonCode;
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

/**
 * Future connected-provider groups must come from an explicit, routed adapter.
 * The picker does not turn generic model settings or ACP workers into entries.
 */
export type EveConnectedProviderGroup = Omit<EvePickerGroup, 'kind' | 'items'> & {
  kind: 'connected';
  items: Array<EvePickerItem & { group: 'connected' }>;
};

export type EveLocalPickerRuntimeTruth = {
  statusKnown: boolean;
  ramFit: boolean;
  installed: boolean;
  readyForUse: boolean;
};

export type EvePickerRuntimeTruth = {
  cloudOnline?: boolean;
  cloudAuthenticated?: boolean;
  localTiers?: Readonly<Record<string, EveLocalPickerRuntimeTruth | undefined>>;
};

export type EvePickerItemAvailability = {
  state: 'available' | 'checking' | 'unavailable';
  selectable: boolean;
  reasonCode?: EvePickerUnavailableReasonCode;
};

/**
 * Filter groups without flattening their navigation hierarchy. Group-title
 * matches keep the full group; item matches keep only matching rows.
 */
export function filterEvePickerGroups(groups: readonly EvePickerGroup[], query: string): EvePickerGroup[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return groups.map((group) => ({ ...group, items: [...group.items] }));

  return groups.flatMap((group) => {
    const groupMatches = group.title.toLocaleLowerCase().includes(normalizedQuery);
    const items = groupMatches
      ? [...group.items]
      : group.items.filter((item) =>
          [item.label, item.sublabel, item.costBadge].some((value) =>
            value?.toLocaleLowerCase().includes(normalizedQuery)
          )
        );
    return items.length > 0 ? [{ ...group, items }] : [];
  });
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
 * The wire tiers the eve-inference Edge Function accepts.
 *
 * Deliberately its OWN list rather than a slice of the picker registry: the
 * desktop ladder and the server contract are separate things that merely
 * overlap, and the registry can carry a rung the function has not been taught.
 * Such a rung is answered with 403 `tier_not_allowed`, and because the tier
 * travels on EVERY request, a seat holding it loses every turn — not only the
 * ones that route to media.
 */
export const EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS = Object.freeze(['standard', 'high', 'xhigh', 'max'] as const);

/**
 * A wire tier the server accepts. Narrower than {@link EveInferenceWireTier},
 * which also contains rungs the picker offers but the function refuses — a
 * predicate narrowing to the wider type would let a refused value type-check as
 * sendable, which is the mistake this type exists to make impossible.
 */
export type ServerAllowedWireTier = (typeof EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS)[number];

/** The strongest rung the server accepts — where a retired rung lands. */
export const EVE_INFERENCE_LEGACY_ULTRA_FALLBACK_TIER_ID: EveInferenceTierId = 'eve-max';

/**
 * The tier ids the product OFFERS. Exactly two: the unnamed default and MAX.
 *
 * Kept as ids (not wire tiers) because that is what a persisted selection holds
 * and what a migration has to produce.
 */
const EVE_INFERENCE_OFFERED_TIER_IDS = Object.freeze([
  EVE_INFERENCE_STANDARD_TIER_ID,
  EVE_INFERENCE_MAX_TIER_ID,
] as const);

/** An id on the offered surface. */
export type OfferedEveTierId = (typeof EVE_INFERENCE_OFFERED_TIER_IDS)[number];

/** Whether a tier id is one of the two the picker offers. */
export function isOfferedEveTierId(tierId: string | undefined): tierId is OfferedEveTierId {
  return typeof tierId === 'string' && (EVE_INFERENCE_OFFERED_TIER_IDS as readonly string[]).includes(tierId);
}

/**
 * The wire tiers the OFFERED surface may travel on.
 *
 * DERIVED by filtering the server allow-list — not hand-written next to it. That
 * ordering matters: an offered rung the Edge Function refuses is impossible by
 * CONSTRUCTION, because a tier that is not in
 * {@link EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS} can never survive this filter,
 * no matter what someone later adds to the offered-id list.
 */
export const EVE_INFERENCE_OFFERED_WIRE_TIERS = Object.freeze(
  EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS.filter((wire) =>
    EVE_INFERENCE_TIERS.some((tier) => tier.tier === wire && isOfferedEveTierId(tier.id))
  )
);

/**
 * A wire tier the product currently OFFERS.
 *
 * Strictly narrower than {@link ServerAllowedWireTier} at the TYPE level too, not
 * only at runtime: the server still accepts rungs the picker no longer presents
 * (the managed-visual / media contract uses them), so a single loose union would
 * let a non-offered rung type-check as offerable. The `& ServerAllowedWireTier`
 * intersection is the compile-time half of the same guarantee the runtime filter
 * above enforces — offering a rung the server refuses collapses to `never`.
 */
export type OfferedWireTier = Extract<EveInferenceTier, { id: OfferedEveTierId }>['tier'] & ServerAllowedWireTier;

/** Whether this wire tier is part of the two-choice offer the picker presents. */
export function isOfferedWireTier(tier: string): tier is OfferedWireTier {
  return (EVE_INFERENCE_OFFERED_WIRE_TIERS as readonly string[]).includes(tier);
}

/**
 * The rungs a user may actually pick.
 *
 * Derived from {@link EVE_INFERENCE_OFFERED_WIRE_TIERS}, which is itself derived
 * from the server allow-list — so an unofferable rung cannot leak into the picker
 * through either door. {@link EVE_INFERENCE_TIERS} keeps every rung — including
 * retired ones — because a persisted selection still has to be recognised in
 * order to be migrated, and because the media contract still uses those wire
 * values.
 */
export const EVE_INFERENCE_SELECTABLE_TIERS = EVE_INFERENCE_TIERS.filter((tier) => isOfferedWireTier(tier.tier));

/**
 * Where each retired rung lands when the offer collapsed to Standard + MAX.
 *
 * Direction is a product decision, not a mechanical one:
 *   - `eve-high`  → Standard. It was the cheap step above Standard; a user on it
 *                   was not paying for the strong lane, so silently promoting
 *                   them to MAX would start metering them harder than they chose.
 *   - `eve-xhigh` → MAX. It was the deep-reasoning rung; MAX is what that user
 *                   was reaching for.
 *   - `eve-ultra` → MAX. Already the pre-existing behaviour; the server refuses
 *                   `ultra` on the chat path, so anything else costs every turn.
 */
const EVE_INFERENCE_TIER_ID_MIGRATIONS: Readonly<Partial<Record<EveInferenceTierId, EveInferenceTierId>>> =
  Object.freeze({
    'eve-high': EVE_INFERENCE_STANDARD_TIER_ID,
    'eve-xhigh': EVE_INFERENCE_MAX_TIER_ID,
    'eve-ultra': EVE_INFERENCE_MAX_TIER_ID,
  });

/**
 * Migrate a no-longer-offered tier id onto the offered surface.
 *
 * Applied at PARSE level, not only on the wire, so the selection genuinely
 * BECOMES the migrated tier — labels included. Migrating only outbound would
 * leave the picker naming one tier while another is sent.
 *
 * Only KNOWN retired ids are mapped. Anything else unrecognised stays
 * unrecognised so the caller fails loud; a value that cannot be named is not a
 * value to silently reinterpret.
 */
export function normalizeLegacyEveTierId(tierId: EveInferenceTierId | undefined): EveInferenceTierId | undefined {
  if (tierId === undefined) return undefined;
  return EVE_INFERENCE_TIER_ID_MIGRATIONS[tierId] ?? tierId;
}

/**
 * REPAIR a persisted selection into something that can ALWAYS be acted on.
 *
 * WHY THIS IS NOT THE SAME AS {@link migrateLegacyEveSelection}: migration is
 * about intent (a rung the user picked that no longer exists as an offer).
 * Repair is about SURVIVAL — a value nobody can parse. Those were previously
 * handled only in the renderer hook, which meant:
 *
 *   - a corrupt EVE-prefixed value (`command-eve-inference:eve-bogus`) reached
 *     the wire as "no tier" and the shim answered 500 on EVERY turn until the
 *     renderer happened to have mounted and rewritten it — a boot-order race,
 *     and absent entirely on paths where the hook never mounts;
 *   - a corrupt NON-prefixed value silently dropped the seat onto the LOCAL lane
 *     forever, because it matched neither prefix and nothing ever repaired it.
 *
 * So this lives in the pure core and is applied at the WIRE as well as in the
 * renderer. `repaired: true` means the stored string is not what it claims and a
 * caller holding a writable store SHOULD rewrite it.
 *
 * Note the deliberate asymmetry with the 1.2.19 fail-loud rule: a RECOGNISED
 * rung is never silently downgraded (that bug cost a paid seat its lane). This
 * only ever touches values that cannot be named at all — for which there is no
 * intent to preserve, and where the alternative is a seat that cannot send.
 */
export type EveInferenceSelectionRepair = {
  /** A selection every consumer can resolve. */
  selection: string;
  /** True iff `selection` differs from what was stored. */
  repaired: boolean;
};

export function repairInferenceSelection(persisted: string | null | undefined): EveInferenceSelectionRepair {
  const effective = resolveEffectiveInferenceSelection(persisted);

  if (isEveInferenceSelection(effective)) {
    const migrated = migrateLegacyEveSelection(effective);
    const selection = migrated ?? effective;
    return { selection, repaired: selection !== persisted };
  }

  if (isLocalSelection(effective)) {
    // A known local tier is honoured verbatim. An UNKNOWN local id is left alone
    // too: the local picker list can legitimately grow, and the local lane never
    // egresses, so an unrecognised local value costs nothing and must not be
    // silently converted into a metered cloud turn.
    return { selection: effective, repaired: false };
  }

  // Neither prefix: a corrupt/foreign value. Left alone it would pin the seat to
  // the local lane forever (isEveInferenceSelection === false), so repair it to
  // the documented default rather than leaving it stranded.
  return { selection: EVE_DEFAULT_INFERENCE_SELECTION, repaired: true };
}

/**
 * Migrate a persisted SELECTION STRING, for callers holding the raw stored value
 * rather than a parsed tier id.
 *
 * Returns the replacement selection when migration applies and `undefined` when
 * there is nothing to change, so a caller can distinguish "already current" from
 * "rewritten" and write back only in the second case. Parsing alone changes
 * neither what is on disk nor what the picker shows as active; that needs this
 * plus a write.
 *
 * A LOCAL selection is never touched — the local lane is a separate offer.
 * An EVE selection naming NO known rung resolves to Standard rather than staying
 * stranded.
 *
 * SCOPE, precisely: this function only produces a REPLACEMENT STRING. On its own
 * it guarantees nothing about what the wire does — that guarantee comes from
 * {@link repairInferenceSelection} being applied at the wire path too. Before
 * that existed, this repair lived only in the renderer hook, so a corrupt value
 * still 500'd every turn until (and unless) the hook happened to mount.
 */
export function migrateLegacyEveSelection(selection: string | null | undefined): string | undefined {
  if (!isEveInferenceSelection(selection)) return undefined;
  const rawTierId = (selection as string).slice(EVE_SELECTION_PREFIX.length);
  const known = findEveInferenceTier(rawTierId);
  const migrated = known ? normalizeLegacyEveTierId(known.id) : undefined;
  // Fail-safe: anything that does not land on the OFFERED surface becomes the
  // default rather than a selection nobody can act on.
  const targetId = isOfferedEveTierId(migrated) ? migrated : EVE_INFERENCE_DEFAULT_TIER_ID;
  const replacement = eveTierValue(targetId);
  return replacement === selection ? undefined : replacement;
}

/**
 * Parse an EVE tier id out of a selection value (e.g.
 * "command-eve-inference:eve-standard" → "eve-standard"). Returns undefined
 * when the value is not a known EVE selection.
 *
 * A persisted retired tier is migrated here, so every consumer — routing,
 * warm-up, lane resolution AND the visible mode label — agrees on the tier that
 * will actually be served.
 */
export function parseEveTierIdFromSelection(value: string | null | undefined): EveInferenceTierId | undefined {
  if (!isEveInferenceSelection(value)) return undefined;
  const tierId = (value as string).slice(EVE_SELECTION_PREFIX.length);
  return normalizeLegacyEveTierId(findEveInferenceTier(tierId)?.id);
}

/**
 * Resolve the WIRE TIER an EVE picker selection POSTs to the eve-inference Edge
 * Function (HONEST TIER ROUTING, 1.2.19). Maps a selection value to the registry
 * wire value via `parseEveTierIdFromSelection → findEveInferenceTier → .tier`,
 * VERBATIM for both OFFERED rungs:
 *
 *   command-eve-inference:eve-standard → 'standard'
 *   command-eve-inference:eve-max      → 'max'
 *
 * A rung that is no longer OFFERED is the one exception to verbatim: it is
 * migrated onto the offered surface rather than sent as-is, so the tier that
 * travels is the tier the picker names:
 *
 *   command-eve-inference:eve-high     → 'standard'  (migrated)
 *   command-eve-inference:eve-xhigh    → 'max'       (migrated)
 *   command-eve-inference:eve-ultra    → 'max'       (migrated; the server also
 *                                                     refuses `ultra` outright)
 *
 * See normalizeLegacyEveTierId for why each retired rung lands where it does.
 *
 * Returns `undefined` for a LOCAL selection, any value that does not resolve to
 * a known EVE tier, AND any tier outside
 * {@link EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS} (so a caller can fail-loud
 * rather than silently meter the cheapest model or post a refused tier). This is
 * the ONE place the selection→wire-tier mapping lives,
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
  const tier = findEveInferenceTier(tierId)?.tier;
  if (tier === undefined) return undefined;
  // Second boundary, fail-closed: never put a tier on the wire the server has
  // told us it refuses. The parse step above already migrates the one legacy
  // value we know; this catches anything the registry may grow later that the
  // Edge Function has not been taught yet. `undefined` makes the caller fail
  // loud — far better than a 403 that eats the user's turn, and better than
  // guessing a substitute nobody chose.
  return isServerAllowedWireTier(tier) ? tier : undefined;
}

/** Whether the eve-inference Edge Function accepts this wire tier today. */
export function isServerAllowedWireTier(tier: string): tier is ServerAllowedWireTier {
  return (EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS as readonly string[]).includes(tier);
}

/**
 * What the seat is allowed to send, as opposed to what it PICKED.
 *
 * `maxEntitled` is deliberately three-state:
 *   - `true`      — proven entitled: MAX travels.
 *   - `false`     — proven NOT entitled: MAX falls back to `standard`, and the
 *                   surface says why.
 *   - `undefined` — UNKNOWN (never written, a read that failed, a surface with no
 *                   entitlement truth). Neither answer may be guessed: sending
 *                   `max` would put paid spend on an UNVERIFIED seat, and sending
 *                   `standard` would silently downgrade a seat that may well be
 *                   paying. The lane is therefore HELD — see
 *                   {@link resolveEveWireLaneDecision}.
 */
export type EveSeatWireEntitlement = { maxEntitled?: boolean };

/** Why an EVE cloud lane refuses to send. Exactly one reason exists today. */
export type EveWireHoldReason = 'max-entitlement-unknown';

/**
 * The three answers the send path can get for a picker selection.
 *
 *   - `send`        — a wire tier the request may carry, verbatim.
 *   - `hold`        — MAX intent on an UNVERIFIED seat. Nothing may be sent, and
 *                     nothing may be substituted: both substitutions are the
 *                     failures this contract exists to prevent.
 *   - `no-eve-lane` — a LOCAL or unresolvable selection; the cloud lane is not
 *                     engaged at all (what `undefined` used to mean).
 */
export type EveWireLaneDecision =
  | { status: 'send'; tier: EveInferenceWireTier }
  | { status: 'hold'; reason: EveWireHoldReason }
  | { status: 'no-eve-lane' };

/**
 * THE SEND DECISION — fail-closed in BOTH directions.
 *
 * This replaced `resolveEffectiveWireTierFromSelection`, which returned a bare
 * tier and therefore had no way to say "do not send at all". It answered UNKNOWN
 * entitlement with `max`, on the reasoning that the server is the binding gate
 * and that guessing "unentitled" would downgrade a paying seat. Half of that is
 * still true — the downgrade half — but letting `max` travel on an entitlement
 * nobody read is HIDDEN SPEND on an unverified seat, and "the server will refuse
 * it" is not a spend control the client is allowed to lean on.
 *
 * So the three states are answered as three states:
 *
 *   TRUE     → send `max`.
 *   FALSE    → send `standard`. The seat is never bricked, and the surface says
 *              why (non-provider copy — no model, vendor or slug is ever named).
 *   UNKNOWN  → HOLD. No request leaves on this selection until the entitlement
 *              resolves one way or the other.
 *
 * THE PERSISTED SELECTION IS NEVER TOUCHED HERE, and that is deliberate: the user
 * chose MAX and that choice must survive a hold, a lapse and a transient credits
 * blip. Intent is stored; entitlement decides what travels this turn.
 *
 * A bare `standard` selection is never held — it is the floor, and it needs no
 * entitlement. Only a selection that RESOLVES to `max` (including the migrated
 * legacy rungs) can reach the hold.
 *
 * NOTE THE DEFAULT. `seat` defaults to `{}` = unknown = HOLD, so a call site that
 * FORGETS the entitlement refuses to send rather than spending on a guess.
 */
export function resolveEveWireLaneDecision(
  selection: string | null | undefined,
  seat: EveSeatWireEntitlement = {}
): EveWireLaneDecision {
  const tier = resolveWireTierFromSelection(selection);
  if (tier === undefined) return { status: 'no-eve-lane' };
  if (tier !== 'max') return { status: 'send', tier };
  if (seat.maxEntitled === true) return { status: 'send', tier: 'max' };
  // PROVEN unentitled: the non-brick fallback. Standard is sendable, so the seat
  // keeps working while the copy explains what it lost.
  if (seat.maxEntitled === false) return { status: 'send', tier: 'standard' };
  return { status: 'hold', reason: 'max-entitlement-unknown' };
}

/**
 * MAY WE *SHOW* THE USER THAT MAX IS ACTIVE?
 *
 * Painting MAX requires a POSITIVE, KNOWN entitlement: `maxEntitled === true` and
 * nothing else. A painted "MAX aktiv" is a MONEY CLAIM made to the user's face,
 * and making it on an entitlement nobody proved is the unknown-authority-fails-
 * OPEN defect the picker gate already refuses ({@link hasEveMaxAccess} locks MAX
 * on an absent/null/unknown entitlement).
 *
 * SINCE 1.820.2 THIS AGREES WITH THE SEND PATH ON UNKNOWN, and the agreement is
 * the fix. The two used to disagree on purpose — paint Standard, send MAX — which
 * is precisely how hidden MAX spend could leave an unverified seat while the
 * surface showed the routine lane. {@link resolveEveWireLaneDecision} now HOLDS on
 * unknown, so neither half claims a lane it has not established.
 *
 * NOTE THE DEFAULT. `seat` defaults to `{}` = unknown = do-not-paint-MAX, so a
 * call site that FORGETS the entitlement under-claims rather than over-claims.
 * That polarity is the point: an omission has to fail closed.
 */
export function mayPaintEveMax(seat: EveSeatWireEntitlement = {}): boolean {
  return seat.maxEntitled === true;
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

/**
 * Combine entitlement gating with live cloud and local-runtime truth. Unknown
 * probes stay selectable but explicitly `checking`; missing evidence must never
 * invent an auth or hardware blocker.
 */
export function resolveEvePickerItemAvailability(
  item: EvePickerItem,
  runtimeTruth: EvePickerRuntimeTruth
): EvePickerItemAvailability {
  if (item.disabled) {
    return {
      state: 'unavailable',
      selectable: false,
      reasonCode: item.disabledReasonCode ?? 'UNAVAILABLE',
    };
  }

  if (item.group === 'eve') {
    if (runtimeTruth.cloudOnline === false) {
      return { state: 'unavailable', selectable: false, reasonCode: 'OFFLINE' };
    }
    if (runtimeTruth.cloudAuthenticated === false) {
      return { state: 'unavailable', selectable: false, reasonCode: 'AUTH_REQUIRED' };
    }
    if (runtimeTruth.cloudOnline === undefined || runtimeTruth.cloudAuthenticated === undefined) {
      return { state: 'checking', selectable: true };
    }
    return { state: 'available', selectable: true };
  }

  if (item.group === 'local') {
    const tierId = parseLocalTierFromSelection(item.value)?.localTierId;
    const localTruth = tierId ? runtimeTruth.localTiers?.[tierId] : undefined;
    if (!localTruth || !localTruth.statusKnown) {
      return { state: 'checking', selectable: true };
    }
    if (!localTruth.ramFit) {
      return { state: 'unavailable', selectable: false, reasonCode: 'HARDWARE_UNSUPPORTED' };
    }
    if (!localTruth.installed) {
      return { state: 'unavailable', selectable: false, reasonCode: 'NOT_INSTALLED' };
    }
    if (!localTruth.readyForUse) {
      return { state: 'unavailable', selectable: false, reasonCode: 'VERIFICATION_REQUIRED' };
    }
  }

  return { state: 'available', selectable: true };
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
export function resolveCommandEveActiveLane(
  persisted: string | null | undefined,
  seat: EveSeatWireEntitlement = {}
): CommandEveActiveLane {
  const selection = resolveEffectiveInferenceSelection(persisted);

  if (isEveInferenceSelection(selection)) {
    const parsed = parseEveTierIdFromSelection(selection) ?? EVE_INFERENCE_DEFAULT_TIER_ID;
    // PAINT AUTHORITY (1.820.1). The persisted selection is INTENT, not proof of
    // funding. A stored MAX may only be DESCRIBED as MAX on a positively-known
    // entitlement — see {@link mayPaintEveMax} for why this is the opposite
    // polarity to the send-path clamp. Clamping AFTER the parse (which already
    // migrated eve-ultra/eve-xhigh to MAX) keeps the order the send path uses:
    // migrate first, then judge — a clamp that ran first would make every legacy
    // seat look like Standard forever.
    const tierId =
      findEveInferenceTier(parsed)?.tier === 'max' && !mayPaintEveMax(seat) ? EVE_INFERENCE_STANDARD_TIER_ID : parsed;
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
export function describeCommandEveActiveLane(
  persisted: string | null | undefined,
  locale: 'de-DE' | 'en-US',
  seat: EveSeatWireEntitlement = {}
): string {
  const lane = resolveCommandEveActiveLane(persisted, seat);
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
 * trial_ends_at ALONE cannot tell free from paid — that is exactly why the seat
 * gates key off explicit edition-derived booleans, not trial_ends_at.
 *
 * `has_paid_seat` (1.2.18 + free-seat 2026-06-30) is the explicit, main-process-
 * derived PAID-seat hint (entitlementCore.isPaidSeatEdition: no trial window AND
 * the edition is on the PAID_SEAT_EDITIONS allowlist). It is a MAX-authority
 * signal ONLY. Absent/false ⇒ not a sold seat.
 *
 * `has_byok_seat` (1.820.1) is the SEPARATE, main-process-derived BYOK hint
 * (entitlementCore.isByokSeatEdition: no trial window AND the edition is on the
 * wider BYOK_SEAT_EDITIONS allowlist, which INCLUDES the comped `pilot` seat).
 * THE SPLIT IS THE POINT: `has_paid_seat` answered both questions until a MAX fix
 * narrowed it and silently deleted bring-your-own-model from every perpetual
 * pilot seat. Founder ruling: pilot keeps Standard AND BYOK, and never gets MAX
 * without purchased credits or a paid plan. Feeding this into a MAX predicate
 * would re-open exactly the hole the paid allowlist closed.
 *
 * `has_active_topup` (v1.5 M7) unlocks BYOK ONLY — it is NOT a MAX unlock. A
 * subscription that has been fully SPENT has no purchased balance, so MAX stays
 * locked (see {@link hasEveMaxAccess}); treating it as a MAX unlock made the
 * client offer a lane the server answers with 402. Keep the two gates distinct.
 *
 * As a BYOK signal it is the SECOND unlock path: an active credit
 * SUBSCRIPTION (recurring top-up, from 25 €/month) that grants Pro features WITHOUT
 * a paid client seat. It is sourced from the credits-status contract (additive; an
 * absent field ⇒ false ⇒ today's behavior). Either signal unlocks BYOK; cancelling
 * the subscription flips it back off for free (the gate re-reads the live status).
 */
export interface EveEntitlementView {
  trial_ends_at?: string | null;
  has_paid_seat?: boolean;
  /** Licensed, non-free seat (INCLUDING `pilot`) — the BYOK authority. Never a MAX unlock. */
  has_byok_seat?: boolean;
  has_active_topup?: boolean;
  /** Live credits truth: purchased/included metered credits can fund cloud inference. */
  has_metered_credits?: boolean;
  /** Distinguishes an authoritative zero-credit response from an unavailable response. */
  metered_credit_access_known?: boolean;
  /**
   * A qualifying PAID PLAN (the client mirror of the backend's `entitlement.kind
   * === 'paid'`). Distinct from `has_paid_seat`, which is the narrower paid
   * CLIENT-SEAT signal the BYOK gate keys on — widening that one would loosen
   * BYOK as a side effect, which is not what the MAX gate is asking for.
   */
  has_paid_plan?: boolean;
  /**
   * REAL purchased / topped-up credits remain (`purchased_credits_remaining > 0`).
   *
   * Deliberately NOT the same thing as {@link EveEntitlementView.has_metered_credits},
   * which is true for INCLUDED ALLOWANCE credits too. A promotional grant lands
   * in the allowance bucket, and a promotion must not unlock the strong lane —
   * that separation is the whole enforcement seam for the MAX gate.
   */
  has_purchased_credits?: boolean;
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
 * gate (1.2.18 Req 4 + v1.5 M7 + the 1.820.1 decoupling). Unlocked by EITHER:
 *   - `has_byok_seat` (a LICENSED, non-free seat — `standard` OR the comped
 *     `pilot`; see entitlementCore.isByokSeatEdition), OR
 *   - `has_active_topup` (an active credit subscription, from 25 €/month, M7).
 * AND it must not be trialing (a trial never unlocks Pro features). A free OR
 * trial OR unknown entitlement returns false.
 *
 * IT NO LONGER READS `has_paid_seat`, AND THAT IS THE FIX. This gate and
 * {@link hasEveMaxAccess} shared that one boolean, so narrowing it to keep a
 * zero-euro seat out of MAX — correct, and it stays — deleted BYOK from every
 * perpetual pilot seat as a side effect. FOUNDER RULING (1.820.1): a pilot seat
 * KEEPS Standard, KEEPS BYOK, and NEVER gets MAX absent purchased credits or an
 * explicitly paid plan. Reintroducing `has_paid_seat` here would not merely be
 * redundant (every paid seat is already a BYOK seat) — it would re-couple the two
 * authorities that this split exists to keep apart.
 *
 * Safe to be the wider rule: BYOK spends the USER's key, bypassing EVE inference
 * entirely, so there is no wallet at risk and no server gate to contradict.
 *
 * This is what the Settings→Modell "Add Platform" / api_key affordances gate on;
 * it SUPERSEDES the trial-only `isByokDisabledForEntitlement`. Defense-in-depth:
 * a present-and-true unlock signal is REQUIRED and it must not be trialing — both
 * conditions — so a malformed/stale view can never wrongly unlock. Cancelling the
 * subscription flips `has_active_topup` off on the next live status read.
 */
export function isModelByokAllowed(entitlement: EveEntitlementView | null | undefined): boolean {
  const byokUnlock = entitlement?.has_byok_seat === true || entitlement?.has_active_topup === true;
  return byokUnlock && !isTrialingEntitlement(entitlement);
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
 * THE MAX MONEY GATE. Exactly two unlocks, and nothing else:
 *
 *   (a) a qualifying PAID plan / paid client seat, OR
 *   (b) a REAL purchased-credit BALANCE (`purchased_credits_remaining > 0`).
 *
 * `has_active_topup` IS NOT AN UNLOCK, and removing it is the point. A top-up
 * subscription that has been fully SPENT is not a purchase balance — the seat has
 * no purchased credits left. Treating "has a top-up" as an unlock kept MAX open
 * on an exhausted wallet, and the server (which gates on
 * `entitlement.kind === "paid" || purchased_credits_remaining > 0`) then answered
 * 402. Client offering what the server refuses is the whole defect class here, so
 * the two predicates are deliberately the SAME rule stated twice, and a parity
 * test asserts they agree on the same inputs.
 *
 * Promotional / trial / included-allowance credits do NOT unlock MAX. The ledger
 * already separates the buckets; a promotional grant lands in ALLOWANCE, and that
 * split IS the enforcement seam.
 *
 * Fail-CLOSED on purpose: every unlock signal must be present-and-true. An
 * absent or unreadable credits status therefore locks MAX rather than opening
 * it — and the non-brick clamp keeps that seat able to send on Standard.
 */
export function hasEveMaxAccess(entitlement: EveEntitlementView | null | undefined): boolean {
  return (
    entitlement?.has_paid_seat === true ||
    entitlement?.has_paid_plan === true ||
    entitlement?.has_purchased_credits === true
  );
}

/**
 * Whether a given EVE tier is selectable for the entitlement. Standard is
 * always selectable; MAX keys on the stricter purchase gate above; any other
 * metered level keeps the wider metered-credit rule (the media/managed-visual
 * consumers still resolve through it).
 */
export function isEveTierSelectable(
  tier: Pick<EveInferenceTier, 'paidOnly'> & Partial<Pick<EveInferenceTier, 'tier'>>,
  entitlement: EveEntitlementView | null | undefined
): boolean {
  if (tier.tier === 'max') return hasEveMaxAccess(entitlement);
  if (!tier.paidOnly) return true;
  return hasEvePaidInferenceAccess(entitlement);
}

/**
 * Build the full two-group picker model (STUFEN) for the current entitlement.
 * Local tiers are never gated. The cloud group offers exactly Standard and MAX:
 * Standard is always selectable, MAX keys on {@link hasEveMaxAccess}. Cloud rows
 * expose capability descriptors rather than concrete model names because the
 * server owns provider and model routing.
 */
export function buildEvePickerGroups(
  entitlement: EveEntitlementView | null | undefined,
  connectedProviderGroups: readonly EveConnectedProviderGroup[] = []
): EvePickerGroup[] {
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
    items: EVE_INFERENCE_SELECTABLE_TIERS.map((tier) => {
      const disabled = !isEveTierSelectable(tier, entitlement);
      const consumesCredits = tier.consumesCredits === true;
      const gated = tier.gated === true;
      // Cloud rows expose capability labels; concrete model routing remains
      // server-owned and may change without a desktop release.
      const modelLabel = 'modelLabel' in tier ? (tier.modelLabel as string) : undefined;
      const sublabel = modelLabel ?? EVE_INFERENCE_TIER_SUBLABEL;
      // Emitted for any OFFERED rung that declares one (today: MAX only).
      // Keying it on `gated` made it dead code the moment the gated rung was
      // retired, and dead affordance code is worse than no affordance.
      const costBadge = 'costBadge' in tier ? (tier.costBadge as string) : undefined;
      return {
        value: eveTierValue(tier.id),
        group: 'eve' as const,
        // The group header already conveys the EVE cloud lane, so the rows carry
        // the STUFE only. MAX is the single user-visible name for the strong lane.
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

  const connectedGroups = connectedProviderGroups.filter((group) => group.items.length > 0);

  return [localGroup, eveGroup, ...connectedGroups];
}

// ---------------------------------------------------------------------------
// THERE IS NO FREE LANE, SO THERE IS NO FREE LANE MODEL (1.820.1).
//
// A three-lane picker model lived here — `PickerLane = 'local' | 'free' | 'pro'`,
// `buildEveLaneViews`, `buildFreeLaneItems`, `laneOfSelection` — presenting
// "Lokal · EVE Free · EVE Pro", with the EVE Free lane advertising a rung as
// "· 100/Tag" and `laneOfSelection` classifying the Standard cloud rung as
// `'free'`. Every cloud turn is credit-metered; Standard is INCLUDED, not free.
//
// IT WAS DELETED RATHER THAN RELABELLED, for two reasons. It was already DEAD —
// the rendered picker is `buildEvePickerGroups`, and nothing outside its own test
// file imported any of it — so relabelling would have preserved a free-lane
// vocabulary that no user could ever see, waiting to be picked up by the next
// surface that needed a picker. And a lane axis whose middle rung does not exist
// is not a model that can be corrected into truth; the honest correction is that
// it has no middle rung. Its test file is replaced by a guard asserting exactly
// that (tests/unit/command-eve/eveLaneViews.test.ts).

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
  locale: 'de-DE' | 'en-US',
  seat: EveSeatWireEntitlement = {}
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
    // NO TIER VOCABULARY. This string goes into EVE's own SYSTEM PROMPT, so it is
    // exactly how the ladder would sneak back into the product through the
    // assistant's mouth after being abolished in the UI. The routine lane has no
    // name; the only thing worth stating is whether MAX is engaged.
    //
    // The old text also hardcoded a context claim ("grosser Kontext") for EVERY
    // cloud rung, which was a capability assertion this module cannot verify —
    // the server owns the model and may change its window without a release.
    //
    // PAINT AUTHORITY (1.820.1): "MAX aktiv" is a money claim about the user's
    // seat, spoken by EVE in its own system prompt. It requires a positively-KNOWN
    // entitlement — unknown says nothing rather than claiming the strong lane.
    const maxEngaged = parseEveTierIdFromSelection(selection) === EVE_INFERENCE_MAX_TIER_ID && mayPaintEveMax(seat);
    if (de) {
      return maxEngaged ? 'EVE-Cloud, MAX aktiv' : 'EVE-Cloud';
    }
    return maxEngaged ? 'EVE Cloud, MAX on' : 'EVE Cloud';
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
  // Defence in depth: a caller holding a retired tier id — a stale route, an old
  // cached value — must not be able to build a provider whose use_model the
  // server refuses. Normalised to the same replacement the persistence migration
  // uses, so both paths land on one tier rather than disagreeing.
  const tier = findEveInferenceTier(normalizeLegacyEveTierId(args.tierId) ?? args.tierId);
  if (!tier) {
    throw new Error(`buildEveInferenceProvider: unknown EVE tier "${args.tierId}"`);
  }
  // The comment above used to CLAIM the server allow-list was enforced here; it
  // was not. It happened to hold only because every id the migration produces is
  // currently allowed — safe by coincidence, which is not safe. Enforce it.
  if (!isServerAllowedWireTier(tier.tier)) {
    throw new Error(
      `buildEveInferenceProvider: wire tier "${tier.tier}" is not accepted by the eve-inference function`
    );
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
