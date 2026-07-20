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

import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { COMPANY_BRAIN_DIR, readCompanyBrainSeedStateFromHome } from '@process/commandEve/companyBrainSeedCore';
import { withExclusiveFileLock } from '@process/services/project-workspace/storage/atomicJson';

/** Schema tag for the multi-entry index (company-brain/brain.json). */
export const COMMAND_EVE_COMPANY_BRAIN_SCHEMA = 'command-eve-company-brain/v2';

/** The subdir under company-brain/ that holds the per-entry Markdown bodies. */
export const ENTRIES_SUBDIR = 'entries';

/**
 * The kinds the DESKTOP writes today. Read tolerates any string kind (session_digest
 * arrives via the system writer); write rejects anything outside this allowlist so
 * the store can only grow deliberately.
 *
 * T8 (v1.4, 2026-07-02) — WIDENED by four ADDITIVE blueprint kinds: 'team', 'goals',
 * 'focus', 'projects'. These carry the fixed-section blueprint (Team / Ziele & Zukunft
 * / Fokus / Aktuelle Projekte) so EVE + the UI can update a section by its stable id.
 * No migration: read already tolerated foreign kinds, and existing entries/digests are
 * untouched. session_digest stays OUT of the user allowlist (system-writer only).
 */
export const COMPANY_BRAIN_WRITE_KINDS = [
  'company',
  'team',
  'offer',
  'audience',
  'projects',
  'goals',
  'focus',
  'tone',
  'dos_donts',
  'brief',
  'note',
] as const;

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
    throw new Error(
      `Command EVE: company-brain store requires an absolute hermesHome (got ${JSON.stringify(hermesHome)}).`
    );
  }
};

const brainDirOf = (hermesHome: string): string => path.join(hermesHome, COMPANY_BRAIN_DIR);
const brainJsonOf = (hermesHome: string): string => path.join(brainDirOf(hermesHome), 'brain.json');
const entriesDirOf = (hermesHome: string): string => path.join(brainDirOf(hermesHome), ENTRIES_SUBDIR);
const activeMutationLocks = new Set<string>();

type ExactRegularFile = {
  contents: string;
  dev: number;
  ino: number;
  size: number;
  sha256: string;
  mtimeMs: number;
};

type ExactDirectory = { dev: number; ino: number; realPath: string };

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function lstatIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function exactDirectory(directory: string, label: string): ExactDirectory | undefined {
  const before = lstatIfPresent(directory);
  if (!before) return undefined;
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`Command EVE: ${label} must be a real directory.`);
  }
  const realPath = fs.realpathSync(directory);
  const after = fs.lstatSync(directory);
  if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error(`Command EVE: ${label} changed while it was being validated.`);
  }
  return { dev: before.dev, ino: before.ino, realPath };
}

function ensureRealDirectory(directory: string, label: string): ExactDirectory {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const exact = exactDirectory(directory, label);
  if (!exact) throw new Error(`Command EVE: failed to create ${label}.`);
  return exact;
}

function existingBrainDirectory(hermesHome: string): ExactDirectory | undefined {
  assertAbsoluteHome(hermesHome);
  return exactDirectory(brainDirOf(hermesHome), 'company-brain/');
}

function ensureBrainDirectory(hermesHome: string): ExactDirectory {
  assertAbsoluteHome(hermesHome);
  fs.mkdirSync(path.resolve(hermesHome), { recursive: true, mode: 0o700 });
  return ensureRealDirectory(brainDirOf(hermesHome), 'company-brain/');
}

/**
 * Resolve entries/ without following a symlink and prove that its canonical path
 * remains the direct child of the canonical company-brain directory.
 */
function existingEntriesDirectory(hermesHome: string): string | undefined {
  const brain = existingBrainDirectory(hermesHome);
  if (!brain) return undefined;
  const entriesPath = entriesDirOf(hermesHome);
  const entries = exactDirectory(entriesPath, 'company-brain/entries/');
  if (!entries) return undefined;
  if (
    path.dirname(path.resolve(entriesPath)) !== path.resolve(brainDirOf(hermesHome)) ||
    path.dirname(entries.realPath) !== brain.realPath ||
    path.basename(entries.realPath) !== ENTRIES_SUBDIR
  ) {
    throw new Error('Command EVE: company-brain/entries/ escaped its canonical storage boundary.');
  }
  return entriesPath;
}

function ensureEntriesDirectory(hermesHome: string): string {
  const brain = ensureBrainDirectory(hermesHome);
  const entriesPath = entriesDirOf(hermesHome);
  const entries = ensureRealDirectory(entriesPath, 'company-brain/entries/');
  if (
    path.dirname(path.resolve(entriesPath)) !== path.resolve(brainDirOf(hermesHome)) ||
    path.dirname(entries.realPath) !== brain.realPath ||
    path.basename(entries.realPath) !== ENTRIES_SUBDIR
  ) {
    throw new Error('Command EVE: company-brain/entries/ escaped its canonical storage boundary.');
  }
  return entriesPath;
}

function exactRegularFile(file: string): ExactRegularFile | undefined {
  const before = lstatIfPresent(file);
  if (!before) return undefined;
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Command EVE: company-brain body/index path must be a regular file.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)
    );
    const descriptorStat = fs.fstatSync(descriptor);
    if (!descriptorStat.isFile()) {
      throw new Error('Command EVE: company-brain body/index descriptor is not a regular file.');
    }
    const contents = fs.readFileSync(descriptor, 'utf8');
    const descriptorAfterRead = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(file);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.dev !== descriptorStat.dev ||
      pathStat.ino !== descriptorStat.ino ||
      descriptorAfterRead.size !== descriptorStat.size ||
      descriptorAfterRead.mtimeMs !== descriptorStat.mtimeMs ||
      pathStat.size !== descriptorAfterRead.size ||
      pathStat.mtimeMs !== descriptorAfterRead.mtimeMs ||
      descriptorAfterRead.dev !== descriptorStat.dev ||
      descriptorAfterRead.ino !== descriptorStat.ino ||
      descriptorAfterRead.size !== Buffer.byteLength(contents, 'utf8')
    ) {
      throw new Error('Command EVE: company-brain body/index changed while it was being read.');
    }
    return {
      contents,
      dev: descriptorStat.dev,
      ino: descriptorStat.ino,
      size: descriptorAfterRead.size,
      sha256: crypto.createHash('sha256').update(contents, 'utf8').digest('hex'),
      mtimeMs: descriptorAfterRead.mtimeMs,
    };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameExactFile(left: ExactRegularFile, right: ExactRegularFile): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.contents === right.contents
  );
}

function writeBodyAtomic(hermesHome: string, name: string, contents: string): string {
  const entriesDirectory = ensureEntriesDirectory(hermesHome);
  const file = path.join(entriesDirectory, name);
  writeFileAtomic(file, contents);
  // A parent-directory replacement must never turn a successful write into an
  // out-of-bound publication.
  ensureEntriesDirectory(hermesHome);
  return file;
}

function writeBodyCreateOnly(hermesHome: string, name: string, contents: string): ExactRegularFile {
  const entriesDirectory = ensureEntriesDirectory(hermesHome);
  const file = path.join(entriesDirectory, name);
  fs.writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
  ensureEntriesDirectory(hermesHome);
  const snapshot = exactRegularFile(file);
  if (!snapshot || snapshot.contents !== contents) {
    throw new Error('Command EVE: create-only company-brain staging body changed while it was written.');
  }
  return snapshot;
}

function unlinkExactRegularFileIfPresent(hermesHome: string, name: string, expected?: ExactRegularFile): boolean {
  const entriesDirectory = existingEntriesDirectory(hermesHome);
  if (!entriesDirectory) return false;
  const file = path.join(entriesDirectory, name);
  const observed = exactRegularFile(file);
  if (!observed) return false;
  if (expected && !sameExactFile(observed, expected)) {
    throw new Error('Command EVE: company-brain body ownership changed before removal.');
  }
  const immediatelyBeforeUnlink = exactRegularFile(file);
  if (!immediatelyBeforeUnlink || !sameExactFile(observed, immediatelyBeforeUnlink)) {
    throw new Error('Command EVE: company-brain body changed immediately before removal.');
  }
  fs.unlinkSync(file);
  return true;
}

function brainMutationLockPath(hermesHome: string): string {
  return path.join(path.resolve(hermesHome), COMPANY_BRAIN_DIR, 'brain.json.lock');
}

function hasCompanyBrainMutationLock(hermesHome: string): boolean {
  return activeMutationLocks.has(brainMutationLockPath(hermesHome));
}

/**
 * One cross-process mutation fence for every brain.json read-modify-write path.
 * The callback is synchronous by contract, so a same-stack nested store operation
 * can safely reuse the held lock without opening an interleaving window.
 */
export function withCompanyBrainMutationLock<T>(hermesHome: string, operation: () => T): T {
  assertAbsoluteHome(hermesHome);
  const lockPath = brainMutationLockPath(hermesHome);
  if (activeMutationLocks.has(lockPath)) return operation();
  return withExclusiveFileLock(lockPath, () => {
    activeMutationLocks.add(lockPath);
    try {
      return operation();
    } finally {
      activeMutationLocks.delete(lockPath);
    }
  });
}

function withCompanyBrainMutationLocks<T>(hermesHomes: readonly string[], operation: () => T): T {
  const ordered = [
    ...new Set(
      hermesHomes.map((home) => {
        assertAbsoluteHome(home);
        return path.resolve(home);
      })
    ),
  ].toSorted((left, right) => brainMutationLockPath(left).localeCompare(brainMutationLockPath(right)));

  const alreadyHeld = ordered.filter((home) => activeMutationLocks.has(brainMutationLockPath(home)));
  if (alreadyHeld.length > 0 && alreadyHeld.length !== ordered.length) {
    throw new Error('Command EVE: refusing an out-of-order partial two-home mutation lock acquisition.');
  }

  const acquire = (index: number): T => {
    if (index >= ordered.length) return operation();
    const home = ordered[index];
    const lockPath = brainMutationLockPath(home);
    if (activeMutationLocks.has(lockPath)) return acquire(index + 1);
    return withExclusiveFileLock(lockPath, () => {
      activeMutationLocks.add(lockPath);
      try {
        return acquire(index + 1);
      } finally {
        activeMutationLocks.delete(lockPath);
      }
    });
  };

  return acquire(0);
}

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
    throw new Error(
      `Command EVE: rejected unsafe company-brain entry id (path-traversal guard): ${JSON.stringify(id)}`
    );
  }
  if (!ENTRY_ID_RE.test(raw)) {
    throw new Error(
      `Command EVE: rejected malformed company-brain entry id (expected [a-z0-9-]): ${JSON.stringify(id)}`
    );
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
  const nonce = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const titleBudget = Math.max(0, 64 - kind.length - nonce.length - 2);
  const titleSlug = slugify(title).slice(0, titleBudget).replace(/-+$/g, '');
  return assertEntryId(titleSlug.length > 0 ? `${kind}-${titleSlug}-${nonce}` : `${kind}-${nonce}`);
};

/**
 * An omitted id always means CREATE. A UUID collision (index or disk) is retried;
 * it must never silently turn the operation into edit semantics.
 */
function deriveUnusedEntryId(
  hermesHome: string,
  index: CompanyBrainIndex,
  kind: CompanyBrainWriteKind,
  title: string
): string {
  const entriesDirectory = ensureEntriesDirectory(hermesHome);
  const indexedIds = new Set(index.entries.map((entry) => entry.id));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = deriveEntryId(kind, title);
    if (indexedIds.has(candidate)) continue;
    if (
      lstatIfPresent(path.join(entriesDirectory, `${candidate}.md`)) ||
      lstatIfPresent(path.join(entriesDirectory, `.staging-${candidate}.md`))
    ) {
      continue;
    }
    return candidate;
  }
  throw new Error('Command EVE: failed to allocate a collision-free company-brain entry id.');
}

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
      const body_file =
        typeof rec.body_file === 'string' && rec.body_file.length > 0
          ? rec.body_file
          : path.posix.join(ENTRIES_SUBDIR, `${id}.md`);
      entries.push({ id, kind, title, updated_at, author, source, body_file });
    }
  }
  return { schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA, entries };
};

function strictIndex(parsed: unknown): CompanyBrainIndex {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Command EVE: malformed company-brain index.');
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !Object.hasOwn(record, 'schema_version') ||
    !Object.hasOwn(record, 'entries') ||
    record.schema_version !== COMMAND_EVE_COMPANY_BRAIN_SCHEMA ||
    !Array.isArray(record.entries)
  ) {
    throw new Error('Command EVE: malformed company-brain index.');
  }

  const ids = new Set<string>();
  const entries = record.entries.map((candidate): CompanyBrainEntry => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Command EVE: malformed company-brain index entry.');
    }
    const entry = candidate as Record<string, unknown>;
    const keys = ['id', 'kind', 'title', 'updated_at', 'author', 'source', 'body_file'] as const;
    if (Object.keys(entry).length !== keys.length || !keys.every((key) => Object.hasOwn(entry, key))) {
      throw new Error('Command EVE: malformed company-brain index entry.');
    }
    const id = typeof entry.id === 'string' ? assertEntryId(entry.id) : '';
    if (
      !id ||
      ids.has(id) ||
      typeof entry.kind !== 'string' ||
      entry.kind.length === 0 ||
      typeof entry.title !== 'string' ||
      entry.title.length === 0 ||
      typeof entry.updated_at !== 'string' ||
      entry.updated_at.length === 0 ||
      (entry.author !== 'user' && entry.author !== 'eve') ||
      (entry.source !== 'settings' && entry.source !== 'chat' && entry.source !== 'seed-migration') ||
      entry.body_file !== path.posix.join(ENTRIES_SUBDIR, `${id}.md`)
    ) {
      throw new Error('Command EVE: malformed company-brain index entry.');
    }
    ids.add(id);
    return {
      id,
      kind: entry.kind,
      title: entry.title,
      updated_at: entry.updated_at,
      author: entry.author,
      source: entry.source,
      body_file: entry.body_file,
    };
  });
  return { schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA, entries };
}

/**
 * Lossless mutation reader. Public reads remain tolerant, but a read-modify-write
 * must never turn malformed/partially-valid bytes into a new empty index.
 */
function readBrainIndexForMutation(hermesHome: string, allowMissing = false): CompanyBrainIndex {
  assertAbsoluteHome(hermesHome);
  const brainDirectory = existingBrainDirectory(hermesHome);
  if (!brainDirectory) {
    if (allowMissing) return emptyIndex();
    throw new Error('Command EVE: company-brain index is absent.');
  }
  const snapshot = exactRegularFile(brainJsonOf(hermesHome));
  if (!snapshot) {
    if (allowMissing) return emptyIndex();
    throw new Error('Command EVE: company-brain index is absent.');
  }
  return strictIndex(JSON.parse(snapshot.contents) as unknown);
}

/**
 * Read the index (company-brain/brain.json). A missing/unreadable/malformed file
 * returns an EMPTY index — never throws. Unknown kinds are preserved (read-tolerant).
 */
export function readBrainIndex(hermesHome: string): CompanyBrainIndex {
  assertAbsoluteHome(hermesHome);
  try {
    if (!existingBrainDirectory(hermesHome)) return emptyIndex();
    const snapshot = exactRegularFile(brainJsonOf(hermesHome));
    if (!snapshot) return emptyIndex();
    return coerceIndex(JSON.parse(snapshot.contents));
  } catch {
    return emptyIndex();
  }
}

/** List entries (index only — NO bodies). Convenience over readBrainIndex. */
export function listEntries(hermesHome: string): CompanyBrainEntry[] {
  return readBrainIndex(hermesHome).entries;
}

/** An index entry enriched with the DISK truth the list surfaces need (1.6.2). */
export interface CompanyBrainEntryWithState extends CompanyBrainEntry {
  /**
   * Blueprint sections: the body carries real content beyond the scaffolded
   * placeholder (isBlueprintBodyFilled). Other kinds: the body is non-empty.
   */
  filled: boolean;
  /**
   * Body-file mtime (ms epoch), null when the body is missing. This is the
   * freshness truth: EVE edits section bodies DIRECTLY (SOUL directive) and the
   * reconciler deliberately skips already-indexed ids, so index `updated_at`
   * goes stale the moment she writes — the mtime never does.
   */
  body_mtime_ms: number | null;
}

/**
 * 1.6.2 — list entries WITH per-entry fill state read from the BODIES on disk.
 * The settings dialog previously derived "leer / N von 10 ausgefüllt" from a
 * renderer-local body cache that starts empty on every open, so a fully filled
 * brain rendered as 0/10 until each section was clicked (live incident
 * 2026-07-03). The fill decision belongs HERE, next to the files.
 */
export function listEntriesWithState(hermesHome: string): CompanyBrainEntryWithState[] {
  const placeholders = new Map<string, string>(BLUEPRINT_SECTIONS.map((s) => [s.id, s.placeholder]));
  return listEntries(hermesHome).map((entry) => {
    const body = readEntryBody(hermesHome, entry.id);
    const placeholder = placeholders.get(entry.id);
    const filled =
      placeholder !== undefined ? isBlueprintBodyFilled(body, placeholder) : (body ?? '').trim().length > 0;
    let bodyMtimeMs: number | null = null;
    try {
      const entriesDirectory = existingEntriesDirectory(hermesHome);
      const snapshot = entriesDirectory ? exactRegularFile(path.join(entriesDirectory, `${entry.id}.md`)) : undefined;
      bodyMtimeMs = snapshot?.mtimeMs ?? null;
    } catch {
      // missing/unreadable body — null keeps the index timestamp authoritative
    }
    return { ...entry, filled, body_mtime_ms: bodyMtimeMs };
  });
}

const writeIndex = (hermesHome: string, index: CompanyBrainIndex): void => {
  ensureBrainDirectory(hermesHome);
  const existing = lstatIfPresent(brainJsonOf(hermesHome));
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error('Command EVE: brain.json must be a regular file.');
  }
  writeFileAtomic(brainJsonOf(hermesHome), `${JSON.stringify(index, null, 2)}\n`);
  ensureBrainDirectory(hermesHome);
};

/**
 * Read a single entry body (entries/<id>.md). The id is asserted (traversal guard)
 * BEFORE it touches the filesystem. Returns null for a missing/unreadable body (an
 * index entry whose body file was lost reads as null rather than throwing).
 */
export function readEntryBody(hermesHome: string, id: string): string | null {
  assertAbsoluteHome(hermesHome);
  const safeId = assertEntryId(id);
  const entriesDirectory = existingEntriesDirectory(hermesHome);
  if (!entriesDirectory) return null;
  try {
    return exactRegularFile(path.join(entriesDirectory, `${safeId}.md`))?.contents ?? null;
  } catch {
    // Tolerant read only: never follow a symlink/special file and never expose its
    // target bytes. Mutation paths use the strict helpers and still fail closed.
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
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    return withCompanyBrainMutationLock(hermesHome, () => upsertEntry(hermesHome, input));
  }
  assertAbsoluteHome(hermesHome);
  if (!isWritableKind(input.kind)) {
    throw new Error(
      `Command EVE: refusing to write company-brain entry with unknown kind ${JSON.stringify(input.kind)}.`
    );
  }
  const title = (input.title ?? '').trim();
  if (title.length === 0) {
    throw new Error('Command EVE: refusing to write a company-brain entry with a blank title.');
  }

  ensureEntriesDirectory(hermesHome);
  const index = readBrainIndexForMutation(hermesHome, true);
  const existingId = input.id !== undefined ? assertEntryId(input.id) : undefined;
  const id = existingId ?? deriveUnusedEntryId(hermesHome, index, input.kind, title);
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

  // F6 (MEDIUM) — STAGED body write to defeat reconciler resurrection. A CREATE
  // writes the body to `.staging-<id>.md` FIRST (a dotfile — the reconciler skips
  // dotfiles, so a crash between the body write and the index commit leaves an
  // UN-adoptable staging file, not an orphan the reconciler folds in as an eve
  // note). The index is committed, THEN the staging file is renamed onto the final
  // `<id>.md`. An EDIT (existing id already in the index) writes `<id>.md` directly
  // — it is already referenced, so there is no resurrection window to protect.
  const bodyPath = path.join(entriesDirOf(hermesHome), `${id}.md`);
  const bodyContents = `${(input.body ?? '').replace(/\s+$/, '')}\n`;
  if (created) {
    writeBodyCreateOnly(hermesHome, `.staging-${id}.md`, bodyContents);
  } else {
    writeBodyAtomic(hermesHome, `${id}.md`, bodyContents);
  }

  // 2) index (atomic) — replace-in-place on edit, append on create.
  const nextEntries = created ? [...index.entries, entry] : index.entries.map((e) => (e.id === id ? entry : e));
  const nextIndex: CompanyBrainIndex = { schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA, entries: nextEntries };
  writeIndex(hermesHome, nextIndex);

  // 3) CREATE only: publish with a create-only hard link. A raw write_file body
  //    that appears after the index commit wins EEXIST and is never overwritten;
  //    the exact staging body remains available for explicit recovery.
  if (created && !promoteExactStagingBody(hermesHome, entry, bodyContents)) {
    throw new Error('Command EVE: failed to promote the entry staging body.');
  }

  return { ok: true, index: nextIndex, entry, bodyPath, created };
}

/**
 * Remove an entry. F6 (MEDIUM) — ORDER INVERTED: the body file is UNLINKED FIRST,
 * and only THEN is the index rewritten (atomic). This is the reconciler-safe order:
 * the sole tolerated crash window is "index slot without a body" (a dangling slot
 * whose readEntryBody returns null — harmless, self-heals on the next remove/edit).
 * The DANGEROUS order (index-first) leaves "body on disk, no index slot" — which the
 * T4 reconciler then RESURRECTS as an author:'eve' note, un-deleting what the user
 * just deleted. If the unlink FAILS (e.g. EPERM) we do NOT rewrite the index — the
 * entry stays fully present (fail-closed: never half-remove). Idempotent — removing
 * an absent id unlinks nothing and rewrites the same index (removed:false).
 */
export function removeEntry(hermesHome: string, id: string): RemoveEntryResult {
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    return withCompanyBrainMutationLock(hermesHome, () => removeEntry(hermesHome, id));
  }
  assertAbsoluteHome(hermesHome);
  const safeId = assertEntryId(id);
  const index = readBrainIndexForMutation(hermesHome);
  const nextEntries = index.entries.filter((e) => e.id !== safeId);
  const removed = nextEntries.length !== index.entries.length;

  if (removed) {
    // 1) body FIRST. If the unlink throws (not merely absent), abort WITHOUT
    //    touching the index so the entry is never left as an index-less body the
    //    reconciler would adopt. fs.rmSync({force:true}) does not throw on ENOENT.
    try {
      unlinkExactRegularFileIfPresent(hermesHome, `${safeId}.md`);
      unlinkExactRegularFileIfPresent(hermesHome, `.staging-${safeId}.md`);
    } catch {
      return { ok: false, index, removed: false };
    }
  }

  // 2) index LAST — the tolerated residue is a dangling index slot, never an
  //    orphan body. A no-op remove still rewrites the identical index (idempotent).
  const nextIndex: CompanyBrainIndex = { schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA, entries: nextEntries };
  writeIndex(hermesHome, nextIndex);
  return { ok: true, index: nextIndex, removed };
}

/**
 * F8 (MEDIUM) — MIRROR a 'brief' body onto company-brain/brief.md. The §SEAT USER.md
 * stamp points the agent at company-brain/brief.md, but a T3 edit of the day-0 brief
 * updates only the brain ENTRY (entries/<id>.md) — so brief.md and the brief entry
 * diverged (the agent kept reading the stale brief.md). This atomically writes the
 * brief body onto <home>/company-brain/brief.md at 0600 (the SAME file + posture the
 * seed writer uses), keeping the two in sync. Best-effort by contract: it NEVER
 * throws — a failed mirror must not fail the upsert. Only 'brief'-kind edits call it.
 */
export function mirrorBriefBodyToFile(hermesHome: string, body: string): boolean {
  try {
    assertAbsoluteHome(hermesHome);
    writeFileAtomic(path.join(brainDirOf(hermesHome), 'brief.md'), `${(body ?? '').replace(/\s+$/, '')}\n`);
    return true;
  } catch {
    return false; // best-effort — the upsert already succeeded
  }
}

/**
 * DAY-ZERO SCAFFOLD (idempotent, best-effort). Ensure company-brain/ + entries/ +
 * an empty brain.json exist so EVERY seat carries a functional (empty) brain from
 * first boot / first switch — even before the operator adds anything. If brain.json
 * already exists it is left untouched (never clobber a populated store). Any fs
 * error is swallowed so scaffolding can never block boot or a seat switch.
 */
export function ensureCompanyBrainScaffold(hermesHome: string): ScaffoldResult {
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    try {
      return withCompanyBrainMutationLock(hermesHome, () => ensureCompanyBrainScaffold(hermesHome));
    } catch {
      return { ok: false, created: false, brainDir: '' };
    }
  }
  try {
    assertAbsoluteHome(hermesHome);
  } catch {
    return { ok: false, created: false, brainDir: '' };
  }
  const brainDir = brainDirOf(hermesHome);
  try {
    ensureEntriesDirectory(hermesHome); // creates company-brain/ + entries/
    const brainJson = brainJsonOf(hermesHome);
    const existing = lstatIfPresent(brainJson);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error('Command EVE: brain.json must be a regular file.');
      }
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
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    try {
      return withCompanyBrainMutationLock(hermesHome, () => migrateSeedToBrain(hermesHome, opts));
    } catch {
      return { ok: false, migrated: false, index: emptyIndex() };
    }
  }
  try {
    assertAbsoluteHome(hermesHome);
  } catch {
    return { ok: false, migrated: false, index: emptyIndex() };
  }

  // Already migrated (or already a v2 store) → no-op, return the live index.
  if (lstatIfPresent(brainJsonOf(hermesHome))) {
    return { ok: true, migrated: false, index: readBrainIndexForMutation(hermesHome) };
  }

  const seedState = readCompanyBrainSeedStateFromHome(hermesHome);
  if (!seedState.seeded || !seedState.record) {
    // No v1 seed to migrate → just scaffold an empty brain.
    const scaffold = ensureCompanyBrainScaffold(hermesHome);
    return {
      ok: scaffold.ok,
      migrated: false,
      index: scaffold.ok ? readBrainIndexForMutation(hermesHome) : emptyIndex(),
    };
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
  // 1.6.2 ADOPT-GUARD (review finding): after an index QUARANTINE this migration
  // re-runs (brain.json is gone) — but EVE writes the Briefing body DIRECTLY, so
  // entries/brief-day-0.md can be NEWER than the brief.md mirror (which only the
  // settings upsert refreshes). An existing on-disk Briefing body always wins;
  // re-staging the stale mirror over it would clobber her content.
  const existingBriefBody = readEntryBody(hermesHome, COMMAND_EVE_DAY_ZERO_BRIEF_ID);
  if (existingBriefBody !== null && existingBriefBody.trim().length > 0) body = existingBriefBody;

  const result = upsertEntry(hermesHome, {
    // F5: STABLE day-0 id so a legacy migration converges with a later seed IPC
    // upsert (same id → UPDATE, never a duplicate Day-0 entry).
    id: COMMAND_EVE_DAY_ZERO_BRIEF_ID,
    kind: 'brief',
    title: 'Day-0 Briefing',
    body,
    author: 'user',
    source: 'seed-migration',
    now: opts?.now,
  });
  return { ok: result.ok, migrated: true, index: result.index };
}

/** The title of an EVE-authored note whose body has no leading '# ' heading. */
const EVE_NOTE_FALLBACK_TITLE = 'EVE-Notiz';

/**
 * STABLE id for the day-0 briefing entry (F5). Both the seed IPC handler's
 * best-effort upsert AND the v1→v2 migration use this SAME id, so a re-seed / a
 * legacy migration UPDATES the one Day-0 entry in place instead of duplicating it —
 * the seed→entry path converges on exactly one 'brief' entry per seat.
 */
export const COMMAND_EVE_DAY_ZERO_BRIEF_ID = 'brief-day-0';

/** Result of a reconcile pass (T4 — EVE write-path intake). */
export interface ReconcileResult {
  ok: boolean;
  /** The (possibly-updated) index after intake. */
  index: CompanyBrainIndex;
  /** Number of previously-unindexed .md files folded into brain.json this pass. */
  adopted: number;
  /** The ids adopted this pass (audit/test). */
  adoptedIds: string[];
}

/**
 * Lift a note title from a Markdown body: the first non-empty line, and — when
 * that line is an ATX H1 (`# Titel`) — its heading text. Falls back to the given
 * default for an empty/whitespace body so an adopted entry never carries a blank
 * title. Trimmed to SEAT_ENTITY_MAX_LEN-ish so a runaway first line can't bloat
 * the index (mirrors the §SEAT first-line lift discipline).
 */
const titleFromBody = (body: string, fallback: string): string => {
  const firstLine = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return fallback;
  const heading = /^#{1,6}\s+(.*\S)\s*$/.exec(firstLine);
  const title = (heading ? heading[1] : firstLine).trim();
  if (title.length === 0) return fallback;
  return title.length > 120 ? `${title.slice(0, 119)}…` : title;
};

/**
 * T4 — EVE WRITE-PATH RECONCILER (Option A, spec §4). EVE writes durable client
 * knowledge with the wheel's `write_file` tool straight into
 * company-brain/entries/note-<slug>.md (allowed — it is her own HERMES_HOME). The
 * DESKTOP stays the deterministic INDEX authority: this pass finds any DIRECT .md
 * child of entries/ that is NOT referenced by brain.json and folds it in as
 *   { kind:'note', title: <first-H1 or first line>, author:'eve', source:'chat' }.
 *
 * SAFETY / TRAVERSAL. Only DIRECT children of entries/ are considered (readdir,
 * withFileTypes — no recursion, symlinks are not followed as dirs). The on-disk
 * BASENAME (minus `.md`) must itself pass assertEntryId; a file whose name is not a
 * safe [a-z0-9-] slug is IGNORED (never renamed, never adopted) — we never
 * synthesize an id for it, so a crafted filename can neither traverse nor collide.
 * Non-.md files and dotfiles are skipped.
 *
 * IDEMPOTENT + best-effort. A file already in the index (matched by id) is left
 * untouched — its title/author are NEVER rewritten, so a later user edit through
 * Settings is not clobbered by a reconcile. A missing entries/ dir or any fs error
 * degrades to a no-op (ok:false, adopted:0). The index is rewritten (atomic) only
 * when something was actually adopted.
 */
export function reconcileUnindexedEntries(hermesHome: string, opts?: { now?: () => Date }): ReconcileResult {
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    try {
      return withCompanyBrainMutationLock(hermesHome, () => reconcileUnindexedEntries(hermesHome, opts));
    } catch {
      return { ok: false, index: emptyIndex(), adopted: 0, adoptedIds: [] };
    }
  }
  let index: CompanyBrainIndex;
  try {
    assertAbsoluteHome(hermesHome);
    index = readBrainIndexForMutation(hermesHome, true);
  } catch {
    return { ok: false, index: emptyIndex(), adopted: 0, adoptedIds: [] };
  }

  let entriesDir: string;
  let dirents: fs.Dirent[];
  try {
    const existingEntries = existingEntriesDirectory(hermesHome);
    if (!existingEntries) return { ok: false, index, adopted: 0, adoptedIds: [] };
    entriesDir = existingEntries;
    dirents = fs.readdirSync(entriesDir, { withFileTypes: true });
  } catch {
    // No entries/ dir (or unreadable) → nothing to reconcile.
    return { ok: false, index, adopted: 0, adoptedIds: [] };
  }

  const known = new Set(index.entries.map((e) => e.id));
  const now = (opts?.now?.() ?? new Date()).toISOString();
  const adoptedIds: string[] = [];
  const adopted: CompanyBrainEntry[] = [];

  for (const dirent of dirents) {
    // Only DIRECT regular-file children ending in .md — no recursion, no dirs,
    // no symlinked directories treated as entries.
    if (!dirent.isFile()) continue;
    const name = dirent.name;
    if (name.startsWith('.') || !name.endsWith('.md')) continue;
    const base = name.slice(0, -'.md'.length);
    // The ON-DISK basename must itself be a safe entry id; otherwise IGNORE it
    // (never rename, never synthesize an id — a crafted filename can't collide).
    let id: string;
    try {
      id = assertEntryId(base);
    } catch {
      continue;
    }
    if (known.has(id)) continue; // already indexed → never rewrite its title/author

    let body = '';
    try {
      const bodySnapshot = exactRegularFile(path.join(entriesDir, name));
      if (!bodySnapshot) continue;
      body = bodySnapshot.contents;
    } catch {
      continue; // unreadable body → skip (don't adopt a phantom)
    }
    const entry: CompanyBrainEntry = {
      id,
      kind: 'note',
      title: titleFromBody(body, EVE_NOTE_FALLBACK_TITLE),
      updated_at: now,
      author: 'eve',
      source: 'chat',
      body_file: path.posix.join(ENTRIES_SUBDIR, `${id}.md`),
    };
    adopted.push(entry);
    adoptedIds.push(id);
    known.add(id);
  }

  if (adopted.length === 0) {
    return { ok: true, index, adopted: 0, adoptedIds: [] };
  }

  const nextIndex: CompanyBrainIndex = {
    schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA,
    entries: [...index.entries, ...adopted],
  };
  try {
    writeIndex(hermesHome, nextIndex);
  } catch {
    // Best-effort: a failed index write degrades to a no-op (the .md stays on
    // disk unindexed; the next pass retries). Report the in-memory intent.
    return { ok: false, index: nextIndex, adopted: adopted.length, adoptedIds };
  }
  return { ok: true, index: nextIndex, adopted: adopted.length, adoptedIds };
}

/**
 * L3 SESSION-DIGEST kind (v1.4 T5). This is the ONE kind that is NOT in
 * COMPANY_BRAIN_WRITE_KINDS (the USER-IPC write allowlist) — so the Settings write
 * path can never produce it — yet is written deterministically by the DESKTOP's
 * main-side digest writer through upsertSystemEntry (below). Read already tolerates
 * it (open string-union), so a digest shows up in the Company-Brain list like any
 * other entry.
 */
export const SESSION_DIGEST_KIND = 'session_digest' as const;
/** Project identity summaries are system-owned and never accepted by the renderer write allowlist. */
export const PROJECT_BRAIN_KIND = 'project' as const;

/** Max L3 session_digest entries kept per seat before FIFO-pruning (spec §2 L3). */
export const SESSION_DIGEST_MAX = 50;

/** Kinds the DESKTOP SYSTEM writer (not the user IPC) may write — T5 widens by one. */
const SYSTEM_WRITE_KINDS: readonly string[] = [...COMPANY_BRAIN_WRITE_KINDS, SESSION_DIGEST_KIND, PROJECT_BRAIN_KIND];

export interface UpsertSystemEntryInput {
  /** REQUIRED for a system entry — the writer owns the id (stable so re-digest replaces). */
  id: string;
  kind: string;
  title: string;
  body: string;
  author?: CompanyBrainAuthor;
  source?: CompanyBrainSource;
  now?: () => Date;
}

export interface RecoverSystemEntryPromotionInput extends Omit<UpsertSystemEntryInput, 'now'> {
  updated_at: string;
}

function expectedSystemEntry(input: RecoverSystemEntryPromotionInput): {
  id: string;
  entry: CompanyBrainEntry;
  bodyContents: string;
} {
  if (!SYSTEM_WRITE_KINDS.includes(input.kind)) throw new Error('Command EVE: invalid SYSTEM entry recovery kind.');
  const id = assertEntryId(input.id);
  const title = (input.title ?? '').trim();
  if (title.length === 0 || new Date(input.updated_at).toISOString() !== input.updated_at) {
    throw new Error('Command EVE: invalid SYSTEM entry recovery identity.');
  }
  return {
    id,
    entry: {
      id,
      kind: input.kind,
      title,
      updated_at: input.updated_at,
      author: input.author ?? 'eve',
      source: input.source ?? 'chat',
      body_file: path.posix.join(ENTRIES_SUBDIR, `${id}.md`),
    },
    bodyContents: `${(input.body ?? '').replace(/\s+$/, '')}\n`,
  };
}

function promoteExactStagingBody(
  hermesHome: string,
  expectedEntry: CompanyBrainEntry,
  expectedBodyContents: string
): boolean {
  try {
    const indexed = readBrainIndexForMutation(hermesHome).entries.find((entry) => entry.id === expectedEntry.id);
    if (!entryExactlyMatches(indexed, expectedEntry)) return false;
    const entriesDirectory = existingEntriesDirectory(hermesHome);
    if (!entriesDirectory) return false;
    const bodyPath = path.join(entriesDirectory, `${expectedEntry.id}.md`);
    const stagingName = `.staging-${expectedEntry.id}.md`;
    const stagingPath = path.join(entriesDirectory, stagingName);
    const finalBody = exactRegularFile(bodyPath);
    if (finalBody) {
      if (finalBody.contents !== expectedBodyContents) return false;
      const staging = exactRegularFile(stagingPath);
      if (staging?.contents === expectedBodyContents) {
        try {
          unlinkExactRegularFileIfPresent(hermesHome, stagingName, staging);
        } catch {
          // The exact final bytes are already published; retain a contested
          // staging residue rather than deleting anything uncertain.
        }
      }
      return true;
    }

    const staging = exactRegularFile(stagingPath);
    if (!staging || staging.contents !== expectedBodyContents) return false;
    const current = readBrainIndexForMutation(hermesHome).entries.find((entry) => entry.id === expectedEntry.id);
    if (!entryExactlyMatches(current, expectedEntry)) return false;
    const immediatelyBeforeLink = exactRegularFile(stagingPath);
    if (!immediatelyBeforeLink || !sameExactFile(immediatelyBeforeLink, staging)) return false;
    try {
      fs.linkSync(stagingPath, bodyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    const promoted = exactRegularFile(bodyPath);
    if (!promoted || promoted.contents !== expectedBodyContents) return false;
    try {
      unlinkExactRegularFileIfPresent(hermesHome, stagingName, staging);
    } catch {
      // The exact final body is authoritative; stale staging cleanup is best-effort.
    }
    return true;
  } catch {
    return false;
  }
}

/** Promotes only the exact system-owned staging body referenced by the exact index entry. */
export function recoverSystemEntryPromotion(hermesHome: string, input: RecoverSystemEntryPromotionInput): boolean {
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    try {
      return withCompanyBrainMutationLock(hermesHome, () => recoverSystemEntryPromotion(hermesHome, input));
    } catch {
      return false;
    }
  }
  assertAbsoluteHome(hermesHome);
  const expected = expectedSystemEntry(input);
  return promoteExactStagingBody(hermesHome, expected.entry, expected.bodyContents);
}

export type RemoveExactSystemEntryInput = RecoverSystemEntryPromotionInput;

export interface RemoveExactSystemEntryResult {
  ok: boolean;
  removed: boolean;
  /** True only when BOTH the exact body path and its index slot were already absent. */
  already_absent: boolean;
  index: CompanyBrainIndex;
}

function entryExactlyMatches(left: CompanyBrainEntry | undefined, right: CompanyBrainEntry): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function unlinkPathIfExact(file: string, expected: ExactRegularFile): void {
  const immediatelyBeforeUnlink = exactRegularFile(file);
  if (!immediatelyBeforeUnlink || !sameExactFile(immediatelyBeforeUnlink, expected)) {
    throw new Error('Command EVE: quarantined company-brain body changed before unlink.');
  }
  fs.unlinkSync(file);
}

function restoreCapturedBody(capturedPath: string, bodyPath: string, captured: ExactRegularFile): void {
  const currentBody = exactRegularFile(bodyPath);
  if (currentBody) return; // a later raw writer already published the newest path
  const currentCapture = exactRegularFile(capturedPath);
  if (!currentCapture || !sameExactFile(currentCapture, captured)) {
    throw new Error('Command EVE: captured company-brain body changed before restore.');
  }
  try {
    fs.linkSync(capturedPath, bodyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

type ExactIndexReplacement = {
  canonicalPath: string;
  candidatePath: string;
  candidate: ExactRegularFile;
  previousCapturePath: string;
  previousQuarantinePath: string;
  previous: ExactRegularFile;
  published: ExactRegularFile;
  nonce: string;
  finalized: boolean;
};

function restoreCapturedFileCreateOnly(capturedPath: string, canonicalPath: string): void {
  if (exactRegularFile(canonicalPath)) return;
  const captured = exactRegularFile(capturedPath);
  if (!captured) return;
  try {
    fs.linkSync(capturedPath, canonicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function rollbackExactIndexReplacement(replacement: ExactIndexReplacement): void {
  if (replacement.finalized) return;
  const current = exactRegularFile(replacement.canonicalPath);
  if (!current || !sameExactFile(current, replacement.published)) {
    // Missing or different means a raw writer won; never manufacture/overwrite a
    // canonical index over that latest filesystem state.
    return;
  }

  const rollbackCapturePath = `${replacement.candidatePath}.rollback-${replacement.nonce}`;
  fs.renameSync(replacement.canonicalPath, rollbackCapturePath);
  const capturedCurrent = exactRegularFile(rollbackCapturePath);
  if (!capturedCurrent) return;
  if (!sameExactFile(capturedCurrent, replacement.published)) {
    restoreCapturedFileCreateOnly(rollbackCapturePath, replacement.canonicalPath);
    return;
  }

  // A writer that held the pre-capture descriptor may have changed the old inode.
  // Both hidden names point to it; restore those newest bytes create-only.
  restoreCapturedFileCreateOnly(replacement.previousQuarantinePath, replacement.canonicalPath);
  if (!exactRegularFile(replacement.canonicalPath)) {
    restoreCapturedFileCreateOnly(replacement.previousCapturePath, replacement.canonicalPath);
  }
}

function verifyExactIndexReplacement(replacement: ExactIndexReplacement): boolean {
  if (replacement.finalized) return false;
  const canonical = exactRegularFile(replacement.canonicalPath);
  const candidate = exactRegularFile(replacement.candidatePath);
  const previousCapture = exactRegularFile(replacement.previousCapturePath);
  const previousQuarantine = exactRegularFile(replacement.previousQuarantinePath);
  return (
    canonical !== undefined &&
    candidate !== undefined &&
    previousCapture !== undefined &&
    previousQuarantine !== undefined &&
    sameExactFile(canonical, replacement.published) &&
    sameExactFile(candidate, replacement.candidate) &&
    sameExactFile(previousCapture, replacement.previous) &&
    sameExactFile(previousQuarantine, replacement.previous)
  );
}

function finalizeExactIndexReplacement(replacement: ExactIndexReplacement): boolean {
  if (!verifyExactIndexReplacement(replacement)) return false;
  const candidate = exactRegularFile(replacement.candidatePath);
  const canonical = exactRegularFile(replacement.canonicalPath);
  if (
    !candidate ||
    !canonical ||
    !sameExactFile(candidate, replacement.candidate) ||
    !sameExactFile(canonical, replacement.published)
  ) {
    return false;
  }
  unlinkPathIfExact(replacement.candidatePath, candidate);
  const canonicalAfterCandidateCleanup = exactRegularFile(replacement.canonicalPath);
  if (!canonicalAfterCandidateCleanup || !sameExactFile(canonicalAfterCandidateCleanup, replacement.published)) {
    return false;
  }
  unlinkPathIfExact(replacement.previousCapturePath, replacement.previous);
  const previousQuarantine = exactRegularFile(replacement.previousQuarantinePath);
  if (!previousQuarantine || !sameExactFile(previousQuarantine, replacement.previous)) return false;
  unlinkPathIfExact(replacement.previousQuarantinePath, previousQuarantine);
  replacement.finalized = true;
  const finalCanonical = exactRegularFile(replacement.canonicalPath);
  return finalCanonical !== undefined && sameExactFile(finalCanonical, replacement.published);
}

function beginExactIndexReplacement(
  hermesHome: string,
  previous: ExactRegularFile,
  nextIndex: CompanyBrainIndex
): ExactIndexReplacement {
  const brainDirectory = ensureBrainDirectory(hermesHome);
  const canonicalPath = brainJsonOf(hermesHome);
  const nonce = `${process.pid}-${crypto.randomUUID()}`;
  const candidatePath = path.join(brainDirectory.realPath, `.brain-index-next-${nonce}.json`);
  const previousCapturePath = path.join(brainDirectory.realPath, `.brain-index-capture-${nonce}.json`);
  const previousQuarantinePath = path.join(brainDirectory.realPath, `.brain-index-old-${nonce}.json`);
  let candidate: ExactRegularFile | undefined;
  let published: ExactRegularFile | undefined;

  try {
    const current = exactRegularFile(canonicalPath);
    if (!current || !sameExactFile(current, previous)) {
      throw new Error('Command EVE: brain.json changed before exact replacement.');
    }
    fs.writeFileSync(candidatePath, `${JSON.stringify(nextIndex, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    candidate = exactRegularFile(candidatePath);
    if (!candidate) throw new Error('Command EVE: failed to stage exact brain.json replacement.');

    fs.linkSync(canonicalPath, previousQuarantinePath);
    const quarantined = exactRegularFile(previousQuarantinePath);
    const immediatelyBeforeCapture = exactRegularFile(canonicalPath);
    if (
      !quarantined ||
      !immediatelyBeforeCapture ||
      !sameExactFile(quarantined, previous) ||
      !sameExactFile(immediatelyBeforeCapture, previous)
    ) {
      throw new Error('Command EVE: brain.json changed before exact capture.');
    }

    fs.renameSync(canonicalPath, previousCapturePath);
    const captured = exactRegularFile(previousCapturePath);
    if (!captured || !sameExactFile(captured, previous)) {
      restoreCapturedFileCreateOnly(previousCapturePath, canonicalPath);
      throw new Error('Command EVE: brain.json replacement won the capture race.');
    }
    const quarantineBeforePublish = exactRegularFile(previousQuarantinePath);
    if (!quarantineBeforePublish || !sameExactFile(quarantineBeforePublish, previous)) {
      restoreCapturedFileCreateOnly(previousCapturePath, canonicalPath);
      throw new Error('Command EVE: brain.json changed before exact publish.');
    }

    // Create-only publication: a raw writer that creates brain.json in the
    // capture window wins EEXIST and is never overwritten.
    fs.linkSync(candidatePath, canonicalPath);
    published = exactRegularFile(canonicalPath);
    if (!published || !sameExactFile(published, candidate)) {
      throw new Error('Command EVE: exact brain.json publication lost ownership.');
    }
    return {
      canonicalPath,
      candidatePath,
      candidate,
      previousCapturePath,
      previousQuarantinePath,
      previous,
      published,
      nonce,
      finalized: false,
    };
  } catch (error) {
    try {
      if (published && candidate) {
        rollbackExactIndexReplacement({
          canonicalPath,
          candidatePath,
          candidate,
          previousCapturePath,
          previousQuarantinePath,
          previous,
          published,
          nonce,
          finalized: false,
        });
      } else if (!exactRegularFile(canonicalPath)) {
        restoreCapturedFileCreateOnly(previousCapturePath, canonicalPath);
        if (!exactRegularFile(canonicalPath)) {
          restoreCapturedFileCreateOnly(previousQuarantinePath, canonicalPath);
        }
      }
    } catch {
      // Hidden capture/quarantine files retain bytes for a later recovery pass.
    }
    throw error;
  }
}

/**
 * Remove one SYSTEM-owned entry only when its complete index metadata and body
 * bytes still match the caller's receipt. The body is first hard-linked to a
 * hidden quarantine and the canonical name is atomically captured. If a raw
 * write_file edit/replacement wins any race, its bytes are restored/preserved and
 * brain.json is left unchanged. This is the storage primitive transactional
 * semantic rollback uses instead of the broad user `removeEntry` path.
 */
export function removeExactSystemEntry(
  hermesHome: string,
  input: RemoveExactSystemEntryInput
): RemoveExactSystemEntryResult {
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    try {
      return withCompanyBrainMutationLock(hermesHome, () => removeExactSystemEntry(hermesHome, input));
    } catch {
      return { ok: false, removed: false, already_absent: false, index: readBrainIndex(hermesHome) };
    }
  }

  assertAbsoluteHome(hermesHome);
  const expected = expectedSystemEntry(input);
  let originalIndex: CompanyBrainIndex;
  try {
    originalIndex = readBrainIndexForMutation(hermesHome, true);
  } catch {
    return { ok: false, removed: false, already_absent: false, index: readBrainIndex(hermesHome) };
  }
  const indexed = originalIndex.entries.find((entry) => entry.id === expected.id);
  let entriesDirectory: string | undefined;
  let body: ExactRegularFile | undefined;
  try {
    entriesDirectory = existingEntriesDirectory(hermesHome);
    body = entriesDirectory ? exactRegularFile(path.join(entriesDirectory, `${expected.id}.md`)) : undefined;
  } catch {
    return { ok: false, removed: false, already_absent: false, index: originalIndex };
  }

  if (!indexed && !body) {
    return { ok: true, removed: false, already_absent: true, index: originalIndex };
  }
  if (
    !entriesDirectory ||
    !entryExactlyMatches(indexed, expected.entry) ||
    !body ||
    body.contents !== expected.bodyContents
  ) {
    return { ok: false, removed: false, already_absent: false, index: originalIndex };
  }

  const bodyPath = path.join(entriesDirectory, `${expected.id}.md`);
  const nonce = crypto.randomUUID();
  const quarantinePath = path.join(entriesDirectory, `.remove-${expected.id}-${nonce}.md`);
  const capturePath = path.join(entriesDirectory, `.capture-${expected.id}-${nonce}.md`);
  let quarantine: ExactRegularFile | undefined;
  let captured: ExactRegularFile | undefined;
  let indexBeforeRemoval: CompanyBrainIndex | undefined;
  let removalIndex: CompanyBrainIndex | undefined;
  let indexReplacement: ExactIndexReplacement | undefined;

  const restoreBestBody = (): void => {
    try {
      const captureNow = exactRegularFile(capturePath);
      if (captureNow && captured) {
        restoreCapturedBody(capturePath, bodyPath, captureNow);
        return;
      }
      const quarantineNow = exactRegularFile(quarantinePath);
      if (quarantineNow && quarantine) restoreCapturedBody(quarantinePath, bodyPath, quarantineNow);
    } catch {
      // The quarantine/capture remains hidden on disk rather than deleting bytes.
    }
  };

  const failClosed = (): RemoveExactSystemEntryResult => {
    if (indexReplacement) {
      try {
        rollbackExactIndexReplacement(indexReplacement);
      } catch {
        // Hidden index captures retain bytes; never overwrite a raw winner.
      }
    }
    restoreBestBody();
    return { ok: false, removed: false, already_absent: false, index: readBrainIndex(hermesHome) };
  };

  try {
    // Create-only hard-link: never overwrites a contender's path and pins the
    // exact inode while the canonical path is claimed.
    fs.linkSync(bodyPath, quarantinePath);
    quarantine = exactRegularFile(quarantinePath);
    if (!quarantine || !sameExactFile(quarantine, body)) return failClosed();

    const immediatelyBeforeCapture = exactRegularFile(bodyPath);
    if (!immediatelyBeforeCapture || !sameExactFile(immediatelyBeforeCapture, body)) return failClosed();
    fs.renameSync(bodyPath, capturePath);
    captured = exactRegularFile(capturePath);
    if (!captured || !sameExactFile(captured, body)) {
      // rename captured the replacement instead of our owned bytes; put those
      // latest bytes back under the canonical name and leave the index untouched.
      restoreBestBody();
      return failClosed();
    }

    // The quarantine still pins the owned inode, so the duplicate capture name
    // can be removed after an immediate descriptor/inode/hash revalidation.
    unlinkPathIfExact(capturePath, captured);
    captured = undefined;

    const indexSnapshot = exactRegularFile(brainJsonOf(hermesHome));
    if (!indexSnapshot) return failClosed();
    indexBeforeRemoval = strictIndex(JSON.parse(indexSnapshot.contents) as unknown);
    const currentOwner = indexBeforeRemoval.entries.find((entry) => entry.id === expected.id);
    if (!entryExactlyMatches(currentOwner, expected.entry)) return failClosed();
    if (exactRegularFile(bodyPath)) return failClosed();
    const quarantineBeforeIndex = exactRegularFile(quarantinePath);
    if (!quarantineBeforeIndex || !sameExactFile(quarantineBeforeIndex, body)) return failClosed();

    removalIndex = {
      schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA,
      entries: indexBeforeRemoval.entries.filter((entry) => entry.id !== expected.id),
    };
    indexReplacement = beginExactIndexReplacement(hermesHome, indexSnapshot, removalIndex);

    // Raw body/index writers that publish during either exact capture win. The
    // prior index and exact body remain hard-linked until all ownership checks pass.
    if (!verifyExactIndexReplacement(indexReplacement)) return failClosed();
    if (exactRegularFile(bodyPath)) return failClosed();
    const quarantineBeforeUnlink = exactRegularFile(quarantinePath);
    if (!quarantineBeforeUnlink || !sameExactFile(quarantineBeforeUnlink, body)) return failClosed();
    if (!finalizeExactIndexReplacement(indexReplacement)) return failClosed();
    if (exactRegularFile(bodyPath)) return failClosed();
    const finalQuarantine = exactRegularFile(quarantinePath);
    if (!finalQuarantine || !sameExactFile(finalQuarantine, body)) return failClosed();
    unlinkPathIfExact(quarantinePath, finalQuarantine);
    quarantine = undefined;
    return { ok: true, removed: true, already_absent: false, index: removalIndex };
  } catch {
    return failClosed();
  }
}

/**
 * T5 — SYSTEM WRITE PATH (session digests). A SEPARATE writer from upsertEntry: it
 * accepts the widened SYSTEM_WRITE_KINDS allowlist (the 7 user kinds PLUS
 * 'session_digest'), so the DESKTOP can persist an L3 digest WITHOUT relaxing the
 * user-facing IPC write allowlist (upsertEntry / isWritableKind stay at the 7 kinds —
 * a Settings write of kind 'session_digest' is still refused). The id is REQUIRED and
 * writer-owned (stable `sd-<conversation>` → a re-digest REPLACES rather than
 * duplicates). Same atomic (tmp+rename), 0o600, index-last-authority discipline as
 * upsertEntry; the CREATE branch uses the SAME `.staging-<id>.md` dance so a crash
 * between body write and index commit leaves an UN-adoptable staging file, never an
 * orphan the T4 reconciler would fold back in as an author:'eve' note.
 *
 * Fail-closed: rejects a kind outside SYSTEM_WRITE_KINDS, a blank title/id, a
 * non-absolute home, and any id that fails assertEntryId.
 */
export function upsertSystemEntry(hermesHome: string, input: UpsertSystemEntryInput): UpsertEntryResult {
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    return withCompanyBrainMutationLock(hermesHome, () => upsertSystemEntry(hermesHome, input));
  }
  assertAbsoluteHome(hermesHome);
  if (!SYSTEM_WRITE_KINDS.includes(input.kind)) {
    throw new Error(
      `Command EVE: refusing to write company-brain SYSTEM entry with unknown kind ${JSON.stringify(input.kind)}.`
    );
  }
  const title = (input.title ?? '').trim();
  if (title.length === 0) {
    throw new Error('Command EVE: refusing to write a company-brain SYSTEM entry with a blank title.');
  }
  const id = assertEntryId(input.id);

  ensureEntriesDirectory(hermesHome);
  const index = readBrainIndexForMutation(hermesHome, true);
  const created = !index.entries.some((e) => e.id === id);
  const updated_at = (input.now?.() ?? new Date()).toISOString();
  const body_file = path.posix.join(ENTRIES_SUBDIR, `${id}.md`);
  const entry: CompanyBrainEntry = {
    id,
    kind: input.kind,
    title,
    updated_at,
    author: input.author ?? 'eve',
    source: input.source ?? 'chat',
    body_file,
  };

  const bodyPath = path.join(entriesDirOf(hermesHome), `${id}.md`);
  const bodyContents = `${(input.body ?? '').replace(/\s+$/, '')}\n`;
  if (created) {
    writeBodyCreateOnly(hermesHome, `.staging-${id}.md`, bodyContents);
  } else {
    writeBodyAtomic(hermesHome, `${id}.md`, bodyContents);
  }

  const nextEntries = created ? [...index.entries, entry] : index.entries.map((e) => (e.id === id ? entry : e));
  const nextIndex: CompanyBrainIndex = { schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA, entries: nextEntries };
  writeIndex(hermesHome, nextIndex);

  if (
    created &&
    !recoverSystemEntryPromotion(hermesHome, {
      ...input,
      id,
      title,
      updated_at,
    })
  ) {
    throw new Error('Command EVE: failed to promote the SYSTEM entry staging body.');
  }

  return { ok: true, index: nextIndex, entry, bodyPath, created };
}

export interface PruneResult {
  ok: boolean;
  index: CompanyBrainIndex;
  /** Number of session_digest entries removed this pass (oldest-first). */
  pruned: number;
  /** The ids pruned this pass (audit/test). */
  prunedIds: string[];
}

/**
 * T5 — FIFO-PRUNE session digests to at most `max` per seat (spec §2 L3, default
 * SESSION_DIGEST_MAX=50). Only kind==='session_digest' entries count and are pruned;
 * every other kind is untouched. Oldest-first by updated_at (lexicographic ISO sort
 * is chronological); ties break on id for determinism. Removes the body FIRST then
 * rewrites the index (the SAME reconciler-safe order as removeEntry — the only
 * tolerated crash residue is a dangling index slot, never an orphan body the T4
 * reconciler would resurrect). Best-effort: never throws; a bad home / index-write
 * failure degrades to a no-op. Idempotent — at or below the cap it prunes nothing.
 */
export function pruneSessionDigests(hermesHome: string, max: number = SESSION_DIGEST_MAX): PruneResult {
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    try {
      return withCompanyBrainMutationLock(hermesHome, () => pruneSessionDigests(hermesHome, max));
    } catch {
      return { ok: false, index: emptyIndex(), pruned: 0, prunedIds: [] };
    }
  }
  let index: CompanyBrainIndex;
  try {
    assertAbsoluteHome(hermesHome);
    index = readBrainIndexForMutation(hermesHome);
  } catch {
    return { ok: false, index: emptyIndex(), pruned: 0, prunedIds: [] };
  }

  const cap = Math.max(0, Math.floor(max));
  const digests = index.entries.filter((e) => e.kind === SESSION_DIGEST_KIND);
  if (digests.length <= cap) {
    return { ok: true, index, pruned: 0, prunedIds: [] };
  }

  // Oldest-first: chronological by ISO updated_at, id as a stable tiebreaker.
  const ordered = [...digests].sort((a, b) =>
    a.updated_at === b.updated_at ? a.id.localeCompare(b.id) : a.updated_at.localeCompare(b.updated_at)
  );
  const doomed = ordered.slice(0, digests.length - cap);
  const doomedIds = new Set(doomed.map((e) => e.id));

  // Bodies FIRST (reconciler-safe order). rmSync({force:true}) ignores ENOENT; a
  // hard failure aborts THAT id but the pass continues for the rest — never a
  // half-remove that leaves the index and disk disagreeing about a kept entry.
  const prunedIds: string[] = [];
  for (const e of doomed) {
    try {
      unlinkExactRegularFileIfPresent(hermesHome, `${e.id}.md`);
      prunedIds.push(e.id);
    } catch {
      doomedIds.delete(e.id); // keep this entry indexed — its body survived the unlink
    }
  }

  if (prunedIds.length === 0) {
    return { ok: false, index, pruned: 0, prunedIds: [] };
  }

  const nextEntries = index.entries.filter((e) => !doomedIds.has(e.id));
  const nextIndex: CompanyBrainIndex = { schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA, entries: nextEntries };
  try {
    writeIndex(hermesHome, nextIndex);
  } catch {
    return { ok: false, index, pruned: 0, prunedIds: [] };
  }
  return { ok: true, index: nextIndex, pruned: prunedIds.length, prunedIds };
}

/**
 * T8 — a fixed BLUEPRINT SECTION. The store scaffolds exactly one entry per section
 * (if absent) so every seat carries a structured blueprint from second one. Each has
 * a STABLE `id` (bp-…) EVE + the UI update section-precisely, a `kind` (an allowlisted
 * write-kind), a German `title`, and a `placeholder` body of Leitfragen (Markdown
 * comments/bullets) so the operator KNOWS what belongs in each section.
 */
export interface BlueprintSection {
  /** Stable id (bp-<kind>) — never derived, so a section is addressable forever. */
  id: string;
  kind: CompanyBrainWriteKind;
  title: string;
  /** Empty-default body: Leitfragen as Markdown so the section is self-documenting. */
  placeholder: string;
}

/**
 * T8 — the blueprint, in DISPLAY ORDER (Founder design, wörtlich): Unternehmen · Team
 * · Angebot · Zielgruppe · Aktuelle Projekte · Ziele & Zukunft · Fokus · Tonalität ·
 * Dos & Don'ts · Briefing. Ten sections. The Briefing section REUSES the day-0 brief
 * id (COMMAND_EVE_DAY_ZERO_BRIEF_ID = 'brief-day-0') so the seed→entry path (T4.5-F5)
 * and the blueprint converge on ONE 'brief' entry — the rückwärtskompatible choice
 * (no bp-brief alias; the stable seed id IS the Briefing section's id).
 */
export const BLUEPRINT_SECTIONS: readonly BlueprintSection[] = [
  {
    id: 'bp-company',
    kind: 'company',
    title: 'Unternehmen',
    placeholder: ['### Unternehmen', '- Name: …', '- Größe / Mitarbeiter: …', '- Branche: …', '- Standort: …'].join(
      '\n'
    ),
  },
  {
    id: 'bp-team',
    kind: 'team',
    title: 'Team',
    placeholder: ['### Team', '- Wer gehört zum Team (Rollen)?', '- Ansprechpartner: …', '- Externe Partner: …'].join(
      '\n'
    ),
  },
  {
    id: 'bp-offer',
    kind: 'offer',
    title: 'Angebot',
    placeholder: ['### Angebot', '- Was wird verkauft?', '- Preis / Pakete: …', '- Nutzenversprechen: …'].join('\n'),
  },
  {
    id: 'bp-audience',
    kind: 'audience',
    title: 'Zielgruppe',
    placeholder: [
      '### Zielgruppe',
      '- Wer ist der ideale Kunde?',
      '- Probleme / Bedürfnisse: …',
      '- Kanäle, wo sie sind: …',
    ].join('\n'),
  },
  {
    id: 'bp-projects',
    kind: 'projects',
    title: 'Aktuelle Projekte',
    placeholder: ['### Aktuelle Projekte', '- Woran wird gerade gearbeitet?', '- Status / Deadline: …'].join('\n'),
  },
  {
    id: 'bp-goals',
    kind: 'goals',
    title: 'Ziele & Zukunft',
    placeholder: [
      '### Ziele & Zukunft',
      '- Ziel für die nächsten 3–12 Monate?',
      '- Vision / wohin soll es gehen?',
    ].join('\n'),
  },
  {
    id: 'bp-focus',
    kind: 'focus',
    title: 'Fokus',
    placeholder: ['### Fokus', '- Was ist gerade am wichtigsten?', '- Woran NICHT arbeiten (bewusst weglassen)?'].join(
      '\n'
    ),
  },
  {
    id: 'bp-tone',
    kind: 'tone',
    title: 'Tonalität',
    placeholder: [
      '### Tonalität',
      '- Wie klingt die Marke (Stil, Ansprache)?',
      '- Lieblingsphrasen / was NIE gesagt wird: …',
    ].join('\n'),
  },
  {
    // NOTE: the entry id uses a HYPHEN (bp-dos-donts) — assertEntryId's [a-z0-9-]
    // slug rule forbids the underscore that the 'dos_donts' KIND carries.
    id: 'bp-dos-donts',
    kind: 'dos_donts',
    title: "Dos & Don'ts",
    placeholder: ["### Dos & Don'ts", '- Dos: …', "- Don'ts: …"].join('\n'),
  },
  {
    // Briefing REUSES the stable day-0 brief id so seed↔blueprint converge (F5).
    id: COMMAND_EVE_DAY_ZERO_BRIEF_ID,
    kind: 'brief',
    title: 'Briefing',
    placeholder: ['### Briefing', '- Kurzbriefing / Kontext für EVE: …'].join('\n'),
  },
] as const;

/** How many blueprint sections there are (for the "N/M ausgefüllt" hint clause). */
export const BLUEPRINT_SECTION_COUNT = BLUEPRINT_SECTIONS.length;

/** The set of blueprint section ids (fast membership tests: UI "kann nicht löschen"). */
export const BLUEPRINT_SECTION_IDS: ReadonlySet<string> = new Set(BLUEPRINT_SECTIONS.map((s) => s.id));

/** Is `id` a fixed blueprint section (never user-deletable)? */
export function isBlueprintSectionId(id: string): boolean {
  return BLUEPRINT_SECTION_IDS.has(id);
}

/**
 * A blueprint entry is "filled" iff its body has real content beyond the scaffolded
 * placeholder (any non-empty, non-comment, non-heading line that is not the bare
 * "- Frage: …" Leitfrage). We treat a body equal (after trim) to its section's
 * placeholder — OR empty — as UNFILLED. This drives the hint's N/M count so an
 * untouched seat honestly reads 0/10.
 */
function isBlueprintBodyFilled(body: string | null, placeholder: string): boolean {
  const trimmed = (body ?? '').trim();
  if (trimmed.length === 0) return false;
  if (trimmed === placeholder.trim()) return false;
  // Any line that is NOT a heading and NOT an empty-value Leitfrage ("- X: …" / "- X?")
  // counts as filled content the operator or EVE actually added.
  for (const rawLine of trimmed.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue; // heading
    // Leitfrage patterns: "- Label: …" (ellipsis unfilled) or "- Frage?" (bare prompt).
    if (/^[-*]\s.*:\s*…\s*$/.test(line)) continue;
    if (/^[-*]\s.*\?\s*$/.test(line)) continue;
    return true;
  }
  return false;
}

export interface BlueprintResult {
  ok: boolean;
  /** Number of sections newly created this pass (absent → scaffolded empty). */
  created: number;
  /** The section ids created this pass (audit/test). */
  createdIds: string[];
  index: CompanyBrainIndex;
}

/**
 * T8 DAY-ZERO BLUEPRINT (idempotent, best-effort). Ensure EXACTLY ONE entry exists
 * per BLUEPRINT_SECTIONS id. A section that is ABSENT is created with its placeholder
 * body (Leitfragen) via upsertSystemEntry (author:'user', source:'settings') so the
 * operator sees the structure to fill. A section that ALREADY EXISTS (by id) is left
 * UNTOUCHED — never clobber operator/EVE content, never rewrite a filled body. Never
 * throws — any fs error degrades to a no-op so it can't block boot / a seat switch.
 *
 * Runs AFTER migrateSeedToBrain, so if the seed produced the day-0 'brief-day-0'
 * entry the Briefing section already exists and is skipped (convergence, not a
 * duplicate). Only scaffolds the sections still missing.
 */
export function ensureBrainBlueprint(hermesHome: string, opts?: { now?: () => Date }): BlueprintResult {
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    try {
      return withCompanyBrainMutationLock(hermesHome, () => ensureBrainBlueprint(hermesHome, opts));
    } catch {
      return { ok: false, created: 0, createdIds: [], index: emptyIndex() };
    }
  }
  let index: CompanyBrainIndex;
  try {
    assertAbsoluteHome(hermesHome);
    // Make sure company-brain/ + brain.json exist before we upsert sections.
    ensureCompanyBrainScaffold(hermesHome);
    index = readBrainIndexForMutation(hermesHome);
  } catch {
    return { ok: false, created: 0, createdIds: [], index: emptyIndex() };
  }

  const existing = new Set(index.entries.map((e) => e.id));
  const createdIds: string[] = [];
  for (const section of BLUEPRINT_SECTIONS) {
    if (existing.has(section.id)) continue; // never clobber an existing section
    try {
      // 1.6.2 CLOBBER-GUARD. "Absent from the index" does NOT mean absent from
      // disk: after a corrupt-index quarantine (or any index/body divergence)
      // the section BODY can still exist with real operator/EVE content, and
      // upsertSystemEntry's created=true staging-rename would overwrite it with
      // the placeholder. An existing body is ADOPTED into the index untouched.
      const bodyOnDisk = readEntryBody(hermesHome, section.id);
      if (bodyOnDisk !== null) {
        let adoptedAt = (opts?.now?.() ?? new Date()).toISOString();
        try {
          const entriesDirectory = existingEntriesDirectory(hermesHome);
          const bodySnapshot = entriesDirectory
            ? exactRegularFile(path.join(entriesDirectory, `${section.id}.md`))
            : undefined;
          if (bodySnapshot) adoptedAt = new Date(bodySnapshot.mtimeMs).toISOString();
        } catch {
          // body raced away — keep now()
        }
        const adopted: CompanyBrainEntry = {
          id: section.id,
          kind: section.kind,
          title: section.title,
          updated_at: adoptedAt,
          author: 'user',
          source: 'settings',
          body_file: path.posix.join(ENTRIES_SUBDIR, `${section.id}.md`),
        };
        const live = readBrainIndexForMutation(hermesHome);
        writeIndex(hermesHome, {
          schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA,
          entries: [...live.entries.filter((e) => e.id !== section.id), adopted],
        });
        existing.add(section.id);
        continue;
      }
      const res = upsertSystemEntry(hermesHome, {
        id: section.id,
        kind: section.kind,
        title: section.title,
        body: section.placeholder,
        author: 'user',
        source: 'settings',
        now: opts?.now,
      });
      if (res.ok) {
        createdIds.push(section.id);
        existing.add(section.id);
        index = res.index;
      }
    } catch {
      // Best-effort per section: a failed section never aborts the rest.
    }
  }
  return {
    ok: true,
    created: createdIds.length,
    createdIds,
    index: readBrainIndexForMutation(hermesHome),
  };
}

/**
 * T8 — how many blueprint sections carry a filled body, out of BLUEPRINT_SECTION_COUNT.
 * Best-effort (never throws): a bad home / read failure reads as 0 filled. Drives the
 * you-are-here hint's "Blaupause: N/M Sektionen ausgefüllt" clause.
 */
export function countFilledBlueprintSections(hermesHome: string): { filled: number; total: number } {
  const total = BLUEPRINT_SECTION_COUNT;
  try {
    assertAbsoluteHome(hermesHome);
  } catch {
    return { filled: 0, total };
  }
  let filled = 0;
  for (const section of BLUEPRINT_SECTIONS) {
    const body = readEntryBody(hermesHome, section.id);
    if (isBlueprintBodyFilled(body, section.placeholder)) filled += 1;
  }
  return { filled, total };
}

/**
 * Day-Zero convenience for the boot / seat-switch hooks: migrate a v1 seed if one
 * exists (creating brain.json), else scaffold an empty brain — THEN ensure the fixed
 * blueprint sections exist (T8) — THEN fold in any EVE-written .md files that are not
 * yet in the index (T4 reconciler). Idempotent + best-effort — the single call the
 * lifecycle hooks make so every seat ends up with a functional brain.json (the
 * structured blueprint + EVE's fresh notes visible) exactly once.
 */
export function ensureCompanyBrainReady(hermesHome: string, opts?: { now?: () => Date }): CompanyBrainIndex {
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    try {
      return withCompanyBrainMutationLock(hermesHome, () => ensureCompanyBrainReady(hermesHome, opts));
    } catch {
      return readBrainIndex(hermesHome);
    }
  }
  // 1.6.2: a corrupt brain.json must be quarantined BEFORE anything reads it as
  // an empty index — the rebuild below (blueprint adopt-guard + reconciler)
  // restores the index from the surviving files instead of clobbering them.
  quarantineCorruptBrainIndex(hermesHome, opts);
  const migration = migrateSeedToBrain(hermesHome, opts);
  // T8: scaffold the fixed blueprint sections (Day-Zero) AFTER the seed migration so
  // the day-0 brief converges on the Briefing section rather than duplicating it.
  ensureBrainBlueprint(hermesHome, opts);
  const reconciled = reconcileUnindexedEntries(hermesHome, opts);
  // reconcileUnindexedEntries returns the live index on ok; on a best-effort
  // failure it may return the migration index — prefer whichever is authoritative.
  return reconciled.ok ? reconciled.index : migration.index;
}

export interface QuarantineIndexResult {
  quarantined: boolean;
  /** The rename target (brain.json.corrupt-<ts>), kept on disk for forensics. */
  corruptFile?: string;
}

/**
 * 1.6.2 — QUARANTINE a corrupt brain.json instead of letting readBrainIndex
 * coerce it to an EMPTY index. Before this guard, a truncated/unparseable index
 * made ensureBrainBlueprint see every section as "absent" and stage placeholders
 * OVER the real body files (total clobber, latent since T8). The unreadable file
 * is renamed aside and the ready-pipeline rebuilds the index from the surviving
 * files (blueprint adopt-guard + T4 reconciler). Never throws; a missing or
 * parseable brain.json is a no-op.
 */
export function quarantineCorruptBrainIndex(hermesHome: string, opts?: { now?: () => Date }): QuarantineIndexResult {
  if (!hasCompanyBrainMutationLock(hermesHome)) {
    try {
      return withCompanyBrainMutationLock(hermesHome, () => quarantineCorruptBrainIndex(hermesHome, opts));
    } catch {
      return { quarantined: false };
    }
  }
  try {
    assertAbsoluteHome(hermesHome);
    const file = brainJsonOf(hermesHome);
    const observed = exactRegularFile(file);
    if (!observed) return { quarantined: false };
    try {
      strictIndex(JSON.parse(observed.contents) as unknown);
      return { quarantined: false };
    } catch {
      const stamp = (opts?.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
      const target = `${file}.corrupt-${stamp}`;
      const immediatelyBeforeRename = exactRegularFile(file);
      if (!immediatelyBeforeRename || !sameExactFile(observed, immediatelyBeforeRename)) {
        return { quarantined: false };
      }
      fs.renameSync(file, target);
      return { quarantined: true, corruptFile: target };
    }
  } catch {
    return { quarantined: false };
  }
}

export interface MigrateBrainHomeResult {
  ok: boolean;
  /** True iff this call carried a brain over (target had none, source had one). */
  migrated: boolean;
  /** Files copied (bodies + companions + index). */
  copied: number;
}

/**
 * 1.6.2 — OWN-SEAT PROVISIONING: carry the legacy/root home's company-brain into
 * a seat home being provisioned for the FIRST time. Before this, the switch hook
 * seeded an empty blueprint right next to the operator's filled root brain
 * (2026-07-02: root filled 12:06, seat empty-seeded 12:09) — the first switch to
 * the own seat then looked like total data loss. STRICT preconditions, each
 * degrading to a no-op: the TARGET must not have a brain.json yet (never merge,
 * never clobber) and the SOURCE must have one. The CALLER gates on seat kind
 * 'own_company' — client seats NEVER inherit the operator's brain (ISO-6).
 */
export function migrateCompanyBrainFromHome(sourceHome: string, targetHome: string): MigrateBrainHomeResult {
  if (!hasCompanyBrainMutationLock(sourceHome) || !hasCompanyBrainMutationLock(targetHome)) {
    try {
      return withCompanyBrainMutationLocks([sourceHome, targetHome], () =>
        migrateCompanyBrainFromHome(sourceHome, targetHome)
      );
    } catch {
      return { ok: false, migrated: false, copied: 0 };
    }
  }
  try {
    assertAbsoluteHome(sourceHome);
    assertAbsoluteHome(targetHome);
    if (path.resolve(sourceHome) === path.resolve(targetHome)) return { ok: true, migrated: false, copied: 0 };
    const sourceBrain = exactRegularFile(brainJsonOf(sourceHome));
    if (!sourceBrain) return { ok: true, migrated: false, copied: 0 };
    // A migration is a mutation. Never copy a partially valid/coerced source
    // index, because the target's next RMW would otherwise silently drop bytes.
    readBrainIndexForMutation(sourceHome);
    const srcEntries = existingEntriesDirectory(sourceHome);

    if (lstatIfPresent(brainJsonOf(targetHome))) {
      // HEAL LANE (review finding): every own-seat provisioned under ≤1.6.1 was
      // ALREADY empty-seeded (a placeholder-only scaffold — exactly the live
      // incident this migration exists for), and a bare existence check would
      // lock those seats out of inheriting forever. A PRISTINE scaffold — only
      // blueprint-section ids, not one filled, no notes/digests/user entries —
      // carries zero information, so it is set aside (forensics rename, same
      // discipline as the index quarantine) and the inherit proceeds. ANY sign
      // of real content keeps the hard no-op (never merge, never clobber).
      if (!isPristineBlueprintScaffold(targetHome)) return { ok: true, migrated: false, copied: 0 };
      // 1.6.2 MEDIUM (Codex): a brain.json can read as pristine (only blueprint
      // section ids, none filled) while `entries/` ALREADY holds a REAL unindexed
      // `.md` note (e.g. an EVE write not yet folded into the index). The bare
      // pristine check would set the whole target brain aside and bury that live
      // note behind the inherited source brain. Scan the target bodies for any
      // non-dot `.md` that is NOT a blueprint section / day-zero brief body — those
      // ARE the pristine scaffold's own placeholders (safe to take over); anything
      // else is a real unindexed note ⇒ hard no-op, let the ready-pass reconcile.
      const targetEntries = existingEntriesDirectory(targetHome);
      if (targetEntries) {
        const hasUnindexedNote = fs.readdirSync(targetEntries).some((n) => {
          if (!n.endsWith('.md') || n.startsWith('.')) return false;
          const base = n.slice(0, -'.md'.length);
          return !isBlueprintSectionId(base) && base !== COMMAND_EVE_DAY_ZERO_BRIEF_ID;
        });
        if (hasUnindexedNote) return { ok: true, migrated: false, copied: 0 };
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const canonicalBrainDir = brainDirOf(targetHome);
      const setAside = `${canonicalBrainDir}.pre-inherit-${stamp}-${process.pid}-${crypto.randomUUID()}`;
      fs.mkdirSync(setAside, { mode: 0o700 });
      for (const child of fs.readdirSync(canonicalBrainDir)) {
        // The two-home fence itself must stay at its canonical path until the
        // callback returns. Process witnesses are lock infrastructure too.
        if (child === 'brain.json.lock' || child === '.process-witnesses') continue;
        fs.renameSync(path.join(canonicalBrainDir, child), path.join(setAside, child));
      }
      ensureBrainDirectory(targetHome);
    } else if (
      existingEntriesDirectory(targetHome) &&
      fs.readdirSync(existingEntriesDirectory(targetHome)!).some((n) => n.endsWith('.md') && !n.startsWith('.'))
    ) {
      // No index but bodies on disk (e.g. death inside a quarantine rebuild):
      // that is REAL content awaiting adoption by ensureCompanyBrainReady —
      // overwriting same-named section bodies here would be one-shot data loss
      // (review finding). Hard no-op; the ready-pass heals the index instead.
      return { ok: true, migrated: false, copied: 0 };
    }

    let copied = 0;
    const copyFile = (from: string, to: string, bodyName?: string): void => {
      // H10 (re-audit fix): symlink-safe at the SINGLE copy chokepoint. lstat (NOT
      // stat/existsSync) the SOURCE and skip anything that is not a regular file, so
      // a symlinked brief.md / seed.json / brain.json — or a symlinked entry — can
      // never be FOLLOWED by readFileSync to copy a local secret into the
      // model-visible target brain. The entries loop below also pre-filters with
      // dirent.isFile() (lstat semantics); centralizing the guard here additionally
      // covers the companion + index copies, which the first H10 pass left exposed
      // (existsSync + readFileSync both follow symlinks).
      let snapshot: ExactRegularFile | undefined;
      try {
        snapshot = exactRegularFile(from);
      } catch {
        return;
      }
      if (!snapshot) return;
      if (bodyName) writeBodyAtomic(targetHome, bodyName, snapshot.contents);
      else {
        ensureBrainDirectory(targetHome);
        writeFileAtomic(to, snapshot.contents);
        ensureBrainDirectory(targetHome);
      }
      copied += 1;
    };
    // Bodies FIRST, index LAST — the same crash ordering as upsertSystemEntry: an
    // interrupted copy leaves body files a later ready-pass can adopt, never an
    // index pointing at bodies that were never written.
    if (srcEntries) {
      // H10 (Codex): mirror the reconciler's guard exactly — read with
      // withFileTypes, copy ONLY DIRECT regular files (dirent.isFile() ⇒ a `.md`
      // SYMLINK or a symlinked dir is skipped, never followed), and require the
      // basename to be a safe entry id. Without this a `.md` symlink in a source
      // brain could copy a locally-readable secret into the target company-brain
      // and make it model-visible.
      for (const dirent of fs.readdirSync(srcEntries, { withFileTypes: true })) {
        if (!dirent.isFile()) continue;
        const name = dirent.name;
        if (!name.endsWith('.md') || name.startsWith('.')) continue;
        const base = name.slice(0, -'.md'.length);
        try {
          assertEntryId(base);
        } catch {
          continue; // crafted / unsafe basename → ignore, never copy
        }
        copyFile(path.join(srcEntries, name), path.join(entriesDirOf(targetHome), name), name);
      }
    }
    for (const companion of ['brief.md', 'seed.json']) {
      const from = path.join(brainDirOf(sourceHome), companion);
      if (lstatIfPresent(from)) copyFile(from, path.join(brainDirOf(targetHome), companion));
    }
    copyFile(brainJsonOf(sourceHome), brainJsonOf(targetHome));
    // Prove the final target is a strict, lossless index and that the canonical
    // target directory was never replaced while its lock was held.
    readBrainIndexForMutation(targetHome);
    ensureBrainDirectory(targetHome);
    return { ok: true, migrated: true, copied };
  } catch {
    return { ok: false, migrated: false, copied: 0 };
  }
}

/**
 * True iff a home's company-brain is an UNTOUCHED blueprint scaffold: a valid
 * index whose entries are ALL fixed blueprint sections, with not one section
 * filled. Any note/digest/custom entry, any filled section, or an unparseable
 * index reads as NOT pristine (fail-closed — pristine grants a takeover).
 */
export function isPristineBlueprintScaffold(hermesHome: string): boolean {
  try {
    assertAbsoluteHome(hermesHome);
    const index = readBrainIndexForMutation(hermesHome);
    if (!index.entries.every((e) => isBlueprintSectionId(e.id) || e.id === COMMAND_EVE_DAY_ZERO_BRIEF_ID)) return false;
    return countFilledBlueprintSections(hermesHome).filled === 0;
  } catch {
    return false;
  }
}
