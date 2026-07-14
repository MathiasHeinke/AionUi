/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HONCHO-Inc.3 / P1 — the provisioning plan decision. Pins the fail-safe gates
 * (every reason to not run Honcho ⇒ disabled + a skip reason, never a hard error)
 * and the ordered, consent-aware step plan.
 */

import { describe, expect, it } from 'vitest';
import {
  HONCHO_MIN_FREE_DISK_GB,
  HONCHO_REASON_BLOCKED_DISK,
  HONCHO_REASON_BLOCKED_RAM,
  HONCHO_REASON_MODE_OFF,
  HONCHO_STEP_DB,
  HONCHO_STEP_HOMEBREW,
  HONCHO_STEP_POSTGRES,
  HONCHO_STEP_PROCESS,
  HONCHO_STEP_READY,
  buildHonchoProvisionPlan,
  type HonchoConsentState,
  type HonchoDepDetection,
} from '@/process/commandEve/honchoProvisionPlanCore';
import { HONCHO_REASON_DECLINED, HONCHO_REASON_DEP_MISSING } from '@/process/commandEve/honchoReadinessCore';
import { HONCHO_DERIVER_BRANCH_CLOUD, HONCHO_DERIVER_BRANCH_LOCAL } from '@/process/commandEve/honchoRuntimeConfigCore';

const CLOUD = { deriver: { branch: HONCHO_DERIVER_BRANCH_CLOUD } };
const LOCAL = { deriver: { branch: HONCHO_DERIVER_BRANCH_LOCAL } };
const OPTED: HonchoConsentState = { memoryOptedIn: true, hasLicense: true };
const ALL_PRESENT: HonchoDepDetection = {
  hasHomebrew: true,
  hasPostgres: true,
  hasPgvector: true,
  pythonSupported: true,
  hasHonchoPkg: true,
  dbProvisioned: true,
  freeDiskGb: 50,
};

describe('honchoProvisionPlanCore — fail-safe gates (every miss disables, never errors)', () => {
  it('mode off ⇒ disabled / HONCHO_MODE_OFF, no steps', () => {
    const p = buildHonchoProvisionPlan({ mode: 'off', consent: OPTED, config: CLOUD });
    expect(p.honchoEnabled).toBe(false);
    expect(p.skipReason).toBe(HONCHO_REASON_MODE_OFF);
    expect(p.steps).toEqual([]);
  });

  it('memory not opted-in ⇒ disabled / HONCHO_DECLINED', () => {
    const p = buildHonchoProvisionPlan({ consent: { memoryOptedIn: false, hasLicense: true }, config: CLOUD });
    expect(p.honchoEnabled).toBe(false);
    expect(p.skipReason).toBe(HONCHO_REASON_DECLINED);
  });

  it('cloud-flash deriver but no license ⇒ disabled / HONCHO_DEP_MISSING (no deriver auth)', () => {
    const p = buildHonchoProvisionPlan({
      consent: { memoryOptedIn: true, hasLicense: false },
      config: CLOUD,
      detection: ALL_PRESENT,
    });
    expect(p.honchoEnabled).toBe(false);
    expect(p.skipReason).toBe(HONCHO_REASON_DEP_MISSING);
  });

  it('LOCAL deriver branch does NOT require a license (local Gemma needs no bearer)', () => {
    const p = buildHonchoProvisionPlan({
      consent: { memoryOptedIn: true, hasLicense: false },
      config: LOCAL,
      detection: ALL_PRESENT,
    });
    expect(p.honchoEnabled).toBe(true);
  });

  it('MISSING/unknown branch defaults to CLOUD ⇒ requires a license (Codex #2)', () => {
    // no config at all + no license ⇒ must NOT enable (default deriver is cloud-flash)
    const p = buildHonchoProvisionPlan({ consent: { memoryOptedIn: true, hasLicense: false }, detection: ALL_PRESENT });
    expect(p.honchoEnabled).toBe(false);
    expect(p.skipReason).toBe(HONCHO_REASON_DEP_MISSING);
    // with a license, missing branch (treated cloud) is fine
    expect(
      buildHonchoProvisionPlan({ consent: { memoryOptedIn: true, hasLicense: true }, detection: ALL_PRESENT })
        .honchoEnabled
    ).toBe(true);
  });

  it('an explicit UNKNOWN/garbage branch is treated as cloud ⇒ still requires a license', () => {
    const garbage = { deriver: { branch: 'something-else' } };
    const p = buildHonchoProvisionPlan({
      consent: { memoryOptedIn: true, hasLicense: false },
      config: garbage,
      detection: ALL_PRESENT,
    });
    expect(p.honchoEnabled).toBe(false);
    expect(p.skipReason).toBe(HONCHO_REASON_DEP_MISSING);
  });

  it('free disk below the floor ⇒ disabled / HONCHO_BLOCKED_DISK', () => {
    const p = buildHonchoProvisionPlan({
      consent: OPTED,
      config: CLOUD,
      detection: { ...ALL_PRESENT, freeDiskGb: HONCHO_MIN_FREE_DISK_GB - 0.5 },
    });
    expect(p.honchoEnabled).toBe(false);
    expect(p.skipReason).toBe(HONCHO_REASON_BLOCKED_DISK);
  });

  it('RAM below the floor (8GB Air) ⇒ disabled / HONCHO_BLOCKED_RAM; 16GB ⇒ enabled (perf audit)', () => {
    const air = buildHonchoProvisionPlan({
      consent: OPTED,
      config: CLOUD,
      detection: { ...ALL_PRESENT, totalMemoryGb: 8 },
    });
    expect(air.honchoEnabled).toBe(false);
    expect(air.skipReason).toBe(HONCHO_REASON_BLOCKED_RAM);
    const pro = buildHonchoProvisionPlan({
      consent: OPTED,
      config: CLOUD,
      detection: { ...ALL_PRESENT, totalMemoryGb: 16 },
    });
    expect(pro.honchoEnabled).toBe(true);
    // unknown RAM is not gated (the caller always supplies os.totalmem())
    expect(buildHonchoProvisionPlan({ consent: OPTED, config: CLOUD, detection: ALL_PRESENT }).honchoEnabled).toBe(
      true
    );
  });

  it('a needed install the user DECLINED ⇒ disabled / HONCHO_DEP_MISSING (fail-safe)', () => {
    // postgres missing + user declined the install
    const p = buildHonchoProvisionPlan({
      consent: { memoryOptedIn: true, hasLicense: true, installDeclined: true },
      config: CLOUD,
      detection: { hasHomebrew: true, hasPostgres: false, pythonSupported: true, freeDiskGb: 50 },
    });
    expect(p.honchoEnabled).toBe(false);
    expect(p.skipReason).toBe(HONCHO_REASON_DEP_MISSING);
  });
});

describe('honchoProvisionPlanCore — enabled plan shape', () => {
  it('all deps present + opted-in ⇒ enabled, 8 ordered steps, consentRequired false', () => {
    const p = buildHonchoProvisionPlan({ consent: OPTED, config: CLOUD, detection: ALL_PRESENT });
    expect(p.honchoEnabled).toBe(true);
    expect(p.skipReason).toBeUndefined();
    expect((p.steps || []).map((s) => s.id)).toEqual([
      HONCHO_STEP_HOMEBREW,
      HONCHO_STEP_POSTGRES,
      'honcho-pgvector',
      'honcho-python',
      'honcho-package',
      HONCHO_STEP_DB,
      HONCHO_STEP_PROCESS,
      HONCHO_STEP_READY,
    ]);
    // present deps are marked satisfied; process/ready always run.
    const byId = Object.fromEntries((p.steps || []).map((s) => [s.id, s]));
    expect(byId[HONCHO_STEP_POSTGRES].alreadySatisfied).toBe(true);
    expect(byId[HONCHO_STEP_PROCESS].alreadySatisfied).toBe(false);
    expect(byId[HONCHO_STEP_READY].alreadySatisfied).toBe(false);
    expect(p.consentRequired).toBe(false);
  });

  it('missing consent-deps ⇒ enabled but consentRequired true, and those steps are not satisfied', () => {
    const p = buildHonchoProvisionPlan({
      consent: OPTED,
      config: CLOUD,
      detection: { hasHomebrew: false, hasPostgres: false, hasPgvector: false, pythonSupported: true, freeDiskGb: 50 },
    });
    expect(p.honchoEnabled).toBe(true);
    expect(p.consentRequired).toBe(true);
    const byId = Object.fromEntries((p.steps || []).map((s) => [s.id, s]));
    expect(byId[HONCHO_STEP_HOMEBREW].alreadySatisfied).toBe(false);
    expect(byId[HONCHO_STEP_HOMEBREW].needsConsent).toBe(true);
  });

  it('is deterministic + never throws on an empty input (defaults to auto/off-by-consent)', () => {
    expect(() => buildHonchoProvisionPlan({})).not.toThrow();
    const p = buildHonchoProvisionPlan({});
    // no memory opt-in in an empty input ⇒ safely disabled, not enabled
    expect(p.honchoEnabled).toBe(false);
    expect(p.skipReason).toBe(HONCHO_REASON_DECLINED);
    expect(buildHonchoProvisionPlan({ consent: OPTED, config: CLOUD, detection: ALL_PRESENT })).toEqual(
      buildHonchoProvisionPlan({ consent: OPTED, config: CLOUD, detection: ALL_PRESENT })
    );
  });
});
