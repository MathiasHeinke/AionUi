/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildFailureArtifact,
  evaluateArtifactGoldenCases,
  rendererArtifactType,
  shouldForceArtifactForPromptClass,
  toRendererGeneratedArtifactPayload,
  visibleArtifactPresent,
  type GeneratedArtifactPayload,
} from '@/process/commandEve/artifactContractCore';

function artifact(overrides: Partial<GeneratedArtifactPayload> = {}): GeneratedArtifactPayload {
  return {
    artifactType: 'image',
    title: 'Campaign image',
    url: 'https://example.com/image.png',
    mimeType: 'image/png',
    receipt: {
      requestId: 'req-1',
      provider: 'xAI',
      model: 'grok-image',
      route: 'xai',
      dataClass: 'S1-internal-low',
      humanGate: 'HG-2',
      status: 'done',
    },
    ...overrides,
  };
}

describe('Command EVE artifact contract core', () => {
  it('maps report/failure types to renderer-safe artifact types', () => {
    expect(rendererArtifactType('report', 'text/html')).toBe('html');
    expect(rendererArtifactType('report', 'application/pdf')).toBe('file');
    expect(rendererArtifactType('failure')).toBe('file');
    expect(rendererArtifactType('audio')).toBe('audio');
  });

  it('normalizes a generated image payload for MessageGeneratedArtifact', () => {
    const rendererPayload = toRendererGeneratedArtifactPayload(artifact());
    expect(rendererPayload).toMatchObject({
      artifact_type: 'image',
      title: 'Campaign image',
      url: 'https://example.com/image.png',
      mime_type: 'image/png',
      provider: 'xAI',
      model: 'grok-image',
      request_id: 'req-1',
    });
    expect(rendererPayload.receipt).toMatchObject({
      route: 'xai',
      status: 'done',
      dataClass: 'S1-internal-low',
    });
  });

  it('treats done artifacts as visible only when they have a preview source or content', () => {
    expect(visibleArtifactPresent(artifact())).toBe(true);
    expect(visibleArtifactPresent(artifact({ url: undefined, path: undefined, content: undefined }))).toBe(false);
    expect(
      visibleArtifactPresent(
        artifact({
          artifactType: 'html',
          url: undefined,
          html: '<main>Preview</main>',
          mimeType: 'text/html',
        })
      )
    ).toBe(true);
  });

  it('builds visible failure and blocked artifacts without requiring media source data', () => {
    const failed = buildFailureArtifact({
      requestId: 'req-fail',
      title: 'Bild konnte nicht erzeugt werden',
      error: 'Provider returned 502',
      dataClass: 'S1-internal-low',
      humanGate: 'HG-2',
      route: 'xai',
    });
    expect(visibleArtifactPresent(failed)).toBe(true);
    expect(toRendererGeneratedArtifactPayload(failed)).toMatchObject({
      artifact_type: 'file',
      error: 'Provider returned 502',
      request_id: 'req-fail',
    });

    const blocked = buildFailureArtifact({
      requestId: 'req-blocked',
      title: 'Cloud Vision blockiert',
      description: 'S3-Daten duerfen nicht an Cloud Vision.',
      error: 'S3 hard floor',
      dataClass: 'S3-restricted',
      humanGate: 'HG-3',
      blocked: true,
    });
    expect(blocked.receipt.status).toBe('blocked');
    expect(visibleArtifactPresent(blocked)).toBe(true);
  });

  it('forces artifacts for work/media/audio/blocked classes but not plain chat', () => {
    expect(shouldForceArtifactForPromptClass('work_product')).toBe(true);
    expect(shouldForceArtifactForPromptClass('media')).toBe(true);
    expect(shouldForceArtifactForPromptClass('audio')).toBe(true);
    expect(shouldForceArtifactForPromptClass('blocked_data')).toBe(true);
    expect(shouldForceArtifactForPromptClass('plain_chat')).toBe(false);
  });

  it('evaluates the golden artifact threshold set', () => {
    const result = evaluateArtifactGoldenCases([
      {
        promptClass: 'work_product',
        artifact: artifact({ artifactType: 'html', html: '<article>Post</article>', mimeType: 'text/html' }),
      },
      { promptClass: 'media', artifact: artifact() },
      {
        promptClass: 'audio',
        artifact: artifact({ artifactType: 'audio', url: 'file:///tmp/voice.mp3', mimeType: 'audio/mpeg' }),
      },
      {
        promptClass: 'blocked_data',
        artifact: buildFailureArtifact({
          requestId: 'blocked',
          title: 'Blocked',
          error: 'S3 hard floor',
          dataClass: 'S3-restricted',
          humanGate: 'HG-3',
          blocked: true,
        }),
      },
      { promptClass: 'plain_chat' },
    ]);

    expect(result.pass).toBe(true);
    expect(result.eligibleArtifactRate).toBe(1);
    expect(result.plainChatForcedArtifactRate).toBe(0);
    expect(result.blockedDataLeakCount).toBe(0);
  });

  it('fails the golden eval when blocked S3 data is not represented as a blocked receipt', () => {
    const result = evaluateArtifactGoldenCases([
      {
        promptClass: 'blocked_data',
        artifact: artifact({ receipt: { ...artifact().receipt, status: 'done', dataClass: 'S3-restricted' } }),
      },
      { promptClass: 'plain_chat', artifact: artifact() },
    ]);

    expect(result.pass).toBe(false);
    expect(result.blockedDataLeakCount).toBe(1);
    expect(result.plainChatForcedArtifactRate).toBe(1);
  });
});
