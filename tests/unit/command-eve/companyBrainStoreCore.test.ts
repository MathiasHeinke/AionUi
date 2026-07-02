/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.4 T2 — Company-Brain STORE v2 core suite.
 *
 * Proves the multi-entry store: CRUD is atomic + idempotent, the v1→v2 seed
 * migration runs once (with and without brief.md) and never double-migrates, the
 * Day-Zero scaffold is idempotent and never clobbers a populated store, the id
 * sanitizer rejects path-traversal, unknown kinds are read-tolerated but
 * write-rejected, and two seat homes stay disjoint. The core is pure/injectable so
 * it runs against tmp dirs with no Electron.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  COMMAND_EVE_COMPANY_BRAIN_SCHEMA,
  ENTRIES_SUBDIR,
  assertEntryId,
  ensureCompanyBrainReady,
  ensureCompanyBrainScaffold,
  isWritableKind,
  listEntries,
  migrateSeedToBrain,
  readBrainIndex,
  readEntryBody,
  reconcileUnindexedEntries,
  removeEntry,
  upsertEntry,
} from '@process/commandEve/companyBrainStoreCore';
import { COMPANY_BRAIN_DIR, writeCompanyBrainSeedToHome } from '@process/commandEve/companyBrainSeedCore';

const tempRoots: string[] = [];
const makeHome = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-brain-store-'));
  tempRoots.push(root);
  return path.join(root, 'home'); // an absolute, not-yet-existing seat home
};
const fixedClock = (iso: string) => () => new Date(iso);
const brainJson = (home: string) => path.join(home, COMPANY_BRAIN_DIR, 'brain.json');
const bodyOf = (home: string, id: string) => path.join(home, COMPANY_BRAIN_DIR, ENTRIES_SUBDIR, `${id}.md`);

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('CRUD — create / read / edit / remove', () => {
  it('upsert CREATE writes body + index atomically; id is a kind-slug + random', () => {
    const home = makeHome();
    const res = upsertEntry(home, { kind: 'offer', title: 'Website Relaunch', body: 'Full relaunch offer', now: fixedClock('2026-07-02T10:00:00.000Z') });

    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    expect(res.entry.id).toMatch(/^offer-website-relaunch-[a-z0-9]+$/);
    expect(res.entry.kind).toBe('offer');
    expect(res.entry.author).toBe('user');
    expect(res.entry.source).toBe('settings');
    expect(res.entry.updated_at).toBe('2026-07-02T10:00:00.000Z');
    expect(res.entry.body_file).toBe(path.posix.join(ENTRIES_SUBDIR, `${res.entry.id}.md`));

    // Index reflects exactly one entry; body is on disk.
    const idx = readBrainIndex(home);
    expect(idx.schema_version).toBe(COMMAND_EVE_COMPANY_BRAIN_SCHEMA);
    expect(idx.entries).toHaveLength(1);
    expect(readEntryBody(home, res.entry.id)).toContain('Full relaunch offer');

    if (process.platform !== 'win32') {
      expect(fs.statSync(brainJson(home)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(bodyOf(home, res.entry.id)).mode & 0o777).toBe(0o600);
    }
  });

  it('upsert EDIT (same id) rewrites body + index slot in place; no duplicate, updated_at moves', () => {
    const home = makeHome();
    const created = upsertEntry(home, { kind: 'note', title: 'Kickoff', body: 'v1', now: fixedClock('2026-07-02T10:00:00.000Z') });
    const edited = upsertEntry(home, { id: created.entry.id, kind: 'note', title: 'Kickoff (revised)', body: 'v2', now: fixedClock('2026-07-02T12:00:00.000Z') });

    expect(edited.created).toBe(false);
    const idx = readBrainIndex(home);
    expect(idx.entries).toHaveLength(1); // NOT appended
    expect(idx.entries[0].title).toBe('Kickoff (revised)');
    expect(idx.entries[0].updated_at).toBe('2026-07-02T12:00:00.000Z');
    expect(readEntryBody(home, created.entry.id)).toContain('v2');
    expect(readEntryBody(home, created.entry.id)).not.toContain('v1');
  });

  it('multiple entries accumulate (append-first — the single-slot lie is dead)', () => {
    const home = makeHome();
    upsertEntry(home, { kind: 'company', title: 'ACME GmbH', body: 'The client' });
    upsertEntry(home, { kind: 'audience', title: 'SMB owners', body: 'Target group' });
    upsertEntry(home, { kind: 'tone', title: 'Direct, warm', body: 'Voice' });
    const kinds = listEntries(home).map((e) => e.kind).sort();
    expect(kinds).toEqual(['audience', 'company', 'tone']);
    expect(listEntries(home)).toHaveLength(3);
  });

  it('remove drops the index slot AND unlinks the body; idempotent on an absent id', () => {
    const home = makeHome();
    const a = upsertEntry(home, { kind: 'brief', title: 'Brief A', body: 'a' });
    const b = upsertEntry(home, { kind: 'brief', title: 'Brief B', body: 'b' });

    const rm = removeEntry(home, a.entry.id);
    expect(rm.removed).toBe(true);
    expect(listEntries(home).map((e) => e.id)).toEqual([b.entry.id]);
    expect(fs.existsSync(bodyOf(home, a.entry.id))).toBe(false);

    // Second remove of the same id is a clean no-op.
    const rm2 = removeEntry(home, a.entry.id);
    expect(rm2.removed).toBe(false);
    expect(listEntries(home)).toHaveLength(1);
  });

  it('readEntryBody returns null for a missing body (never throws)', () => {
    const home = makeHome();
    ensureCompanyBrainScaffold(home);
    expect(readEntryBody(home, 'note-does-not-exist')).toBeNull();
  });
});

describe('atomicity / self-heal — index authority', () => {
  it('a malformed brain.json reads as an empty index (self-heals, never throws)', () => {
    const home = makeHome();
    ensureCompanyBrainScaffold(home);
    fs.writeFileSync(brainJson(home), '{ this is : not json');
    expect(readBrainIndex(home).entries).toEqual([]);
    // A subsequent write recovers a clean index.
    upsertEntry(home, { kind: 'note', title: 'Recovered', body: 'ok' });
    expect(listEntries(home)).toHaveLength(1);
  });

  it('an index entry with an unsafe id is dropped defensively on read', () => {
    const home = makeHome();
    ensureCompanyBrainScaffold(home);
    fs.writeFileSync(
      brainJson(home),
      JSON.stringify({
        schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA,
        entries: [
          { id: '../escape', kind: 'note', title: 'evil', updated_at: '', author: 'user', source: 'settings', body_file: 'x' },
          { id: 'note-legit', kind: 'note', title: 'ok', updated_at: '', author: 'user', source: 'settings', body_file: 'entries/note-legit.md' },
        ],
      })
    );
    const ids = listEntries(home).map((e) => e.id);
    expect(ids).toEqual(['note-legit']);
  });
});

describe('id sanitizer — path-traversal fail-closed', () => {
  it('assertEntryId accepts a safe slug', () => {
    expect(assertEntryId('offer-website-relaunch-ab12cd')).toBe('offer-website-relaunch-ab12cd');
  });

  it.each(['../etc', 'a/b', 'a\\b', '..', '.hidden', '', 'a'.repeat(65), 'Has Space', 'UPPER', 'trailing-', 'a\0b'])(
    'assertEntryId rejects %j',
    (bad) => {
      expect(() => assertEntryId(bad as string)).toThrow();
    }
  );

  it('upsert / remove / readEntryBody reject a crafted id before touching disk', () => {
    const home = makeHome();
    expect(() => upsertEntry(home, { id: '../../etc', kind: 'note', title: 't', body: 'b' })).toThrow();
    expect(() => removeEntry(home, '../../etc')).toThrow();
    expect(() => readEntryBody(home, '../../etc')).toThrow();
  });

  it('every written path stays strictly under company-brain/', () => {
    const home = makeHome();
    const res = upsertEntry(home, { kind: 'company', title: 'Contained', body: 'x' });
    const brainDir = path.resolve(path.join(home, COMPANY_BRAIN_DIR));
    for (const p of [res.bodyPath, brainJson(home)]) {
      expect(path.resolve(p).startsWith(brainDir + path.sep)).toBe(true);
    }
  });
});

describe('kind allowlist — read-tolerate, write-reject', () => {
  it('isWritableKind only accepts the v1.4 write kinds', () => {
    for (const k of ['company', 'offer', 'audience', 'tone', 'dos_donts', 'brief', 'note']) {
      expect(isWritableKind(k)).toBe(true);
    }
    for (const k of ['project', 'session_digest', 'random', '']) {
      expect(isWritableKind(k)).toBe(false);
    }
  });

  it('upsert REJECTS an unknown kind (write path can only grow deliberately)', () => {
    const home = makeHome();
    expect(() => upsertEntry(home, { kind: 'project' as never, title: 'P', body: 'b' })).toThrow(/unknown kind/);
  });

  it('read TOLERATES an unknown kind already in the index (never drops a future entry)', () => {
    const home = makeHome();
    ensureCompanyBrainScaffold(home);
    fs.writeFileSync(
      brainJson(home),
      JSON.stringify({
        schema_version: COMMAND_EVE_COMPANY_BRAIN_SCHEMA,
        entries: [{ id: 'project-alpha', kind: 'project', title: 'Alpha', updated_at: '', author: 'eve', source: 'chat', body_file: 'entries/project-alpha.md' }],
      })
    );
    const entries = listEntries(home);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('project');
    expect(entries[0].author).toBe('eve');
    expect(entries[0].source).toBe('chat');
  });

  it('upsert REJECTS a blank title', () => {
    const home = makeHome();
    expect(() => upsertEntry(home, { kind: 'note', title: '   ', body: 'b' })).toThrow(/blank title/);
  });
});

describe('scaffold — Day-Zero, idempotent', () => {
  it('creates company-brain/ + entries/ + empty brain.json', () => {
    const home = makeHome();
    const res = ensureCompanyBrainScaffold(home);
    expect(res.created).toBe(true);
    expect(fs.existsSync(brainJson(home))).toBe(true);
    expect(fs.existsSync(path.join(home, COMPANY_BRAIN_DIR, ENTRIES_SUBDIR))).toBe(true);
    expect(readBrainIndex(home).entries).toEqual([]);
  });

  it('is idempotent and NEVER clobbers a populated store', () => {
    const home = makeHome();
    ensureCompanyBrainScaffold(home);
    upsertEntry(home, { kind: 'note', title: 'Keep me', body: 'x' });
    const again = ensureCompanyBrainScaffold(home);
    expect(again.created).toBe(false); // brain.json already existed
    expect(listEntries(home)).toHaveLength(1); // entry survived
  });

  it('best-effort: a non-absolute home returns ok:false without throwing', () => {
    expect(ensureCompanyBrainScaffold('relative/home')).toEqual({ ok: false, created: false, brainDir: '' });
  });
});

describe('migration v1 seed.json → v2 brain.json', () => {
  it('migrates a v1 seed into ONE brief entry (source seed-migration), using brief.md body', () => {
    const home = makeHome();
    // T1 seed writer creates seed.json v1 + brief.md.
    writeCompanyBrainSeedToHome({ hermesHome: home, seed: { kind: 'paste_brief', value: 'ACME day-0 brief (seed value)' } });
    // Overwrite brief.md so we can prove the migration prefers the live brief.md body.
    fs.writeFileSync(path.join(home, COMPANY_BRAIN_DIR, 'brief.md'), 'ACME day-0 brief (brief.md body)\n');

    const res = migrateSeedToBrain(home, { now: fixedClock('2026-07-02T09:00:00.000Z') });
    expect(res.migrated).toBe(true);
    expect(res.index.entries).toHaveLength(1);
    const entry = res.index.entries[0];
    expect(entry.kind).toBe('brief');
    expect(entry.title).toBe('Day-0 Briefing');
    expect(entry.author).toBe('user');
    expect(entry.source).toBe('seed-migration');
    expect(readEntryBody(home, entry.id)).toContain('brief.md body');

    // seed.json STAYS (v1 compat — §SEAT stamp + companyBrainStatus still read it).
    expect(fs.existsSync(path.join(home, COMPANY_BRAIN_DIR, 'seed.json'))).toBe(true);
  });

  it('falls back to the seed value when no brief.md exists', () => {
    const home = makeHome();
    writeCompanyBrainSeedToHome({ hermesHome: home, seed: { kind: 'connect_client', value: 'client-only-value' } });
    fs.rmSync(path.join(home, COMPANY_BRAIN_DIR, 'brief.md'), { force: true });

    const res = migrateSeedToBrain(home);
    expect(res.migrated).toBe(true);
    expect(readEntryBody(home, res.index.entries[0].id)).toContain('client-only-value');
  });

  it('is idempotent — a second run is a NO-OP (does not re-migrate)', () => {
    const home = makeHome();
    writeCompanyBrainSeedToHome({ hermesHome: home, seed: { kind: 'paste_brief', value: 'brief' } });
    const first = migrateSeedToBrain(home);
    expect(first.migrated).toBe(true);
    const second = migrateSeedToBrain(home);
    expect(second.migrated).toBe(false);
    expect(second.index.entries).toHaveLength(1); // still exactly one brief entry
  });

  it('an unseeded home scaffolds an empty brain instead of migrating', () => {
    const home = makeHome();
    const res = migrateSeedToBrain(home);
    expect(res.migrated).toBe(false);
    expect(fs.existsSync(brainJson(home))).toBe(true);
    expect(res.index.entries).toEqual([]);
  });

  it('ensureCompanyBrainReady is the single idempotent Day-Zero call (migrate-or-scaffold)', () => {
    const home = makeHome();
    writeCompanyBrainSeedToHome({ hermesHome: home, seed: { kind: 'paste_brief', value: 'ready brief' } });
    const idx1 = ensureCompanyBrainReady(home);
    expect(idx1.entries).toHaveLength(1);
    // A second call after the operator added an entry keeps everything.
    upsertEntry(home, { kind: 'note', title: 'Added later', body: 'x' });
    const idx2 = ensureCompanyBrainReady(home);
    expect(idx2.entries).toHaveLength(2);
  });
});

describe('per-seat isolation — two homes stay disjoint', () => {
  it('entries written under home A never appear under home B', () => {
    const homeA = makeHome();
    const homeB = makeHome();
    upsertEntry(homeA, { kind: 'company', title: 'Client A', body: 'A-secret' });
    upsertEntry(homeB, { kind: 'company', title: 'Client B', body: 'B-secret' });

    expect(listEntries(homeA).map((e) => e.title)).toEqual(['Client A']);
    expect(listEntries(homeB).map((e) => e.title)).toEqual(['Client B']);
    expect(readEntryBody(homeA, listEntries(homeA)[0].id)).toContain('A-secret');
    expect(readEntryBody(homeA, listEntries(homeA)[0].id)).not.toContain('B-secret');
    expect(homeA).not.toBe(homeB);
  });
});

describe('T4 reconciler — EVE write-path intake (unindexed entries/*.md → brain.json)', () => {
  const entriesDir = (home: string) => path.join(home, COMPANY_BRAIN_DIR, ENTRIES_SUBDIR);
  const writeNote = (home: string, name: string, body: string) => {
    fs.mkdirSync(entriesDir(home), { recursive: true });
    fs.writeFileSync(path.join(entriesDir(home), name), body);
  };

  it('adopts an unindexed EVE note: title from the first H1, author eve, source chat, kind note', () => {
    const home = makeHome();
    ensureCompanyBrainScaffold(home); // empty brain.json + entries/
    writeNote(home, 'note-mueller-tonalitaet.md', '# Tonalität Bäckerei Müller\nLocker, regional, per Du.');

    const res = reconcileUnindexedEntries(home, { now: fixedClock('2026-07-02T12:00:00.000Z') });
    expect(res.ok).toBe(true);
    expect(res.adopted).toBe(1);
    expect(res.adoptedIds).toEqual(['note-mueller-tonalitaet']);

    const idx = readBrainIndex(home);
    const entry = idx.entries.find((e) => e.id === 'note-mueller-tonalitaet');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('note');
    expect(entry!.title).toBe('Tonalität Bäckerei Müller');
    expect(entry!.author).toBe('eve');
    expect(entry!.source).toBe('chat');
    expect(entry!.updated_at).toBe('2026-07-02T12:00:00.000Z');
    // The body is untouched (readEntryBody sees the same content).
    expect(readEntryBody(home, 'note-mueller-tonalitaet')).toContain('Locker, regional, per Du.');
  });

  it('title falls back to the first non-empty line when there is no H1, then to the default when the body is blank', () => {
    const home = makeHome();
    ensureCompanyBrainScaffold(home);
    writeNote(home, 'note-plain.md', 'Kein Heading hier\nzweite Zeile');
    writeNote(home, 'note-blank.md', '   \n\n');

    reconcileUnindexedEntries(home);
    const idx = readBrainIndex(home);
    expect(idx.entries.find((e) => e.id === 'note-plain')!.title).toBe('Kein Heading hier');
    expect(idx.entries.find((e) => e.id === 'note-blank')!.title).toBe('EVE-Notiz');
  });

  it('is IDEMPOTENT: a second pass adopts nothing and never rewrites an indexed entry', () => {
    const home = makeHome();
    ensureCompanyBrainScaffold(home);
    writeNote(home, 'note-a.md', '# A');
    const first = reconcileUnindexedEntries(home, { now: fixedClock('2026-07-02T12:00:00.000Z') });
    expect(first.adopted).toBe(1);
    const second = reconcileUnindexedEntries(home, { now: fixedClock('2026-07-02T13:00:00.000Z') });
    expect(second.adopted).toBe(0);
    // updated_at from the FIRST pass survives (no rewrite).
    expect(readBrainIndex(home).entries.find((e) => e.id === 'note-a')!.updated_at).toBe('2026-07-02T12:00:00.000Z');
  });

  it('leaves existing user/settings brain.json entries UNTOUCHED (does not clobber a user-edited title)', () => {
    const home = makeHome();
    const created = upsertEntry(home, { kind: 'offer', id: 'offer-fixed', title: 'User Title', body: 'body' });
    expect(created.ok).toBe(true);
    // Drop an unindexed EVE note beside it.
    writeNote(home, 'note-eve.md', '# EVE Note');

    const res = reconcileUnindexedEntries(home);
    expect(res.adopted).toBe(1);
    const idx = readBrainIndex(home);
    // The user entry is byte-identical (author/title/source unchanged).
    const userEntry = idx.entries.find((e) => e.id === 'offer-fixed')!;
    expect(userEntry.title).toBe('User Title');
    expect(userEntry.author).toBe('user');
    expect(userEntry.source).toBe('settings');
    expect(userEntry.kind).toBe('offer');
    // The EVE note is now present.
    expect(idx.entries.some((e) => e.id === 'note-eve' && e.author === 'eve')).toBe(true);
  });

  it('ignores non-.md files, dotfiles, subdirectories, and filenames that are not safe entry ids (no traversal, no synthesized id)', () => {
    const home = makeHome();
    ensureCompanyBrainScaffold(home);
    writeNote(home, 'note-ok.md', '# Ok');
    // Non-.md — ignored.
    writeNote(home, 'ignore.txt', 'not markdown');
    // Dotfile .md — ignored.
    writeNote(home, '.hidden.md', '# Hidden');
    // Unsafe basename (uppercase/space would fail the [a-z0-9-] entry-id RE) — ignored.
    writeNote(home, 'Note With Space.md', '# Spaced');
    // A subdirectory named like a note — NOT a regular file, ignored (no recursion).
    fs.mkdirSync(path.join(entriesDir(home), 'note-dir.md'), { recursive: true });

    const res = reconcileUnindexedEntries(home);
    expect(res.adoptedIds).toEqual(['note-ok']);
    const ids = readBrainIndex(home).entries.map((e) => e.id);
    expect(ids).toEqual(['note-ok']);
  });

  it('degrades to a no-op when entries/ does not exist (best-effort, never throws)', () => {
    const home = makeHome(); // nothing scaffolded
    const res = reconcileUnindexedEntries(home);
    expect(res.ok).toBe(false);
    expect(res.adopted).toBe(0);
  });

  it('ensureCompanyBrainReady folds in an EVE note dropped after scaffold (boot/switch hook path)', () => {
    const home = makeHome();
    ensureCompanyBrainReady(home); // day-zero scaffold
    // EVE writes a note after the seat is live.
    fs.writeFileSync(path.join(entriesDir(home), 'note-later.md'), '# Später gelernt');
    const idx = ensureCompanyBrainReady(home); // next boot/switch reconciles
    expect(idx.entries.some((e) => e.id === 'note-later' && e.author === 'eve')).toBe(true);
  });
});
