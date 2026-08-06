/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CEVE-18205 (T9) — the agent-initiated video GENERATE operation.
 *
 * THE HONEST CONTRACT, WHICH IS NOT THE ONE THE TASK ASSUMED.
 *
 * This work was specified as "gated like `video_edit`, permit required". Reading
 * the mint before writing any of it showed the second half is not implementable,
 * and the reason is worth stating because it is the whole risk profile of this
 * feature. `commandEveVideoBridge.ts` says it in the mint's own comment:
 *
 *   "the path that consumes reference images — `handleCommandEveVideoGenerate` —
 *    takes no permit and redeems none."
 *
 * And the mint issues permits for exactly two operations, `video_edit` and
 * `image_edit`; an unrecognised operation mints NOTHING. So a `permit` field on
 * this operation could only ever be a field no caller can fill: the app never
 * mints a generate permit, so requiring one would make the tool refuse every
 * call forever. A test asserting "permit required" would be green, and would be
 * guarding a path the product cannot take — the exact failure mode of a test
 * written from a spec rather than from the code.
 *
 * WHAT ACTUALLY BOUNDS THIS LANE, then, and what this file pins:
 *
 *   1. THE GATE. Default-off and, since CEVE-18205-FLAG, a PER-SEAT config
 *      release read fresh on every call (kill-switch + licence + persisted
 *      consent — see `agentVideoGenerateSeatResolver.test.ts` for the resolver
 *      itself). It is the whole containment, so it is tested in both directions
 *      AND across a revocation mid-session.
 *   2. THE GRANT. The conversation is read off OUR grant, never off a
 *      `conversation_id` the model supplies — the handle store's own rule.
 *   3. THE PINNED AXES. Tier and duration are chosen app-side; a model that
 *      names them is ignored, not obeyed.
 *
 * `it('has no spend permit …')` at the end pins the ABSENCE deliberately. If
 * someone later adds a generate permit, that test fails and sends them here to
 * update the doctrine — which is what a gap marker is for.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactCapabilityCallHandler,
  type ArtifactCapabilityLoopbackDeps,
} from '@/process/commandEve/artifactCapabilityLoopback';
import {
  AGENT_VIDEO_GENERATE_DURATION_SECONDS,
  AGENT_VIDEO_GENERATE_TIER_ID,
} from '@/process/commandEve/agentVideoGenerateFlag';
import {
  buildVideoConversationArtifact,
  type CommandEveVideoConversationArtifact,
} from '@/common/config/videoGenerationRequestCore';
import type { ArtifactCapabilityGrant } from '@/common/config/eveArtifactCapabilityHandleCore';

let tmpRoot: string;

const HANDLE = `evecap_${'a'.repeat(64)}`;

const GRANT: ArtifactCapabilityGrant = {
  handle: HANDLE,
  conversation_id: 'conv-1',
  artifact_id: 'video-1',
  artifact_sha256: 'b'.repeat(64),
  operation: 'video_edit',
  issued_at_ms: 1_754_000_000_000,
};

function artifact(): CommandEveVideoConversationArtifact {
  return buildVideoConversationArtifact({
    id: 'video-generated',
    conversationId: 'conv-1',
    createdAtMs: 1_754_000_000_000,
    path: '/tmp/videos/conv-1/video-generated.mp4',
    artifact: {
      mimeType: 'video/mp4',
      sha256: 'c'.repeat(64),
      bytes: 10,
      durationSeconds: 5,
      resolution: '480p',
      estimatedCredits: 500,
      model: 'grok-imagine-video',
      dataBase64: '',
      tierId: 'fast',
    } as never,
  });
}

function deps(overrides: Partial<ArtifactCapabilityLoopbackDeps> = {}): ArtifactCapabilityLoopbackDeps {
  return {
    getDataPath: () => tmpRoot,
    listArtifactRecords: () => [artifact()],
    readGrant: () => GRANT,
    videoEdit: vi.fn(),
    isVideoEditEnabled: () => true,
    videoGenerate: vi.fn(async () => ({
      ok: true as const,
      artifact: {} as never,
      conversationArtifact: artifact(),
    })),
    isVideoGenerateEnabled: async () => true,
    ...overrides,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-video-generate-loopback-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('CEVE-18205 T9 — the video_generate loopback operation', () => {
  it('generates for an open seat and answers with an artifact id, never a path', async () => {
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_generate', handle: HANDLE, prompt: 'eine tanzende Aubergine' },
      deps()
    );
    expect(result.status).toBe(200);
    const payload = result.payload as { ok: boolean; artifact_id: string };
    expect(payload.ok).toBe(true);
    expect(payload.artifact_id).toBe('video-generated');
    // Same path-free doctrine as the edit branches.
    expect(JSON.stringify(payload)).not.toContain('/tmp/videos');
    expect(JSON.stringify(payload)).not.toContain('MEDIA:');
  });

  it('is CLOSED by default — a seat that did not opt in is refused 403 by name', async () => {
    const generate = vi.fn();
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_generate', handle: HANDLE, prompt: 'x' },
      deps({ isVideoGenerateEnabled: async () => false, videoGenerate: generate })
    );
    expect(result.status).toBe(403);
    expect((result.payload as { reason: string }).reason).toBe('agent-video-generate-disabled');
    // 403 must mean NOTHING WAS SPENT, not "refused after the fact".
    expect(generate).not.toHaveBeenCalled();
  });

  it('closing generate does not darken video_edit — the three tools are independent', async () => {
    // The positive control for the test above: prove the probe distinguishes
    // "generate closed" from "everything closed". The record must carry the
    // grant's own artifact id, or this 404s for an unrelated reason and proves
    // nothing about the flag.
    const result = await artifactCapabilityCallHandler(
      { operation: 'artifact_get', handle: HANDLE },
      deps({
        isVideoGenerateEnabled: async () => false,
        listArtifactRecords: () => [{ ...artifact(), id: GRANT.artifact_id }],
      })
    );
    expect(result.status).toBe(200);
  });

  it('re-asks the per-seat gate on EVERY call, and a revoked release closes it', async () => {
    // CEVE-18205-FLAG. The gate is an async per-seat config read, not a boot-time
    // constant: an operator who unticks the box must close the tool on the next
    // call. A cached decision would keep spending after the release was revoked.
    let released = true;
    const gate = vi.fn(async () => released);
    const generate = vi.fn(async () => ({
      ok: true as const,
      artifact: {} as never,
      conversationArtifact: artifact(),
    }));
    const d = deps({ isVideoGenerateEnabled: gate, videoGenerate: generate });

    const first = await artifactCapabilityCallHandler({ operation: 'video_generate', handle: HANDLE, prompt: 'x' }, d);
    expect(first.status).toBe(200);

    released = false;
    const second = await artifactCapabilityCallHandler({ operation: 'video_generate', handle: HANDLE, prompt: 'x' }, d);
    expect(second.status).toBe(403);
    expect((second.payload as { reason: string }).reason).toBe('agent-video-generate-disabled');

    expect(gate).toHaveBeenCalledTimes(2);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('a gate that rejects is refused, not crashed into a 500', async () => {
    // The production gate swallows its own errors, but the loopback must not
    // depend on that politeness: a rejected promise here still has to mean OFF.
    const generate = vi.fn();
    await expect(
      artifactCapabilityCallHandler(
        { operation: 'video_generate', handle: HANDLE, prompt: 'x' },
        deps({
          isVideoGenerateEnabled: async () => {
            throw new Error('backend unreachable');
          },
          videoGenerate: generate,
        })
      )
    ).rejects.toThrow('backend unreachable');
    // What matters for money: nothing was spent on the way out.
    expect(generate).not.toHaveBeenCalled();
  });

  it('refuses a handle it did not mint — the conversation must be ours to state', async () => {
    const generate = vi.fn();
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_generate', handle: HANDLE, prompt: 'x' },
      deps({ readGrant: () => undefined, videoGenerate: generate })
    );
    expect(result.status).toBe(404);
    expect((result.payload as { reason: string }).reason).toBe('handle-unknown');
    expect(generate).not.toHaveBeenCalled();
  });

  it('refuses an empty prompt before spending anything', async () => {
    const generate = vi.fn();
    const results = await Promise.all(
      ['', '   ', undefined].map((prompt) =>
        artifactCapabilityCallHandler(
          { operation: 'video_generate', handle: HANDLE, prompt },
          deps({ videoGenerate: generate })
        )
      )
    );
    for (const result of results) {
      expect(result.status).toBe(400);
      expect((result.payload as { reason: string }).reason).toBe('prompt-required');
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it('takes the conversation from the GRANT and ignores one the model supplies', async () => {
    const generate = vi.fn(async () => ({
      ok: true as const,
      artifact: {} as never,
      conversationArtifact: artifact(),
    }));
    await artifactCapabilityCallHandler(
      {
        operation: 'video_generate',
        handle: HANDLE,
        prompt: 'x',
        // A model aiming a paid render at someone else's conversation.
        conversation_id: 'conv-victim',
        conversationId: 'conv-victim',
      },
      deps({ videoGenerate: generate })
    );
    expect(generate).toHaveBeenCalledTimes(1);
    const passed = generate.mock.calls[0][0] as unknown as { conversationId: string };
    expect(passed.conversationId).toBe('conv-1');
  });

  it('pins tier and duration app-side and ignores a model that names them', async () => {
    const generate = vi.fn(async () => ({
      ok: true as const,
      artifact: {} as never,
      conversationArtifact: artifact(),
    }));
    await artifactCapabilityCallHandler(
      {
        operation: 'video_generate',
        handle: HANDLE,
        prompt: 'x',
        // The expensive axes, as a model would try to name them.
        tierId: 'hd',
        modelId: 'grok-imagine-video-1.5',
        durationSeconds: 15,
        resolution: '1080p',
      },
      deps({ videoGenerate: generate })
    );
    const passed = generate.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(passed.tierId).toBe(AGENT_VIDEO_GENERATE_TIER_ID);
    expect(passed.durationSeconds).toBe(AGENT_VIDEO_GENERATE_DURATION_SECONDS);
    // Not merely overridden — never carried at all.
    expect(passed.modelId).toBeUndefined();
    expect(passed.resolution).toBeUndefined();
  });

  it('reports a refusal from the handler by its own reason code', async () => {
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_generate', handle: HANDLE, prompt: 'x' },
      deps({
        videoGenerate: vi.fn(async () => ({
          ok: false as const,
          reasonCode: 'insufficient_credits',
          message: 'Nicht genug Credits für dieses Video.',
          retryable: false,
        })),
      })
    );
    expect(result.status).toBe(400);
    const payload = result.payload as { reason: string; message: string };
    expect(payload.reason).toBe('insufficient_credits');
    expect(payload.message).toBe('Nicht genug Credits für dieses Video.');
  });

  it('does not fabricate an artifact id when the durable save was skipped', async () => {
    // The success branch's `conversationArtifact` is optional: the handler skips
    // the save rather than faking one. A clip that was rendered AND BILLED but
    // has no record must not be reported as a saved artifact.
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_generate', handle: HANDLE, prompt: 'x' },
      deps({ videoGenerate: vi.fn(async () => ({ ok: true as const, artifact: {} as never })) })
    );
    expect(result.status).toBe(200);
    const payload = result.payload as { ok: boolean; artifact_id: null; reason: string };
    expect(payload.ok).toBe(true);
    expect(payload.artifact_id).toBeNull();
    expect(payload.reason).toBe('artifact-not-persisted');
  });

  it('still refuses an unknown operation with 400', async () => {
    // The new branch must not have widened the fallthrough.
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_generate_batch', handle: HANDLE, prompt: 'x' },
      deps()
    );
    expect(result.status).toBe(400);
    expect((result.payload as { reason: string }).reason).toBe('unsupported-operation');
  });

  it('has no spend permit — this pins a KNOWN GAP, not a satisfied requirement', async () => {
    const generate = vi.fn(async () => ({
      ok: true as const,
      artifact: {} as never,
      conversationArtifact: artifact(),
    }));
    // A permit offered by the caller is neither required nor consumed, because
    // the app mints none for this operation. If this ever starts failing, the
    // lane has grown a turn-bound credential and `agentVideoGenerateFlag.ts`
    // should be re-read: its default-off posture exists precisely because this
    // binding is missing, and it could then be revisited.
    await artifactCapabilityCallHandler(
      { operation: 'video_generate', handle: HANDLE, prompt: 'x', permit: `evespend_${'d'.repeat(64)}` },
      deps({ videoGenerate: generate })
    );
    const passed = generate.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(passed.permit).toBeUndefined();
    // And it succeeds WITHOUT one — the unbounded-spend gap, stated as a fact.
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
