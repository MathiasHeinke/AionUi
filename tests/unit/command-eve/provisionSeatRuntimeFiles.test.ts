/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * T0 — PER-SEAT RUNTIME PROVISIONING ON SEAT SWITCH.
 *
 * THE VERIFIED BUG: the Hermes runtime files of a seat home — config.yaml (with
 * memory_enabled:true, user_profile_enabled:true, data_boundary, nudge intervals),
 * SOUL.md, skills-command-eve — are written ONLY by the boot bootstrap, and at boot
 * the active seat is ALWAYS the legacy/founder home (there is no boot-restore of a
 * saved seat). A seat SWITCH re-homes HERMES_HOME + re-spawns the agent but never
 * provisioned the TARGET client seat home. Result: every real client seat ran on
 * WHEEL DEFAULTS — memory_enabled=FALSE, no SOUL.md, no EVE skills.
 *
 * These tests exercise the REAL provisioning naht (`provisionSeatRuntimeFiles`) the
 * seat-switch prepareEnv thunk now calls, against a REAL temp seat home resolved
 * through the SAME `resolveCommandEveRuntimeBootstrapPaths` factory the runtime
 * uses — mirroring the established pattern in runtimeBootstrapSeatScoping.test.ts.
 *
 * INVARIANTS UNDER TEST:
 *   (a) after a switch to a FRESH seat home, config.yaml (memory_enabled: true) +
 *       SOUL.md exist IN THAT SEAT HOME (not the legacy home).
 *   (b) a second provisioning pass is BYTE-IDEMPOTENT (same content).
 *   (c) EVE-GROWN files in the seat home (memories/USER.md + an agent-created skill)
 *       SURVIVE provisioning untouched.
 *   (d) two distinct seats get DISJOINT, independently-provisioned homes.
 *   (e) a crafted/unsafe seat id fails BEST-EFFORT (ok:false) rather than escaping seats/.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  provisionSeatRuntimeFiles,
  resolveCommandEveRuntimeBootstrapPaths,
} from '@/process/commandEve/runtimeBootstrapCore';
import {
  SEATS_SUBDIR,
  __resetActiveSeatForTests,
  clearActiveSeat,
  setActiveSeatId,
} from '@/process/commandEve/seatContextCore';

const REAL_UUID_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const REAL_UUID_B = 'ffeeddcc-bbaa-4321-9988-776655443322';

const tempRoots: string[] = [];
const makeUserData = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-provision-seat-test-'));
  tempRoots.push(root);
  return root;
};

afterEach(() => {
  __resetActiveSeatForTests();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('(a) provisioning a fresh TARGET seat home', () => {
  it('writes config.yaml (memory_enabled: true) + SOUL.md into the seat home, NOT the legacy home', () => {
    const userData = makeUserData();
    // Simulate the switch step (a): the active seat is now the target.
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    expect(seatHome).toContain(`${path.sep}${SEATS_SUBDIR}${path.sep}${REAL_UUID_A}${path.sep}`);

    // Before: the fresh client seat home has NO runtime files (the bug).
    expect(fs.existsSync(path.join(seatHome, 'config.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(seatHome, 'SOUL.md'))).toBe(false);

    const result = provisionSeatRuntimeFiles({ userDataPath: userData });
    expect(result.ok).toBe(true);
    expect(result.hermes_home).toBe(seatHome);
    expect(result.memory_enabled).toBe(true);

    // After: both Desktop-OWNED files exist in the TARGET seat home.
    const configPath = path.join(seatHome, 'config.yaml');
    const soulPath = path.join(seatHome, 'SOUL.md');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(soulPath)).toBe(true);

    // The config.yaml carries the memory wiring the wheel defaults OFF.
    const config = fs.readFileSync(configPath, 'utf8');
    expect(config).toContain('memory_enabled: true');
    expect(config).toContain('user_profile_enabled: true');

    // The legacy/founder home was NOT provisioned as a side effect.
    const legacyHome = resolveCommandEveRuntimeBootstrapPaths(userData, 'seat-1').hermesHome;
    expect(legacyHome).not.toBe(seatHome);
    expect(fs.existsSync(path.join(legacyHome, 'config.yaml'))).toBe(false);
  });

  it('writes the skills-command-eve managed dir into the seat home', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const paths = resolveCommandEveRuntimeBootstrapPaths(userData);
    const result = provisionSeatRuntimeFiles({ userDataPath: userData });
    expect(result.ok).toBe(true);
    // managedSkillsRoot lives directly under the seat home; it exists + is populated
    // with at least the onboarding stubs (bundledSkillsDir is '' here → stubs only).
    expect(fs.existsSync(paths.managedSkillsRoot)).toBe(true);
    expect(fs.readdirSync(paths.managedSkillsRoot).length).toBeGreaterThan(0);
  });

  it('files are written 0600 (owner-only), matching the boot path', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    provisionSeatRuntimeFiles({ userDataPath: userData });
    const configMode = fs.statSync(path.join(seatHome, 'config.yaml')).mode & 0o777;
    const soulMode = fs.statSync(path.join(seatHome, 'SOUL.md')).mode & 0o777;
    expect(configMode).toBe(0o600);
    expect(soulMode).toBe(0o600);
  });
});

describe('(b) idempotency — a second switch is byte-identical', () => {
  it('a second provisioning pass produces byte-identical config.yaml + SOUL.md', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;

    provisionSeatRuntimeFiles({ userDataPath: userData });
    const config1 = fs.readFileSync(path.join(seatHome, 'config.yaml'), 'utf8');
    const soul1 = fs.readFileSync(path.join(seatHome, 'SOUL.md'), 'utf8');

    // A second switch back onto this seat re-provisions.
    const result2 = provisionSeatRuntimeFiles({ userDataPath: userData });
    expect(result2.ok).toBe(true);
    const config2 = fs.readFileSync(path.join(seatHome, 'config.yaml'), 'utf8');
    const soul2 = fs.readFileSync(path.join(seatHome, 'SOUL.md'), 'utf8');

    expect(config2).toBe(config1);
    expect(soul2).toBe(soul1);
  });
});

describe('(c) EVE-GROWN state survives provisioning', () => {
  it('memories/USER.md and an agent-created skill are NOT touched', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    const seatHome = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;

    // Model an already-provisioned + EVE-grown seat home: create the home, an
    // agent-grown memory file, and an agent-created skill under the PRIMARY skills
    // dir (NOT the Desktop-managed skills-command-eve).
    const memDir = path.join(seatHome, 'memories');
    fs.mkdirSync(memDir, { recursive: true });
    const userMdPath = path.join(memDir, 'USER.md');
    const memoryMdPath = path.join(memDir, 'MEMORY.md');
    fs.writeFileSync(userMdPath, '# Operator\nName: Alois (EVE-grown)\n', { mode: 0o600 });
    fs.writeFileSync(memoryMdPath, '# Working notes EVE grew\n', { mode: 0o600 });

    const agentSkillDir = path.join(seatHome, 'skills', 'agent-invented-skill');
    fs.mkdirSync(agentSkillDir, { recursive: true });
    const agentSkillPath = path.join(agentSkillDir, 'SKILL.md');
    fs.writeFileSync(agentSkillPath, '# A skill EVE created for this client\n', { mode: 0o600 });

    const userMdBefore = fs.readFileSync(userMdPath, 'utf8');
    const memoryMdBefore = fs.readFileSync(memoryMdPath, 'utf8');
    const agentSkillBefore = fs.readFileSync(agentSkillPath, 'utf8');

    const result = provisionSeatRuntimeFiles({ userDataPath: userData });
    expect(result.ok).toBe(true);

    // EVE-grown files are byte-for-byte untouched.
    expect(fs.readFileSync(userMdPath, 'utf8')).toBe(userMdBefore);
    expect(fs.readFileSync(memoryMdPath, 'utf8')).toBe(memoryMdBefore);
    expect(fs.readFileSync(agentSkillPath, 'utf8')).toBe(agentSkillBefore);

    // And the Desktop-owned files were still written alongside.
    expect(fs.existsSync(path.join(seatHome, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(seatHome, 'SOUL.md'))).toBe(true);
  });
});

describe('(d) two distinct seats get disjoint, independently-provisioned homes', () => {
  it('provisions seat A and seat B into separate homes', () => {
    const userData = makeUserData();

    setActiveSeatId(REAL_UUID_A);
    const homeA = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    const resA = provisionSeatRuntimeFiles({ userDataPath: userData });

    setActiveSeatId(REAL_UUID_B);
    const homeB = resolveCommandEveRuntimeBootstrapPaths(userData).hermesHome;
    const resB = provisionSeatRuntimeFiles({ userDataPath: userData });

    expect(resA.ok && resB.ok).toBe(true);
    expect(homeA).not.toBe(homeB);
    expect(fs.existsSync(path.join(homeA, 'config.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(homeB, 'config.yaml'))).toBe(true);
  });

  it('an explicit seatId provisions that seat regardless of the active seat', () => {
    const userData = makeUserData();
    setActiveSeatId(REAL_UUID_A);
    // Provision B explicitly while A is active.
    const result = provisionSeatRuntimeFiles({ userDataPath: userData, seatId: REAL_UUID_B });
    const homeB = resolveCommandEveRuntimeBootstrapPaths(userData, REAL_UUID_B).hermesHome;
    expect(result.ok).toBe(true);
    expect(result.hermes_home).toBe(homeB);
    expect(fs.existsSync(path.join(homeB, 'config.yaml'))).toBe(true);
    // A was NOT provisioned by the explicit-B call.
    const homeA = resolveCommandEveRuntimeBootstrapPaths(userData, REAL_UUID_A).hermesHome;
    expect(fs.existsSync(path.join(homeA, 'config.yaml'))).toBe(false);
  });
});

describe('(e) fail-safe — an unsafe seat id never escapes seats/', () => {
  it('a crafted target id yields ok:false + an error, and writes NO config.yaml', () => {
    const userData = makeUserData();
    clearActiveSeat();
    const result = provisionSeatRuntimeFiles({ userDataPath: userData, seatId: '../../escape' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // Nothing escaped into the runtime root.
    const runtimeRoot = path.join(path.resolve(userData), 'command-eve-runtime');
    // A crafted home would sit outside seats/; assert no stray config.yaml exists anywhere under the runtime root.
    const stray: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === 'config.yaml') stray.push(full);
      }
    };
    walk(runtimeRoot);
    expect(stray).toEqual([]);
  });
});
