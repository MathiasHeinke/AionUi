/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — the edit path end to end on the desktop side.
 *
 * The claims worth testing here all cost money if they are wrong:
 *
 *   - the paid path is CLOSED on a kill-switched or ineligible seat, in the
 *     shared handler, so neither lane can be open while the other is shut;
 *   - a paid edit needs an EPHEMERAL SINGLE-USE PERMIT minted by a real user
 *     send, so a fourteen-day handle recovered from a transcript buys nothing;
 *   - one permit is one edit — the same permit with a different instruction
 *     fails closed, which is what makes a varied-instruction loop impossible;
 *   - a retry of the SAME edit returns the SAME clip rather than a second charge
 *     or a bare failure;
 *   - every refusal happens BEFORE the network, so a refusal is free;
 *   - the request body carries no nonce, so one approved edit bills once even
 *     when it arrives twice;
 *   - the result lands BESIDE the source, so a bad edit is never data loss.
 *
 * Each "cannot happen" below is paired with the positive case that proves the
 * probe would have fired.
 *
 * NOTE ON THE FLAG: it is enabled per-test through an injected dep and NEVER
 * through `process.env`. Since 1.820.2 the env var is only the kill-switch
 * (`'0'`) — eligibility comes from the licence wire, which this file mocks —
 * and a suite that set the env globally would still be the one place a stray
 * value could silently flip every assertion below.
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

import type { CommandEveVideoBridgeDeps } from '@/process/bridge/commandEveVideoBridge';
import {
  handleCommandEveArtifactContextEnvelope,
  handleCommandEveVideoEdit,
  handleCommandEveVideoEditBridge,
} from '@/process/bridge/commandEveVideoBridge';
import { ensureVideoEditCapabilityHandle } from '@/process/commandEve/artifactCapabilityHandleStore';
import { issueVideoEditSpendPermit } from '@/process/commandEve/videoEditSpendPermitStore';
import { listVideoArtifactRecords, saveVideoArtifactRecord } from '@/process/commandEve/videoArtifactStore';
import { buildVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';
import { COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG } from '@/process/commandEve/agentVideoEditFlag';
import {
  __resetActiveSeatForTests,
  hasCommandEvePaidArtifactOperationInFlight,
} from '@/process/commandEve/seatContextCore';

let dataRoot: string;
let videoRoot: string;
let sourcePath: string;

const SOURCE_BYTES = Buffer.from('the founders five second aubergine clip');
const SOURCE_SHA = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');
const ACTIVE_SEED_ID = 'a2000000-0000-4000-8000-000000000001';

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

function seedSource(overrides: { id?: string; durationSeconds?: number; resolution?: string } = {}) {
  const id = overrides.id ?? 'video-aubergine';
  sourcePath = path.join(videoRoot, `${id}.mp4`);
  fs.writeFileSync(sourcePath, SOURCE_BYTES);
  const artifact = buildVideoConversationArtifact({
    id,
    conversationId: 'conv-1',
    seatId: ACTIVE_SEED_ID,
    createdAtMs: 1_754_000_000_000,
    path: sourcePath,
    artifact: {
      mimeType: 'video/mp4',
      sha256: SOURCE_SHA,
      bytes: SOURCE_BYTES.byteLength,
      durationSeconds: overrides.durationSeconds ?? 5,
      resolution: overrides.resolution ?? '480p',
      estimatedCredits: 500,
      model: 'grok-imagine-video',
      dataBase64: '',
      tierId: overrides.resolution === '1080p' ? 'hd' : 'sd',
    } as never,
  });
  saveVideoArtifactRecord(dataRoot, artifact);
  return artifact;
}

/**
 * A permit exactly as a real user send would produce one: bound to the
 * conversation, to the hash of what the person typed, and to the bytes of the
 * clips they were shown.
 */
function permitForTurn(userTurnText: string, artifactSha256: string[] = [SOURCE_SHA]): string {
  const permit = issueVideoEditSpendPermit(dataRoot, {
    conversationId: 'conv-1',
    userTurnSha256: crypto.createHash('sha256').update(userTurnText).digest('hex'),
    allowedArtifactSha256: artifactSha256,
  });
  expect(permit).toBeTruthy();
  return permit as string;
}

function deps(fetchImpl: typeof fetch, overrides: Partial<CommandEveVideoBridgeDeps> = {}): CommandEveVideoBridgeDeps {
  return {
    getDataPath: () => dataRoot,
    fetch: fetchImpl,
    newRequestId: () => 'req-fixed',
    newArtifactId: () => 'video-edited',
    getActiveSeatId: () => ACTIVE_SEED_ID,
    areFileSelectionPathsGranted: () => true,
    readImageSource: () => ({ bytes: new Uint8Array([1, 2, 3, 4]) }),
    saveVideoFile: (input) => {
      const savedPath = path.join(videoRoot, `${input.artifactId}.mp4`);
      fs.writeFileSync(savedPath, Buffer.from(input.dataBase64, 'base64'));
      return savedPath;
    },
    saveArtifactRecord: saveVideoArtifactRecord,
    // The flag, injected — never set in the environment. See the file header.
    isVideoEditEnabled: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetActiveSeatForTests();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-video-edit-'));
  videoRoot = path.join(dataRoot, 'videos');
  fs.mkdirSync(videoRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('the paid path is closed unless the seat is eligible', () => {
  it('refuses in the SHARED handler, so the renderer IPC lane cannot be open while the loopback is shut', async () => {
    // THE regression this test exists for: the first build gated only the MCP
    // loopback, and `commandEveBridge` registered the identical paid handler for
    // the renderer with no gate at all. The gate now lives where both lanes meet.
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('gib der Aubergine ein Gesicht');
    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;

    const result = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'gib der Aubergine ein Gesicht' },
      deps(fetchImpl, { isVideoEditEnabled: () => false })
    );

    expect(result.ok === false && result.reasonCode).toBe('video-edit-disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads the flag from the environment by default, and the environment does not set it', () => {
    // The POSITIVE control for "the kill-switch is not accidentally engaged":
    // the flag name is not present in this process, so nothing in this suite is
    // running with the spending path implicitly closed (or a stray '1' making
    // the eligibility assertions ambiguous).
    expect(process.env[COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]).toBeUndefined();
  });
});

describe('an edit reaches the gateway from a handle AND a live permit', () => {
  it('sends the source, the inherited tier and the bearer — and persists the result beside the source', async () => {
    // THE POSITIVE CONTROL for every "no fetch" assertion below.
    const source = seedSource();
    const sourceManifestBefore = structuredClone(
      listVideoArtifactRecords(dataRoot, 'conv-1', ACTIVE_SEED_ID).find((record) => record.id === source.id)
    );
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('gib der Aubergine ein Gesicht');
    let sentAuth = '';
    let sentBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sentAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      sentBody = JSON.parse(String(init?.body));
      return jsonResponse(200, editedBody);
    }) as unknown as typeof fetch;

    const result = await handleCommandEveVideoEdit(
      // ACCEPTANCE 3: the caller names NO video keyword, no filename and no
      // artifact id — only the two credentials it read out of its own envelope.
      { handle, permit, instruction: 'gib der Aubergine ein Gesicht' },
      deps(fetchImpl, { getActiveSeatId: () => ACTIVE_SEED_ID })
    );

    expect(result.ok).toBe(true);
    expect(sentAuth).toBe('Bearer ceve-wire-token');
    expect(sentBody?.seat_id).toBe(ACTIVE_SEED_ID);
    expect(sentBody?.capability).toBe('video_edit');
    const edit = sentBody?.video_edit as Record<string, unknown>;
    // The tier is INHERITED from the source record, never chosen by the caller.
    expect(edit.tier).toBe('sd');
    expect(edit.source_sha256).toBe(SOURCE_SHA);
    expect(edit.source_duration_seconds).toBe(5);
    expect(edit.source_base64).toBe(SOURCE_BYTES.toString('base64'));
    // The permit is a LOCAL authority. It must never reach the gateway, or the
    // content-only ledger key would stop collapsing two arrivals into one debit.
    expect(JSON.stringify(sentBody)).not.toContain(permit);

    if (!result.ok) return;
    // ACCEPTANCE 5: beside the source, with the parent recorded.
    expect(result.conversationArtifact.payload.origin_capability).toBe('video_edit');
    expect(result.conversationArtifact.payload.parent_artifact_id).toBe('video-aubergine');
    expect(result.conversationArtifact.payload.hash).toBe(editedBody.artifact.sha256);
    expect(result.conversationArtifact.conversation_id).toBe(source.conversation_id);
    expect(result.conversationArtifact.id).not.toBe(source.id);
    expect(result.sourceArtifactId).toBe('video-aubergine');
    const recordsAfter = listVideoArtifactRecords(dataRoot, 'conv-1', ACTIVE_SEED_ID);
    expect(recordsAfter.find((record) => record.id === source.id)).toEqual(sourceManifestBefore);
    expect(recordsAfter.find((record) => record.id === result.conversationArtifact.id)).toEqual(
      result.conversationArtifact
    );
    // Both source bytes AND its durable manifest are untouched: a failed or
    // unwanted edit is never data loss, and provenance lives only on the child.
    expect(fs.readFileSync(sourcePath)).toEqual(SOURCE_BYTES);

    // A path, never a data: URL — the chat renderer resolves an https URL or a
    // file path and nothing else. This value stays on the Main -> renderer wire.
    expect(result.mediaDirective.startsWith('MEDIA: ')).toBe(true);
    expect(result.mediaDirective).not.toContain('data:');
    expect(result.mediaDirective.endsWith('.mp4')).toBe(true);
  });

  it('keeps an already-billed edit on its captured Seed while the paid-artifact fence is held', async () => {
    const originDataPath = dataRoot;
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(originDataPath, source)!;
    const permit = permitForTurn('mach den Clip wärmer');
    let activeSeatId = ACTIVE_SEED_ID;
    let activeSeatContextRevision = 7;
    let currentDataPath = originDataPath;
    let resolveFetch!: (response: Response) => void;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    ) as unknown as typeof fetch;
    const saveArtifactRecord = vi.fn();

    const pending = handleCommandEveVideoEdit(
      { handle, permit, instruction: 'mach den Clip wärmer' },
      deps(fetchImpl, {
        getDataPath: () => currentDataPath,
        getActiveSeatId: () => activeSeatId,
        getActiveSeatContextRevision: () => activeSeatContextRevision,
        saveArtifactRecord,
      })
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    expect(hasCommandEvePaidArtifactOperationInFlight()).toBe(true);

    // Main refuses a real switch while this fence is held. This direct state
    // mutation is the hostile defense-in-depth case: even then the billed clip
    // must stay under the origin Seed instead of being discarded or rehomed.
    activeSeatId = 'b2000000-0000-4000-8000-000000000001';
    activeSeatContextRevision += 1;
    currentDataPath = '/tmp/eve-data-seat-b';
    resolveFetch(jsonResponse(200, editedBody));

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(saveArtifactRecord).toHaveBeenCalledWith(originDataPath, expect.any(Object));
    expect(hasCommandEvePaidArtifactOperationInFlight()).toBe(false);
  });

  it('makes the edited clip appear in the NEXT context envelope', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const envelopeDeps = {
      getDataPath: () => dataRoot,
      getActiveSeatId: () => ACTIVE_SEED_ID,
      buildEntries: (await import('@/process/commandEve/artifactCapabilityHandleStore'))
        .buildConversationArtifactEnvelopeEntries,
      isVideoEditEnabled: () => true,
    };
    const before = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'zeig mir das Video' },
      envelopeDeps
    );
    expect(before.envelope).not.toContain('video-edited');

    await handleCommandEveVideoEdit(
      { handle, permit: permitForTurn('gib der Aubergine ein Gesicht'), instruction: 'gib der Aubergine ein Gesicht' },
      deps((async () => jsonResponse(200, editedBody)) as unknown as typeof fetch)
    );

    const after = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'und jetzt?' },
      envelopeDeps
    );
    expect(after.envelope).toContain('artifact_id=video-edited');
    expect(after.envelope).toContain('edited_from=video-aubergine');
  });

  it('wraps the outcome in the renderer IPC envelope', async () => {
    const response = await handleCommandEveVideoEditBridge(
      undefined,
      deps((async () => jsonResponse(200, editedBody)) as unknown as typeof fetch)
    );
    expect(response.success).toBe(true);
    expect(response.data.ok).toBe(false);
  });
});

describe('one user turn buys exactly one paid edit', () => {
  it('refuses a second edit on the same permit — the varied-instruction loop, closed', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('gib der Aubergine ein Gesicht');
    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;

    const first = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'gib der Aubergine ein Gesicht' },
      deps(fetchImpl, { newArtifactId: () => 'edit-1' })
    );
    expect(first.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Same permit, DIFFERENT instruction. This is the loop: one user request
    // turned into an unbounded series of paid variations.
    const second = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'und jetzt mach den Hintergrund blau' },
      deps(fetchImpl, { newArtifactId: () => 'edit-2' })
    );
    expect(second.ok === false && second.reasonCode).toBe('video-edit-permit-consumed');
    // THE assertion that matters: no second provider call, so no second charge.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      listVideoArtifactRecords(dataRoot, 'conv-1', ACTIVE_SEED_ID)
        .map((r) => r.id)
        .toSorted()
    ).toEqual(['edit-1', 'video-aubergine']);
  });

  it('answers a RETRY of the same edit from the receipt instead of charging again', async () => {
    // "Fail closed" must not mean "a dropped response costs the user their turn
    // AND their money". A repeat of the identical request returns the identical
    // clip.
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('gib der Aubergine ein Gesicht');
    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;

    const first = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'gib der Aubergine ein Gesicht' },
      deps(fetchImpl, { newArtifactId: () => 'edit-1' })
    );
    const retry = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'gib der Aubergine ein Gesicht' },
      deps(fetchImpl, { newArtifactId: () => 'edit-2' })
    );

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    expect(retry.ok === true && retry.replayed).toBe(true);
    expect(retry.ok === true && retry.conversationArtifact.id).toBe('edit-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Exactly one new artifact exists, not two.
    expect(listVideoArtifactRecords(dataRoot, 'conv-1', ACTIVE_SEED_ID)).toHaveLength(2);
  });

  it('refuses a permit minted for a previous turn once a new turn mints its own', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const stale = permitForTurn('erstes Anliegen');
    permitForTurn('zweites Anliegen');
    const { result, fetchImpl } = await refuseWith({ handle, permit: stale, instruction: 'mach es bunt' });
    expect(result.ok === false && result.reasonCode).toBe('video-edit-permit-unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses while another edit in the same conversation is still in flight', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('gib der Aubergine ein Gesicht');
    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const result = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'gib der Aubergine ein Gesicht' },
      deps(fetchImpl, { acquireInflightLock: () => false })
    );
    expect(result.ok === false && result.reasonCode).toBe('video-edit-already-in-flight');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('releases the conversation lock even when the gateway refuses', async () => {
    // NEGATIVE CONTROL for the lock: a refusal that left the lock held would
    // close the lane for the rest of the session, which is a denial of service
    // we inflicted on ourselves.
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const released: string[] = [];
    await handleCommandEveVideoEdit(
      { handle, permit: permitForTurn('erstes'), instruction: 'mach es bunt' },
      deps((async () => jsonResponse(402, { ok: false, reason: 'insufficient_credits' })) as unknown as typeof fetch, {
        releaseInflightLock: (_dataPath: string, conversationId: string) => {
          released.push(conversationId);
        },
      })
    );
    expect(released).toEqual(['conv-1']);
  });
});

async function refuseWith(
  request: Parameters<typeof handleCommandEveVideoEdit>[0],
  overrides: Partial<CommandEveVideoBridgeDeps> = {}
) {
  const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
  const result = await handleCommandEveVideoEdit(request, deps(fetchImpl, overrides));
  return { result, fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn> };
}

describe('every refusal happens before the network', () => {
  it('refuses an empty instruction', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const { result, fetchImpl } = await refuseWith({ handle, permit: permitForTurn('x'), instruction: '   ' });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a handle we never minted, instead of picking the newest clip', async () => {
    seedSource();
    const { result, fetchImpl } = await refuseWith({
      handle: `evecap_${'9'.repeat(64)}`,
      permit: permitForTurn('mach es bunt'),
      instruction: 'mach es bunt',
    });
    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'video-edit-handle-unknown',
      message: 'Dieser Videobezug ist unbekannt — es wurde nichts bearbeitet.',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a valid handle and permit from another seat-scoped data root', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('mach es bunt');
    const foreignSeatRoot = path.join(dataRoot, 'seat-b');
    fs.mkdirSync(foreignSeatRoot, { recursive: true });

    const { result, fetchImpl } = await refuseWith(
      { handle, permit, instruction: 'mach es bunt' },
      { getDataPath: () => foreignSeatRoot, getActiveSeatId: () => 'seat-b' }
    );

    expect(result.ok === false && result.reasonCode).toBe('video-edit-handle-unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses another Seat’s grant as unknown without consuming its permit', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('mach es bunt');
    const foreignFetch = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const foreignSeat = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'mach es bunt' },
      deps(foreignFetch, { getActiveSeatId: () => 'b2000000-0000-4000-8000-000000000001' })
    );

    expect(foreignSeat).toMatchObject({
      ok: false,
      reasonCode: 'video-edit-handle-unknown',
      message: 'Dieser Videobezug ist unbekannt — es wurde nichts bearbeitet.',
    });
    expect(foreignFetch).not.toHaveBeenCalled();

    const ownerFetch = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const ownerSeat = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'mach es bunt' },
      deps(ownerFetch, { getActiveSeatId: () => ACTIVE_SEED_ID })
    );
    expect(ownerSeat.ok).toBe(true);
    expect(ownerFetch).toHaveBeenCalledOnce();
  });

  it('refuses a bare artifact id used as if it were authority', async () => {
    const source = seedSource();
    ensureVideoEditCapabilityHandle(dataRoot, source);
    // The model knows the id — it is right there in the envelope. Knowing it
    // must buy nothing.
    const { result, fetchImpl } = await refuseWith({
      handle: 'video-aubergine',
      permit: permitForTurn('mach es bunt'),
      instruction: 'mach es bunt',
    });
    expect(result.ok === false && result.reasonCode).toBe('video-edit-handle-unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a VALID handle with NO permit — the old fourteen-day authority, revoked', async () => {
    // THE finding this whole slice exists for. Everything the first build
    // required is still true here: a real handle, a real clip, a real
    // instruction. It is no longer enough.
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const { result, fetchImpl } = await refuseWith({ handle, instruction: 'gib der Aubergine ein Gesicht' });
    expect(result.ok === false && result.reasonCode).toBe('video-edit-permit-missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an invented permit', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const { result, fetchImpl } = await refuseWith({
      handle,
      permit: `evespend_${'7'.repeat(64)}`,
      instruction: 'mach es bunt',
    });
    expect(result.ok === false && result.reasonCode).toBe('video-edit-permit-unknown');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a permit minted for a DIFFERENT conversation', async () => {
    // The conversation comparison is grant-record against permit-record: two
    // things we wrote, neither supplied by the caller.
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const foreign = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-elsewhere',
      userTurnSha256: crypto.createHash('sha256').update('anderswo').digest('hex'),
      allowedArtifactSha256: [SOURCE_SHA],
    })!;
    const { result, fetchImpl } = await refuseWith({ handle, permit: foreign, instruction: 'mach es bunt' });
    expect(result.ok === false && result.reasonCode).toBe('video-edit-permit-conversation-mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a permit that does not cover THIS clip', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const { result, fetchImpl } = await refuseWith({
      handle,
      permit: permitForTurn('mach es bunt', ['c'.repeat(64)]),
      instruction: 'mach es bunt',
    });
    expect(result.ok === false && result.reasonCode).toBe('video-edit-permit-artifact-not-covered');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an EXPIRED permit', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: crypto.createHash('sha256').update('vor einer Stunde').digest('hex'),
      allowedArtifactSha256: [SOURCE_SHA],
      nowMs: Date.now() - 60 * 60 * 1000,
    })!;
    const { result, fetchImpl } = await refuseWith({ handle, permit, instruction: 'mach es bunt' });
    expect(result.ok === false && result.reasonCode).toBe('video-edit-permit-expired');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a handle fenced to another conversation', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const { result, fetchImpl } = await refuseWith({
      handle,
      permit: permitForTurn('mach es bunt'),
      instruction: 'mach es bunt',
      conversationId: 'conv-elsewhere',
    });
    expect(result.ok === false && result.reasonCode).toBe('video-edit-conversation-mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when the bytes changed under the handle', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('mach es bunt');
    fs.writeFileSync(sourcePath, Buffer.from('a completely different clip'));
    const { result, fetchImpl } = await refuseWith({ handle, permit, instruction: 'mach es bunt' });
    expect(result.ok === false && result.reasonCode).toBe('video-edit-artifact-changed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when the source file is gone', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('mach es bunt');
    fs.rmSync(sourcePath);
    const { result, fetchImpl } = await refuseWith({ handle, permit, instruction: 'mach es bunt' });
    expect(result.ok === false && result.reasonCode).toBe('video-edit-source-unreadable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a source past the 8.7 second ceiling — a handle is never minted for one', async () => {
    const source = seedSource({ durationSeconds: 30 });
    expect(ensureVideoEditCapabilityHandle(dataRoot, source)).toBeUndefined();
  });

  it('refuses without an entitlement, before the gateway is asked', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('mach es bunt');
    readLicenseWireMock.mockReturnValue({ ok: false });
    const { result, fetchImpl } = await refuseWith({ handle, permit, instruction: 'mach es bunt' });
    expect(result.ok === false && result.reasonCode).toBe('entitlement-not-drawable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not consume the permit when the entitlement check refuses', async () => {
    // A refusal must be FREE in both senses: no charge, and no burned turn.
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const permit = permitForTurn('mach es bunt');
    readLicenseWireMock.mockReturnValue({ ok: false });
    await refuseWith({ handle, permit, instruction: 'mach es bunt' });

    readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
    const retry = await handleCommandEveVideoEdit(
      { handle, permit, instruction: 'mach es bunt' },
      deps((async () => jsonResponse(200, editedBody)) as unknown as typeof fetch)
    );
    expect(retry.ok).toBe(true);
  });
});

describe('one approved edit bills once', () => {
  it('produces a byte-identical body from two independent arrivals', async () => {
    // ACCEPTANCE 7. The gateway's ledger key is content-only, so the desktop must
    // not stamp anything that distinguishes HOW the request arrived. Two calls,
    // two different `newRequestId` implementations, one body — and, since a
    // permit is single-use, two different permits from two different turns.
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const bodies: string[] = [];
    const capture = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return jsonResponse(200, editedBody);
    }) as unknown as typeof fetch;

    await handleCommandEveVideoEdit(
      { handle, permit: permitForTurn('turn A'), instruction: 'gib der Aubergine ein Gesicht' },
      deps(capture, { newRequestId: () => 'from-the-cost-wall', newArtifactId: () => 'edit-a' })
    );
    await handleCommandEveVideoEdit(
      { handle, permit: permitForTurn('turn B'), instruction: 'gib der Aubergine ein Gesicht' },
      deps(capture, { newRequestId: () => 'from-a-hermes-tool-call', newArtifactId: () => 'edit-b' })
    );

    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    // NEGATIVE CONTROL: the two `newRequestId` values really are different, so
    // the equality above is about the body and not about identical inputs.
    expect('from-the-cost-wall').not.toBe('from-a-hermes-tool-call');
    expect(bodies[0]).not.toContain('from-the-cost-wall');
    expect(bodies[0]).not.toContain('from-a-hermes-tool-call');
    // And the permit — which DOES differ between the two — is nowhere in it.
    expect(bodies[0]).not.toContain('evespend_');

    // ...and a DIFFERENT instruction must produce a different body, otherwise
    // the second real edit would be refused as a replay of the first.
    await handleCommandEveVideoEdit(
      { handle, permit: permitForTurn('turn C'), instruction: 'mach den Hintergrund blau' },
      deps(capture, { newArtifactId: () => 'edit-c' })
    );
    expect(bodies[2]).not.toBe(bodies[0]);
  });

  it('carries no uuid-shaped request id', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    let sentBody: Record<string, unknown> | undefined;
    await handleCommandEveVideoEdit(
      { handle, permit: permitForTurn('x'), instruction: 'gib der Aubergine ein Gesicht' },
      deps((async (_url: unknown, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        return jsonResponse(200, editedBody);
      }) as unknown as typeof fetch)
    );
    expect(String(sentBody?.requestId)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(sentBody?.requestId)).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('a gateway refusal is reported honestly', () => {
  it('keeps the server reason instead of collapsing it', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const result = await handleCommandEveVideoEdit(
      { handle, permit: permitForTurn('mach es bunt'), instruction: 'mach es bunt' },
      deps((async () => jsonResponse(402, { ok: false, reason: 'insufficient_credits' })) as unknown as typeof fetch)
    );
    expect(result.ok === false && result.reasonCode).toBe('insufficient_credits');
    expect(result.ok === false && result.message).toContain('Credits');
    // Nothing was persisted for a refusal.
    expect(listVideoArtifactRecords(dataRoot, 'conv-1', ACTIVE_SEED_ID).map((r) => r.id)).toEqual(['video-aubergine']);
  });

  it('does not claim success for a 200 with no playable clip', async () => {
    const source = seedSource();
    const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
    const result = await handleCommandEveVideoEdit(
      { handle, permit: permitForTurn('mach es bunt'), instruction: 'mach es bunt' },
      deps((async () => jsonResponse(200, { ok: true, artifact: {}, video_edit: {} })) as unknown as typeof fetch)
    );
    expect(result.ok === false && result.reasonCode).toBe('video-artifact-malformed');
  });
});
