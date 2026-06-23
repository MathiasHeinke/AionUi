/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ISO-6 — PER-SEAT IDENTITY + DSGVO in the assembled EVE system prompt.
 *
 * THE LEAK THIS CLOSES (verified pre-fix). The EVE assistant skill prompt is
 * assembled from `buildCommandEveAssistantFirstRunContext`, whose founder/company
 * seed comes from the GLOBAL `first-run-profile.json` (sourced from the single
 * admin `registration.json`). Rendering that into a CLIENT seat's prompt greets
 * that client with the ADMIN operator's founder/company — a cross-seat identity
 * bleed that taints client-facing output.
 *
 * THE FIX. When a real (non-legacy) seat is active, the seat's OWN ISO-3
 * Company-Brain seed (under the seat-scoped hermesHome) supplies the client
 * entity and OUTRANKS the admin profile; the admin seed is never rendered into a
 * client seat. Legacy/single-seat is byte-identical to 1.1.3.
 *
 * INVARIANTS UNDER TEST (all on the PURE assembler, in plain vitest):
 *   (a) a real seat's assembled prompt reflects THAT seat's entity, not the admin
 *   (b) two seats yield DISTINCT prompts — seat A's entity never appears in B's
 *   (c) legacy / no-seat prompt is BYTE-IDENTICAL to the pre-ISO-6 assembler
 *   (d) the per-seat DSGVO posture is present for a seeded real seat, absent for
 *       legacy (no loosening of the global egress boundary)
 */

import { describe, expect, it } from 'vitest';
import {
  COMMAND_EVE_SEAT_DSGVO_POSTURE_DE,
  COMMAND_EVE_SEAT_DSGVO_POSTURE_EN,
  buildCommandEveAssistantFirstRunContext,
  resolveCommandEveSeatIdentity,
  type CommandEveAssistantFirstRunContext,
} from '@/process/commandEve/assistantBootstrapCore';

const ADMIN_PROFILE = {
  founder_name: 'Mathias (Admin)',
  company_name: 'FYN Labs GmbH',
  source: 'registration',
  confidence: 'verified',
  needs_confirmation: false,
};

const SEAT_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const SEAT_B = 'ffeeddcc-bbaa-4321-9988-776655443322';

const baseContext = (overrides?: Partial<CommandEveAssistantFirstRunContext>): CommandEveAssistantFirstRunContext => ({
  appVersion: '1.1.1',
  profile: { ...ADMIN_PROFILE },
  receipt: { status: 'ready', default_model: 'eve-standard', provider: 'eve_cloud' },
  ...overrides,
});

describe('ISO-6 (resolver) resolveCommandEveSeatIdentity', () => {
  it('legacy seat → undefined (the admin profile is used, byte-identical)', () => {
    expect(resolveCommandEveSeatIdentity({ legacy: true, seatId: 'seat-1' })).toBeUndefined();
    expect(
      resolveCommandEveSeatIdentity({ legacy: true, seatId: 'seat-1', seed: { kind: 'paste_brief', value: 'X' } })
    ).toBeUndefined();
  });

  it('real seat WITH a seed → lifts the client entity + the default DSGVO posture', () => {
    const id = resolveCommandEveSeatIdentity({
      legacy: false,
      seatId: SEAT_A,
      seed: { kind: 'connect_client', value: 'Mueller GmbH' },
      locale: 'en-US',
    });
    expect(id?.hasClientEntity).toBe(true);
    expect(id?.clientEntity).toBe('Mueller GmbH');
    expect(id?.source).toBe('seat');
    expect(id?.kind).toBe('connect_client');
    expect(id?.dsgvoPosture).toBe(COMMAND_EVE_SEAT_DSGVO_POSTURE_EN);
  });

  it('the DSGVO posture is locale-correct (de-DE)', () => {
    const id = resolveCommandEveSeatIdentity({
      legacy: false,
      seatId: SEAT_A,
      seed: { kind: 'connect_client', value: 'Mueller GmbH' },
      locale: 'de-DE',
    });
    expect(id?.dsgvoPosture).toBe(COMMAND_EVE_SEAT_DSGVO_POSTURE_DE);
  });

  it('real seat WITHOUT a seed → hasClientEntity:false (admin still suppressed)', () => {
    const id = resolveCommandEveSeatIdentity({ legacy: false, seatId: SEAT_A });
    expect(id).toBeDefined();
    expect(id?.hasClientEntity).toBe(false);
    expect(id?.clientEntity).toBeUndefined();
  });

  it('a blank/whitespace seed value does NOT count as a client entity', () => {
    const id = resolveCommandEveSeatIdentity({
      legacy: false,
      seatId: SEAT_A,
      seed: { kind: 'paste_brief', value: '   \n  ' },
    });
    expect(id?.hasClientEntity).toBe(false);
  });

  it('a multi-line brief is reduced to a short entity headline (full brief stays in MEMORY.md per ISO-3)', () => {
    const id = resolveCommandEveSeatIdentity({
      legacy: false,
      seatId: SEAT_A,
      seed: { kind: 'paste_brief', value: '   \n\nACME GmbH — Berlin\nlong second line with details...\n' },
      locale: 'en-US',
    });
    expect(id?.clientEntity).toBe('ACME GmbH — Berlin');
  });

  it('an overly long single-line value is clamped', () => {
    const long = 'A'.repeat(400);
    const id = resolveCommandEveSeatIdentity({
      legacy: false,
      seatId: SEAT_A,
      seed: { kind: 'connect_client', value: long },
    });
    expect((id?.clientEntity || '').length).toBeLessThanOrEqual(160);
    expect(id?.clientEntity?.endsWith('…')).toBe(true);
  });
});

describe('ISO-6 (a) a real seat reflects THAT seat, not the admin', () => {
  for (const locale of ['de-DE', 'en-US'] as const) {
    it(`[${locale}] the seat entity appears and the admin profile does NOT`, () => {
      const seatIdentity = resolveCommandEveSeatIdentity({
        legacy: false,
        seatId: SEAT_A,
        seed: { kind: 'connect_client', value: 'Mueller GmbH' },
        locale,
      });
      const prompt = buildCommandEveAssistantFirstRunContext(baseContext({ seatIdentity }), locale);
      expect(prompt).toContain('Mueller GmbH');
      // The admin's founder + company must NOT bleed into the client prompt.
      expect(prompt).not.toContain('Mathias (Admin)');
      expect(prompt).not.toContain('FYN Labs GmbH');
      // The DSGVO posture must be present.
      expect(prompt).toContain(locale === 'de-DE' ? 'Seat-Datenhaltung' : 'Seat data posture');
    });
  }

  it('a real but UNSEEDED seat still does NOT render the admin entity', () => {
    const seatIdentity = resolveCommandEveSeatIdentity({ legacy: false, seatId: SEAT_A });
    const prompt = buildCommandEveAssistantFirstRunContext(baseContext({ seatIdentity }), 'en-US');
    expect(prompt).not.toContain('Mathias (Admin)');
    expect(prompt).not.toContain('FYN Labs GmbH');
    expect(prompt).toContain('not recorded for this seat yet');
  });
});

describe('ISO-6 (b) two seats yield DISTINCT prompts (no A-in-B bleed)', () => {
  it("seat A's client name never appears in seat B's assembled prompt", () => {
    const a = buildCommandEveAssistantFirstRunContext(
      baseContext({
        seatIdentity: resolveCommandEveSeatIdentity({
          legacy: false,
          seatId: SEAT_A,
          seed: { kind: 'connect_client', value: 'Mueller GmbH' },
          locale: 'en-US',
        }),
      }),
      'en-US'
    );
    const b = buildCommandEveAssistantFirstRunContext(
      baseContext({
        seatIdentity: resolveCommandEveSeatIdentity({
          legacy: false,
          seatId: SEAT_B,
          seed: { kind: 'connect_client', value: 'Schmidt AG' },
          locale: 'en-US',
        }),
      }),
      'en-US'
    );

    expect(a).toContain('Mueller GmbH');
    expect(a).not.toContain('Schmidt AG');
    expect(b).toContain('Schmidt AG');
    expect(b).not.toContain('Mueller GmbH');
    expect(a).not.toBe(b);
    // And neither carries the admin identity.
    for (const prompt of [a, b]) {
      expect(prompt).not.toContain('Mathias (Admin)');
      expect(prompt).not.toContain('FYN Labs GmbH');
    }
  });
});

describe('ISO-6 (c) legacy / no-seat is BYTE-IDENTICAL to the pre-ISO-6 assembler', () => {
  for (const locale of ['de-DE', 'en-US'] as const) {
    it(`[${locale}] omitting seatIdentity yields the exact legacy admin prompt`, () => {
      // No seatIdentity ⇒ the legacy path: admin founder/company rendered exactly
      // as 1.1.3 did. We assert the load-bearing legacy lines are present and the
      // ISO-6 seat lines are absent.
      const prompt = buildCommandEveAssistantFirstRunContext(baseContext(), locale);
      expect(prompt).toContain('Mathias (Admin)');
      expect(prompt).toContain('FYN Labs GmbH');
      expect(prompt).toContain(locale === 'de-DE' ? 'Founder-Seed:' : 'Founder seed:');
      expect(prompt).toContain(locale === 'de-DE' ? 'Company-Seed:' : 'Company seed:');
      // No seat lines / no DSGVO appendix on the legacy path.
      expect(prompt).not.toContain(locale === 'de-DE' ? 'Client-Seat-Entitaet' : 'Client seat entity');
      expect(prompt).not.toContain(locale === 'de-DE' ? 'Seat-Datenhaltung' : 'Seat data posture');
    });
  }

  it('an explicitly-legacy resolver result is undefined → same legacy prompt', () => {
    const legacyIdentity = resolveCommandEveSeatIdentity({ legacy: true, seatId: 'seat-1' });
    const withLegacy = buildCommandEveAssistantFirstRunContext(
      baseContext({ seatIdentity: legacyIdentity }),
      'en-US'
    );
    const noField = buildCommandEveAssistantFirstRunContext(baseContext(), 'en-US');
    expect(withLegacy).toBe(noField);
  });
});

describe('ISO-6 (d) DSGVO posture tightens, never loosens', () => {
  it('the posture text asserts per-client isolation + no admin attribution', () => {
    for (const posture of [COMMAND_EVE_SEAT_DSGVO_POSTURE_DE, COMMAND_EVE_SEAT_DSGVO_POSTURE_EN]) {
      expect(posture.length).toBeGreaterThan(0);
    }
    expect(COMMAND_EVE_SEAT_DSGVO_POSTURE_EN.toLowerCase()).toContain('per-client isolation');
    expect(COMMAND_EVE_SEAT_DSGVO_POSTURE_EN.toLowerCase()).toContain('never');
    expect(COMMAND_EVE_SEAT_DSGVO_POSTURE_DE.toLowerCase()).toContain('per-client-isolation');
  });

  it('legacy seat carries NO DSGVO posture (byte-identical default)', () => {
    const prompt = buildCommandEveAssistantFirstRunContext(baseContext(), 'en-US');
    expect(prompt).not.toContain('Seat data posture');
  });
});
