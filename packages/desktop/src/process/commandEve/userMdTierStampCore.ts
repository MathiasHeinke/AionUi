/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE USER.md TIER STAMP core (Seat-Context-Bridge / S3 / spec B2).
 *
 * WHAT THIS IS. The per-seat USER.md (memories/USER.md under each seat's
 * hermesHome) is already physically per-seat (ISO-1) and is the frozen-snapshot
 * profile the Hermes agent loads once at __init__. B2 stamps two SMALL,
 * MARKER-FENCED tier blocks into it so the agent's self-knowledge tree is real
 * from turn one WITHOUT a wheel change and WITHOUT freezing the whole tree:
 *
 *   §FOUNDER  (<!-- CE:FOUNDER:v1 --> … <!-- /CE:FOUNDER -->), ≤600 chars:
 *     WHO the operator is (name, company, DSGVO/values kernel). Stamped into
 *     EVERY seat's USER.md (the founder identity is global L0). Source: the same
 *     RuntimeBootstrapIdentityProfile the existing first-run USER.md seed uses.
 *
 *   §SEAT     (<!-- CE:SEAT:v1 --> … <!-- /CE:SEAT -->), ≤400 chars:
 *     WHO this client seat is (client company, what we do for them, DSGVO
 *     posture). Stamped ONLY into a REAL seat's USER.md, NEVER the legacy/founder
 *     seat. Source: the seat's own ISO-3 Company-Brain seed (companyBrainSeed-
 *     Core's seed.json / brief), read per-seat under its own hermesHome.
 *
 * THE ELEGANCE IS REPLICATION, NOT A NEW HIERARCHY. A re-stamp REPLACES ONLY its
 * own fenced block (regex on the stable markers); any EVE-grown content OUTSIDE
 * the fence is untouched, and stamping the SAME input twice is byte-identical
 * (the idempotency the existing ISO-3 MEMORY.md block already proves). The hard
 * char budget is enforced by TRUNCATING inside the fence (and logging), never by
 * overflowing — invariant §3 ("frozen snapshot stays small").
 *
 * INVARIANTS (spec, LOCKED):
 *  - §FOUNDER present in EVERY seat; §SEAT ABSENT in the legacy/founder seat.
 *  - A client seat's USER.md never contains another seat's name (the §SEAT block
 *    is derived ONLY from THIS seat's own hermesHome seed — structurally single-
 *    seat by construction).
 *  - ≤600 / ≤400 char budgets are HARD (truncate + log).
 *
 * PURE / INJECTABLE. The stamp operates on a hermesHome path with injectable fs
 * handles (readFile / writeFile / mkdir) + an injectable logger, so it unit-tests
 * against a tmp dir (or fully in-memory) with no Electron. The seat-resolving
 * wrappers sit on top and pick up the active/explicit seat.
 */

import fs from 'fs';
import path from 'path';

import type { RuntimeBootstrapIdentityProfile } from './runtimeBootstrapCore';
import { resolveCommandEveRuntimeBootstrapPaths } from './runtimeBootstrapCore';
import type { CompanyBrainSeedRecord } from './companyBrainSeedCore';
import { readCompanyBrainSeedStateFromHome } from './companyBrainSeedCore';
import { isLegacySeatId, resolveSeatHome } from './seatContextCore';

/**
 * A minimal, always-valid fallback profile when no persisted first-run-profile
 * exists yet (a fresh install, or a switch before the first bootstrap wrote it).
 * `placeholder` confidence → renderFounderBody emits the honest "not known yet /
 * ask casually" §FOUNDER, never a fabricated identity.
 */
const FALLBACK_PROFILE: RuntimeBootstrapIdentityProfile = {
  version: 'command-eve-first-run-profile/v0',
  source: 'unverified',
  confidence: 'placeholder',
  needs_confirmation: true,
  updated_at: '',
};

/**
 * Read the persisted global first-run-profile.json (the SAME source the boot
 * §FOUNDER stamp uses) for a userDataPath, fail-safe: any read/parse failure
 * returns the honest placeholder fallback so a switch-time stamp never throws and
 * never invents an identity. Note the profile is GLOBAL (the operator/admin), not
 * per-seat — §FOUNDER is L0 by design.
 */
export function readPersistedFirstRunProfile(
  userDataPath: string,
  fsImpl: UserMdStampFs = defaultFs
): RuntimeBootstrapIdentityProfile {
  try {
    const { firstRunProfile } = resolveCommandEveRuntimeBootstrapPaths(userDataPath);
    if (!fsImpl.existsSync(firstRunProfile)) return FALLBACK_PROFILE;
    const raw = JSON.parse(fsImpl.readFileSync(firstRunProfile, 'utf8')) as Partial<RuntimeBootstrapIdentityProfile>;
    if (!raw || typeof raw !== 'object') return FALLBACK_PROFILE;
    return {
      version: 'command-eve-first-run-profile/v0',
      source: raw.source ?? 'unverified',
      confidence: raw.confidence ?? 'placeholder',
      needs_confirmation: raw.needs_confirmation ?? true,
      updated_at: raw.updated_at ?? '',
      founder_name: raw.founder_name,
      company_name: raw.company_name,
    };
  } catch {
    return FALLBACK_PROFILE;
  }
}

/** HARD char budget for the §FOUNDER fenced block body (spec invariant §3). */
export const FOUNDER_BLOCK_MAX_CHARS = 600;
/** HARD char budget for the §SEAT fenced block body (spec invariant §3). */
export const SEAT_BLOCK_MAX_CHARS = 400;

/** Stable version-tagged fence markers. A re-stamp replaces ONLY its own block. */
export const FOUNDER_MARKER_BEGIN = '<!-- CE:FOUNDER:v1 -->';
export const FOUNDER_MARKER_END = '<!-- /CE:FOUNDER -->';
export const SEAT_MARKER_BEGIN = '<!-- CE:SEAT:v1 -->';
export const SEAT_MARKER_END = '<!-- /CE:SEAT -->';

/** Injectable fs surface (defaults to node fs) so the stamp unit-tests in-memory. */
export interface UserMdStampFs {
  readFileSync: (p: string, enc: 'utf8') => string;
  writeFileSync: (p: string, data: string, opts?: { mode?: number }) => void;
  mkdirSync: (p: string, opts?: { recursive?: boolean }) => void;
  existsSync: (p: string) => boolean;
}

const defaultFs: UserMdStampFs = {
  readFileSync: (p, enc) => fs.readFileSync(p, enc),
  writeFileSync: (p, data, opts) => fs.writeFileSync(p, data, opts),
  mkdirSync: (p, opts) => {
    fs.mkdirSync(p, opts);
  },
  existsSync: (p) => fs.existsSync(p),
};

export interface UserMdTierStampDeps {
  fsImpl?: UserMdStampFs;
  /** Injected logger for the truncation notice (default console.warn). */
  logTruncation?: (msg: string) => void;
}

export interface UserMdTierStampResult {
  ok: boolean;
  userMdPath: string;
  /** True when a §FOUNDER block was written/refreshed. */
  founderStamped: boolean;
  /** True when a §SEAT block was written/refreshed (real seat + a seed only). */
  seatStamped: boolean;
  /** True when the §FOUNDER body had to be truncated to fit the budget. */
  founderTruncated: boolean;
  /** True when the §SEAT body had to be truncated to fit the budget. */
  seatTruncated: boolean;
  /** True when the write actually changed the file (else it was byte-identical). */
  changed: boolean;
}

/**
 * Replace (or insert) a marker-fenced block inside an existing body. If a prior
 * block exists (between begin/end markers) it is REPLACED IN PLACE; otherwise the
 * block is appended with a separating blank line. Content outside the fence is
 * preserved verbatim. Mirrors the ISO-3 MEMORY.md upsert discipline so the two
 * fences behave identically.
 */
export function upsertFencedBlock(existing: string, begin: string, end: string, block: string): string {
  const beginIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx).replace(/\s+$/, '');
    const after = existing.slice(endIdx + end.length).replace(/^\s+/, '');
    // Match the SAME leading form the append branch produces so a re-stamp of a
    // block that sits at the very top of the file (before === '') is byte-
    // identical to the first stamp — no phantom leading blank lines accumulate.
    const prefix = before.length > 0 ? `${before}\n\n` : '';
    const joined = `${prefix}${block}\n${after.length > 0 ? `\n${after}` : ''}`;
    return joined.replace(/\s+$/, '') + '\n';
  }
  const base = existing.replace(/\s+$/, '');
  const prefix = base.length > 0 ? `${base}\n\n` : '';
  return `${prefix}${block}\n`;
}

/** Remove a marker-fenced block entirely (used to strip §SEAT from a legacy seat). */
export function removeFencedBlock(existing: string, begin: string, end: string): string {
  const beginIdx = existing.indexOf(begin);
  const endIdx = existing.indexOf(end);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) return existing;
  const before = existing.slice(0, beginIdx).replace(/\s+$/, '');
  const after = existing.slice(endIdx + end.length).replace(/^\s+/, '');
  const joined = before.length > 0 && after.length > 0 ? `${before}\n\n${after}` : `${before}${after}`;
  const trimmed = joined.replace(/\s+$/, '');
  return trimmed.length > 0 ? `${trimmed}\n` : '';
}

/**
 * HARD-truncate a block BODY (the content between the fence markers) to `budget`
 * chars, appending a single ellipsis when it overran. Returns the (possibly
 * truncated) body + a `truncated` flag so the caller can log. Never overflows.
 */
export function truncateToBudget(body: string, budget: number): { body: string; truncated: boolean } {
  if (body.length <= budget) return { body, truncated: false };
  // Reserve one char for the ellipsis so the RESULT is ≤ budget.
  const cut = Math.max(0, budget - 1);
  return { body: `${body.slice(0, cut)}…`, truncated: true };
}

/**
 * Build the §FOUNDER block BODY (between the markers) from the first-run identity
 * profile — the SAME source the existing seedFounderUserProfile uses. Kept to the
 * global L0 truth: name, company, and the standing per-client-isolation/DSGVO
 * kernel. Operator branding is NOT durably available at bootstrap (only per-export
 * in reportExportCore), so it is intentionally omitted here (report as a gap).
 */
export function renderFounderBody(
  profile: RuntimeBootstrapIdentityProfile,
  locale: 'de-DE' | 'en-US' = 'de-DE'
): string {
  const reliable = profile.confidence !== 'placeholder';
  const name = (reliable && profile.founder_name?.trim()) || '';
  const company = (reliable && profile.company_name?.trim()) || '';
  const confirm = profile.needs_confirmation;
  if (locale === 'en-US') {
    const nameLine = name || (confirm ? '(unconfirmed — ask casually)' : 'not known yet');
    const companyLine = company || (confirm ? '(unconfirmed — ask casually)' : 'not known yet');
    return [
      '§ FOUNDER',
      `Operator: ${nameLine}`,
      `Company/brand: ${companyLine}`,
      'Global operator identity (L0) — stamped into every seat. Per-client isolation is sacred: one client\'s data/brief/output never bleeds into another; never attribute a client seat\'s work to the operator.',
    ].join('\n');
  }
  const nameLine = name || (confirm ? '(unbestätigt — beiläufig nachfragen)' : 'noch nicht bekannt');
  const companyLine = company || (confirm ? '(unbestätigt — beiläufig nachfragen)' : 'noch nicht bekannt');
  return [
    '§ FOUNDER',
    `Operator: ${nameLine}`,
    `Firma/Brand: ${companyLine}`,
    'Globale Operator-Identität (L0) — in jeden Seat gestempelt. Per-Client-Isolation ist heilig: Daten/Briefing/Output eines Kunden bluten nie in einen anderen; schreibe Client-Seat-Arbeit nie dem Betreiber zu.',
  ].join('\n');
}

/**
 * Build the §SEAT block BODY (between the markers) from THIS seat's ISO-3
 * Company-Brain seed record. Derives a short summary: the client company / what we
 * do for them (lifted from the seed value's first non-empty line) + the DSGVO
 * posture. Returns `null` when there is no usable seed (a real seat not yet seeded
 * gets NO §SEAT block — honest omission, never a fabricated client).
 */
export function renderSeatBody(
  seed: CompanyBrainSeedRecord | null,
  locale: 'de-DE' | 'en-US' = 'de-DE'
): string | null {
  const value = typeof seed?.value === 'string' ? seed.value.trim() : '';
  if (!seed || value.length === 0) return null;
  const firstLine = value.split('\n').map((l) => l.trim()).find((l) => l.length > 0) || value;
  const kindLabel =
    seed.kind === 'paste_brief'
      ? locale === 'en-US'
        ? 'brief'
        : 'Briefing'
      : locale === 'en-US'
        ? 'connected client'
        : 'verbundener Client';
  if (locale === 'en-US') {
    return [
      '§ SEAT',
      `Client (this seat): ${firstLine}`,
      `Source: ${kindLabel}. Full brief lives in this seat's MEMORY.md.`,
      'This seat belongs to exactly this client. Their data stays in this seat (per-client isolation, GDPR); the seat name never appears in deliverables.',
    ].join('\n');
  }
  return [
    '§ SEAT',
    `Client (dieser Seat): ${firstLine}`,
    `Quelle: ${kindLabel}. Vollständiges Briefing liegt in der MEMORY.md dieses Seats.`,
    'Dieser Seat gehört genau diesem Kunden. Seine Daten bleiben in diesem Seat (Per-Client-Isolation, DSGVO); der Seat-Name erscheint nie in Deliverables.',
  ].join('\n');
}

/** Compose a fenced block from begin/end markers + a (already-truncated) body. */
function fence(begin: string, end: string, body: string): string {
  return [begin, body, end].join('\n');
}

/**
 * PURE stamper: stamp/refresh the tier blocks into the USER.md at an ALREADY-
 * RESOLVED hermesHome. `legacy` decides §SEAT: a legacy/founder seat gets ONLY
 * §FOUNDER (and any pre-existing §SEAT is stripped, defensively); a real seat gets
 * §FOUNDER + (when seeded) §SEAT. Idempotent: same inputs → byte-identical file;
 * content outside the fences is preserved. Never throws (best-effort — a stamp
 * failure must never block boot/switch).
 */
export function stampUserMdTiersToHome(args: {
  hermesHome: string;
  legacy: boolean;
  profile: RuntimeBootstrapIdentityProfile;
  seed?: CompanyBrainSeedRecord | null;
  locale?: 'de-DE' | 'en-US';
  deps?: UserMdTierStampDeps;
}): UserMdTierStampResult {
  const fsImpl = args.deps?.fsImpl ?? defaultFs;
  const log = args.deps?.logTruncation ?? ((m: string) => console.warn(m));
  const locale = args.locale ?? 'de-DE';
  const memDir = path.join(args.hermesHome, 'memories');
  const userMdPath = path.join(memDir, 'USER.md');

  const result: UserMdTierStampResult = {
    ok: false,
    userMdPath,
    founderStamped: false,
    seatStamped: false,
    founderTruncated: false,
    seatTruncated: false,
    changed: false,
  };

  try {
    let existing = '';
    if (fsImpl.existsSync(userMdPath)) {
      try {
        existing = fsImpl.readFileSync(userMdPath, 'utf8');
      } catch {
        existing = '';
      }
    }
    const before = existing;

    // §FOUNDER — stamped into EVERY seat (global L0).
    const founderRaw = renderFounderBody(args.profile, locale);
    const founderTrunc = truncateToBudget(founderRaw, FOUNDER_BLOCK_MAX_CHARS);
    if (founderTrunc.truncated) {
      log(`[CommandEVE] §FOUNDER USER.md block truncated to ${FOUNDER_BLOCK_MAX_CHARS} chars (was ${founderRaw.length}).`);
      result.founderTruncated = true;
    }
    let next = upsertFencedBlock(
      existing,
      FOUNDER_MARKER_BEGIN,
      FOUNDER_MARKER_END,
      fence(FOUNDER_MARKER_BEGIN, FOUNDER_MARKER_END, founderTrunc.body)
    );
    result.founderStamped = true;

    // §SEAT — REAL seats only, and only when a seed exists. A legacy seat NEVER
    // carries §SEAT; strip a stray one defensively (e.g. a home mislabeled once).
    if (args.legacy) {
      next = removeFencedBlock(next, SEAT_MARKER_BEGIN, SEAT_MARKER_END);
    } else {
      const seatBody = renderSeatBody(args.seed ?? null, locale);
      if (seatBody) {
        const seatTrunc = truncateToBudget(seatBody, SEAT_BLOCK_MAX_CHARS);
        if (seatTrunc.truncated) {
          log(`[CommandEVE] §SEAT USER.md block truncated to ${SEAT_BLOCK_MAX_CHARS} chars (was ${seatBody.length}).`);
          result.seatTruncated = true;
        }
        next = upsertFencedBlock(
          next,
          SEAT_MARKER_BEGIN,
          SEAT_MARKER_END,
          fence(SEAT_MARKER_BEGIN, SEAT_MARKER_END, seatTrunc.body)
        );
        result.seatStamped = true;
      } else {
        // Real seat, not seeded yet: no §SEAT block (honest omission). Strip a
        // prior §SEAT if the seed was removed so a stale client never lingers.
        next = removeFencedBlock(next, SEAT_MARKER_BEGIN, SEAT_MARKER_END);
      }
    }

    if (next !== before) {
      fsImpl.mkdirSync(memDir, { recursive: true });
      fsImpl.writeFileSync(userMdPath, next, { mode: 0o600 });
      result.changed = true;
    }
    result.ok = true;
    return result;
  } catch {
    // best-effort: a stamp failure must never block the boot / switch.
    return result;
  }
}

/**
 * Seat-aware wrapper: resolve the seat home for `seatId` (explicit) and stamp the
 * tiers there, reading the seat's OWN Company-Brain seed for §SEAT. This is the
 * function the bootstrap + seat-switch flows call. It reads the seed from the
 * SAME resolved home (never a cross-seat lookup — the §SEAT truth is strictly the
 * one under this seat's hermesHome).
 */
export function stampUserMdTiers(args: {
  userDataPath: string;
  seatId: string;
  profile: RuntimeBootstrapIdentityProfile;
  locale?: 'de-DE' | 'en-US';
  deps?: UserMdTierStampDeps;
}): UserMdTierStampResult {
  const home = resolveSeatHome(args.userDataPath, args.seatId);
  const legacy = isLegacySeatId(args.seatId);
  // §SEAT source: THIS seat's own on-disk seed (never another seat's). A legacy
  // seat is never seeded as a client, so we skip the read for it.
  const seed = legacy ? null : readCompanyBrainSeedStateFromHome(home.hermesHome).record;
  return stampUserMdTiersToHome({
    hermesHome: home.hermesHome,
    legacy,
    profile: args.profile,
    seed,
    locale: args.locale,
    deps: args.deps,
  });
}

/**
 * SEAT-SWITCH entry point (spec B2, set-point b): after a switch re-spawns the
 * backend under the target seat's HERMES_HOME, refresh that seat's USER.md tier
 * blocks. Reads the GLOBAL first-run-profile for §FOUNDER and the TARGET seat's
 * own Company-Brain seed for §SEAT (from the target seat's home only — never a
 * cross-seat read). Best-effort + never throws (a stamp failure must not fail the
 * switch — applySeatSwitch treats reseed/stamp as informational).
 */
export function stampUserMdTiersForSwitch(args: {
  userDataPath: string;
  seatId: string;
  locale?: 'de-DE' | 'en-US';
  deps?: UserMdTierStampDeps;
}): UserMdTierStampResult {
  const profile = readPersistedFirstRunProfile(args.userDataPath, args.deps?.fsImpl);
  return stampUserMdTiers({
    userDataPath: args.userDataPath,
    seatId: args.seatId,
    profile,
    locale: args.locale ?? 'de-DE',
    deps: args.deps,
  });
}
