/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Seat-Context-Bridge (S3 / spec B2) — USER.md TIER STAMP tests.
 *
 * Invariants proven:
 *  - idempotency: double-stamp with the SAME inputs is byte-identical;
 *  - grown-content survival: EVE-grown content outside the fences is untouched;
 *  - hard char budget (600/400) with a TRUNCATION LOG (never overflow);
 *  - §SEAT ABSENT in a legacy/founder seat; §FOUNDER present in EVERY seat;
 *  - a client seat's USER.md NEVER contains another seat's name (2-seat fixture).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  FOUNDER_BLOCK_MAX_CHARS,
  FOUNDER_MARKER_BEGIN,
  FOUNDER_MARKER_END,
  SEAT_BLOCK_MAX_CHARS,
  SEAT_MARKER_BEGIN,
  SEAT_MARKER_END,
  renderFounderBody,
  stampUserMdTiers,
  stampUserMdTiersToHome,
  truncateToBudget,
  type UserMdStampFs,
} from '@/process/commandEve/userMdTierStampCore';
import type { RuntimeBootstrapIdentityProfile } from '@/process/commandEve/runtimeBootstrapCore';
import { writeCompanyBrainSeedToHome } from '@/process/commandEve/companyBrainSeedCore';
import { resolveSeatHome } from '@/process/commandEve/seatContextCore';

const PROFILE: RuntimeBootstrapIdentityProfile = {
  version: 'command-eve-first-run-profile/v0',
  source: 'registration',
  confidence: 'verified',
  needs_confirmation: false,
  updated_at: '2026-07-01T00:00:00.000Z',
  founder_name: 'Mathias Heinke',
  company_name: 'FYN Labs',
};

/** An in-memory fs surface so the stamp unit-tests without touching disk. */
function makeMemFs(seed: Record<string, string> = {}): { fsImpl: UserMdStampFs; files: Record<string, string> } {
  const files: Record<string, string> = { ...seed };
  const dirs = new Set<string>();
  return {
    files,
    fsImpl: {
      existsSync: (p) => p in files || dirs.has(p),
      readFileSync: (p) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p];
      },
      writeFileSync: (p, data) => {
        files[p] = data;
      },
      mkdirSync: (p) => {
        dirs.add(p);
      },
    },
  };
}

const HOME = '/seat/home';
const userMd = path.join(HOME, 'memories', 'USER.md');

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('B2 stamp — §FOUNDER present in every seat, §SEAT gating', () => {
  it('legacy seat: §FOUNDER present, §SEAT ABSENT', () => {
    const { fsImpl, files } = makeMemFs();
    const r = stampUserMdTiersToHome({ hermesHome: HOME, legacy: true, profile: PROFILE, deps: { fsImpl } });
    expect(r.ok).toBe(true);
    expect(r.founderStamped).toBe(true);
    expect(r.seatStamped).toBe(false);
    const body = files[userMd];
    expect(body).toContain(FOUNDER_MARKER_BEGIN);
    expect(body).toContain('Mathias Heinke');
    expect(body).not.toContain(SEAT_MARKER_BEGIN);
  });

  it('real seat WITH a seed: §FOUNDER + §SEAT present', () => {
    const { fsImpl, files } = makeMemFs();
    const r = stampUserMdTiersToHome({
      hermesHome: HOME,
      legacy: false,
      profile: PROFILE,
      seed: { schema_version: 'v1', seeded_at: '', kind: 'connect_client', value: 'Bäckerei Müller' },
      deps: { fsImpl },
    });
    expect(r.founderStamped).toBe(true);
    expect(r.seatStamped).toBe(true);
    const body = files[userMd];
    expect(body).toContain(FOUNDER_MARKER_BEGIN);
    expect(body).toContain(SEAT_MARKER_BEGIN);
    expect(body).toContain('Bäckerei Müller');
  });

  it('real seat WITHOUT a seed: §FOUNDER present, §SEAT absent (honest omission)', () => {
    const { fsImpl, files } = makeMemFs();
    const r = stampUserMdTiersToHome({ hermesHome: HOME, legacy: false, profile: PROFILE, seed: null, deps: { fsImpl } });
    expect(r.seatStamped).toBe(false);
    expect(files[userMd]).toContain(FOUNDER_MARKER_BEGIN);
    expect(files[userMd]).not.toContain(SEAT_MARKER_BEGIN);
  });
});

describe('B2 stamp — idempotency + grown-content survival', () => {
  it('double-stamp with the SAME inputs is byte-identical', () => {
    const { fsImpl, files } = makeMemFs();
    stampUserMdTiersToHome({ hermesHome: HOME, legacy: false, profile: PROFILE, seed: { schema_version: 'v1', seeded_at: '', kind: 'paste_brief', value: 'Kunde A' }, deps: { fsImpl } });
    const first = files[userMd];
    stampUserMdTiersToHome({ hermesHome: HOME, legacy: false, profile: PROFILE, seed: { schema_version: 'v1', seeded_at: '', kind: 'paste_brief', value: 'Kunde A' }, deps: { fsImpl } });
    const second = files[userMd];
    expect(second).toBe(first);
  });

  it('EVE-grown content OUTSIDE the fences survives a re-stamp', () => {
    const grown = '# Operator notes\nEVE lernte: der Operator mag knappe Antworten.\n';
    const { fsImpl, files } = makeMemFs({ [userMd]: grown });
    stampUserMdTiersToHome({ hermesHome: HOME, legacy: true, profile: PROFILE, deps: { fsImpl } });
    expect(files[userMd]).toContain('EVE lernte: der Operator mag knappe Antworten.');
    expect(files[userMd]).toContain(FOUNDER_MARKER_BEGIN);
    // Re-stamp: grown content STILL there, fence still single (no dup).
    stampUserMdTiersToHome({ hermesHome: HOME, legacy: true, profile: PROFILE, deps: { fsImpl } });
    expect(files[userMd]).toContain('EVE lernte: der Operator mag knappe Antworten.');
    const beginCount = files[userMd].split(FOUNDER_MARKER_BEGIN).length - 1;
    expect(beginCount).toBe(1);
  });

  it('re-stamp replaces ONLY its own fenced block (updated profile → new content, one fence)', () => {
    const { fsImpl, files } = makeMemFs();
    stampUserMdTiersToHome({ hermesHome: HOME, legacy: true, profile: PROFILE, deps: { fsImpl } });
    expect(files[userMd]).toContain('FYN Labs');
    const updated = { ...PROFILE, company_name: 'FYN Labs GmbH' };
    stampUserMdTiersToHome({ hermesHome: HOME, legacy: true, profile: updated, deps: { fsImpl } });
    expect(files[userMd]).toContain('FYN Labs GmbH');
    expect(files[userMd].split(FOUNDER_MARKER_BEGIN).length - 1).toBe(1);
    expect(files[userMd].split(FOUNDER_MARKER_END).length - 1).toBe(1);
  });
});

describe('B2 stamp — hard char budgets (truncate + log, never overflow)', () => {
  it('truncateToBudget never exceeds the budget and flags truncation', () => {
    const long = 'x'.repeat(1000);
    const r = truncateToBudget(long, 100);
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBeLessThanOrEqual(100);
    expect(r.body.endsWith('…')).toBe(true);
    // A short body is untouched.
    const s = truncateToBudget('short', 100);
    expect(s.truncated).toBe(false);
    expect(s.body).toBe('short');
  });

  it('§SEAT body from a huge brief is truncated to ≤400 and LOGS', () => {
    const { fsImpl, files } = makeMemFs();
    const logs: string[] = [];
    const hugeBrief = 'Kunde: ' + 'A'.repeat(5000);
    const r = stampUserMdTiersToHome({
      hermesHome: HOME,
      legacy: false,
      profile: PROFILE,
      seed: { schema_version: 'v1', seeded_at: '', kind: 'paste_brief', value: hugeBrief },
      deps: { fsImpl, logTruncation: (m) => logs.push(m) },
    });
    expect(r.seatTruncated).toBe(true);
    expect(logs.some((l) => l.includes('§SEAT'))).toBe(true);
    // Extract the §SEAT block body and assert the hard budget.
    const body = files[userMd];
    const begin = body.indexOf(SEAT_MARKER_BEGIN) + SEAT_MARKER_BEGIN.length;
    const end = body.indexOf(SEAT_MARKER_END);
    const seatBody = body.slice(begin, end).replace(/^\n|\n$/g, '');
    expect(seatBody.length).toBeLessThanOrEqual(SEAT_BLOCK_MAX_CHARS);
  });

  it('§FOUNDER body budget is enforced at ≤600', () => {
    // A pathologically long company name forces truncation of the founder body.
    const bloated = { ...PROFILE, company_name: 'C'.repeat(2000) };
    const founderBody = renderFounderBody(bloated, 'de-DE');
    const r = truncateToBudget(founderBody, FOUNDER_BLOCK_MAX_CHARS);
    expect(r.body.length).toBeLessThanOrEqual(FOUNDER_BLOCK_MAX_CHARS);
    expect(FOUNDER_BLOCK_MAX_CHARS).toBe(600);
  });
});

describe('B2 stamp — cross-seat NAME isolation (2-seat fixture, real disk)', () => {
  it('a client seat USER.md NEVER contains another seat\'s name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-2seat-'));
    const SEAT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const SEAT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const homeA = resolveSeatHome(root, SEAT_A).hermesHome;
    const homeB = resolveSeatHome(root, SEAT_B).hermesHome;

    // Seed each seat with its OWN client (distinct names) via the real ISO-3 writer.
    writeCompanyBrainSeedToHome({ hermesHome: homeA, seed: { kind: 'connect_client', value: 'ACME_CLIENT_ALPHA' } });
    writeCompanyBrainSeedToHome({ hermesHome: homeB, seed: { kind: 'connect_client', value: 'BETA_CLIENT_OMEGA' } });

    // Stamp each seat's USER.md via the seat-aware wrapper (reads its OWN seed).
    stampUserMdTiers({ userDataPath: root, seatId: SEAT_A, profile: PROFILE });
    stampUserMdTiers({ userDataPath: root, seatId: SEAT_B, profile: PROFILE });

    const aMd = fs.readFileSync(path.join(homeA, 'memories', 'USER.md'), 'utf8');
    const bMd = fs.readFileSync(path.join(homeB, 'memories', 'USER.md'), 'utf8');

    // Each seat knows ONLY its own client; NEVER the other seat's.
    expect(aMd).toContain('ACME_CLIENT_ALPHA');
    expect(aMd).not.toContain('BETA_CLIENT_OMEGA');
    expect(bMd).toContain('BETA_CLIENT_OMEGA');
    expect(bMd).not.toContain('ACME_CLIENT_ALPHA');
  });

  it('the legacy seat carries §FOUNDER only — no §SEAT, even seat-aware', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-legacy-'));
    stampUserMdTiers({ userDataPath: root, seatId: 'seat-1', profile: PROFILE });
    const home = resolveSeatHome(root, 'seat-1').hermesHome;
    const md = fs.readFileSync(path.join(home, 'memories', 'USER.md'), 'utf8');
    expect(md).toContain(FOUNDER_MARKER_BEGIN);
    expect(md).not.toContain(SEAT_MARKER_BEGIN);
  });
});
