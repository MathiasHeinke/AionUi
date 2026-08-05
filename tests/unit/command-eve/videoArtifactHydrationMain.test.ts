/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { reconcileConversationRemoteVideos } from '@process/commandEve/videoArtifactHydrationMain';

const MP4_BYTES = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 1, 2, 3, 4]);
const CLIP_URL = 'https://cdn.example.com/videos/clip.mp4?sig=1';

const transcriptWith = (text: string) => ({ items: [{ content: { content: text } }] });

const makeDeps = (overrides: Record<string, unknown> = {}) => ({
  fetchTranscript: vi.fn(async () => transcriptWith(`Fertig!\nMEDIA: ${CLIP_URL}`)),
  fetchImpl: vi.fn(async () => new Response(MP4_BYTES, { status: 200, headers: { 'content-type': 'video/mp4' } })),
  saveVideoFile: vi.fn(() => '/downloads/Command EVE Videos/conv-1/art-1.mp4'),
  saveArtifactRecord: vi.fn(),
  listRecords: vi.fn(() => []),
  newArtifactId: () => 'art-1',
  nowMs: () => 1_000,
  log: vi.fn(),
  ...overrides,
});

describe('reconcileConversationRemoteVideos (MAT-1773 Package B)', () => {
  it('downloads a remote directive clip into the durable store with its origin URL', async () => {
    const deps = makeDeps();
    const summary = await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);

    expect(summary).toMatchObject({ directives: 1, hydrated: 1, alreadyLocal: 0, failed: [] });
    expect(deps.saveVideoFile).toHaveBeenCalledTimes(1);
    const saved = deps.saveArtifactRecord.mock.calls[0][1];
    expect(saved.kind).toBe('video');
    expect(saved.payload.path).toBe('/downloads/Command EVE Videos/conv-1/art-1.mp4');
    expect(saved.payload.source_url).toBe(CLIP_URL);
    expect(saved.payload.size).toBe(MP4_BYTES.length);
  });

  it('is idempotent: a covered URL is alreadyLocal and never re-downloaded', async () => {
    const deps = makeDeps({
      listRecords: vi.fn(() => [{ payload: { path: '/x.mp4', source_url: CLIP_URL } }]),
    });
    const summary = await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);

    expect(summary).toMatchObject({ directives: 1, hydrated: 0, alreadyLocal: 1 });
    expect(deps.fetchImpl).not.toHaveBeenCalled();
    expect(deps.saveArtifactRecord).not.toHaveBeenCalled();
  });

  it('fails quiet per directive: a refused body is collected, never thrown', async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(
        async () => new Response('<html>expired</html>', { status: 410, headers: { 'content-type': 'text/html' } })
      ),
    });
    const summary = await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);

    expect(summary.hydrated).toBe(0);
    expect(summary.failed).toEqual([{ url: CLIP_URL, reason: 'http_410' }]);
    expect(deps.saveArtifactRecord).not.toHaveBeenCalled();
  });

  it('rejects bytes without a video signature even on a 200 video response', async () => {
    const deps = makeDeps({
      fetchImpl: vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]), {
            status: 200,
            headers: { 'content-type': 'video/mp4' },
          })
      ),
    });
    const summary = await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);
    expect(summary.failed[0]?.reason).toBe('bad-signature');
  });

  it('no directives → no transcript-side work beyond the fetch', async () => {
    const deps = makeDeps({ fetchTranscript: vi.fn(async () => transcriptWith('kein video hier')) });
    const summary = await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);
    expect(summary.directives).toBe(0);
    expect(deps.fetchImpl).not.toHaveBeenCalled();
  });

  it('a transcript fetch failure returns an empty summary, never throws', async () => {
    const deps = makeDeps({ fetchTranscript: vi.fn(async () => Promise.reject(new Error('backend down'))) });
    const summary = await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);
    expect(summary.transcriptFetched).toBe(false);
    expect(summary.hydrated).toBe(0);
  });
});
