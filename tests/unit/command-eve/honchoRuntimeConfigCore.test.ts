/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HONCHO-1 — the PURE per-seat Honcho runtime config core. This battery pins the
 * three invariants that make a leak/overbill structurally impossible:
 *
 *   ISOLATION — two seats get DISJOINT db + workspace + honchoHome; a crafted id
 *     can never become a db name or path; the db name is opaque (H3, never the
 *     label, never even the id).
 *   MONEY — the cloud-Flash deriver is HARD-pinned to the FREE 'standard' tier
 *     across the full opt-in × ready × license cartesian; there is no code path to
 *     a paid tier (no selection parameter exists).
 *   EGRESS — the cloud deriver base is ALWAYS a loopback shim (never the edge fn),
 *     so the deriver's derivation text rides the shim's PII redaction; the guard
 *     THROWS on any non-loopback base; and a source-level grep-gate proves the
 *     module can not name the edge lane.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EVE_INFERENCE_FUNCTION_URL } from '@/common/config/eveInferenceCore';
import { resolveSeatHome, type SeatHomePaths } from '@/process/commandEve/seatContextCore';
import {
  HONCHO_DEFAULT_LOCAL_MODEL_REF,
  HONCHO_DERIVER_BRANCH_CLOUD,
  HONCHO_DERIVER_BRANCH_LOCAL,
  HONCHO_DERIVER_FORCED_TIER,
  HONCHO_PG_MAX_IDENT,
  buildHonchoRuntimeConfig,
  hardenPgIdent,
  honchoDbNameForSeat,
  honchoWorkspaceIdForSeat,
  requireLoopbackShimBase,
  resolveHonchoDeriverConfig,
  type HonchoRuntimeConfigInput,
} from '@/process/commandEve/honchoRuntimeConfigCore';

const USER_DATA = '/tmp/command-eve-honcho-test-userdata';
const REAL_UUID_A = 'a1b2c3d4-e5f6-4789-aabb-ccddeeff0011';
const REAL_UUID_B = 'ffeeddcc-bbaa-4321-9988-776655443322';
const LABELISH_UUID = REAL_UUID_A; // a seat whose human label might be "Alois GmbH"

/** Build a valid seatHome for a (safe) id — the caller-supplied context the core reads. */
function seatHomeFor(seatId?: string | null): SeatHomePaths {
  return resolveSeatHome(USER_DATA, seatId);
}

/** A minimal input over a seat + deriver flags (deriver defaults to cloud fallback). */
function inputFor(seatId: string | null | undefined, over: Partial<HonchoRuntimeConfigInput> = {}): HonchoRuntimeConfigInput {
  // For an unsafe id, seatHome can't be resolved — pass a legacy home; the core
  // throws on the raw seatId before it ever reads seatHome.
  let home: SeatHomePaths;
  try {
    home = seatHomeFor(seatId);
  } catch {
    home = seatHomeFor(undefined);
  }
  return { seatId, seatHome: home, ...over };
}

const PG_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

describe('honchoRuntimeConfigCore — ISOLATION', () => {
  it('1 — legacy/no-seat maps byte-stable to honcho_seat_1 + workspace seat-1, no seats/ segment', () => {
    for (const legacyId of [undefined, null, '', 'default', 'seat-1'] as const) {
      const cfg = buildHonchoRuntimeConfig(inputFor(legacyId));
      expect(cfg.legacy).toBe(true);
      expect(cfg.seatId).toBe('seat-1');
      expect(cfg.dbName).toBe('honcho_seat_1');
      expect(cfg.workspaceId).toBe('seat-1');
      expect(cfg.honchoHome).toContain(`${path.sep}hermes${path.sep}home${path.sep}honcho`);
      expect(cfg.honchoHome).not.toContain(`${path.sep}seats${path.sep}`);
    }
  });

  it('2 — a real uuid seat gets an opaque hashed db, ws_<id> workspace, honcho home under seats/<id>', () => {
    const cfg = buildHonchoRuntimeConfig(inputFor(REAL_UUID_A));
    expect(cfg.legacy).toBe(false);
    expect(cfg.seatId).toBe(REAL_UUID_A);
    expect(cfg.dbName).toMatch(/^honcho_[0-9a-f]{16}$/);
    expect(cfg.workspaceId).toBe(`ws_${REAL_UUID_A}`);
    expect(cfg.honchoHome).toContain(`${path.sep}seats${path.sep}${REAL_UUID_A}${path.sep}home${path.sep}honcho`);
  });

  it('2b — two DISTINCT seats get DISJOINT db name AND workspace AND home (no overlap)', () => {
    const a = buildHonchoRuntimeConfig(inputFor(REAL_UUID_A));
    const b = buildHonchoRuntimeConfig(inputFor(REAL_UUID_B));
    expect(a.dbName).not.toBe(b.dbName);
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.honchoHome).not.toBe(b.honchoHome);
    expect(a.dbName).not.toBe('honcho_seat_1');
  });

  it('3 — a path-traversal / separator / NUL / absolute / dotfile seatId THROWS and never yields a db or path', () => {
    for (const evil of ['../evil', 'a/b', 'a\\b', '/etc/passwd', '..', '.hidden', 'a\0b', 'C:\\x']) {
      expect(() => buildHonchoRuntimeConfig(inputFor(evil))).toThrow();
    }
  });

  it('C4 — buildHonchoRuntimeConfig THROWS on a seatId/seatHome mismatch (no cross-seat memory-FS merge)', () => {
    const homeB = resolveSeatHome(USER_DATA, REAL_UUID_B);
    // seatId A + seatHome resolved from B would give A's db/workspace but B's home.
    expect(() => buildHonchoRuntimeConfig({ seatId: REAL_UUID_A, seatHome: homeB })).toThrow(/mismatch/i);
    // A matching pair builds cleanly.
    expect(() => buildHonchoRuntimeConfig({ seatId: REAL_UUID_A, seatHome: resolveSeatHome(USER_DATA, REAL_UUID_A) })).not.toThrow();
    // Legacy id + legacy home also matches (both resolve to seat-1).
    expect(() => buildHonchoRuntimeConfig({ seatId: undefined, seatHome: resolveSeatHome(USER_DATA, undefined) })).not.toThrow();
  });

  it('4 — case-fold: ABC and abc produce IDENTICAL db, workspace and home (one seat identity)', () => {
    const upper = buildHonchoRuntimeConfig(inputFor('ABC'));
    const lower = buildHonchoRuntimeConfig(inputFor('abc'));
    expect(upper.dbName).toBe(lower.dbName);
    expect(upper.workspaceId).toBe(lower.workspaceId);
    expect(upper.honchoHome).toBe(lower.honchoHome);
  });

  it('5 — the db name always matches the PG identifier grammar and fits NAMEDATALEN', () => {
    const ids = [REAL_UUID_A, REAL_UUID_B, 'abc', 'a_b', 'a-b', 'x'.repeat(64), 'client-42_seat'];
    for (const id of ids) {
      const db = honchoDbNameForSeat(id, false);
      expect(db).toMatch(PG_IDENT_RE);
      expect(db.length).toBeLessThanOrEqual(HONCHO_PG_MAX_IDENT);
    }
    expect(honchoDbNameForSeat('seat-1', true)).toMatch(PG_IDENT_RE);
  });

  it('6 — a 64-char safe-slug seat id yields the hashed db (honcho_<16hex>), stable + ≤63', () => {
    const long = 'a'.repeat(64);
    const cfg = buildHonchoRuntimeConfig(inputFor(long));
    expect(cfg.dbName).toMatch(/^honcho_[0-9a-f]{16}$/);
    expect((cfg.dbName || '').length).toBeLessThanOrEqual(HONCHO_PG_MAX_IDENT);
    // deterministic
    expect(cfg.dbName).toBe(buildHonchoRuntimeConfig(inputFor(long)).dbName);
  });

  it('7 — a-b and a_b (differ ONLY by dash vs underscore) get DISTINCT db names (no merge)', () => {
    const dash = honchoDbNameForSeat('a-b', false);
    const underscore = honchoDbNameForSeat('a_b', false);
    expect(dash).not.toBe(underscore);
  });

  it('8 — H3 opacity: the db name never contains the seat id (let alone a human label)', () => {
    const cfg = buildHonchoRuntimeConfig(inputFor(LABELISH_UUID));
    // The db name is a hash — it must not embed the uuid or any label-derived slug.
    expect(cfg.dbName).not.toContain(LABELISH_UUID);
    expect((cfg.dbName || '').toLowerCase()).not.toContain('alois');
    expect(cfg.dbUri).not.toContain(LABELISH_UUID);
  });

  it('9 — business/private peers are fixed PII-free literals on every seat incl. legacy', () => {
    for (const id of [undefined, REAL_UUID_A] as const) {
      const cfg = buildHonchoRuntimeConfig(inputFor(id));
      expect(cfg.businessPeerId).toBe('biz');
      expect(cfg.privatePeerId).toBe('priv');
    }
  });

  it('19 — dbUri targets 127.0.0.1:<port>/<dbName> and never carries a password literal', () => {
    const cfg = buildHonchoRuntimeConfig(inputFor(REAL_UUID_A, { pgPort: 6543 }));
    expect(cfg.dbUri).toBe(`postgresql://127.0.0.1:6543/${cfg.dbName}`);
    expect(cfg.dbUri).not.toContain('@'); // no user:pass@ segment
    const dflt = buildHonchoRuntimeConfig(inputFor(REAL_UUID_A));
    expect(dflt.dbUri).toBe(`postgresql://127.0.0.1:5432/${dflt.dbName}`);
  });

  it('20 — pure/deterministic: same input twice is deeply equal; only unsafe ids throw', () => {
    const input = inputFor(REAL_UUID_A, { localModelOptedIn: true, localModelReady: true });
    expect(buildHonchoRuntimeConfig(input)).toEqual(buildHonchoRuntimeConfig(input));
    expect(() => buildHonchoRuntimeConfig(inputFor('seat-1'))).not.toThrow();
    expect(() => buildHonchoRuntimeConfig(inputFor(REAL_UUID_B))).not.toThrow();
  });
});

describe('honchoRuntimeConfigCore — DERIVER routing', () => {
  it('10 — opted-in + ready ⇒ LOCAL Ollama deriver (gemma e4b, no tier, no egress)', () => {
    const d = resolveHonchoDeriverConfig({ localModelOptedIn: true, localModelReady: true });
    expect(d.branch).toBe(HONCHO_DERIVER_BRANCH_LOCAL);
    expect(d.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(d.model).toBe(HONCHO_DEFAULT_LOCAL_MODEL_REF);
    expect(d.apiKey).toBe('ollama');
    expect(d.forcedTier).toBeUndefined();
    expect(d.behindEgressBoundary).toBe(false);
    expect(d.routeReason).toBe('local-opt-in-ready');
  });

  it('11 — not opted in ⇒ FREE cloud-Flash fallback behind the shim (tier standard, empty key/model)', () => {
    for (const optedIn of [false, undefined] as const) {
      const d = resolveHonchoDeriverConfig({ localModelOptedIn: optedIn, localModelReady: true });
      expect(d.branch).toBe(HONCHO_DERIVER_BRANCH_CLOUD);
      expect(d.forcedTier).toBe(HONCHO_DERIVER_FORCED_TIER);
      expect(d.apiKey).toBe('');
      expect(d.model).toBe('');
      expect(d.behindEgressBoundary).toBe(true);
      expect(d.routeReason).toBe('fallback-free-flash');
      expect(d.baseUrl).toBe('http://127.0.0.1:25811/v1');
    }
  });

  it('12 — opted in but NOT ready ⇒ cloud fallback (not local), reason opt-in-not-ready', () => {
    const d = resolveHonchoDeriverConfig({ localModelOptedIn: true, localModelReady: false });
    expect(d.branch).toBe(HONCHO_DERIVER_BRANCH_CLOUD);
    expect(d.forcedTier).toBe(HONCHO_DERIVER_FORCED_TIER);
    expect(d.routeReason).toBe('opt-in-not-ready');
  });

  it('13 — MONEY INVARIANT: across the full opt-in × ready × license cartesian, cloud tier is ALWAYS standard, never paid', () => {
    for (const optedIn of [true, false, undefined] as const) {
      for (const ready of [true, false, undefined] as const) {
        for (const hasLicense of [true, false, undefined] as const) {
          const cfg = buildHonchoRuntimeConfig(inputFor(REAL_UUID_A, { localModelOptedIn: optedIn, localModelReady: ready, hasLicense }));
          const d = cfg.deriver || {};
          if (d.branch === HONCHO_DERIVER_BRANCH_CLOUD) {
            expect(d.forcedTier).toBe('standard');
            expect(d.forcedTier).not.toBe('high');
            expect(d.forcedTier).not.toBe('max');
          } else {
            expect(d.branch).toBe(HONCHO_DERIVER_BRANCH_LOCAL);
            expect(d.forcedTier).toBeUndefined();
          }
        }
      }
    }
  });

  it('13b — no picker/tier can be injected: an extra selection/tier field is ignored (structural)', () => {
    const clean = resolveHonchoDeriverConfig({ localModelOptedIn: false });
    // A hostile caller tries to smuggle a paid tier / picker selection in — the
    // function has no such parameter, so it is inert. Cast through unknown (there
    // is deliberately no typed slot for these fields).
    const spoofInput = { localModelOptedIn: false, selection: 'command-eve-inference:eve-max', tier: 'max' } as unknown as Parameters<typeof resolveHonchoDeriverConfig>[0];
    const spoofed = resolveHonchoDeriverConfig(spoofInput);
    expect(spoofed.forcedTier).toBe('standard');
    expect(spoofed).toEqual(clean);
  });

  it('C3 — the LOCAL branch REJECTS a non-loopback ollamaBaseUrl (no direct unredacted egress)', () => {
    // A remote "local" base would emit behindEgressBoundary:false + egress un-redacted.
    expect(() => resolveHonchoDeriverConfig({ localModelOptedIn: true, localModelReady: true, ollamaBaseUrl: EVE_INFERENCE_FUNCTION_URL })).toThrow();
    expect(() => resolveHonchoDeriverConfig({ localModelOptedIn: true, localModelReady: true, ollamaBaseUrl: 'http://10.0.0.5:11434' })).toThrow();
    expect(() => resolveHonchoDeriverConfig({ localModelOptedIn: true, localModelReady: true, ollamaBaseUrl: 'https://127.0.0.1:11434' })).toThrow();
    // A genuine loopback Ollama base is accepted.
    const ok = resolveHonchoDeriverConfig({ localModelOptedIn: true, localModelReady: true, ollamaBaseUrl: 'http://127.0.0.1:11434' });
    expect(ok.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(ok.behindEgressBoundary).toBe(false);
  });

  it('17 — READY gate: cloud + no license ⇒ ready=false; cloud + license ⇒ true; local ⇒ true regardless', () => {
    expect(buildHonchoRuntimeConfig(inputFor(REAL_UUID_A, { localModelOptedIn: false, hasLicense: false })).ready).toBe(false);
    expect(buildHonchoRuntimeConfig(inputFor(REAL_UUID_A, { localModelOptedIn: false, hasLicense: true })).ready).toBe(true);
    expect(buildHonchoRuntimeConfig(inputFor(REAL_UUID_A, { localModelOptedIn: true, localModelReady: true, hasLicense: false })).ready).toBe(true);
  });
});

describe('honchoRuntimeConfigCore — EGRESS safety', () => {
  it('14 — EGRESS INVARIANT: no branch serialises the edge URL/host; cloud base is always a loopback /v1', () => {
    const branches: HonchoRuntimeConfigInput[] = [
      inputFor(REAL_UUID_A, { localModelOptedIn: true, localModelReady: true }), // local
      inputFor(REAL_UUID_A, { localModelOptedIn: false }), // cloud
      inputFor('seat-1', { localModelOptedIn: false }), // legacy cloud
    ];
    for (const input of branches) {
      const cfg = buildHonchoRuntimeConfig(input);
      const json = JSON.stringify(cfg);
      expect(json).not.toContain(EVE_INFERENCE_FUNCTION_URL);
      expect(json).not.toContain('unvbeothoimlzlolxucl');
      if (cfg.deriver && cfg.deriver.branch === HONCHO_DERIVER_BRANCH_CLOUD) {
        expect(cfg.deriver.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      }
    }
  });

  it('15 — requireLoopbackShimBase THROWS on non-loopback/edge/portless; accepts the loopback shim (slash-stripped)', () => {
    expect(() => requireLoopbackShimBase('https://evil.example.com')).toThrow();
    expect(() => requireLoopbackShimBase(EVE_INFERENCE_FUNCTION_URL)).toThrow(); // the real edge fn (https, remote)
    expect(() => requireLoopbackShimBase('http://127.0.0.1')).toThrow(); // portless
    expect(() => requireLoopbackShimBase('http://10.0.0.5:25811')).toThrow(); // LAN, not loopback
    expect(requireLoopbackShimBase('http://127.0.0.1:25811')).toBe('http://127.0.0.1:25811');
    expect(requireLoopbackShimBase('http://127.0.0.1:25811/')).toBe('http://127.0.0.1:25811');
    expect(requireLoopbackShimBase('http://localhost:25811')).toBe('http://localhost:25811');
  });

  it('15b — loopback guard resists spoofed hosts (userinfo, decimal/hex IP, mapped IPv6, look-alike domains)', () => {
    // Every one of these MUST throw — none is the real loopback the shim listens on.
    const spoofs = [
      'http://127.0.0.1@evil.com:80', // userinfo trick: real hostname is evil.com
      'http://127.0.0.1.evil.com:25811', // sub-domain look-alike
      'http://localhost.evil.com:25811', // look-alike of localhost
      'http://0x7f000001:25811', // hex-encoded 127.0.0.1
      'http://2130706433:25811', // decimal-encoded 127.0.0.1
      'http://[::ffff:127.0.0.1]:25811', // IPv4-mapped IPv6
      'http://10.0.0.5:25811', // LAN
      'http://169.254.169.254:25811', // link-local metadata endpoint
      'https://127.0.0.1:25811', // https (not the plain-http shim)
      'ftp://127.0.0.1:25811', // wrong scheme
    ];
    for (const s of spoofs) {
      expect(() => requireLoopbackShimBase(s), `expected THROW for ${s}`).toThrow();
    }
    // The genuine loopbacks (with a port) are accepted; an uppercase scheme normalises.
    expect(requireLoopbackShimBase('HTTP://127.0.0.1:25811')).toBe('HTTP://127.0.0.1:25811');
    expect(requireLoopbackShimBase('http://[::1]:25811')).toBe('http://[::1]:25811');
  });

  it('16 — SECRET-FREE: cloud api key is empty (no CEVE bearer), local key is the ollama placeholder', () => {
    const cloud = resolveHonchoDeriverConfig({ localModelOptedIn: false });
    expect(cloud.apiKey).toBe('');
    const local = resolveHonchoDeriverConfig({ localModelOptedIn: true, localModelReady: true });
    expect(local.apiKey).toBe('ollama');
    // Even with a license present, the descriptor never bakes it.
    const cfg = buildHonchoRuntimeConfig(inputFor(REAL_UUID_A, { localModelOptedIn: false, hasLicense: true }));
    expect(JSON.stringify(cfg).toLowerCase()).not.toContain('bearer');
    expect(JSON.stringify(cfg)).not.toContain('CEVE');
  });

  it('18 — GREP-GATE (source): the module never string-references the edge symbol/host/path', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/process/commandEve/honchoRuntimeConfigCore.ts'),
      'utf8'
    );
    expect(src).not.toContain('EVE_INFERENCE_FUNCTION_URL');
    expect(src).not.toContain('unvbeothoimlzlolxucl');
    expect(src).not.toContain('/functions/v1/');
  });
});

describe('honchoRuntimeConfigCore — helper units', () => {
  it('hardenPgIdent is deterministic 16-hex and workspace uses the sanitized id verbatim', () => {
    expect(hardenPgIdent(REAL_UUID_A)).toMatch(/^[0-9a-f]{16}$/);
    expect(hardenPgIdent(REAL_UUID_A)).toBe(hardenPgIdent(REAL_UUID_A));
    expect(hardenPgIdent(REAL_UUID_A)).not.toBe(hardenPgIdent(REAL_UUID_B));
    expect(honchoWorkspaceIdForSeat(REAL_UUID_A, false)).toBe(`ws_${REAL_UUID_A}`);
    expect(honchoWorkspaceIdForSeat('seat-1', true)).toBe('seat-1');
  });
});
