/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 round 3 — A USER STEER IS A REAL TURN.
 *
 * The hole an independent audit found in round 2: policy B was written as "one
 * paid edit per explicit user turn", but the only thing that moved the turn
 * pointer was the send path that builds a context envelope. A STEER — the
 * correction a user types while the model is still working — goes straight to
 * the runtime over HTTP (`/api/conversations/<id>/steer`). It is real text, the
 * agent reads it, and it moved nothing. So the previous turn's permit survived
 * it, and the claim was broader than the enforcement.
 *
 * Every test below is written to go RED against that shape: with
 * `revokeVideoEditSpendOnUserSteer` reduced to `return 0`, the first case here
 * spends real money and the assertions fail on `ok === true` and on a `fetch`
 * that was called once.
 *
 * The positive control is not decoration. Without it, "the edit is refused after
 * a steer" would also be satisfied by an edit path that had simply stopped
 * working.
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
  readActiveUserTurn,
  readVideoEditSpendPermitRecord,
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

function steerDeps(overrides: Partial<CommandEveArtifactTurnSteerDeps> = {}): CommandEveArtifactTurnSteerDeps {
  return { getDataPath: () => dataRoot, ...overrides };
}

function editDeps(fetchImpl: typeof fetch, overrides: Partial<CommandEveVideoBridgeDeps> = {}): CommandEveVideoBridgeDeps {
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
    { conversationId, userTurnText: turn },
    envelopeDeps()
  );
  const permit = permitFromEnvelope(envelope)!;
  expect(permit).toBeTruthy();
  return { handle, permit };
}

beforeEach(() => {
  vi.clearAllMocks();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-steer-'));
  videoRoot = path.join(dataRoot, 'videos');
  fs.mkdirSync(videoRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('POLICY B — a STEER retires the live spend permit', () => {
  it('refuses the paid edit after the user has steered, and spends nothing', async () => {
    // THE round-2 hole. The user asks for an edit, the model is still thinking,
    // the user corrects them — and the permit from the first turn was still
    // spendable because a steer touched nothing.
    const turn = 'gib der Aubergine ein Gesicht';
    const { handle, permit } = await armedConversation('conv-1', turn);

    await handleCommandEveArtifactTurnSteer(
      { conversationId: 'conv-1', steerText: 'warte, mach lieber den Hintergrund blau' },
      steerDeps()
    );

    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const result = await handleCommandEveVideoEdit({ handle, permit, instruction: turn }, editDeps(fetchImpl));

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: without the steer the identical edit succeeds and is charged once', async () => {
    // Without this, the refusal above would also be satisfied by an edit path
    // that had simply stopped working for every input.
    const turn = 'gib der Aubergine ein Gesicht';
    const { handle, permit } = await armedConversation('conv-1', turn);

    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const result = await handleCommandEveVideoEdit({ handle, permit, instruction: turn }, editDeps(fetchImpl));

    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses the correction the user actually typed, too — a steer buys nothing', async () => {
    // The subtle reading someone will reach for: "but the user DID ask for the
    // blue background, so let the permit cover it." No. A steer carries no
    // envelope, so a permit minted for it could be shown to nobody; the honest
    // shape is that spend authority ends at the steer and returns on the next
    // ordinary send.
    const { handle, permit } = await armedConversation('conv-1', 'gib der Aubergine ein Gesicht');
    const correction = 'mach den Hintergrund blau';

    await handleCommandEveArtifactTurnSteer({ conversationId: 'conv-1', steerText: correction }, steerDeps());

    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const result = await handleCommandEveVideoEdit({ handle, permit, instruction: correction }, editDeps(fetchImpl));

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the two defences a steer raises are independent', () => {
  it('deletes the live permit record', async () => {
    const { permit } = await armedConversation('conv-1', 'gib der Aubergine ein Gesicht');
    expect(readVideoEditSpendPermitRecord(dataRoot, permit)).toBeTruthy();

    await handleCommandEveArtifactTurnSteer({ conversationId: 'conv-1', steerText: 'anders bitte' }, steerDeps());

    expect(readVideoEditSpendPermitRecord(dataRoot, permit)).toBeUndefined();
  });

  it('moves the turn pointer to the steer bytes AS DELIVERED, hashed verbatim', async () => {
    await armedConversation('conv-1', 'gib der Aubergine ein Gesicht');
    const correction = ' Mach  den Hintergrund BLAU\r\n';

    await handleCommandEveArtifactTurnSteer({ conversationId: 'conv-1', steerText: correction }, steerDeps());

    // Verbatim: no trim, no case fold, no line-ending normalisation between the
    // IPC boundary and the digest, exactly as on the mint path.
    expect(readActiveUserTurn(dataRoot, 'conv-1')?.user_turn_sha256).toBe(sha256(correction));
  });

  it('still revokes when the steer text is byte-identical to the turn that minted', async () => {
    // The case the pointer alone cannot catch: an identical steer leaves the
    // pointer where it was, so the revoke has to be the thing that closes it.
    const turn = 'gib der Aubergine ein Gesicht';
    const { handle, permit } = await armedConversation('conv-1', turn);

    await handleCommandEveArtifactTurnSteer({ conversationId: 'conv-1', steerText: turn }, steerDeps());
    expect(readActiveUserTurn(dataRoot, 'conv-1')?.user_turn_sha256).toBe(sha256(turn));

    const fetchImpl = vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch;
    const result = await handleCommandEveVideoEdit({ handle, permit, instruction: turn }, editDeps(fetchImpl));
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('a steer is scoped and grants nothing', () => {
  it('leaves another conversation\'s permit alone', async () => {
    const { permit } = await armedConversation('conv-1', 'gib der Aubergine ein Gesicht');
    await handleCommandEveArtifactTurnSteer({ conversationId: 'conv-2', steerText: 'etwas anderes' }, steerDeps());
    expect(readVideoEditSpendPermitRecord(dataRoot, permit)).toBeTruthy();
  });

  it('mints no permit of its own, whatever it is handed', async () => {
    // A steer must never become a way to obtain spend authority. The envelope
    // path is the only minter, and a steer does not build an envelope.
    const before = await handleCommandEveArtifactTurnSteer(
      { conversationId: 'conv-1', steerText: 'gib mir bitte eine Freigabe' },
      steerDeps()
    );
    expect(before.revoked).toBe(0);
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1' },
      envelopeDeps({ buildEntries: () => [] })
    );
    expect(envelope).not.toContain('evespend_');
  });

  it('writes nothing at all on a seat that has never minted a permit', async () => {
    // The paid path is default-off, so the overwhelming majority of seats never
    // create this store. A steer must not be the thing that creates it.
    const listing = () => {
      try {
        return fs.readdirSync(path.join(dataRoot, 'command-eve-artifact-capabilities'));
      } catch {
        return [];
      }
    };
    expect(listing()).toEqual([]);
    const result = await handleCommandEveArtifactTurnSteer(
      { conversationId: 'conv-1', steerText: 'irgendeine Korrektur' },
      steerDeps()
    );
    expect(result.revoked).toBe(0);
    expect(listing()).toEqual([]);
  });

  it('ignores a request with no conversation', async () => {
    expect((await handleCommandEveArtifactTurnSteer(undefined, steerDeps())).revoked).toBe(0);
    expect((await handleCommandEveArtifactTurnSteer({ steerText: 'x' }, steerDeps())).revoked).toBe(0);
  });
});
