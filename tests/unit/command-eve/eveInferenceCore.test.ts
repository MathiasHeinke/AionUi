/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * EVE Inference picker core — the STUFEN (level) model + the two required
 * behaviors:
 *
 *  (0) STUFEN shape: EVE exposes FOUR levels — Standard, Hoch (both FREE,
 *      Standard default), Max (DeepSeek V4 Pro, paid, consumes credits) and
 *      Maximum / "härteste Aufgabe" (GLM 5.2, paid + GATED, highest cost). The
 *      paid levels carry a model sublabel + a visible cost badge; Maximum is
 *      flagged `gated` with the highest-cost badge so the ~5× rate is obvious.
 *
 *  (1) Free-tier greying: when the entitlement is trialing (CEVE.v2
 *      trial_ends_at present), EVE Max + EVE Maximum are disabled (greyed) with
 *      a PAID_TIER_REQUIRED hint, and BYOK is disabled; EVE Standard + EVE Hoch
 *      + both local tiers stay selectable. A paid entitlement (trial_ends_at
 *      null/absent) leaves everything selectable.
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
  EVE_INFERENCE_TIER_SUBLABEL,
  EVE_INFERENCE_TIERS,
  eveTierValue,
  isByokDisabledForEntitlement,
  isEveInferenceSelection,
  isEveTierSelectable,
  isTrialingEntitlement,
  localTierValue,
  parseEveTierIdFromSelection,
  resolveCommandEveWarmupLane,
  resolveEffectiveInferenceSelection,
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
  it('exposes EXACTLY the three EVE levels in order: Standard, Hoch, Max', () => {
    const groups = buildEvePickerGroups(PAID_NULL);
    const eve = groups.find((g) => g.kind === 'eve')!;
    expect(eve.items.map((i) => i.label)).toEqual(['Standard', 'Hoch', 'Max']);
  });

  it('Standard is the free-eligible default (DeepSeek V4 Flash); Hoch + Max are paid', () => {
    const mittel = EVE_INFERENCE_TIERS.find((t) => t.id === 'eve-standard')!;
    const hoch = EVE_INFERENCE_TIERS.find((t) => t.id === 'eve-high')!;
    const max = EVE_INFERENCE_TIERS.find((t) => t.id === 'eve-max')!;
    expect(mittel.paidOnly).toBe(false);
    expect(mittel.label).toBe('Standard');
    expect(mittel.modelLabel).toBe('großer Kontext');
    expect(hoch.paidOnly).toBe(true);
    expect(max.paidOnly).toBe(true);
    expect(EVE_INFERENCE_DEFAULT_TIER_ID).toBe('eve-standard');
  });

  it('Hoch is paid + consumes credits (DeepSeek V4 Pro), NOT gated', () => {
    const items = flat(buildEvePickerGroups(PAID_NULL));
    const hoch = byLabel(items, 'eve', 'Hoch')!;
    expect(hoch.consumesCredits).toBe(true);
    expect(hoch.gated).toBe(false);
    expect(hoch.sublabel).toBe('intelligenter');
    expect(hoch.costBadge).toBe('mehr Credits');
  });

  it('Max is paid + GATED (GLM 5.2) and carries the highest-cost badge', () => {
    const items = flat(buildEvePickerGroups(PAID_NULL));
    const max = byLabel(items, 'eve', 'Max')!;
    expect(max.consumesCredits).toBe(true);
    expect(max.gated).toBe(true);
    expect(max.sublabel).toBe('höchste Intelligenz');
    expect(max.costBadge).toBe('höchste Kosten');
  });

  it('the FREE level (Standard) carries NO cost badge in the base picker (free = no credit surprise)', () => {
    const items = flat(buildEvePickerGroups(PAID_NULL));
    expect(byLabel(items, 'eve', 'Standard')!.costBadge).toBeUndefined();
    expect(byLabel(items, 'eve', 'Standard')!.consumesCredits).toBe(false);
  });
});

describe('eveInferenceCore — free-tier greying (requirement 1)', () => {
  it('renders EXACTLY two groups and nothing else', () => {
    const groups = buildEvePickerGroups(TRIAL);
    expect(groups.map((g) => g.kind)).toEqual(['local', 'eve']);
    // Local: Standard + Hoch only (no 31B pro tier). EVE: the three STUFEN.
    expect(groups[0].items.map((i) => i.label)).toEqual(['Standard', 'Hoch']);
    expect(groups[1].items.map((i) => i.label)).toEqual(['Standard', 'Hoch', 'Max']);
  });

  it('greys the paid Pro rungs (Hoch + Max) while trialing; Standard + locals selectable', () => {
    const items = flat(buildEvePickerGroups(TRIAL));

    // The paid Pro rungs (Hoch + Max) disabled with the paid hint.
    const hoch = byLabel(items, 'eve', 'Hoch')!;
    const max = byLabel(items, 'eve', 'Max')!;
    expect(hoch.disabled).toBe(true);
    expect(hoch.disabledReasonCode).toBe('PAID_TIER_REQUIRED');
    expect(max.disabled).toBe(true);
    expect(max.disabledReasonCode).toBe('PAID_TIER_REQUIRED');

    // The cost badge is shown EVEN while greyed, so the user knows what it costs
    // before deciding to upgrade.
    expect(hoch.costBadge).toBe('mehr Credits');
    expect(max.costBadge).toBe('höchste Kosten');

    // EVE Standard (the free model) selectable on a trial.
    expect(byLabel(items, 'eve', 'Standard')!.disabled).toBe(false);

    // Both local tiers selectable.
    expect(byLabel(items, 'local', 'Standard')!.disabled).toBe(false);
    expect(byLabel(items, 'local', 'Hoch')!.disabled).toBe(false);

    // Local tiers carry their bundled model labels as sublabels.
    expect(byLabel(items, 'local', 'Standard')!.sublabel).toBe('Gemma 4 E4B');
    expect(byLabel(items, 'local', 'Hoch')!.sublabel).toBe('Gemma 4 12B');
  });

  it('leaves ALL EVE levels selectable when paid (trial_ends_at null/absent)', () => {
    for (const ent of [PAID_NULL, PAID_ABSENT]) {
      const items = flat(buildEvePickerGroups(ent));
      expect(byLabel(items, 'eve', 'Standard')!.disabled).toBe(false);
      expect(byLabel(items, 'eve', 'Hoch')!.disabled).toBe(false);
      expect(byLabel(items, 'eve', 'Max')!.disabled).toBe(false);
    }
  });

  it('isEveTierSelectable gates paid-only levels on trial, never the free ones', () => {
    expect(isEveTierSelectable({ paidOnly: false }, TRIAL)).toBe(true);
    expect(isEveTierSelectable({ paidOnly: true }, TRIAL)).toBe(false);
    expect(isEveTierSelectable({ paidOnly: true }, PAID_NULL)).toBe(true);
  });

  it('disables BYOK while trialing, enables it when paid', () => {
    expect(isByokDisabledForEntitlement(TRIAL)).toBe(true);
    expect(isByokDisabledForEntitlement(PAID_NULL)).toBe(false);
    expect(isByokDisabledForEntitlement(PAID_ABSENT)).toBe(false);
    expect(isByokDisabledForEntitlement(null)).toBe(false);
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

  it('each EVE level names its concrete cloud model in the sublabel (level in the primary label, model in the secondary)', () => {
    const items = flat(buildEvePickerGroups(TRIAL));
    expect(byLabel(items, 'eve', 'Standard')!.sublabel).toBe('großer Kontext');
    expect(byLabel(items, 'eve', 'Hoch')!.sublabel).toBe('intelligenter');
    expect(byLabel(items, 'eve', 'Max')!.sublabel).toBe('höchste Intelligenz');
  });

  it('cloud heading marks EVE as Cloud; rows show CAPABILITY, never a concrete model name', () => {
    const groups = buildEvePickerGroups(TRIAL);
    const eveGroup = groups.find((g) => g.kind === 'eve')!;
    expect(eveGroup.title.toLowerCase()).toContain('cloud');
    // Founder mandate: NO concrete model name anywhere user-facing — not the cloud
    // vendors (DeepSeek/GLM) and not the local one (Gemma). The lane is still
    // unmistakably "Cloud" via the heading; the rows describe capability only.
    const eveSubs = eveGroup.items.map((i) => i.sublabel ?? '');
    expect(eveSubs.every((s) => !/gemma|deepseek|glm|openrouter/i.test(s))).toBe(true);
    // The local group is unmistakably NOT cloud (heading). Offline/local models ARE
    // named (founder 2026-06-28: they run on the user's own device) — only the cloud
    // lane stays model-abstract.
    const localGroup = groups.find((g) => g.kind === 'local')!;
    expect(localGroup.title.toLowerCase()).not.toContain('cloud');
    expect(localGroup.items.some((i) => /gemma/i.test(i.sublabel ?? ''))).toBe(true);
    // ...but a CLOUD vendor/model must never appear, even in the local rows.
    expect(localGroup.items.map((i) => i.sublabel ?? '').every((s) => !/deepseek|glm/i.test(s))).toBe(true);
  });
});

describe('commandEveActiveModeLabel — honest lane self-description (cloud abstract, local named)', () => {
  const NO_MODEL = /gemma|deepseek|glm|ollama|openrouter/i;
  // Cloud models/providers must NEVER appear anywhere; the on-device (gemma) model MAY (local only).
  const NO_CLOUD_MODEL = /deepseek|glm|openrouter/i;

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
  });

  it('the wire values are exactly the registry-accepted set (matches the server KNOWN_TIERS standard/high/max)', () => {
    const wires = EVE_INFERENCE_TIERS.map((t) => t.tier);
    expect(wires).toEqual(['standard', 'high', 'max']);
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
