/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Company-Brain SEED writer (Phase 4 / ISO-3 — close the dropped-seed NO-OP).
 *
 * THE GAP THIS CLOSES. The Day-0 onboarding flow validates the operator's
 * one-client-input seed (`ClientSeedInput`, kind `connect_client | paste_brief`)
 * and then THREW IT AWAY: `useDayZeroOnboarding.recordSeed` awaited an
 * `onSeedRecorded` sink that DEFAULTED TO A NO-OP, and neither call site passed
 * one. So the active seat's hermesHome carried NO client knowledge — EVE had no
 * day-0 truth about THIS seat's client, and "seeded?" was answered from a single
 * GLOBAL config flag that suppressed the prompt for every other seat.
 *
 * THE FIX (this module). Persist the seed into the ACTIVE seat's hermesHome so
 * the Hermes agent reads it as that client's durable knowledge:
 *
 *   - <hermesHome>/company-brain/seed.json is a structured, machine-readable
 *     marker so "has THIS seat been seeded?" is answerable from on-disk per-seat
 *     evidence (readCompanyBrainSeedState) rather than a shared global flag.
 *
 *   - <hermesHome>/company-brain/brief.md holds the full brief verbatim, for
 *     EVERY seed kind (connect_client stores the client entity as a one-liner;
 *     paste_brief stores the whole pasted brief). This is the file the AGENT
 *     actually reads via read_file — its own HERMES_HOME is not workspace-
 *     confined by the wheel's file_tools — and the §SEAT USER.md stamp
 *     (userMdTierStampCore) links to exactly this path. seed.json + brief.md
 *     are the whole persistence surface; there is NO MEMORY.md write.
 *
 * WHY NOT MEMORY.md (v1.4 T1 correction). The prior code wrote a fenced "Client
 * context (day-0 seed)" block into <hermesHome>/MEMORY.md (ROOT). The bundled
 * Hermes wheel only ever loads <hermesHome>/memories/MEMORY.md (wheel
 * memory_tool.py:55-57,153) — so the root block was a DEAD WRITE the agent never
 * saw (live-confirmed: a 191-byte tot root file next to a growing memories/
 * MEMORY.md). We do NOT redirect the write into memories/ either: memories/ is
 * the agent's own 2200c hot-cache under a drift-guard budget, and stamping a full
 * brief into it collides with that budget (spec §0.3, G3 risk). The brief lives
 * in company-brain/ (agent reads it on demand); memories/ stays the agent's.
 * migrateStrayRootMemoryBlock() cleans up any legacy root block on the next seed
 * write and once at boot (Founder-decision #3: delete the stale root file).
 *
 * SEAT-CORRECT BY CONSTRUCTION. The home is resolved with
 * `resolveActiveSeatHome(userDataPath).hermesHome` (the SAME active-seat seam
 * ISO-1 introduced), so a legacy/no-seat install writes byte-compatibly into
 * <hermesRoot>/home and a real seat writes into <hermesRoot>/seats/<id>/home.
 * The write NEVER touches the global config store and NEVER escapes the seat
 * home (the resolver's allowlist throws on a crafted seatId).
 *
 * PURE / INJECTABLE. The actual writer (`writeCompanyBrainSeedToHome`) takes the
 * resolved home path directly, so it unit-tests with a tmp dir and no Electron.
 * The seat-resolving wrappers (`writeCompanyBrainSeed` /
 * `readCompanyBrainSeedState`) sit on top and pick up the active seat.
 *
 * HONESTY (eve-doctrine): this module PERSISTS the seed into a file the agent can
 * actually read (company-brain/brief.md), and the §SEAT stamp points at it. It
 * does not claim EVE "learns" the client. The narrow claim is: each seat carries
 * its own client truth on disk under its own hermesHome, reachable per-seat.
 */

import fs from 'fs';
import path from 'path';

import type { ClientSeedInput } from '@/common/config/creditsCore';
import { isClientSeedSatisfied } from '@/common/config/creditsCore';
import { resolveActiveSeatHome, resolveSeatHome } from '@process/commandEve/seatContextCore';
import { stripYamlUnprintables } from '@process/commandEve/runtimeBootstrapCore';

/** Schema tag for the on-disk per-seat seed marker. */
export const COMMAND_EVE_COMPANY_BRAIN_SEED_SCHEMA = 'command-eve-company-brain-seed/v1';

/** The subdir under hermesHome holding the structured marker + raw brief. */
export const COMPANY_BRAIN_DIR = 'company-brain';

/**
 * Stable fence markers that DELIMITED the legacy root-MEMORY.md "Client context"
 * seed block. That block was a dead write (the wheel only loads memories/
 * MEMORY.md), so the writer is gone — but these markers are STILL needed to
 * recognize and remove OUR old block from an installed root MEMORY.md during
 * migration (migrateStrayRootMemoryBlock). Foreign content OUTSIDE the fence is
 * never touched.
 */
const MEMORY_BLOCK_BEGIN = '<!-- command-eve:company-brain-seed:begin -->';
const MEMORY_BLOCK_END = '<!-- command-eve:company-brain-seed:end -->';

/** The structured on-disk seed marker (company-brain/seed.json). */
export interface CompanyBrainSeedRecord {
  schema_version: string;
  seeded_at: string;
  kind: ClientSeedInput['kind'];
  value: string;
}

/** The per-seat "seeded?" answer, sourced from on-disk evidence. */
export interface CompanyBrainSeedState {
  seeded: boolean;
  record: CompanyBrainSeedRecord | null;
}

export interface WriteCompanyBrainSeedResult {
  ok: boolean;
  /** The hermesHome the seed landed under (the active seat home). */
  hermesHome: string;
  /** Absolute path of the structured marker that was written. */
  seedJsonPath: string;
  /**
   * Absolute path of the brief written for EVERY seed kind — the file the agent
   * reads via read_file and the §SEAT USER.md stamp links to.
   */
  briefPath: string;
  /**
   * True when a stale legacy root-MEMORY.md seed block was removed as part of
   * this write (the dead-write migration). Purely informational.
   */
  migratedRootMemory: boolean;
  record: CompanyBrainSeedRecord;
}

const ensureDir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
};

/**
 * Atomic file write (temp + rename) at mode 0o600 — the SAME convention used for
 * SOUL.md / config.yaml / receipts (runtimeBootstrapCore.ts:993, :2093-2095) so
 * the seed files inherit the same private-by-default posture as the rest of the
 * seat home. A partially-written file can never be observed by the agent.
 */
const writeFileAtomic = (file: string, contents: string): void => {
  ensureDir(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, contents, { mode: 0o600 });
  fs.renameSync(tempFile, file);
};

/**
 * Remove OUR fenced seed block from a body, preserving all foreign content around
 * it (the same before/after-splice discipline the old upsert used, minus the
 * insert). Only the well-formed `BEGIN … END` span is cut. Returns the cleaned
 * body plus whether a block was actually found. Conservative: a half/reversed
 * fence is NOT touched (we never guess at foreign structure).
 */
const removeMemoryBlock = (existing: string): { body: string; removed: boolean } => {
  const beginIdx = existing.indexOf(MEMORY_BLOCK_BEGIN);
  const endIdx = existing.indexOf(MEMORY_BLOCK_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx <= beginIdx) {
    return { body: existing, removed: false };
  }
  const before = existing.slice(0, beginIdx).replace(/\s+$/, '');
  const after = existing.slice(endIdx + MEMORY_BLOCK_END.length).replace(/^\s+/, '');
  const joined = before.length > 0 && after.length > 0 ? `${before}\n\n${after}` : `${before}${after}`;
  const trimmed = joined.replace(/\s+$/, '');
  return { body: trimmed.length > 0 ? `${trimmed}\n` : '', removed: true };
};

/**
 * MIGRATION (v1.4 T1, idempotent): heal a legacy install where a prior version
 * wrote OUR "Client context (day-0 seed)" fence into the DEAD root
 * <hermesHome>/MEMORY.md (the wheel only ever loads memories/MEMORY.md, so the
 * block was never read). We:
 *   - do nothing if the root file is absent or carries no OUR-fence;
 *   - strip ONLY the fenced block, leaving any foreign content the user/agent may
 *     have added around it untouched (conservative — never touch outside-fence);
 *   - delete the root file entirely if it is empty / whitespace-only afterwards.
 * NEVER writes into memories/ (that is the agent's own budgeted hot-cache — G3).
 * Best-effort: any fs error is swallowed (migration must never block a seed/boot).
 * Runs on every seed write AND once at boot via readCompanyBrainSeedStateFromHome,
 * so an already-clean home is a cheap no-op. Returns true iff it changed anything.
 */
export function migrateStrayRootMemoryBlock(hermesHome: string): boolean {
  if (!hermesHome || !path.isAbsolute(hermesHome)) return false;
  const rootMemoryPath = path.join(hermesHome, 'MEMORY.md');
  let existing: string;
  try {
    existing = fs.readFileSync(rootMemoryPath, 'utf8');
  } catch {
    return false; // absent / unreadable → nothing to migrate
  }
  const { body, removed } = removeMemoryBlock(existing);
  if (!removed) return false; // no OUR-fence present → leave a foreign root file alone
  try {
    if (body.trim().length === 0) {
      fs.rmSync(rootMemoryPath, { force: true }); // Founder-decision #3: delete the stale file
    } else {
      writeFileAtomic(rootMemoryPath, body); // foreign content survives, our fence removed
    }
    return true;
  } catch {
    return false; // best-effort
  }
}

/**
 * PURE writer: persist the seed under an ALREADY-RESOLVED hermesHome. No seat
 * resolution, no Electron — inject the home and it unit-tests against a tmp dir.
 *
 * Guards:
 *  - rejects a blank/whitespace seed (mirrors isClientSeedSatisfied) — a real
 *    switching-cost seed only.
 *  - requires an ABSOLUTE hermesHome and writes ONLY under it (never escapes).
 */
export function writeCompanyBrainSeedToHome(args: {
  hermesHome: string;
  seed: ClientSeedInput;
  now?: () => Date;
}): WriteCompanyBrainSeedResult {
  const { hermesHome, seed } = args;
  if (!isClientSeedSatisfied(seed)) {
    throw new Error('Command EVE: refusing to write an empty Company-Brain seed.');
  }
  if (!hermesHome || !path.isAbsolute(hermesHome)) {
    throw new Error(`Command EVE: company-brain seed requires an absolute hermesHome (got ${JSON.stringify(hermesHome)}).`);
  }

  const seededAt = (args.now?.() ?? new Date()).toISOString();
  // F1 (HIGH) defense-in-depth: strip YAML-unprintables from the seed value at the
  // PERSIST boundary so seed.json and brief.md never carry a control char that would
  // later break the config.yaml environment_hint scalar (and silently drop the wheel
  // to its memory-OFF defaults). \n \t \r are preserved — a pasted brief keeps its
  // line structure; only C0(-\t\n\r)/DEL/C1/U+2028/U+2029 fold to a space.
  const cleanValue = stripYamlUnprintables(seed.value);
  const record: CompanyBrainSeedRecord = {
    schema_version: COMMAND_EVE_COMPANY_BRAIN_SEED_SCHEMA,
    seeded_at: seededAt,
    kind: seed.kind,
    value: cleanValue,
  };

  const brainDir = path.join(hermesHome, COMPANY_BRAIN_DIR);
  const seedJsonPath = path.join(brainDir, 'seed.json');
  const briefPath = path.join(brainDir, 'brief.md');

  ensureDir(hermesHome);

  // 1) company-brain/seed.json — the structured per-seat "seeded?" evidence.
  writeFileAtomic(seedJsonPath, `${JSON.stringify(record, null, 2)}\n`);

  // 2) company-brain/brief.md — the full brief, verbatim, for EVERY seed kind.
  //    THIS is the file the agent actually reads (read_file in its own, non-
  //    workspace-confined HERMES_HOME), and the §SEAT USER.md stamp
  //    (userMdTierStampCore) links to exactly this path. connect_client stores
  //    the client entity as a one-liner; paste_brief stores the whole brief.
  writeFileAtomic(briefPath, `${cleanValue.replace(/\s+$/, '')}\n`);

  // 3) Migration: kill any stale legacy root-MEMORY.md seed block (dead write —
  //    the wheel never loaded it). Idempotent; foreign content is preserved.
  const migratedRootMemory = migrateStrayRootMemoryBlock(hermesHome);

  return {
    ok: true,
    hermesHome,
    seedJsonPath,
    briefPath,
    migratedRootMemory,
    record,
  };
}

/**
 * Seat-aware wrapper: resolve the ACTIVE seat home (or an explicit seatId) and
 * write the seed there. This is the function the IPC provider calls.
 */
export function writeCompanyBrainSeed(args: {
  userDataPath: string;
  seatId?: string | null;
  seed: ClientSeedInput;
  now?: () => Date;
}): WriteCompanyBrainSeedResult {
  const home =
    args.seatId === undefined
      ? resolveActiveSeatHome(args.userDataPath).hermesHome
      : resolveSeatHome(args.userDataPath, args.seatId).hermesHome;
  return writeCompanyBrainSeedToHome({ hermesHome: home, seed: args.seed, now: args.now });
}

/**
 * Reader: answer "seeded?" from an ALREADY-RESOLVED hermesHome by reading the
 * structured marker. Never throws on a missing file — an unseeded seat simply
 * returns { seeded:false, record:null }.
 *
 * SIDE EFFECT (v1.4 T1, deliberate): this is the cheapest once-at-boot hook — it
 * already runs at bootstrap (runtimeBootstrapCore.ts) with the active seat home —
 * so it ALSO runs the idempotent legacy-root-MEMORY.md migration here. The
 * migration is a best-effort no-op on an already-clean home and never throws, so
 * the "seeded?" answer is unaffected. (It touches only <hermesHome>/MEMORY.md at
 * root — never seed.json, never memories/.)
 */
export function readCompanyBrainSeedStateFromHome(hermesHome: string): CompanyBrainSeedState {
  // Once-at-boot cleanup of the dead legacy root block (idempotent, best-effort).
  migrateStrayRootMemoryBlock(hermesHome);
  const seedJsonPath = path.join(hermesHome, COMPANY_BRAIN_DIR, 'seed.json');
  try {
    const raw = fs.readFileSync(seedJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CompanyBrainSeedRecord>;
    if (parsed && typeof parsed.value === 'string' && parsed.value.trim().length > 0 && (parsed.kind === 'connect_client' || parsed.kind === 'paste_brief')) {
      return {
        seeded: true,
        record: {
          schema_version: parsed.schema_version || COMMAND_EVE_COMPANY_BRAIN_SEED_SCHEMA,
          seeded_at: parsed.seeded_at || '',
          kind: parsed.kind,
          value: parsed.value,
        },
      };
    }
  } catch {
    // missing / unreadable / malformed → unseeded
  }
  return { seeded: false, record: null };
}

/** Seat-aware wrapper for the "seeded?" read (active seat or explicit seatId). */
export function readCompanyBrainSeedState(args: {
  userDataPath: string;
  seatId?: string | null;
}): CompanyBrainSeedState {
  const home =
    args.seatId === undefined
      ? resolveActiveSeatHome(args.userDataPath).hermesHome
      : resolveSeatHome(args.userDataPath, args.seatId).hermesHome;
  return readCompanyBrainSeedStateFromHome(home);
}
