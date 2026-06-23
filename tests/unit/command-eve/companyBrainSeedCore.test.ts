/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ISO-3 ADVERSARIAL per-seat seed leak-CI.
 *
 * Proves the Company-Brain seed actually PERSISTS into the ACTIVE seat's
 * hermesHome (NOT a NO-OP), is keyed to that seat ONLY (never cross-seat, never a
 * global path), is byte-compatible for the legacy/no-seat install, and is
 * idempotent on re-seed. The writer core is pure/injectable so it runs without
 * Electron.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  COMMAND_EVE_COMPANY_BRAIN_SEED_SCHEMA,
  COMPANY_BRAIN_DIR,
  readCompanyBrainSeedState,
  readCompanyBrainSeedStateFromHome,
  writeCompanyBrainSeed,
  writeCompanyBrainSeedToHome,
} from '@process/commandEve/companyBrainSeedCore';
import {
  __resetActiveSeatForTests,
  resolveSeatHome,
  setActiveSeatId,
} from '@process/commandEve/seatContextCore';

const tempRoots: string[] = [];

const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-company-brain-seed-test-'));
  tempRoots.push(root);
  return root;
};

const SEAT_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const SEAT_B = 'ffeeddcc-bbaa-4321-9988-776655443322';

beforeEach(() => {
  __resetActiveSeatForTests();
});

afterEach(() => {
  __resetActiveSeatForTests();
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('writeCompanyBrainSeed — the seed actually persists (NOT a no-op)', () => {
  it('(a) creates MEMORY.md block + company-brain/seed.json under the active seat home with the payload', () => {
    const userData = makeRoot();
    setActiveSeatId(SEAT_A);
    const result = writeCompanyBrainSeed({
      userDataPath: userData,
      seed: { kind: 'paste_brief', value: 'ACME GmbH — client A secret brief' },
    });

    const home = resolveSeatHome(userData, SEAT_A).hermesHome;
    expect(result.hermesHome).toBe(home);

    const memory = fs.readFileSync(path.join(home, 'MEMORY.md'), 'utf8');
    expect(memory).toContain('Client context (day-0 seed)');
    expect(memory).toContain('ACME GmbH — client A secret brief');

    const seedJson = JSON.parse(fs.readFileSync(path.join(home, COMPANY_BRAIN_DIR, 'seed.json'), 'utf8'));
    expect(seedJson.schema_version).toBe(COMMAND_EVE_COMPANY_BRAIN_SEED_SCHEMA);
    expect(seedJson.kind).toBe('paste_brief');
    expect(seedJson.value).toContain('ACME');

    // paste_brief also drops the raw brief verbatim.
    const brief = fs.readFileSync(path.join(home, COMPANY_BRAIN_DIR, 'brief.md'), 'utf8');
    expect(brief).toContain('ACME GmbH — client A secret brief');

    // seeded? is answerable from the on-disk evidence.
    expect(readCompanyBrainSeedState({ userDataPath: userData, seatId: SEAT_A }).seeded).toBe(true);
  });

  it('seed files are written with 0o600 (private like SOUL.md/config.yaml)', () => {
    const userData = makeRoot();
    setActiveSeatId(SEAT_A);
    const result = writeCompanyBrainSeed({
      userDataPath: userData,
      seed: { kind: 'connect_client', value: 'client-xyz' },
    });
    // Skip the mode assertion on platforms that don't honor unix modes.
    if (process.platform !== 'win32') {
      expect(fs.statSync(result.memoryPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(result.seedJsonPath).mode & 0o777).toBe(0o600);
    }
    // connect_client does NOT drop a raw brief.
    expect(result.briefPath).toBeNull();
  });
});

describe('cross-seat fence — disjoint homes, no leak', () => {
  it('(b) seat A seed never appears under seat B home; seeded? is per-seat', () => {
    const userData = makeRoot();

    setActiveSeatId(SEAT_A);
    writeCompanyBrainSeed({
      userDataPath: userData,
      seed: { kind: 'paste_brief', value: 'ACME GmbH — client A secret brief' },
    });

    setActiveSeatId(SEAT_B);
    const homeB = resolveSeatHome(userData, SEAT_B).hermesHome;

    // Negative: seat B home does not exist OR does not contain seat A's truth.
    const memoryBExists = fs.existsSync(path.join(homeB, 'MEMORY.md'));
    if (memoryBExists) {
      expect(fs.readFileSync(path.join(homeB, 'MEMORY.md'), 'utf8')).not.toContain('ACME');
    }
    expect(fs.existsSync(path.join(homeB, COMPANY_BRAIN_DIR, 'seed.json'))).toBe(false);

    // seeded? is per-seat: A true, B false.
    expect(readCompanyBrainSeedState({ userDataPath: userData, seatId: SEAT_A }).seeded).toBe(true);
    expect(readCompanyBrainSeedState({ userDataPath: userData, seatId: SEAT_B }).seeded).toBe(false);

    // The two seats' homes are disjoint and neither is a prefix of the other.
    const homeA = resolveSeatHome(userData, SEAT_A).hermesHome;
    expect(homeA).not.toBe(homeB);
    expect(homeA.startsWith(homeB)).toBe(false);
    expect(homeB.startsWith(homeA)).toBe(false);
  });

  it('seat B can seed its own truth without ever touching seat A', () => {
    const userData = makeRoot();
    setActiveSeatId(SEAT_A);
    writeCompanyBrainSeed({ userDataPath: userData, seed: { kind: 'paste_brief', value: 'A-only secret' } });
    setActiveSeatId(SEAT_B);
    writeCompanyBrainSeed({ userDataPath: userData, seed: { kind: 'paste_brief', value: 'B-only secret' } });

    const homeA = resolveSeatHome(userData, SEAT_A).hermesHome;
    const homeB = resolveSeatHome(userData, SEAT_B).hermesHome;
    expect(fs.readFileSync(path.join(homeA, 'MEMORY.md'), 'utf8')).toContain('A-only secret');
    expect(fs.readFileSync(path.join(homeA, 'MEMORY.md'), 'utf8')).not.toContain('B-only secret');
    expect(fs.readFileSync(path.join(homeB, 'MEMORY.md'), 'utf8')).toContain('B-only secret');
    expect(fs.readFileSync(path.join(homeB, 'MEMORY.md'), 'utf8')).not.toContain('A-only secret');
  });
});

describe('legacy / no-seat byte-compatibility', () => {
  it('(c) legacy active seat writes under <hermesRoot>/home (no seats/ segment)', () => {
    const userData = makeRoot();
    // active seat defaults to legacy (no setActiveSeatId call).
    const result = writeCompanyBrainSeed({
      userDataPath: userData,
      seed: { kind: 'paste_brief', value: 'legacy single-seat brief' },
    });

    const legacyHome = resolveSeatHome(userData, 'seat-1').hermesHome;
    expect(result.hermesHome).toBe(legacyHome);
    expect(legacyHome).not.toContain(`${path.sep}seats${path.sep}`);
    expect(legacyHome.endsWith(path.join('hermes', 'home'))).toBe(true);

    expect(fs.readFileSync(path.join(legacyHome, 'MEMORY.md'), 'utf8')).toContain('legacy single-seat brief');
    expect(readCompanyBrainSeedStateFromHome(legacyHome).seeded).toBe(true);
  });
});

describe('idempotent re-seed', () => {
  it('(d) re-seeding REPLACES the block in place — no duplicate blocks accumulate', () => {
    const userData = makeRoot();
    setActiveSeatId(SEAT_A);
    const home = resolveSeatHome(userData, SEAT_A).hermesHome;

    writeCompanyBrainSeed({ userDataPath: userData, seed: { kind: 'paste_brief', value: 'first brief' } });
    writeCompanyBrainSeed({ userDataPath: userData, seed: { kind: 'paste_brief', value: 'second brief' } });

    const memory = fs.readFileSync(path.join(home, 'MEMORY.md'), 'utf8');
    // Exactly ONE seed block.
    const beginCount = (memory.match(/command-eve:company-brain-seed:begin/g) || []).length;
    expect(beginCount).toBe(1);
    // The block reflects the LATEST seed only.
    expect(memory).toContain('second brief');
    expect(memory).not.toContain('first brief');

    // seed.json reflects the latest.
    const seedJson = JSON.parse(fs.readFileSync(path.join(home, COMPANY_BRAIN_DIR, 'seed.json'), 'utf8'));
    expect(seedJson.value).toBe('second brief');
  });

  it('preserves pre-existing MEMORY.md content outside the seed block', () => {
    const userData = makeRoot();
    setActiveSeatId(SEAT_A);
    const home = resolveSeatHome(userData, SEAT_A).hermesHome;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'MEMORY.md'), '# Existing notes\n\nkeep me\n');

    writeCompanyBrainSeed({ userDataPath: userData, seed: { kind: 'paste_brief', value: 'the seed' } });
    const memory = fs.readFileSync(path.join(home, 'MEMORY.md'), 'utf8');
    expect(memory).toContain('# Existing notes');
    expect(memory).toContain('keep me');
    expect(memory).toContain('the seed');
  });
});

describe('write confinement / guards (writer never escapes the seat home)', () => {
  it('(e) rejects a non-absolute hermesHome (cannot write outside a resolved seat home)', () => {
    expect(() =>
      writeCompanyBrainSeedToHome({ hermesHome: 'relative/home', seed: { kind: 'paste_brief', value: 'x' } })
    ).toThrow(/absolute hermesHome/);
  });

  it('a crafted active seatId cannot escape seats/ (resolver throws before any write)', () => {
    const userData = makeRoot();
    // setActiveSeatId fail-closes (throws) on an unsafe id, so it never becomes
    // active and the writer never runs against an escaped path.
    expect(() => setActiveSeatId('../../etc')).toThrow();
    // And writing directly via the seat-aware wrapper with a crafted id throws.
    expect(() =>
      writeCompanyBrainSeed({ userDataPath: userData, seatId: '../../etc', seed: { kind: 'paste_brief', value: 'x' } })
    ).toThrow();
  });

  it('all written paths stay strictly under the resolved seat home', () => {
    const userData = makeRoot();
    setActiveSeatId(SEAT_A);
    const home = resolveSeatHome(userData, SEAT_A).hermesHome;
    const result = writeCompanyBrainSeed({
      userDataPath: userData,
      seed: { kind: 'paste_brief', value: 'contained' },
    });
    for (const p of [result.memoryPath, result.seedJsonPath, result.briefPath].filter(Boolean) as string[]) {
      expect(path.resolve(p).startsWith(path.resolve(home) + path.sep)).toBe(true);
    }
  });

  it('refuses a blank/whitespace seed (no real switching-cost seed)', () => {
    const userData = makeRoot();
    setActiveSeatId(SEAT_A);
    expect(() =>
      writeCompanyBrainSeed({ userDataPath: userData, seed: { kind: 'paste_brief', value: '   ' } })
    ).toThrow();
  });
});

describe('global-store NON-write', () => {
  it('(f) does not write any global config/command-eve-config.txt — the seed lives ONLY under hermesHome', () => {
    const userData = makeRoot();
    setActiveSeatId(SEAT_A);
    writeCompanyBrainSeed({
      userDataPath: userData,
      seed: { kind: 'paste_brief', value: 'ACME confidential' },
    });

    // The seed must not appear anywhere outside the seats/<id>/home subtree.
    const home = resolveSeatHome(userData, SEAT_A).hermesHome;
    const offending: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          try {
            if (fs.readFileSync(full, 'utf8').includes('ACME confidential')) offending.push(full);
          } catch {
            /* binary / unreadable */
          }
        }
      }
    };
    walk(userData);
    // Every hit must be under the seat home.
    for (const f of offending) {
      expect(path.resolve(f).startsWith(path.resolve(home) + path.sep)).toBe(true);
    }
    expect(offending.length).toBeGreaterThan(0);
  });
});
