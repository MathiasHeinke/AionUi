import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handleCommandEveArtifactContextEnvelope } from '@/process/bridge/commandEveVideoBridge';
import {
  consumeVideoEditSpendPermit,
  evaluateStoredVideoEditSpendPermit,
  issueVideoEditSpendPermit,
  recordActiveUserTurn,
  reinitializeVideoEditSpendStore,
} from '@/process/commandEve/videoEditSpendPermitStore';
import type { CommandEveActiveImageArtifact } from '@/common/config/managedImageArtifactCore';

const VIDEO_SHA = 'a'.repeat(64);
const IMAGE_SHA = 'b'.repeat(64);
const TURN = 'gib der Aubergine ein Gesicht';
const TURN_SHA = crypto.createHash('sha256').update(TURN).digest('hex');

let dataRoot: string;

function managedImageRecord(): CommandEveActiveImageArtifact {
  return {
    id: 'img_generated1',
    conversation_id: 'conv-1',
    kind: 'image',
    status: 'active',
    payload: {
      artifact_type: 'image',
      title: 'Bild 1K',
      description: '1K · 16:9 · gemini',
      managed_image: true,
      mime_type: 'image/png',
      sha256: IMAGE_SHA,
      size: 1234,
      tier: 'quality',
      model: 'gemini',
      resolution: '1K',
      aspect_ratio: '16:9',
      prompt_sha256: 'c'.repeat(64),
    },
    created_at: 1_754_000_000_000,
    updated_at: 1_754_000_000_000,
  };
}

/** BOTH media kinds present and editable, through the real handler. */
function deps() {
  return {
    getDataPath: () => dataRoot,
    buildEntries: () => [
      {
        artifactId: 'video-1',
        kind: 'video' as const,
        mimeType: 'video/mp4',
        durationSeconds: 5,
        editable: true,
        editHandle: `evecap_${'d'.repeat(64)}`,
        artifactSha256: VIDEO_SHA,
      },
    ],
    recordActiveTurn: recordActiveUserTurn,
    isVideoEditEnabled: () => true,
    isImageEditEnabled: () => true,
    listManagedImageRecords: () => [managedImageRecord()],
    ensureImageEditHandle: () => `evecap_${'e'.repeat(64)}`,
  };
}

/** The operations of every live permit record in the real store. */
function livePermitOperations(): string[] {
  const dir = path.join(dataRoot, 'command-eve-artifact-capabilities', 'spend-permits');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.length === 69)
    .map((name) => {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { operation?: unknown };
      return String(record.operation);
    });
}

function permitFromEnvelope(envelope: string): string | undefined {
  return /evespend_[0-9a-f]{64}/.exec(envelope)?.[0];
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-permit-gate-'));
  reinitializeVideoEditSpendStore(dataRoot);
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('the requestedEditOperation gate (CoS fail-closed)', () => {
  it('(a) both media present + requestedEditOperation=image_edit => ONLY an image_edit permit is live for the turn', async () => {
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: TURN, requestedEditOperation: 'image_edit' },
      deps()
    );
    const permit = permitFromEnvelope(envelope);
    expect(permit).toBeTruthy();
    expect(livePermitOperations()).toEqual(['image_edit']);
    // The permit covers the IMAGE bytes, not the clip's.
    const evaluation = evaluateStoredVideoEditSpendPermit(dataRoot, {
      permit,
      conversationId: 'conv-1',
      observedArtifactSha256: IMAGE_SHA,
      operation: 'image_edit',
    });
    expect(evaluation.ok).toBe(true);
    expect(
      evaluateStoredVideoEditSpendPermit(dataRoot, {
        permit,
        conversationId: 'conv-1',
        observedArtifactSha256: VIDEO_SHA,
        operation: 'image_edit',
      })
    ).toMatchObject({ ok: false, reason: 'permit-artifact-not-covered' });
  });

  it('(b) both media present + requestedEditOperation=video_edit => ONLY a video_edit permit is live', async () => {
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: TURN, requestedEditOperation: 'video_edit' },
      deps()
    );
    expect(permitFromEnvelope(envelope)).toBeTruthy();
    expect(livePermitOperations()).toEqual(['video_edit']);
  });

  it('(c) absent or invalid requestedEditOperation => NO permit minted at all', async () => {
    for (const request of [
      { conversationId: 'conv-1', userTurnText: TURN },
      { conversationId: 'conv-1', userTurnText: TURN, requestedEditOperation: 'media_edit' },
      { conversationId: 'conv-1', userTurnText: TURN, requestedEditOperation: 7 },
    ]) {
      const { envelope } = await handleCommandEveArtifactContextEnvelope(
        request as { conversationId: string; userTurnText: string; requestedEditOperation?: string },
        deps()
      );
      expect(envelope).not.toContain('evespend_');
      expect(livePermitOperations()).toEqual([]);
    }
  });

  it('an image_edit request with no editable image mints nothing — no silent fallback to video', async () => {
    const { envelope } = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', userTurnText: TURN, requestedEditOperation: 'image_edit' },
      { ...deps(), listManagedImageRecords: () => [] }
    );
    expect(envelope).not.toContain('evespend_');
    expect(livePermitOperations()).toEqual([]);
  });
});

describe('operation binding is semantic, not nominal', () => {
  it('a video permit is REFUSED for an image edit and vice versa (operation-mismatch)', () => {
    recordActiveUserTurn(dataRoot, 'conv-1', TURN_SHA);
    const videoPermit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [VIDEO_SHA],
      operation: 'video_edit',
    })!;
    expect(
      evaluateStoredVideoEditSpendPermit(dataRoot, {
        permit: videoPermit,
        conversationId: 'conv-1',
        observedArtifactSha256: VIDEO_SHA,
        operation: 'image_edit',
      })
    ).toMatchObject({ ok: false, reason: 'permit-operation-mismatch' });

    const imagePermit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [IMAGE_SHA],
      operation: 'image_edit',
    })!;
    // Minting the image permit revoked the video one: ONE live permit per conversation.
    expect(livePermitOperations()).toEqual(['image_edit']);
    expect(
      evaluateStoredVideoEditSpendPermit(dataRoot, {
        permit: imagePermit,
        conversationId: 'conv-1',
        observedArtifactSha256: IMAGE_SHA,
        operation: 'video_edit',
      })
    ).toMatchObject({ ok: false, reason: 'permit-operation-mismatch' });
  });

  it('an image permit is consumed exactly once — the second spend is refused before any provider work', () => {
    recordActiveUserTurn(dataRoot, 'conv-1', TURN_SHA);
    const permit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [IMAGE_SHA],
      operation: 'image_edit',
    })!;
    const consume = () =>
      consumeVideoEditSpendPermit(dataRoot, {
        permit,
        conversationId: 'conv-1',
        userTurnSha256: TURN_SHA,
        instructionSha256: crypto.createHash('sha256').update('heller').digest('hex'),
        artifactSha256: IMAGE_SHA,
      });
    expect(consume()).toEqual({ ok: true });
    const second = consume();
    expect(second.ok).toBe(false);
  });
});
