import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  handleCommandEveImageArtifactBind,
  handleCommandEveImageArtifactImportLegacy,
  handleCommandEveImageArtifactPreview,
  handleCommandEveImageArtifactsList,
  handleCommandEveImageEdit,
  type CommandEveImageEditDeps,
} from '@/process/bridge/commandEveImageArtifactBridge';
import {
  bindStagedImageArtifact,
  readImageArtifactBytes,
  readImageArtifactRecordById,
  stageGeneratedImageArtifact,
} from '@/process/commandEve/imageArtifactStore';
import {
  consumeVideoEditSpendPermit,
  issueVideoEditSpendPermit,
  recordActiveUserTurn,
  reinitializeVideoEditSpendStore,
} from '@/process/commandEve/videoEditSpendPermitStore';
import type { CommandEveActiveImageArtifact } from '@/common/config/managedImageArtifactCore';

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
    isImageEditEnabled: () => true,
    runManagedEdit,
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

  it('a disabled seat refuses before everything, including the permit check', async () => {
    const runManagedEdit = vi.fn();
    const result = await handleCommandEveImageEdit(
      { handle: 'evecap_x', instruction: 'heller' },
      { getDataPath: () => dataRoot, isImageEditEnabled: () => false, runManagedEdit }
    );
    expect(result).toMatchObject({ ok: false, reasonCode: 'image-edit-disabled' });
    expect(runManagedEdit).not.toHaveBeenCalled();
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
        { conversationId: '3be29bae', legacyWorkspaceId: 'hermes-temp-3be29bae', expectedFileName: 'img-1785796180699.png' },
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
        { conversationId: '3be29bae', legacyWorkspaceId: 'hermes-temp-other', expectedFileName: 'img-1785796180699.png' },
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
        await handleCommandEveImageArtifactImportLegacy({ conversationId: '3be29bae', expectedFileName: 'x.png' } as never, deps)
      ).toEqual({ ok: false, reason: 'invalid-request' });
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
