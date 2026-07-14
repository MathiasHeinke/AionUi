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
  renderSeatBody,
  stampUserMdTiers,
  stampUserMdTiersToHome,
  truncateToBudget,
  upsertFencedBlock,
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
    // T1/T7: §SEAT v2 points at the LIVING brief.md by its ABSOLUTE path so the
    // agent never resolves it against workspace cwd (NOT the dead root MEMORY.md).
    expect(body).toContain(path.join('company-brain', 'brief.md'));
    expect(body).toContain(path.join(HOME, 'company-brain', 'brief.md'));
    expect(body).not.toContain('MEMORY.md');
    // Budget: the §SEAT body stays within the hard ≤400c budget.
    const begin = body.indexOf(SEAT_MARKER_BEGIN) + SEAT_MARKER_BEGIN.length;
    const end = body.indexOf(SEAT_MARKER_END);
    const seatBody = body.slice(begin, end).replace(/^\n|\n$/g, '');
    expect(seatBody.length).toBeLessThanOrEqual(SEAT_BLOCK_MAX_CHARS);
  });

  it('real seat WITHOUT a seed: §FOUNDER present, §SEAT absent (honest omission)', () => {
    const { fsImpl, files } = makeMemFs();
    const r = stampUserMdTiersToHome({
      hermesHome: HOME,
      legacy: false,
      profile: PROFILE,
      seed: null,
      deps: { fsImpl },
    });
    expect(r.seatStamped).toBe(false);
    expect(files[userMd]).toContain(FOUNDER_MARKER_BEGIN);
    expect(files[userMd]).not.toContain(SEAT_MARKER_BEGIN);
  });
});

describe('B2 stamp — idempotency + grown-content survival', () => {
  it('double-stamp with the SAME inputs is byte-identical', () => {
    const { fsImpl, files } = makeMemFs();
    stampUserMdTiersToHome({
      hermesHome: HOME,
      legacy: false,
      profile: PROFILE,
      seed: { schema_version: 'v1', seeded_at: '', kind: 'paste_brief', value: 'Kunde A' },
      deps: { fsImpl },
    });
    const first = files[userMd];
    stampUserMdTiersToHome({
      hermesHome: HOME,
      legacy: false,
      profile: PROFILE,
      seed: { schema_version: 'v1', seeded_at: '', kind: 'paste_brief', value: 'Kunde A' },
      deps: { fsImpl },
    });
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

describe('T9 operator-vs-client role semantics — §SEAT + §FOUNDER bodies', () => {
  const seed = { schema_version: 'v1', seeded_at: '', kind: 'paste_brief' as const, value: 'Bäckerei Müller GmbH' };
  const REAL_BRAIN = '/Users/mathias/Library/Application Support/Command EVE/seats/kunde-x/hermes/home/company-brain';

  it('§SEAT de carries the operator-vs-client role sentence', () => {
    const body = renderSeatBody(seed, 'de-DE', REAL_BRAIN);
    expect(body).toContain('Dein Operator bedient dich hier im Auftrag des Kunden, nicht für seine eigene Firma.');
    // The isolation doctrine still present.
    expect(body).toContain('der Seat-Name erscheint nie in Deliverables');
  });

  it('§SEAT en carries the operator-vs-client role sentence', () => {
    const body = renderSeatBody(seed, 'en-US', REAL_BRAIN);
    expect(body).toContain("Your operator runs you here on the client's behalf, not for their own firm.");
    expect(body).toContain('the seat name never appears in deliverables');
  });

  it('§SEAT budget holds: with a REAL absolute brain path the truncated block ≤400c and the role + isolation doctrine survive (the long path trims first)', () => {
    const { fsImpl, files } = makeMemFs();
    const r = stampUserMdTiersToHome({
      hermesHome: REAL_BRAIN.replace(/\/company-brain$/, ''),
      legacy: false,
      profile: PROFILE,
      seed,
      deps: { fsImpl },
    });
    expect(r.seatStamped).toBe(true);
    const seatHome = REAL_BRAIN.replace(/\/company-brain$/, '');
    const body = files[path.join(seatHome, 'memories', 'USER.md')];
    const begin = body.indexOf(SEAT_MARKER_BEGIN) + SEAT_MARKER_BEGIN.length;
    const end = body.indexOf(SEAT_MARKER_END);
    const seatBody = body.slice(begin, end).replace(/^\n|\n$/g, '');
    expect(seatBody.length).toBeLessThanOrEqual(SEAT_BLOCK_MAX_CHARS);
    // Fixed doctrine (role + isolation) survives even though the absolute path is present.
    expect(seatBody).toContain('Dein Operator bedient dich hier im Auftrag des Kunden');
    expect(seatBody).toContain('der Seat-Name erscheint nie in Deliverables');
  });

  it('§FOUNDER body carries the operator-role half-sentence (both locales) and stays ≤600c', () => {
    const de = renderFounderBody(PROFILE, 'de-DE');
    expect(de).toContain('in Kunden-Seats handelt er im Auftrag des jeweiligen Kunden, nicht für seine eigene Firma');
    expect(de.length).toBeLessThanOrEqual(FOUNDER_BLOCK_MAX_CHARS);
    const en = renderFounderBody(PROFILE, 'en-US');
    expect(en).toContain("in client seats they act on the respective client's behalf, not for their own firm");
    expect(en.length).toBeLessThanOrEqual(FOUNDER_BLOCK_MAX_CHARS);
  });
});

describe('K3 kind-conditioned §SEAT doctrine (own_company drops client doctrine)', () => {
  const seed = { schema_version: 'v1', seeded_at: '', kind: 'paste_brief' as const, value: 'FYN Labs GmbH' };
  const REAL_BRAIN = '/Users/mathias/Library/Application Support/Command EVE/seats/eigen/hermes/home/company-brain';

  it('client (default) is BYTE-IDENTICAL to an explicit client kind (regression proof)', () => {
    for (const locale of ['de-DE', 'en-US'] as const) {
      const implicit = renderSeatBody(seed, locale, REAL_BRAIN);
      const explicit = renderSeatBody(seed, locale, REAL_BRAIN, 'client');
      expect(explicit).toBe(implicit);
    }
  });

  it('own_company (de) DROPS invisible-delivery AND "im Auftrag des Kunden", KEEPS data-isolation', () => {
    const body = renderSeatBody(seed, 'de-DE', REAL_BRAIN, 'own_company')!;
    expect(body).not.toContain('im Auftrag des Kunden');
    expect(body).not.toContain('erscheint nie in Deliverables');
    expect(body).toContain('er ist hier selbst der Auftraggeber');
    expect(body).toContain('bleiben in diesem Seat'); // data-isolation kept
  });

  it('own_company (en) DROPS invisible-delivery AND the client-behalf sentence, KEEPS isolation', () => {
    const body = renderSeatBody(seed, 'en-US', REAL_BRAIN, 'own_company')!;
    expect(body).not.toContain('on the client');
    expect(body).not.toContain('never appears in deliverables');
    expect(body).toContain('they are the client here');
    expect(body).toContain('stays in this seat');
  });

  it('department (de/en) KEEPS invisible-delivery (conservative) but NOT "im Auftrag des Kunden"', () => {
    const de = renderSeatBody(seed, 'de-DE', REAL_BRAIN, 'department')!;
    expect(de).toContain('erscheint nie in Deliverables');
    expect(de).not.toContain('im Auftrag des Kunden');
    expect(de).toContain('Abteilung/ein Bereich des Operators');
    const en = renderSeatBody(seed, 'en-US', REAL_BRAIN, 'department')!;
    expect(en).toContain('never appears in deliverables');
    expect(en).not.toContain("on the client's behalf");
    expect(en).toContain('departments/areas');
  });

  it('all kinds stay within the ≤400c §SEAT budget after stamping (own_company is shorter than client)', () => {
    for (const kind of ['client', 'own_company', 'department'] as const) {
      const { fsImpl, files } = makeMemFs();
      const seatHome = REAL_BRAIN.replace(/\/company-brain$/, '');
      const r = stampUserMdTiersToHome({
        hermesHome: seatHome,
        legacy: false,
        profile: PROFILE,
        seed,
        kind,
        deps: { fsImpl },
      });
      expect(r.seatStamped).toBe(true);
      const body = files[path.join(seatHome, 'memories', 'USER.md')];
      const seatBody = body
        .slice(body.indexOf(SEAT_MARKER_BEGIN) + SEAT_MARKER_BEGIN.length, body.indexOf(SEAT_MARKER_END))
        .replace(/^\n|\n$/g, '');
      expect(seatBody.length).toBeLessThanOrEqual(SEAT_BLOCK_MAX_CHARS);
    }
  });
});

describe('B2 stamp — cross-seat NAME isolation (2-seat fixture, real disk)', () => {
  it("a client seat USER.md NEVER contains another seat's name", () => {
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

// ── H4 — fence-corruption hardening (upsertFencedBlock) ────────────────────────
// USER.md is agent-writable, so an EVE edit CAN drop/reorder a fence marker. A
// half/reversed fence must NEVER silently append (leaving an orphan that later
// swallows grown content or duplicates per boot). It must be repaired
// deterministically, and a well-formed fence must be left completely alone.

describe('H4 upsertFencedBlock — corrupt-fence hardening', () => {
  const B = FOUNDER_MARKER_BEGIN;
  const E = FOUNDER_MARKER_END;
  const block = `${B}\n§ FOUNDER v2\n${E}`;

  const beginCount = (s: string) => s.split(B).length - 1;
  const endCount = (s: string) => s.split(E).length - 1;

  it('well-formed fence: replaces in place, exactly one fence, grown prose survives (regression guard)', () => {
    const existing = `# Notes\ngrown line\n\n${B}\n§ FOUNDER v1\n${E}\n\n# Tail\ntail line\n`;
    const out = upsertFencedBlock(existing, B, E, block);
    expect(out).toContain('§ FOUNDER v2');
    expect(out).not.toContain('§ FOUNDER v1');
    expect(out).toContain('grown line');
    expect(out).toContain('tail line');
    expect(beginCount(out)).toBe(1);
    expect(endCount(out)).toBe(1);
  });

  it('orphan BEGIN (no END): grown content is NOT lost, exactly one clean fence results', () => {
    // A dropped END left an orphan BEGIN above grown prose. The OLD code would
    // append below and, on the next read, the orphan BEGIN + new END would swallow
    // "PRECIOUS grown insight".
    const existing = `${B}\n§ FOUNDER stale\n\nPRECIOUS grown insight EVE wrote\n`;
    const out = upsertFencedBlock(existing, B, E, block);
    expect(out).toContain('PRECIOUS grown insight EVE wrote'); // no content loss
    expect(out).toContain('§ FOUNDER v2');
    expect(beginCount(out)).toBe(1); // the orphan was cleaned, only the fresh BEGIN remains
    expect(endCount(out)).toBe(1);
    // Re-stamp is now idempotent-safe (well-formed) — no duplication.
    const out2 = upsertFencedBlock(out, B, E, block);
    expect(beginCount(out2)).toBe(1);
    expect(endCount(out2)).toBe(1);
  });

  it('stray END (no BEGIN): no duplicate fence after two stamps', () => {
    const existing = `some grown note\n${E}\nmore grown note\n`;
    const out1 = upsertFencedBlock(existing, B, E, block);
    // The stray END token is gone; grown notes survive.
    expect(out1).toContain('some grown note');
    expect(out1).toContain('more grown note');
    expect(beginCount(out1)).toBe(1);
    expect(endCount(out1)).toBe(1);
    // Stamp AGAIN: still exactly one fence (no per-boot duplication).
    const out2 = upsertFencedBlock(out1, B, E, block);
    expect(beginCount(out2)).toBe(1);
    expect(endCount(out2)).toBe(1);
  });

  it('reversed markers (END before BEGIN): repaired deterministically to one clean fence', () => {
    const existing = `${E}\ngrown middle\n${B}\n`;
    const out = upsertFencedBlock(existing, B, E, block);
    expect(out).toContain('grown middle'); // prose between the reversed markers survives
    expect(out).toContain('§ FOUNDER v2');
    expect(beginCount(out)).toBe(1);
    expect(endCount(out)).toBe(1);
    // Deterministic: repeating on the same corrupt input yields the same result.
    const outAgain = upsertFencedBlock(`${E}\ngrown middle\n${B}\n`, B, E, block);
    expect(outAgain).toBe(out);
  });

  it('duplicate stray marker alongside a well-formed pair is scrubbed to one fence', () => {
    const existing = `${B}\n§ FOUNDER v1\n${E}\ngrown\n${B}\n`; // extra orphan BEGIN below
    const out = upsertFencedBlock(existing, B, E, block);
    expect(out).toContain('grown');
    expect(beginCount(out)).toBe(1);
    expect(endCount(out)).toBe(1);
    expect(out).toContain('§ FOUNDER v2');
  });
});

// ── H8 — code-point-safe truncation (no split surrogate → no U+FFFD) ───────────

describe('H8 truncateToBudget — surrogate-pair safety', () => {
  const REPLACEMENT = '�';

  it('an emoji at the budget boundary is NOT split into a lone surrogate (no U+FFFD)', () => {
    // Build a body where the naive UTF-16 cut (budget-1) would land INSIDE the
    // surrogate pair of a trailing emoji.
    const budget = 10;
    const body = 'abcdefgh' + '😀' + 'zzzz'; // '😀' occupies code units 8 and 9
    const r = truncateToBudget(body, budget);
    expect(r.truncated).toBe(true);
    // No replacement char anywhere — the emoji was dropped whole, never half-cut.
    expect(r.body).not.toContain(REPLACEMENT);
    // Still within the code-unit budget.
    expect(r.body.length).toBeLessThanOrEqual(budget);
    expect(r.body.endsWith('…')).toBe(true);
  });

  it('a full run of astral chars truncates cleanly on code-point boundaries', () => {
    const body = '🎉'.repeat(50); // 100 UTF-16 code units, 50 code points
    const r = truncateToBudget(body, 20);
    expect(r.truncated).toBe(true);
    expect(r.body).not.toContain(REPLACEMENT);
    expect(r.body.length).toBeLessThanOrEqual(20);
    // Every emoji in the result is intact (no lone surrogate): the code-point count
    // (minus the ellipsis) times 2 equals the code-unit length of the emoji run.
    const emojiOnly = r.body.replace('…', '');
    expect([...emojiOnly].every((cp) => cp === '🎉')).toBe(true);
  });

  it('ASCII truncation is unchanged (still ≤ budget, ellipsis appended)', () => {
    const r = truncateToBudget('x'.repeat(1000), 100);
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBeLessThanOrEqual(100);
    expect(r.body.endsWith('…')).toBe(true);
  });
});
