/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ISO-8 — THE GATE-NULL cross-seat isolation harness (the keystone CI).
 * ====================================================================
 *
 * This is the ONE end-to-end proof the founder relies on to ship MULTISEAT at all
 * (doctrine 1.2: multi-client operation stays GATE-NULL until a green
 * cross-client-isolation CI runs on real state).
 *
 * 1.820.1 raised the stakes rather than retiring them: additional seats are no
 * longer a +99 €-per-seat SKU, they are INCLUDED in the one Standard
 * subscription. Nothing prices an operator out of running many clients side by
 * side any more, so this harness is the only thing standing between them.
 *
 * It CONSOLIDATES the six per-dimension fence tests (ISO-1…ISO-6) into a single
 * coherent two-seat scenario: for two DISTINCT real seats A and B, seat A can
 * NEVER reach seat B across EVERY isolation dimension at once. It does NOT
 * re-implement any isolation logic — it drives the REAL seams (the same ones the
 * running desktop app uses) via `setActiveSeatId`, the live active-seat holder:
 *
 *   ISO-1  HERMES_HOME / memory roots ....... resolveActiveSeatHome
 *   ISO-2  config-key namespace ............. seatScopedKey
 *   ISO-3  Company-Brain seed ............... writeCompanyBrainSeedToHome / read…FromHome
 *   ISO-4  workspace + backend conv. SQLite . getBackendDataDir / getSystemDir
 *   ISO-5  connectors / skills / managedSkills resolveCommandEveRuntimeBootstrapPaths().managedSkillsRoot
 *   ISO-6  assembled prompt / greeting ...... buildCommandEveAssistantFirstRunContext / buildCommandEveOnboardingStatus
 *
 * NON-TAUTOLOGY + NO FALSE-PASS: the final `describe` is an INJECT-A-LEAK
 * self-test (mirrors supabase/tests/migration-lint.sh, which self-tests that it
 * actually catches an injected grant). It feeds a deliberately BROKEN resolver
 * (one that ignores the seat and returns seat A's value under seat B) into the
 * SAME disjointness assertions the harness uses, and proves they FAIL RED. A
 * green gate that does not fail on a real leak is theatre; this test makes the
 * gate's failure mode executable.
 *
 * SCOPE / HONESTY: this proves the DESKTOP DATA-isolation half (the on-device
 * runtime seams) at the unit/integration tier with REAL seams (no re-impl). The
 * ACCESS half — RLS / cross-tenant SQL bleed + the grant-regression lint — lives
 * in the MAIN Company.OS repo and is NOT re-implemented here:
 *   - supabase/tests/b2_delegate_isolation_bleed_test.sql  (delegate-token bleed)
 *   - supabase/tests/d8_cross_client_isolation_bleed_test.sql + run-d8-bleed-test.sh
 *   - supabase/tests/migration-lint.sh  (grant/guard/policy lint, self-testing)
 *   wired as the `d8-cross-client-isolation` + `migration-lint` jobs in
 *   .github/workflows/backend-gates.yml. GATE-NULL = data(this) + access(main).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'path';

// ISO-1 — the live HERMES_HOME / active-seat seam.
import {
  SEATS_SUBDIR,
  __resetActiveSeatForTests,
  getActiveSeatId,
  isActiveSeatLegacy,
  resolveActiveSeatHome,
  setActiveSeatId,
} from '@/process/commandEve/seatContextCore';
// ISO-2 — the config-key namespace seam.
import { SEAT_SCOPED_CONFIG_KEYS, seatScopedKey } from '@/common/config/seatConfigKeyCore';
// ISO-3 — the Company-Brain seed writer/reader (pure, home-injected).
import {
  COMPANY_BRAIN_DIR,
  readCompanyBrainSeedStateFromHome,
  writeCompanyBrainSeedToHome,
} from '@/process/commandEve/companyBrainSeedCore';
// ISO-4 + ISO-5 — the workspace / data-dir / managedSkills seams.
import { getBackendDataDir, getSystemDir, getAssistantsDir, getSkillsDir } from '@/process/utils/initStorage';
import { resolveCommandEveRuntimeBootstrapPaths } from '@/process/commandEve/runtimeBootstrapCore';
// ISO-6 — the assembled prompt + the onboarding greeting.
import {
  buildCommandEveAssistantFirstRunContext,
  resolveCommandEveSeatIdentity,
} from '@/process/commandEve/assistantBootstrapCore';
import { buildCommandEveOnboardingStatus } from '@/process/commandEve/onboardingStatusCore';

import { mkdtempSync, rmSync } from 'fs';
import os from 'os';

// ---------------------------------------------------------------------------
// Two DISTINCT real seats. Each carries a unique, recognizable client entity
// so a leak of ANY dimension shows up as one seat's secret token surfacing in
// the other seat's resolved value. These tokens are the "tracer dye".
// ---------------------------------------------------------------------------
const SEAT_A = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const SEAT_B = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';

const ENTITY_A = 'ACME-Steuerberatung-Alpha-GmbH'; // seat A's client, never to appear under B
const ENTITY_B = 'Beta-Medspa-Bravo-AG'; // seat B's client, never to appear under A

const A_SCOPED_VALUE = `secret-A-${SEAT_A}`;
const B_SCOPED_VALUE = `secret-B-${SEAT_B}`;

/**
 * A real per-app userData root on disk so the ISO-3 seed writer actually writes
 * files under each seat home and the disjointness is proven against the
 * filesystem, not just string math.
 */
const USER_DATA = mkdtempSync(path.join(os.tmpdir(), 'eve-iso8-'));

// HERMETIC: the active-seat holder is a process-global; this harness drives it via
// setActiveSeatId, so it MUST start AND end every test on the legacy default so it
// can never leak a non-legacy active seat into another test file sharing the vitest
// worker. (The path resolvers it calls are pure — no disk side effects — so the temp
// dir + the active-seat reset are the only shared state to contain.)
beforeEach(() => {
  __resetActiveSeatForTests();
});

afterEach(() => {
  __resetActiveSeatForTests();
});

afterAll(() => {
  __resetActiveSeatForTests();
  rmSync(USER_DATA, { recursive: true, force: true });
});

/** Capture the FULL isolation surface for the currently-active seat. */
type SeatSurface = {
  seatId: string;
  hermesHome: string; // ISO-1
  configKeys: string[]; // ISO-2 (one scoped key per allowlisted key)
  seedHome: string; // ISO-3 (where the Company-Brain seed lives)
  backendDataDir: string; // ISO-4 (the --data-dir handed to backendManager.start)
  cacheDir: string; // ISO-4 (workspace / chat-history root)
  workDir: string; // ISO-4 (produced-deliverables root)
  assistantsDir: string; // ISO-4/5
  skillsDir: string; // ISO-5
  managedSkillsRoot: string; // ISO-5 (connectors/skills under the seat home)
};

const captureActiveSeatSurface = (): SeatSurface => {
  const home = resolveActiveSeatHome(USER_DATA).hermesHome;
  const sys = getSystemDir();
  return {
    seatId: getActiveSeatId(),
    hermesHome: home,
    configKeys: [...SEAT_SCOPED_CONFIG_KEYS].map((key) => seatScopedKey(key, getActiveSeatId())),
    seedHome: home,
    backendDataDir: getBackendDataDir(),
    cacheDir: sys.cacheDir,
    workDir: sys.workDir,
    assistantsDir: getAssistantsDir(),
    skillsDir: getSkillsDir(),
    managedSkillsRoot: resolveCommandEveRuntimeBootstrapPaths(USER_DATA).managedSkillsRoot,
  };
};

/**
 * The reusable disjointness oracle. Given two seats' surfaces (and the tracer
 * tokens that must stay seat-private), assert NO dimension of seat A can reach
 * seat B and vice-versa. This is the EXACT predicate the inject-a-leak self-test
 * later feeds a broken surface into — so the gate's pass-condition and its
 * fail-condition are one and the same function.
 */
const assertFullyDisjoint = (a: SeatSurface, b: SeatSurface, tracers: { aToken: string; bToken: string }): void => {
  const underSeats = (p: string) => p.includes(`${path.sep}${SEATS_SUBDIR}${path.sep}`);
  const containedIn = (parent: string, child: string) => child.startsWith(parent + path.sep);

  // (i) ISO-1 — HERMES_HOME / memory roots disjoint + neither contains the other.
  expect(a.hermesHome).not.toBe(b.hermesHome);
  expect(containedIn(a.hermesHome, b.hermesHome)).toBe(false);
  expect(containedIn(b.hermesHome, a.hermesHome)).toBe(false);
  expect(a.hermesHome).toContain(a.seatId);
  expect(a.hermesHome).not.toContain(b.seatId);
  expect(b.hermesHome).not.toContain(a.seatId);
  expect(underSeats(a.hermesHome)).toBe(true);
  expect(underSeats(b.hermesHome)).toBe(true);

  // (ii) ISO-2 — config-key namespaces disjoint: A's scoped keys never collide
  // with B's, and A's keys carry A's id, not B's (so a read under B can't hit A).
  for (const key of a.configKeys) {
    expect(key).toContain(a.seatId);
    expect(key).not.toContain(b.seatId);
    expect(b.configKeys).not.toContain(key);
  }
  for (const key of b.configKeys) {
    expect(key).not.toContain(a.seatId);
  }

  // (iii) ISO-3 — the Company-Brain seed roots are disjoint AND each seat reads
  // back ONLY its own client entity (the cross-read returns the other's NOTHING).
  expect(a.seedHome).not.toBe(b.seedHome);
  const aSeed = readCompanyBrainSeedStateFromHome(a.seedHome);
  const bSeed = readCompanyBrainSeedStateFromHome(b.seedHome);
  // A's seed home holds A's entity (tracer) and NOT B's.
  expect(aSeed.record?.value ?? '').toContain(tracers.aToken);
  expect(aSeed.record?.value ?? '').not.toContain(tracers.bToken);
  // B's seed home holds B's entity and NOT A's.
  expect(bSeed.record?.value ?? '').toContain(tracers.bToken);
  expect(bSeed.record?.value ?? '').not.toContain(tracers.aToken);
  // The seed json/MEMORY.md live strictly under each seat's own home.
  expect(path.join(a.seedHome, COMPANY_BRAIN_DIR)).toContain(a.seatId);
  expect(path.join(b.seedHome, COMPANY_BRAIN_DIR)).toContain(b.seatId);

  // (iv) ISO-4 — workspace + the backend conversation SQLite --data-dir disjoint.
  for (const dir of [a.backendDataDir, a.cacheDir, a.workDir] as const) {
    expect(dir).toContain(a.seatId);
    expect(dir).not.toContain(b.seatId);
  }
  for (const dir of [b.backendDataDir, b.cacheDir, b.workDir] as const) {
    expect(dir).not.toContain(a.seatId);
    expect(dir).toContain(b.seatId);
  }
  expect(a.backendDataDir).not.toBe(b.backendDataDir);
  expect(containedIn(a.backendDataDir, b.backendDataDir)).toBe(false);
  expect(containedIn(b.backendDataDir, a.backendDataDir)).toBe(false);
  expect(a.cacheDir).not.toBe(b.cacheDir);
  expect(a.workDir).not.toBe(b.workDir);

  // (v) ISO-5 — connectors / skills / managedSkills under A's home, not B's.
  for (const dir of [a.assistantsDir, a.skillsDir, a.managedSkillsRoot] as const) {
    expect(dir).toContain(a.seatId);
    expect(dir).not.toContain(b.seatId);
    expect(containedIn(a.hermesHome, a.managedSkillsRoot)).toBe(true);
  }
  for (const dir of [b.assistantsDir, b.skillsDir, b.managedSkillsRoot] as const) {
    expect(dir).not.toContain(a.seatId);
    expect(dir).toContain(b.seatId);
  }
  expect(a.managedSkillsRoot).not.toBe(b.managedSkillsRoot);
};

// ===========================================================================
// THE GATE-NULL SCENARIO — one coherent two-seat run across all 6 dimensions.
// ===========================================================================
describe('ISO-8 GATE-NULL — seat A can never reach seat B across all 6 isolation dimensions', () => {
  /**
   * Build seat A's full surface: switch to A, write A's real client seed to A's
   * home, snapshot every dimension; then do the same for B. Both seeds persist
   * on disk so the ISO-3 cross-reads in the oracle are real file reads.
   */
  const buildSurfaces = (): { a: SeatSurface; b: SeatSurface } => {
    // --- Seat A ---
    setActiveSeatId(SEAT_A);
    expect(isActiveSeatLegacy()).toBe(false);
    writeCompanyBrainSeedToHome({
      hermesHome: resolveActiveSeatHome(USER_DATA).hermesHome,
      seed: { kind: 'paste_brief', value: `${ENTITY_A}\nbrief tracer ${A_SCOPED_VALUE}` },
    });
    const a = captureActiveSeatSurface();

    // --- Seat B ---
    setActiveSeatId(SEAT_B);
    expect(isActiveSeatLegacy()).toBe(false);
    writeCompanyBrainSeedToHome({
      hermesHome: resolveActiveSeatHome(USER_DATA).hermesHome,
      seed: { kind: 'paste_brief', value: `${ENTITY_B}\nbrief tracer ${B_SCOPED_VALUE}` },
    });
    const b = captureActiveSeatSurface();

    return { a, b };
  };

  it('the full disjointness oracle holds for two distinct real seats (ISO-1…ISO-5)', () => {
    const { a, b } = buildSurfaces();
    assertFullyDisjoint(a, b, { aToken: ENTITY_A, bToken: ENTITY_B });
    expect(a.configKeys).toContain(`seat:${SEAT_A}:commandEve.cloudVisualAnalysisEnabled`);
    expect(b.configKeys).toContain(`seat:${SEAT_B}:commandEve.cloudVisualAnalysisEnabled`);
    // And cross-check: seat A's tracer never appears anywhere in seat B's surface.
    const bSurfaceBlob = JSON.stringify(b);
    expect(bSurfaceBlob).not.toContain(SEAT_A);
    expect(bSurfaceBlob).not.toContain(A_SCOPED_VALUE);
    const aSurfaceBlob = JSON.stringify(a);
    expect(aSurfaceBlob).not.toContain(SEAT_B);
    expect(aSurfaceBlob).not.toContain(B_SCOPED_VALUE);
  });

  it("(vi) ISO-6 — A's assembled prompt entity NEVER appears in B's prompt and vice-versa", () => {
    // Seat A's identity comes from A's seed; render A's first-run prompt.
    const idA = resolveCommandEveSeatIdentity({
      legacy: false,
      seatId: SEAT_A,
      seed: { kind: 'paste_brief', value: `${ENTITY_A}\nbrief tracer ${A_SCOPED_VALUE}` },
    });
    const idB = resolveCommandEveSeatIdentity({
      legacy: false,
      seatId: SEAT_B,
      seed: { kind: 'paste_brief', value: `${ENTITY_B}\nbrief tracer ${B_SCOPED_VALUE}` },
    });
    const promptA = buildCommandEveAssistantFirstRunContext({ appVersion: '1.1.1', seatIdentity: idA }, 'de-DE');
    const promptB = buildCommandEveAssistantFirstRunContext({ appVersion: '1.1.1', seatIdentity: idB }, 'de-DE');

    // A's prompt names A's client entity, never B's; and vice-versa.
    expect(promptA).toContain(ENTITY_A);
    expect(promptA).not.toContain(ENTITY_B);
    expect(promptB).toContain(ENTITY_B);
    expect(promptB).not.toContain(ENTITY_A);
  });

  it("(vi) ISO-6 — the onboarding GREETING for seat B never carries seat A's entity", () => {
    // Drive the live greeting builder for seat B with B's seed injected; assert
    // the rendered identity carries B's client, never A's operator/other entity.
    setActiveSeatId(SEAT_B);
    const result = buildCommandEveOnboardingStatus({
      userDataPath: USER_DATA,
      readEntitlement: () => ({ state: 'entitled' }) as never,
      readLicenseWirePresence: () => true,
      readActiveSeat: () => ({ legacy: false, seatId: SEAT_B }),
      readActiveSeatSeed: () => ({ kind: 'paste_brief', value: `${ENTITY_B}\nbrief tracer ${B_SCOPED_VALUE}` }),
    });
    expect(result.ok).toBe(true);
    const blob = JSON.stringify(result.model?.identity ?? {});
    expect(blob).toContain(ENTITY_B);
    expect(blob).not.toContain(ENTITY_A);
    expect(blob).not.toContain(SEAT_A);
  });

  it('switching A→B→A re-homes every dimension with zero residue from the other seat', () => {
    // Two switches must not bleed: each resolves ONLY its own surface.
    setActiveSeatId(SEAT_A);
    const a1 = captureActiveSeatSurface();
    setActiveSeatId(SEAT_B);
    const b1 = captureActiveSeatSurface();
    setActiveSeatId(SEAT_A);
    const a2 = captureActiveSeatSurface();

    // Returning to A reproduces A's surface byte-for-byte (deterministic, no
    // residue from the B interlude).
    expect(a2).toEqual(a1);
    // And B's surface shares no seat-scoped root with A's.
    expect(b1.hermesHome).not.toBe(a1.hermesHome);
    expect(b1.backendDataDir).not.toBe(a1.backendDataDir);
  });
});

// ===========================================================================
// INJECT-A-LEAK SELF-TEST — proves the gate FAILS RED on a real leak so it can
// never silently false-PASS. Mirrors migration-lint.sh's self-test discipline.
// ===========================================================================
describe('ISO-8 self-test — the disjointness oracle FAILS RED when isolation is broken', () => {
  /**
   * A deliberately BROKEN surface for seat B that IGNORES the seat and returns
   * seat A's values (the classic "resolver forgot the seat / fell back to the
   * global/active-A root" regression). Every dimension is poisoned with A's id
   * and A's tracer so the oracle has a leak to catch on each axis.
   */
  const brokenBSurface = (a: SeatSurface): SeatSurface => ({
    seatId: SEAT_B,
    // The leak: B's home resolves to A's home (a resolver that dropped the seat).
    hermesHome: a.hermesHome,
    configKeys: a.configKeys, // B re-uses A's namespaced config keys
    seedHome: a.seedHome, // B reads A's Company-Brain seed
    backendDataDir: a.backendDataDir, // B's backend serves A's conversation SQLite
    cacheDir: a.cacheDir,
    workDir: a.workDir,
    assistantsDir: a.assistantsDir,
    skillsDir: a.skillsDir,
    managedSkillsRoot: a.managedSkillsRoot,
  });

  it("a broken resolver that returns A's roots under B makes assertFullyDisjoint THROW", () => {
    setActiveSeatId(SEAT_A);
    writeCompanyBrainSeedToHome({
      hermesHome: resolveActiveSeatHome(USER_DATA).hermesHome,
      seed: { kind: 'paste_brief', value: `${ENTITY_A}\nbrief tracer ${A_SCOPED_VALUE}` },
    });
    const a = captureActiveSeatSurface();
    const leakyB = brokenBSurface(a);

    // The SAME oracle the green gate uses must FAIL on this leak. If it did NOT
    // throw, the gate would silently false-PASS on a real cross-seat bleed —
    // exactly the theatre this self-test exists to prevent.
    expect(() => assertFullyDisjoint(a, leakyB, { aToken: ENTITY_A, bToken: ENTITY_B })).toThrow();
  });

  it('each dimension independently is enough to trip the oracle (no single axis carries the whole proof)', () => {
    setActiveSeatId(SEAT_A);
    writeCompanyBrainSeedToHome({
      hermesHome: resolveActiveSeatHome(USER_DATA).hermesHome,
      seed: { kind: 'paste_brief', value: `${ENTITY_A}\nbrief tracer ${A_SCOPED_VALUE}` },
    });
    const a = captureActiveSeatSurface();
    setActiveSeatId(SEAT_B);
    writeCompanyBrainSeedToHome({
      hermesHome: resolveActiveSeatHome(USER_DATA).hermesHome,
      seed: { kind: 'paste_brief', value: `${ENTITY_B}\nbrief tracer ${B_SCOPED_VALUE}` },
    });
    const cleanB = captureActiveSeatSurface();

    // Poison ONE dimension at a time on an otherwise-clean B and confirm the
    // oracle still trips — proving each axis is actually load-bearing.
    const poisons: Array<(b: SeatSurface) => SeatSurface> = [
      (b) => ({ ...b, hermesHome: a.hermesHome }), // ISO-1
      (b) => ({ ...b, configKeys: a.configKeys }), // ISO-2
      (b) => ({ ...b, seedHome: a.seedHome }), // ISO-3
      (b) => ({ ...b, backendDataDir: a.backendDataDir }), // ISO-4 (--data-dir)
      (b) => ({ ...b, cacheDir: a.cacheDir, workDir: a.workDir }), // ISO-4 (workspace)
      (b) => ({ ...b, managedSkillsRoot: a.managedSkillsRoot, skillsDir: a.skillsDir }), // ISO-5
    ];
    for (const poison of poisons) {
      expect(() => assertFullyDisjoint(a, poison(cleanB), { aToken: ENTITY_A, bToken: ENTITY_B })).toThrow();
    }

    // Sanity floor: the CLEAN B (no poison) must PASS — otherwise the self-test
    // would trivially "catch" everything and prove nothing.
    expect(() => assertFullyDisjoint(a, cleanB, { aToken: ENTITY_A, bToken: ENTITY_B })).not.toThrow();
  });
});

// Best-effort cleanup of the tmp userData root AFTER the suite (never fail on it).
afterAll(() => {
  try {
    rmSync(USER_DATA, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
