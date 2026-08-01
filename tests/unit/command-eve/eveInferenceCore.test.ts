/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EVE Inference picker core — the STUFEN (level) model + the required behaviors:
 *
 *  (0) STUFEN shape: the OFFERED surface is EXACTLY TWO rungs — Standard (the
 *      unnamed default, free-eligible) and MAX (the strong lane). The
 *      intermediate/retired rungs stay in the REGISTRY — the managed-visual /
 *      media contract still uses their wire tiers and a persisted selection has
 *      to be recognisable to be migrated — but none of them is offerable.
 *
 *  (1) Gating: MAX unlocks ONLY on a real purchase (paid plan/seat, active
 *      top-up, or bought credits). Promotional / included-allowance credits do
 *      NOT unlock it. BYOK remains a separate, stricter gate.
 *
 *  (2) EVE routing: buildEveInferenceProvider targets the eve-inference Edge
 *      Function URL with the CEVE license WIRE STRING as the bearer api_key
 *      (NOT a provider key), via the OpenAI-compatible platform so
 *      ClientFactory keeps the egress boundary. The wire value sent is the
 *      level string the backend registry understands.
 *
 * All tokens here are SYNTHETIC — never a real license.
 */

import { describe, expect, it } from 'vitest';

import {
  buildEveInferenceProvider,
  buildEvePickerGroups,
  buildEveInferenceRequestBody,
  commandEveActiveModeLabel,
  EVE_DEFAULT_INFERENCE_SELECTION,
  EVE_INFERENCE_FUNCTION_URL,
  EVE_INFERENCE_DEFAULT_TIER_ID,
  EVE_INFERENCE_GROUP_TITLE,
  EVE_INFERENCE_MAX_TIER_ID,
  EVE_INFERENCE_OFFERED_WIRE_TIERS,
  EVE_INFERENCE_STANDARD_TIER_ID,
  EVE_INFERENCE_TIERS,
  EVE_INFERENCE_SELECTABLE_TIERS,
  EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS,
  hasEveMaxAccess,
  isOfferedWireTier,
  isServerAllowedWireTier,
  eveTierValue,
  filterEvePickerGroups,
  isByokDisabledForEntitlement,
  isModelByokAllowed,
  isEveInferenceSelection,
  isEveTierSelectable,
  hasEvePaidInferenceAccess,
  isTrialingEntitlement,
  localTierValue,
  migrateLegacyEveSelection,
  normalizeLegacyEveTierId,
  repairInferenceSelection,
  parseEveTierIdFromSelection,
  parseLocalTierFromSelection,
  resolveCommandEveActiveLane,
  describeCommandEveActiveLane,
  resolveCommandEveWarmupLane,
  resolveEffectiveInferenceSelection,
  resolveEffectiveWireTierFromSelection,
  resolveEvePickerItemAvailability,
  resolveWireTierFromSelection,
  shouldDisableModelByok,
  type EveConnectedProviderGroup,
  type EvePickerItem,
} from '@/common/config/eveInferenceCore';

/** Synthetic CEVE wire string — NOT a real license. */
const FAKE_WIRE = 'CEVE.v2.FAKE-payload-TESTONLY.FAKE-sig-TESTONLY';

const TRIAL = { trial_ends_at: '2026-07-01T00:00:00.000Z' };
const PAID_NULL = { trial_ends_at: null };
const PAID_ABSENT = {};
/** A seat that actually BOUGHT something — the only thing that unlocks MAX. */
const PURCHASED = { trial_ends_at: null, has_paid_seat: true };
/** A promotional grant: allowance credits only, nothing purchased. */
const PROMOTIONAL_ONLY = {
  trial_ends_at: '2099-01-01T00:00:00.000Z',
  has_metered_credits: true,
  metered_credit_access_known: true,
  has_paid_seat: false,
  has_paid_plan: false,
  has_active_topup: false,
  has_purchased_credits: false,
};

function flat(groups: ReturnType<typeof buildEvePickerGroups>): EvePickerItem[] {
  return groups.flatMap((g) => g.items);
}
function byLabel(items: EvePickerItem[], group: 'local' | 'eve', label: string): EvePickerItem | undefined {
  return items.find((i) => i.group === group && i.label === label);
}

describe('eveInferenceCore — trial detection', () => {
  it('treats a non-null trial_ends_at as trialing', () => {
    expect(isTrialingEntitlement(TRIAL)).toBe(true);
  });

  it('treats null/absent/unknown trial_ends_at as NOT trialing (paid)', () => {
    expect(isTrialingEntitlement(PAID_NULL)).toBe(false);
    expect(isTrialingEntitlement(PAID_ABSENT)).toBe(false);
    expect(isTrialingEntitlement(null)).toBe(false);
    expect(isTrialingEntitlement(undefined)).toBe(false);
  });
});

describe('eveInferenceCore — collapsed offer: exactly Standard + MAX (spec 2.2)', () => {
  it('offers EXACTLY two cloud rungs — Standard and MAX — and no four-rung ladder', () => {
    const groups = buildEvePickerGroups(PURCHASED);
    const eve = groups.find((g) => g.kind === 'eve')!;
    expect(eve.items.map((i) => i.label)).toEqual(['Standard', 'MAX']);
    // The retired middle rungs are gone from the OFFER...
    expect(eve.items.map((i) => i.label)).not.toContain('Hoch');
    expect(eve.items.map((i) => i.label)).not.toContain('Sehr hoch');
    expect(eve.items.map((i) => i.label)).not.toContain('Ultra');
    // ...and no offered row carries a legacy value either.
    expect(eve.items.map((i) => i.value)).toEqual([
      eveTierValue(EVE_INFERENCE_STANDARD_TIER_ID),
      eveTierValue(EVE_INFERENCE_MAX_TIER_ID),
    ]);
  });

  it('keeps every tier id in the REGISTRY — the media contract depends on the wire substrate', () => {
    // Deleting these would break CommandEveManagedVisualTurnTier /
    // bridgePolicy's ['high','xhigh','max','ultra'] validation. Collapse the
    // OFFER, never the substrate.
    const ids = EVE_INFERENCE_TIERS.map((t) => t.id);
    expect(ids).toEqual(['eve-standard', 'eve-high', 'eve-xhigh', 'eve-max', 'eve-ultra']);
    const wires = EVE_INFERENCE_TIERS.map((t) => t.tier);
    expect(wires).toEqual(['standard', 'high', 'xhigh', 'max', 'ultra']);
  });

  it('DERIVES the offer from the server allow-list, so an unofferable rung is impossible by construction', () => {
    // Every offered wire tier must also be server-accepted — not by review, by
    // construction: EVE_INFERENCE_OFFERED_WIRE_TIERS is a FILTER over the
    // allow-list, so a refused rung cannot survive it.
    expect([...EVE_INFERENCE_OFFERED_WIRE_TIERS]).toEqual(['standard', 'max']);
    for (const wire of EVE_INFERENCE_OFFERED_WIRE_TIERS) {
      expect(isServerAllowedWireTier(wire)).toBe(true);
    }
    // The offer is strictly narrower than the allow-list.
    expect(isServerAllowedWireTier('high')).toBe(true);
    expect(isOfferedWireTier('high')).toBe(false);
    expect(isOfferedWireTier('xhigh')).toBe(false);
    expect(isOfferedWireTier('ultra')).toBe(false);
    // And the selectable list is exactly the offered one.
    expect(EVE_INFERENCE_SELECTABLE_TIERS.map((t) => t.tier)).toEqual(['standard', 'max']);
  });

  it('Standard is the free-eligible default; MAX is the paid strong lane', () => {
    const standard = EVE_INFERENCE_TIERS.find((t) => t.id === 'eve-standard')!;
    const max = EVE_INFERENCE_TIERS.find((t) => t.id === 'eve-max')!;
    expect(standard.paidOnly).toBe(false);
    expect(standard.label).toBe('Standard');
    expect(standard.modelLabel).toBe('großer Kontext');
    expect(max.paidOnly).toBe(true);
    expect(max.label).toBe('MAX');
    expect(EVE_INFERENCE_DEFAULT_TIER_ID).toBe('eve-standard');
  });

  it('the MAX row wires its cost badge instead of leaving dead affordance code', () => {
    // The badge used to be emitted only when `gated` was true, and every offered
    // rung is gated:false — so it was dead. Either wire it or delete it.
    const items = flat(buildEvePickerGroups(PURCHASED));
    const max = byLabel(items, 'eve', 'MAX')!;
    expect(max.consumesCredits).toBe(true);
    expect(max.gated).toBe(false);
    expect(max.sublabel).toBe('starkes Agenten-Reasoning');
    expect(max.costBadge).toBe('sehr hohe Kosten');
    // The free rung stays quiet.
    const standard = byLabel(items, 'eve', 'Standard')!;
    expect(standard.consumesCredits).toBe(false);
    expect(standard.costBadge).toBeUndefined();
  });
});

describe('eveInferenceCore — scalable picker presentation', () => {
  it('keeps only matching rows while preserving their group navigation', () => {
    const filtered = filterEvePickerGroups(buildEvePickerGroups(PURCHASED), 'MAX');

    expect(filtered.map((group) => group.kind)).toEqual(['eve']);
    expect(filtered[0].items.map((item) => item.label)).toEqual(['MAX']);
  });

  it('keeps the full group when its heading matches the search', () => {
    const filtered = filterEvePickerGroups(buildEvePickerGroups(PAID_NULL), 'privat');

    expect(filtered).toHaveLength(1);
    expect(filtered[0].items.map((item) => item.label)).toEqual(['Standard', 'Hoch']);
  });

  it('appends connected providers only when an explicit routed group is supplied', () => {
    const connected: EveConnectedProviderGroup = {
      kind: 'connected',
      title: 'OpenRouter (verbunden)',
      items: [
        {
          value: 'test-routed-provider:model',
          group: 'connected',
          label: 'Persönliches Modell',
          disabled: true,
          disabledReasonCode: 'AUTH_REQUIRED',
        },
      ],
    };

    expect(buildEvePickerGroups(PAID_NULL).some((group) => group.kind === 'connected')).toBe(false);
    expect(buildEvePickerGroups(PAID_NULL, [connected]).at(-1)).toEqual(connected);
  });

  it('does not synthesize raw CLI worker backends into the model picker', () => {
    const labels = flat(buildEvePickerGroups(PAID_NULL)).map((item) => item.label);

    expect(labels).not.toContain('Claude Code');
    expect(labels).not.toContain('Codex');
    expect(labels).not.toContain('Gemini CLI');
  });
});

describe('eveInferenceCore — truthful picker availability', () => {
  const groups = buildEvePickerGroups(PAID_NULL);
  const cloud = groups.find((group) => group.kind === 'eve')!.items[0];
  const local = groups.find((group) => group.kind === 'local')!.items[0];
  const localTierId = parseLocalTierFromSelection(local.value)!.localTierId;

  it('blocks cloud tiers while offline before evaluating authentication', () => {
    expect(
      resolveEvePickerItemAvailability(cloud, {
        cloudOnline: false,
        cloudAuthenticated: false,
      })
    ).toEqual({ state: 'unavailable', selectable: false, reasonCode: 'OFFLINE' });
  });

  it('reports missing cloud authentication without changing the selected value', () => {
    expect(
      resolveEvePickerItemAvailability(cloud, {
        cloudOnline: true,
        cloudAuthenticated: false,
      })
    ).toEqual({ state: 'unavailable', selectable: false, reasonCode: 'AUTH_REQUIRED' });
  });

  it('keeps unknown local probes selectable instead of inventing a hardware blocker', () => {
    expect(resolveEvePickerItemAvailability(local, {})).toEqual({ state: 'checking', selectable: true });
  });

  it('blocks a local tier when authoritative hardware truth says it cannot fit', () => {
    expect(
      resolveEvePickerItemAvailability(local, {
        localTiers: {
          [localTierId]: { statusKnown: true, ramFit: false, installed: true, readyForUse: true },
        },
      })
    ).toEqual({ state: 'unavailable', selectable: false, reasonCode: 'HARDWARE_UNSUPPORTED' });
  });

  it('distinguishes a missing local install from a pending integrity verification', () => {
    const notInstalled = resolveEvePickerItemAvailability(local, {
      localTiers: {
        [localTierId]: { statusKnown: true, ramFit: true, installed: false, readyForUse: false },
      },
    });
    const notVerified = resolveEvePickerItemAvailability(local, {
      localTiers: {
        [localTierId]: { statusKnown: true, ramFit: true, installed: true, readyForUse: false },
      },
    });

    expect(notInstalled.reasonCode).toBe('NOT_INSTALLED');
    expect(notVerified.reasonCode).toBe('VERIFICATION_REQUIRED');
  });
});

describe('eveInferenceCore — free-tier greying (requirement 1)', () => {
  it('renders EXACTLY two groups and nothing else', () => {
    const groups = buildEvePickerGroups(TRIAL);
    expect(groups.map((g) => g.kind)).toEqual(['local', 'eve']);
    // Local: Standard + Hoch only (no 31B pro tier). EVE: the two-choice offer.
    expect(groups[0].items.map((i) => i.label)).toEqual(['Standard', 'Hoch']);
    expect(groups[1].items.map((i) => i.label)).toEqual(['Standard', 'MAX']);
  });

  it('greys MAX while trialing; EVE Standard + locals stay selectable', () => {
    const items = flat(buildEvePickerGroups(TRIAL));

    const max = byLabel(items, 'eve', 'MAX')!;
    expect(max.disabled).toBe(true);
    expect(max.disabledReasonCode).toBe('PAID_TIER_REQUIRED');

    // EVE Standard (the free rung) selectable on a trial.
    expect(byLabel(items, 'eve', 'Standard')!.disabled).toBe(false);

    // The entry-level local tiers remain selectable.
    expect(byLabel(items, 'local', 'Standard')!.disabled).toBe(false);
    expect(byLabel(items, 'local', 'Hoch')!.disabled).toBe(false);

    // Local tiers carry their bundled model labels as sublabels.
    expect(byLabel(items, 'local', 'Standard')!.sublabel).toBe('Gemma 4 E4B Uncensored');
    expect(byLabel(items, 'local', 'Hoch')!.sublabel).toBe('Gemma 4 12B Heretic');
  });

  it('MAX needs a PURCHASE, not merely a non-trial entitlement', () => {
    // trial_ends_at null alone is NOT a purchase — the free permanent seat also
    // has it null. MAX is fail-closed on the money gate.
    for (const ent of [PAID_NULL, PAID_ABSENT]) {
      const items = flat(buildEvePickerGroups(ent));
      expect(byLabel(items, 'eve', 'Standard')!.disabled).toBe(false);
      expect(byLabel(items, 'eve', 'MAX')!.disabled).toBe(true);
    }
    const purchased = flat(buildEvePickerGroups(PURCHASED));
    expect(byLabel(purchased, 'eve', 'MAX')!.disabled).toBe(false);
  });

  it('isEveTierSelectable gates paid-only levels on trial, never the free ones', () => {
    expect(isEveTierSelectable({ paidOnly: false }, TRIAL)).toBe(true);
    expect(isEveTierSelectable({ paidOnly: true }, TRIAL)).toBe(false);
    expect(isEveTierSelectable({ paidOnly: true }, PAID_NULL)).toBe(true);
    // ...and MAX routes through the stricter purchase gate instead.
    expect(isEveTierSelectable({ paidOnly: true, tier: 'max' }, PAID_NULL)).toBe(false);
    expect(isEveTierSelectable({ paidOnly: true, tier: 'max' }, PURCHASED)).toBe(true);
  });

  it('keeps bought credits spendable even when a stale trial flag is present', () => {
    const fundedTrial = {
      trial_ends_at: '2099-01-01T00:00:00.000Z',
      has_metered_credits: true,
      metered_credit_access_known: true,
    };
    expect(hasEvePaidInferenceAccess(fundedTrial)).toBe(true);
    expect(isEveTierSelectable({ paidOnly: true }, fundedTrial)).toBe(true);
    expect(isModelByokAllowed(fundedTrial)).toBe(false);
  });

  it('disables BYOK while trialing, enables it when paid', () => {
    expect(isByokDisabledForEntitlement(TRIAL)).toBe(true);
    expect(isByokDisabledForEntitlement(PAID_NULL)).toBe(false);
    expect(isByokDisabledForEntitlement(PAID_ABSENT)).toBe(false);
    expect(isByokDisabledForEntitlement(null)).toBe(false);
  });
});

describe('eveInferenceCore — paid-seat BYOK gate (1.2.18 Req 4)', () => {
  // The paid-seat gate is STRICTER than the trial-only check: it unlocks ONLY on
  // the explicit, main-process-derived has_paid_seat flag (entitled && non-trial).
  const PAID_SEAT = { trial_ends_at: null, has_paid_seat: true } as const;

  it('unlocks add-own-model/API-key ONLY for an explicit paid seat', () => {
    expect(isModelByokAllowed(PAID_SEAT)).toBe(true);
  });

  it('stays locked for trial, free (no flag), absent, and null/undefined', () => {
    // Trial: never paid, even if a stale flag were present (both conditions required).
    expect(isModelByokAllowed({ trial_ends_at: '2026-07-01T00:00:00.000Z', has_paid_seat: true })).toBe(false);
    expect(isModelByokAllowed(TRIAL)).toBe(false);
    // Non-trial but WITHOUT the explicit paid flag ⇒ free ⇒ locked (the new
    // behavior vs the trial-only check, which would have wrongly unlocked these).
    expect(isModelByokAllowed(PAID_NULL)).toBe(false);
    expect(isModelByokAllowed(PAID_ABSENT)).toBe(false);
    expect(isModelByokAllowed(null)).toBe(false);
    expect(isModelByokAllowed(undefined)).toBe(false);
  });
});

describe('eveInferenceCore — Pro-feature unlock via active credit subscription (M7)', () => {
  it('unlocks BYOK on an active credit subscription WITHOUT a paid seat', () => {
    // The second unlock path: no client seat, but an active recurring top-up.
    expect(isModelByokAllowed({ trial_ends_at: null, has_paid_seat: false, has_active_topup: true })).toBe(true);
    // has_paid_seat absent entirely, subscription active ⇒ unlocked.
    expect(isModelByokAllowed({ trial_ends_at: null, has_active_topup: true })).toBe(true);
  });

  it('still unlocks on a paid seat alone (OR semantics; topup absent ⇒ false ⇒ today)', () => {
    expect(isModelByokAllowed({ trial_ends_at: null, has_paid_seat: true })).toBe(true);
    expect(isModelByokAllowed({ trial_ends_at: null, has_paid_seat: true, has_active_topup: false })).toBe(true);
  });

  it('a trial NEVER unlocks, even with an active subscription (trial gate is absolute)', () => {
    expect(isModelByokAllowed({ trial_ends_at: '2026-07-01T00:00:00.000Z', has_active_topup: true })).toBe(false);
  });

  it('an absent has_active_topup falls back to today: no seat + no subscription ⇒ locked', () => {
    // Version-skew: an old credits-status without the field ⇒ absent ⇒ false ⇒ locked.
    expect(isModelByokAllowed({ trial_ends_at: null, has_paid_seat: false })).toBe(false);
    expect(isModelByokAllowed({ trial_ends_at: null })).toBe(false);
  });
});

describe('eveInferenceCore — transient credits status is not a free-tier verdict', () => {
  it('keeps BYOK available when top-up truth is temporarily unavailable', () => {
    expect(
      shouldDisableModelByok({ trial_ends_at: null, has_paid_seat: false, has_active_topup: undefined }, false)
    ).toBe(false);
  });

  it('locks only after an authoritative no-seat/no-top-up response', () => {
    expect(shouldDisableModelByok({ trial_ends_at: null, has_paid_seat: false, has_active_topup: false }, true)).toBe(
      true
    );
  });

  it('keeps confirmed paid paths unlocked and confirmed trials locked', () => {
    expect(shouldDisableModelByok({ trial_ends_at: null, has_paid_seat: true }, false)).toBe(false);
    expect(shouldDisableModelByok({ trial_ends_at: null, has_active_topup: true }, true)).toBe(false);
    expect(shouldDisableModelByok({ trial_ends_at: '2099-01-01T00:00:00.000Z', has_active_topup: true }, false)).toBe(
      true
    );
  });
});

describe('eveInferenceCore — honest CLOUD labeling (audit #1)', () => {
  it('the EVE group heading carries an explicit "(Cloud)" marker', () => {
    const groups = buildEvePickerGroups(TRIAL);
    const eveGroup = groups.find((g) => g.kind === 'eve')!;
    expect(eveGroup.title).toBe(EVE_INFERENCE_GROUP_TITLE);
    expect(eveGroup.title).toContain('(Cloud)');
    // The local group stays the private/local one (no Cloud marker).
    expect(groups.find((g) => g.kind === 'local')!.title).not.toContain('Cloud');
  });

  it('each EVE level exposes a capability sublabel without leaking the concrete cloud model', () => {
    const items = flat(buildEvePickerGroups(TRIAL));
    expect(byLabel(items, 'eve', 'Standard')!.sublabel).toBe('großer Kontext');
    expect(byLabel(items, 'eve', 'MAX')!.sublabel).toBe('starkes Agenten-Reasoning');
  });

  it('MAX is the ONLY user-visible name for the strong lane — no vendor slug anywhere', () => {
    // A vendor/model id in this registry is always a `vendor/model` slug, so a
    // slash in ANY user-facing string is the tell. Asserting the exact label set
    // as well makes this exhaustive rather than a blacklist someone can outgrow.
    const items = flat(buildEvePickerGroups(PURCHASED));
    const eve = items.filter((i) => i.group === 'eve');
    expect(eve.map((i) => i.label)).toEqual(['Standard', 'MAX']);
    for (const item of eve) {
      for (const text of [item.label, item.sublabel ?? '', item.costBadge ?? '']) {
        expect(text).not.toContain('/');
      }
    }
  });

  it('cloud heading marks EVE as Cloud; rows show CAPABILITY, never a concrete model name', () => {
    const groups = buildEvePickerGroups(TRIAL);
    const eveGroup = groups.find((g) => g.kind === 'eve')!;
    expect(eveGroup.title.toLowerCase()).toContain('cloud');
    // Founder mandate: NO concrete model name anywhere user-facing — not the cloud
    // vendors (DeepSeek/GLM) and not the local one (Gemma). The lane is still
    // unmistakably "Cloud" via the heading; the rows describe capability only.
    const eveSubs = eveGroup.items.map((i) => i.sublabel ?? '');
    expect(eveSubs.every((s) => !/gemma|deepseek|glm|kimi|moonshot|openrouter/i.test(s))).toBe(true);
    // The local group is unmistakably NOT cloud (heading). Offline/local models ARE
    // named (founder 2026-06-28: they run on the user's own device) — only the cloud
    // lane stays model-abstract.
    const localGroup = groups.find((g) => g.kind === 'local')!;
    expect(localGroup.title.toLowerCase()).not.toContain('cloud');
    expect(localGroup.items.some((i) => /gemma/i.test(i.sublabel ?? ''))).toBe(true);
    // ...but a CLOUD vendor/model must never appear, even in the local rows.
    expect(localGroup.items.map((i) => i.sublabel ?? '').every((s) => !/deepseek|glm|kimi|moonshot/i.test(s))).toBe(
      true
    );
  });
});

describe('commandEveActiveModeLabel — honest lane self-description (cloud abstract, local named)', () => {
  const NO_MODEL = /gemma|deepseek|glm|kimi|moonshot|ollama|openrouter/i;
  // Cloud models/providers must NEVER appear anywhere; the on-device (gemma) model MAY (local only).
  const NO_CLOUD_MODEL = /deepseek|glm|kimi|moonshot|openrouter/i;

  it('NAMES the on-device model for the LOCAL lane (founder: offline models are named)', () => {
    const de = commandEveActiveModeLabel(localTierValue('local-standard'), 'de-DE');
    const en = commandEveActiveModeLabel(localTierValue('local-high'), 'en-US');
    expect(de).toMatch(/lokal/i);
    expect(en).toMatch(/local/i);
    // The local model IS named (runs openly on the user's own device)...
    expect(de).toMatch(/gemma/i);
    expect(en).toMatch(/gemma/i);
    // ...but a CLOUD model/provider must never leak.
    expect(de).not.toMatch(NO_CLOUD_MODEL);
    expect(en).not.toMatch(NO_CLOUD_MODEL);
  });

  it('describes a CLOUD lane WITHOUT tier vocabulary — this string is EVE s system prompt', () => {
    // The ladder must not come back through the assistant's own mouth. No
    // "Stufe"/"level"/"tier", no rung names, and no unverifiable capability
    // claim about context size (the server owns the model and its window).
    const LADDER = /Stufe|level|tier|Standard|Sehr hoch|Maximum|Ultra|Kontext|context/i;
    const deMax = commandEveActiveModeLabel(eveTierValue('eve-max'), 'de-DE');
    const enMax = commandEveActiveModeLabel(eveTierValue('eve-max'), 'en-US');
    const deRoutine = commandEveActiveModeLabel(eveTierValue('eve-standard'), 'de-DE');
    const enRoutine = commandEveActiveModeLabel(eveTierValue('eve-standard'), 'en-US');

    expect(deMax).toBe('EVE-Cloud, MAX aktiv');
    expect(enMax).toBe('EVE Cloud, MAX on');
    // The routine lane is UNNAMED — it says only that it is the cloud lane.
    expect(deRoutine).toBe('EVE-Cloud');
    expect(enRoutine).toBe('EVE Cloud');

    for (const value of [deMax, enMax, deRoutine, enRoutine]) {
      expect(value).not.toMatch(NO_MODEL);
      expect(value).not.toMatch(LADDER);
      expect(value).not.toContain('/');
    }
  });

  it('a legacy rung self-describes as the lane it will ACTUALLY run on', () => {
    expect(commandEveActiveModeLabel(eveTierValue('eve-ultra'), 'de-DE')).toBe('EVE-Cloud, MAX aktiv');
    expect(commandEveActiveModeLabel(eveTierValue('eve-xhigh'), 'en-US')).toBe('EVE Cloud, MAX on');
    // eve-high migrates DOWN, so it must not claim MAX.
    expect(commandEveActiveModeLabel(eveTierValue('eve-high'), 'de-DE')).toBe('EVE-Cloud');
  });

  it('falls back to "nicht verifiziert" / "not verified" for an unknown/absent selection', () => {
    expect(commandEveActiveModeLabel(undefined, 'de-DE')).toBe('nicht verifiziert');
    expect(commandEveActiveModeLabel('something-else', 'en-US')).toBe('not verified');
  });
});

describe('eveInferenceCore — EVE Standard routing (requirement 2)', () => {
  it('targets the eve-inference Edge Function URL with the license wire as bearer', () => {
    const provider = buildEveInferenceProvider({ tierId: 'eve-standard', licenseWire: FAKE_WIRE });
    // Routes through the OpenAI-compatible client path (ClientFactory egress).
    expect(provider.platform).toBe('openai');
    expect(provider.base_url).toBe(EVE_INFERENCE_FUNCTION_URL);
    expect(provider.base_url).toBe('https://unvbeothoimlzlolxucl.supabase.co/functions/v1/eve-inference');
    // The license wire IS the bearer (OpenAI SDK sends api_key as Bearer).
    expect(provider.api_key).toBe(FAKE_WIRE);
    // Standard tier maps to the 'standard' wire tier (sent as the model).
    expect(provider.use_model).toBe('standard');
  });

  it('maps every level to the wire string the backend registry understands', () => {
    // Each level sends its registry level name; the backend resolves the model.
    expect(buildEveInferenceProvider({ tierId: 'eve-max', licenseWire: FAKE_WIRE }).use_model).toBe('max');
    // Defence in depth: a caller still holding a no-longer-offered id — a stale
    // route, a cached value — cannot build a provider on a rung the picker no
    // longer names. It is migrated to the same place persistence migrates it.
    expect(buildEveInferenceProvider({ tierId: 'eve-high', licenseWire: FAKE_WIRE }).use_model).toBe('standard');
    expect(buildEveInferenceProvider({ tierId: 'eve-xhigh', licenseWire: FAKE_WIRE }).use_model).toBe('max');
    expect(buildEveInferenceProvider({ tierId: 'eve-ultra', licenseWire: FAKE_WIRE }).use_model).toBe('max');
  });

  it('the registry keeps five ids for migration + the media contract; only four are server-accepted', () => {
    const wires = EVE_INFERENCE_TIERS.map((t) => t.tier);
    expect(wires).toEqual(['standard', 'high', 'xhigh', 'max', 'ultra']);
    // The desktop never sends a provider slug on the wire — only the level; the
    // backend resolves the model. A slug always carries a '/'.
    for (const w of wires) {
      expect(w).not.toContain('/');
    }
  });

  it('THROWS (fail-loud) when the license wire is empty — never an empty bearer', () => {
    expect(() => buildEveInferenceProvider({ tierId: 'eve-standard', licenseWire: '' })).toThrow();
    expect(() => buildEveInferenceProvider({ tierId: 'eve-standard', licenseWire: '   ' })).toThrow();
  });

  it('THROWS on an unknown tier id', () => {
    // @ts-expect-error — exercising the runtime guard with a bad tier id.
    expect(() => buildEveInferenceProvider({ tierId: 'eve-bogus', licenseWire: FAKE_WIRE })).toThrow();
  });

  it('builds an OpenAI-compatible body { messages, stream, tier }', () => {
    const body = buildEveInferenceRequestBody({
      tier: 'standard',
      messages: [{ role: 'user', content: 'hallo' }],
      stream: true,
    });
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'hallo' }],
      stream: true,
      tier: 'standard',
    });
  });

  it('omits agent_id entirely when not delegated (un-delegated body keeps its prior shape)', () => {
    const body = buildEveInferenceRequestBody({
      tier: 'standard',
      messages: [{ role: 'user', content: 'hallo' }],
    });
    // No agent_id key at all — the backend defaults it to the system `eve`.
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'hallo' }],
      stream: false,
      tier: 'standard',
    });
    expect('agent_id' in body).toBe(false);
  });

  it('carries a delegated agent_id (Dein Team ledger attribution) when provided', () => {
    const body = buildEveInferenceRequestBody({
      tier: 'max',
      messages: [{ role: 'user', content: 'kampagne' }],
      stream: true,
      agent_id: 'growth-lead',
    });
    expect(body).toEqual({
      messages: [{ role: 'user', content: 'kampagne' }],
      stream: true,
      tier: 'max',
      agent_id: 'growth-lead',
    });
  });
});

describe('eveInferenceCore — selection parsing', () => {
  it('round-trips an EVE selection value', () => {
    const value = eveTierValue('eve-standard');
    expect(isEveInferenceSelection(value)).toBe(true);
    expect(parseEveTierIdFromSelection(value)).toBe('eve-standard');
  });

  it('does not treat a local selection as an EVE selection', () => {
    expect(isEveInferenceSelection('command-eve-local:local-standard')).toBe(false);
    expect(parseEveTierIdFromSelection('command-eve-local:local-standard')).toBeUndefined();
  });

  it('default EVE tier is Standard', () => {
    expect(EVE_INFERENCE_DEFAULT_TIER_ID).toBe('eve-standard');
  });
});

describe('eveInferenceCore — default-flip to EVE Standard (cloud)', () => {
  it('the default selection is EVE Standard, not a local tier', () => {
    expect(EVE_DEFAULT_INFERENCE_SELECTION).toBe(eveTierValue('eve-standard'));
    expect(isEveInferenceSelection(EVE_DEFAULT_INFERENCE_SELECTION)).toBe(true);
  });

  it('an absent/empty persisted selection resolves to EVE Standard', () => {
    expect(resolveEffectiveInferenceSelection(undefined)).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(resolveEffectiveInferenceSelection(null)).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(resolveEffectiveInferenceSelection('')).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    expect(resolveEffectiveInferenceSelection('   ')).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    // The default must route to the cloud lane.
    expect(isEveInferenceSelection(resolveEffectiveInferenceSelection(undefined))).toBe(true);
  });

  it('a present selection is returned verbatim (local stays opt-in, not overridden)', () => {
    const local = localTierValue('local-high');
    expect(resolveEffectiveInferenceSelection(local)).toBe(local);
    expect(isEveInferenceSelection(resolveEffectiveInferenceSelection(local))).toBe(false);
    const eveHigh = eveTierValue('eve-high');
    expect(resolveEffectiveInferenceSelection(eveHigh)).toBe(eveHigh);
  });
});

describe('eveInferenceCore — startup warm-up lane selection', () => {
  it('warms the EVE cloud lane (with wire tier) for an EVE selection', () => {
    expect(resolveCommandEveWarmupLane(eveTierValue('eve-standard'))).toEqual({ lane: 'eve', tier: 'standard' });
    expect(resolveCommandEveWarmupLane(eveTierValue('eve-max'))).toEqual({ lane: 'eve', tier: 'max' });
    // A persisted legacy rung warms the lane it will MIGRATE onto, not the one
    // it used to name — otherwise the warm-up preflights a tier that never runs.
    expect(resolveCommandEveWarmupLane(eveTierValue('eve-high'))).toEqual({ lane: 'eve', tier: 'standard' });
    expect(resolveCommandEveWarmupLane(eveTierValue('eve-xhigh'))).toEqual({ lane: 'eve', tier: 'max' });
    expect(resolveCommandEveWarmupLane(eveTierValue('eve-ultra'))).toEqual({ lane: 'eve', tier: 'max' });
  });

  it('warms the EVE cloud lane for the DEFAULT (absent/empty) selection — never the inactive local model', () => {
    // The default flipped to EVE Standard, so a fresh user warms the cloud lane.
    expect(resolveCommandEveWarmupLane(undefined)).toEqual({ lane: 'eve', tier: 'standard' });
    expect(resolveCommandEveWarmupLane(null)).toEqual({ lane: 'eve', tier: 'standard' });
    expect(resolveCommandEveWarmupLane('')).toEqual({ lane: 'eve', tier: 'standard' });
    expect(resolveCommandEveWarmupLane('   ')).toEqual({ lane: 'eve', tier: 'standard' });
  });

  it('warms the LOCAL lane only for an explicit local selection', () => {
    expect(resolveCommandEveWarmupLane(localTierValue('local-high'))).toEqual({ lane: 'local' });
    expect(resolveCommandEveWarmupLane(localTierValue('local-standard'))).toEqual({ lane: 'local' });
  });
});

describe('eveInferenceCore — HONEST tier routing (resolveWireTierFromSelection, 1.2.19)', () => {
  // This is the EXACT contract the desktop money-path repair rests on: the wire
  // tier POSTed to eve-inference is the user's ACTUAL picker selection, mapped
  // VERBATIM to the registry value — so EVE Maximum/Ultra and EVE High
  // meters DeepSeek V4 Pro, never the cheapest Flash. (Root cause closed:
  // OpenRouter logs showed 100% Flash because the selection→wire-tier mapping
  // was an unasserted inline expression that fell back to 'standard'.)

  it('carries the wire tier VERBATIM for BOTH offered rungs (the silent-Flash-downgrade guard)', () => {
    // RISK 1, and it already happened once: an absent/empty tier defaults to
    // `standard` server-side, so a mapping that quietly produced Standard was
    // invisible in the logs (100% Flash, nothing else ever called). Verbatim for
    // every OFFERED rung is the pin that makes that impossible again.
    for (const tier of EVE_INFERENCE_SELECTABLE_TIERS) {
      expect(resolveWireTierFromSelection(eveTierValue(tier.id))).toBe(tier.tier);
    }
    expect(resolveWireTierFromSelection(eveTierValue('eve-standard'))).toBe('standard');
    expect(resolveWireTierFromSelection(eveTierValue('eve-max'))).toBe('max');
  });

  it('MIGRATION ROW: eve-high → standard (a cheap-rung user is not silently metered harder)', () => {
    expect(normalizeLegacyEveTierId('eve-high')).toBe('eve-standard');
    expect(parseEveTierIdFromSelection(eveTierValue('eve-high'))).toBe('eve-standard');
    expect(resolveWireTierFromSelection(eveTierValue('eve-high'))).toBe('standard');
    expect(migrateLegacyEveSelection(eveTierValue('eve-high'))).toBe(eveTierValue('eve-standard'));
  });

  it('MIGRATION ROW: eve-xhigh → MAX (that user was reaching for the deep-reasoning lane)', () => {
    expect(normalizeLegacyEveTierId('eve-xhigh')).toBe('eve-max');
    expect(parseEveTierIdFromSelection(eveTierValue('eve-xhigh'))).toBe('eve-max');
    expect(resolveWireTierFromSelection(eveTierValue('eve-xhigh'))).toBe('max');
    expect(migrateLegacyEveSelection(eveTierValue('eve-xhigh'))).toBe(eveTierValue('eve-max'));
  });

  it('MIGRATION ROW: eve-ultra → MAX (the server refuses `ultra`; anything else costs every turn)', () => {
    expect(normalizeLegacyEveTierId('eve-ultra')).toBe('eve-max');
    expect(parseEveTierIdFromSelection(eveTierValue('eve-ultra'))).toBe('eve-max');
    expect(resolveWireTierFromSelection(eveTierValue('eve-ultra'))).toBe('max');
    expect(migrateLegacyEveSelection(eveTierValue('eve-ultra'))).toBe(eveTierValue('eve-max'));
  });

  it('MIGRATION ROW: eve-standard → Standard and eve-max → MAX write nothing back', () => {
    // `undefined` means "already current", which is what lets the caller write
    // back ONLY on an actual change instead of looping through its own write.
    expect(migrateLegacyEveSelection(eveTierValue('eve-standard'))).toBeUndefined();
    expect(migrateLegacyEveSelection(eveTierValue('eve-max'))).toBeUndefined();
  });

  it('MIGRATION ROW: a LOCAL selection is never touched (local stays a separate offer)', () => {
    expect(migrateLegacyEveSelection(localTierValue('local-standard'))).toBeUndefined();
    expect(migrateLegacyEveSelection(localTierValue('local-high'))).toBeUndefined();
    expect(migrateLegacyEveSelection('command-eve-local:future-local')).toBeUndefined();
  });

  it('MIGRATION ROW: unknown / empty → Standard (never a selection nobody can act on)', () => {
    expect(migrateLegacyEveSelection('command-eve-inference:eve-bogus')).toBe(eveTierValue('eve-standard'));
    expect(migrateLegacyEveSelection('command-eve-inference:eve-maximum')).toBe(eveTierValue('eve-standard'));
    expect(migrateLegacyEveSelection('command-eve-inference:')).toBe(eveTierValue('eve-standard'));
    // Empty/absent are handled by resolveEffectiveInferenceSelection, which also
    // lands on Standard — so every row of the table ends somewhere sendable.
    expect(migrateLegacyEveSelection(undefined)).toBeUndefined();
    expect(resolveEffectiveInferenceSelection(undefined)).toBe(eveTierValue('eve-standard'));
    expect(resolveEffectiveInferenceSelection('')).toBe(eveTierValue('eve-standard'));
  });

  it('never puts a tier on the wire that the server refuses, and only ever an OFFERED one', () => {
    for (const tier of EVE_INFERENCE_TIERS) {
      const wire = resolveWireTierFromSelection(eveTierValue(tier.id));
      if (wire === undefined) continue;
      expect(EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS).toContain(wire);
      expect(isOfferedWireTier(wire)).toBe(true);
    }
  });

  it('the selection ITSELF becomes the migrated tier, so the visible label cannot disagree', () => {
    // Normalising at parse level rather than only outbound: the picker must not
    // read one rung while another is sent. Same thing everywhere or nowhere.
    expect(parseEveTierIdFromSelection(eveTierValue('eve-ultra'))).toBe('eve-max');
    expect(parseEveTierIdFromSelection(eveTierValue('eve-high'))).toBe('eve-standard');
  });

  it('models an in-session switch: re-resolving the new selection changes the wire tier', () => {
    // The picker persists a NEW selection on an in-session switch; the send path
    // re-resolves the CURRENT selection per request.
    let current = eveTierValue('eve-standard');
    expect(resolveWireTierFromSelection(current)).toBe('standard');

    current = eveTierValue('eve-max'); // user engages MAX mid-session
    expect(resolveWireTierFromSelection(current)).toBe('max');

    current = eveTierValue('eve-ultra'); // a legacy selection still on disk
    expect(resolveWireTierFromSelection(current)).toBe('max');

    current = eveTierValue('eve-standard'); // user switches back down
    expect(resolveWireTierFromSelection(current)).toBe('standard');
  });

  it('returns undefined for a LOCAL selection (so the cloud lane is never engaged)', () => {
    expect(resolveWireTierFromSelection(localTierValue('local-standard'))).toBeUndefined();
    expect(resolveWireTierFromSelection(localTierValue('local-high'))).toBeUndefined();
  });

  it('returns undefined for an absent/empty/unknown selection (caller fails loud, never silently meters the cheapest lane)', () => {
    expect(resolveWireTierFromSelection(undefined)).toBeUndefined();
    expect(resolveWireTierFromSelection(null)).toBeUndefined();
    expect(resolveWireTierFromSelection('')).toBeUndefined();
    // An unknown EVE tier id resolves to no tier (not a silent 'standard').
    expect(resolveWireTierFromSelection('command-eve-inference:eve-maximum')).toBeUndefined();
    expect(resolveWireTierFromSelection('command-eve-inference:eve-bogus')).toBeUndefined();
  });

  it('a tier the server refuses can never become a metered call', () => {
    // The no-debit invariant, at the only layer this module can actually prove
    // it: a wire tier is the input to the metered request, so if a refused tier
    // can never BE a wire tier, it can never start one — and a request that is
    // never started cannot take credits. A retired rung reaching the wire would
    // 403 on every turn, which is why it must be stopped here rather than there.
    for (const wire of ['ultra', 'gigantic', '', 'MAX'] as const) {
      expect(isServerAllowedWireTier(wire)).toBe(false);
    }
    for (const wire of EVE_INFERENCE_SERVER_ALLOWED_WIRE_TIERS) {
      expect(isServerAllowedWireTier(wire)).toBe(true);
    }
    // And the one legacy value resolves to something billable and allowed,
    // rather than to nothing at all — a migrated seat keeps working.
    expect(resolveWireTierFromSelection(eveTierValue('eve-ultra'))).toBe('max');
  });
});

describe('eveInferenceCore — MAX money gate (spec 2.6 / server 1.4 mirror)', () => {
  it('unlocks MAX on a paid seat, a paid plan, an active top-up, or PURCHASED credits', () => {
    expect(hasEveMaxAccess({ trial_ends_at: null, has_paid_seat: true })).toBe(true);
    expect(hasEveMaxAccess({ trial_ends_at: null, has_paid_plan: true })).toBe(true);
    expect(hasEveMaxAccess({ trial_ends_at: null, has_active_topup: true })).toBe(true);
    expect(hasEveMaxAccess({ trial_ends_at: null, has_purchased_credits: true })).toBe(true);
  });

  it('LOCKS MAX on promotional/allowance-only credits — a promotion is not a purchase', () => {
    // THE test. `has_metered_credits` is true (allowance credits fund the cheap
    // lane), yet nothing was bought — so MAX must stay locked and the row must
    // carry the upsell reason, not an auth error.
    expect(hasEvePaidInferenceAccess(PROMOTIONAL_ONLY)).toBe(true);
    expect(hasEveMaxAccess(PROMOTIONAL_ONLY)).toBe(false);

    const items = flat(buildEvePickerGroups(PROMOTIONAL_ONLY));
    const max = byLabel(items, 'eve', 'MAX')!;
    expect(max.disabled).toBe(true);
    expect(max.disabledReasonCode).toBe('PAID_TIER_REQUIRED');
    // ...and the promotional seat can still use the entry rung it was granted.
    expect(byLabel(items, 'eve', 'Standard')!.disabled).toBe(false);
  });

  it('a purchased-credit seat unlocks MAX even while a stale trial flag lingers', () => {
    const boughtCreditsOnTrialMarker = {
      trial_ends_at: '2099-01-01T00:00:00.000Z',
      has_purchased_credits: true,
      metered_credit_access_known: true,
    };
    expect(hasEveMaxAccess(boughtCreditsOnTrialMarker)).toBe(true);
    expect(byLabel(flat(buildEvePickerGroups(boughtCreditsOnTrialMarker)), 'eve', 'MAX')!.disabled).toBe(false);
  });

  it('fails CLOSED: absent/null/unknown entitlement locks MAX', () => {
    expect(hasEveMaxAccess(null)).toBe(false);
    expect(hasEveMaxAccess(undefined)).toBe(false);
    expect(hasEveMaxAccess({})).toBe(false);
    expect(hasEveMaxAccess(TRIAL)).toBe(false);
    expect(hasEveMaxAccess(PAID_NULL)).toBe(false);
  });
});

describe('eveInferenceCore — repairInferenceSelection (survivability at the WIRE)', () => {
  it('repairs a corrupt EVE-prefixed value to the default and flags the rewrite', () => {
    for (const corrupt of ['command-eve-inference:eve-bogus', 'command-eve-inference:eve-maximum']) {
      const repair = repairInferenceSelection(corrupt);
      expect(repair.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
      expect(repair.repaired).toBe(true);
      // The repaired value must actually resolve to a sendable tier — "not
      // undefined" is not enough, the shim refuses anything outside the
      // server allow-list.
      expect(resolveWireTierFromSelection(repair.selection)).toBe('standard');
    }
  });

  it('repairs a corrupt NON-prefixed value instead of stranding the seat on the local lane', () => {
    // isEveInferenceSelection() is false for these, so before the repair they
    // silently pinned the seat to local FOREVER with no path back.
    for (const corrupt of ['totally-corrupt', 'openrouter:something', '???']) {
      const repair = repairInferenceSelection(corrupt);
      expect(repair.selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
      expect(repair.repaired).toBe(true);
    }
  });

  it('migrates a legacy rung and reports it as a rewrite', () => {
    expect(repairInferenceSelection(eveTierValue('eve-ultra'))).toEqual({
      selection: eveTierValue('eve-max'),
      repaired: true,
    });
    expect(repairInferenceSelection(eveTierValue('eve-high'))).toEqual({
      selection: eveTierValue('eve-standard'),
      repaired: true,
    });
  });

  it('leaves an OFFERED rung and a KNOWN local tier completely alone', () => {
    for (const value of [
      eveTierValue('eve-standard'),
      eveTierValue('eve-max'),
      localTierValue('local-standard'),
      localTierValue('local-high'),
    ]) {
      expect(repairInferenceSelection(value)).toEqual({ selection: value, repaired: false });
    }
  });

  it('does NOT convert an unknown LOCAL id into a metered cloud turn', () => {
    // The local picker list can legitimately grow, and the local lane never
    // egresses — silently re-laning it to cloud would start charging a seat that
    // deliberately chose privacy.
    const future = 'command-eve-local:future-local';
    expect(repairInferenceSelection(future)).toEqual({ selection: future, repaired: false });
  });

  it('an absent/empty value resolves to the default without being reported as a repair', () => {
    for (const empty of [undefined, null, '', '   ']) {
      expect(repairInferenceSelection(empty).selection).toBe(EVE_DEFAULT_INFERENCE_SELECTION);
    }
  });
});

describe('eveInferenceCore — the non-brick clamp (spec 2.3)', () => {
  it('clamps a MAX selection to `standard` when the seat is PROVEN unentitled — the chat still sends', () => {
    const max = eveTierValue('eve-max');
    expect(resolveWireTierFromSelection(max)).toBe('max');
    expect(resolveEffectiveWireTierFromSelection(max, { maxEntitled: false })).toBe('standard');
    // Sendable, not undefined: an unfunded seat must never be unable to send.
    expect(resolveEffectiveWireTierFromSelection(max, { maxEntitled: false })).not.toBeUndefined();
  });

  it('does NOT clamp when entitlement is unknown — guessing would re-open the silent-downgrade bug', () => {
    const max = eveTierValue('eve-max');
    expect(resolveEffectiveWireTierFromSelection(max, {})).toBe('max');
    expect(resolveEffectiveWireTierFromSelection(max, { maxEntitled: undefined })).toBe('max');
    expect(resolveEffectiveWireTierFromSelection(max)).toBe('max');
  });

  it('lets MAX travel for an entitled seat, and never clamps the Standard floor', () => {
    expect(resolveEffectiveWireTierFromSelection(eveTierValue('eve-max'), { maxEntitled: true })).toBe('max');
    for (const entitled of [true, false, undefined]) {
      expect(resolveEffectiveWireTierFromSelection(eveTierValue('eve-standard'), { maxEntitled: entitled })).toBe(
        'standard'
      );
    }
  });

  it('a persisted legacy rung is clamped AFTER migration, not instead of it', () => {
    // eve-ultra migrates to MAX first; only then does the clamp apply. Asserting
    // both together is what proves the order — a clamp that ran first would make
    // every legacy seat look like Standard forever.
    expect(resolveEffectiveWireTierFromSelection(eveTierValue('eve-ultra'), { maxEntitled: true })).toBe('max');
    expect(resolveEffectiveWireTierFromSelection(eveTierValue('eve-ultra'), { maxEntitled: false })).toBe('standard');
  });

  it('a LOCAL selection stays undefined under every clamp state (the cloud lane is never engaged)', () => {
    for (const entitled of [true, false, undefined]) {
      expect(
        resolveEffectiveWireTierFromSelection(localTierValue('local-standard'), { maxEntitled: entitled })
      ).toBeUndefined();
      expect(
        resolveEffectiveWireTierFromSelection(localTierValue('local-high'), { maxEntitled: entitled })
      ).toBeUndefined();
    }
  });
});

describe('eveInferenceCore — honest active-lane self-description (Task #50 port)', () => {
  const SHIM = 'command-eve-gemma4-e4b-64k';

  it('resolves an EVE cloud selection to its tier (shim-free)', () => {
    expect(resolveCommandEveActiveLane(eveTierValue('eve-max'))).toEqual({
      kind: 'eve',
      tierId: 'eve-max',
      tierLabel: 'MAX',
      wireTier: 'max',
    });
  });

  it('resolves a local selection to the real local model label', () => {
    expect(resolveCommandEveActiveLane(localTierValue('local-standard'))).toEqual({
      kind: 'local',
      tierId: 'local-standard',
      modelLabel: 'Gemma 4 E4B Uncensored',
    });
  });

  it('an absent selection resolves to the EVE Standard cloud lane (router default), never local', () => {
    expect(resolveCommandEveActiveLane(undefined).kind).toBe('eve');
    expect(resolveCommandEveActiveLane('').kind).toBe('eve');
  });

  it('describes EVE Cloud MAX by its STUFE, never the shim model (DE + EN)', () => {
    const de = describeCommandEveActiveLane(eveTierValue('eve-max'), 'de-DE');
    expect(de).toBe('EVE Cloud, MAX-Stufe (maximales Reasoning, starke Agentenarbeit)');
    expect(de).not.toContain(SHIM);
    expect(de.toLowerCase()).not.toContain('ollama');
    expect(de.toLowerCase()).not.toContain('lokal');

    const en = describeCommandEveActiveLane(eveTierValue('eve-max'), 'en-US');
    expect(en).toBe('EVE Cloud, MAX tier (maximum reasoning, strong agent work)');
    expect(en).not.toContain(SHIM);
    expect(en.toLowerCase()).not.toContain('local');
  });

  it('describes a persisted legacy selection as the lane it will ACTUALLY get', () => {
    // Describing the lane the user WILL be served — rather than the one they once
    // picked — is the whole point of migrating at parse level instead of only on
    // the wire. Anything else is a sentence that lies about the next turn.
    for (const legacy of ['eve-ultra', 'eve-xhigh'] as const) {
      expect(describeCommandEveActiveLane(eveTierValue(legacy), 'de-DE')).toBe(
        'EVE Cloud, MAX-Stufe (maximales Reasoning, starke Agentenarbeit)'
      );
      expect(describeCommandEveActiveLane(eveTierValue(legacy), 'en-US')).toBe(
        'EVE Cloud, MAX tier (maximum reasoning, strong agent work)'
      );
    }
    expect(describeCommandEveActiveLane(eveTierValue('eve-high'), 'de-DE')).toContain('Standard-Stufe');
    // No provider slug in any of it.
    expect(describeCommandEveActiveLane(eveTierValue('eve-ultra'), 'de-DE')).not.toContain('/');
  });

  it('describes a local lane by its honest model name', () => {
    expect(describeCommandEveActiveLane(localTierValue('local-standard'), 'de-DE')).toBe(
      'Lokal · Gemma 4 E4B Uncensored (privat, läuft auf deinem Mac)'
    );
    expect(describeCommandEveActiveLane(localTierValue('local-high'), 'en-US')).toBe(
      'Local · Gemma 4 12B Heretic (private, runs on your Mac)'
    );
  });

  it('NEVER surfaces the shim model id on ANY EVE cloud tier', () => {
    for (const tier of ['eve-standard', 'eve-high', 'eve-xhigh', 'eve-max', 'eve-ultra'] as const) {
      for (const locale of ['de-DE', 'en-US'] as const) {
        const desc = describeCommandEveActiveLane(eveTierValue(tier), locale);
        expect(desc).not.toContain(SHIM);
        expect(desc.toLowerCase()).not.toContain('ollama');
        expect(desc).toContain('EVE Cloud');
      }
    }
  });
});
