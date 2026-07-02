/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.4 T2 — Company-Brain store IPC, tested through the REAL bridge seam.
 *
 * Drives the ACTUAL providers `initCommandEveBridge` registers (list / write /
 * remove) — not a fixture-vs-fixture mirror — with a real tmp userDataPath and a
 * real active seat, so the round-trip (write → list → remove) exercises the same
 * resolveActiveSeatHome + store-core path the desktop runs. The store core is real;
 * only Electron/IO leaf deps are neutralized (same discipline as the kanban write-
 * fence real-seam test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Capture the real providers registered by initCommandEveBridge ──────────────
const registered = new Map<string, (req?: unknown) => Promise<unknown>>();
vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      provider: (fn: (req?: unknown) => Promise<unknown>) => {
        registered.set(channel, fn);
        return { channel };
      },
    }),
  },
}));

// ── Point the bridge's data path at a real tmp dir (the store writes to disk). ──
let dataRoot = '';
vi.mock('@process/utils/utils', () => ({ getDataPath: () => dataRoot }));

// ── Neutralize the remaining heavy leaf deps the bridge pulls at import. ────────
vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: () => undefined, getSync: () => undefined, set: () => {} },
  getSkillsDir: () => '/tmp/skills',
  getCronSkillsDir: () => '/tmp/cron-skills',
}));
vi.mock('@process/commandEve/seatWireFetchCore', () => ({ readMySeatsWire: vi.fn(async () => null) }));

// seatContextCore stays REAL — resolveActiveSeatHome / setActiveSeatId are the pure
// seam the handlers rely on for active-seat resolution.
import { __resetActiveSeatForTests, resolveSeatHome, setActiveSeatId } from '@process/commandEve/seatContextCore';
import { COMPANY_BRAIN_DIR } from '@process/commandEve/companyBrainSeedCore';
import { initCommandEveBridge } from '@process/bridge/commandEveBridge';

type Envelope<T = { ok?: boolean; reason_code?: string; entries?: Array<{ id: string; title: string; kind: string }>; entry?: { id: string; title: string }; created?: boolean; removed?: boolean; body?: string | null }> = {
  success: boolean;
  msg?: string;
  data?: T;
};

const SEAT = 'aabbccdd-1122-4333-8444-556677889900';
const tempRoots: string[] = [];

const call = <T>(channel: string, req?: unknown) => (registered.get(channel) as (r?: unknown) => Promise<Envelope<T>>)(req);

beforeEach(() => {
  registered.clear();
  __resetActiveSeatForTests();
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-brain-bridge-'));
  tempRoots.push(dataRoot);
  setActiveSeatId(SEAT);
  initCommandEveBridge();
});
afterEach(() => {
  __resetActiveSeatForTests();
  vi.clearAllMocks();
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('company-brain store providers (real bridge seam)', () => {
  it('registers list / read / write / remove providers', () => {
    expect(registered.has('command-eve.company-brain-list')).toBe(true);
    expect(registered.has('command-eve.company-brain-read')).toBe(true);
    expect(registered.has('command-eve.company-brain-write')).toBe(true);
    expect(registered.has('command-eve.company-brain-remove')).toBe(true);
  });

  it('write → list → remove round-trips against the ACTIVE seat home', async () => {
    // Empty at first.
    const empty = await call('command-eve.company-brain-list');
    expect(empty.success).toBe(true);
    expect(empty.data?.entries).toEqual([]);

    // WRITE an entry (upsert; author user / source settings).
    const written = await call('command-eve.company-brain-write', { kind: 'offer', title: 'Website Relaunch', body: 'The offer body' });
    expect(written.success).toBe(true);
    expect(written.data?.ok).toBe(true);
    expect(written.data?.created).toBe(true);
    const id = written.data?.entry?.id as string;
    expect(id).toMatch(/^offer-/);

    // The entry actually landed under THIS seat's home (not a global path).
    const home = resolveSeatHome(dataRoot, SEAT).hermesHome;
    expect(fs.existsSync(path.join(home, COMPANY_BRAIN_DIR, 'brain.json'))).toBe(true);
    expect(fs.existsSync(path.join(home, COMPANY_BRAIN_DIR, 'entries', `${id}.md`))).toBe(true);

    // LIST now returns titles/kinds (index only — no bodies in the payload).
    const listed = await call('command-eve.company-brain-list');
    expect(listed.data?.entries).toHaveLength(1);
    expect(listed.data?.entries?.[0]).toMatchObject({ id, title: 'Website Relaunch', kind: 'offer' });
    expect(listed.data?.entries?.[0]).not.toHaveProperty('body');

    // REMOVE it.
    const removed = await call('command-eve.company-brain-remove', { id });
    expect(removed.success).toBe(true);
    expect(removed.data?.removed).toBe(true);
    const afterRemove = await call('command-eve.company-brain-list');
    expect(afterRemove.data?.entries).toEqual([]);
  });

  it('T4: an EVE note dropped straight into entries/*.md is folded into the index by the LIST handler (reconciler hook)', async () => {
    // EVE writes a note with write_file into her own seat home — no brain.json
    // entry yet. Opening the Company-Brain tab (list) must reconcile it in FIRST so
    // the operator sees EVE's note immediately.
    const home = resolveSeatHome(dataRoot, SEAT).hermesHome;
    const entriesDir = path.join(home, COMPANY_BRAIN_DIR, 'entries');
    fs.mkdirSync(entriesDir, { recursive: true });
    fs.writeFileSync(path.join(entriesDir, 'note-mueller-brand.md'), '# Marke Müller\nRegional, herzlich.');

    const listed = await call('command-eve.company-brain-list');
    expect(listed.success).toBe(true);
    const entry = listed.data?.entries?.find((e) => e.id === 'note-mueller-brand');
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ id: 'note-mueller-brand', title: 'Marke Müller', kind: 'note' });
    // The reconciler folded it into brain.json (persisted, not just a list-time view).
    expect(fs.existsSync(path.join(home, COMPANY_BRAIN_DIR, 'brain.json'))).toBe(true);
  });

  it('read returns the body for an entry written through the seam (lazy single-body read)', async () => {
    const written = await call('command-eve.company-brain-write', { kind: 'note', title: 'My note', body: 'the body text' });
    const id = written.data?.entry?.id as string;

    const read = await call('command-eve.company-brain-read', { id });
    expect(read.success).toBe(true);
    expect(read.data?.ok).toBe(true);
    expect(read.data?.body).toBe('the body text\n');
  });

  it('read of a missing id is { ok:true, body:null } (not an error — a lost body reads as null)', async () => {
    const read = await call('command-eve.company-brain-read', { id: 'note-does-not-exist' });
    expect(read.success).toBe(true);
    expect(read.data?.ok).toBe(true);
    expect(read.data?.body).toBeNull();
  });

  it('read with a missing id returns COMPANY_BRAIN_READ_BAD_REQUEST', async () => {
    const read = await call('command-eve.company-brain-read', {});
    expect(read.success).toBe(false);
    expect(read.data?.reason_code).toBe('COMPANY_BRAIN_READ_BAD_REQUEST');
  });

  it('read with a crafted id surfaces as { ok:false } (traversal guard fires inside the store)', async () => {
    const read = await call('command-eve.company-brain-read', { id: '../../etc/passwd' });
    expect(read.success).toBe(false);
    expect(read.data?.ok).toBe(false);
  });

  it('write with an unknown kind fails as { ok:false } (allowlist enforced through the seam)', async () => {
    const res = await call('command-eve.company-brain-write', { kind: 'project', title: 'Alpha', body: 'x' });
    expect(res.success).toBe(false);
    expect(res.data?.ok).toBe(false);
  });

  it('write with a missing kind/title returns COMPANY_BRAIN_WRITE_BAD_REQUEST', async () => {
    const res = await call('command-eve.company-brain-write', { title: 'no kind' });
    expect(res.success).toBe(false);
    expect(res.data?.reason_code).toBe('COMPANY_BRAIN_WRITE_BAD_REQUEST');
  });

  it('remove with a missing id returns COMPANY_BRAIN_REMOVE_BAD_REQUEST', async () => {
    const res = await call('command-eve.company-brain-remove', {});
    expect(res.success).toBe(false);
    expect(res.data?.reason_code).toBe('COMPANY_BRAIN_REMOVE_BAD_REQUEST');
  });

  it('a crafted id surfaces as { ok:false } (traversal guard fires inside the store)', async () => {
    const res = await call('command-eve.company-brain-remove', { id: '../../etc' });
    expect(res.success).toBe(false);
    expect(res.data?.ok).toBe(false);
  });
});
