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
  migrateStrayRootMemoryBlock,
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
  it('(a) creates company-brain/seed.json + brief.md under the active seat home; NO root MEMORY.md write', () => {
    const userData = makeRoot();
    setActiveSeatId(SEAT_A);
    const result = writeCompanyBrainSeed({
      userDataPath: userData,
      seed: { kind: 'paste_brief', value: 'ACME GmbH — client A secret brief' },
    });

    const home = resolveSeatHome(userData, SEAT_A).hermesHome;
    expect(result.hermesHome).toBe(home);

    const seedJson = JSON.parse(fs.readFileSync(path.join(home, COMPANY_BRAIN_DIR, 'seed.json'), 'utf8'));
    expect(seedJson.schema_version).toBe(COMMAND_EVE_COMPANY_BRAIN_SEED_SCHEMA);
    expect(seedJson.kind).toBe('paste_brief');
    expect(seedJson.value).toContain('ACME');

    // The brief is the file the agent reads (linked from the §SEAT stamp).
    const brief = fs.readFileSync(path.join(home, COMPANY_BRAIN_DIR, 'brief.md'), 'utf8');
    expect(brief).toContain('ACME GmbH — client A secret brief');
    expect(path.resolve(result.briefPath)).toBe(path.resolve(path.join(home, COMPANY_BRAIN_DIR, 'brief.md')));

    // T1: the DEAD root-MEMORY.md write is gone — the wheel never loaded it.
    expect(fs.existsSync(path.join(home, 'MEMORY.md'))).toBe(false);

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
      expect(fs.statSync(result.seedJsonPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(result.briefPath).mode & 0o777).toBe(0o600);
    }
    // T1: brief.md is written for connect_client TOO (the §SEAT link always resolves).
    const brief = fs.readFileSync(result.briefPath, 'utf8');
    expect(brief).toContain('client-xyz');
    expect(path.basename(result.briefPath)).toBe('brief.md');
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
    const briefBExists = fs.existsSync(path.join(homeB, COMPANY_BRAIN_DIR, 'brief.md'));
    if (briefBExists) {
      expect(fs.readFileSync(path.join(homeB, COMPANY_BRAIN_DIR, 'brief.md'), 'utf8')).not.toContain('ACME');
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
    const briefA = fs.readFileSync(path.join(homeA, COMPANY_BRAIN_DIR, 'brief.md'), 'utf8');
    const briefB = fs.readFileSync(path.join(homeB, COMPANY_BRAIN_DIR, 'brief.md'), 'utf8');
    expect(briefA).toContain('A-only secret');
    expect(briefA).not.toContain('B-only secret');
    expect(briefB).toContain('B-only secret');
    expect(briefB).not.toContain('A-only secret');
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

    expect(fs.readFileSync(path.join(legacyHome, COMPANY_BRAIN_DIR, 'brief.md'), 'utf8')).toContain('legacy single-seat brief');
    expect(readCompanyBrainSeedStateFromHome(legacyHome).seeded).toBe(true);
  });
});

describe('idempotent re-seed', () => {
  it('(d) re-seeding REPLACES brief.md + seed.json in place — reflects the LATEST seed only', () => {
    const userData = makeRoot();
    setActiveSeatId(SEAT_A);
    const home = resolveSeatHome(userData, SEAT_A).hermesHome;

    writeCompanyBrainSeed({ userDataPath: userData, seed: { kind: 'paste_brief', value: 'first brief' } });
    writeCompanyBrainSeed({ userDataPath: userData, seed: { kind: 'paste_brief', value: 'second brief' } });

    const brief = fs.readFileSync(path.join(home, COMPANY_BRAIN_DIR, 'brief.md'), 'utf8');
    // The brief reflects the LATEST seed only (overwrite, not append).
    expect(brief).toContain('second brief');
    expect(brief).not.toContain('first brief');

    // seed.json reflects the latest.
    const seedJson = JSON.parse(fs.readFileSync(path.join(home, COMPANY_BRAIN_DIR, 'seed.json'), 'utf8'));
    expect(seedJson.value).toBe('second brief');

    // No root MEMORY.md is ever created by the write path.
    expect(fs.existsSync(path.join(home, 'MEMORY.md'))).toBe(false);
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
    for (const p of [result.seedJsonPath, result.briefPath].filter(Boolean) as string[]) {
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

// ── T1 — legacy dead-write migration (root MEMORY.md) ──────────────────────────
// A prior version wrote OUR "Client context (day-0 seed)" fence into the DEAD root
// <hermesHome>/MEMORY.md (the wheel only ever loads memories/MEMORY.md). The
// migration strips ONLY that fence, deletes the file if it becomes empty, NEVER
// touches foreign content outside the fence, and NEVER touches memories/.

const OUR_BEGIN = '<!-- command-eve:company-brain-seed:begin -->';
const OUR_END = '<!-- command-eve:company-brain-seed:end -->';
const legacyRootBlock = [
  OUR_BEGIN,
  '## Client context (day-0 seed)',
  '',
  '_Seeded 2026-06-29T00:00:00.000Z · source: Pasted brief_',
  '',
  '> STALE ACME client brief that the agent never actually read',
  OUR_END,
].join('\n');

describe('T1 migration — kill the stale legacy root-MEMORY.md seed block', () => {
  it('removes OUR fence and DELETES the file when only our block was in it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mig-only-'));
    tempRoots.push(home);
    const rootMemory = path.join(home, 'MEMORY.md');
    fs.writeFileSync(rootMemory, `${legacyRootBlock}\n`);

    const changed = migrateStrayRootMemoryBlock(home);
    expect(changed).toBe(true);
    // Founder-decision #3: the now-empty stale file is DELETED, not left behind.
    expect(fs.existsSync(rootMemory)).toBe(false);
    // Never touches the agent's own memories/ hot-cache.
    expect(fs.existsSync(path.join(home, 'memories', 'MEMORY.md'))).toBe(false);
  });

  it('strips ONLY our fence and PRESERVES foreign content around it (never deletes)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mig-foreign-'));
    tempRoots.push(home);
    const rootMemory = path.join(home, 'MEMORY.md');
    fs.writeFileSync(rootMemory, `# Foreign header the user typed\n\nkeep this line\n\n${legacyRootBlock}\n\n## Foreign tail\ntail survives\n`);

    const changed = migrateStrayRootMemoryBlock(home);
    expect(changed).toBe(true);
    // File still exists (had foreign content) and foreign content is intact.
    const after = fs.readFileSync(rootMemory, 'utf8');
    expect(after).toContain('# Foreign header the user typed');
    expect(after).toContain('keep this line');
    expect(after).toContain('## Foreign tail');
    expect(after).toContain('tail survives');
    // Our fence + its body are gone.
    expect(after).not.toContain(OUR_BEGIN);
    expect(after).not.toContain(OUR_END);
    expect(after).not.toContain('STALE ACME');
  });

  it('leaves a foreign root MEMORY.md (no OUR-fence) completely untouched', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mig-noop-'));
    tempRoots.push(home);
    const rootMemory = path.join(home, 'MEMORY.md');
    const foreign = '# Someone else wrote this\nno command-eve fence here\n';
    fs.writeFileSync(rootMemory, foreign);

    const changed = migrateStrayRootMemoryBlock(home);
    expect(changed).toBe(false);
    expect(fs.readFileSync(rootMemory, 'utf8')).toBe(foreign);
  });

  it('is idempotent — running twice, and on a clean/absent home, is a no-op', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mig-idem-'));
    tempRoots.push(home);
    // absent root file → no-op
    expect(migrateStrayRootMemoryBlock(home)).toBe(false);
    // seed it, then migrate twice: first migrates, second is a clean no-op
    const rootMemory = path.join(home, 'MEMORY.md');
    fs.writeFileSync(rootMemory, `${legacyRootBlock}\n`);
    expect(migrateStrayRootMemoryBlock(home)).toBe(true);
    expect(migrateStrayRootMemoryBlock(home)).toBe(false);
  });

  it('the seed write ALSO migrates a stale root block (writeCompanyBrainSeedToHome reports it)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mig-onwrite-'));
    tempRoots.push(home);
    fs.writeFileSync(path.join(home, 'MEMORY.md'), `${legacyRootBlock}\n`);

    const result = writeCompanyBrainSeedToHome({
      hermesHome: home,
      seed: { kind: 'paste_brief', value: 'fresh brief' },
    });
    expect(result.migratedRootMemory).toBe(true);
    // The stale root file is gone; the fresh brief lives in company-brain/.
    expect(fs.existsSync(path.join(home, 'MEMORY.md'))).toBe(false);
    expect(fs.readFileSync(path.join(home, COMPANY_BRAIN_DIR, 'brief.md'), 'utf8')).toContain('fresh brief');
  });

  it('the boot read path (readCompanyBrainSeedStateFromHome) runs the migration once', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mig-onread-'));
    tempRoots.push(home);
    fs.writeFileSync(path.join(home, 'MEMORY.md'), `${legacyRootBlock}\n`);

    // Reading "seeded?" at boot cleans up the dead root block as a side effect.
    const state = readCompanyBrainSeedStateFromHome(home);
    expect(state.seeded).toBe(false); // not seeded — but the stale file is cleaned
    expect(fs.existsSync(path.join(home, 'MEMORY.md'))).toBe(false);
  });
});
