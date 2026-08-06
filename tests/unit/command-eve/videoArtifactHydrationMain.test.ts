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

/**
 * B1 — THE CEILING MUST BIND ON BYTES WE COUNTED, NOT ON BYTES THE SERVER CLAIMED.
 *
 * `content-length` is a claim: it is ABSENT on any chunked response (routine for a
 * CDN) and it can simply lie. Before this fix the 128 MB ceiling was evaluated only
 * against that header, and the body was then read with `arrayBuffer()` and copied
 * to base64 with no length check anywhere — so both cases below read an unbounded
 * body into the main process. The URL comes from a `MEDIA:` line in a persisted
 * assistant message, i.e. from model output, so this is reachable input.
 *
 * `maxBytes` is injected so these run against a few bytes instead of allocating
 * 128 MB; the production default is `MAX_VIDEO_HYDRATION_BYTES`.
 */
describe('B1 — the hydration download is bounded by the bytes actually received', () => {
  /** A body that exceeds the (tiny, injected) ceiling, with a valid mp4 signature. */
  const oversizedMp4 = () => {
    const bytes = new Uint8Array(64);
    bytes.set(MP4_BYTES, 0);
    return bytes;
  };

  it('rejects an oversized body that declares NO content-length', async () => {
    // A `Response` built from a stream carries no content-length — exactly the
    // chunked-CDN shape that skipped the ceiling entirely.
    const deps = makeDeps({
      maxBytes: 32,
      fetchImpl: vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(oversizedMp4());
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4' } });
      }),
    });

    const summary = await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);

    expect(summary.hydrated).toBe(0);
    expect(summary.failed).toEqual([{ url: CLIP_URL, reason: 'too-large' }]);
    // Nothing may reach the disk or the base64 copy.
    expect(deps.saveVideoFile).not.toHaveBeenCalled();
    expect(deps.saveArtifactRecord).not.toHaveBeenCalled();
  });

  it('rejects an oversized body that LIES in its content-length', async () => {
    const deps = makeDeps({
      maxBytes: 32,
      fetchImpl: vi.fn(
        async () =>
          new Response(oversizedMp4(), {
            status: 200,
            // Declares 8 bytes — under the ceiling — and sends 64.
            headers: { 'content-type': 'video/mp4', 'content-length': '8' },
          })
      ),
    });

    const summary = await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);

    expect(summary.hydrated).toBe(0);
    expect(summary.failed).toEqual([{ url: CLIP_URL, reason: 'too-large' }]);
    expect(deps.saveVideoFile).not.toHaveBeenCalled();
  });

  it('still accepts a clip inside the ceiling (the guard is not a blanket refusal)', async () => {
    const deps = makeDeps({ maxBytes: 32 });
    const summary = await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);
    expect(summary).toMatchObject({ hydrated: 1, failed: [] });
  });
});

/**
 * S1 — F-05 DOCTRINE ON THIS LANE TOO.
 *
 * `ollamaOpenAiShim.ts` states it for the upstream lanes: "never follow redirects
 * … no shim lane has a legitimate redirect", implemented as `redirect: 'error'`.
 * This lane fetched a model-supplied URL with `redirect: 'follow'`, so a 30x could
 * walk the request to a host the directive never named.
 *
 * The first test pins the REQUEST we make (the option is the whole contract with
 * the platform — a mock cannot enforce redirect semantics, so asserting the
 * option is the honest unit-level assertion). The second pins what happens when
 * the platform then refuses, which is how a real redirect surfaces.
 */
describe('S1 — the hydration fetch refuses redirects', () => {
  it('requests redirect: error, never follow', async () => {
    const deps = makeDeps();
    await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);

    expect(deps.fetchImpl).toHaveBeenCalledTimes(1);
    const init = deps.fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe('error');
  });

  it('fails quiet when the platform rejects a redirecting response', async () => {
    const deps = makeDeps({
      // What `fetch(..., { redirect: 'error' })` really does on a 30x.
      fetchImpl: vi.fn(async () => Promise.reject(new TypeError('unexpected redirect'))),
    });

    const summary = await reconcileConversationRemoteVideos('/data', 'conv-1', deps as never);

    expect(summary.hydrated).toBe(0);
    expect(summary.failed).toEqual([{ url: CLIP_URL, reason: 'TypeError' }]);
    expect(deps.saveArtifactRecord).not.toHaveBeenCalled();
  });
});

/**
 * S2 — IDEMPOTENCY THAT SURVIVES A RACE, NOT ONLY A SEQUENCE.
 *
 * The dedupe was a plan-time snapshot of `listRecords`, and the artifact id was a
 * fresh `randomUUID()`. The turn-end relay and the list-time reconcile can both be
 * in flight, so both saw "not local", both downloaded, and both saved under a
 * DIFFERENT id — two manifest files, two cards, one clip. The module docstring and
 * the relay comment both claimed this was safe.
 *
 * The id is now a digest of the origin URL, so a racing pair collapses onto ONE
 * filename: the second write overwrites the first instead of adding a duplicate.
 */
describe('S2 — a relay/list race collapses onto one record', () => {
  it('gives two concurrent hydrations of the same URL the SAME artifact id', async () => {
    // Both reconciles observe an EMPTY store — the snapshot race, reproduced.
    const first = makeDeps({ newArtifactId: undefined });
    const second = makeDeps({ newArtifactId: undefined });

    const [a, b] = await Promise.all([
      reconcileConversationRemoteVideos('/data', 'conv-1', first as never),
      reconcileConversationRemoteVideos('/data', 'conv-1', second as never),
    ]);

    expect(a.hydrated).toBe(1);
    expect(b.hydrated).toBe(1);

    const idA = (first.saveArtifactRecord.mock.calls[0][1] as { id: string }).id;
    const idB = (second.saveArtifactRecord.mock.calls[0][1] as { id: string }).id;
    // ONE id ⇒ one manifest filename (the store keys by artifact.id) ⇒ one card.
    expect(idA).toBe(idB);
    // And the file the bytes land in is keyed by the same id.
    expect((first.saveVideoFile.mock.calls[0][0] as { artifactId: string }).artifactId).toBe(idA);
  });

  it('derives a different id for a different origin URL', async () => {
    const other = 'https://cdn.example.com/videos/other.mp4?sig=2';
    const first = makeDeps({ newArtifactId: undefined });
    const second = makeDeps({
      newArtifactId: undefined,
      fetchTranscript: vi.fn(async () => transcriptWith(`Fertig!\nMEDIA: ${other}`)),
    });

    await reconcileConversationRemoteVideos('/data', 'conv-1', first as never);
    await reconcileConversationRemoteVideos('/data', 'conv-1', second as never);

    const idA = (first.saveArtifactRecord.mock.calls[0][1] as { id: string }).id;
    const idB = (second.saveArtifactRecord.mock.calls[0][1] as { id: string }).id;
    expect(idA).not.toBe(idB);
    // The store rejects an id its SAFE_ID regex refuses, so the digest must pass it.
    expect(idA).toMatch(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);
  });
});
