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
const ACTIVE_SEED_ID = 'a2000000-0000-4000-8000-000000000001';
vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/eve-data' }));

import type { CommandEveVideoBridgeDeps } from '@/process/bridge/commandEveVideoBridge';
import {
  handleCommandEveVideoArtifactsList,
  handleCommandEveVideoArtifactsListBridge,
  handleCommandEveVideoGenerate,
  handleCommandEveVideoGenerateBridge,
} from '@/process/bridge/commandEveVideoBridge';
import { hasCommandEvePaidArtifactOperationInFlight } from '@/process/commandEve/seatContextCore';

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
  // MAT-1753. A seat with grok-imagine-video-1.5 proven, so the tests below
  // exercise the ENTITLED path; the unentitled refusal has its own test. Injected
  // rather than left to the default so the production default (both flags OFF)
  // stays fail-closed and is not quietly relaxed by the suite.
  getVideoSeatCapabilities: () => ({ hd15Available: true, presetVoicesAvailable: true }),
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
  it('wraps raw outcomes in the renderer IPC response envelope', async () => {
    const response = await handleCommandEveVideoGenerateBridge();

    expect(response.success).toBe(true);
    expect(response.data.ok).toBe(false);
    if (response.data.ok) return;
    expect(response.data.reasonCode).toBe('video-request-invalid');
  });

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
      deps(fetchMock as unknown as typeof fetch, { getActiveSeatId: () => ACTIVE_SEED_ID })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentAuth).toBe('Bearer ceve-wire-token');
    expect(sentBody.seat_id).toBe(ACTIVE_SEED_ID);
    expect((sentBody.video_generation as Record<string, unknown>).tier).toBe('fast');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.resolution).toBe('720p');
    expect(result.artifact.estimatedCredits).toBe(700);
    expect(result.artifact.mimeType).toBe('video/mp4');
  });

  it('refuses an A-to-B Seed switch while the catalog await is pending before POST', async () => {
    let activeSeatId = ACTIVE_SEED_ID;
    let activeSeatContextRevision = 11;
    let resolveCatalog!: (value: null) => void;
    const getVideoCatalogWire = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveCatalog = resolve;
        })
    );
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const saveVideoFile = vi.fn(() => '/tmp/never-written.mp4');
    const saveArtifactRecord = vi.fn();

    const pending = handleCommandEveVideoGenerate(
      { prompt: 'ein Produktclip', tierId: 'fast', durationSeconds: 5, conversationId: 'conv-race' },
      deps(fetchMock as unknown as typeof fetch, {
        getActiveSeatId: () => activeSeatId,
        getActiveSeatContextRevision: () => activeSeatContextRevision,
        getVideoCatalogWire,
        saveVideoFile,
        saveArtifactRecord,
      })
    );
    await vi.waitFor(() => expect(getVideoCatalogWire).toHaveBeenCalledOnce());
    activeSeatId = 'b2000000-0000-4000-8000-000000000001';
    activeSeatContextRevision += 1;
    resolveCatalog(null);

    await expect(pending).resolves.toMatchObject({ ok: false, reasonCode: 'video-seat-changed' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveVideoFile).not.toHaveBeenCalled();
    expect(saveArtifactRecord).not.toHaveBeenCalled();
  });

  it('keeps a billed response and stores its record under the captured origin while the paid fence is held', async () => {
    let activeSeatId = ACTIVE_SEED_ID;
    let activeSeatContextRevision = 21;
    let dataPath = '/tmp/eve-data-seat-a';
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const saveArtifactRecord = vi.fn();

    const pending = handleCommandEveVideoGenerate(
      { prompt: 'ein Produktclip', tierId: 'fast', durationSeconds: 5, conversationId: 'conv-origin' },
      deps(fetchMock as unknown as typeof fetch, {
        getDataPath: () => dataPath,
        getActiveSeatId: () => activeSeatId,
        getActiveSeatContextRevision: () => activeSeatContextRevision,
        saveArtifactRecord,
      })
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(hasCommandEvePaidArtifactOperationInFlight()).toBe(true);

    // A real switch is refused by Main. This direct mutation is the hostile
    // defense-in-depth case: it still must not discard the paid result or rehome it.
    activeSeatId = 'b2000000-0000-4000-8000-000000000001';
    activeSeatContextRevision += 1;
    dataPath = '/tmp/eve-data-seat-b';
    resolveFetch(jsonResponse(200, okBody));

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(saveArtifactRecord).toHaveBeenCalledWith('/tmp/eve-data-seat-a', expect.any(Object));
    expect(hasCommandEvePaidArtifactOperationInFlight()).toBe(false);
  });

  it('reports Seat recovery as non-retryable before calling the paid gateway', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'ein Produktclip', tierId: 'fast', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch, {
        getPaidArtifactBlockReason: () => 'seat_recovery_required',
      })
    );

    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'video-seat-recovery-required',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
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

  // INVERTED, MAT-1753. This assertion used to read "refuses a 1080p (hd) request
  // before touching the network when no image is attached", which was the bridge
  // half of the false "1.5 is image-to-video only" belief. A bare prompt at 1080p
  // now reaches the gateway on an entitled seat; the case that is STILL refused —
  // 1080p without 1.5 proven — has its own assertion below.
  it('lets a 1080p (hd) TEXT request through to the gateway on an entitled seat', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'hd', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
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

  it('resolves a pathless managed image in Main, verifies its bytes, and preserves immutable parentage', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      sentBody = JSON.parse((init as { body: string }).body);
      return jsonResponse(200, okBody);
    });
    const imageBytes = Buffer.from([9, 8, 7, 6]);
    const sha256 = createHash('sha256').update(imageBytes).digest('hex');
    const readManagedImageRecord = vi.fn(() => ({
      id: 'img-source',
      seat_id: 'seat-1',
      conversation_id: 'conv-1',
      kind: 'image' as const,
      status: 'active' as const,
      payload: {
        artifact_type: 'image' as const,
        title: 'Produktbild',
        description: '1K · 16:9',
        managed_image: true as const,
        mime_type: 'image/png',
        sha256,
        size: imageBytes.byteLength,
        tier: 'quality',
        model: 'gemini',
        resolution: '1K',
        aspect_ratio: '16:9',
        prompt_sha256: 'a'.repeat(64),
      },
      created_at: 1,
      updated_at: 1,
    }));
    const readManagedImageBytes = vi.fn(() => imageBytes);
    const readImageSourceMock = vi.fn(() => ({ bytes: new Uint8Array([1]) }));

    const result = await handleCommandEveVideoGenerate(
      {
        prompt: 'sanfte Kamerafahrt',
        tierId: 'fast',
        durationSeconds: 5,
        conversationId: 'conv-1',
        imageArtifactId: 'img-source',
      },
      deps(fetchMock as unknown as typeof fetch, {
        readManagedImageRecord,
        readManagedImageBytes,
        readImageSource: readImageSourceMock,
      })
    );

    expect(readManagedImageRecord).toHaveBeenCalledWith('/tmp/eve-data', 'img-source', 'seat-1');
    expect(readManagedImageBytes).toHaveBeenCalledWith('/tmp/eve-data', 'img-source', 'seat-1');
    expect(readImageSourceMock).not.toHaveBeenCalled();
    const sentVideo = sentBody.video_generation as Record<string, unknown>;
    expect(sentVideo.mode).toBe('image');
    expect(sentVideo.image_base64).toBe(imageBytes.toString('base64'));
    expect(sentVideo.image_sha256).toBe(sha256);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conversationArtifact?.payload.parent_artifact_id).toBe('img-source');
  });

  it.each([
    {
      name: 'has no active conversation',
      request: { imageArtifactId: 'img-source' },
      recordConversationId: 'conv-1',
      storedSha256: 'b'.repeat(64),
      reasonCode: 'video-image-artifact-conversation-required',
    },
    {
      name: 'belongs to another conversation',
      request: { conversationId: 'conv-1', imageArtifactId: 'img-source' },
      recordConversationId: 'conv-other',
      storedSha256: 'b'.repeat(64),
      reasonCode: 'video-image-artifact-unavailable',
    },
    {
      name: 'changed after its manifest was written',
      request: { conversationId: 'conv-1', imageArtifactId: 'img-source' },
      recordConversationId: 'conv-1',
      storedSha256: '0'.repeat(64),
      reasonCode: 'video-image-artifact-unavailable',
    },
  ])('refuses a managed image that $name before credentials or network', async (scenario) => {
    const imageBytes = Buffer.from([1, 2, 3, 4]);
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const readManagedImageRecord = vi.fn(() => ({
      id: 'img-source',
      seat_id: 'seat-1',
      conversation_id: scenario.recordConversationId,
      kind: 'image' as const,
      status: 'active' as const,
      payload: {
        artifact_type: 'image' as const,
        title: 'Bild',
        description: '',
        managed_image: true as const,
        mime_type: 'image/png',
        sha256:
          scenario.storedSha256 === 'b'.repeat(64)
            ? createHash('sha256').update(imageBytes).digest('hex')
            : scenario.storedSha256,
        size: imageBytes.byteLength,
        tier: 'quality',
        model: 'gemini',
        resolution: '1K',
        aspect_ratio: '1:1',
        prompt_sha256: 'a'.repeat(64),
      },
      created_at: 1,
      updated_at: 1,
    }));

    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'fast', durationSeconds: 5, ...scenario.request },
      deps(fetchMock as unknown as typeof fetch, {
        readManagedImageRecord,
        readManagedImageBytes: () => imageBytes,
      })
    );

    expect(result).toMatchObject({ ok: false, reasonCode: scenario.reasonCode });
    expect(readLicenseWireMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses simultaneous file and managed image authority before credentials or network', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));

    const result = await handleCommandEveVideoGenerate(
      {
        prompt: 'p',
        tierId: 'fast',
        durationSeconds: 5,
        conversationId: 'conv-1',
        imagePath: '/tmp/source.png',
        imageArtifactId: 'img-source',
      },
      deps(fetchMock as unknown as typeof fetch)
    );

    expect(result).toMatchObject({ ok: false, reasonCode: 'video-mode-ambiguous' });
    expect(readLicenseWireMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses hd (1080p) when 1.5 is NOT available to the seat, before reading anything', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const readImageSourceMock = vi.fn(() => ({ bytes: new Uint8Array([1]) }));
    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'hd', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch, {
        getVideoSeatCapabilities: () => ({ hd15Available: false, presetVoicesAvailable: false }),
        readImageSource: readImageSourceMock,
      })
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasonCode).toBe('video-tier-unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readImageSourceMock).not.toHaveBeenCalled();
  });

  it('sends a TEXT prompt at 1080p on the 1.5 model once the seat is entitled', async () => {
    // The MAT-1753 migration, end to end at the bridge: no image, tier hd, and
    // the request reaches the gateway instead of being refused locally.
    let sentBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      sentBody = JSON.parse((init as { body: string }).body);
      return jsonResponse(200, okBody);
    });
    const readImageSourceMock = vi.fn(() => ({ bytes: new Uint8Array([1]) }));
    const result = await handleCommandEveVideoGenerate(
      { prompt: 'p', tierId: 'hd', durationSeconds: 5 },
      deps(fetchMock as unknown as typeof fetch, { readImageSource: readImageSourceMock })
    );
    expect(result.ok).toBe(true);
    const sentVideo = sentBody.video_generation as Record<string, unknown>;
    expect(sentVideo.tier).toBe('hd');
    expect(sentVideo.mode).toBe('text');
    expect(sentVideo.image_base64).toBeUndefined();
    expect(readImageSourceMock).not.toHaveBeenCalled();
  });

  it('grant-verifies EVERY reference image and forwards all of them', async () => {
    let sentBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: unknown, init: unknown) => {
      sentBody = JSON.parse((init as { body: string }).body);
      return jsonResponse(200, okBody);
    });
    const grantedMock = vi.fn(() => true);
    const result = await handleCommandEveVideoGenerate(
      {
        prompt: 'p',
        tierId: 'fast',
        durationSeconds: 15,
        referenceImagePaths: ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'],
      },
      deps(fetchMock as unknown as typeof fetch, { areFileSelectionPathsGranted: grantedMock })
    );
    expect(result.ok).toBe(true);
    // ONE grant check, naming EVERY path. A reference image is not a lighter
    // class of attachment than an image->video source.
    expect(grantedMock).toHaveBeenCalledWith({
      filePaths: ['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'],
      seatId: 'seat-1',
      purpose: 'read',
    });
    const sentVideo = sentBody.video_generation as Record<string, unknown>;
    expect(sentVideo.mode).toBe('reference');
    expect((sentVideo.reference_images as unknown[]).length).toBe(3);
    expect(sentVideo.image_base64).toBeUndefined();
  });

  it('refuses an 8th reference image by name, before any read or fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const readImageSourceMock = vi.fn(() => ({ bytes: new Uint8Array([1]) }));
    const result = await handleCommandEveVideoGenerate(
      {
        prompt: 'p',
        tierId: 'fast',
        durationSeconds: 5,
        referenceImagePaths: Array.from({ length: 8 }, (_, i) => `/tmp/ref-${i}.png`),
      },
      deps(fetchMock as unknown as typeof fetch, { readImageSource: readImageSourceMock })
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasonCode).toBe('reference-images-too-many');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readImageSourceMock).not.toHaveBeenCalled();
  });

  it('refuses an image AND reference images arriving together over IPC', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const result = await handleCommandEveVideoGenerate(
      {
        prompt: 'p',
        tierId: 'fast',
        durationSeconds: 5,
        imagePath: '/tmp/a.png',
        referenceImagePaths: ['/tmp/b.png'],
      },
      deps(fetchMock as unknown as typeof fetch)
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reasonCode).toBe('video-mode-ambiguous');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a 4th preset voice, and refuses ANY voice on an unentitled seat', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody));
    const tooMany = await handleCommandEveVideoGenerate(
      {
        prompt: 'p',
        tierId: 'fast',
        durationSeconds: 5,
        referenceImagePaths: ['/tmp/a.png'],
        presetVoiceIds: ['v1', 'v2', 'v3', 'v4'],
      },
      deps(fetchMock as unknown as typeof fetch)
    );
    expect(tooMany.ok === false && tooMany.reasonCode).toBe('reference-voices-too-many');

    const unentitled = await handleCommandEveVideoGenerate(
      {
        prompt: 'p',
        tierId: 'fast',
        durationSeconds: 5,
        referenceImagePaths: ['/tmp/a.png'],
        presetVoiceIds: ['v1'],
      },
      deps(fetchMock as unknown as typeof fetch, {
        getVideoSeatCapabilities: () => ({ hd15Available: true, presetVoicesAvailable: false }),
      })
    );
    expect(unentitled.ok === false && unentitled.reasonCode).toBe('reference-voices-not-entitled');
    expect(fetchMock).not.toHaveBeenCalled();
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
  it('wraps the durable list in the renderer IPC response envelope', async () => {
    const response = await handleCommandEveVideoArtifactsListBridge();

    expect(response).toEqual({ success: true, data: [] });
  });

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
      {
        getDataPath: () => '/tmp/eve-data',
        listArtifactRecords: listArtifactRecordsMock,
        listOfficeArtifactRecords: vi.fn(async (_dataPath, conversationId) => [
          {
            id: 'office-a',
            conversation_id: conversationId,
            kind: 'file' as const,
            status: 'active' as const,
            payload: { artifact_type: 'file' as const, title: 'Report.docx', path: '.command-eve/report.docx' },
            created_at: 2,
            updated_at: 2,
          },
        ]) as never,
      }
    );

    expect(listArtifactRecordsMock).toHaveBeenCalledWith('/tmp/eve-data', 'conv-1');
    expect(result).toHaveLength(2);
    expect(result[0].conversation_id).toBe('conv-1');
    expect(result[1]).toMatchObject({ id: 'office-a', conversation_id: 'conv-1', kind: 'file' });
  });

  it('reports native reconcile and Office list failures without hiding local videos', async () => {
    const log = vi.fn();
    const result = await handleCommandEveVideoArtifactsList(
      { conversationId: 'conv-1' },
      {
        getDataPath: () => '/tmp/eve-data',
        listArtifactRecords: () => [
          {
            id: 'video-a',
            conversation_id: 'conv-1',
            kind: 'video',
            status: 'active',
            payload: {
              artifact_type: 'video',
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
        ],
        hydrateBeforeList: async () => {
          throw new Error('reconcile unavailable');
        },
        listOfficeArtifactRecords: async () => {
          throw new Error('Office store corrupt');
        },
        log,
      }
    );

    expect(result).toHaveLength(1);
    expect(log).toHaveBeenNthCalledWith(
      1,
      '[command-eve-artifact-list] native-reconcile-failed: reconcile unavailable'
    );
    expect(log).toHaveBeenNthCalledWith(2, '[command-eve-artifact-list] office-list-failed: Office store corrupt');
  });
});
