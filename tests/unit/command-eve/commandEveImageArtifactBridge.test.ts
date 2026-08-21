import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleCommandEveImageArtifactBind,
  handleCommandEveImageArtifactImportLegacy,
  handleCommandEveImageArtifactImportLegacyBridge,
  handleCommandEveImageArtifactPreview,
  handleCommandEveImageArtifactsList,
  handleCommandEveImageEdit,
  type CommandEveImageArtifactImportLegacyDeps,
  type CommandEveImageEditDeps,
} from '@/process/bridge/commandEveImageArtifactBridge';
import {
  bindStagedImageArtifact,
  readImageArtifactBytes,
  readImageArtifactRecordById,
  stageGeneratedImageArtifact,
} from '@/process/commandEve/imageArtifactStore';
import type { importLegacyImageArtifact } from '@/process/commandEve/imageArtifactStore';
import {
  clearCommandEveFileSelectionGrantsForTests,
  registerCommandEveFileSelectionGrant,
} from '@/process/commandEve/fileSelectionGrantCore';
import type { CommandEveActiveImageArtifact } from '@/common/config/managedImageArtifactCore';

const SOURCE_BYTES = Buffer.from('source-image-bytes');
const SOURCE_SHA = crypto.createHash('sha256').update(SOURCE_BYTES).digest('hex');
const PROMPT_SHA = crypto.createHash('sha256').update('prompt').digest('hex');
const CHILD_HANDLE = `img_h_${'9'.repeat(64)}`;
const REQUEST_ID = 'a'.repeat(64);
const SEAT_ID = 'seat-1';

let dataRoot: string;

/** A REAL staged-then-bound image in the real store, grant minted for real. */
function seedActiveImage(conversationId = 'conv-1'): CommandEveActiveImageArtifact {
  const staged = stageGeneratedImageArtifact(dataRoot, {
    capturedSeatId: SEAT_ID,
    bytes: SOURCE_BYTES,
    mimeType: 'image/png',
    tier: 'quality',
    model: 'gemini',
    resolution: '1K',
    aspectRatio: '16:9',
    promptSha256: PROMPT_SHA,
  })!;
  const bound = bindStagedImageArtifact(dataRoot, {
    conversationId,
    handle: staged.handle,
    toolCallId: 'call-1',
    expectedSeatId: SEAT_ID,
  });
  if (bound.ok === false) throw new Error(`seed failed: ${bound.reason}`);
  return bound.record;
}

function imageEditHandleFor(conversationId: string, artifactId: string): string {
  const key = crypto.createHash('sha256').update(`image_edit|${SEAT_ID}|${conversationId}|${artifactId}`).digest('hex');
  const file = path.join(dataRoot, 'command-eve-artifact-capabilities', 'by-artifact', `${key}.json`);
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { handle: string }).handle;
}

function editDeps(runManagedEdit: CommandEveImageEditDeps['runManagedEdit']): CommandEveImageEditDeps {
  return {
    getDataPath: () => dataRoot,
    getActiveSeatId: () => SEAT_ID,
    getActiveSeatContextRevision: () => 7,
    getPaidArtifactBlockReason: () => null,
    tryBeginPaidArtifactOperation: () => vi.fn(),
    isImageEditEnabled: () => true,
    runManagedEdit,
  };
}

type ManagedEditInput = Parameters<NonNullable<CommandEveImageEditDeps['runManagedEdit']>>[0];

function stageManagedEditChild(input: ManagedEditInput, instruction: string) {
  return stageGeneratedImageArtifact(dataRoot, {
    capturedSeatId: SEAT_ID,
    bytes: Buffer.from(`edited-child-bytes:${instruction}`),
    mimeType: 'image/png',
    tier: 'quality',
    model: 'gemini',
    resolution: '1K',
    aspectRatio: '16:9',
    promptSha256: crypto.createHash('sha256').update(instruction).digest('hex'),
    parentArtifactId: input.parentArtifactId,
    editRequestSha256: input.requestId,
  })!;
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-image-bridge-'));
});

afterEach(() => {
  clearCommandEveFileSelectionGrantsForTests();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('handleCommandEveImageEdit', () => {
  it('valid handle + logical call identity stages a child with parent set, source untouched, and source bytes forwarded', async () => {
    const source = seedActiveImage();
    const grantHandle = (() => {
      // The handle the envelope would carry: the durable grant minted at bind.
      return imageEditHandleFor('conv-1', source.id);
    })();
    let childHandle = '';
    const runManagedEdit = vi.fn(async (input: ManagedEditInput) => {
      const child = stageManagedEditChild(input, 'mach den Himmel bedeckt');
      childHandle = child.handle;
      return {
        status: 200,
        body: {
          created: 1,
          data: [{ artifact_handle: child.handle, media_type: 'image/png', sha256: 'f'.repeat(64), bytes_count: 10 }],
        },
      };
    });

    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, instruction: 'mach den Himmel bedeckt', requestId: REQUEST_ID },
      editDeps(runManagedEdit)
    );

    expect(result).toEqual({ ok: true, artifactHandle: childHandle, parentArtifactId: source.id });
    expect(runManagedEdit).toHaveBeenCalledTimes(1);
    const call = runManagedEdit.mock.calls[0][0];
    expect(call.parentArtifactId).toBe(source.id);
    expect(call.instruction).toBe('mach den Himmel bedeckt');
    expect(call.dataPath).toBe(dataRoot);
    expect(call.expectedSeat).toEqual({ id: 'seat-1', revision: 7 });
    expect(call.requestId).toBe(REQUEST_ID);
    // The reference rides as a data URL built from EXACTLY the private bytes.
    expect(call.referenceDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    const decoded = Buffer.from(call.referenceDataUrl.slice('data:image/png;base64,'.length), 'base64');
    expect(decoded.equals(SOURCE_BYTES)).toBe(true);
    // The ORIGINAL artifact is untouched: record and bytes identical.
    const after = readImageArtifactRecordById(dataRoot, source.id, SEAT_ID)!;
    expect(after.status).toBe('active');
    expect(after.payload.sha256).toBe(SOURCE_SHA);
    expect(readImageArtifactBytes(dataRoot, source.id, SEAT_ID)?.equals(SOURCE_BYTES)).toBe(true);
  });

  it('refuses a missing logical call identity before the grant or provider', async () => {
    const runManagedEdit = vi.fn();
    const result = await handleCommandEveImageEdit(
      { handle: `evecap_${'1'.repeat(64)}`, instruction: 'heller' },
      editDeps(runManagedEdit)
    );
    expect(result).toMatchObject({ ok: false, reasonCode: 'image-edit-request-identity-missing' });
    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('refuses an uppercase logical call identity before the grant or provider', async () => {
    const runManagedEdit = vi.fn();
    const result = await handleCommandEveImageEdit(
      { handle: `evecap_${'1'.repeat(64)}`, instruction: 'heller', requestId: REQUEST_ID.toUpperCase() },
      editDeps(runManagedEdit)
    );
    expect(result).toMatchObject({ ok: false, reasonCode: 'image-edit-request-identity-missing' });
    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('unknown, malformed and cross-conversation handles refuse before the provider', async () => {
    seedActiveImage();
    const runManagedEdit = vi.fn();

    const unknown = await handleCommandEveImageEdit(
      { handle: `evecap_${'2'.repeat(64)}`, instruction: 'heller', requestId: REQUEST_ID },
      editDeps(runManagedEdit)
    );
    expect(unknown).toMatchObject({
      ok: false,
      reasonCode: 'image-edit-handle-unknown',
      message: 'Dieser Bildbezug ist unbekannt — es wurde nichts bearbeitet.',
    });
    expect(unknown.ok === false ? unknown.message : '').not.toContain('Video');

    const malformed = await handleCommandEveImageEdit(
      { handle: 'evecap_nope', instruction: 'heller', requestId: REQUEST_ID },
      editDeps(runManagedEdit)
    );
    expect(malformed).toMatchObject({ ok: false, reasonCode: 'image-edit-handle-unknown' });

    // A grant minted for ANOTHER conversation's artifact, presented with this
    // conversation as the caller fence.
    const other = seedActiveImage('conv-2');
    const otherHandle = imageEditHandleFor('conv-2', other.id);
    const cross = await handleCommandEveImageEdit(
      { handle: otherHandle, instruction: 'heller', requestId: REQUEST_ID, conversationId: 'conv-1' },
      editDeps(runManagedEdit)
    );
    expect(cross).toMatchObject({ ok: false, reasonCode: 'image-edit-conversation-mismatch' });

    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('an expired grant (read as absent) refuses before the provider', async () => {
    const source = seedActiveImage();
    const runManagedEdit = vi.fn();
    const result = await handleCommandEveImageEdit(
      { handle: `evecap_${'3'.repeat(64)}`, instruction: 'heller', requestId: REQUEST_ID },
      { ...editDeps(runManagedEdit), readGrant: () => undefined }
    );
    expect(result).toMatchObject({ ok: false, reasonCode: 'image-edit-handle-unknown' });
    expect(runManagedEdit).not.toHaveBeenCalled();
    expect(readImageArtifactRecordById(dataRoot, source.id, SEAT_ID)).toBeTruthy();
  });

  it('a changed visible image recovers from the private source before the provider', async () => {
    const source = seedActiveImage();
    fs.writeFileSync(
      path.join(dataRoot, 'command-eve-temp-artifacts', 'conv-1', ...source.payload.path.split('/')),
      Buffer.from('tampered-image-xyz'),
      { mode: 0o600 }
    );
    const records = fs.readdirSync(path.join(dataRoot, 'command-eve-artifact-capabilities'));
    const grantFile = records.find((name) => name.length === 69)!;
    const grantHandle = (
      JSON.parse(fs.readFileSync(path.join(dataRoot, 'command-eve-artifact-capabilities', grantFile), 'utf8')) as {
        handle: string;
      }
    ).handle;

    let childHandle = '';
    const runManagedEdit = vi.fn(async (input: ManagedEditInput) => {
      const child = stageManagedEditChild(input, 'heller');
      childHandle = child.handle;
      return {
        status: 200,
        body: {
          created: 1,
          data: [{ artifact_handle: child.handle, media_type: 'image/png', sha256: 'f'.repeat(64), bytes_count: 10 }],
        },
      };
    });
    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, instruction: 'heller', requestId: REQUEST_ID },
      editDeps(runManagedEdit)
    );
    expect(result).toEqual({ ok: true, artifactHandle: childHandle, parentArtifactId: source.id });
    const call = runManagedEdit.mock.calls[0][0];
    expect(Buffer.from(call.referenceDataUrl.split(',')[1], 'base64')).toEqual(SOURCE_BYTES);
  });

  it('changed visible and private copies refuse as artifact-changed before the provider', async () => {
    const source = seedActiveImage();
    fs.writeFileSync(
      path.join(dataRoot, 'command-eve-temp-artifacts', 'conv-1', ...source.payload.path.split('/')),
      Buffer.from('tampered-visible-xyz'),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(dataRoot, 'command-eve-managed-image-artifacts', 'blobs', source.id),
      Buffer.from('tampered-private-xyz'),
      { mode: 0o600 }
    );
    const grantHandle = imageEditHandleFor('conv-1', source.id);
    const runManagedEdit = vi.fn();

    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, instruction: 'heller', requestId: REQUEST_ID },
      editDeps(runManagedEdit)
    );
    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'image-edit-artifact-changed',
      message: 'Die Bilddatei hat sich seit dem Erstellen geändert — die Bearbeitung wurde abgebrochen.',
    });
    expect(runManagedEdit).not.toHaveBeenCalled();
  });

  it('a disabled image-edit feature refuses before everything, including the logical call identity check', async () => {
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
    const grantHandle = imageEditHandleFor('conv-1', source.id);
    let revisionReads = 0;
    const runManagedEdit = vi.fn();

    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, instruction: 'heller', requestId: REQUEST_ID },
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
    const grantHandle = imageEditHandleFor('conv-1', source.id);
    const releasePaidArtifactOperation = vi.fn();
    const runManagedEdit = vi.fn(async () => ({
      status: 503,
      body: { error: { code: 'image_model_registry_unavailable', message: 'registry unavailable' } },
    }));

    const result = await handleCommandEveImageEdit(
      { handle: grantHandle, instruction: 'heller', requestId: REQUEST_ID },
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

  it('recovers an already-staged child for the same logical call without a second provider call', async () => {
    const source = seedActiveImage();
    const grantHandle = imageEditHandleFor('conv-1', source.id);
    let childHandle = '';
    const runManagedEdit = vi.fn(async (input: ManagedEditInput) => {
      const child = stageManagedEditChild(input, 'heller');
      childHandle = child.handle;
      return {
        status: 200,
        body: { data: [{ artifact_handle: child.handle }] },
      };
    });
    const deps = editDeps(runManagedEdit);

    await expect(
      handleCommandEveImageEdit({ handle: grantHandle, instruction: 'heller', requestId: REQUEST_ID }, deps)
    ).resolves.toEqual({ ok: true, artifactHandle: expect.any(String), parentArtifactId: source.id });
    await expect(
      handleCommandEveImageEdit({ handle: grantHandle, instruction: 'heller', requestId: REQUEST_ID }, deps)
    ).resolves.toEqual({ ok: true, artifactHandle: childHandle, parentArtifactId: source.id });
    expect(runManagedEdit).toHaveBeenCalledTimes(1);
  });

  it('never reports success when the provider handle does not resolve to the exact staged child', async () => {
    const source = seedActiveImage();
    const grantHandle = imageEditHandleFor('conv-1', source.id);
    const runManagedEdit = vi.fn(async () => ({
      status: 200,
      body: { data: [{ artifact_handle: CHILD_HANDLE }] },
    }));

    await expect(
      handleCommandEveImageEdit(
        { handle: grantHandle, instruction: 'heller', requestId: REQUEST_ID },
        editDeps(runManagedEdit)
      )
    ).resolves.toMatchObject({ ok: false, reasonCode: 'image-edit-stage-failed', retryable: true });
    expect(runManagedEdit).toHaveBeenCalledTimes(1);
  });
});

describe('bind / list / preview / import handlers', () => {
  it('bind handler: staged -> active through the IPC-shaped request; invalid requests refuse', async () => {
    const staged = stageGeneratedImageArtifact(dataRoot, {
      capturedSeatId: SEAT_ID,
      bytes: SOURCE_BYTES,
      mimeType: 'image/png',
      tier: 'quality',
      model: 'gemini',
      resolution: '1K',
      aspectRatio: '16:9',
      promptSha256: PROMPT_SHA,
    })!;
    const deps = { getDataPath: () => dataRoot, getActiveSeatId: () => SEAT_ID };
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

  it('list handler fails closed when the active seat changes during reconcile', async () => {
    seedActiveImage();
    let activeSeatId = SEAT_ID;
    let seatContextRevision = 7;
    const listRecords = vi.fn(() => []);
    const listed = await handleCommandEveImageArtifactsList(
      { conversationId: 'conv-1' },
      {
        getDataPath: () => dataRoot,
        getActiveSeatId: () => activeSeatId,
        getActiveSeatContextRevision: () => seatContextRevision,
        listRecords,
        reconcileBeforeList: async (_conversationId, expectedSeatId, expectedSeatRevision) => {
          expect(expectedSeatId).toBe(SEAT_ID);
          expect(expectedSeatRevision).toBe(7);
          activeSeatId = 'seat-b';
          seatContextRevision = 8;
        },
      }
    );

    expect(listed).toEqual([]);
    expect(listRecords).not.toHaveBeenCalled();
  });

  it('preview handler recovers from one good copy and refuses only when both copies are invalid', async () => {
    const source = seedActiveImage();
    const deps = { getDataPath: () => dataRoot, getActiveSeatId: () => SEAT_ID };
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
      path.join(dataRoot, 'command-eve-temp-artifacts', 'conv-1', ...source.payload.path.split('/')),
      Buffer.from('tampered-image-xyz'),
      { mode: 0o600 }
    );
    const recovered = await handleCommandEveImageArtifactPreview(
      { conversationId: 'conv-1', artifactId: source.id },
      deps
    );
    expect(Buffer.from(recovered!.data_base64, 'base64')).toEqual(SOURCE_BYTES);

    fs.writeFileSync(
      path.join(dataRoot, 'command-eve-managed-image-artifacts', 'blobs', source.id),
      Buffer.from('tampered-private-xyz'),
      { mode: 0o600 }
    );
    expect(
      await handleCommandEveImageArtifactPreview({ conversationId: 'conv-1', artifactId: source.id }, deps)
    ).toBeNull();
  });

  it('legacy import handler refuses Seat B from claiming deterministic pre-Seat bytes', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-import-ws-'));
    try {
      fs.writeFileSync(path.join(workspaceRoot, 'img-1785796180699.png'), SOURCE_BYTES);

      await expect(
        handleCommandEveImageArtifactImportLegacy(
          {
            conversationId: '3be29bae',
            legacyWorkspaceId: 'hermes-temp-3be29bae',
            expectedFileName: 'img-1785796180699.png',
          },
          {
            getDataPath: () => dataRoot,
            getActiveSeatId: () => 'seat-b',
            workspaceRootForLegacyId: () => workspaceRoot,
          }
        )
      ).resolves.toEqual({ ok: false, reason: 'invalid-request' });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('import handler: canonical binding through the fence; exact-file accept; traversal and malformed requests refuse', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-import-ws-'));
    try {
      fs.writeFileSync(path.join(workspaceRoot, 'img-1785796180699.png'), SOURCE_BYTES);
      const deps = {
        getDataPath: () => dataRoot,
        getActiveSeatId: () => SEAT_ID,
        workspaceRootForLegacyId: () => workspaceRoot,
      };
      expect(
        registerCommandEveFileSelectionGrant({
          filePath: path.join(workspaceRoot, 'img-1785796180699.png'),
          seatId: SEAT_ID,
          purpose: 'read',
        })
      ).toBe(true);
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
      getActiveSeatId: () => SEAT_ID,
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
          capturedSeatId: SEAT_ID,
        },
      },
    ]);
    expect(result).toEqual({ success: true, data: { ok: true, record: source, alreadyImported: false } });
  });
});
