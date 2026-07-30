/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bridge-level tests: the desktop actually calls the gateway, sends the bearer,
 * and turns each distinct refusal into a distinct outcome.
 *
 * The assertions that matter most are the negative ones. A lane that reports
 * "failed" for out-of-credits, over-cap, replayed and impossible-resolution alike
 * is a lane that has thrown away everything the server worked to tell it.
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const readLicenseWireMock = vi.fn();
vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/eve-data' }));

import type { CommandEveVideoBridgeDeps } from '@/process/bridge/commandEveVideoBridge';
import {
  handleCommandEveVideoArtifactsList,
  handleCommandEveVideoGenerate,
} from '@/process/bridge/commandEveVideoBridge';

const deps = (
  fetchImpl: typeof fetch,
  overrides: Partial<CommandEveVideoBridgeDeps> = {}
): CommandEveVideoBridgeDeps => ({
  getDataPath: () => '/tmp/eve-data',
  fetch: fetchImpl,
  newRequestId: () => 'req-fixed',
  newArtifactId: () => 'artifact-fixed',
  getActiveSeatId: () => 'seat-1',
  areFileSelectionPathsGranted: () => true,
  readImageSource: () => ({ bytes: new Uint8Array([1, 2, 3, 4]) }),
  saveVideoFile: () => '/tmp/Downloads/Command EVE Videos/conv-1/artifact-fixed.mp4',
  saveArtifactRecord: () => {},
  ...overrides,
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const okBody = {
  ok: true,
  artifact: { mime_type: 'video/mp4', data_base64: 'AAAA', bytes: 3, sha256: 'c'.repeat(64) },
  video_generation: {
    model: 'grok-imagine-video',
    resolution: '720p',
    tier: 'fast',
    duration_seconds: 5,
    estimated_credits: 700,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
});

describe('handleCommandEveVideoGenerate', () => {
  it('sends the bearer and the tier, and returns the resolved artifact', async () => {
    let sentAuth = '';
    let sentBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      const request = init as { headers: Record<string, string>; body: string };
      sentAuth = request.headers.Authorization;
      sentBody = JSON.parse(request.body);
      return jsonResponse(200, okBody);
    });

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'ein Produktclip', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentAuth).toBe('Bearer ceve-wire-token');
    expect((sentBody.video_generation as Record<string, unknown>).tier).toBe('fast');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.resolution).toBe('720p');
    expect(result.artifact.estimatedCredits).toBe(700);
    expect(result.artifact.mimeType).toBe('video/mp4');
  });

  it('never calls the gateway without a licence wire', async () => {
    readLicenseWireMock.mockReturnValue({ ok: false, wire: null });
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('entitlement-not-drawable');
  });

  it.each([
    ['insufficient_credits', 402, false],
    ['spend_cap_exceeded', 402, false],
    ['video-tier-unavailable', 422, false],
    ['request-replayed', 409, false],
    ['video-daily-cap', 429, false],
    ['credit-gate-unavailable', 503, true],
  ])('keeps %s distinguishable end to end', async (reason, status, retryable) => {
    const fetchMock = vi.fn(async () => jsonResponse(status, { ok: false, reason, message: 'server said so' }));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe(reason);
    expect(result.retryable).toBe(retryable);
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('does not report success for a 200 with no playable video', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ...okBody, artifact: { mime_type: 'application/json', data_base64: 'AAAA' } })
    );

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('video-artifact-malformed');
  });

  it('turns an aborted request into a timeout, not a silent failure', async () => {
    const fetchMock = vi.fn(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('provider-timeout');
    expect(result.retryable).toBe(true);
  });

  it('survives a non-JSON body without claiming success', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>gateway down</html>', { status: 502 }));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(result.ok).toBe(false);
  });

  it('rejects an empty prompt before touching the network', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));

    const result = await handleCommandEveVideoGenerate(
      { prompt: '   ', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Image->video: the renderer sends a PATH, Main re-reads and re-hashes it
  // ---------------------------------------------------------------------

  it('refuses a 1080p (hd) request before touching the network when no image is attached', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'hd', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('video-tier-unavailable');
    expect(result.retryable).toBe(false);
  });

  it('re-reads the granted image path and sends the ACTUAL bytes and their SHA-256, never a renderer-supplied claim', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      sentBody = JSON.parse((init as { body: string }).body);
      return jsonResponse(200, okBody);
    });
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3]);
    const expectedSha256 = createHash('sha256').update(imageBytes).digest('hex');
    const readImageSourceMock = vi.fn(() => ({ bytes: imageBytes }));
    const grantedMock = vi.fn(() => true);

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'hd', durationSeconds: 5, imagePath: '/tmp/photo.png' },
      deps(fetchMock as unknown as typeof fetch, {
        readImageSource: readImageSourceMock,
        areFileSelectionPathsGranted: grantedMock,
      })
    );

    expect(readImageSourceMock).toHaveBeenCalledWith('/tmp/photo.png');
    expect(grantedMock).toHaveBeenCalledWith({
      filePaths: ['/tmp/photo.png'],
      seatId: 'seat-1',
      purpose: 'read',
    });
    const sentVideo = sentBody.video_generation as Record<string, unknown>;
    expect(sentVideo.image_base64).toBe(Buffer.from(imageBytes).toString('base64'));
    expect(sentVideo.image_sha256).toBe(expectedSha256);
    expect(result.ok).toBe(true);
  });

  it('refuses when the attached image path was not grant-verified, without reading it', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const readImageSourceMock = vi.fn(() => ({ bytes: new Uint8Array([1]) }));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5, imagePath: '/tmp/untrusted.png' },
      deps(fetchMock as unknown as typeof fetch, {
        areFileSelectionPathsGranted: () => false,
        readImageSource: readImageSourceMock,
      })
    );

    expect(readImageSourceMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('video-image-not-granted');
  });

  it('refuses honestly when a granted image cannot actually be read', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5, imagePath: '/tmp/photo.png' },
      deps(fetchMock as unknown as typeof fetch, {
        readImageSource: () => {
          throw new Error('not a valid image');
        },
      })
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('video-image-unreadable');
  });

  // ---------------------------------------------------------------------
  // Durable persistence: a success becomes a playable, path-based artifact
  // ---------------------------------------------------------------------

  it('saves a successful generation as a durable, path-based conversation artifact', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const savedPath = '/tmp/Downloads/Command EVE Videos/conv-1/artifact-fixed.mp4';
    const saveVideoFileMock = vi.fn(() => savedPath);
    const saveArtifactRecordMock = vi.fn();

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5, conversationId: 'conv-1' },
      deps(fetchMock as unknown as typeof fetch, {
        saveVideoFile: saveVideoFileMock,
        saveArtifactRecord: saveArtifactRecordMock,
      })
    );

    expect(saveVideoFileMock).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      artifactId: 'artifact-fixed',
      dataBase64: 'AAAA',
      mimeType: 'video/mp4',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conversationArtifact).toBeDefined();
    expect(result.conversationArtifact?.conversation_id).toBe('conv-1');
    expect(result.conversationArtifact?.kind).toBe('video');
    expect(result.conversationArtifact?.status).toBe('active');
    // A local file PATH — never a data: URL, which is exactly the ephemeral shape
    // this lane must not repeat.
    expect(result.conversationArtifact?.payload.path).toBe(savedPath);
    expect(saveArtifactRecordMock).toHaveBeenCalledWith('/tmp/eve-data', result.conversationArtifact);
  });

  it('skips persistence, never fakes it, when no conversationId is supplied', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const saveVideoFileMock = vi.fn(() => '/tmp/should-not-be-called.mp4');
    const saveArtifactRecordMock = vi.fn();

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch, {
        saveVideoFile: saveVideoFileMock,
        saveArtifactRecord: saveArtifactRecordMock,
      })
    );

    expect(saveVideoFileMock).not.toHaveBeenCalled();
    expect(saveArtifactRecordMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conversationArtifact).toBeUndefined();
  });

  it('reports a distinct failure — not a fake success and not a generic one — when the artifact cannot be saved', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5, conversationId: 'conv-1' },
      deps(fetchMock as unknown as typeof fetch, {
        saveVideoFile: () => {
          throw new Error('disk full');
        },
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasonCode).toBe('video-artifact-save-failed');
  });
});

describe('handleCommandEveVideoArtifactsList', () => {
  it('returns nothing for a missing conversation id', async () => {
    const listArtifactRecordsMock = vi.fn(() => [
      {
        id: 'a',
        conversation_id: 'conv-1',
        kind: 'video' as const,
        status: 'active' as const,
        payload: {
          artifact_type: 'video' as const,
          title: 'Video 720p',
          description: '',
          path: '/tmp/a.mp4',
          mime_type: 'video/mp4',
          hash: 'x'.repeat(64),
          size: 3,
        },
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const result = await handleCommandEveVideoArtifactsList(
      {},
      { getDataPath: () => '/tmp/eve-data', listArtifactRecords: listArtifactRecordsMock }
    );

    expect(result).toEqual([]);
    expect(listArtifactRecordsMock).not.toHaveBeenCalled();
  });

  it('returns this conversation local durable artifacts, and only its own', async () => {
    const listArtifactRecordsMock = vi.fn((_dataPath: string, conversationId: string) => [
      {
        id: 'a',
        conversation_id: conversationId,
        kind: 'video' as const,
        status: 'active' as const,
        payload: {
          artifact_type: 'video' as const,
          title: 'Video 720p',
          description: '',
          path: '/tmp/a.mp4',
          mime_type: 'video/mp4',
          hash: 'x'.repeat(64),
          size: 3,
        },
        created_at: 1,
        updated_at: 1,
      },
    ]);

    const result = await handleCommandEveVideoArtifactsList(
      { conversationId: 'conv-1' },
      { getDataPath: () => '/tmp/eve-data', listArtifactRecords: listArtifactRecordsMock }
    );

    expect(listArtifactRecordsMock).toHaveBeenCalledWith('/tmp/eve-data', 'conv-1');
    expect(result).toHaveLength(1);
    expect(result[0].conversation_id).toBe('conv-1');
  });
});
