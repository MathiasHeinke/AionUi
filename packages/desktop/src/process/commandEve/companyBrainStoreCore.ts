/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Company-Brain STORE v2 (v1.4 T2) — the per-seat, multi-entry knowledge store.
 *
 * WHAT THIS REPLACES. The v1 seed (companyBrainSeedCore) is a SINGLE freetext slot
 * (`company-brain/seed.json` v1 {kind:'paste_brief'|'connect_client', value}) and
 * "Weiteren Client ergänzen" REPLACED it — the single-slot lie. v2 is a proper
 * append-first store: a deterministic INDEX (brain.json) over per-entry Markdown
 * bodies (entries/<id>.md), so the operator can add / edit / delete many entries
 * (Firma, Angebot, Zielgruppe, Tonalität, Dos-&-Don'ts, Brief, Notiz) and EVE can
 * (in a later slice) append client knowledge — without ever clobbering the rest.
 *
 * LAYOUT (per-seat, under the ACTIVE seat's hermesHome).
 *   <seatHome>/company-brain/
 *     brain.json          # the ONLY index authority (schema v2)
 *     entries/<id>.md      # one node = one body file, 0600
 *     seed.json            # STAYS (v1 compat — §SEAT stamp + companyBrainStatus
 *                          #   still read it; migration references it)
 *
 * INDEX = SINGLE SOURCE OF TRUTH. brain.json holds the entry list (id, kind, title,
 * updated_at, author, source, body_file); the .md files hold only the bodies. A
 * reader lists from the index; a body is fetched on demand (readEntryBody). This
 * matches the T13 topology intent (the tree is an INDEX over files, not a new
 * storage system) — no vector DB, no embeddings, no seventh system.
 *
 * KINDS (v1.4). company | offer | audience | tone | dos_donts | brief | note. The
 * type is a string-union kept open enough for later 'project' / 'session_digest'
 * (spec §2 L2/L3) — so we TOLERATE an unknown kind on READ (never drop a foreign
 * entry we don't recognize) but REJECT it on WRITE (the desktop only writes the
 * allowlisted set; a future slice widens the allowlist deliberately).
 *
 * PURE / INJECTABLE. Every function takes an already-resolved seat home and an
 * injectable clock — no seat resolution, no Electron — so it unit-tests against a
 * tmp dir. The seat-resolving wrappers live in commandEveBridge (active-seat) so
 * this module never imports the process-local active-seat state.
 *
 * SECURITY. Entry ids are [a-z0-9-] only (assertEntryId), so an id can never become
 * a path-traversal segment; every write is atomic (tmp+rename) at 0o600; every
 * write path is asserted to stay strictly under company-brain/. The seat home
 * itself is guarded upstream (assertSeatId / resolveSeatHome) — this module refuses
 * a non-absolute home, same posture as companyBrainSeedCore.
 *
 * HONESTY (eve-doctrine). This slice is STORE + SCAFFOLD + IPC only. There is NO UI
 * here (T3) and NO EVE write-intake (T4 reconciler); author:'eve'/source:'chat' are
 * modelled in the schema but only 'user'/'settings' and the one 'seed-migration'
 * entry are produced today.
 */

import fs from 'fs';
import path from 'path';

import { COMPANY_BRAIN_DIR, readCompanyBrainSeedStateFromHome } from '@process/commandEve/companyBrainSeedCore';

/** Schema tag for the multi-entry index (company-brain/brain.json). */
export const COMMAND_EVE_COMPANY_BRAIN_SCHEMA = 'command-eve-company-brain/v2';

/** The subdir under company-brain/ that holds the per-entry Markdown bodies. */
export const ENTRIES_SUBDIR = 'entries';

/**
 * The kinds the DESKTOP writes today (v1.4). Read tolerates any string kind (a
 * later slice may introduce 'project'/'session_digest'); write rejects anything
 * outside this allowlist so the store can only grow deliberately.
 */
export const COMPANY_BRAIN_WRITE_KINDS = ['company', 'offer', 'audience', 'tone', 'dos_donts', 'brief', 'note'] as const;

/** A kind the desktop is allowed to WRITE today. */
export type CompanyBrainWriteKind = (typeof COMPANY_BRAIN_WRITE_KINDS)[number];

/**
 * A brain kind as it may appear in the INDEX. Open string-union: the allowlisted
 * write-kinds are the known set; a foreign/future kind (e.g. 'project') is still a
 * valid string we tolerate on read. `(string & {})` keeps editor autocomplete for
 * the known kinds while accepting any other string.
 */
export type CompanyBrainKind = CompanyBrainWriteKind | (string & {});

/** Who authored the entry. Only 'user' is produced by this slice (EVE = T4). */
export type CompanyBrainAuthor = 'user' | 'eve';

/** Where the entry came from. 'chat' is reserved for the T4 reconciler. */
export type CompanyBrainSource = 'settings' | 'chat' | 'seed-migration';

/** One entry as recorded in the index (brain.json). The body lives in body_file. */
export interface CompanyBrainEntry {
  id: string;
  kind: CompanyBrainKind;
  title: string;
  updated_at: string;
  author: CompanyBrainAuthor;
  source: CompanyBrainSource;
  /** Relative-to-company-brain/ path of the body Markdown (entries/<id>.md). */
  body_file: string;
}

/** The on-disk index shape (company-brain/brain.json). */
export interface CompanyBrainIndex {
  schema_version: string;
  entries: CompanyBrainEntry[];
}

export interface UpsertEntryInput {
  /** Reuse an existing id to EDIT in place; omit to CREATE (id auto-derived). */
  id?: string;
  kind: CompanyBrainWriteKind;
  title: string;
  body: string;
  author?: CompanyBrainAuthor;
  source?: CompanyBrainSource;
  now?: () => Date;
}

export interface UpsertEntryResult {
  ok: boolean;
  index: CompanyBrainIndex;
  entry: CompanyBrainEntry;
  /** Absolute path of the body file that was written. */
  bodyPath: string;
  created: boolean;
}

export interface RemoveEntryResult {
  ok: boolean;
  index: CompanyBrainIndex;
  removed: boolean;
}

export interface MigrateSeedResult {
  ok: boolean;
  /** True iff this call actually created brain.json from a v1 seed. */
  migrated: boolean;
  index: CompanyBrainIndex;
}

export interface ScaffoldResult {
  ok: boolean;
  /** True iff this call created brain.json (false = already existed / best-effort skip). */
  created: boolean;
  brainDir: string;
}

/** [a-z0-9-] only, no leading/trailing/double dash, 1..64 chars. */
const ENTRY_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ensureDir = (dir: string): void => {
  fs.mkdirSync(dir, { recursive: true });
};

/**
 * Atomic file write (temp + rename) at mode 0o600 — the SAME convention as
 * companyBrainSeedCore / SOUL.md / config.yaml, so bodies + index inherit the
 * private-by-default posture and a half-written file can never be observed.
 */
const writeFileAtomic = (file: string, contents: string): void => {
  ensureDir(path.dirname(file));
  const tempFile = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tempFile, contents, { mode: 0o600 });
  fs.renameSync(tempFile, file);
};

const assertAbsoluteHome = (hermesHome: string): void => {
  if (!hermesHome || !path.isAbsolute(hermesHome)) {
    throw new Error(`Command EVE: company-brain store requires an absolute hermesHome (got ${JSON.stringify(hermesHome)}).`);
  }
};

const brainDirOf = (hermesHome: string): string => path.join(hermesHome, COMPANY_BRAIN_DIR);
const brainJsonOf = (hermesHome: string): string => path.join(brainDirOf(hermesHome), 'brain.json');
const entriesDirOf = (hermesHome: string): string => path.join(brainDirOf(hermesHome), ENTRIES_SUBDIR);

/**
 * Fail-closed entry-id validation (assertSeatId discipline): an id is a bare
 * [a-z0-9-] slug so it can NEVER become a path-traversal segment. Rejects empty,
 * separators, '..', dotfiles, NUL, and anything the RE doesn't accept. Throws so a
 * bad id hard-stops before it can touch the filesystem.
 */
export function assertEntryId(id: string): string {
  if (typeof id !== 'string') {
    throw new Error(`Command EVE: rejected non-string company-brain entry id (${JSON.stringify(id)}).`);
  }
  const raw = id;
  if (raw.length === 0 || raw.length > 64) {
    throw new Error(`Command EVE: rejected out-of-range company-brain entry id (${JSON.stringify(id)}).`);
  }
  if (raw.includes('\0') || raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw.startsWith('.')) {
    throw new Error(`Command EVE: rejected unsafe company-brain entry id (path-traversal guard): ${JSON.stringify(id)}`);
  }
  if (!ENTRY_ID_RE.test(raw)) {
    throw new Error(`Command EVE: rejected malformed company-brain entry id (expected [a-z0-9-]): ${JSON.stringify(id)}`);
  }
  return raw;
}

/** Is `kind` one the desktop is allowed to WRITE today? */
export function isWritableKind(kind: string): kind is CompanyBrainWriteKind {
  return (COMPANY_BRAIN_WRITE_KINDS as readonly string[]).includes(kind);
}

const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * Derive a fresh entry id from kind + title: `<kind>-<title-slug>-<rand>`. The kind
 * is already an allowlisted slug; the title is slugified best-effort; a short random
 * suffix guarantees uniqueness even for identical titles. The final id is asserted,
 * so a pathological title can never produce an unsafe id.
 */
const deriveEntryId = (kind: CompanyBrainWriteKind, title: string): string => {
  const titleSlug = slugify(title);
  const rand = Math.random().toString(36).slice(2, 8);
  const base = titleSlug.length > 0 ? `${kind}-${titleSlug}-${rand}` : `${kind}-${rand}`;
  return assertEntryId(base.slice(0, 64).replace(/-+$/g, '') || `${kind}-${rand}`);
};

const emptyIndex = (): CompanyBrainIndex => ({ schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA, entries: [] });

/**
 * Coerce a parsed brain.json into a well-formed index. Drops entries that are not
 * objects or lack a safe id / body_file, but TOLERATES unknown kinds (keeps them).
 * Never throws — a malformed index reads as an empty index so the store self-heals.
 */
const coerceIndex = (parsed: unknown): CompanyBrainIndex => {
  if (!parsed || typeof parsed !== 'object') return emptyIndex();
  const rawEntries = (parsed as { entries?: unknown }).entries;
  const entries: CompanyBrainEntry[] = [];
  if (Array.isArray(rawEntries)) {
    for (const e of rawEntries) {
      if (!e || typeof e !== 'object') continue;
      const rec = e as Record<string, unknown>;
      const id = rec.id;
      if (typeof id !== 'string') continue;
      try {
        assertEntryId(id);
      } catch {
        continue; // an index entry with an unsafe id is dropped defensively
      }
      const kind = typeof rec.kind === 'string' ? rec.kind : 'note';
      const title = typeof rec.title === 'string' ? rec.title : id;
      const updated_at = typeof rec.updated_at === 'string' ? rec.updated_at : '';
      const author: CompanyBrainAuthor = rec.author === 'eve' ? 'eve' : 'user';
      const source: CompanyBrainSource =
        rec.source === 'chat' ? 'chat' : rec.source === 'seed-migration' ? 'seed-migration' : 'settings';
      const body_file = typeof rec.body_file === 'string' && rec.body_file.length > 0 ? rec.body_file : path.posix.join(ENTRIES_SUBDIR, `${id}.md`);
      entries.push({ id, kind, title, updated_at, author, source, body_file });
    }
  }
  return { schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA, entries };
};

/**
 * Read the index (company-brain/brain.json). A missing/unreadable/malformed file
 * returns an EMPTY index — never throws. Unknown kinds are preserved (read-tolerant).
 */
export function readBrainIndex(hermesHome: string): CompanyBrainIndex {
  assertAbsoluteHome(hermesHome);
  try {
    const raw = fs.readFileSync(brainJsonOf(hermesHome), 'utf8');
    return coerceIndex(JSON.parse(raw));
  } catch {
    return emptyIndex();
  }
}

/** List entries (index only — NO bodies). Convenience over readBrainIndex. */
export function listEntries(hermesHome: string): CompanyBrainEntry[] {
  return readBrainIndex(hermesHome).entries;
}

const writeIndex = (hermesHome: string, index: CompanyBrainIndex): void => {
  writeFileAtomic(brainJsonOf(hermesHome), `${JSON.stringify(index, null, 2)}\n`);
};

/**
 * Read a single entry body (entries/<id>.md). The id is asserted (traversal guard)
 * BEFORE it touches the filesystem. Returns null for a missing/unreadable body (an
 * index entry whose body file was lost reads as null rather than throwing).
 */
export function readEntryBody(hermesHome: string, id: string): string | null {
  assertAbsoluteHome(hermesHome);
  const safeId = assertEntryId(id);
  try {
    return fs.readFileSync(path.join(entriesDirOf(hermesHome), `${safeId}.md`), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Create or edit an entry. On CREATE (no id) an id is derived from kind+title; on
 * EDIT (id present) the same body file + index slot are rewritten in place. The
 * body is written first (atomic), then the index is rewritten (atomic) — the index
 * is the last authority to flip, so a crash mid-write never leaves the index
 * pointing at a body that was never written.
 *
 * Fail-closed: rejects a non-writable kind (allowlist), a blank title, a non-absolute
 * home, and any id that fails assertEntryId. author defaults to 'user', source to
 * 'settings' (the T3 UI path); EVE-authored entries arrive via the T4 reconciler.
 */
export function upsertEntry(hermesHome: string, input: UpsertEntryInput): UpsertEntryResult {
  assertAbsoluteHome(hermesHome);
  if (!isWritableKind(input.kind)) {
    throw new Error(`Command EVE: refusing to write company-brain entry with unknown kind ${JSON.stringify(input.kind)}.`);
  }
  const title = (input.title ?? '').trim();
  if (title.length === 0) {
    throw new Error('Command EVE: refusing to write a company-brain entry with a blank title.');
  }

  const index = readBrainIndex(hermesHome);
  const existingId = input.id !== undefined ? assertEntryId(input.id) : undefined;
  const id = existingId ?? deriveEntryId(input.kind, title);
  const created = !index.entries.some((e) => e.id === id);

  const updated_at = (input.now?.() ?? new Date()).toISOString();
  const body_file = path.posix.join(ENTRIES_SUBDIR, `${id}.md`);
  const entry: CompanyBrainEntry = {
    id,
    kind: input.kind,
    title,
    updated_at,
    author: input.author ?? 'user',
    source: input.source ?? 'settings',
    body_file,
  };

  // 1) body first (atomic) — the index only points at bodies that exist.
  const bodyPath = path.join(entriesDirOf(hermesHome), `${id}.md`);
  writeFileAtomic(bodyPath, `${(input.body ?? '').replace(/\s+$/, '')}\n`);

  // 2) index last (atomic) — replace-in-place on edit, append on create.
  const nextEntries = created ? [...index.entries, entry] : index.entries.map((e) => (e.id === id ? entry : e));
  const nextIndex: CompanyBrainIndex = { schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA, entries: nextEntries };
  writeIndex(hermesHome, nextIndex);

  return { ok: true, index: nextIndex, entry, bodyPath, created };
}

/**
 * Remove an entry: drop it from the index (atomic), then best-effort unlink its body
 * file. The index is updated first so a failed unlink never leaves a dangling index
 * slot. Idempotent — removing an absent id rewrites the same index and reports
 * removed:false.
 */
export function removeEntry(hermesHome: string, id: string): RemoveEntryResult {
  assertAbsoluteHome(hermesHome);
  const safeId = assertEntryId(id);
  const index = readBrainIndex(hermesHome);
  const nextEntries = index.entries.filter((e) => e.id !== safeId);
  const removed = nextEntries.length !== index.entries.length;
  const nextIndex: CompanyBrainIndex = { schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA, entries: nextEntries };
  writeIndex(hermesHome, nextIndex);
  if (removed) {
    try {
      fs.rmSync(path.join(entriesDirOf(hermesHome), `${safeId}.md`), { force: true });
    } catch {
      /* best-effort — the index is already correct */
    }
  }
  return { ok: true, index: nextIndex, removed };
}

/**
 * DAY-ZERO SCAFFOLD (idempotent, best-effort). Ensure company-brain/ + entries/ +
 * an empty brain.json exist so EVERY seat carries a functional (empty) brain from
 * first boot / first switch — even before the operator adds anything. If brain.json
 * already exists it is left untouched (never clobber a populated store). Any fs
 * error is swallowed so scaffolding can never block boot or a seat switch.
 */
export function ensureCompanyBrainScaffold(hermesHome: string): ScaffoldResult {
  try {
    assertAbsoluteHome(hermesHome);
  } catch {
    return { ok: false, created: false, brainDir: '' };
  }
  const brainDir = brainDirOf(hermesHome);
  try {
    ensureDir(entriesDirOf(hermesHome)); // creates company-brain/ + entries/
    const brainJson = brainJsonOf(hermesHome);
    if (fs.existsSync(brainJson)) {
      return { ok: true, created: false, brainDir };
    }
    writeIndex(hermesHome, emptyIndex());
    return { ok: true, created: true, brainDir };
  } catch {
    return { ok: false, created: false, brainDir };
  }
}

/**
 * MIGRATION v1 → v2 (idempotent). If a v1 seed (company-brain/seed.json) exists AND
 * brain.json is absent, fold the seed into ONE 'brief' entry:
 *   { kind:'brief', title:'Day-0 Briefing', author:'user', source:'seed-migration' }
 * The body is taken from company-brain/brief.md if present (the live file the agent
 * reads), else from the seed's `value`. seed.json is LEFT IN PLACE (v1 compat — the
 * §SEAT stamp and companyBrainStatus still read it).
 *
 * Idempotent by construction: it only runs when brain.json is ABSENT, so a second
 * call (brain.json now present) is a no-op. Unseeded seats scaffold to an empty
 * brain instead. Never throws — a migration failure degrades to an empty scaffold.
 */
export function migrateSeedToBrain(hermesHome: string, opts?: { now?: () => Date }): MigrateSeedResult {
  try {
    assertAbsoluteHome(hermesHome);
  } catch {
    return { ok: false, migrated: false, index: emptyIndex() };
  }

  // Already migrated (or already a v2 store) → no-op, return the live index.
  if (fs.existsSync(brainJsonOf(hermesHome))) {
    return { ok: true, migrated: false, index: readBrainIndex(hermesHome) };
  }

  const seedState = readCompanyBrainSeedStateFromHome(hermesHome);
  if (!seedState.seeded || !seedState.record) {
    // No v1 seed to migrate → just scaffold an empty brain.
    const scaffold = ensureCompanyBrainScaffold(hermesHome);
    return { ok: scaffold.ok, migrated: false, index: readBrainIndex(hermesHome) };
  }

  // Prefer the live brief.md body (what the agent reads today); fall back to the
  // seed value.
  let body = seedState.record.value;
  try {
    const briefRaw = fs.readFileSync(path.join(brainDirOf(hermesHome), 'brief.md'), 'utf8');
    if (briefRaw.trim().length > 0) body = briefRaw;
  } catch {
    /* no brief.md → use the seed value */
  }

  const result = upsertEntry(hermesHome, {
    kind: 'brief',
    title: 'Day-0 Briefing',
    body,
    author: 'user',
    source: 'seed-migration',
    now: opts?.now,
  });
  return { ok: result.ok, migrated: true, index: result.index };
}

/**
 * Day-Zero convenience for the boot / seat-switch hooks: migrate a v1 seed if one
 * exists (creating brain.json), else scaffold an empty brain. Idempotent + best-
 * effort — the single call the lifecycle hooks make so every seat ends up with a
 * functional brain.json exactly once.
 */
export function ensureCompanyBrainReady(hermesHome: string, opts?: { now?: () => Date }): CompanyBrainIndex {
  const migration = migrateSeedToBrain(hermesHome, opts);
  return migration.index;
}
