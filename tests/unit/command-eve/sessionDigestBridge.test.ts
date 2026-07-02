/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.4 T5 — session-digest IPC + pre-switch flush, tested through the REAL bridge
 * seam (same discipline as companyBrainStoreBridge / companyBrainSwitchWriteFence).
 *
 * Drives the ACTUAL `command-eve.session-digest` provider initCommandEveBridge
 * registers, with a real tmp userDataPath + a real active seat, and a FAKED backend +
 * Ollama over a stubbed global fetch (loopback URLs). Asserts: a digest round-trips
 * into the ACTIVE seat's brain as a session_digest entry; an Ollama miss writes
 * nothing; and a digest that is IN FLIGHT when a seat switch starts is FLUSHED (awaited)
 * before the switch takes its lock — the write lands in the OUTGOING seat.
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

vi.mock('@process/utils/initStorage', () => ({
  ProcessConfig: { get: () => undefined, getSync: () => undefined, set: () => {} },
  getSkillsDir: () => '/tmp/skills',
  getCronSkillsDir: () => '/tmp/cron-skills',
}));

let dataRoot = '';
vi.mock('@process/utils/utils', () => ({ getDataPath: () => dataRoot }));

// Freeze the switch handler's FIRST heavy await (readMySeatsWire) so we can drive the
// order of a switch vs. an in-flight digest.
let releaseSwitchGate: (() => void) | null = null;
const switchGate = () =>
  new Promise<null>((resolve) => {
    releaseSwitchGate = () => resolve(null);
  });
const readMySeatsWireCoreMock = vi.fn(() => switchGate());
vi.mock('@process/commandEve/seatWireFetchCore', () => ({
  readMySeatsWire: (...args: unknown[]) => readMySeatsWireCoreMock(...args),
}));

import { __resetActiveSeatForTests, resolveSeatHome, setActiveSeatId } from '@process/commandEve/seatContextCore';
import { COMPANY_BRAIN_DIR } from '@process/commandEve/companyBrainSeedCore';
import { listEntries, readEntryBody, SESSION_DIGEST_KIND } from '@process/commandEve/companyBrainStoreCore';
import { initCommandEveBridge } from '@process/bridge/commandEveBridge';

type Envelope = { success: boolean; msg?: string; data?: { ok?: boolean; outcome?: string; id?: string; reason_code?: string } };

const SEAT = 'aabbccdd-1122-4333-8444-556677889900';
const tempRoots: string[] = [];
const call = (channel: string, req?: unknown) => (registered.get(channel) as (r?: unknown) => Promise<Envelope>)(req);

// ── Fake backend + Ollama over a stubbed global fetch. ──────────────────────────
let ollamaModel: string | null = 'command-eve-gemma4-e4b';
let ollamaReply: string | null = 'Nutzer wollte eine Landingpage; EVE hat sie entworfen. Offen: Text.';
let transcriptItems: unknown[] = [
  { type: 'text', position: 'right', content: { content: 'Bau mir eine Landingpage.' } },
  { type: 'text', position: 'left', content: { content: 'Klar, hier ist ein Entwurf.' } },
];
let generateDelayMs = 0;
const conversations = [{ id: 'conv-1', name: 'Landingpage Müller' }];

const jsonRes = (body: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response);

const fakeFetch = vi.fn(async (input: string | URL, _init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url.endsWith('/api/tags')) {
    return jsonRes({ models: ollamaModel ? [{ name: ollamaModel }] : [] });
  }
  if (url.endsWith('/api/chat')) {
    if (generateDelayMs > 0) await new Promise((r) => setTimeout(r, generateDelayMs));
    if (ollamaReply === null) return jsonRes({}, false);
    return jsonRes({ message: { content: ollamaReply } });
  }
  if (url.includes('/messages')) {
    return jsonRes({ data: { items: transcriptItems, total: transcriptItems.length, has_more: false } });
  }
  if (url.includes('/api/conversations')) {
    return jsonRes({ data: { items: conversations, total: conversations.length, has_more: false } });
  }
  return jsonRes({}, false);
});

beforeEach(() => {
  registered.clear();
  releaseSwitchGate = null;
  readMySeatsWireCoreMock.mockClear();
  fakeFetch.mockClear();
  ollamaModel = 'command-eve-gemma4-e4b';
  ollamaReply = 'Nutzer wollte eine Landingpage; EVE hat sie entworfen. Offen: Text.';
  transcriptItems = [
    { type: 'text', position: 'right', content: { content: 'Bau mir eine Landingpage.' } },
    { type: 'text', position: 'left', content: { content: 'Klar, hier ist ein Entwurf.' } },
  ];
  generateDelayMs = 0;
  __resetActiveSeatForTests();
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-digest-bridge-'));
  tempRoots.push(dataRoot);
  setActiveSeatId(SEAT);
  (globalThis as { __backendPort?: number }).__backendPort = 13400;
  vi.stubGlobal('fetch', fakeFetch);
  initCommandEveBridge();
});
afterEach(() => {
  releaseSwitchGate?.();
  __resetActiveSeatForTests();
  vi.unstubAllGlobals();
  delete (globalThis as { __backendPort?: number }).__backendPort;
  vi.clearAllMocks();
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('command-eve.session-digest (real bridge seam)', () => {
  it('registers the session-digest provider', () => {
    expect(registered.has('command-eve.session-digest')).toBe(true);
  });

  it('writes a session_digest entry into the ACTIVE seat brain (round-trip)', async () => {
    const res = await call('command-eve.session-digest', { conversation_id: 'conv-1' });
    expect(res.success).toBe(true);
    expect(res.data?.outcome).toBe('written');
    expect(res.data?.id).toBe('sd-conv-1');

    const home = resolveSeatHome(dataRoot, SEAT).hermesHome;
    const entry = listEntries(home).find((e) => e.id === 'sd-conv-1');
    expect(entry).toMatchObject({ id: 'sd-conv-1', kind: SESSION_DIGEST_KIND, author: 'eve', source: 'chat', title: 'Landingpage Müller' });
    const body = readEntryBody(home, 'sd-conv-1');
    expect(body).toContain('Landingpage');
    // The digest body file actually landed under THIS seat's home.
    expect(fs.existsSync(path.join(home, COMPANY_BRAIN_DIR, 'entries', 'sd-conv-1.md'))).toBe(true);
  });

  it('an Ollama miss writes NOTHING (fail-quiet, no raw fallback)', async () => {
    ollamaReply = null;
    const res = await call('command-eve.session-digest', { conversation_id: 'conv-1' });
    expect(res.success).toBe(false);
    expect(res.data?.outcome).toBe('no_digest');
    const home = resolveSeatHome(dataRoot, SEAT).hermesHome;
    expect(listEntries(home).some((e) => e.kind === SESSION_DIGEST_KIND)).toBe(false);
  });

  it('a missing local model writes NOTHING', async () => {
    ollamaModel = null;
    const res = await call('command-eve.session-digest', { conversation_id: 'conv-1' });
    expect(res.data?.outcome).toBe('no_digest');
  });

  it('an empty transcript writes NOTHING', async () => {
    transcriptItems = [];
    const res = await call('command-eve.session-digest', { conversation_id: 'conv-1' });
    expect(res.data?.outcome).toBe('no_transcript');
  });

  it('re-digest of the same conversation REPLACES (no duplicate)', async () => {
    await call('command-eve.session-digest', { conversation_id: 'conv-1' });
    ollamaReply = 'Zweiter Digest mit neuem Inhalt.';
    await call('command-eve.session-digest', { conversation_id: 'conv-1' });
    const home = resolveSeatHome(dataRoot, SEAT).hermesHome;
    const digests = listEntries(home).filter((e) => e.kind === SESSION_DIGEST_KIND);
    expect(digests).toHaveLength(1);
    expect(readEntryBody(home, 'sd-conv-1')).toContain('Zweiter Digest');
  });
});

describe('T5 pre-switch flush (real switch-seat + digest seam)', () => {
  it('a digest in flight when a switch starts is FLUSHED before the switch locks — the write lands in the outgoing seat', async () => {
    // Make the Ollama call slow so the digest is genuinely in-flight when we switch.
    generateDelayMs = 60;
    const digestPromise = call('command-eve.session-digest', { conversation_id: 'conv-1' });
    // Let the handler register its in-flight run (it awaits the transcript fetch first).
    await Promise.resolve();
    await Promise.resolve();

    // Start a switch. Its pre-flush AWAITS the in-flight digest BEFORE taking the lock,
    // so the digest completes and writes to the (still-active) OUTGOING seat; only then
    // does the switch reach the gated readMySeatsWire.
    const switchPromise = call('command-eve.switch-seat', { seatId: 'seat-2' });

    // The digest resolves (writes to the OUTGOING seat) during the flush window.
    const digestRes = await digestPromise;
    expect(digestRes.data?.outcome).toBe('written');

    // Release the switch gate once it reaches readMySeatsWire (may be a tick after the
    // flush). With readMySeatsWire → null, the switch resolves FORBIDDEN before the real
    // applySeatSwitch lifecycle runs, so awaiting it can't hang on a backend respawn.
    for (let i = 0; i < 50 && !releaseSwitchGate; i += 1) await Promise.resolve();
    releaseSwitchGate?.();
    await switchPromise.catch(() => undefined);

    // The digest landed in the OUTGOING (still-active-at-flush) seat's brain.
    const home = resolveSeatHome(dataRoot, SEAT).hermesHome;
    expect(listEntries(home).some((e) => e.id === 'sd-conv-1')).toBe(true);
  });

  it('a digest requested WHILE a switch is already in flight is fenced (switch_in_flight)', async () => {
    const switchPromise = call('command-eve.switch-seat', { seatId: 'seat-2' });
    await Promise.resolve();
    await Promise.resolve();

    const res = await call('command-eve.session-digest', { conversation_id: 'conv-1' });
    expect(res.data?.outcome).toBe('switch_in_flight');
    const home = resolveSeatHome(dataRoot, SEAT).hermesHome;
    expect(listEntries(home).some((e) => e.kind === SESSION_DIGEST_KIND)).toBe(false);

    releaseSwitchGate?.();
    await switchPromise.catch(() => undefined);
  });
});
