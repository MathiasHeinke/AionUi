/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1753 items C and F — the reference images ride the EXISTING envelope, and
 * they are bound by the EXISTING single-use spend permit.
 *
 * Two properties, and both are about not building a second surface:
 *
 *   C. the agent sees exactly the files the user attached to this message, in
 *      the order they attached them, so a follow-up ("the second reference") is
 *      answerable and nothing has to ask the user to pick again. No path is
 *      emitted, which is the envelope's own standing rule;
 *   F. the permit that covers them is THE permit — same store, same TTL, same
 *      turn binding, one per turn. There is no second spend authority and no
 *      popup.
 *
 * The store here is REAL (a temp dir, the production permit store). Only the
 * license wire and the data path are doubled, mirroring the sibling suites — a
 * permit proven against an injected store would prove nothing about the store
 * production uses.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: () => ({ ok: true, wire: 'ceve-wire-token' }),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/eve-data' }));

import type { CommandEveArtifactContextEnvelopeDeps } from '@/process/bridge/commandEveVideoBridge';
import { handleCommandEveArtifactContextEnvelope } from '@/process/bridge/commandEveVideoBridge';
import { readVideoEditSpendPermitRecord } from '@/process/commandEve/videoEditSpendPermitStore';

let dataRoot: string;
let imageRoot: string;

const REF_BYTES = (label: string) => Buffer.from(`reference-image-${label}`);
const sha256 = (value: Buffer | string) => crypto.createHash('sha256').update(value).digest('hex');

function seedImage(label: string): string {
  const filePath = path.join(imageRoot, `${label}.png`);
  fs.writeFileSync(filePath, REF_BYTES(label));
  return filePath;
}

function envelopeDeps(overrides: Partial<CommandEveArtifactContextEnvelopeDeps> = {}): CommandEveArtifactContextEnvelopeDeps {
  return {
    getDataPath: () => dataRoot,
    // No STORED artifacts at all, deliberately: everything asserted below must
    // come from the pending reference images, not from a clip that already exists.
    buildEntries: () => [],
    isVideoEditEnabled: () => true,
    getActiveSeatId: () => 'seat-1',
    areFileSelectionPathsGranted: () => true,
    readImageSource: (filePath: string) => ({ bytes: new Uint8Array(fs.readFileSync(filePath)) }),
    ...overrides,
  };
}

const permitFromEnvelope = (envelope: string) => /evespend_[0-9a-f]{64}/.exec(envelope)?.[0];

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-ref-envelope-'));
  imageRoot = path.join(dataRoot, 'images');
  fs.mkdirSync(imageRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('MAT-1753 C — reference images ride the EXISTING artifact envelope', () => {
  it('names every attached image, in order, with no second picker and no path', async () => {
    const paths = ['a', 'b', 'c'].map(seedImage);
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'mach daraus ein Video', referenceImagePaths: paths },
      envelopeDeps()
    );

    expect(envelope).toContain('artifact_id=reference_image_1');
    expect(envelope).toContain('artifact_id=reference_image_2');
    expect(envelope).toContain('artifact_id=reference_image_3');
    expect(envelope).toContain('kind=reference_image');
    // ORDER is the whole point of an ordinal id: "the second one" must resolve.
    expect(envelope.indexOf('reference_image_1')).toBeLessThan(envelope.indexOf('reference_image_2'));
    expect(envelope.indexOf('reference_image_2')).toBeLessThan(envelope.indexOf('reference_image_3'));
    // The model is told not to ask again — that IS "no second picker".
    expect(envelope).toContain('Do not ask the user to pick them again');
    // THE STANDING RULE: no filesystem path, ever, not even a basename.
    for (const filePath of paths) {
      expect(envelope).not.toContain(filePath);
      expect(envelope).not.toContain(path.basename(filePath));
    }
    expect(envelope).not.toContain(imageRoot);
  });

  it('never offers an edit handle for a pending input', async () => {
    const paths = ['a', 'b'].map(seedImage);
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'mach daraus ein Video', referenceImagePaths: paths },
      envelopeDeps()
    );
    // There is nothing produced to edit, so no handle is minted and none renders.
    expect(envelope).toContain('editable=false');
    expect(envelope).not.toContain('edit_handle=');
  });

  it('emits NOTHING rather than a short list when the ceiling is exceeded', async () => {
    const paths = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(seedImage);
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'mach daraus ein Video', referenceImagePaths: paths },
      envelopeDeps()
    );
    // A list of seven would tell the model the user attached fewer images than
    // they did — worse than telling it nothing.
    expect(envelope).toBe('');
  });

  it('emits nothing when the paths were not grant-verified', async () => {
    const paths = ['a', 'b'].map(seedImage);
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'mach daraus ein Video', referenceImagePaths: paths },
      envelopeDeps({ areFileSelectionPathsGranted: () => false })
    );
    expect(envelope).toBe('');
  });

  it('grant-verifies the whole set in ONE call, naming every path', async () => {
    const paths = ['a', 'b', 'c'].map(seedImage);
    const granted = vi.fn(() => true);
    await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'mach daraus ein Video', referenceImagePaths: paths },
      envelopeDeps({ areFileSelectionPathsGranted: granted })
    );
    expect(granted).toHaveBeenCalledTimes(1);
    expect(granted).toHaveBeenCalledWith({ filePaths: paths, seatId: 'seat-1', purpose: 'read' });
  });
});

describe('MAT-1753 F — one permit, the existing one, bound to the reference BYTES', () => {
  // THE EXISTING RULE, unchanged and deliberately not relaxed: a permit is
  // emitted only alongside a capability that could redeem it. Reference images
  // alone advertise NO capability — there is no agent-facing reference-render
  // tool — so a permit minted for them would be a live spending credential in a
  // transcript with nothing able to spend it, which the envelope forbids in so
  // many words. What reference work rides is THE turn's permit when one exists,
  // never a permit of its own.
  it('mints NO permit when reference images are the only thing on the turn', async () => {
    const paths = ['a', 'b'].map(seedImage);
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'mach daraus ein Video', referenceImagePaths: paths },
      envelopeDeps()
    );
    expect(envelope).toContain('kind=reference_image');
    expect(permitFromEnvelope(envelope)).toBeUndefined();
  });

  it('binds the SAME single permit to the reference bytes AND the editable clip', async () => {
    const paths = ['a', 'b'].map(seedImage);
    const turn = 'mach daraus ein Video';
    const clipSha = 'c'.repeat(64);
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: turn, referenceImagePaths: paths },
      envelopeDeps({
        buildEntries: () => [
          {
            artifactId: 'video-1',
            kind: 'video',
            mimeType: 'video/mp4',
            durationSeconds: 5,
            editable: true,
            editHandle: `evecap_${'a'.repeat(64)}`,
            artifactSha256: clipSha,
          },
        ],
      })
    );

    const permit = permitFromEnvelope(envelope);
    expect(permit).toBeDefined();
    // ONE permit for the whole turn — no second credential, no second popup.
    expect(envelope.match(/evespend_/g)).toHaveLength(1);

    // Read the stored record through the PRODUCTION store, not a double.
    const record = readVideoEditSpendPermitRecord(dataRoot, permit!);
    expect(record).toBeDefined();
    // Byte-bound to the reference images AND the clip, turn-bound to the raw turn.
    expect(record?.allowed_artifact_sha256).toEqual([sha256(REF_BYTES('a')), sha256(REF_BYTES('b')), clipSha]);
    expect(record?.user_turn_sha256).toBe(sha256(turn));
    // Same operation, same store, same TTL — not a new spend authority.
    expect(record?.operation).toBe('video_edit');
    expect(record!.expires_at_ms).toBeGreaterThan(record!.issued_at_ms);
  });

  it('mints no permit at all when the paid path is disabled', async () => {
    const paths = ['a'].map(seedImage);
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: 'mach daraus ein Video', referenceImagePaths: paths },
      envelopeDeps({ isVideoEditEnabled: () => false })
    );
    // The entries still ride along; the spending credential does not.
    expect(envelope).toContain('kind=reference_image');
    expect(permitFromEnvelope(envelope)).toBeUndefined();
  });

  it('mints no permit for a turn with no text, however many images are attached', async () => {
    const paths = ['a', 'b'].map(seedImage);
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: '   ', referenceImagePaths: paths },
      envelopeDeps()
    );
    expect(permitFromEnvelope(envelope)).toBeUndefined();
  });
});
