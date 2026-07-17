/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EVE Inference picker core — the STUFEN (level) model + the two required
 * behaviors:
 *
 *  (0) STUFEN shape: EVE exposes FIVE levels — Standard, Hoch, Sehr hoch,
 *      Maximum and Ultra. Standard is free-eligible; the other levels are metered.
 *
 *  (1) Free-tier greying: when the entitlement is trialing (CEVE.v2
 *      trial_ends_at present), metered levels are disabled unless the user has
 *      a paid seat, active top-up, or spendable credits. BYOK remains separate.
 *
 *  (2) EVE routing: buildEveInferenceProvider targets the eve-inference Edge
 *      Function URL with the CEVE license WIRE STRING as the bearer api_key
 *      (NOT an OpenRouter key), via the OpenAI-compatible platform so
 *      ClientFactory keeps the egress boundary. The wire value sent is the
 *      level/legacy-tier string the backend registry understands.
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
  EVE_INFERENCE_TIERS,
  eveTierValue,
  filterEvePickerGroups,
  isByokDisabledForEntitlement,
  isModelByokAllowed,
  isEveInferenceSelection,
  isEveTierSelectable,
  hasEvePaidInferenceAccess,
  isTrialingEntitlement,
  localTierValue,
  parseEveTierIdFromSelection,
  parseLocalTierFromSelection,
  resolveCommandEveActiveLane,
  describeCommandEveActiveLane,
  resolveCommandEveWarmupLane,
  resolveEffectiveInferenceSelection,
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

describe('eveInferenceCore — STUFEN shape (requirement 0)', () => {
  it('exposes EXACTLY the five EVE levels in order: Standard, Hoch, Sehr hoch, Maximum, Ultra', () => {
    const groups = buildEvePickerGroups(PAID_NULL);
    const eve = groups.find((g) => g.kind === 'eve')!;
    // Founder mandate: picker rows expose the strength ladder, never raw models.
    expect(eve.items.map((i) => i.label)).toEqual(['Standard', 'Hoch', 'Sehr hoch', 'Maximum', 'Ultra']);
  });

  it('Standard is the free-eligible default; Hoch through Ultra are paid', () => {
    const mittel = EVE_INFERENCE_TIERS.find((t) => t.id === 'eve-standard')!;
    const hoch = EVE_INFERENCE_TIERS.find((t) => t.id === 'eve-high')!;
    const max = EVE_INFERENCE_TIERS.find((t) => t.id === 'eve-max')!;
    const ultra = EVE_INFERENCE_TIERS.find((t) => t.id === 'eve-ultra')!;
    expect(mittel.paidOnly).toBe(false);
    expect(mittel.label).toBe('Standard');
    expect(mittel.modelLabel).toBe('großer Kontext');
    expect(hoch.paidOnly).toBe(true);
    expect(max.paidOnly).toBe(true);
    expect(ultra.paidOnly).toBe(true);
    expect(EVE_INFERENCE_DEFAULT_TIER_ID).toBe('eve-standard');
  });

  it('EVE High is paid + consumes credits (DeepSeek V4 Pro), NOT gated; cost badge suppressed in picker', () => {
    const items = flat(buildEvePickerGroups(PAID_NULL));
    const hoch = byLabel(items, 'eve', 'Hoch')!;
    expect(hoch.consumesCredits).toBe(true);
    expect(hoch.gated).toBe(false);
    expect(hoch.sublabel).toBe('intelligenter');
    // Founder mandate 1.2.13: cost/upsell labels are NOT surfaced in the picker.
    expect(hoch.costBadge).toBeUndefined();
  });

  it('EVE Maximum is the stable max-reasoning lane; Ultra alone carries the experimental high-cost marker', () => {
    const items = flat(buildEvePickerGroups(PAID_NULL));
    const max = byLabel(items, 'eve', 'Maximum')!;
    const ultra = byLabel(items, 'eve', 'Ultra')!;
    expect(max.consumesCredits).toBe(true);
    expect(max.gated).toBe(false);
    expect(max.sublabel).toBe('starkes Agenten-Reasoning');
    expect(max.costBadge).toBeUndefined();
    expect(ultra.consumesCredits).toBe(true);
    expect(ultra.gated).toBe(true);
    expect(ultra.sublabel).toBe('maximale Agenten-Power · experimentell');
    expect(ultra.costBadge).toBe('Ultra-Kosten');
  });

  it('keeps routine EVE rows quiet and marks only experimental Ultra cost', () => {
    const items = flat(buildEvePickerGroups(PAID_NULL));
    const eve = items.filter((i) => i.group === 'eve');
    expect(eve.filter((i) => i.label !== 'Ultra').every((i) => i.costBadge === undefined)).toBe(true);
    expect(byLabel(items, 'eve', 'Ultra')!.costBadge).toBe('Ultra-Kosten');
    expect(byLabel(items, 'eve', 'Standard')!.consumesCredits).toBe(false);
  });
});

describe('eveInferenceCore — scalable picker presentation', () => {
  it('keeps only matching rows while preserving their group navigation', () => {
    const filtered = filterEvePickerGroups(buildEvePickerGroups(PAID_NULL), 'Ultra');

    expect(filtered.map((group) => group.kind)).toEqual(['eve']);
    expect(filtered[0].items.map((item) => item.label)).toEqual(['Ultra']);
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
    // Local: Standard + Hoch only (no 31B pro tier). EVE: all five STUFEN.
    expect(groups[0].items.map((i) => i.label)).toEqual(['Standard', 'Hoch']);
    expect(groups[1].items.map((i) => i.label)).toEqual(['Standard', 'Hoch', 'Sehr hoch', 'Maximum', 'Ultra']);
  });

  it('greys every paid Pro rung through Ultra while trialing; EVE Standard + locals stay selectable', () => {
    const items = flat(buildEvePickerGroups(TRIAL));

    // The paid Pro rungs are disabled with the paid hint.
    const hoch = byLabel(items, 'eve', 'Hoch')!;
    const max = byLabel(items, 'eve', 'Maximum')!;
    const ultra = byLabel(items, 'eve', 'Ultra')!;
    expect(hoch.disabled).toBe(true);
    expect(hoch.disabledReasonCode).toBe('PAID_TIER_REQUIRED');
    expect(max.disabled).toBe(true);
    expect(max.disabledReasonCode).toBe('PAID_TIER_REQUIRED');
    expect(ultra.disabled).toBe(true);
    expect(ultra.disabledReasonCode).toBe('PAID_TIER_REQUIRED');

    // Routine tiers stay quiet. Experimental Ultra keeps its explicit cost warning.
    expect(hoch.costBadge).toBeUndefined();
    expect(max.costBadge).toBeUndefined();
    expect(ultra.costBadge).toBe('Ultra-Kosten');

    // EVE Standard (the free model) selectable on a trial.
    expect(byLabel(items, 'eve', 'Standard')!.disabled).toBe(false);

    // The entry-level local tiers remain selectable.
    expect(byLabel(items, 'local', 'Standard')!.disabled).toBe(false);
    expect(byLabel(items, 'local', 'Hoch')!.disabled).toBe(false);

    // Local tiers carry their bundled model labels as sublabels.
    expect(byLabel(items, 'local', 'Standard')!.sublabel).toBe('Gemma 4 E4B Uncensored');
    expect(byLabel(items, 'local', 'Hoch')!.sublabel).toBe('Gemma 4 12B Heretic');
  });

  it('leaves ALL EVE levels selectable when paid (trial_ends_at null/absent)', () => {
    for (const ent of [PAID_NULL, PAID_ABSENT]) {
      const items = flat(buildEvePickerGroups(ent));
      expect(byLabel(items, 'eve', 'Standard')!.disabled).toBe(false);
      expect(byLabel(items, 'eve', 'Hoch')!.disabled).toBe(false);
      expect(byLabel(items, 'eve', 'Maximum')!.disabled).toBe(false);
      expect(byLabel(items, 'eve', 'Ultra')!.disabled).toBe(false);
    }
  });

  it('isEveTierSelectable gates paid-only levels on trial, never the free ones', () => {
    expect(isEveTierSelectable({ paidOnly: false }, TRIAL)).toBe(true);
    expect(isEveTierSelectable({ paidOnly: true }, TRIAL)).toBe(false);
    expect(isEveTierSelectable({ paidOnly: true }, PAID_NULL)).toBe(true);
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
    expect(byLabel(items, 'eve', 'Hoch')!.sublabel).toBe('intelligenter');
    expect(byLabel(items, 'eve', 'Maximum')!.sublabel).toBe('starkes Agenten-Reasoning');
    expect(byLabel(items, 'eve', 'Ultra')!.sublabel).toBe('maximale Agenten-Power · experimentell');
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

  it('describes a CLOUD tier as EVE-Cloud + Stufe, never the model (DE + EN)', () => {
    const de = commandEveActiveModeLabel(eveTierValue('eve-max'), 'de-DE');
    const en = commandEveActiveModeLabel(eveTierValue('eve-standard'), 'en-US');
    expect(de).toMatch(/EVE-Cloud/);
    expect(de).toContain('Max'); // the STUFE label, not the model
    expect(en).toMatch(/EVE Cloud/);
    expect(de).not.toMatch(NO_MODEL);
    expect(en).not.toMatch(NO_MODEL);
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
    expect(buildEveInferenceProvider({ tierId: 'eve-high', licenseWire: FAKE_WIRE }).use_model).toBe('high');
    expect(buildEveInferenceProvider({ tierId: 'eve-max', licenseWire: FAKE_WIRE }).use_model).toBe('max');
    expect(buildEveInferenceProvider({ tierId: 'eve-ultra', licenseWire: FAKE_WIRE }).use_model).toBe('ultra');
  });

  it('the wire values are exactly the registry-accepted five-level set', () => {
    const wires = EVE_INFERENCE_TIERS.map((t) => t.tier);
    expect(wires).toEqual(['standard', 'high', 'xhigh', 'max', 'ultra']);
    // The desktop never sends "DeepSeek V4 Pro" / "GLM 5.2" on the wire — only
    // the level; the backend resolves the model.
    for (const w of wires) {
      expect(w).not.toMatch(/DeepSeek|GLM/i);
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
    expect(resolveCommandEveWarmupLane(eveTierValue('eve-high'))).toEqual({ lane: 'eve', tier: 'high' });
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

  it('maps eve-max → wire tier "max"', () => {
    expect(resolveWireTierFromSelection(eveTierValue('eve-max'))).toBe('max');
  });

  it('maps eve-ultra → wire tier "ultra"', () => {
    expect(resolveWireTierFromSelection(eveTierValue('eve-ultra'))).toBe('ultra');
  });

  it('maps eve-high → wire tier "high" (DeepSeek V4 Pro lane)', () => {
    expect(resolveWireTierFromSelection(eveTierValue('eve-high'))).toBe('high');
  });

  it('maps eve-standard → wire tier "standard" (DeepSeek V4 Flash lane)', () => {
    expect(resolveWireTierFromSelection(eveTierValue('eve-standard'))).toBe('standard');
  });

  it('returns the registry value VERBATIM for every defined EVE tier (no shift/bridge)', () => {
    for (const tier of EVE_INFERENCE_TIERS) {
      expect(resolveWireTierFromSelection(eveTierValue(tier.id))).toBe(tier.tier);
    }
  });

  it('models an in-session switch: re-resolving the new selection changes the wire tier', () => {
    // The picker persists a NEW selection on an in-session switch; the send path
    // re-resolves the CURRENT selection per request. So switching Standard → Max
    // → Ultra → High must yield the current wire tier every time.
    let current = eveTierValue('eve-standard');
    expect(resolveWireTierFromSelection(current)).toBe('standard');

    current = eveTierValue('eve-max'); // user switches to EVE Max mid-session
    expect(resolveWireTierFromSelection(current)).toBe('max');

    current = eveTierValue('eve-ultra');
    expect(resolveWireTierFromSelection(current)).toBe('ultra');

    current = eveTierValue('eve-high'); // user switches down to EVE High
    expect(resolveWireTierFromSelection(current)).toBe('high');
  });

  it('returns undefined for a LOCAL selection (so the cloud lane is never engaged)', () => {
    expect(resolveWireTierFromSelection(localTierValue('local-standard'))).toBeUndefined();
    expect(resolveWireTierFromSelection(localTierValue('local-high'))).toBeUndefined();
  });

  it('returns undefined for an absent/empty/unknown selection (caller fails loud, never silently meters Flash)', () => {
    expect(resolveWireTierFromSelection(undefined)).toBeUndefined();
    expect(resolveWireTierFromSelection(null)).toBeUndefined();
    expect(resolveWireTierFromSelection('')).toBeUndefined();
    // A retired/unknown EVE tier id resolves to no tier (not a silent 'standard').
    expect(resolveWireTierFromSelection('command-eve-inference:eve-maximum')).toBeUndefined();
    expect(resolveWireTierFromSelection('command-eve-inference:eve-bogus')).toBeUndefined();
  });
});

describe('eveInferenceCore — honest active-lane self-description (Task #50 port)', () => {
  const SHIM = 'command-eve-gemma4-e4b-64k';

  it('resolves an EVE cloud selection to its tier (shim-free)', () => {
    expect(resolveCommandEveActiveLane(eveTierValue('eve-max'))).toEqual({
      kind: 'eve',
      tierId: 'eve-max',
      tierLabel: 'Maximum',
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

  it('describes EVE Cloud Maximum as the stable max-reasoning tier, never the shim model (DE + EN)', () => {
    const de = describeCommandEveActiveLane(eveTierValue('eve-max'), 'de-DE');
    expect(de).toBe('EVE Cloud, Maximum-Stufe (maximales Reasoning, starke Agentenarbeit)');
    expect(de).not.toContain(SHIM);
    expect(de.toLowerCase()).not.toContain('ollama');
    expect(de.toLowerCase()).not.toContain('lokal');

    const en = describeCommandEveActiveLane(eveTierValue('eve-max'), 'en-US');
    expect(en).toBe('EVE Cloud, Maximum tier (maximum reasoning, strong agent work)');
    expect(en).not.toContain(SHIM);
    expect(en.toLowerCase()).not.toContain('local');
  });

  it('describes Ultra as proactive worker orchestration without exposing Kimi', () => {
    const de = describeCommandEveActiveLane(eveTierValue('eve-ultra'), 'de-DE');
    const en = describeCommandEveActiveLane(eveTierValue('eve-ultra'), 'en-US');
    expect(de).toBe('EVE Cloud, Ultra-Stufe (maximales Reasoning, proaktive Worker-Orchestrierung)');
    expect(en).toBe('EVE Cloud, Ultra tier (maximum reasoning, proactive worker orchestration)');
    expect(`${de} ${en}`).not.toMatch(/kimi|moonshot|openrouter/i);
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
