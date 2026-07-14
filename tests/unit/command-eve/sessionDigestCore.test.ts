/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * v1.4 T5 — L3 session-digest core (pure/injectable) + the store's system write path.
 * Covers: terminal-state mapping incl. the 'unknown' state-default falle · transcript
 * extraction + hard cap · Ollama failure ⇒ no entry, no throw · stable id replaces ·
 * FIFO-prune to 50 · the fence denies during a switch · upsertSystemEntry allows
 * session_digest while the user IPC write allowlist does NOT.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildDigestPrompt,
  clampTranscript,
  DIGEST_INPUT_CHAR_CAP,
  DIGEST_OUTPUT_CHAR_CAP,
  extractTranscriptText,
  isTerminalTurnState,
  runSessionDigest,
  sanitizeDigest,
  stableDigestId,
  type SessionDigestDeps,
} from '@process/commandEve/sessionDigestCore';
import {
  isWritableKind,
  listEntries,
  pruneSessionDigests,
  readEntryBody,
  SESSION_DIGEST_KIND,
  SESSION_DIGEST_MAX,
  upsertEntry,
  upsertSystemEntry,
} from '@process/commandEve/companyBrainStoreCore';

const tempRoots: string[] = [];
const mkHome = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-digest-'));
  tempRoots.push(dir);
  return dir;
};
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// A fixed clock so ids/titles/timestamps are deterministic.
const at = (iso: string) => () => new Date(iso);

// ── Deps factory: a fully faked, in-memory digest environment. ──────────────────
interface DepsProbe {
  deps: SessionDigestDeps;
  writes: Array<{ id: string; title: string; body: string }>;
  state: { pruneCalls: number };
}
const makeDeps = (over: Partial<SessionDigestDeps> = {}): DepsProbe => {
  const writes: Array<{ id: string; title: string; body: string }> = [];
  const state = { pruneCalls: 0 };
  const base: SessionDigestDeps = {
    isSwitchInFlight: () => false,
    fetchTranscript: async () => [
      { type: 'text', position: 'right', content: { content: 'Bau mir eine Landingpage für Müller Bau.' } },
      { type: 'text', position: 'left', content: { content: 'Klar, ich entwerfe Hero, Angebot und Kontakt.' } },
    ],
    resolveTitle: async () => 'Landingpage Müller',
    generateDigest: async () =>
      'Nutzer wollte eine Landingpage für Müller Bau; EVE hat Hero/Angebot/Kontakt entworfen. Offen: finaler Text.',
    writeDigestEntry: ({ id, title, body }) => {
      writes.push({ id, title, body });
    },
    pruneDigests: () => {
      state.pruneCalls += 1;
      return 0;
    },
    now: at('2026-07-02T10:00:00.000Z'),
  };
  return { deps: { ...base, ...over } as SessionDigestDeps, writes, state };
};

describe('isTerminalTurnState — terminal mapping + the state-default falle', () => {
  it('the three terminal states are terminal', () => {
    expect(isTerminalTurnState('ai_waiting_input')).toBe(true);
    expect(isTerminalTurnState('error')).toBe(true);
    expect(isTerminalTurnState('stopped')).toBe(true);
  });
  it("'unknown' is NOT terminal (the default a missing non-finished state maps to)", () => {
    expect(isTerminalTurnState('unknown')).toBe(false);
  });
  it('non-terminal / undefined / null states are not terminal', () => {
    expect(isTerminalTurnState('ai_generating')).toBe(false);
    expect(isTerminalTurnState('ai_waiting_confirmation')).toBe(false);
    expect(isTerminalTurnState('initializing')).toBe(false);
    expect(isTerminalTurnState(undefined)).toBe(false);
    expect(isTerminalTurnState(null)).toBe(false);
    expect(isTerminalTurnState('')).toBe(false);
  });
});

describe('extractTranscriptText — role + text from a compact backend list', () => {
  it('maps position right→user, left→assistant and pulls content.content', () => {
    const msgs = extractTranscriptText([
      { type: 'text', position: 'right', content: { content: 'Frage' } },
      { type: 'text', position: 'left', content: { content: 'Antwort' } },
    ]);
    expect(msgs).toEqual([
      { role: 'user', text: 'Frage' },
      { role: 'assistant', text: 'Antwort' },
    ]);
  });
  it('honors an explicit role and a bare-string content', () => {
    const msgs = extractTranscriptText([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: { text: 'hallo' } },
    ]);
    expect(msgs).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hallo' },
    ]);
  });
  it('skips non-text turns (tool_call, plan, …) and roleless / empty rows', () => {
    const msgs = extractTranscriptText([
      { type: 'tool_call', position: 'left', content: { name: 'x' } },
      { type: 'plan', position: 'left', content: { steps: [] } },
      { type: 'text', position: 'center', content: { content: 'system' } }, // no user/assistant role
      { type: 'text', position: 'right', content: { content: '   ' } }, // whitespace
      null,
      'not an object',
    ]);
    expect(msgs).toEqual([]);
  });
  it('non-array input is []', () => {
    expect(extractTranscriptText(undefined)).toEqual([]);
    expect(extractTranscriptText({} as unknown)).toEqual([]);
  });
});

describe('clampTranscript — hard cap keeps the most-recent text', () => {
  it('labels roles and joins under the cap', () => {
    const t = clampTranscript([
      { role: 'user', text: 'Frage' },
      { role: 'assistant', text: 'Antwort' },
    ]);
    expect(t).toBe('Nutzer: Frage\nEVE: Antwort');
  });
  it('drops the oldest lines when over the cap (tail retained)', () => {
    const big = Array.from({ length: 200 }, (_, i) => ({ role: 'user' as const, text: `msg ${i} ${'x'.repeat(60)}` }));
    const t = clampTranscript(big, 500);
    expect(t.length).toBeLessThanOrEqual(500);
    // The tail (latest) survives; the very first message does not.
    expect(t).toContain('msg 199');
    expect(t).not.toContain('msg 0 ');
  });
  it('empty messages ⇒ empty string', () => {
    expect(clampTranscript([])).toBe('');
    expect(clampTranscript([{ role: 'user', text: '   ' }])).toBe('');
  });
  it('DIGEST_INPUT_CHAR_CAP is the default ceiling', () => {
    const big = Array.from({ length: 5000 }, () => ({ role: 'assistant' as const, text: 'x'.repeat(50) }));
    expect(clampTranscript(big).length).toBeLessThanOrEqual(DIGEST_INPUT_CHAR_CAP);
  });
});

describe('sanitizeDigest — clean + ≤600c', () => {
  it('trims, strips a wrapping code-fence/quotes', () => {
    expect(sanitizeDigest('```\nHallo Welt\n```')).toBe('Hallo Welt');
    expect(sanitizeDigest('"Ein Satz."')).toBe('Ein Satz.');
  });
  it('truncates to the cap with an ellipsis on a word boundary', () => {
    const out = sanitizeDigest('wort '.repeat(400));
    expect(out.length).toBeLessThanOrEqual(DIGEST_OUTPUT_CHAR_CAP + 1);
    expect(out.endsWith('…')).toBe(true);
  });
  it('empty / whitespace ⇒ empty string', () => {
    expect(sanitizeDigest('')).toBe('');
    expect(sanitizeDigest('   \n  ')).toBe('');
    expect(sanitizeDigest(null)).toBe('');
  });
});

describe('stableDigestId — stable per conversation', () => {
  it('is deterministic and prefixed sd-', () => {
    expect(stableDigestId('abc-123')).toBe('sd-abc-123');
    expect(stableDigestId('abc-123')).toBe(stableDigestId('abc-123'));
  });
  it('sanitizes and never yields an unsafe id', () => {
    expect(stableDigestId('Sess/../ID!!')).toMatch(/^sd-[a-z0-9-]+$/);
    expect(stableDigestId('***')).toMatch(/^sd-[a-z0-9]+$/);
  });
});

describe('runSessionDigest — orchestration (fail-safe, injectable)', () => {
  it('writes a session_digest and prunes on the happy path', async () => {
    const probe = makeDeps();
    const res = await runSessionDigest(probe.deps, { conversationId: 'conv-1' });
    expect(res).toMatchObject({ ok: true, outcome: 'written', id: 'sd-conv-1' });
    expect(probe.writes).toHaveLength(1);
    expect(probe.writes[0]).toMatchObject({ id: 'sd-conv-1', title: 'Landingpage Müller' });
    expect(probe.writes[0].body).toContain('Landingpage');
    expect(probe.state.pruneCalls).toBe(1);
    expect(buildDigestPrompt('x')).toContain('KEIN Marketing-Ton');
  });

  it('no conversation id ⇒ no write', async () => {
    const probe = makeDeps();
    const res = await runSessionDigest(probe.deps, { conversationId: '   ' });
    expect(res.outcome).toBe('no_conversation');
    expect(probe.writes).toHaveLength(0);
  });

  it('FENCE: a switch in flight ⇒ refused, no write', async () => {
    const probe = makeDeps({ isSwitchInFlight: () => true });
    const res = await runSessionDigest(probe.deps, { conversationId: 'conv-1' });
    expect(res.outcome).toBe('switch_in_flight');
    expect(probe.writes).toHaveLength(0);
  });

  it('a switch that STARTS during inference is caught by the post-inference re-check', async () => {
    let flag = false;
    const probe = makeDeps({
      isSwitchInFlight: () => flag,
      generateDigest: async () => {
        flag = true; // a switch began while the local model ran
        return 'Ein Digest.';
      },
    });
    const res = await runSessionDigest(probe.deps, { conversationId: 'conv-1' });
    expect(res.outcome).toBe('switch_in_flight');
    expect(probe.writes).toHaveLength(0);
  });

  it('no usable transcript ⇒ no write', async () => {
    const probe = makeDeps({ fetchTranscript: async () => [] });
    const res = await runSessionDigest(probe.deps, { conversationId: 'conv-1' });
    expect(res.outcome).toBe('no_transcript');
    expect(probe.writes).toHaveLength(0);
  });

  it('Ollama returns null ⇒ NO entry, NO throw (fail-quiet, never a raw fallback)', async () => {
    const probe = makeDeps({ generateDigest: async () => null });
    const res = await runSessionDigest(probe.deps, { conversationId: 'conv-1' });
    expect(res.outcome).toBe('no_digest');
    expect(probe.writes).toHaveLength(0);
  });

  it('Ollama THROWS ⇒ still no throw out, resolves error', async () => {
    const probe = makeDeps({
      generateDigest: async () => {
        throw new Error('ollama down');
      },
    });
    await expect(runSessionDigest(probe.deps, { conversationId: 'conv-1' })).resolves.toMatchObject({
      ok: false,
      outcome: 'error',
    });
    expect(probe.writes).toHaveLength(0);
  });

  it('a missing conversation title falls back to a dated "Session <datum>"', async () => {
    const probe = makeDeps({ resolveTitle: async () => undefined });
    await runSessionDigest(probe.deps, { conversationId: 'conv-1' });
    expect(probe.writes[0].title).toBe('Session 2026-07-02');
  });
});

describe('companyBrainStoreCore — session_digest system write path', () => {
  it('upsertSystemEntry ALLOWS session_digest; the user IPC write allowlist does NOT', () => {
    const home = mkHome();
    // The user allowlist rejects session_digest …
    expect(isWritableKind(SESSION_DIGEST_KIND)).toBe(false);
    expect(() => upsertEntry(home, { kind: SESSION_DIGEST_KIND as never, title: 'x', body: 'y' })).toThrow();
    // … but the system writer accepts it.
    const res = upsertSystemEntry(home, {
      id: 'sd-conv-1',
      kind: SESSION_DIGEST_KIND,
      title: 'Session',
      body: 'Digest body',
    });
    expect(res.ok).toBe(true);
    expect(res.entry).toMatchObject({ id: 'sd-conv-1', kind: 'session_digest', author: 'eve', source: 'chat' });
    expect(readEntryBody(home, 'sd-conv-1')).toBe('Digest body\n');
  });

  it('a stable id REPLACES on re-digest (no duplicate)', () => {
    const home = mkHome();
    upsertSystemEntry(home, {
      id: 'sd-conv-1',
      kind: SESSION_DIGEST_KIND,
      title: 'v1',
      body: 'first',
      now: at('2026-07-02T10:00:00.000Z'),
    });
    upsertSystemEntry(home, {
      id: 'sd-conv-1',
      kind: SESSION_DIGEST_KIND,
      title: 'v2',
      body: 'second',
      now: at('2026-07-02T11:00:00.000Z'),
    });
    const digests = listEntries(home).filter((e) => e.kind === SESSION_DIGEST_KIND);
    expect(digests).toHaveLength(1);
    expect(digests[0].title).toBe('v2');
    expect(readEntryBody(home, 'sd-conv-1')).toBe('second\n');
  });

  it('a system entry cannot be resurrected by the T4 reconciler (it is already indexed)', () => {
    const home = mkHome();
    upsertSystemEntry(home, { id: 'sd-conv-1', kind: SESSION_DIGEST_KIND, title: 'x', body: 'body' });
    // Re-listing (which reconciles) does not duplicate or re-author it.
    const before = listEntries(home).find((e) => e.id === 'sd-conv-1');
    expect(before?.author).toBe('eve');
    expect(before?.kind).toBe('session_digest');
  });

  it('rejects a kind outside the system allowlist and a blank id/title', () => {
    const home = mkHome();
    expect(() => upsertSystemEntry(home, { id: 'sd-x', kind: 'totally_unknown', title: 't', body: 'b' })).toThrow();
    expect(() => upsertSystemEntry(home, { id: '', kind: SESSION_DIGEST_KIND, title: 't', body: 'b' })).toThrow();
    expect(() => upsertSystemEntry(home, { id: 'sd-x', kind: SESSION_DIGEST_KIND, title: '  ', body: 'b' })).toThrow();
    expect(() =>
      upsertSystemEntry(home, { id: '../../etc', kind: SESSION_DIGEST_KIND, title: 't', body: 'b' })
    ).toThrow();
  });
});

describe('pruneSessionDigests — FIFO to the per-seat cap (default 50)', () => {
  const seedDigests = (home: string, n: number) => {
    for (let i = 0; i < n; i += 1) {
      const stamp = new Date(Date.UTC(2026, 6, 2, 0, 0, i)).toISOString(); // ascending
      upsertSystemEntry(home, {
        id: `sd-conv-${String(i).padStart(3, '0')}`,
        kind: SESSION_DIGEST_KIND,
        title: `s${i}`,
        body: `b${i}`,
        now: () => new Date(stamp),
      });
    }
  };

  it('leaves entries untouched at or below the cap', () => {
    const home = mkHome();
    seedDigests(home, 5);
    const res = pruneSessionDigests(home, 10);
    expect(res.pruned).toBe(0);
    expect(listEntries(home).filter((e) => e.kind === SESSION_DIGEST_KIND)).toHaveLength(5);
  });

  it('prunes OLDEST-first down to the cap and unlinks their bodies', () => {
    const home = mkHome();
    seedDigests(home, 55);
    const res = pruneSessionDigests(home, SESSION_DIGEST_MAX); // 50
    expect(res.pruned).toBe(5);
    // The five OLDEST (000..004) are gone; the newest survive.
    expect(res.prunedIds).toEqual(['sd-conv-000', 'sd-conv-001', 'sd-conv-002', 'sd-conv-003', 'sd-conv-004']);
    const remaining = listEntries(home).filter((e) => e.kind === SESSION_DIGEST_KIND);
    expect(remaining).toHaveLength(50);
    // Body of a pruned digest is unlinked; a survivor's body remains.
    expect(readEntryBody(home, 'sd-conv-000')).toBeNull();
    expect(readEntryBody(home, 'sd-conv-054')).toBe('b54\n');
  });

  it('only session_digest entries count/are pruned — other kinds are untouched', () => {
    const home = mkHome();
    upsertEntry(home, { kind: 'offer', title: 'Offer', body: 'keep me', id: 'offer-keep' });
    seedDigests(home, 52);
    pruneSessionDigests(home, SESSION_DIGEST_MAX);
    expect(listEntries(home).find((e) => e.id === 'offer-keep')).toBeDefined();
    expect(listEntries(home).filter((e) => e.kind === SESSION_DIGEST_KIND)).toHaveLength(50);
  });

  it('never throws on a bad home', () => {
    expect(pruneSessionDigests('not-absolute').ok).toBe(false);
  });
});
