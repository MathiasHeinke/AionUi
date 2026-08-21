import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
  commandEveOfficeFingerprint,
  commandEveOfficeMimeType,
  type CommandEveOfficeConversationArtifactPayload,
} from '@/common/types/office/artifactLineage';
import {
  resolveCommandEveOfficeArtifactAttachment,
  resolveCommandEveOfficeConversationAuthority,
  validateOfficePackageBuffer,
  type CommandEveOfficeArtifactAttachmentDeps,
} from '@/process/commandEve/officeArtifactAttachmentCore';
import {
  handleCommandEveArtifactContextEnvelope,
  type CommandEveArtifactContextEnvelopeDeps,
} from '@/process/bridge/commandEveVideoBridge';
import {
  commandEveOfficeArtifactPayloadSha256,
  commandEveOfficeArtifactRelativePath,
  ProjectWorkspaceConversationArtifactStore,
} from '@/process/services/project-workspace/storage/conversationArtifactStore';

const WORD_PACKAGE = Buffer.from(
  'UEsDBBQAAAAAAPZjD13HHBc8CAAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDxUeXBlcy8+UEsDBBQAAAAAAPZjD10RXudMBwAAAAcAAAARAAAAd29yZC9kb2N1bWVudC54bWw8cm9vdC8+UEsBAhQDFAAAAAAA9mMPXcccFzwIAAAACAAAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAAAAD2Yw9dEV7nTAcAAAAHAAAAEQAAAAAAAAAAAAAAgAE5AAAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAIAAgCAAAAAbwAAAAAA',
  'base64'
);
const EXCEL_PACKAGE = Buffer.from(
  'UEsDBBQAAAAAAPZjD13HHBc8CAAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDxUeXBlcy8+UEsDBBQAAAAAAPZjD10RXudMBwAAAAcAAAAPAAAAeGwvd29ya2Jvb2sueG1sPHJvb3QvPlBLAQIUAxQAAAAAAPZjD13HHBc8CAAAAAgAAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAAA9mMPXRFe50wHAAAABwAAAA8AAAAAAAAAAAAAAIABOQAAAHhsL3dvcmtib29rLnhtbFBLBQYAAAAAAgACAH4AAABtAAAAAAA=',
  'base64'
);
const INVALID_PACKAGE = Buffer.from(
  'UEsDBBQAAAAAAPZjD13HHBc8CAAAAAgAAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDxUeXBlcy8+UEsDBBQAAAAAAPZjD10RXudMBwAAAAcAAAARAAAAZG9jUHJvcHMvY29yZS54bWw8cm9vdC8+UEsBAhQDFAAAAAAA9mMPXcccFzwIAAAACAAAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAAAAD2Yw9dEV7nTAcAAAAHAAAAEQAAAAAAAAAAAAAAgAE5AAAAZG9jUHJvcHMvY29yZS54bWxQSwUGAAAAAAIAAgCAAAAAbwAAAAAA',
  'base64'
);

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const processGlobals = globalThis as typeof globalThis & { __backendPort?: number };
const originalBackendPort = processGlobals.__backendPort;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  processGlobals.__backendPort = originalBackendPort;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it('resolves the production fetch lazily after the local capability boundary is installed', async () => {
  processGlobals.__backendPort = 18181;
  const capabilityFetch = vi.fn<typeof fetch>(async () => jsonResponse({ id: 'conv-lazy-fetch', extra: {} }));
  globalThis.fetch = capabilityFetch;

  const result = await resolveCommandEveOfficeConversationAuthority('conv-lazy-fetch');

  expect(result).toMatchObject({ status: 'temporary' });
  expect(capabilityFetch).toHaveBeenCalledOnce();
  expect(String(capabilityFetch.mock.calls[0]?.[0])).toBe('http://127.0.0.1:18181/api/conversations/conv-lazy-fetch');
});

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-office-artifact-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const hermesHome = path.join(root, 'hermes-home');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(hermesHome, { recursive: true });
  return { root, workspace, hermesHome };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeDeps(options: {
  workspace: string;
  hermesHome: string;
  message?: Record<string, unknown>;
  artifacts?: unknown[];
}): CommandEveOfficeArtifactAttachmentDeps {
  return {
    fetch: (async (url: string | URL | Request) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/messages/msg-1')) return jsonResponse(options.message ?? null);
      if (pathname.endsWith('/artifacts')) return jsonResponse(options.artifacts ?? []);
      if (pathname.endsWith('/api/conversations/conv-1')) {
        return jsonResponse({ id: 'conv-1', extra: { workspace: options.workspace } });
      }
      return jsonResponse(null, 404);
    }) as typeof fetch,
    getBackendPort: () => 18181,
    getDataPath: () => path.dirname(options.hermesHome),
    getActiveSeatId: () => 'seat-office',
    getActiveSeatContextRevision: () => 7,
    resolveSeatHermesHome: () => options.hermesHome,
    newId: () => 'staged-copy',
  };
}

function transcriptMessage(source: string, conversationId = 'conv-1') {
  return {
    id: 'msg-1',
    conversation_id: conversationId,
    position: 'left',
    type: 'text',
    hidden: false,
    status: 'finish',
    turn_id: 'turn-source-1',
    content: { content: `Fertig.\nMEDIA: ${source}` },
  };
}

async function persistCreateArtifact(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  options: { artifactId: string; completed: boolean }
) {
  const sha256 = crypto.createHash('sha256').update(WORD_PACKAGE).digest('hex');
  const fingerprint = commandEveOfficeFingerprint('word', sha256, WORD_PACKAGE.length);
  const operationId = 'officeop_' + crypto.createHash('sha256').update(options.artifactId).digest('hex');
  const relativePath = commandEveOfficeArtifactRelativePath('conv-1', options.artifactId, sha256, 'word');
  const immutablePath = path.join(fixture.workspace, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(immutablePath), { recursive: true });
  await fs.writeFile(immutablePath, WORD_PACKAGE);
  const store = new ProjectWorkspaceConversationArtifactStore({
    state_root: path.join(fixture.root, 'project-workspace'),
    now: () => 42,
  });
  store.createOfficeOperation({
    operation_id: operationId,
    request_id: 'request-' + options.artifactId,
    seat_id: 'seat-office',
    seat_context_revision: 7,
    process_id: 1001,
    process_nonce_sha256: 'a'.repeat(64),
    conversation_id: 'conv-1',
    action: 'create',
    mode: 'word',
    parent_artifact_id: null,
    source_sha256: null,
    source_size: null,
    source_fingerprint: null,
  });
  const payload: CommandEveOfficeConversationArtifactPayload = {
    artifact_type: 'file',
    artifact_id: options.artifactId,
    title: 'Created.docx',
    file_name: 'Created.docx',
    mime_type: commandEveOfficeMimeType('word'),
    path: relativePath,
    size: WORD_PACKAGE.length,
    hash: sha256,
    managed_office: true,
    office_mode: 'word',
    origin_capability: COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
    origin_action: 'create',
    parent_artifact_id: null,
    source_sha256: sha256,
    source_size: WORD_PACKAGE.length,
    source_fingerprint: fingerprint,
    result_sha256: sha256,
    result_fingerprint: fingerprint,
    operation_id: operationId,
    seat_id: 'seat-office',
    seat_context_revision: 7,
    source_message_id: 'msg-created',
    source_turn_id: 'turn-created',
    source_directive_index: 0,
    source_tool: 'hermes_media_directive',
  };
  const artifact = store.createOfficeArtifact({
    seat_id: 'seat-office',
    conversation_id: 'conv-1',
    artifact_id: options.artifactId,
    payload,
  });
  if (options.completed) {
    store.createOfficeOperationCompletion({
      seat_id: 'seat-office',
      seat_context_revision: 7,
      conversation_id: 'conv-1',
      operation_id: operationId,
      artifact_receipts: [
        {
          artifact_id: artifact.id,
          payload_sha256: commandEveOfficeArtifactPayloadSha256(artifact.payload),
        },
      ],
    });
  }
  return {
    artifact,
    manifestPath: path.join(
      fixture.root,
      'project-workspace',
      'conversation-artifacts',
      'seat-office',
      'conv-1',
      '.office-records',
      options.artifactId + '.json'
    ),
    store,
  };
}

async function persistCompletedEditArtifact(
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  parent: Awaited<ReturnType<typeof persistCreateArtifact>>,
  artifactId: string
) {
  const sha256 = crypto.createHash('sha256').update(WORD_PACKAGE).digest('hex');
  const fingerprint = commandEveOfficeFingerprint('word', sha256, WORD_PACKAGE.length);
  const operationId = 'officeop_' + crypto.createHash('sha256').update(artifactId).digest('hex');
  const relativePath = commandEveOfficeArtifactRelativePath('conv-1', artifactId, sha256, 'word');
  const immutablePath = path.join(fixture.workspace, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(immutablePath), { recursive: true });
  await fs.writeFile(immutablePath, WORD_PACKAGE);
  parent.store.createOfficeOperation({
    operation_id: operationId,
    request_id: 'request-' + artifactId,
    seat_id: 'seat-office',
    seat_context_revision: 7,
    process_id: 1001,
    process_nonce_sha256: 'a'.repeat(64),
    conversation_id: 'conv-1',
    action: 'edit',
    mode: 'word',
    parent_artifact_id: parent.artifact.id,
    source_sha256: parent.artifact.payload.result_sha256,
    source_size: parent.artifact.payload.size,
    source_fingerprint: parent.artifact.payload.result_fingerprint,
  });
  const payload: CommandEveOfficeConversationArtifactPayload = {
    artifact_type: 'file',
    artifact_id: artifactId,
    title: 'Edited.docx',
    file_name: 'Edited.docx',
    mime_type: commandEveOfficeMimeType('word'),
    path: relativePath,
    size: WORD_PACKAGE.length,
    hash: sha256,
    managed_office: true,
    office_mode: 'word',
    origin_capability: COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
    origin_action: 'edit',
    parent_artifact_id: parent.artifact.id,
    source_sha256: parent.artifact.payload.result_sha256,
    source_size: parent.artifact.payload.size,
    source_fingerprint: parent.artifact.payload.result_fingerprint,
    result_sha256: sha256,
    result_fingerprint: fingerprint,
    operation_id: operationId,
    seat_id: 'seat-office',
    seat_context_revision: 7,
    source_message_id: 'msg-edited',
    source_turn_id: 'turn-edited',
    source_directive_index: 0,
    source_tool: 'hermes_media_directive',
  };
  const artifact = parent.store.createOfficeArtifact({
    seat_id: 'seat-office',
    conversation_id: 'conv-1',
    artifact_id: artifactId,
    payload,
  });
  parent.store.createOfficeOperationCompletion({
    seat_id: 'seat-office',
    seat_context_revision: 7,
    conversation_id: 'conv-1',
    operation_id: operationId,
    artifact_receipts: [
      {
        artifact_id: artifact.id,
        payload_sha256: commandEveOfficeArtifactPayloadSha256(artifact.payload),
      },
    ],
  });
  return artifact;
}

describe('Office artifact attachment authority', () => {
  it('accepts only structurally valid DOCX/XLSX packages for the matching mode', async () => {
    await expect(validateOfficePackageBuffer(WORD_PACKAGE, 'word')).resolves.toBe(true);
    await expect(validateOfficePackageBuffer(EXCEL_PACKAGE, 'excel')).resolves.toBe(true);
    await expect(validateOfficePackageBuffer(WORD_PACKAGE, 'excel')).resolves.toBe(false);
    await expect(validateOfficePackageBuffer(INVALID_PACKAGE, 'word')).resolves.toBe(false);
    await expect(validateOfficePackageBuffer(Buffer.from('not a zip'), 'word')).resolves.toBe(false);
  });

  it.each([
    ['word', 'report.docx', WORD_PACKAGE],
    ['excel', 'model.xlsx', EXCEL_PACKAGE],
  ] as const)('re-resolves an exact transcript %s artifact and stages a private copy', async (mode, name, bytes) => {
    const fixture = await makeFixture();
    const source = path.join(fixture.workspace, name);
    await fs.writeFile(source, bytes);

    const result = await resolveCommandEveOfficeArtifactAttachment(
      { conversationId: 'conv-1', artifactId: 'hermes-media-msg-1-0', mode },
      makeDeps({ workspace: fixture.workspace, hermesHome: fixture.hermesHome, message: transcriptMessage(source) })
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.path).not.toBe(source);
    expect(path.relative(fixture.hermesHome, result.path)).not.toMatch(/^\.\./);
    expect(await fs.readFile(result.path)).toEqual(bytes);
    const parent = new ProjectWorkspaceConversationArtifactStore({
      state_root: path.join(fixture.root, 'project-workspace'),
    }).readOfficeArtifact('seat-office', 'conv-1', 'hermes-media-msg-1-0');
    expect(parent?.payload).toMatchObject({
      source_message_id: 'msg-1',
      source_turn_id: 'turn-source-1',
      source_directive_index: 0,
      source_tool: 'office_transcript_import',
    });

    await fs.writeFile(source, Buffer.from('changed after staging'));
    expect(await fs.readFile(result.path)).toEqual(bytes);
  });

  it('refuses a stale artifact, a wrong conversation and a mode mismatch', async () => {
    const fixture = await makeFixture();
    const source = path.join(fixture.workspace, 'report.docx');
    await fs.writeFile(source, WORD_PACKAGE);

    await expect(
      resolveCommandEveOfficeArtifactAttachment(
        { conversationId: 'conv-1', artifactId: 'hermes-media-msg-1-9', mode: 'word' },
        makeDeps({ workspace: fixture.workspace, hermesHome: fixture.hermesHome, message: transcriptMessage(source) })
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
    await expect(
      resolveCommandEveOfficeArtifactAttachment(
        { conversationId: 'conv-1', artifactId: 'hermes-media-msg-1-0', mode: 'word' },
        makeDeps({
          workspace: fixture.workspace,
          hermesHome: fixture.hermesHome,
          message: transcriptMessage(source, 'conv-other'),
        })
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
    await expect(
      resolveCommandEveOfficeArtifactAttachment(
        { conversationId: 'conv-1', artifactId: 'hermes-media-msg-1-0', mode: 'excel' },
        makeDeps({ workspace: fixture.workspace, hermesHome: fixture.hermesHome, message: transcriptMessage(source) })
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'source-format-mismatch' });
  });

  it.each([
    ['missing turn', { turn_id: undefined }],
    ['unsafe turn', { turn_id: '../turn-other' }],
    ['missing status', { status: undefined }],
    ['non-terminal status', { status: 'streaming' }],
  ] as const)('refuses transcript parent provenance with %s', async (_label, override) => {
    const fixture = await makeFixture();
    const source = path.join(fixture.workspace, 'report.docx');
    await fs.writeFile(source, WORD_PACKAGE);
    const result = await resolveCommandEveOfficeArtifactAttachment(
      { conversationId: 'conv-1', artifactId: 'hermes-media-msg-1-0', mode: 'word' },
      makeDeps({
        workspace: fixture.workspace,
        hermesHome: fixture.hermesHome,
        message: { ...transcriptMessage(source), ...override },
      })
    );
    expect(result).toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
    expect(
      new ProjectWorkspaceConversationArtifactStore({
        state_root: path.join(fixture.root, 'project-workspace'),
      }).listOfficeArtifacts('seat-office', 'conv-1')
    ).toEqual([]);
  });

  it('refuses an artifact outside the authoritative workspace', async () => {
    const fixture = await makeFixture();
    const source = path.join(fixture.root, 'outside.docx');
    await fs.writeFile(source, WORD_PACKAGE);
    const result = await resolveCommandEveOfficeArtifactAttachment(
      { conversationId: 'conv-1', artifactId: 'hermes-media-msg-1-0', mode: 'word' },
      makeDeps({ workspace: fixture.workspace, hermesHome: fixture.hermesHome, message: transcriptMessage(source) })
    );
    expect(result).toEqual({ status: 'refused', reasonCode: 'source-unsafe' });
  });

  it('refuses symlink, hardlink and malformed OOXML sources', async () => {
    const fixture = await makeFixture();
    const target = path.join(fixture.workspace, 'target.docx');
    const symlink = path.join(fixture.workspace, 'symlink.docx');
    const hardlink = path.join(fixture.workspace, 'hardlink.docx');
    const malformed = path.join(fixture.workspace, 'malformed.docx');
    await fs.writeFile(target, WORD_PACKAGE);
    await fs.symlink(target, symlink);
    await fs.link(target, hardlink);
    await fs.writeFile(malformed, INVALID_PACKAGE);

    const results = await Promise.all(
      [symlink, hardlink, malformed].map((source) =>
        resolveCommandEveOfficeArtifactAttachment(
          { conversationId: 'conv-1', artifactId: 'hermes-media-msg-1-0', mode: 'word' },
          makeDeps({
            workspace: fixture.workspace,
            hermesHome: fixture.hermesHome,
            message: transcriptMessage(source),
          })
        )
      )
    );
    for (const result of results) {
      expect(result).toEqual({ status: 'refused', reasonCode: 'source-unsafe' });
    }
  });

  it('supports a conversation-owned stored artifact without trusting renderer metadata', async () => {
    const fixture = await makeFixture();
    const source = path.join(fixture.workspace, 'report.docx');
    await fs.writeFile(source, WORD_PACKAGE);
    const result = await resolveCommandEveOfficeArtifactAttachment(
      { conversationId: 'conv-1', artifactId: 'artifact-1', mode: 'word' },
      makeDeps({
        workspace: fixture.workspace,
        hermesHome: fixture.hermesHome,
        artifacts: [
          {
            id: 'artifact-1',
            conversation_id: 'conv-1',
            kind: 'file',
            status: 'active',
            payload: { artifact_type: 'file', path: source },
          },
        ],
      })
    );
    expect(result.status).toBe('ready');
    const parent = new ProjectWorkspaceConversationArtifactStore({
      state_root: path.join(fixture.root, 'project-workspace'),
    }).readOfficeArtifact('seat-office', 'conv-1', 'artifact-1');
    expect(parent?.payload).toMatchObject({
      source_message_id: null,
      source_turn_id: null,
      source_directive_index: null,
      source_tool: 'aioncore_artifact_import',
    });
  });

  it('refuses a partial managed child before staging or creating an edit operation', async () => {
    const fixture = await makeFixture();
    const seeded = await persistCreateArtifact(fixture, { artifactId: 'partial-child', completed: false });

    await expect(
      resolveCommandEveOfficeArtifactAttachment(
        { conversationId: 'conv-1', artifactId: seeded.artifact.id, mode: 'word' },
        makeDeps({ workspace: fixture.workspace, hermesHome: fixture.hermesHome })
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'source-unsafe' });
    await expect(fs.stat(path.join(fixture.hermesHome, 'office-edit-sources'))).rejects.toThrow();
    expect(seeded.store.listOfficeOperations('seat-office', 'conv-1')).toHaveLength(1);
  });

  it('refuses a completed child whose payload no longer matches its immutable receipt', async () => {
    const fixture = await makeFixture();
    const seeded = await persistCreateArtifact(fixture, { artifactId: 'tampered-child', completed: true });
    const manifest = JSON.parse(await fs.readFile(seeded.manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.payload = {
      ...(manifest.payload as Record<string, unknown>),
      source_turn_id: 'turn-rewritten',
    };
    await fs.writeFile(seeded.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      resolveCommandEveOfficeArtifactAttachment(
        { conversationId: 'conv-1', artifactId: seeded.artifact.id, mode: 'word' },
        makeDeps({ workspace: fixture.workspace, hermesHome: fixture.hermesHome })
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'source-unsafe' });
    await expect(fs.stat(path.join(fixture.hermesHome, 'office-edit-sources'))).rejects.toThrow();
    expect(seeded.store.listOfficeOperations('seat-office', 'conv-1')).toHaveLength(1);
  });

  it('refuses a completed edit child when its verified parent chain becomes invalid', async () => {
    const fixture = await makeFixture();
    const parent = await persistCreateArtifact(fixture, { artifactId: 'chain-parent', completed: true });
    const child = await persistCompletedEditArtifact(fixture, parent, 'chain-child');
    const manifest = JSON.parse(await fs.readFile(parent.manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.payload = {
      ...(manifest.payload as Record<string, unknown>),
      source_turn_id: 'turn-parent-rewritten',
    };
    await fs.writeFile(parent.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => parent.store.listOfficeArtifactsWithVerifiedRecordLineage('seat-office', 'conv-1')).toThrow();
    expect(() => parent.store.readOfficeArtifactWithVerifiedRecordLineage('seat-office', 'conv-1', child.id)).toThrow();
    await expect(
      resolveCommandEveOfficeArtifactAttachment(
        { conversationId: 'conv-1', artifactId: child.id, mode: 'word' },
        makeDeps({ workspace: fixture.workspace, hermesHome: fixture.hermesHome })
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'source-unsafe' });
    await expect(fs.stat(path.join(fixture.hermesHome, 'office-edit-sources'))).rejects.toThrow();
  });

  it.each([
    ['word', '/private/staged/report.docx'],
    ['excel', '/private/staged/model.xlsx'],
  ] as const)('extends the existing envelope with the exact selected %s source', async (mode, stagedPath) => {
    const parent = {
      status: 'ready' as const,
      path: stagedPath,
      parentArtifactId: 'artifact-1',
      sourceSha256: 'a'.repeat(64),
      sourceSize: 42,
      sourceFingerprint: 'office-v1:' + mode + ':42:' + 'a'.repeat(64),
      seatId: 'seat-office',
      seatContextRevision: 7,
    };
    const resolver = vi.fn().mockResolvedValue(parent);
    const marker = '<command-eve-office-operation version="1" id="officeop_' + 'b'.repeat(64) + '" />';
    const beginOfficeOperation = vi.fn().mockResolvedValue({ status: 'ready', marker });
    const deps: CommandEveArtifactContextEnvelopeDeps = {
      getDataPath: () => '/private/data',
      buildEntries: () => [],
      isVideoEditEnabled: () => false,
      isImageEditEnabled: () => false,
      resolveOfficeAttachment: resolver,
      beginOfficeOperation,
    };
    const result = await handleCommandEveArtifactContextEnvelope(
      {
        conversationId: 'conv-1',
        selectedArtifactIds: ['artifact-1'],
        requestedOfficeMode: mode,
        officeOperationRequestId: 'queue-item-1',
      },
      deps
    );
    expect(result).toEqual({
      envelope: marker,
      officeAttachment: { status: 'ready', path: stagedPath },
      officeOperation: { status: 'ready' },
    });
    expect(resolver).toHaveBeenCalledWith({ conversationId: 'conv-1', artifactId: 'artifact-1', mode });
    expect(beginOfficeOperation).toHaveBeenCalledWith('/private/data', {
      conversationId: 'conv-1',
      requestId: 'queue-item-1',
      action: 'edit',
      mode,
      parent,
    });
  });

  it('registers an Office create without inventing a parent', async () => {
    const resolver = vi.fn();
    const marker = '<command-eve-office-operation version="1" id="officeop_' + 'c'.repeat(64) + '" />';
    const beginOfficeOperation = vi.fn().mockResolvedValue({ status: 'ready', marker });
    const result = await handleCommandEveArtifactContextEnvelope(
      {
        conversationId: 'conv-1',
        selectedArtifactIds: [],
        requestedOfficeMode: 'excel',
        officeOperationRequestId: 'queue-create-1',
      },
      {
        getDataPath: () => '/private/data',
        buildEntries: () => [],
        isVideoEditEnabled: () => false,
        isImageEditEnabled: () => false,
        resolveOfficeAttachment: resolver,
        beginOfficeOperation,
      }
    );
    expect(result).toEqual({
      envelope: marker,
      officeOperation: { status: 'ready' },
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(beginOfficeOperation).toHaveBeenCalledWith('/private/data', {
      conversationId: 'conv-1',
      requestId: 'queue-create-1',
      action: 'create',
      mode: 'excel',
    });
  });

  it('refuses an Office envelope request with ambiguous selection or no stable request id', async () => {
    const beginOfficeOperation = vi.fn();
    const result = await handleCommandEveArtifactContextEnvelope(
      {
        conversationId: 'conv-1',
        selectedArtifactIds: ['artifact-1', 'artifact-2'],
        requestedOfficeMode: 'excel',
      },
      {
        getDataPath: () => '/private/data',
        buildEntries: () => [],
        isVideoEditEnabled: () => false,
        isImageEditEnabled: () => false,
        beginOfficeOperation,
      }
    );
    expect(result).toEqual({
      envelope: '',
      officeAttachment: { status: 'refused', reasonCode: 'invalid-request' },
      officeOperation: { status: 'refused', reasonCode: 'invalid-request' },
    });
    expect(beginOfficeOperation).not.toHaveBeenCalled();
  });
});
