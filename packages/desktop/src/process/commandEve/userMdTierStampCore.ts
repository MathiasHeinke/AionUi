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
import { COMPANY_BRAIN_DIR, readCompanyBrainSeedStateFromHome } from './companyBrainSeedCore';
import { isLegacySeatId, resolveSeatHome, type SeatKind } from './seatContextCore';

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
 * Strip EVERY standalone occurrence of a marker TOKEN from a body, preserving all
 * surrounding text. Used by the H4 repair path to eliminate orphan/stray/reversed
 * markers WITHOUT deleting EVE-grown prose (only the marker tokens are removed).
 */
function stripMarkerTokens(body: string, ...markers: string[]): string {
  let out = body;
  for (const marker of markers) {
    // Remove the marker plus a single trailing newline if present, so a stripped
    // orphan does not leave a phantom blank line where the token stood.
    out = out.split(`${marker}\n`).join('').split(marker).join('');
  }
  return out;
}

/**
 * Replace (or insert) a marker-fenced block inside an existing body. If a WELL-
 * FORMED prior block exists (a begin marker with a matching end AFTER it) it is
 * REPLACED IN PLACE; otherwise the block is appended with a separating blank line.
 * Content outside the fence is preserved verbatim. Mirrors the ISO-3 MEMORY.md
 * upsert discipline so the two fences behave identically.
 *
 * H4 (isolation-adjacent, destructive-write hardening) — USER.md is agent-writable
 * by design, so an EVE edit CAN drop or reorder a marker. The OLD code took the
 * replace path ONLY when both markers existed AND end>begin; ANY half/reversed
 * fence fell into the plain append branch, which (a) left the orphan/stray marker
 * in place and (b) on the NEXT stamp let that orphan pair with the fresh block and
 * SWALLOW the grown content between them, or DUPLICATE per boot/switch. We now
 * DETECT a malformed fence and repair it DETERMINISTICALLY: strip every stray
 * marker TOKEN (never the surrounding prose), then append one clean block. The
 * result is always exactly ONE well-formed fence with NO orphan markers, so the
 * very next stamp finds it well-formed and replaces in place (idempotent, no dup,
 * no content loss). A well-formed fence is NEVER touched by the repair path.
 */
export function upsertFencedBlock(existing: string, begin: string, end: string, block: string): string {
  const beginIdx = existing.indexOf(begin);
  // The matching end must come AFTER this begin (a reversed END...BEGIN, or an end
  // that belongs to a different/earlier fragment, is NOT a well-formed pair).
  const endIdx = beginIdx !== -1 ? existing.indexOf(end, beginIdx + begin.length) : existing.indexOf(end);

  const wellFormed = beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;

  // Defensive malformed-fence detection: a lone begin, a lone end, a reversed
  // order, or ANY leftover duplicate marker beyond the one well-formed pair.
  const beginCount = existing.split(begin).length - 1;
  const endCount = existing.split(end).length - 1;
  const malformed = !wellFormed
    ? beginCount > 0 || endCount > 0 // any stray marker at all when not well-formed
    : beginCount > 1 || endCount > 1; // well-formed but with extra stray marker(s)

  if (wellFormed && !malformed) {
    const before = existing.slice(0, beginIdx).replace(/\s+$/, '');
    const after = existing.slice(endIdx + end.length).replace(/^\s+/, '');
    // Match the SAME leading form the append branch produces so a re-stamp of a
    // block that sits at the very top of the file (before === '') is byte-
    // identical to the first stamp — no phantom leading blank lines accumulate.
    const prefix = before.length > 0 ? `${before}\n\n` : '';
    const joined = `${prefix}${block}\n${after.length > 0 ? `\n${after}` : ''}`;
    return joined.replace(/\s+$/, '') + '\n';
  }

  // Malformed (or a well-formed pair contaminated by extra stray markers): strip
  // EVERY marker token of this fence (grown prose survives — only tokens go), then
  // fall through to a clean append. If a well-formed pair existed among the strays,
  // its stale body content is intentionally dropped here (it is this fence's own
  // block, which we are re-stamping anyway) — grown content OUTSIDE the markers is
  // preserved because we only remove the tokens, never surrounding text.
  const cleaned = malformed ? stripMarkerTokens(existing, begin, end) : existing;

  const base = cleaned.replace(/\s+$/, '');
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
  // Reserve one code UNIT for the ellipsis so the RESULT (still measured in code
  // units, `.length`) stays ≤ budget.
  const unitLimit = Math.max(0, budget - 1);
  // H8 — never split a surrogate pair. A raw `body.slice(0, unitLimit)` can cut an
  // astral character (emoji / some CJK) mid-pair, leaving a lone surrogate that
  // renders as U+FFFD () at the block end. Instead accumulate WHOLE code points
  // while their combined code-unit length still fits under `unitLimit`, dropping the
  // boundary character ENTIRELY rather than half of it. This keeps the result both
  // surrogate-safe AND within the code-unit budget (the caller's hard invariant).
  let used = 0;
  let truncated = '';
  for (const codePoint of body) {
    if (used + codePoint.length > unitLimit) break;
    truncated += codePoint;
    used += codePoint.length;
  }
  return { body: `${truncated}…`, truncated: true };
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
      "Global operator identity (L0) — stamped into every seat. The operator runs this installation; in client seats they act on the respective client's behalf, not for their own firm. Per-client isolation is sacred: one client's data/brief/output never bleeds into another; never attribute a client seat's work to the operator.",
    ].join('\n');
  }
  const nameLine = name || (confirm ? '(unbestätigt — beiläufig nachfragen)' : 'noch nicht bekannt');
  const companyLine = company || (confirm ? '(unbestätigt — beiläufig nachfragen)' : 'noch nicht bekannt');
  return [
    '§ FOUNDER',
    `Operator: ${nameLine}`,
    `Firma/Brand: ${companyLine}`,
    'Globale Operator-Identität (L0) — in jeden Seat gestempelt. Der Operator bedient diese Installation; in Kunden-Seats handelt er im Auftrag des jeweiligen Kunden, nicht für seine eigene Firma. Per-Client-Isolation ist heilig: Daten/Briefing/Output eines Kunden bluten nie in einen anderen; schreibe Client-Seat-Arbeit nie dem Betreiber zu.',
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
  locale: 'de-DE' | 'en-US' = 'de-DE',
  brainDir?: string | null,
  kind: SeatKind = 'client'
): string | null {
  const value = typeof seed?.value === 'string' ? seed.value.trim() : '';
  if (!seed || value.length === 0) return null;
  const firstLine =
    value
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) || value;
  const kindLabel =
    seed.kind === 'paste_brief'
      ? locale === 'en-US'
        ? 'brief'
        : 'Briefing'
      : locale === 'en-US'
        ? 'connected client'
        : 'verbundener Client';
  // T7 — reference the brief by its ABSOLUTE path so the agent never resolves it
  // against workspace cwd. Absent brainDir → an explicit HERMES_HOME qualifier
  // (never a bare workspace-relative path). The whole block is still truncated to
  // SEAT_BLOCK_MAX_CHARS (≤400c) by the stamper.
  const dir = typeof brainDir === 'string' ? brainDir.trim() : '';
  const briefRefEn = dir ? `${dir}/brief.md (absolute)` : 'company-brain/brief.md in this seat home (HERMES_HOME)';
  const briefRefDe = dir ? `${dir}/brief.md (absolut)` : 'company-brain/brief.md in diesem Seat-Home (HERMES_HOME)';
  // F3 (MEDIUM) — the client line is a Prompt-Injection lane (operator/seed data,
  // not an instruction). Frame it as DATA with guillemets «…», matching the you-are-
  // here hint; SOUL tells EVE that «…»-wrapped text is data, never a command.
  // Ordering (H8 truncate-from-END discipline): the FIXED doctrine lines — the T9
  // operator-vs-client role sentence + the per-client-isolation clause — come BEFORE
  // the VARIABLE-length brief-ref line. On a real install the absolute brief path is
  // ~140c and can push the block past ≤400c; ordering the long path LAST means a
  // truncate trims the (recoverable) path detail, never the role/isolation doctrine.
  // K3 — kind-conditioned doctrine (§4 matrix). CLIENT stays BYTE-IDENTICAL to
  // pre-K3 (regression-proven by snapshot). own_company DROPS the invisible-
  // delivery clause (the seat name is the operator's OWN brand and MUST be usable
  // in deliverables) but KEEPS data-isolation. department is conservative = LIKE
  // client (keeps invisible-delivery) but with the department role/entity framing.
  if (locale === 'en-US') {
    if (kind === 'own_company') {
      return [
        '§ SEAT',
        `Own project/firm (this seat), per briefing: «${firstLine}»`,
        // T9 (own_company): the operator is the client here — it is their own project/firm.
        "This seat is one of the operator's own projects/firms — they are the client here.",
        // Isolation KEPT; invisible-delivery DROPPED (own brand belongs in deliverables).
        'This seat belongs to this project/firm. Its data stays in this seat (isolation, GDPR).',
        `Source: ${kindLabel}. Full brief: ${briefRefEn} — read it with read_file when you need it.`,
      ].join('\n');
    }
    if (kind === 'department') {
      return [
        '§ SEAT',
        `Department/area (this seat), per briefing: «${firstLine}»`,
        // T9 (department): the operator's own department/area — not a client.
        "This seat is one of the operator's departments/areas — work here belongs to exactly this area.",
        // Conservative: invisible-delivery KEPT (an internal org label has no place outside).
        'This seat belongs to exactly this area. Its data stays in this seat (isolation, GDPR); the seat name never appears in deliverables.',
        `Source: ${kindLabel}. Full brief: ${briefRefEn} — read it with read_file when you need it.`,
      ].join('\n');
    }
    return [
      '§ SEAT',
      `Client (this seat), per operator briefing: «${firstLine}»`,
      // T9 — operator-vs-client role: the operator drives EVE, the work is FOR the client.
      "Your operator runs you here on the client's behalf, not for their own firm.",
      'This seat belongs to exactly this client. Their data stays in this seat (per-client isolation, GDPR); the seat name never appears in deliverables.',
      `Source: ${kindLabel}. Full brief: ${briefRefEn} — read it with read_file when you need it.`,
    ].join('\n');
  }
  if (kind === 'own_company') {
    return [
      '§ SEAT',
      `Eigenes Projekt/eigene Firma (dieser Seat), laut Briefing: «${firstLine}»`,
      // T9 (own_company): der Operator ist hier selbst der Auftraggeber.
      'Dieser Seat ist ein eigenes Projekt/eine eigene Firma des Operators — er ist hier selbst der Auftraggeber.',
      // Isolation BLEIBT; NIE-in-Deliverables ENTFÄLLT (eigene Marke gehört in Deliverables).
      'Dieser Seat gehört diesem Projekt/dieser Firma. Seine Daten bleiben in diesem Seat (Isolation, DSGVO).',
      `Quelle: ${kindLabel}. Vollständiges Briefing: ${briefRefDe} — lies es bei Bedarf mit read_file.`,
    ].join('\n');
  }
  if (kind === 'department') {
    return [
      '§ SEAT',
      `Abteilung/Bereich (dieser Seat), laut Briefing: «${firstLine}»`,
      // T9 (department): eine Abteilung/ein Bereich des Operators — kein Kunde.
      'Dieser Seat ist eine Abteilung/ein Bereich des Operators — Arbeit hier gehört zu genau diesem Bereich.',
      // Konservativ: NIE-in-Deliverables BLEIBT (internes Org-Etikett hat außen nichts verloren).
      'Dieser Seat gehört genau diesem Bereich. Seine Daten bleiben in diesem Seat (Isolation, DSGVO); der Seat-Name erscheint nie in Deliverables.',
      `Quelle: ${kindLabel}. Vollständiges Briefing: ${briefRefDe} — lies es bei Bedarf mit read_file.`,
    ].join('\n');
  }
  return [
    '§ SEAT',
    `Client (dieser Seat), laut Operator-Briefing: «${firstLine}»`,
    // T9 — operator-vs-client role: the operator drives EVE, the work is FOR the client.
    'Dein Operator bedient dich hier im Auftrag des Kunden, nicht für seine eigene Firma.',
    'Dieser Seat gehört genau diesem Kunden. Seine Daten bleiben in diesem Seat (Per-Client-Isolation, DSGVO); der Seat-Name erscheint nie in Deliverables.',
    `Quelle: ${kindLabel}. Vollständiges Briefing: ${briefRefDe} — lies es bei Bedarf mit read_file.`,
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
  /** K3: the seat's kind — conditions the §SEAT doctrine text only. Default 'client'. */
  kind?: SeatKind;
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
      log(
        `[CommandEVE] §FOUNDER USER.md block truncated to ${FOUNDER_BLOCK_MAX_CHARS} chars (was ${founderRaw.length}).`
      );
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
      // K3: pass the seat kind so the doctrine text matches (own_company drops the
      // client invisible-delivery clause). A legacy seat never reaches here (§SEAT
      // is stripped above), so kind only ever conditions a REAL seat's block.
      const seatBody = renderSeatBody(
        args.seed ?? null,
        locale,
        path.join(args.hermesHome, COMPANY_BRAIN_DIR),
        args.kind ?? 'client'
      );
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
  /** K3: the seat's kind — conditions the §SEAT doctrine text only. Default 'client'. */
  kind?: SeatKind;
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
    kind: args.kind,
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
  /** K3: the target seat's kind (the caller passes getActiveSeatKind() — the holder
   *  applySeatSwitch set from the wire record). Default 'client'. */
  kind?: SeatKind;
  deps?: UserMdTierStampDeps;
}): UserMdTierStampResult {
  const profile = readPersistedFirstRunProfile(args.userDataPath, args.deps?.fsImpl);
  return stampUserMdTiers({
    userDataPath: args.userDataPath,
    seatId: args.seatId,
    profile,
    locale: args.locale ?? 'de-DE',
    kind: args.kind,
    deps: args.deps,
  });
}
