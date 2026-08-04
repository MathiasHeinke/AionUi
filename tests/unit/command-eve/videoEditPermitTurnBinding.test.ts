/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 round 2 — the four things the independent CAO disproved.
 *
 * Round 1 SELF-REPORTED policies B, C, F and L as met. A read-only Codex CAO
 * showed all four were not, with file:line evidence. Every test in this file is
 * written to go RED against that round-1 code, so "met" is a property of the
 * suite rather than of a report:
 *
 *   POLICY B — the user-turn hash was STORED at mint and never compared at
 *   redeem. A field that is written and never read is not a binding. It is now
 *   re-compared against the conversation's CURRENT turn, and a permit whose turn
 *   has passed fails closed.
 *
 *   POLICY C — the mint path could be re-driven for the SAME user turn, so one
 *   request could buy several paid edits. The turn itself is now the unit of
 *   spend: it can be claimed exactly once, atomically, whatever permit presents
 *   it.
 *
 *   POLICY L — retry recovery ran BEFORE the conversation fence and matched only
 *   (instruction, artifact bytes), so a recovery in conversation B could return
 *   conversation A's clip AND its filesystem path. The fence now precedes
 *   recovery and recovery is conversation-scoped.
 *
 *   RAW HASH — the turn text was `.trim()`ed before hashing, so two different
 *   turns collapsed into one. It is hashed verbatim now, and emptiness is judged
 *   by a separate non-mutating predicate.
 *
 * The flag is enabled per-test through an injected dep and NEVER through
 * `process.env`: the spending flag stays default-off everywhere, test env
 * included.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readLicenseWireMock = vi.fn();
vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/eve-data' }));

import type {
  CommandEveArtifactContextEnvelopeDeps,
  CommandEveVideoBridgeDeps,
} from '@/process/bridge/commandEveVideoBridge';
import {
  handleCommandEveArtifactContextEnvelope,
  handleCommandEveVideoEdit,
} from '@/process/bridge/commandEveVideoBridge';
import {
  buildConversationArtifactEnvelopeEntries,
  ensureVideoEditCapabilityHandle,
} from '@/process/commandEve/artifactCapabilityHandleStore';
import {
  consumeVideoEditSpendPermit,
  issueVideoEditSpendPermit,
  readActiveUserTurn,
} from '@/process/commandEve/videoEditSpendPermitStore';
import { saveVideoArtifactRecord } from '@/process/commandEve/videoArtifactStore';
import { buildVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';

const SOURCE_BYTES = Buffer.from('the founders five second aubergine clip');
const SOURCE_SHA = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');

const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const editedBody = {
  ok: true,
  artifact: { mime_type: 'video/mp4', data_base64: 'QUJD', bytes: 3, sha256: 'e'.repeat(64) },
  video_edit: {
    model: 'grok-imagine-video',
    tier: 'sd',
    source_duration_seconds: 5,
    source_sha256: SOURCE_SHA,
    prompt_sha256: 'd'.repeat(64),
    estimated_credits: 1000,
  },
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let dataRoot: string;
let videoRoot: string;

function seedSource(conversationId: string, id: string) {
  const clipPath = path.join(videoRoot, `${id}.mp4`);
  fs.writeFileSync(clipPath, SOURCE_BYTES);
  const artifact = buildVideoConversationArtifact({
    id,
    conversationId,
    createdAtMs: 1_754_000_000_000,
    path: clipPath,
    artifact: {
      mimeType: 'video/mp4',
      sha256: SOURCE_SHA,
      bytes: SOURCE_BYTES.byteLength,
      durationSeconds: 5,
      resolution: '480p',
      estimatedCredits: 500,
      model: 'grok-imagine-video',
      dataBase64: '',
      tierId: 'sd',
    } as never,
  });
  saveVideoArtifactRecord(dataRoot, artifact);
  return artifact;
}

function envelopeDeps(
  overrides: Partial<CommandEveArtifactContextEnvelopeDeps> = {}
): CommandEveArtifactContextEnvelopeDeps {
  return {
    getDataPath: () => dataRoot,
    buildEntries: buildConversationArtifactEnvelopeEntries,
    isVideoEditEnabled: () => true,
    ...overrides,
  };
}

function editDeps(
  fetchImpl: typeof fetch,
  overrides: Partial<CommandEveVideoBridgeDeps> = {}
): CommandEveVideoBridgeDeps {
  return {
    getDataPath: () => dataRoot,
    fetch: fetchImpl,
    newRequestId: () => 'req-fixed',
    newArtifactId: () => 'video-edited',
    getActiveSeatId: () => 'seat-1',
    areFileSelectionPathsGranted: () => true,
    readImageSource: () => ({ bytes: new Uint8Array([1, 2, 3, 4]) }),
    saveVideoFile: (input) => {
      const savedPath = path.join(videoRoot, `${input.artifactId}.mp4`);
      fs.writeFileSync(savedPath, Buffer.from(input.dataBase64, 'base64'));
      return savedPath;
    },
    saveArtifactRecord: saveVideoArtifactRecord,
    isVideoEditEnabled: () => true,
    ...overrides,
  };
}

/** Pull the permit out of the envelope exactly as a model reading it would. */
function permitFromEnvelope(envelope: string): string | undefined {
  return /evespend_[0-9a-f]{64}/.exec(envelope)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-turn-binding-'));
  videoRoot = path.join(dataRoot, 'videos');
  fs.mkdirSync(videoRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

// SCOPED deliberately: this is the ORDINARY send path, which is the only path
// that mints. The correction path retires instead and binds the bytes delivered
// to the runtime — see the round-8 cases in `tests/unit/renderer/AcpSendBox.dom.test.tsx`.
describe('the raw ORDINARY user turn is hashed VERBATIM', () => {
  it('gives four whitespace variants of one sentence four different turn hashes', async () => {
    // The defect: `request.userTurnText.trim()` was hashed, so a turn with a
    // leading space, a turn with a trailing space and the bare turn were ONE
    // turn as far as every binding below was concerned.
    const base = 'gib der Aubergine ein Gesicht\nbitte';
    const variants = [base, ` ${base}`, `${base} `, base.split('\n').join('\r\n')];
    const seen: string[] = [];
    const deps = envelopeDeps({
      buildEntries: () => [
        {
          artifactId: 'video-1',
          kind: 'video',
          mimeType: 'video/mp4',
          durationSeconds: 5,
          editable: true,
          editHandle: `evecap_${'a'.repeat(64)}`,
          artifactSha256: SOURCE_SHA,
        },
      ],
      issuePermit: (_dataPath, input) => {
        seen.push(input.userTurnSha256);
        return `evespend_${'1'.repeat(64)}`;
      },
    });

    for (const variant of variants) {
      // oxlint-disable-next-line no-await-in-loop -- sequential on purpose: the ORDER of `seen` is asserted against `variants` below, and Promise.all would not preserve it
      await handleCommandEveArtifactContextEnvelope(
        { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: variant },
        deps
      );
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    // ...and each one is the digest of the EXACT bytes received, not of some
    // normalised form of them.
    expect(seen).toEqual(variants.map(sha256));
  });

  it('still mints nothing for a turn that is only whitespace', async () => {
    // The emptiness predicate must stay a predicate: it may judge the value, it
    // may not replace it.
    const seen: string[] = [];
    const deps = envelopeDeps({
      buildEntries: () => [
        {
          artifactId: 'video-1',
          kind: 'video',
          mimeType: 'video/mp4',
          durationSeconds: 5,
          editable: true,
          editHandle: `evecap_${'a'.repeat(64)}`,
          artifactSha256: SOURCE_SHA,
        },
      ],
      issuePermit: (_dataPath, input) => {
        seen.push(input.userTurnSha256);
        return `evespend_${'1'.repeat(64)}`;
      },
    });
    const result = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: ' \t\r\n ' },
      deps
    );
    expect(seen).toEqual([]);
    expect(result.envelope).not.toContain('evespend_');
  });

  it('refuses to redeem a permit against a whitespace variant of the turn that minted it', async () => {
    // POLICY B + the raw-hash defect in one shot: the bare turn mints, the
    // variant is a DIFFERENT turn, and the permit from the bare turn dies with
    // its own turn rather than surviving into the next one.
    const source = seedSource('conv-1', 'video-aubergine');
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const bare = 'gib der Aubergine ein Gesicht';

    const first = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: bare },
      envelopeDeps()
    );
    const permit = permitFromEnvelope(first.envelope)!;
    expect(permit).toBeTruthy();

    // The next real send carries the same words with a trailing space, and
    // happens to have nothing editable in view, so it mints no permit of its
    // own. It still MOVES THE TURN.
    await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: `${bare} ` },
      envelopeDeps({ buildEntries: () => [] })
    );
    expect(readActiveUserTurn(dataRoot, 'conv-1')?.user_turn_sha256).toBe(sha256(`${bare} `));

    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const result = await handleCommandEveVideoEdit({ handle, permit, instruction: bare }, editDeps(fetchImpl));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasonCode).toBe('video-edit-permit-turn-mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('nothing normalises the turn text between arrival and digest', () => {
  it('the mint path contains no trim, case fold, replace or Unicode normalisation', () => {
    // A STRUCTURAL companion to the behavioural tests above, because the
    // behavioural ones only catch the normalisations someone thought to try.
    // This catches the next one on the way in.
    const source = fs.readFileSync(
      path.join(__dirname, '../../../packages/desktop/src/process/bridge/commandEveVideoBridge.ts'),
      'utf8'
    );
    const body = /export async function handleCommandEveArtifactContextEnvelope\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    expect(body).toBeTruthy();
    // Comments first — prose ABOUT the old defect must not satisfy a probe
    // looking for it, a mistake this workstream has already made twice.
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[\t ]*\/\/.*$/gm, '');
    expect(code).toContain('createHash');
    for (const forbidden of ['.trim(', '.normalize(', '.replace(', '.toLowerCase(', '.toUpperCase(']) {
      expect(code, `the mint path must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // NEGATIVE CONTROL: the probe fires on the round-1 shape.
    const roundOne =
      "const userTurnText = typeof request?.userTurnText === 'string' ? request.userTurnText.trim() : '';";
    expect(roundOne).toContain('.trim(');
  });
});

describe('POLICY B — the stored user-turn hash is re-compared at redeem', () => {
  it('accepts the permit while its own turn is still the current turn — the positive control', async () => {
    const source = seedSource('conv-1', 'video-aubergine');
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: 'gib der Aubergine ein Gesicht' },
      envelopeDeps()
    );
    const permit = permitFromEnvelope(envelope)!;
    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const result = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'gib der Aubergine ein Gesicht' },
      editDeps(fetchImpl)
    );
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses a permit whose turn has passed, even though the permit itself is still live', async () => {
    // THE round-1 defect. The permit record survived (nothing revoked it,
    // because the next turn had nothing editable to mint against) and every
    // other check passed — so a stored-and-never-read `user_turn_sha256` bought
    // a paid edit for a request the user did not make.
    const source = seedSource('conv-1', 'video-aubergine');
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: 'gib der Aubergine ein Gesicht' },
      envelopeDeps()
    );
    const permit = permitFromEnvelope(envelope)!;

    await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: 'danke, das reicht' },
      envelopeDeps({ buildEntries: () => [] })
    );

    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const result = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'gib der Aubergine ein Gesicht' },
      editDeps(fetchImpl)
    );
    expect(result.ok === false && result.reasonCode).toBe('video-edit-permit-turn-mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('POLICY C — one distinct paid edit per explicit user turn', () => {
  it('mints NO second spendable permit when the mint path is re-driven for the same raw turn', async () => {
    // The round-1 defect: re-driving the envelope for the identical turn text
    // minted a fresh permit every time, so "one edit per turn" was a property of
    // the renderer calling once rather than of the server.
    const source = seedSource('conv-1', 'video-aubergine');
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const turn = 'gib der Aubergine ein Gesicht';

    const first = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: turn },
      envelopeDeps()
    );
    const permit = permitFromEnvelope(first.envelope)!;
    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const edit = await handleCommandEveVideoEdit(
      { handle, permit, instruction: turn },
      editDeps(fetchImpl, { newArtifactId: () => 'edit-1' })
    );
    expect(edit.ok).toBe(true);

    // Same conversation, same raw turn, mint path driven again.
    const second = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: turn },
      envelopeDeps()
    );
    expect(permitFromEnvelope(second.envelope)).toBeUndefined();
    expect(second.envelope).not.toContain('evespend_');
    // POSITIVE CONTROL: a genuinely different turn still gets its own permit, so
    // the rule above is about the turn and not about the feature having died.
    const third = await handleCommandEveArtifactContextEnvelope(
      {
        conversationId: 'conv-1',
        requestedEditOperation: 'video_edit',
        userTurnText: 'und jetzt mach den Hintergrund blau',
      },
      envelopeDeps()
    );
    expect(permitFromEnvelope(third.envelope)).toBeTruthy();
  });

  it('lets exactly ONE of two permits minted for the same turn be spent', async () => {
    // Belt to the mint guard's braces: even if two permits for one turn exist,
    // the TURN is the unit of spend and it can be claimed once.
    const turnSha = sha256('gib der Aubergine ein Gesicht');
    const first = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: turnSha,
      allowedArtifactSha256: [SOURCE_SHA],
    })!;
    const second = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: turnSha,
      allowedArtifactSha256: [SOURCE_SHA],
    })!;
    expect(first).not.toBe(second);

    const spentFirst = consumeVideoEditSpendPermit(dataRoot, {
      permit: first,
      conversationId: 'conv-1',
      userTurnSha256: turnSha,
      instructionSha256: sha256('gesicht'),
      artifactSha256: SOURCE_SHA,
    });
    const spentSecond = consumeVideoEditSpendPermit(dataRoot, {
      permit: second,
      conversationId: 'conv-1',
      userTurnSha256: turnSha,
      instructionSha256: sha256('hintergrund'),
      artifactSha256: SOURCE_SHA,
    });

    expect(spentFirst.ok).toBe(true);
    expect(spentSecond.ok === false && spentSecond.reason).toBe('permit-turn-consumed');
  });
});

describe('POLICY L — the conversation fence runs BEFORE retry recovery', () => {
  async function completeEditInConversationA() {
    const source = seedSource('conv-a', 'video-a');
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const turn = 'gib der Aubergine ein Gesicht';
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-a',
      userTurnSha256: sha256(turn),
      allowedArtifactSha256: [SOURCE_SHA],
    })!;
    const done = await handleCommandEveVideoEdit(
      { handle, permit, instruction: turn },
      editDeps((async () => jsonResponse(200, editedBody)) as unknown as typeof fetch, {
        newArtifactId: () => 'edit-in-a',
      })
    );
    expect(done.ok).toBe(true);
    return { permit, turn, editedPath: done.ok === true ? done.mediaDirective : '' };
  }

  it("refuses conversation B a recovery of conversation A's completed edit, and leaks no path", async () => {
    // The round-1 defect: recovery matched only (instruction sha, artifact sha),
    // then looked the artifact up in the COMPLETION's conversation. Two
    // conversations holding byte-identical clips were therefore enough to hand
    // conversation B both conversation A's clip and its `MEDIA: /Users/...` line.
    const { permit, turn, editedPath } = await completeEditInConversationA();

    const foreignSource = seedSource('conv-b', 'video-b');
    const foreignHandle = ensureVideoEditCapabilityHandle(dataRoot, foreignSource)!;
    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;

    const result = await handleCommandEveVideoEdit(
      { handle: foreignHandle, permit, instruction: turn },
      editDeps(fetchImpl)
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasonCode).toBe('video-edit-permit-conversation-mismatch');
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('MEDIA:');
    expect(serialised).not.toContain('edit-in-a');
    expect(serialised).not.toContain(editedPath.slice('MEDIA: '.length));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still refuses when the permit record itself is gone, so recovery cannot be the way in', async () => {
    // Recovery deliberately outlives the permit record (a slow edit whose permit
    // was retired by the next turn must still be recoverable). That is exactly
    // why recovery ALSO has to be conversation-scoped: with the record swept,
    // the fence above has nothing to compare.
    const { permit, turn } = await completeEditInConversationA();
    // A later turn in conversation A retires the permit record.
    issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-a',
      userTurnSha256: sha256('naechste Frage'),
      allowedArtifactSha256: [SOURCE_SHA],
    });

    const foreignSource = seedSource('conv-b', 'video-b');
    const foreignHandle = ensureVideoEditCapabilityHandle(dataRoot, foreignSource)!;
    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;

    const result = await handleCommandEveVideoEdit(
      { handle: foreignHandle, permit, instruction: turn },
      editDeps(fetchImpl)
    );

    expect(result.ok).toBe(false);
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('MEDIA:');
    expect(serialised).not.toContain('edit-in-a');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * WHY THIS ONE IS STRUCTURAL, and why that is not a cop-out.
   *
   * The ordering — fence, THEN recovery — is defence in depth. Recovery is now
   * conversation-scoped in its own right, so swapping the two back today changes
   * no observable behaviour: the receipt lookup refuses conversation B either
   * way. That is exactly what makes the ordering dangerous to leave unpinned. A
   * future edit that makes the receipt match on (instruction, bytes) again —
   * which is what round 1 did — reopens the leak, and with the order already
   * reverted there is nothing left in front of it. Every behavioural test above
   * would still be green.
   *
   * So the ordering is asserted where it lives. The probe's own ability to fail
   * is proved against a swapped fixture and against a deleted fence, because a
   * source-order check that has never been seen to fail is not a check.
   */
  describe('POLICY L ordering is pinned, not merely present', () => {
    const bridgeSource = fs.readFileSync(
      path.join(__dirname, '../../../packages/desktop/src/process/bridge/commandEveVideoBridge.ts'),
      'utf8'
    );

    const FENCE = 'readPermitRecord(dataPath, permit)';
    const RECOVERY = 'readCompletion(dataPath, permit, {';

    /** Positions of the two guards inside the paid handler, comments removed. */
    function guardPositions(source: string): { fence: number; recovery: number } {
      const body = /export async function handleCommandEveVideoEdit\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
      // Comments first: the handler's own JSDoc describes this ordering in
      // prose, and prose about a guard must never be able to satisfy a probe
      // looking for the guard.
      const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[\t ]*\/\/.*$/gm, '');
      return { fence: code.indexOf(FENCE), recovery: code.indexOf(RECOVERY) };
    }

    it('the probe fails on a SWAPPED order — the regression it exists to catch', () => {
      // A synthetic handler with the two blocks the other way round: the exact
      // round-1 shape, in which a recovery ran before anything fenced it.
      const swapped = [
        'export async function handleCommandEveVideoEdit(request, deps) {',
        `  const completion = ${RECOVERY} conversationId: grant.conversation_id });`,
        `  const permitRecord = ${FENCE};`,
        '}',
      ].join('\n');
      const { fence, recovery } = guardPositions(swapped);
      expect(recovery).toBeGreaterThanOrEqual(0);
      expect(fence).toBeGreaterThan(recovery);
    });

    it('the probe fails when the fence is DELETED outright', () => {
      const removed = [
        'export async function handleCommandEveVideoEdit(request, deps) {',
        `  const completion = ${RECOVERY} conversationId: grant.conversation_id });`,
        '}',
      ].join('\n');
      expect(guardPositions(removed).fence).toBe(-1);
    });

    it('the probe is not satisfied by the handler DOC that describes the ordering', () => {
      const proseOnly = [
        'export async function handleCommandEveVideoEdit(request, deps) {',
        `  // ${FENCE} runs before ${RECOVERY}`,
        `  const completion = ${RECOVERY} conversationId: grant.conversation_id });`,
        '}',
      ].join('\n');
      expect(guardPositions(proseOnly).fence).toBe(-1);
    });

    it('the real handler fences the permit conversation BEFORE it recovers anything', () => {
      const { fence, recovery } = guardPositions(bridgeSource);
      expect(fence).toBeGreaterThanOrEqual(0);
      expect(recovery).toBeGreaterThanOrEqual(0);
      expect(fence).toBeLessThan(recovery);
    });
  });

  it('POSITIVE CONTROL: the SAME conversation still recovers its own edit for free', async () => {
    // Without this, every assertion above could be satisfied by a recovery path
    // that simply stopped working.
    const source = seedSource('conv-a', 'video-a');
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const turn = 'gib der Aubergine ein Gesicht';
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-a',
      userTurnSha256: sha256(turn),
      allowedArtifactSha256: [SOURCE_SHA],
    })!;
    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const first = await handleCommandEveVideoEdit(
      { handle, permit, instruction: turn },
      editDeps(fetchImpl, { newArtifactId: () => 'edit-in-a' })
    );
    const retry = await handleCommandEveVideoEdit(
      { handle, permit, instruction: turn },
      editDeps(fetchImpl, { newArtifactId: () => 'edit-twice' })
    );
    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(retry.ok === true && retry.conversationArtifact.id).toBe('edit-in-a');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
