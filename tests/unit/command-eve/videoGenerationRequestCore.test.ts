/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The desktop half of the video lane.
 *
 * The theme of these tests is that a refusal must survive the trip to the user
 * with its reason intact. This product has twice shipped a surface that replaced
 * a specific cause with a generic sentence; the gateway now distinguishes six
 * different refusals and there is no point in that if the desktop flattens them.
 */

import { describe, expect, it } from 'vitest';
import {
  buildVideoConversationArtifact,
  buildVideoGenerationBody,
  describeVideoRefusal,
  buildVideoArtifactPayload,
  parseVideoGenerationResponse,
  refuseVideoTierWithoutImage,
} from '@/common/config/videoGenerationRequestCore';

describe('buildVideoGenerationBody', () => {
  it('sends the tier ID, never a resolution the desktop guessed', () => {
    const body = buildVideoGenerationBody({
      prompt: 'ein Produktclip',
      tierId: 'fast',
      durationSeconds: 5,
      requestId: 'req-1',
    });
    const video = body.video_generation as Record<string, unknown>;
    expect(video.tier).toBe('fast');
    expect(video.duration_seconds).toBe(5);
    // The SERVER maps tier -> model + resolution. A desktop one release behind
    // must not be able to name a model the gateway would then honour.
    expect(video.resolution).toBeUndefined();
    expect(video.model).toBeUndefined();
    expect(body.capability).toBe('video_generation');
  });

  it('carries the image and its receipt together, or neither', () => {
    const text = buildVideoGenerationBody({
      prompt: 'p',
      tierId: 'fast',
      durationSeconds: 5,
      requestId: 'r',
    });
    expect((text.video_generation as Record<string, unknown>).image_base64).toBeUndefined();

    const image = buildVideoGenerationBody({
      prompt: 'p',
      tierId: 'hd',
      durationSeconds: 5,
      requestId: 'r',
      imageBase64: 'AAAA',
      imageSha256: 'a'.repeat(64),
    });
    const video = image.video_generation as Record<string, unknown>;
    expect(video.image_base64).toBe('AAAA');
    expect(video.image_sha256).toBe('a'.repeat(64));
  });

  it('never claims the desktop holds a provider key', () => {
    const body = buildVideoGenerationBody({
      prompt: 'p',
      tierId: 'fast',
      durationSeconds: 5,
      requestId: 'r',
    });
    expect(body.directProviderKeyPresentInDesktop).toBe(false);
  });
});

describe('describeVideoRefusal — the cause survives to the user', () => {
  it('separates being out of credits from hitting the spend cap', () => {
    const broke = describeVideoRefusal('insufficient_credits');
    const capped = describeVideoRefusal('spend_cap_exceeded');
    expect(broke.message).not.toBe(capped.message);
    expect(broke.retryable).toBe(false);
    expect(capped.retryable).toBe(false);
  });

  it('claims neither a finished video nor a final charge on a replay', () => {
    // 'already' from command_eve_commit_debit proves exactly one thing: a
    // kind='debit' ledger row with this external_ref exists. Two overclaims are
    // therefore both wrong, in opposite directions:
    //   * "wurde bereits erstellt" — the live 480p test hit this refusal with no
    //     artifact and no file anywhere;
    //   * "wurde bereits abgerechnet" — command_eve_reverse_debit adds a separate
    //     kind='reversal' row and leaves the debit row standing, so a fully
    //     refunded attempt still answers 'already'.
    const described = describeVideoRefusal('request-replayed');
    expect(described.message).not.toMatch(/erstellt|erzeugt wurde|fertig/);
    expect(described.message).not.toMatch(/abgerechnet|belastet|bezahlt/);
    // What is provable: the identical request already ran under this key.
    expect(described.message).toMatch(/identische Anfrage|bereits verarbeitet/);
    // And it has to name the way out, since retrying verbatim never works.
    expect(described.message).toMatch(/Ändere|ändern/);
  });

  it('does not invite a retry for something structurally impossible', () => {
    // Telling someone to retry a 1080p text prompt makes them wrong twice.
    expect(describeVideoRefusal('video-tier-unavailable').retryable).toBe(false);
    expect(describeVideoRefusal('request-replayed').retryable).toBe(false);
    expect(describeVideoRefusal('video-daily-cap').retryable).toBe(false);
  });

  it('does invite a retry when the obstacle is temporary', () => {
    expect(describeVideoRefusal('credit-gate-unavailable').retryable).toBe(true);
    expect(describeVideoRefusal('provider-timeout').retryable).toBe(true);
  });

  it('prefers the server sentence for a capability refusal, which knows why', () => {
    const described = describeVideoRefusal(
      'video-tier-unavailable',
      '1080p video requires an image input — the text-to-video model does not produce it.'
    );
    expect(described.message).toContain('image input');
  });
});

describe('parseVideoGenerationResponse', () => {
  const goodBody = {
    ok: true,
    artifact: {
      mime_type: 'video/mp4',
      data_base64: 'AAAA',
      bytes: 3,
      sha256: 'b'.repeat(64),
    },
    video_generation: {
      model: 'grok-imagine-video',
      resolution: '720p',
      tier: 'fast',
      duration_seconds: 5,
      estimated_credits: 700,
    },
  };

  it('returns the RESOLVED spec, not the requested one', () => {
    const out = parseVideoGenerationResponse(200, goodBody);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artifact.resolution).toBe('720p');
    expect(out.artifact.model).toBe('grok-imagine-video');
    expect(out.artifact.estimatedCredits).toBe(700);
  });

  it('keeps a 402 refusal distinguishable', () => {
    const out = parseVideoGenerationResponse(402, {
      ok: false,
      reason: 'spend_cap_exceeded',
      message: 'over cap',
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reasonCode).toBe('spend_cap_exceeded');
    expect(out.retryable).toBe(false);
  });

  it('treats a 200 with no playable video as a FAILURE', () => {
    // The dishonest direction: claiming a video exists when none can be shown.
    const out = parseVideoGenerationResponse(200, { ...goodBody, artifact: { mime_type: 'text/plain' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reasonCode).toBe('video-artifact-malformed');
  });

  it('treats a 200 with an empty payload as a FAILURE', () => {
    const out = parseVideoGenerationResponse(200, {
      ...goodBody,
      artifact: { mime_type: 'video/mp4', data_base64: '' },
    });
    expect(out.ok).toBe(false);
  });

  it('survives a non-JSON or empty body without pretending success', () => {
    expect(parseVideoGenerationResponse(500, null).ok).toBe(false);
    expect(parseVideoGenerationResponse(200, null).ok).toBe(false);
    expect(parseVideoGenerationResponse(502, 'gateway down').ok).toBe(false);
  });

  it('falls back to an http reason code when the body carries none', () => {
    const out = parseVideoGenerationResponse(503, {});
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reasonCode).toBe('http_503');
  });
});

describe('buildVideoArtifactPayload — what the user sees is what was produced', () => {
  const artifact = {
    mimeType: 'video/mp4',
    dataBase64: 'AAAA',
    bytes: 3,
    sha256: 'd'.repeat(64),
    resolution: '720p',
    model: 'grok-imagine-video',
    tierId: 'fast' as const,
    durationSeconds: 5,
    estimatedCredits: 700,
  };

  it('produces a playable data url for the existing artifact renderer', () => {
    const payload = buildVideoArtifactPayload(artifact);
    expect(payload.artifact_type).toBe('video');
    expect(payload.data_url.startsWith('data:video/mp4;base64,')).toBe(true);
    expect(payload.sha256).toBe('d'.repeat(64));
  });

  it('states the RESOLVED resolution and the real credit figure', () => {
    const payload = buildVideoArtifactPayload(artifact);
    expect(payload.description).toContain('720p');
    expect(payload.description).toContain('700');
    expect(payload.description).toContain('grok-imagine-video');
  });

  it('reports what was produced even when it differs from the request', () => {
    // If the server ever resolves differently, the label follows the SERVER.
    const payload = buildVideoArtifactPayload({ ...artifact, resolution: '480p', estimatedCredits: 500 });
    expect(payload.title).toContain('480p');
    expect(payload.description).toContain('480p');
    expect(payload.description).not.toContain('720p');
  });
});

describe('refuseVideoTierWithoutImage — 1080p is unreachable without a validated image', () => {
  it('refuses hd (1080p) when no image made it through', () => {
    const refusal = refuseVideoTierWithoutImage('hd', false);
    expect(refusal).not.toBeNull();
    expect(refusal?.reasonCode).toBe('video-tier-unavailable');
    expect(refusal?.retryable).toBe(false);
  });

  it('allows hd once a validated image is present', () => {
    expect(refuseVideoTierWithoutImage('hd', true)).toBeNull();
  });

  it('never gates a tier that does not need an image', () => {
    expect(refuseVideoTierWithoutImage('fast', false)).toBeNull();
    expect(refuseVideoTierWithoutImage('sd', false)).toBeNull();
  });
});

describe('buildVideoConversationArtifact — the DURABLE, path-based artifact', () => {
  const artifact = {
    mimeType: 'video/mp4',
    dataBase64: 'AAAA',
    bytes: 3,
    sha256: 'f'.repeat(64),
    resolution: '720p',
    model: 'grok-imagine-video',
    tierId: 'fast' as const,
    durationSeconds: 5,
    estimatedCredits: 700,
  };

  it('references a local file PATH, never a data: URL', () => {
    const conversationArtifact = buildVideoConversationArtifact({
      artifact,
      path: '/tmp/Downloads/Command EVE Videos/conv-1/artifact-1.mp4',
      id: 'artifact-1',
      conversationId: 'conv-1',
      createdAtMs: 1000,
    });

    expect(conversationArtifact.id).toBe('artifact-1');
    expect(conversationArtifact.conversation_id).toBe('conv-1');
    expect(conversationArtifact.kind).toBe('video');
    expect(conversationArtifact.status).toBe('active');
    expect(conversationArtifact.payload.path).toBe('/tmp/Downloads/Command EVE Videos/conv-1/artifact-1.mp4');
    expect(conversationArtifact.payload).not.toHaveProperty('data_url');
    expect(conversationArtifact.payload.hash).toBe('f'.repeat(64));
    expect(conversationArtifact.created_at).toBe(1000);
    expect(conversationArtifact.updated_at).toBe(1000);
  });

  it('states the RESOLVED resolution and the real credit figure, same as the ephemeral payload', () => {
    const conversationArtifact = buildVideoConversationArtifact({
      artifact,
      path: '/tmp/video.mp4',
      id: 'artifact-1',
      conversationId: 'conv-1',
      createdAtMs: 1000,
    });
    expect(conversationArtifact.payload.description).toContain('720p');
    expect(conversationArtifact.payload.description).toContain('700');
  });
});
