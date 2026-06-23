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
 *   - <hermesHome>/MEMORY.md gains a clearly-delimited, dated "Client context
 *     (day-0 seed)" block. MEMORY.md is the agent's own working-notes file
 *     (memory_enabled=true, runtimeBootstrapCore.ts:2051-2053) that is loaded
 *     into every turn's context — so this is WHERE the agent will actually
 *     consume the client truth. The block is fenced by stable BEGIN/END markers
 *     so a RE-SEED REPLACES it in place (idempotent — never endlessly appends).
 *
 *   - <hermesHome>/company-brain/seed.json is a structured, machine-readable
 *     marker so "has THIS seat been seeded?" is answerable from on-disk per-seat
 *     evidence (readCompanyBrainSeedState) rather than a shared global flag.
 *
 *   - for kind `paste_brief` the raw brief is ALSO dropped verbatim at
 *     <hermesHome>/company-brain/brief.md so the agent can read the full source
 *     text, not just the MEMORY.md summary block.
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
 * HONESTY (eve-doctrine): this module PERSISTS the seed; it does not make the
 * claim that EVE "learns" the client. The narrow claim is: each seat carries its
 * own client truth on disk under its own hermesHome, decided per-seat.
 */

import fs from 'fs';
import path from 'path';

import type { ClientSeedInput } from '@/common/config/creditsCore';
import { isClientSeedSatisfied } from '@/common/config/creditsCore';
import { resolveActiveSeatHome, resolveSeatHome } from '@process/commandEve/seatContextCore';

/** Schema tag for the on-disk per-seat seed marker. */
export const COMMAND_EVE_COMPANY_BRAIN_SEED_SCHEMA = 'command-eve-company-brain-seed/v1';

/** The subdir under hermesHome holding the structured marker + raw brief. */
export const COMPANY_BRAIN_DIR = 'company-brain';

/**
 * Stable fence markers around the MEMORY.md seed block. A re-seed REPLACES the
 * text between these markers (idempotent) instead of appending a new block, so a
 * file never accumulates duplicate "Client context" sections.
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
  /** Absolute path of MEMORY.md that received the delimited block. */
  memoryPath: string;
  /** Absolute path of the raw brief (paste_brief only), else null. */
  briefPath: string | null;
  record: CompanyBrainSeedRecord;
}

const ensureDir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
};

/**
 * Atomic file write (temp + rename) at mode 0o600 — the SAME convention used for
 * SOUL.md / config.yaml / receipts (runtimeBootstrapCore.ts:993, :2093-2095) so
 * the seed files inherit the same private-by-default posture as the rest of the
 * seat home. A partially-written MEMORY.md can never be observed by the agent.
 */
const writeFileAtomic = (file: string, contents: string): void => {
  ensureDir(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempFile, contents, { mode: 0o600 });
  fs.renameSync(tempFile, file);
};

const renderMemoryBlock = (record: CompanyBrainSeedRecord): string => {
  const kindLabel = record.kind === 'paste_brief' ? 'Pasted brief' : 'Connected client';
  // A fenced, dated, human-readable block. The value is indented as a markdown
  // block-quote so multi-line briefs stay inside the section and read cleanly in
  // the agent's context.
  const quoted = record.value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return [
    MEMORY_BLOCK_BEGIN,
    '## Client context (day-0 seed)',
    '',
    `_Seeded ${record.seeded_at} · source: ${kindLabel}_`,
    '',
    quoted,
    MEMORY_BLOCK_END,
  ].join('\n');
};

/**
 * Upsert the delimited seed block into an existing MEMORY.md body. If a prior
 * block exists (fenced by the markers) it is REPLACED in place; otherwise the
 * block is appended with a separating blank line. This is what makes re-seeding
 * idempotent — no duplicate blocks ever accumulate.
 */
const upsertMemoryBlock = (existing: string, block: string): string => {
  const beginIdx = existing.indexOf(MEMORY_BLOCK_BEGIN);
  const endIdx = existing.indexOf(MEMORY_BLOCK_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + MEMORY_BLOCK_END.length);
    return `${before.replace(/\s+$/, '')}\n\n${block}\n${after.replace(/^\s+/, '')}`.replace(/\s+$/, '') + '\n';
  }
  const base = existing.replace(/\s+$/, '');
  const prefix = base.length > 0 ? `${base}\n\n` : '';
  return `${prefix}${block}\n`;
};

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
  const record: CompanyBrainSeedRecord = {
    schema_version: COMMAND_EVE_COMPANY_BRAIN_SEED_SCHEMA,
    seeded_at: seededAt,
    kind: seed.kind,
    value: seed.value,
  };

  const brainDir = path.join(hermesHome, COMPANY_BRAIN_DIR);
  const seedJsonPath = path.join(brainDir, 'seed.json');
  const memoryPath = path.join(hermesHome, 'MEMORY.md');

  // 1) MEMORY.md — upsert the delimited block (create the file if absent).
  ensureDir(hermesHome);
  let existingMemory = '';
  try {
    existingMemory = fs.readFileSync(memoryPath, 'utf8');
  } catch {
    existingMemory = '';
  }
  const nextMemory = upsertMemoryBlock(existingMemory, renderMemoryBlock(record));
  writeFileAtomic(memoryPath, nextMemory);

  // 2) company-brain/seed.json — the structured per-seat "seeded?" evidence.
  writeFileAtomic(seedJsonPath, `${JSON.stringify(record, null, 2)}\n`);

  // 3) paste_brief → also drop the raw brief verbatim for full-source reads.
  let briefPath: string | null = null;
  if (seed.kind === 'paste_brief') {
    briefPath = path.join(brainDir, 'brief.md');
    writeFileAtomic(briefPath, `${seed.value.replace(/\s+$/, '')}\n`);
  }

  return {
    ok: true,
    hermesHome,
    seedJsonPath,
    memoryPath,
    briefPath,
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
 * PURE reader: answer "seeded?" from an ALREADY-RESOLVED hermesHome by reading
 * the structured marker. Never throws on a missing file — an unseeded seat
 * simply returns { seeded:false, record:null }.
 */
export function readCompanyBrainSeedStateFromHome(hermesHome: string): CompanyBrainSeedState {
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
