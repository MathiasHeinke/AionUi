import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCommandEveImageGenerateCoordinator,
  handleCommandEveImageArtifactBind,
  handleCommandEveImageArtifactImportLegacy,
  handleCommandEveImageArtifactImportLegacyBridge,
  handleCommandEveImageArtifactPreview,
  handleCommandEveImageArtifactsList,
  handleCommandEveImageEdit,
  handleCommandEveImageGenerate,
  type CommandEveImageArtifactImportLegacyDeps,
  type CommandEveImageEditDeps,
  type CommandEveImageGenerateDeps,
} from '@/process/bridge/commandEveImageArtifactBridge';
import {
  bindStagedImageArtifact,
  readImageArtifactBytes,
  readImageArtifactRecordById,
  stageGeneratedImageArtifact,
} from '@/process/commandEve/imageArtifactStore';
import type { importLegacyImageArtifact } from '@/process/commandEve/imageArtifactStore';
import {
  consumeVideoEditSpendPermit,
  issueVideoEditSpendPermit,
  recordActiveUserTurn,
  reinitializeVideoEditSpendStore,
} from '@/process/commandEve/videoEditSpendPermitStore';
import type { CommandEveActiveImageArtifact } from '@/common/config/managedImageArtifactCore';
import type { CommandEveImageGenerateRequest } from '@/common/config/eveManagedImageGenerationCore';

const SOURCE_BYTES = Buffer.from('source-image-bytes');
const SOURCE_SHA = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');
const PROMPT_SHA = crypto.createHash('sha256').update('prompt').digest('hex');
const TURN = 'bearbeite das bild';
const TURN_SHA = crypto.createHash('sha256').update(TURN).digest('hex');
const CHILD_HANDLE = `img_h_${'9'.repeat(64)}`;

let dataRoot: string;

/** A REAL staged-then-bound image in the real store, grant minted for real. */
function seedActiveImage(conversationId = 'conv-1'): CommandEveActiveImageArtifact {
  const staged = stageGeneratedImageArtifact(dataRoot, {
    bytes: SOURCE_BYTES,
    mimeType: 'image/png',
    tier: 'quality',
    model: 'gemini',
    resolution: '1K',
    aspectRatio: '16:9',
    promptSha256: PROMPT_SHA,
  })!;
  const bound = bindStagedImageArtifact(dataRoot, { conversationId, handle: staged.handle, toolCallId: 'call-1' });
  if (bound.ok === false) throw new Error(`seed failed: ${bound.reason}`);
  return bound.record;
}

function issueImagePermit(sha = SOURCE_SHA): string {
  recordActiveUserTurn(dataRoot, 'conv-1', TURN_SHA);
  return issueVideoEditSpendPermit(dataRoot, {
    conversationId: 'conv-1',
    userTurnSha256: TURN_SHA,
    allowedArtifactSha256: [sha],
    operation: 'image_edit',
  })!;
}

function editDeps(runManagedEdit: CommandEveImageEditDeps['runManagedEdit']): CommandEveImageEditDeps {
  return {
    getDataPath: () => dataRoot,
    getActiveSeatId: () => 'seat-1',
    getActiveSeatContextRevision: () => 7,
    getPaidArtifactBlockReason: () => null,
    tryBeginPaidArtifactOperation: () => vi.fn(),
    isImageEditEnabled: () => true,
    runManagedEdit,
  };
}

function imageGenerateRequest(overrides: Partial<CommandEveImageGenerateRequest> = {}): CommandEveImageGenerateRequest {
  return {
    prompt: 'Ein ruhiges Editorial-Motiv',
    conversationId: 'conv-1',
    requestId: 'image-request-0001',
    tierId: 'quality',
    resolution: '2K',
    aspectRatio: '16:9',
    ...overrides,
  };
}

function imageGenerateDeps(
  record: CommandEveActiveImageArtifact,
  overrides: Partial<CommandEveImageGenerateDeps> = {}
): CommandEveImageGenerateDeps {
  return {
    getDataPath: () => dataRoot,
    getActiveSeatId: () => 'seat-1',
    getActiveSeatContextRevision: () => 7,
    areFileSelectionPathsGranted: () => true,
    readImageSource: () => ({ stat: {} as fs.Stats, bytes: new Uint8Array(SOURCE_BYTES), mimeType: 'image/png' }),
    runManagedGeneration: vi.fn(async () => ({
      status: 200,
      body: { data: [{ artifact_handle: CHILD_HANDLE }] },
    })),
    bind: vi.fn(() => ({ ok: true, record, alreadyBound: false })),
    acquireInflightLock: vi.fn(() => true),
    releaseInflightLock: vi.fn(),
    coordinator: createCommandEveImageGenerateCoordinator(),
    ...overrides,
  };
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-image-bridge-'));
  reinitializeVideoEditSpendStore(dataRoot);
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('handleCommandEveImageEdit', () => {
  it('valid handle + permit => child staged with parent set, source untouched, managed service called with the source BYTES', async () => {
    const source = seedActiveImage();
    const permit = issueImagePermit();
    const grantHandle = (() => {
      // The handle the envelope would carry: the durable grant minted at bind.
      const dir = path.join(dataRoot, 'command-eve-artifact-capabilities', 'by-artifact');
      const key = crypto.createHash('sha256').update(`conv-1|${source.id}`).digest('hex');
      return (JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')) as { handle: string }).handle;
    })();
    const runManagedEdit = vi.fn(async () => ({
      status: 200,
      body: {
        created: 1,
        data: [{ artifact_handle: CHILD_HANDLE, media_type: 'image/png', sha256: 'f'.repeat(64), bytes_count: 10 }],
      },
    }));

    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, permit, instruction: 'mach den Himmel bedeckt' },
      editDeps(runManagedEdit)
    );

    expect(result).toEqual({ ok: true, artifactHandle: CHILD_HANDLE, parentArtifactId: source.id });
    expect(runManagedEdit).toHaveBeenCalledTimes(1);
    const call = runManagedEdit.mock.calls[0][0];
    expect(call.parentArtifactId).toBe(source.id);
    expect(call.instruction).toBe('mach den Himmel bedeckt');
    expect(call.dataPath).toBe(dataRoot);
    expect(call.expectedSeat).toEqual({ id: 'seat-1', revision: 7 });
    expect(call.requestId).toMatch(/^[a-f0-9]{64}$/);
    // The reference rides as a data URL built from EXACTLY the private bytes.
    expect(call.referenceDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const decoded = Buffer.from(call.referenceDataUrl.slice('data:image/png;base64,'.length), 'base64');
    expect(decoded.equals(SOURCE_BYTES)).toBe(true);
    // The ORIGINAL artifact is untouched: record and bytes identical.
    const after = readImageArtifactRecordById(dataRoot, source.id)!;
    expect(after.status).toBe('active');
    expect(after.payload.sha256).toBe(SOURCE_SHA);
    expect(readImageArtifactBytes(dataRoot, source.id)?.equals(SOURCE_BYTES)).toBe(true);
  });

  it('a missing permit refuses BEFORE anything — no grant read, no provider', async () => {
    seedActiveImage();
    const runManagedEdit = vi.fn();
    const result = await handleCommandEveImageEdit(
      { handle: `evecap_${'1'.repeat(64)}`, instruction: 'heller' },
      editDeps(runManagedEdit)
    );
    expect(result).toMatchObject({ ok: false, reasonCode: 'image-edit-permit-missing' });
    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('unknown, malformed and cross-conversation handles refuse before the provider', async () => {
    seedActiveImage();
    const permit = issueImagePermit();
    const runManagedEdit = vi.fn();

    const unknown = await handleCommandEveImageEdit(
      { handle: `evecap_${'2'.repeat(64)}`, permit, instruction: 'heller' },
      editDeps(runManagedEdit)
    );
    expect(unknown).toMatchObject({ ok: false, reasonCode: 'image-edit-handle-unknown' });

    const malformed = await handleCommandEveImageEdit(
      { handle: 'evecap_nope', permit, instruction: 'heller' },
      editDeps(runManagedEdit)
    );
    expect(malformed).toMatchObject({ ok: false, reasonCode: 'image-edit-handle-unknown' });

    // A grant minted for ANOTHER conversation's artifact, presented with this
    // conversation as the caller fence.
    const other = seedActiveImage('conv-2');
    const otherDir = path.join(dataRoot, 'command-eve-artifact-capabilities', 'by-artifact');
    const otherKey = crypto.createHash('sha256').update(`conv-2|${other.id}`).digest('hex');
    const otherHandle = (
      JSON.parse(fs.readFileSync(path.join(otherDir, `${otherKey}.json`), 'utf8')) as { handle: string }
    ).handle;
    const cross = await handleCommandEveImageEdit(
      { handle: otherHandle, permit, instruction: 'heller', conversationId: 'conv-1' },
      editDeps(runManagedEdit)
    );
    expect(cross).toMatchObject({ ok: false, reasonCode: 'image-edit-conversation-mismatch' });

    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('an expired grant (read as absent) refuses before the provider', async () => {
    const source = seedActiveImage();
    const permit = issueImagePermit();
    const runManagedEdit = vi.fn();
    const result = await handleCommandEveImageEdit(
      { handle: `evecap_${'3'.repeat(64)}`, permit, instruction: 'heller' },
      { ...editDeps(runManagedEdit), readGrant: () => undefined }
    );
    expect(result).toMatchObject({ ok: false, reasonCode: 'image-edit-handle-unknown' });
    expect(runManagedEdit).not.toHaveBeenCalled();
    expect(readImageArtifactRecordById(dataRoot, source.id)).toBeTruthy();
  });

  it('a video_edit permit cannot buy an image edit — refused before the provider', async () => {
    seedActiveImage();
    recordActiveUserTurn(dataRoot, 'conv-1', TURN_SHA);
    const videoPermit = issueVideoEditSpendPermit(dataRoot, {
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      allowedArtifactSha256: [SOURCE_SHA],
      operation: 'video_edit',
    })!;
    const grantHandle = (() => {
      const records = fs.readdirSync(path.join(dataRoot, 'command-eve-artifact-capabilities'));
      const grantFile = records.find((name) => name.length === 69)!;
      return (
        JSON.parse(fs.readFileSync(path.join(dataRoot, 'command-eve-artifact-capabilities', grantFile), 'utf8')) as {
          handle: string;
        }
      ).handle;
    })();
    const runManagedEdit = vi.fn();
    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, permit: videoPermit, instruction: 'heller' },
      editDeps(runManagedEdit)
    );
    expect(result).toMatchObject({ ok: false, reasonCode: 'image-edit-permit-operation-mismatch' });
    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('a consumed permit refuses before the provider — exactly one debit, and the permit store is the only ledger touched', async () => {
    seedActiveImage();
    const permit = issueImagePermit();
    // Spend the permit's one claim directly, as a completed first edit would.
    const consumed = consumeVideoEditSpendPermit(dataRoot, {
      permit,
      conversationId: 'conv-1',
      userTurnSha256: TURN_SHA,
      instructionSha256: crypto.createHash('sha256').update('heller').digest('hex'),
      artifactSha256: SOURCE_SHA,
    });
    expect(consumed).toEqual({ ok: true });

    const dir = path.join(dataRoot, 'command-eve-artifact-capabilities', 'by-artifact');
    const records = fs.readdirSync(path.join(dataRoot, 'command-eve-artifact-capabilities'));
    const grantFile = records.find((name) => name.length === 69)!;
    const grantHandle = (
      JSON.parse(fs.readFileSync(path.join(dataRoot, 'command-eve-artifact-capabilities', grantFile), 'utf8')) as {
        handle: string;
      }
    ).handle;
    expect(fs.readdirSync(dir).length).toBe(1);

    const runManagedEdit = vi.fn();
    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, permit, instruction: 'heller' },
      editDeps(runManagedEdit)
    );
    expect(result.ok).toBe(false);
    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('a tampered blob (bytes changed under the handle) refuses as artifact-changed before the provider', async () => {
    const source = seedActiveImage();
    const permit = issueImagePermit();
    fs.writeFileSync(
      path.join(dataRoot, 'command-eve-managed-image-artifacts', 'blobs', source.id),
      Buffer.from('tampered-bytes'),
      { mode: 0o600 }
    );
    const records = fs.readdirSync(path.join(dataRoot, 'command-eve-artifact-capabilities'));
    const grantFile = records.find((name) => name.length === 69)!;
    const grantHandle = (
      JSON.parse(fs.readFileSync(path.join(dataRoot, 'command-eve-artifact-capabilities', grantFile), 'utf8')) as {
        handle: string;
      }
    ).handle;

    const runManagedEdit = vi.fn();
    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, permit, instruction: 'heller' },
      editDeps(runManagedEdit)
    );
    expect(result).toMatchObject({ ok: false, reasonCode: 'image-edit-artifact-changed' });
    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('a disabled image-edit feature refuses before everything, including the permit check', async () => {
    const runManagedEdit = vi.fn();
    const result = await handleCommandEveImageEdit(
      { handle: 'evecap_x', instruction: 'heller' },
      { getDataPath: () => dataRoot, isImageEditEnabled: () => false, runManagedEdit }
    );
    expect(result).toMatchObject({ ok: false, reasonCode: 'image-edit-disabled' });
    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('captures Seat + revision before spend and refuses a changed Seat before provider execution', async () => {
    const source = seedActiveImage();
    const permit = issueImagePermit();
    const dir = path.join(dataRoot, 'command-eve-artifact-capabilities', 'by-artifact');
    const key = crypto.createHash('sha256').update(`conv-1|${source.id}`).digest('hex');
    const grantHandle = (JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')) as { handle: string })
      .handle;
    let revisionReads = 0;
    const runManagedEdit = vi.fn();

    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, permit, instruction: 'heller' },
      {
        ...editDeps(runManagedEdit),
        getActiveSeatContextRevision: () => (revisionReads++ === 0 ? 7 : 8),
      }
    );

    expect(result).toMatchObject({ ok: false, reasonCode: 'image-edit-seat-changed', retryable: true });
    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('holds the paid-artifact Seat fence across managed execution and releases it on refusal', async () => {
    const source = seedActiveImage();
    const permit = issueImagePermit();
    const dir = path.join(dataRoot, 'command-eve-artifact-capabilities', 'by-artifact');
    const key = crypto.createHash('sha256').update(`conv-1|${source.id}`).digest('hex');
    const grantHandle = (JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')) as { handle: string })
      .handle;
    const releasePaidArtifactOperation = vi.fn();
    const runManagedEdit = vi.fn(async () => ({
      status: 503,
      body: { error: { code: 'image_model_registry_unavailable', message: 'registry unavailable' } },
    }));

    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, permit, instruction: 'heller' },
      {
        ...editDeps(runManagedEdit),
        tryBeginPaidArtifactOperation: () => releasePaidArtifactOperation,
      }
    );

    expect(runManagedEdit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'image-edit-image_model_registry_unavailable',
      retryable: false,
    });
    expect(releasePaidArtifactOperation).toHaveBeenCalledTimes(1);
  });

  it('recovers an already-staged child from the completion receipt without a second provider call', async () => {
    const source = seedActiveImage();
    const permit = issueImagePermit();
    const dir = path.join(dataRoot, 'command-eve-artifact-capabilities', 'by-artifact');
    const key = crypto.createHash('sha256').update(`conv-1|${source.id}`).digest('hex');
    const grantHandle = (JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8')) as { handle: string })
      .handle;
    let childHandle = '';
    const runManagedEdit = vi.fn(async () => {
      const child = stageGeneratedImageArtifact(dataRoot, {
        bytes: Buffer.from('edited-child-bytes'),
        mimeType: 'image/png',
        tier: 'quality',
        model: 'gemini',
        resolution: '1K',
        aspectRatio: '16:9',
        promptSha256: crypto.createHash('sha256').update('heller').digest('hex'),
        parentArtifactId: source.id,
      })!;
      childHandle = child.handle;
      return {
        status: 200,
        body: { data: [{ artifact_handle: child.handle }] },
      };
    });
    const deps = editDeps(runManagedEdit);

    await expect(
      handleCommandEveImageEdit({ handle: grantHandle, permit, instruction: 'heller' }, deps)
    ).resolves.toEqual({ ok: true, artifactHandle: expect.any(String), parentArtifactId: source.id });
    await expect(
      handleCommandEveImageEdit({ handle: grantHandle, permit, instruction: 'heller' }, deps)
    ).resolves.toEqual({ ok: true, artifactHandle: childHandle, parentArtifactId: source.id });
    expect(runManagedEdit).toHaveBeenCalledTimes(1);
  });
});

describe('handleCommandEveImageGenerate', () => {
  it('passes the exact Main-authoritative tier, resolution, aspect and granted reference bytes, then binds once', async () => {
    const record = seedActiveImage();
    const referencePath = path.join(dataRoot, 'reference.png');
    const runManagedGeneration = vi.fn(async () => ({
      status: 200,
      body: { data: [{ artifact_handle: CHILD_HANDLE }] },
    }));
    const bind = vi.fn(() => ({ ok: true as const, record, alreadyBound: false }));
    const onFreshBind = vi.fn();
    const deps = imageGenerateDeps(record, { runManagedGeneration, bind, onFreshBind });

    const result = await handleCommandEveImageGenerate(
      imageGenerateRequest({ prompt: '  Ein ruhiges Editorial-Motiv  ', referenceImagePaths: [referencePath] }),
      deps
    );

    expect(result).toEqual({
      ok: true,
      requestId: 'image-request-0001',
      artifact: record,
      alreadyCompleted: false,
    });
    expect(runManagedGeneration).toHaveBeenCalledTimes(1);
    const [input, options] = runManagedGeneration.mock.calls[0];
    expect(input).toMatchObject({
      model: 'command-eve-visual-direction-v1',
      prompt: 'Ein ruhiges Editorial-Motiv',
      n: 1,
      aspect_ratio: '16:9',
      resolution: '2K',
    });
    expect(input.input_references).toHaveLength(1);
    expect(input.input_references[0].image_url.url).toBe(`data:image/png;base64,${SOURCE_BYTES.toString('base64')}`);
    expect(options).toMatchObject({
      dataPath: dataRoot,
      requestedTier: 'quality',
      requestId: 'image-request-0001',
      expectedSeat: { id: 'seat-1', revision: 7 },
    });
    expect(bind).toHaveBeenCalledWith(dataRoot, {
      conversationId: 'conv-1',
      handle: CHILD_HANDLE,
      toolCallId: 'image-generate:image-request-0001',
    });
    expect(onFreshBind).toHaveBeenCalledWith('conv-1');
  });

  it('refuses ungranted or malformed reference paths before any read or provider call', async () => {
    const record = seedActiveImage();
    const readImageSource = vi.fn();
    const runManagedGeneration = vi.fn();
    const deniedDeps = imageGenerateDeps(record, {
      areFileSelectionPathsGranted: () => false,
      readImageSource,
      runManagedGeneration,
    });
    const denied = await handleCommandEveImageGenerate(
      imageGenerateRequest({ referenceImagePaths: [path.join(dataRoot, 'reference.png')] }),
      deniedDeps
    );
    expect(denied).toMatchObject({ ok: false, reasonCode: 'image-generate-reference-not-granted' });
    expect(readImageSource).not.toHaveBeenCalled();
    expect(runManagedGeneration).not.toHaveBeenCalled();

    const malformed = await handleCommandEveImageGenerate(
      imageGenerateRequest({
        requestId: 'image-request-0002',
        referenceImagePaths: ['../reference.png'],
      }),
      imageGenerateDeps(record, { runManagedGeneration })
    );
    expect(malformed).toMatchObject({ ok: false, reasonCode: 'image-generate-reference-path-invalid' });
    expect(runManagedGeneration).not.toHaveBeenCalled();
  });

  it.each([
    [{ prompt: '   ' }, 'image-generate-prompt-invalid'],
    [{ conversationId: '../conv' }, 'image-generate-conversation-invalid'],
    [{ requestId: 'short' }, 'image-generate-request-id-invalid'],
    [{ tierId: 'provider-slug' }, 'image-generate-tier-invalid'],
    [{ resolution: '4K' }, 'image-generate-resolution-invalid'],
    [{ aspectRatio: '17:9' }, 'image-generate-aspect-ratio-invalid'],
  ] as const)('strictly refuses malformed option %j before provider', async (override, reasonCode) => {
    const record = seedActiveImage();
    const runManagedGeneration = vi.fn();
    const request = { ...imageGenerateRequest(), ...override } as CommandEveImageGenerateRequest;
    const result = await handleCommandEveImageGenerate(request, imageGenerateDeps(record, { runManagedGeneration }));
    expect(result).toMatchObject({ ok: false, reasonCode });
    expect(runManagedGeneration).not.toHaveBeenCalled();
  });

  it('coalesces an identical request id, refuses a second request in the conversation, and replays completion', async () => {
    const record = seedActiveImage();
    let resolveManaged!: (result: { status: number; body: Record<string, unknown> }) => void;
    const runManagedGeneration = vi.fn(
      () =>
        new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
          resolveManaged = resolve;
        })
    );
    const deps = imageGenerateDeps(record, { runManagedGeneration });
    const request = imageGenerateRequest();

    const first = handleCommandEveImageGenerate(request, deps);
    await vi.waitFor(() => expect(runManagedGeneration).toHaveBeenCalledTimes(1));
    const duplicate = handleCommandEveImageGenerate(request, deps);
    const competing = await handleCommandEveImageGenerate(
      imageGenerateRequest({ requestId: 'image-request-0002' }),
      deps
    );
    expect(competing).toMatchObject({ ok: false, reasonCode: 'image-generate-already-in-flight' });

    resolveManaged({ status: 200, body: { data: [{ artifact_handle: CHILD_HANDLE }] } });
    await expect(first).resolves.toMatchObject({ ok: true, alreadyCompleted: false });
    await expect(duplicate).resolves.toMatchObject({ ok: true, alreadyCompleted: false });
    await expect(handleCommandEveImageGenerate(request, deps)).resolves.toMatchObject({
      ok: true,
      alreadyCompleted: true,
    });
    expect(runManagedGeneration).toHaveBeenCalledTimes(1);

    await expect(handleCommandEveImageGenerate({ ...request, prompt: 'Andere Anfrage' }, deps)).resolves.toMatchObject({
      ok: false,
      reasonCode: 'image-generate-request-id-conflict',
    });
    expect(runManagedGeneration).toHaveBeenCalledTimes(1);
  });

  it('checks the captured seat after provider completion and never binds across a revision change', async () => {
    const record = seedActiveImage();
    let revision = 7;
    const bind = vi.fn();
    const runManagedGeneration = vi.fn(async () => {
      revision = 8;
      return { status: 200, body: { data: [{ artifact_handle: CHILD_HANDLE }] } };
    });
    const result = await handleCommandEveImageGenerate(
      imageGenerateRequest(),
      imageGenerateDeps(record, {
        getActiveSeatContextRevision: () => revision,
        runManagedGeneration,
        bind,
      })
    );
    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'image-generate-seat-changed',
      artifactState: 'stored_not_bound',
    });
    expect(bind).not.toHaveBeenCalled();
  });

  it('reports generated-but-not-stored distinctly and does not attempt a bind', async () => {
    const record = seedActiveImage();
    const bind = vi.fn();
    const result = await handleCommandEveImageGenerate(
      imageGenerateRequest(),
      imageGenerateDeps(record, {
        runManagedGeneration: vi.fn(async () => ({
          status: 502,
          body: {
            error: {
              code: 'managed_image_stage_failed',
              message: 'Managed image was generated but could not be stored locally.',
            },
          },
        })),
        bind,
      })
    );
    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'managed_image_stage_failed',
      retryable: false,
      artifactState: 'created_not_stored',
    });
    expect(bind).not.toHaveBeenCalled();
  });
});

describe('bind / list / preview / import handlers', () => {
  it('bind handler: staged -> active through the IPC-shaped request; invalid requests refuse', async () => {
    const staged = stageGeneratedImageArtifact(dataRoot, {
      bytes: SOURCE_BYTES,
      mimeType: 'image/png',
      tier: 'quality',
      model: 'gemini',
      resolution: '1K',
      aspectRatio: '16:9',
      promptSha256: PROMPT_SHA,
    })!;
    const deps = { getDataPath: () => dataRoot };
    const result = await handleCommandEveImageArtifactBind(
      { conversationId: 'conv-1', handle: staged.handle, toolCallId: 'call-1' },
      deps
    );
    expect(result).toMatchObject({ ok: true, alreadyBound: false });
    expect(
      await handleCommandEveImageArtifactBind({ conversationId: '', handle: staged.handle, toolCallId: 'c' }, deps)
    ).toEqual({ ok: false, reason: 'handle-malformed' });

    const listed = await handleCommandEveImageArtifactsList({ conversationId: 'conv-1' }, deps);
    expect(listed.length).toBe(1);
    expect(JSON.stringify(listed)).not.toContain(dataRoot);
  });

  it('preview handler: serves the active record by id, hash-verified — and refuses other conversations and tampered blobs', async () => {
    const source = seedActiveImage();
    const deps = { getDataPath: () => dataRoot };
    const preview = await handleCommandEveImageArtifactPreview(
      { conversationId: 'conv-1', artifactId: source.id },
      deps
    );
    expect(preview).toMatchObject({ mime_type: 'image/png', size: SOURCE_BYTES.length });
    expect(Buffer.from(preview!.data_base64, 'base64').equals(SOURCE_BYTES)).toBe(true);

    expect(
      await handleCommandEveImageArtifactPreview({ conversationId: 'conv-2', artifactId: source.id }, deps)
    ).toBeNull();
    expect(
      await handleCommandEveImageArtifactPreview({ conversationId: 'conv-1', artifactId: 'img_nope' }, deps)
    ).toBeNull();

    fs.writeFileSync(
      path.join(dataRoot, 'command-eve-managed-image-artifacts', 'blobs', source.id),
      Buffer.from('tampered'),
      { mode: 0o600 }
    );
    expect(
      await handleCommandEveImageArtifactPreview({ conversationId: 'conv-1', artifactId: source.id }, deps)
    ).toBeNull();
  });

  it('import handler: canonical binding through the fence; exact-file accept; traversal and malformed requests refuse', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-import-ws-'));
    try {
      fs.writeFileSync(path.join(workspaceRoot, 'img-1785796180699.png'), SOURCE_BYTES);
      const deps = { getDataPath: () => dataRoot, workspaceRootForLegacyId: () => workspaceRoot };
      const accepted = await handleCommandEveImageArtifactImportLegacy(
        {
          conversationId: '3be29bae',
          legacyWorkspaceId: 'hermes-temp-3be29bae',
          expectedFileName: 'img-1785796180699.png',
        },
        deps
      );
      expect(accepted).toMatchObject({ ok: true, alreadyImported: false });
      if (accepted.ok) expect(accepted.record.conversation_id).toBe('3be29bae');
      // The canonical surface lists it; the workspace-folder id lists nothing.
      expect((await handleCommandEveImageArtifactsList({ conversationId: '3be29bae' }, deps)).length).toBe(1);
      expect(await handleCommandEveImageArtifactsList({ conversationId: 'hermes-temp-3be29bae' }, deps)).toEqual([]);

      const refused = await handleCommandEveImageArtifactImportLegacy(
        {
          conversationId: '3be29bae',
          legacyWorkspaceId: 'hermes-temp-3be29bae',
          expectedFileName: '../img-1785796180699.png',
        },
        deps
      );
      expect(refused).toEqual({ ok: false, reason: 'invalid-request' });
      const mismatched = await handleCommandEveImageArtifactImportLegacy(
        {
          conversationId: '3be29bae',
          legacyWorkspaceId: 'hermes-temp-other',
          expectedFileName: 'img-1785796180699.png',
        },
        deps
      );
      expect(mismatched).toEqual({ ok: false, reason: 'workspace-id-mismatch' });
      expect(
        await handleCommandEveImageArtifactImportLegacy(
          { conversationId: '', legacyWorkspaceId: 'hermes-temp-3be29bae', expectedFileName: 'x.png' },
          deps
        )
      ).toEqual({ ok: false, reason: 'invalid-request' });
      expect(
        await handleCommandEveImageArtifactImportLegacy(
          { conversationId: '3be29bae', expectedFileName: 'x.png' } as never,
          deps
        )
      ).toEqual({ ok: false, reason: 'invalid-request' });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('IPC bridge wrapper: legacyWorkspaceId reaches the store with the workspace root it resolves', async () => {
    // Regression pin for the type-contract leak: the Bridge wrapper dropped
    // legacyWorkspaceId from its request type while the inner handler already
    // required it. Typed spies (no `as never` — the contract is the point)
    // prove the full pass-through, end to end.
    const source = seedActiveImage();
    const importCalls: Array<{ dataPath: string; input: Parameters<typeof importLegacyImageArtifact>[1] }> = [];
    const deps: CommandEveImageArtifactImportLegacyDeps = {
      getDataPath: () => dataRoot,
      importLegacy: (dataPath, input) => {
        importCalls.push({ dataPath, input });
        return { ok: true, record: source, alreadyImported: false };
      },
      workspaceRootForLegacyId: (legacyWorkspaceId) => `/tmp/ws/${legacyWorkspaceId}`,
    };
    const result = await handleCommandEveImageArtifactImportLegacyBridge(
      { conversationId: '3be29bae', legacyWorkspaceId: 'hermes-temp-3be29bae', expectedFileName: 'img-1.png' },
      deps
    );
    expect(importCalls).toEqual([
      {
        dataPath: dataRoot,
        input: {
          conversationId: '3be29bae',
          legacyWorkspaceId: 'hermes-temp-3be29bae',
          expectedFileName: 'img-1.png',
          workspaceRoot: '/tmp/ws/hermes-temp-3be29bae',
        },
      },
    ]);
    expect(result).toEqual({ success: true, data: { ok: true, record: source, alreadyImported: false } });
  });
});
