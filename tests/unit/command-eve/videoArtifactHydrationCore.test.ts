/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  extractRemoteVideoDirectives,
  hasVideoFileSignature,
  planVideoHydration,
  validateVideoDownload,
  VIDEO_HYDRATION_SOURCE_URL_KEY,
} from '@/common/config/videoArtifactHydrationCore';

const MP4_URL = 'https://cdn.example.com/videos/abc123/output.mp4?sig=xyz';

describe('extractRemoteVideoDirectives', () => {
  it('finds https video directives in transcript text, deduped', () => {
    const contents = [
      `Hier ist dein Video!\nMEDIA: ${MP4_URL}\nViel Spaß.`,
      `MEDIA: ${MP4_URL}`, // same URL in a later message — once
      'MEDIA: /abs/local/path.mp4', // local path — not remote
      'MEDIA: https://cdn.example.com/image.png?sig=1', // not a video
      'MEDIA: http://insecure.example.com/clip.mp4', // http only — refused
      'Ein ganz normaler Satz.',
    ];
    const directives = extractRemoteVideoDirectives(contents);
    expect(directives).toEqual([{ url: MP4_URL, title: 'output.mp4' }]);
  });

  it('handles bold-wrapped directive markers and webm', () => {
    expect(extractRemoteVideoDirectives(['**MEDIA:** https://cdn.example.com/v/clip.webm'])).toEqual([
      { url: 'https://cdn.example.com/v/clip.webm', title: 'clip.webm' },
    ]);
  });
});

describe('planVideoHydration', () => {
  it('skips directives a durable record already covers by source_url', () => {
    const plans = planVideoHydration(
      [
        { url: MP4_URL, title: 'output.mp4' },
        { url: 'https://cdn.example.com/v/new.mp4', title: 'new.mp4' },
      ],
      [{ path: '/local/file.mp4', [VIDEO_HYDRATION_SOURCE_URL_KEY]: MP4_URL }]
    );
    expect(plans).toEqual([
      { action: 'already-local', url: MP4_URL },
      { action: 'download', url: 'https://cdn.example.com/v/new.mp4', title: 'new.mp4' },
    ]);
  });

  it('never treats a direct-lane record (no source_url) as coverage', () => {
    const plans = planVideoHydration(
      [{ url: MP4_URL, title: 'output.mp4' }],
      [{ path: '/Users/x/Downloads/Command EVE Videos/c/1.mp4' }]
    );
    expect(plans[0].action).toBe('download');
  });
});

describe('validateVideoDownload + hasVideoFileSignature', () => {
  it('accepts a bounded video response', () => {
    expect(validateVideoDownload({ status: 200, contentType: 'video/mp4', declaredBytes: 1_000_000 })).toEqual({
      ok: true,
    });
  });

  it('refuses non-2xx, non-video content types and oversize declarations', () => {
    expect(validateVideoDownload({ status: 403, contentType: 'video/mp4' })).toEqual({ ok: false, reason: 'http_403' });
    expect(validateVideoDownload({ status: 200, contentType: 'text/html' })).toEqual({
      ok: false,
      reason: 'not-a-video',
    });
    expect(validateVideoDownload({ status: 200, contentType: 'video/mp4', declaredBytes: 200 * 1024 * 1024 })).toEqual({
      ok: false,
      reason: 'too-large',
    });
  });

  it('recognizes mp4 (ftyp) and webm (EBML) signatures and rejects junk', () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(hasVideoFileSignature(mp4)).toBe(true);
    expect(hasVideoFileSignature(webm)).toBe(true);
    expect(hasVideoFileSignature(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBe(false);
  });
});
