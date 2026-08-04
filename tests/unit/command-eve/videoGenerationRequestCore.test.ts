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
  refuseUnproducibleVideoRequest,
} from '@/common/config/videoGenerationRequestCore';

describe('buildVideoGenerationBody', () => {
  it('sends the tier ID, never a resolution the desktop guessed', () => {
    const body = buildVideoGenerationBody({
      prompt: 'ein Produktclip',
      tierId: 'fast',
      durationSeconds: 5,
      mode: { kind: 'text' },
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

  it('carries an explicit resolved model without ever carrying a resolution', () => {
    const body = buildVideoGenerationBody({
      prompt: 'ein Produktclip',
      tierId: 'fast',
      modelId: 'grok-imagine-video-1.5',
      durationSeconds: 10,
      mode: { kind: 'text' },
      requestId: 'req-model',
    });
    const video = body.video_generation as Record<string, unknown>;
    expect(video.model).toBe('grok-imagine-video-1.5');
    expect(video.resolution).toBeUndefined();
  });

  it('carries the image and its receipt together, or neither', () => {
    const text = buildVideoGenerationBody({
      prompt: 'p',
      tierId: 'fast',
      durationSeconds: 5,
      mode: { kind: 'text' },
      requestId: 'r',
    });
    expect((text.video_generation as Record<string, unknown>).image_base64).toBeUndefined();

    const image = buildVideoGenerationBody({
      prompt: 'p',
      tierId: 'hd',
      durationSeconds: 5,
      mode: { kind: 'image', image: { base64: 'AAAA', sha256: 'a'.repeat(64) } },
      requestId: 'r',
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
      mode: { kind: 'text' },
      requestId: 'r',
    });
    expect(body.directProviderKeyPresentInDesktop).toBe(false);
  });

  it('carries reference images and preset voice NAMES, and nothing else', () => {
    const body = buildVideoGenerationBody({
      prompt: 'p',
      tierId: 'fast',
      durationSeconds: 15,
      mode: {
        kind: 'reference',
        referenceImages: [
          { base64: 'AAAA', sha256: 'a'.repeat(64) },
          { base64: 'BBBB', sha256: 'b'.repeat(64) },
        ],
        presetVoiceIds: ['preset-1'],
      },
      requestId: 'r',
    });
    const video = body.video_generation as Record<string, unknown>;
    expect(video.mode).toBe('reference');
    expect(video.reference_images).toEqual([
      { image_base64: 'AAAA', image_sha256: 'a'.repeat(64) },
      { image_base64: 'BBBB', image_sha256: 'b'.repeat(64) },
    ]);
    expect(video.reference_audios).toEqual(['preset-1']);
    // A reference body carries NO image->video source: the modes are exclusive.
    expect(video.image_base64).toBeUndefined();
  });

  it('NO custom-audio field can reach the gateway body', () => {
    // The input is polluted with every shape a custom upload could take. The
    // builder reads only the union's own branches, so none of them has a path
    // into the body — a STRUCTURAL guarantee, and this is what keeps it one.
    const polluted = {
      prompt: 'p',
      tierId: 'fast' as const,
      durationSeconds: 5,
      requestId: 'r',
      audio_base64: 'SMUGGLED',
      custom_audio_url: 'https://example.test/voice.wav',
      mode: {
        kind: 'reference' as const,
        referenceImages: [{ base64: 'AAAA', sha256: 'a'.repeat(64) }],
        presetVoiceIds: ['preset-1'],
        audio_base64: 'SMUGGLED',
        customAudio: { url: 'https://example.test/voice.wav' },
      },
    };
    const body = buildVideoGenerationBody(polluted as unknown as Parameters<typeof buildVideoGenerationBody>[0]);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('SMUGGLED');
    const video = body.video_generation as Record<string, unknown>;
    for (const key of Object.keys(video)) {
      if (key === 'reference_audios') continue;
      expect(/audio/i.test(key)).toBe(false);
    }
    expect(video.reference_audios).toEqual(['preset-1']);
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

// INVERTED, MAT-1753. This block used to be
// "refuseVideoTierWithoutImage — 1080p is unreachable without a validated image",
// and it asserted that `hd` without an image is refused and `hd` with an image is
// allowed. Both halves encoded the false "1.5 is image-to-video only" belief. The
// case keeps an assertion because the guard still exists and still matters — it
// is simply repointed at the specs that are ACTUALLY impossible.
describe('refuseUnproducibleVideoRequest — the local gate, repointed at real impossibilities', () => {
  const HD15 = { hd15Available: true } as const;

  it('allows hd (1080p) from a bare TEXT prompt once 1.5 is available', () => {
    expect(refuseUnproducibleVideoRequest({ tierId: 'hd', modeKind: 'text', capabilities: HD15 })).toBeNull();
  });

  it('still refuses hd when 1.5 is not available to the seat', () => {
    const refusal = refuseUnproducibleVideoRequest({ tierId: 'hd', modeKind: 'text' });
    expect(refusal).not.toBeNull();
    expect(refusal?.reasonCode).toBe('video-tier-unavailable');
    expect(refusal?.retryable).toBe(false);
  });

  it('refuses reference mode when 1.5 is not available, with its own sentence', () => {
    const refusal = refuseUnproducibleVideoRequest({ tierId: 'fast', modeKind: 'reference' });
    expect(refusal).not.toBeNull();
    expect(refusal?.message).toContain('Referenzbildern');
  });

  it('refuses a 1080p EDIT rather than clamping it', () => {
    const refusal = refuseUnproducibleVideoRequest({ tierId: 'hd', modeKind: 'edit', capabilities: HD15 });
    expect(refusal).not.toBeNull();
    expect(refusal?.reasonCode).toBe('video-tier-unavailable');
  });

  it('never gates the tiers the base model always produces', () => {
    expect(refuseUnproducibleVideoRequest({ tierId: 'fast', modeKind: 'text' })).toBeNull();
    expect(refuseUnproducibleVideoRequest({ tierId: 'sd', modeKind: 'text' })).toBeNull();
    expect(refuseUnproducibleVideoRequest({ tierId: 'fast', modeKind: 'image' })).toBeNull();
  });

  it('refuses a base-model 1080p combination before the paid request', () => {
    const refusal = refuseUnproducibleVideoRequest({
      tierId: 'hd',
      modelId: 'grok-imagine-video',
      modeKind: 'text',
      capabilities: HD15,
    });
    expect(refusal?.message).toContain('Videomodell');
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
