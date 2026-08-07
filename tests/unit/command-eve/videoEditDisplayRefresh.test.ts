/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * THE DISPLAY GAP, CLOSED — and bound to the success case so it stays closed.
 *
 * The loopback lane's own success payload admitted this in prose: "a clip
 * produced through THIS lane does not render inline in the chat the way one
 * produced through the renderer lane does … an open display gap, not a solved
 * problem." Measured, it was worse than the comment said: `videoEdit` has ZERO
 * renderer callers, so the agent lane is not a special case — it is the only way
 * a video edit happens at all, and the gap was every edit, not an edge.
 *
 * Main saved the clip and told nobody. The renderer was already listening
 * (`Messages/artifacts.tsx` reloads ALL artifacts, `videoArtifactsList`
 * included). Only the sender was missing.
 *
 * What these tests hold in place:
 *   - the emit happens on success, exactly once;
 *   - it does NOT happen on a refusal — a refresh for an edit that never
 *     occurred is a second lie, not a smaller one;
 *   - it happens AFTER the durable write, not before;
 *   - the payload is a conversation id and nothing else, so the no-paths
 *     contract of the model-facing envelope is untouched;
 *   - and the model-facing payload still carries no path, which is the thing
 *     this fix was never allowed to buy its way out of.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readLicenseWireMock = vi.fn();
vi.mock('@/common/config/licenseWireAtRest', () => ({
  readLicenseWire: (...args: unknown[]) => readLicenseWireMock(...args),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/tmp/eve-data' }));

import type {
  CommandEveArtifactContextEnvelopeDeps,
  CommandEveVideoBridgeDeps,
} from '@/process/bridge/commandEveVideoBridge';
import {
  handleCommandEveArtifactContextEnvelope,
  handleCommandEveVideoEdit,
} from '@/process/bridge/commandEveVideoBridge';
import {
  buildConversationArtifactEnvelopeEntries,
  ensureVideoEditCapabilityHandle,
} from '@/process/commandEve/artifactCapabilityHandleStore';
import { saveVideoArtifactRecord } from '@/process/commandEve/videoArtifactStore';
import { buildVideoConversationArtifact } from '@/common/config/videoGenerationRequestCore';

const SOURCE_BYTES = Buffer.from('the founders five second aubergine clip');
const SOURCE_SHA = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');

const editedBody = {
  ok: true,
  artifact: { mime_type: 'video/mp4', data_base64: 'QUJD', bytes: 3, sha256: 'e'.repeat(64) },
  video_edit: {
    model: 'grok-imagine-video',
    tier: 'sd',
    source_duration_seconds: 5,
    source_sha256: SOURCE_SHA,
    prompt_sha256: 'd'.repeat(64),
    estimated_credits: 1000,
  },
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let dataRoot: string;
let videoRoot: string;

function seedSource(conversationId: string, id: string) {
  const clipPath = path.join(videoRoot, `${id}.mp4`);
  fs.writeFileSync(clipPath, SOURCE_BYTES);
  const artifact = buildVideoConversationArtifact({
    id,
    conversationId,
    createdAtMs: 1_754_000_000_000,
    path: clipPath,
    artifact: {
      mimeType: 'video/mp4',
      sha256: SOURCE_SHA,
      bytes: SOURCE_BYTES.byteLength,
      durationSeconds: 5,
      resolution: '480p',
      estimatedCredits: 500,
      model: 'grok-imagine-video',
      dataBase64: '',
      tierId: 'sd',
    } as never,
  });
  saveVideoArtifactRecord(dataRoot, artifact);
  return artifact;
}

function envelopeDeps(
  overrides: Partial<CommandEveArtifactContextEnvelopeDeps> = {}
): CommandEveArtifactContextEnvelopeDeps {
  return {
    getDataPath: () => dataRoot,
    buildEntries: buildConversationArtifactEnvelopeEntries,
    isVideoEditEnabled: () => true,
    ...overrides,
  };
}

function editDeps(
  fetchImpl: typeof fetch,
  overrides: Partial<CommandEveVideoBridgeDeps> = {}
): CommandEveVideoBridgeDeps {
  return {
    getDataPath: () => dataRoot,
    fetch: fetchImpl,
    newRequestId: () => 'req-fixed',
    newArtifactId: () => 'video-edited',
    getActiveSeatId: () => 'seat-1',
    areFileSelectionPathsGranted: () => true,
    readImageSource: () => ({ bytes: new Uint8Array([1, 2, 3, 4]) }),
    saveVideoFile: (input) => {
      const savedPath = path.join(videoRoot, `${input.artifactId}.mp4`);
      fs.writeFileSync(savedPath, Buffer.from(input.dataBase64, 'base64'));
      return savedPath;
    },
    saveArtifactRecord: saveVideoArtifactRecord,
    isVideoEditEnabled: () => true,
    ...overrides,
  };
}

/** Pull the permit out of the envelope exactly as a model reading it would. */
function permitFromEnvelope(envelope: string): string | undefined {
  return /evespend_[0-9a-f]{64}/.exec(envelope)?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  readLicenseWireMock.mockReturnValue({ ok: true, wire: 'ceve-wire-token' });
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-display-refresh-'));
  videoRoot = path.join(dataRoot, 'videos');
  fs.mkdirSync(videoRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

/** Mint a real handle + permit the way an agent turn does, then edit. */
async function runEdit(options: {
  fetchImpl: typeof fetch;
  emit: (conversationId: string) => void;
  conversationId?: string;
}) {
  const conversationId = options.conversationId ?? 'conv-display';
  const source = seedSource(conversationId, 'video-source');
  const handle = ensureVideoEditCapabilityHandle(dataRoot, source)!;
  const { envelope } = await handleCommandEveArtifactContextEnvelope(
    { conversationId, requestedEditOperation: 'video_edit', userTurnText: 'mach die Aubergine lustig' },
    envelopeDeps()
  );
  const permit = permitFromEnvelope(envelope)!;
  const result = await handleCommandEveVideoEdit(
    { handle, permit, instruction: 'mach die Aubergine lustig' },
    editDeps(options.fetchImpl, { emitArtifactsChanged: options.emit })
  );
  return { result, conversationId };
}

describe('a finished edit tells the renderer — exactly once', () => {
  it('emits the conversation id after a successful, durably saved edit', async () => {
    const emit = vi.fn();
    const { result, conversationId } = await runEdit({
      fetchImpl: vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch,
      emit,
    });

    if (result.ok === false) throw new Error(`edit refused: ${result.reasonCode} ${result.message ?? ''}`);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(conversationId);
  });

  it('the clip really is on disk by the time the renderer is told', async () => {
    // The point of the ordering: a refresh that arrives before the write finds
    // nothing and teaches the user the feature is broken.
    const seen: string[] = [];
    const emit = vi.fn(() => {
      seen.push(fs.existsSync(path.join(videoRoot, 'video-edited.mp4')) ? 'on-disk' : 'missing');
    });
    const { result } = await runEdit({
      fetchImpl: vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch,
      emit,
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(['on-disk']);
  });

  it('ONE edit is ONE refresh — both lanes funnel through this handler', async () => {
    // The emit lives in the shared handler rather than in either lane, so the
    // day the renderer lane gets a caller back, an edit still refreshes once.
    const emit = vi.fn();
    await runEdit({
      fetchImpl: vi.fn(async () => jsonResponse(200, editedBody)) as unknown as typeof fetch,
      emit,
    });
    expect(emit).toHaveBeenCalledTimes(1);
    const bridgeSource = fs.readFileSync(
      path.join(__dirname, '../../../packages/desktop/src/process/bridge/commandEveVideoBridge.ts'),
      'utf8'
    );
    expect(
      [...bridgeSource.matchAll(/deps\.emitArtifactsChanged\?\.\(/g)],
      'a second emit site is a second refresh for one clip'
    ).toHaveLength(1);
  });
});

describe('a refusal must NOT refresh', () => {
  it('an upstream failure saves nothing and tells nobody', async () => {
    const emit = vi.fn();
    const { result } = await runEdit({
      fetchImpl: vi.fn(async () => jsonResponse(502, { ok: false, reason: 'upstream' })) as unknown as typeof fetch,
      emit,
    });
    expect(result.ok).toBe(false);
    expect(emit, 'a refused edit produced a refresh — the UI would flash for nothing').not.toHaveBeenCalled();
  });

  it('the control flow makes it structural, not incidental', () => {
    // `if (outcome.ok === false) return outcome;` stands BETWEEN the upstream
    // call and the persistence block, and the emit sits inside that block after
    // `saveArtifactRecord`. There is no ordering in which a refusal reaches it.
    const source = fs.readFileSync(
      path.join(__dirname, '../../../packages/desktop/src/process/bridge/commandEveVideoBridge.ts'),
      'utf8'
    );
    const editBody = source.slice(source.indexOf('export async function handleCommandEveVideoEdit('));
    const refusalGuard = editBody.indexOf('if (outcome.ok === false) return outcome;');
    const save = editBody.indexOf('deps.saveArtifactRecord(dataPath, conversationArtifact);');
    const emit = editBody.indexOf('deps.emitArtifactsChanged?.(');
    expect(refusalGuard).toBeGreaterThan(-1);
    expect(save).toBeGreaterThan(refusalGuard);
    expect(emit, 'the emit moved above the durable write').toBeGreaterThan(save);
  });
});

describe('the fix does not buy its way out of the no-paths contract', () => {
  const bridgeSource = fs.readFileSync(
    path.join(__dirname, '../../../packages/desktop/src/process/bridge/commandEveVideoBridge.ts'),
    'utf8'
  );
  const emitterSource = fs.readFileSync(
    path.join(__dirname, '../../../packages/desktop/src/process/commandEve/artifactsChangedEmitter.ts'),
    'utf8'
  );

  it('the payload is a conversation id and nothing else', () => {
    expect(emitterSource).toContain('emit({ conversation_id: id })');
    const emitFn = emitterSource.slice(emitterSource.indexOf('export function emitCommandEveArtifactsChanged'));
    for (const forbidden of ['path', 'savedPath', 'mediaDirective', 'dataBase64', 'artifact']) {
      expect(emitFn, `the refresh payload must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the emit call site passes the conversation id only', () => {
    expect(bridgeSource).toContain('deps.emitArtifactsChanged?.(grant.conversation_id);');
  });

  it('the model-facing loopback payload still has no path and no media line', () => {
    const loopback = fs.readFileSync(
      path.join(__dirname, '../../../packages/desktop/src/process/commandEve/artifactCapabilityLoopback.ts'),
      'utf8'
    );
    const success = loopback.slice(
      loopback.indexOf("if (operation === 'video_edit')"),
      loopback.indexOf("if (operation === 'image_edit')")
    );
    const code = success.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[\t ]*\/\/.*$/gm, '');
    expect(code).toContain('artifact_id: result.conversationArtifact.id');
    for (const forbidden of ['mediaDirective', 'savedPath', 'MEDIA:', '.path']) {
      expect(code, `a path reached the model-facing payload via ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the loopback comment no longer describes the gap as open', () => {
    const loopback = fs.readFileSync(
      path.join(__dirname, '../../../packages/desktop/src/process/commandEve/artifactCapabilityLoopback.ts'),
      'utf8'
    );
    expect(loopback, 'the admitted gap outlived its fix').not.toContain('an open display gap, not a');
  });
});
