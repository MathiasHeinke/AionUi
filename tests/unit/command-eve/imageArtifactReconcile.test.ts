import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractImageBindCandidatesFromTranscript } from '@/common/config/imageArtifactReconcileCore';
import { reconcileConversationImageArtifactBinds } from '@/process/commandEve/imageArtifactReconcileMain';
import {
  bindStagedImageArtifact,
  countPendingStagedImageArtifacts,
  readImageArtifactRecordById,
  stageGeneratedImageArtifact,
} from '@/process/commandEve/imageArtifactStore';
import {
  handleCommandEveImageArtifactBind,
  handleCommandEveImageArtifactsList,
} from '@/process/bridge/commandEveImageArtifactBridge';
import { decideImageArtifactReconcileRelay } from '@/renderer/pages/conversation/GroupedHistory/hooks/useImageArtifactReconcileRelay';

const R2_ROW_PATH = 'tests/fixtures/command-eve/r2-row.json';
const R2_HANDLE = `img_h_${'ab'.repeat(32)}`;
const R2_TOOL_CALL_ID = 'tc-syntheticr2001';
const CONVO = 'conv-synth-001';

const SOURCE_BYTES = Buffer.from('reconcile-source-image-bytes');
const PROMPT_SHA = crypto.createHash('sha256').update('reconcile-prompt').digest('hex');

function r2Message(): Record<string, unknown> {
  // SYNTHETIC completed acp_tool_call row (no live token/permit/identifiers —
  // the real R2 row lives only in /tmp evidence). The API serves the row as
  // { type, status, content(JSON string) }.
  const row = JSON.parse(fs.readFileSync(R2_ROW_PATH, 'utf8')) as Record<string, unknown>;
  return { type: 'acp_tool_call', status: 'finish', content: JSON.stringify(row) };
}

let dataRoot: string;
beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-reconcile-'));
});
afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

function stageOrphan(handle?: { randomBytes?: (size: number) => Uint8Array }) {
  const staged = stageGeneratedImageArtifact(dataRoot, {
    bytes: SOURCE_BYTES,
    mimeType: 'image/png',
    tier: 'quality',
    model: 'gemini',
    resolution: '1K',
    aspectRatio: '16:9',
    promptSha256: PROMPT_SHA,
    parentArtifactId: 'img_parent',
    ...handle,
  });
  expect(staged).toBeTruthy();
  return staged!;
}

describe('extractImageBindCandidatesFromTranscript (strict durable extractor)', () => {
  it('lifts the candidate from the persisted completed R2 row', () => {
    const candidates = extractImageBindCandidatesFromTranscript([r2Message()]);
    expect(candidates).toEqual([{ toolCallId: R2_TOOL_CALL_ID, handle: R2_HANDLE }]);
  });

  it('accepts content as a parsed object as well as a JSON string', () => {
    const row = JSON.parse(fs.readFileSync(R2_ROW_PATH, 'utf8')) as Record<string, unknown>;
    const candidates = extractImageBindCandidatesFromTranscript([
      { type: 'acp_tool_call', status: 'completed', content: row },
    ]);
    expect(candidates).toHaveLength(1);
  });

  it('never scans assistant prose, thinking, tips or other message types', () => {
    const prose = `Sieh dir das Bild an: ${R2_HANDLE} — sieht gut aus!`;
    const items = [
      { type: 'text', status: 'finish', content: JSON.stringify({ content: prose }) },
      { type: 'thinking', status: 'finish', content: JSON.stringify({ content: prose }) },
      { type: 'tips', status: 'finish', content: JSON.stringify({ content: prose }) },
      { type: 'text', status: 'finish', content: prose },
    ];
    expect(extractImageBindCandidatesFromTranscript(items)).toEqual([]);
  });

  it('ignores in-flight and failed tool calls, missing ids and malformed handles', () => {
    const base = r2Message();
    const inFlight = {
      ...base,
      content: JSON.stringify({
        update: { status: 'in_progress', tool_call_id: 'tc-x', content: [{ content: { text: R2_HANDLE } }] },
      }),
    };
    const failed = {
      ...base,
      content: JSON.stringify({
        update: { status: 'failed', tool_call_id: 'tc-y', content: [{ content: { text: R2_HANDLE } }] },
      }),
    };
    const noId = {
      ...base,
      content: JSON.stringify({ update: { status: 'completed', content: [{ content: { text: R2_HANDLE } }] } }),
    };
    const badHandle = {
      ...base,
      content: JSON.stringify({
        update: { status: 'completed', tool_call_id: 'tc-z', content: [{ content: { text: 'img_h_not-hex-at-all' } }] },
      }),
    };
    expect(extractImageBindCandidatesFromTranscript([inFlight, failed, noId, badHandle])).toEqual([]);
  });

  it('dedupes by tool call id across pagination replays', () => {
    const candidates = extractImageBindCandidatesFromTranscript([r2Message(), r2Message()]);
    expect(candidates).toHaveLength(1);
  });
});

describe('reconcileConversationImageArtifactBinds (Main orchestration)', () => {
  function depsWith(items: unknown, logs: string[]) {
    return {
      fetchTranscript: async () => items,
      bind: bindStagedImageArtifact,
      log: (line: string) => logs.push(line),
    };
  }

  it('binds the orphan from the persisted row: active, correct conversation + parent, no other fetch', async () => {
    const staged = stageOrphan();
    const transcriptItems = [r2Message()];
    // Point the transcript's handle at OUR staged handle by rewriting the row text.
    const rewritten = JSON.parse(JSON.stringify(transcriptItems[0]) as string) as { content: string };
    rewritten.content = rewritten.content.split(R2_HANDLE).join(staged.handle);
    const logs: string[] = [];
    const summary = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, depsWith([rewritten], logs));
    expect(summary).toMatchObject({ candidates: 1, bound: 1, alreadyBound: 0, refused: [], transcriptFetched: true });
    const record = readImageArtifactRecordById(dataRoot, staged.record.id);
    expect(record?.status).toBe('active');
    expect(record?.conversation_id).toBe(CONVO);
    expect(record?.payload.parent_artifact_id).toBe('img_parent');
    expect(record?.bound_tool_call_id).toBe(R2_TOOL_CALL_ID);
    expect(logs).toEqual([]);
  });

  it('replay is idempotent: second reconcile reports alreadyBound, still one record', async () => {
    const staged = stageOrphan();
    const logs: string[] = [];
    bindStagedImageArtifact(dataRoot, { conversationId: CONVO, handle: staged.handle, toolCallId: R2_TOOL_CALL_ID });
    const rewritten = r2Message();
    rewritten.content = rewritten.content.split(R2_HANDLE).join(staged.handle);
    const summary = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, depsWith([rewritten], logs));
    expect(summary).toMatchObject({ candidates: 1, bound: 0, alreadyBound: 1, refused: [] });
    const records = readImageArtifactRecordById(dataRoot, staged.record.id);
    expect(records?.status).toBe('active');
  });

  it('a reconcile for ANOTHER conversation is refused once the record is bound elsewhere', async () => {
    // The truthful cross-conversation case: candidates only ever come from the
    // SAME conversation's transcript, so a wrong-conversation bind can only be
    // attempted against a record the right conversation already claimed — and
    // the store refuses it, leaving the binding untouched.
    const staged = stageOrphan();
    bindStagedImageArtifact(dataRoot, { conversationId: CONVO, handle: staged.handle, toolCallId: R2_TOOL_CALL_ID });
    const logs: string[] = [];
    const rewritten = r2Message();
    rewritten.content = rewritten.content.split(R2_HANDLE).join(staged.handle);
    const summary = await reconcileConversationImageArtifactBinds(
      dataRoot,
      'other-conversation',
      depsWith([rewritten], logs)
    );
    expect(summary.refused).toEqual([{ toolCallId: R2_TOOL_CALL_ID, reason: 'conversation-mismatch' }]);
    const record = readImageArtifactRecordById(dataRoot, staged.record.id);
    expect(record?.status).toBe('active');
    expect(record?.conversation_id).toBe(CONVO);
    expect(logs.some((line) => line.includes('conversation-mismatch'))).toBe(true);
  });

  it('an expired staged handle is refused and logged, never bound', async () => {
    const staged = stageOrphan();
    // Age the handle entry past its TTL by rewriting the staged entry file.
    const stagedDir = path.join(dataRoot, 'command-eve-managed-image-artifacts', 'staged');
    const file = fs.readdirSync(stagedDir)[0];
    const entry = JSON.parse(fs.readFileSync(path.join(stagedDir, file), 'utf8')) as { expires_at_ms: number };
    entry.expires_at_ms = 1;
    fs.writeFileSync(path.join(stagedDir, file), JSON.stringify(entry), { mode: 0o600 });
    const logs: string[] = [];
    const rewritten = r2Message();
    rewritten.content = rewritten.content.split(R2_HANDLE).join(staged.handle);
    const summary = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, depsWith([rewritten], logs));
    expect(summary.refused).toEqual([{ toolCallId: R2_TOOL_CALL_ID, reason: 'handle-expired' }]);
    expect(logs.some((line) => line.includes('handle-expired'))).toBe(true);
  });

  it('a transcript fetch failure reconciles nothing and never throws', async () => {
    const summary = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, {
      fetchTranscript: async () => {
        throw new Error('backend down');
      },
      bind: bindStagedImageArtifact,
      log: () => undefined,
    });
    expect(summary).toMatchObject({ candidates: 0, bound: 0, refused: [], transcriptFetched: false });
  });
});

describe('the pending-staged guard keeps ordinary loads cheap', () => {
  it('no pending staged entries: the transcript is NEVER fetched', async () => {
    let fetchCalls = 0;
    const summary = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, {
      fetchTranscript: async () => {
        fetchCalls += 1;
        return [r2Message()];
      },
      bind: bindStagedImageArtifact,
      log: () => undefined,
      countPendingStaged: () => 0,
    });
    expect(fetchCalls).toBe(0);
    expect(summary).toMatchObject({ pendingStaged: 0, transcriptFetched: false, candidates: 0, bound: 0 });
  });

  it('only expired staged entries: the guard purges them and still skips the fetch', async () => {
    const staged = stageOrphan();
    const stagedDir = path.join(dataRoot, 'command-eve-managed-image-artifacts', 'staged');
    const file = fs.readdirSync(stagedDir)[0];
    const entry = JSON.parse(fs.readFileSync(path.join(stagedDir, file), 'utf8')) as { expires_at_ms: number };
    entry.expires_at_ms = 1;
    fs.writeFileSync(path.join(stagedDir, file), JSON.stringify(entry), { mode: 0o600 });
    let fetchCalls = 0;
    const summary = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, {
      fetchTranscript: async () => {
        fetchCalls += 1;
        return [];
      },
      bind: bindStagedImageArtifact,
      log: () => undefined,
      countPendingStaged: (dp) => countPendingStagedImageArtifacts(dp),
    });
    expect(fetchCalls).toBe(0);
    expect(summary.pendingStaged).toBe(0);
    // The expired entry AND its never-bound record were purged by the guard.
    expect(fs.readdirSync(stagedDir)).toEqual([]);
    expect(readImageArtifactRecordById(dataRoot, staged.record.id)).toBeUndefined();
  });

  it('pending staged entry: the full reconcile runs (guard passes through)', async () => {
    const staged = stageOrphan();
    let fetchCalls = 0;
    const rewritten = r2Message();
    rewritten.content = rewritten.content.split(R2_HANDLE).join(staged.handle);
    const summary = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, {
      fetchTranscript: async () => {
        fetchCalls += 1;
        return [rewritten];
      },
      bind: bindStagedImageArtifact,
      log: () => undefined,
      countPendingStaged: (dp) => countPendingStagedImageArtifacts(dp),
    });
    expect(fetchCalls).toBe(1);
    expect(summary).toMatchObject({ pendingStaged: 1, bound: 1, transcriptFetched: true });
  });

  it('an ordinary list with nothing pending costs no transcript read and still lists actives', async () => {
    const staged = stageOrphan();
    bindStagedImageArtifact(dataRoot, { conversationId: CONVO, handle: staged.handle, toolCallId: R2_TOOL_CALL_ID });
    // No staged entries remain pending (the one above is bound), so the
    // guarded reconcile inside the list must not fetch anything.
    let fetchCalls = 0;
    const listed = await handleCommandEveImageArtifactsList(
      { conversationId: CONVO },
      {
        getDataPath: () => dataRoot,
        reconcileBeforeList: (conversationId) =>
          reconcileConversationImageArtifactBinds(dataRoot, conversationId, {
            fetchTranscript: async () => {
              fetchCalls += 1;
              return [];
            },
            bind: bindStagedImageArtifact,
            log: () => undefined,
            countPendingStaged: (dp) => countPendingStagedImageArtifacts(dp),
          }),
      }
    );
    expect(fetchCalls).toBe(0);
    expect(listed.map((record) => record.id)).toEqual([staged.record.id]);
  });
});

describe('list recovery + renderer race', () => {
  it('the list reconciles first: an orphan binds and appears in the same list call', async () => {
    const staged = stageOrphan();
    const listed = await handleCommandEveImageArtifactsList(
      { conversationId: CONVO },
      {
        getDataPath: () => dataRoot,
        reconcileBeforeList: async (conversationId) => {
          bindStagedImageArtifact(dataRoot, { conversationId, handle: staged.handle, toolCallId: R2_TOOL_CALL_ID });
        },
      }
    );
    expect(listed.map((record) => record.id)).toEqual([staged.record.id]);
    expect(listed[0]?.payload.parent_artifact_id).toBe('img_parent');
  });

  it('live fast-path then durable reconcile: exactly one active record, alreadyBound is normal', async () => {
    const staged = stageOrphan();
    // Renderer fast path wins the race.
    bindStagedImageArtifact(dataRoot, { conversationId: CONVO, handle: staged.handle, toolCallId: R2_TOOL_CALL_ID });
    const logs: string[] = [];
    const rewritten = r2Message();
    rewritten.content = rewritten.content.split(R2_HANDLE).join(staged.handle);
    const summary = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, {
      fetchTranscript: async () => [rewritten],
      bind: bindStagedImageArtifact,
      log: (line) => logs.push(line),
    });
    expect(summary.bound).toBe(0);
    expect(summary.alreadyBound).toBe(1);
    expect(readImageArtifactRecordById(dataRoot, staged.record.id)?.status).toBe('active');
  });
});

describe('decideImageArtifactReconcileRelay', () => {
  it('reconciles only terminal turn states with a conversation id', () => {
    expect(decideImageArtifactReconcileRelay({ session_id: CONVO, state: 'ai_waiting_input' })).toEqual({
      action: 'reconcile',
      conversationId: CONVO,
    });
    expect(decideImageArtifactReconcileRelay({ session_id: CONVO, state: 'in_progress' })).toEqual({
      action: 'ignore',
    });
    expect(decideImageArtifactReconcileRelay({ session_id: '', state: 'completed' })).toEqual({ action: 'ignore' });
    expect(decideImageArtifactReconcileRelay({})).toEqual({ action: 'ignore' });
  });
});

describe('the list-time win publishes exactly once (production wiring shape)', () => {
  it('a fresh bind from reconcileBeforeList emits command-eve.image-artifacts-changed once and the same list already carries the child', async () => {
    const staged = stageOrphan();
    const rewritten = r2Message();
    rewritten.content = rewritten.content.split(R2_HANDLE).join(staged.handle);
    const emitted: string[] = [];
    // Mirror the production closure (commandEveBridge
    // reconcileImageArtifactBindsForConversation): the SAME reconcile call the
    // list path makes, with the emitter wired through onFreshBind.
    const listed = await handleCommandEveImageArtifactsList(
      { conversationId: CONVO },
      {
        getDataPath: () => dataRoot,
        reconcileBeforeList: (conversationId) =>
          reconcileConversationImageArtifactBinds(dataRoot, conversationId, {
            fetchTranscript: async () => [rewritten],
            bind: bindStagedImageArtifact,
            log: () => undefined,
            onFreshBind: (id) => emitted.push(id),
          }),
      }
    );
    expect(emitted).toEqual([CONVO]);
    expect(listed.map((record) => record.id)).toEqual([staged.record.id]);
    expect(listed[0]?.status).toBe('active');
    expect(listed[0]?.payload.parent_artifact_id).toBe('img_parent');

    // A second list (e.g. a provider reload right after): no new emission.
    const listedAgain = await handleCommandEveImageArtifactsList(
      { conversationId: CONVO },
      {
        getDataPath: () => dataRoot,
        reconcileBeforeList: (conversationId) =>
          reconcileConversationImageArtifactBinds(dataRoot, conversationId, {
            fetchTranscript: async () => [rewritten],
            bind: bindStagedImageArtifact,
            log: () => undefined,
            onFreshBind: (id) => emitted.push(id),
          }),
      }
    );
    expect(listedAgain).toHaveLength(1);
    expect(emitted).toEqual([CONVO]);
  });
});

describe('the race-proof fresh-bind notification inside the reconcile', () => {
  it('onFreshBind fires once for the lane that WINS the race; the relay-late run reports pendingStaged=0/bound=0 and is covered by the unconditional terminal refresh', async () => {
    // The exact R2 sequence: the LIST-time reconcile binds first...
    const staged = stageOrphan();
    const notifications: string[] = [];
    const rewritten = r2Message();
    rewritten.content = rewritten.content.split(R2_HANDLE).join(staged.handle);
    const first = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, {
      fetchTranscript: async () => [rewritten],
      bind: bindStagedImageArtifact,
      log: () => undefined,
      onFreshBind: (id) => notifications.push(id),
    });
    expect(first.bound).toBe(1);
    expect(notifications).toEqual([CONVO]);

    // ...then the TERMINAL relay's reconcile runs: the guard sees only the
    // bound (retained) handle, so pendingStaged=0 and NO fetch happens at all
    // — the exact R2 relay summary (pendingStaged=0/bound=0). No second
    // notification; the unconditional terminal refresh in
    // useImageArtifactReconcileRelay is what re-renders the card.
    const second = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, {
      fetchTranscript: async () => [rewritten],
      bind: bindStagedImageArtifact,
      log: () => undefined,
      countPendingStaged: (dp) => countPendingStagedImageArtifacts(dp),
      onFreshBind: (id) => notifications.push(id),
    });
    expect(second).toMatchObject({ bound: 0, alreadyBound: 0, pendingStaged: 0, transcriptFetched: false });
    expect(notifications).toEqual([CONVO]);
    expect(readImageArtifactRecordById(dataRoot, staged.record.id)?.status).toBe('active');
  });

  it('no fresh bind, no notification — ordinary turns stay quiet', async () => {
    const notifications: string[] = [];
    const summary = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, {
      fetchTranscript: async () => [],
      bind: bindStagedImageArtifact,
      log: () => undefined,
      onFreshBind: (id) => notifications.push(id),
    });
    expect(summary.bound).toBe(0);
    expect(notifications).toEqual([]);
  });
});

describe('the fresh-bind renderer notification (same-turn insertion trigger)', () => {
  it('onFreshBind fires exactly once with the canonical id on a fresh bind, never on alreadyBound or refusal', async () => {
    const staged = stageOrphan();
    const notifications: string[] = [];
    const deps = {
      getDataPath: () => dataRoot,
      onFreshBind: (conversationId: string) => notifications.push(conversationId),
    };
    const bound = await handleCommandEveImageArtifactBind(
      { conversationId: CONVO, handle: staged.handle, toolCallId: R2_TOOL_CALL_ID },
      deps
    );
    expect(bound.ok).toBe(true);
    expect(notifications).toEqual([CONVO]);

    const again = await handleCommandEveImageArtifactBind(
      { conversationId: CONVO, handle: staged.handle, toolCallId: R2_TOOL_CALL_ID },
      deps
    );
    expect(again.ok && 'alreadyBound' in again && again.alreadyBound).toBe(true);
    expect(notifications).toEqual([CONVO]);

    const refused = await handleCommandEveImageArtifactBind(
      {
        conversationId: CONVO,
        handle: 'img_h_0000000000000000000000000000000000000000000000000000000000000000',
        toolCallId: 'tc-x',
      },
      deps
    );
    expect(refused.ok).toBe(false);
    expect(notifications).toEqual([CONVO]);
  });
});

describe('notification failure isolation (P1)', () => {
  it('a THROWING onFreshBind keeps the successful bind result in the IPC handler — never artifact-missing, and the retry reads alreadyBound', async () => {
    const staged = stageOrphan();
    const deps = {
      getDataPath: () => dataRoot,
      onFreshBind: () => {
        throw new Error('emitter exploded');
      },
    };
    const result = await handleCommandEveImageArtifactBind(
      { conversationId: CONVO, handle: staged.handle, toolCallId: R2_TOOL_CALL_ID },
      deps
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.alreadyBound).toBe(false);
    expect(readImageArtifactRecordById(dataRoot, staged.record.id)?.status).toBe('active');
    const retry = await handleCommandEveImageArtifactBind(
      { conversationId: CONVO, handle: staged.handle, toolCallId: R2_TOOL_CALL_ID },
      deps
    );
    expect(retry.ok && 'alreadyBound' in retry && retry.alreadyBound).toBe(true);
  });

  it('a THROWING onFreshBind cannot reject the fail-quiet reconcile or alter its summary', async () => {
    const staged = stageOrphan();
    const rewritten = r2Message();
    rewritten.content = rewritten.content.split(R2_HANDLE).join(staged.handle);
    const summary = await reconcileConversationImageArtifactBinds(dataRoot, CONVO, {
      fetchTranscript: async () => [rewritten],
      bind: bindStagedImageArtifact,
      log: () => undefined,
      onFreshBind: () => {
        throw new Error('emitter exploded');
      },
    });
    expect(summary).toMatchObject({ bound: 1, refused: [] });
    expect(readImageArtifactRecordById(dataRoot, staged.record.id)?.status).toBe('active');
  });
});
