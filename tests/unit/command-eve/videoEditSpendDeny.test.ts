/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 round 4 — A STEER WHOSE REVOCATION CANNOT BE STORED MUST STILL CLOSE
 * THE WALLET.
 *
 * The defect this file exists for: round 3 retired the spend permit from the
 * steer path and then SWALLOWED any failure of that retirement, writing the cost
 * down as "a permit that outlives one steer". Writing it down was honest; the
 * trade was not. It is fail-open on spend authority — local storage fails, and
 * the app silently keeps the ability to spend the user's credits against an
 * instruction the user has already superseded.
 *
 * The corrected shape, which every test below pins:
 *
 *   - the CORRECTION still goes through. A user fixing a running model is never
 *     refused because a local file operation failed;
 *   - the PAID EDIT AUTHORITY fails closed. The conversation enters an
 *     independently checked DENY state, and while it is denied a video edit
 *     reaches neither the provider fetch nor the debit;
 *   - deny clears ONLY on a later successful ordinary send that establishes
 *     fresh turn state and a new valid permit. Never on a timer, never by
 *     retrying the edit.
 *
 * The assertions are on the fetch spy and the debit spy DIRECTLY, never on a
 * returned status string: a refusal that still called the provider would satisfy
 * `ok === false` and cost money anyway.
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
  CommandEveArtifactTurnSteerDeps,
  CommandEveVideoBridgeDeps,
} from '@/process/bridge/commandEveVideoBridge';
import {
  handleCommandEveArtifactContextEnvelope,
  handleCommandEveArtifactTurnSteer,
  handleCommandEveVideoEdit,
} from '@/process/bridge/commandEveVideoBridge';
import {
  buildConversationArtifactEnvelopeEntries,
  ensureVideoEditCapabilityHandle,
} from '@/process/commandEve/artifactCapabilityHandleStore';
import {
  consumeVideoEditSpendPermit,
  denyVideoEditSpend,
  isVideoEditSpendDenied,
  pruneVideoEditSpendPermits,
  readVideoEditSpendDenyState,
} from '@/process/commandEve/videoEditSpendPermitStore';
import { saveVideoArtifactRecord } from '@/process/commandEve/videoArtifactStore';
import { buildVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';

const SOURCE_BYTES = Buffer.from('the founders five second aubergine clip');
const SOURCE_SHA = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');

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

/** The injected storage failure. Exactly what an unwritable permit store looks like. */
const brokenPermitStorage = () => {
  throw new Error('EROFS: read-only file system, unlink permit record');
};

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

function steerDeps(overrides: Partial<CommandEveArtifactTurnSteerDeps> = {}): CommandEveArtifactTurnSteerDeps {
  return { getDataPath: () => dataRoot, ...overrides };
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

/** The turn that mints, and the handle that names the clip it may act on. */
async function armedConversation(conversationId: string, turn: string) {
  const source = seedSource(conversationId, `video-${conversationId}`);
  const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
  const { envelope } = await handleCommandEveArtifactContextEnvelope(
    { conversationId, requestedEditOperation: 'video_edit', userTurnText: turn },
    envelopeDeps()
  );
  const permit = permitFromEnvelope(envelope)!;
  expect(permit).toBeTruthy();
  return { handle, permit };
}

/**
 * One edit attempt, with the two spies the requirement names.
 *
 * The DEBIT spy wraps the real atomic consume rather than replacing it, so a
 * green result still went through the same one-shot claim the production path
 * uses — a stub would let this file prove a lane safe that production is not.
 */
async function attemptEdit(input: { handle: string; permit: string; instruction: string }) {
  const fetchSpy = vi.fn(async () => jsonResponse(200, editedBody));
  const debitSpy = vi.fn((...args: Parameters<typeof consumeVideoEditSpendPermit>) =>
    consumeVideoEditSpendPermit(...args)
  );
  const result = await handleCommandEveVideoEdit(
    { handle: input.handle, permit: input.permit, instruction: input.instruction },
    editDeps(fetchSpy as unknown as typeof fetch, { consumeSpendPermit: debitSpy })
  );
  return { result, fetchSpy, debitSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-deny-'));
  videoRoot = path.join(dataRoot, 'videos');
  fs.mkdirSync(videoRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('MAT-1747 requirement 1 — the correction is never blocked by the permit store', () => {
  it('req1: an injected steer-revoke storage failure completes the steer handler and reports the conversation retired', async () => {
    // The UX half of the contract: the retire is awaited by the renderer BEFORE
    // it posts the correction, so a retire that threw all the way out would take
    // the user's correction down with it. It must resolve, and it must say what
    // it did.
    const { permit } = await armedConversation('conv-1', 'gib der Aubergine ein Gesicht');
    expect(permit).toBeTruthy();

    const result = await handleCommandEveArtifactTurnSteer(
      { conversationId: 'conv-1', steerText: 'warte, mach lieber den Hintergrund blau' },
      steerDeps({ revokeOnSteer: brokenPermitStorage as never })
    );

    // Resolved, not thrown — that is what lets `dispatchSteer` go on to post the
    // correction.
    expect(result).toBeTruthy();
    expect(result.revoked).toBe(0);
    // And it fails CLOSED: nothing was retired on disk, so the conversation is
    // denied instead of quietly keeping its spend authority.
    expect((result as { denied?: boolean }).denied).toBe(true);
  });
});

describe('MAT-1747 requirement 2 — a denied conversation reaches neither the provider nor the debit', () => {
  it('req2: after an injected steer-revoke storage failure the video edit performs ZERO provider fetch and ZERO debit', async () => {
    // The steer text is deliberately BYTE-IDENTICAL to the turn that minted, so
    // the turn-pointer defence cannot mask the result: with the revoke broken,
    // the only thing standing between the model and a charge is the deny state.
    const turn = 'gib der Aubergine ein Gesicht';
    const { handle, permit } = await armedConversation('conv-1', turn);

    await handleCommandEveArtifactTurnSteer(
      { conversationId: 'conv-1', steerText: turn },
      steerDeps({ revokeOnSteer: brokenPermitStorage as never })
    );

    const { result, fetchSpy, debitSpy } = await attemptEdit({ handle, permit, instruction: turn });

    // ON THE SPIES, not on the status string. A refusal that had already called
    // the provider would satisfy `ok === false` and still cost money.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(debitSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });
});

describe('MAT-1747 requirement 4 — only a successful ordinary send recovers the conversation', () => {
  it('req4: a retried edit never clears the deny, and only a later successful send mints a permit that can be spent', async () => {
    const turn = 'gib der Aubergine ein Gesicht';
    const { handle, permit } = await armedConversation('conv-1', turn);

    await handleCommandEveArtifactTurnSteer(
      { conversationId: 'conv-1', steerText: turn },
      steerDeps({ revokeOnSteer: brokenPermitStorage as never })
    );

    const first = await attemptEdit({ handle, permit, instruction: turn });
    expect(first.result.ok).toBe(false);
    expect(first.fetchSpy).not.toHaveBeenCalled();
    expect(first.debitSpy).not.toHaveBeenCalled();

    // RETRYING IS NOT RECOVERING. If a second attempt could clear the state, the
    // deny would be a speed bump rather than a gate.
    const second = await attemptEdit({ handle, permit, instruction: turn });
    expect(second.result.ok).toBe(false);
    expect(second.fetchSpy).not.toHaveBeenCalled();
    expect(second.debitSpy).not.toHaveBeenCalled();

    // THE recovery: an ordinary user send that establishes fresh turn state and
    // mints a new valid permit.
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: 'jetzt doch bitte das Gesicht' },
      envelopeDeps()
    );
    const fresh = permitFromEnvelope(envelope);
    expect(fresh).toBeTruthy();

    const recovered = await attemptEdit({
      handle,
      permit: fresh!,
      instruction: 'jetzt doch bitte das Gesicht',
    });
    expect(recovered.result.ok).toBe(true);
    expect(recovered.fetchSpy).toHaveBeenCalledTimes(1);
    expect(recovered.debitSpy).toHaveBeenCalledTimes(1);
  });

  it('req4: a deny is never lifted by the clock — pruning far into the future leaves it standing', async () => {
    // "Never on a timer" is a rule the sweep has to obey, not a sentence. Every
    // other artefact in this store is swept; the deny marker deliberately is
    // not, because expiry is exactly the implicit clearing the contract forbids.
    denyVideoEditSpend(dataRoot, 'conv-1', 1_000);
    expect(isVideoEditSpendDenied(dataRoot, 'conv-1')).toBe(true);

    pruneVideoEditSpendPermits(dataRoot, 1_000 + 400 * 24 * 60 * 60 * 1000);

    expect(readVideoEditSpendDenyState(dataRoot, 'conv-1').durable).toBe(true);
    expect(isVideoEditSpendDenied(dataRoot, 'conv-1')).toBe(true);
  });

  it('req4: the permit the steer retired stays dead even after the conversation recovers', async () => {
    // Recovery restores the CONVERSATION, not the superseded instruction. The
    // old permit must not become spendable again just because a new one exists.
    const turn = 'gib der Aubergine ein Gesicht';
    const { handle, permit } = await armedConversation('conv-1', turn);

    await handleCommandEveArtifactTurnSteer(
      { conversationId: 'conv-1', steerText: turn },
      steerDeps({ revokeOnSteer: brokenPermitStorage as never })
    );
    await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', requestedEditOperation: 'video_edit', userTurnText: 'jetzt doch bitte das Gesicht' },
      envelopeDeps()
    );

    const stale = await attemptEdit({ handle, permit, instruction: turn });
    expect(stale.result.ok).toBe(false);
    expect(stale.fetchSpy).not.toHaveBeenCalled();
    expect(stale.debitSpy).not.toHaveBeenCalled();
  });
});

describe('MAT-1747 requirement 3 — what a process-scoped deny does and does not survive', () => {
  it('req3: a DURABLE deny survives a fresh process, a PROCESS-SCOPED deny does not — the residual, asserted rather than reassured away', async () => {
    // HALF ONE — the ordinary case. The marker is on disk, so a new process
    // reads it back and the conversation is still denied.
    expect(denyVideoEditSpend(dataRoot, 'conv-durable')).toBe('durable');

    // HALF TWO — the case the fallback exists for: durable writing is EXACTLY
    // what failed. The deny directory is made unwritable, so the marker cannot
    // be written at all and the in-memory set is the only record left.
    const denyDir = path.join(dataRoot, 'command-eve-artifact-capabilities', 'spend-permits', 'deny');
    fs.chmodSync(denyDir, 0o500);
    let scope: string;
    try {
      scope = denyVideoEditSpend(dataRoot, 'conv-process');
    } finally {
      fs.chmodSync(denyDir, 0o700);
    }
    // If this is ever 'durable', the test has stopped exercising the fallback
    // (running as root, or a filesystem that ignores the mode) and must fail
    // rather than pass by accident.
    expect(scope).toBe('process');
    expect(readVideoEditSpendDenyState(dataRoot, 'conv-process')).toEqual({
      denied: true,
      durable: false,
      processScoped: true,
    });
    expect(isVideoEditSpendDenied(dataRoot, 'conv-process')).toBe(true);

    // THE RESTART. A fresh module registry is a fresh process as far as
    // module-level state is concerned: the Set that held the process-scoped deny
    // is gone with it.
    vi.resetModules();
    const restarted = await import('@/process/commandEve/videoEditSpendPermitStore');

    // Durable: still denied. That is what the marker is for.
    expect(restarted.isVideoEditSpendDenied(dataRoot, 'conv-durable')).toBe(true);
    // Process-scoped: NOT denied any more. This is a REAL residual and it is
    // pinned here on purpose. When the only thing that could have recorded the
    // deny was the disk, and the disk is what failed, a restart forgets it — and
    // an old permit inside its fifteen-minute window whose turn pointer also
    // survived would be spendable again. It belongs in `substrate_gaps`, not in
    // a reassuring sentence.
    expect(restarted.isVideoEditSpendDenied(dataRoot, 'conv-process')).toBe(false);
  });
});
