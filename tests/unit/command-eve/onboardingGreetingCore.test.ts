/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE guided onboarding (SLICE S2) — pure greeting-builder tests.
 *
 * The builder turns the S0 read-only status model into the one-time German
 * readiness greeting. These tests pin the load-bearing contract:
 *   - first_value_ready ⇒ "du bist startklar", no gaps.
 *   - !ready ⇒ ONLY genuine `blocked` items appear; `skipped`/`ok` are filtered.
 *   - cloud-ready user with an OPTIONAL blocked local lane is still ready.
 *   - links route registration/license/cloud → registration target, local →
 *     runtime; identity carries no link.
 *   - HONESTY: a name is only greeted when confirmed (verified, no pending
 *     confirmation); a guessed name is NOT asserted in the headline.
 */

import { describe, expect, it } from 'vitest';
import {
  buildFallbackGreeting,
  buildOnboardingGreeting,
  getGreetingBannerTitle,
  COMMAND_EVE_ONBOARDING_GREETING_VERSION,
} from '@/common/config/onboardingGreetingCore';
import type {
  ICommandEveOnboardingItem,
  ICommandEveOnboardingStatusModel,
} from '@/common/adapter/ipcBridge';

function model(
  overrides: Partial<ICommandEveOnboardingStatusModel> = {}
): ICommandEveOnboardingStatusModel {
  return {
    schema_version: 'command-eve-onboarding-status/v0',
    generated_at: '2026-06-21T00:00:00.000Z',
    read_only: true,
    first_value_ready: false,
    entitlement_state: 'registered_unlicensed',
    cloud_bearer_available: false,
    identity: {
      needs_confirmation: true,
      confidence: 'placeholder',
      source: 'unverified',
    },
    items: [],
    warnings: [],
    ...overrides,
  };
}

function item(overrides: Partial<ICommandEveOnboardingItem> & Pick<ICommandEveOnboardingItem, 'id' | 'state'>): ICommandEveOnboardingItem {
  return {
    plain_meaning: 'x',
    remediation_kind: 'none',
    ...overrides,
  };
}

describe('buildOnboardingGreeting', () => {
  it('renders the startklar state with NO gaps when first_value_ready', () => {
    const greeting = buildOnboardingGreeting(
      model({
        first_value_ready: true,
        entitlement_state: 'entitled',
        cloud_bearer_available: true,
        items: [
          item({ id: 'cloud-lane', state: 'ok' }),
          item({ id: 'local-lane', state: 'skipped' }),
        ],
      })
    );
    expect(greeting.schema_version).toBe(COMMAND_EVE_ONBOARDING_GREETING_VERSION);
    expect(greeting.ready).toBe(true);
    expect(greeting.gaps).toHaveLength(0);
    expect(greeting.headline).toContain('startklar');
  });

  it('a cloud-ready user with a BLOCKED optional local lane is still startklar (local never blocks first value)', () => {
    const greeting = buildOnboardingGreeting(
      model({
        first_value_ready: true,
        entitlement_state: 'entitled',
        cloud_bearer_available: true,
        items: [
          item({ id: 'cloud-lane', state: 'ok' }),
          item({
            id: 'local-lane',
            state: 'blocked',
            reason_code: 'OLLAMA_MISSING',
            remediation_kind: 'external-link',
          }),
        ],
      })
    );
    // first_value_ready is the single truth — a blocked local lane does NOT
    // demote the greeting to a gap list.
    expect(greeting.ready).toBe(true);
    expect(greeting.gaps).toHaveLength(0);
  });

  it('lists ONLY blocked items as gaps; ok and skipped are filtered out', () => {
    const greeting = buildOnboardingGreeting(
      model({
        first_value_ready: false,
        entitlement_state: 'entitled',
        cloud_bearer_available: false,
        items: [
          item({ id: 'registration', state: 'ok' }),
          item({ id: 'license', state: 'ok' }),
          item({
            id: 'cloud-lane',
            state: 'blocked',
            plain_meaning: 'Cloud-Zugang fehlt.',
            reason_code: 'EVE_INFERENCE_NO_BEARER',
          }),
          item({ id: 'local-lane', state: 'skipped' }),
          item({ id: 'identity', state: 'skipped' }),
        ],
      })
    );
    expect(greeting.ready).toBe(false);
    expect(greeting.gaps.map((g) => g.id)).toEqual(['cloud-lane']);
    // The greeting renders its OWN localized copy (DE default), not the model's
    // internal plain_meaning; the machine reason_code is preserved for diagnostics.
    expect(greeting.gaps[0].text).toBe('Kurz neu aktivieren, dann läuft die Cloud-KI wieder.');
    expect(greeting.gaps[0].reason_code).toBe('EVE_INFERENCE_NO_BEARER');
  });

  it('routes link targets: cloud-lane → registration target, local-lane → runtime, identity → none', () => {
    const greeting = buildOnboardingGreeting(
      model({
        first_value_ready: false,
        items: [
          item({ id: 'cloud-lane', state: 'blocked' }),
          item({ id: 'local-lane', state: 'blocked', reason_code: 'OLLAMA_MISSING' }),
          item({ id: 'identity', state: 'blocked', reason_code: 'IDENTITY_NEEDS_CONFIRMATION' }),
        ],
      })
    );
    const byId = Object.fromEntries(greeting.gaps.map((g) => [g.id, g]));
    expect(byId['cloud-lane'].link_target).toBe('registration');
    expect(byId['cloud-lane'].link_label).toBe('klick hier');
    expect(byId['local-lane'].link_target).toBe('runtime');
    expect(byId['identity'].link_target).toBe('none');
    expect(byId['identity'].link_label).toBeUndefined();
  });

  it('greets by name ONLY when the identity is confirmed (verified + no pending confirmation)', () => {
    const confirmed = buildOnboardingGreeting(
      model({
        first_value_ready: true,
        identity: {
          founder_name: 'Alois',
          needs_confirmation: false,
          confidence: 'verified',
          source: 'registration',
        },
      })
    );
    expect(confirmed.headline).toContain('Alois');
  });

  it('does NOT assert a guessed name in the headline (honesty)', () => {
    const guessed = buildOnboardingGreeting(
      model({
        first_value_ready: true,
        identity: {
          founder_name: 'Alois',
          needs_confirmation: true,
          confidence: 'needs_confirmation',
          source: 'macos_full_name',
        },
      })
    );
    expect(guessed.headline).not.toContain('Alois');
    expect(guessed.headline).toContain('startklar');
  });

  it('never invents a gap when items is empty', () => {
    const greeting = buildOnboardingGreeting(model({ first_value_ready: false, items: [] }));
    expect(greeting.ready).toBe(false);
    expect(greeting.gaps).toHaveLength(0);
  });
});

describe('EVE greeting: setting-driven language (DE/EN)', () => {
  const blockedModel = () =>
    model({
      first_value_ready: false,
      entitlement_state: 'registered_unlicensed',
      items: [
        item({ id: 'registration', state: 'blocked', reason_code: 'REGISTRATION_REQUIRED' }),
        item({ id: 'license', state: 'blocked', reason_code: 'LICENSE_REQUIRED' }),
      ],
    });

  it('defaults to German when no locale is given (DACH-first, back-compat)', () => {
    const g = buildOnboardingGreeting(blockedModel());
    expect(g.headline).toContain('fast geschafft');
    expect(g.gaps[0].link_label).toBe('klick hier');
    expect(g.gaps.find((x) => x.id === 'registration')!.text).toBe(
      'Lege kurz dein Konto an, damit ich dich kenne.'
    );
  });

  it('renders English when the selected locale is en-US', () => {
    const g = buildOnboardingGreeting(blockedModel(), 'en-US');
    expect(g.headline).toContain('almost there');
    expect(g.gaps[0].link_label).toBe('click here');
    expect(g.gaps.find((x) => x.id === 'registration')!.text).toBe(
      'Set up your account so I know who you are.'
    );
    // No German leaks into the English greeting.
    expect(g.gaps.map((x) => x.text).join(' ')).not.toMatch(/klick hier|Konto|startklar/);
  });

  it('maps de-DE -> German and a non-DE locale (tr-TR) -> English', () => {
    expect(buildOnboardingGreeting(blockedModel(), 'de-DE').gaps[0].link_label).toBe('klick hier');
    expect(buildOnboardingGreeting(blockedModel(), 'tr-TR').gaps[0].link_label).toBe('click here');
  });

  it('ready state greets in the selected language', () => {
    const ready = model({
      first_value_ready: true,
      entitlement_state: 'entitled',
      cloud_bearer_available: true,
      items: [],
    });
    expect(buildOnboardingGreeting(ready, 'de-DE').headline).toContain('startklar');
    expect(buildOnboardingGreeting(ready, 'en-US').headline).toContain("you're all set");
  });

  it('localizes the expired-license gap distinctly in both languages', () => {
    const m = model({
      first_value_ready: false,
      entitlement_state: 'expired',
      items: [item({ id: 'license', state: 'blocked', reason_code: 'LICENSE_EXPIRED' })],
    });
    expect(buildOnboardingGreeting(m, 'de-DE').gaps[0].text).toContain('abgelaufen');
    expect(buildOnboardingGreeting(m, 'en-US').gaps[0].text).toContain('expired');
  });
});

/**
 * v1.6 Slice 1 ("nie wieder leer") — the claim-free fallback greeting for a
 * FAILED status read, plus the waiting-banner title. Honesty invariants: the
 * fallback NEVER claims readiness, never greets by name, never invents gaps.
 */
describe('buildFallbackGreeting (v1.6 degraded state)', () => {
  it('is claim-free: not ready, no gaps, no name, marked degraded', () => {
    const g = buildFallbackGreeting('de-DE');
    expect(g.schema_version).toBe(COMMAND_EVE_ONBOARDING_GREETING_VERSION);
    expect(g.ready).toBe(false);
    expect(g.gaps).toEqual([]);
    expect(g.degraded).toBe(true);
    // Never the ready claim, never a personal greeting.
    expect(g.headline).not.toContain('startklar');
    expect(g.headline).toBe('Hi.');
    expect(g.subline).toContain('Einrichtungs-Status');
  });

  it('localizes de/en and defaults unknown locales like the greeting (de-first)', () => {
    expect(buildFallbackGreeting('en-US').subline).toContain('setup status');
    expect(buildFallbackGreeting('en-US').headline).not.toContain('all set');
    expect(buildFallbackGreeting(undefined).subline).toContain('Einrichtungs-Status');
    expect(buildFallbackGreeting('tr-TR').subline).toContain('setup status');
  });

  it('is pure: same input, same output', () => {
    expect(buildFallbackGreeting('de-DE')).toEqual(buildFallbackGreeting('de-DE'));
  });
});

describe('getGreetingBannerTitle (v1.6 waiting banner)', () => {
  it('localizes the banner title de/en with the de-first default', () => {
    expect(getGreetingBannerTitle('de-DE')).toBe('Bevor es weitergeht:');
    expect(getGreetingBannerTitle('en-US')).toBe('Before we continue:');
    expect(getGreetingBannerTitle(undefined)).toBe('Bevor es weitergeht:');
  });
});
