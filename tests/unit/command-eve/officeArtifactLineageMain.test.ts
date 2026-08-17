import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
  commandEveOfficeFingerprint,
  commandEveOfficeMimeType,
  extractCommandEveOfficeResultCandidates,
  type CommandEveOfficeArtifactMode,
  type CommandEveOfficeConversationArtifactPayload,
} from '@/common/types/office/artifactLineage';
import {
  COMMAND_EVE_PREPARED_CONTEXT_END,
  COMMAND_EVE_PREPARED_CONTEXT_START,
} from '@/common/config/evePreparedContextCore';
import {
  beginCommandEveOfficeArtifactOperation,
  commandEveOfficeOperationIdForRequest,
  listCommandEveOfficeArtifactRecords,
  reconcileConversationOfficeArtifacts,
} from '@/process/commandEve/document/officeArtifactLineageMain';
import { writePrivateDocumentImmutable } from '@/process/commandEve/document/privateDocumentCache';
import { readBoundedOfficeSource } from '@/process/commandEve/officeArtifactAttachmentCore';
import {
  commandEveOfficeArtifactRelativePath,
  commandEveOfficeSourceOperationId,
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

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(mode: CommandEveOfficeArtifactMode = 'word') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-office-lineage-'));
  roots.push(root);
  const dataPath = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(dataPath, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  let seatId = 'seat-office';
  let seatRevision = 7;
  let processNonce = 'a'.repeat(64);
  let processId = 1001;
  // The fixture's pid is synthetic, so liveness must be stated rather than
  // probed against whatever real process happens to own that number.
  let processAlive = true;
  const authority = async (conversationId: string) => ({
    status: 'ready' as const,
    backendPort: 18181,
    workspace,
    seatId,
    seatContextRevision: seatRevision,
    conversationId,
  });
  const beginDeps = {
    getActiveSeatId: () => seatId,
    getActiveSeatContextRevision: () => seatRevision,
    getProcessNonceSha256: () => processNonce,
    getProcessId: () => processId,
    resolveAuthority: authority,
  };
  const runtimeDeps = {
    getActiveSeatId: () => seatId,
    getActiveSeatContextRevision: () => seatRevision,
    getProcessNonceSha256: () => processNonce,
    getProcessId: () => processId,
    isProcessAlive: () => processAlive,
    resolveAuthority: authority,
  };
  const store = () =>
    new ProjectWorkspaceConversationArtifactStore({
      state_root: path.join(dataPath, 'project-workspace'),
      now: () => 1234,
    });
  return {
    root,
    dataPath,
    workspace,
    mode,
    beginDeps,
    runtimeDeps,
    store,
    setSeat: (next: string) => {
      seatId = next;
    },
    setRevision: (next: number) => {
      seatRevision = next;
    },
    setProcessNonce: (next: string) => {
      processNonce = next;
    },
    setProcessId: (next: number) => {
      processId = next;
    },
    setProcessAlive: (next: boolean) => {
      processAlive = next;
    },
  };
}

function transcript(
  marker: string,
  resultPath: string,
  options: { conversationId?: string; turnId?: string; messageId?: string } = {}
) {
  const conversationId = options.conversationId ?? 'conv-1';
  const turnId = options.turnId ?? 'turn-1';
  return [
    {
      id: 'msg-user',
      conversation_id: conversationId,
      position: 'right',
      type: 'text',
      status: 'finish',
      turn_id: turnId,
      content: {
        content:
          COMMAND_EVE_PREPARED_CONTEXT_START +
          '\n' +
          marker +
          '\n' +
          COMMAND_EVE_PREPARED_CONTEXT_END +
          '\nBitte erstellen.',
      },
    },
    {
      id: options.messageId ?? 'msg-result',
      conversation_id: conversationId,
      position: 'left',
      type: 'text',
      status: 'finish',
      turn_id: turnId,
      content: { content: 'Fertig.\nMEDIA: ' + resultPath },
    },
  ];
}

function parentPayload(input: {
  artifactId: string;
  mode: CommandEveOfficeArtifactMode;
  relativePath: string;
  bytes: Buffer;
  seatRevision?: number;
}): CommandEveOfficeConversationArtifactPayload {
  const sha = crypto.createHash('sha256').update(input.bytes).digest('hex');
  const fingerprint = commandEveOfficeFingerprint(input.mode, sha, input.bytes.length);
  const seatContextRevision = input.seatRevision ?? 7;
  return {
    artifact_type: 'file',
    artifact_id: input.artifactId,
    title: input.mode === 'word' ? 'Parent.docx' : 'Parent.xlsx',
    file_name: input.mode === 'word' ? 'Parent.docx' : 'Parent.xlsx',
    mime_type: commandEveOfficeMimeType(input.mode),
    path: input.relativePath,
    size: input.bytes.length,
    hash: sha,
    managed_office: true,
    office_mode: input.mode,
    origin_capability: COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
    origin_action: 'source',
    parent_artifact_id: null,
    source_sha256: sha,
    source_size: input.bytes.length,
    source_fingerprint: fingerprint,
    result_sha256: sha,
    result_fingerprint: fingerprint,
    operation_id: commandEveOfficeSourceOperationId({
      seatId: 'seat-office',
      seatContextRevision,
      conversationId: 'conv-1',
      artifactId: input.artifactId,
      mode: input.mode,
      resultSha256: sha,
      resultSize: input.bytes.length,
      sourceTool: 'office_transcript_import',
      sourceMessageId: 'msg-parent',
      sourceTurnId: 'turn-parent',
      sourceDirectiveIndex: 0,
    }),
    seat_id: 'seat-office',
    seat_context_revision: seatContextRevision,
    source_message_id: 'msg-parent',
    source_turn_id: 'turn-parent',
    source_directive_index: 0,
    source_tool: 'office_transcript_import',
  };
}

function createParent(fixture: ReturnType<typeof setup>, artifactId = 'parent-1') {
  const bytes = fixture.mode === 'word' ? WORD_PACKAGE : EXCEL_PACKAGE;
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const relativePath = commandEveOfficeArtifactRelativePath('conv-1', artifactId, sha256, fixture.mode);
  const target = path.join(fixture.workspace, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  const payload = parentPayload({ artifactId, mode: fixture.mode, relativePath, bytes });
  const artifact = fixture.store().createOfficeArtifact({
    seat_id: 'seat-office',
    conversation_id: 'conv-1',
    artifact_id: artifactId,
    payload,
  });
  return { artifact, target, bytes };
}

function persistManualCreateResult(
  fixture: ReturnType<typeof setup>,
  input: {
    artifactId: string;
    operationId: string;
    messageId: string;
    turnId: string;
    directiveIndex: number;
  }
) {
  const bytes = fixture.mode === 'word' ? WORD_PACKAGE : EXCEL_PACKAGE;
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const fingerprint = commandEveOfficeFingerprint(fixture.mode, sha256, bytes.length);
  const relativePath = commandEveOfficeArtifactRelativePath('conv-1', input.artifactId, sha256, fixture.mode);
  writePrivateDocumentImmutable(fixture.workspace, path.join(fixture.workspace, ...relativePath.split('/')), bytes);
  return fixture.store().createOfficeArtifact({
    seat_id: 'seat-office',
    conversation_id: 'conv-1',
    artifact_id: input.artifactId,
    payload: {
      artifact_type: 'file',
      artifact_id: input.artifactId,
      title: fixture.mode === 'word' ? 'Manual.docx' : 'Manual.xlsx',
      file_name: fixture.mode === 'word' ? 'Manual.docx' : 'Manual.xlsx',
      mime_type: commandEveOfficeMimeType(fixture.mode),
      path: relativePath,
      size: bytes.length,
      hash: sha256,
      managed_office: true,
      office_mode: fixture.mode,
      origin_capability: COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
      origin_action: 'create',
      parent_artifact_id: null,
      source_sha256: sha256,
      source_size: bytes.length,
      source_fingerprint: fingerprint,
      result_sha256: sha256,
      result_fingerprint: fingerprint,
      operation_id: input.operationId,
      seat_id: 'seat-office',
      seat_context_revision: 7,
      source_message_id: input.messageId,
      source_turn_id: input.turnId,
      source_directive_index: input.directiveIndex,
      source_tool: 'hermes_media_directive',
    },
  });
}

async function persistCompletedCreateArtifact(fixture: ReturnType<typeof setup>, requestId: string) {
  const resultPath = path.join(fixture.workspace, requestId + '.docx');
  fs.writeFileSync(resultPath, WORD_PACKAGE);
  const begun = await beginCommandEveOfficeArtifactOperation(
    fixture.dataPath,
    { conversationId: 'conv-1', requestId, action: 'create', mode: 'word' },
    fixture.beginDeps
  );
  if (begun.status !== 'ready') throw new Error('Office parent create operation was refused.');
  const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
    ...fixture.runtimeDeps,
    fetchTranscript: async () => transcript(begun.marker, resultPath),
  });
  if (summary.persisted !== 1 || summary.refused.length > 0) {
    throw new Error('Office parent create result did not complete.');
  }
  const artifact = fixture
    .store()
    .listOfficeArtifacts('seat-office', 'conv-1')
    .find((candidate) => candidate.payload.operation_id === commandEveOfficeOperationIdForRequest(requestId));
  if (!artifact) throw new Error('Completed Office parent artifact is missing.');
  return {
    artifact,
    manifestPath: path.join(
      fixture.dataPath,
      'project-workspace',
      'conversation-artifacts',
      'seat-office',
      'conv-1',
      '.office-records',
      artifact.id + '.json'
    ),
  };
}

async function persistCompletedEditArtifact(
  fixture: ReturnType<typeof setup>,
  parent: CommandEveOfficeConversationArtifactPayload,
  requestId: string
) {
  const resultPath = path.join(fixture.workspace, requestId + '.docx');
  fs.writeFileSync(resultPath, WORD_PACKAGE);
  const begun = await beginCommandEveOfficeArtifactOperation(
    fixture.dataPath,
    {
      conversationId: 'conv-1',
      requestId,
      action: 'edit',
      mode: 'word',
      parent: {
        status: 'ready',
        path: '/private/staged/parent.docx',
        parentArtifactId: parent.artifact_id,
        sourceSha256: parent.result_sha256,
        sourceSize: parent.size,
        sourceFingerprint: parent.result_fingerprint,
        seatId: 'seat-office',
        seatContextRevision: 7,
      },
    },
    fixture.beginDeps
  );
  if (begun.status !== 'ready') throw new Error('Office child edit operation was refused.');
  const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
    ...fixture.runtimeDeps,
    fetchTranscript: async () =>
      transcript(begun.marker, resultPath, { messageId: 'msg-' + requestId, turnId: 'turn-' + requestId }),
  });
  if (summary.persisted !== 1 || summary.refused.length > 0) {
    throw new Error('Office child edit result did not complete.');
  }
  const artifact = fixture
    .store()
    .listOfficeArtifacts('seat-office', 'conv-1')
    .find((candidate) => candidate.payload.operation_id === commandEveOfficeOperationIdForRequest(requestId));
  if (!artifact) throw new Error('Completed Office child artifact is missing.');
  return artifact;
}

function rewriteOfficeArtifactSourceTurn(manifestPath: string): void {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.payload = {
    ...(manifest.payload as Record<string, unknown>),
    source_turn_id: 'turn-rewritten',
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('Office artifact lineage Main', () => {
  it.each([
    ['word', 'result.docx', WORD_PACKAGE],
    ['excel', 'result.xlsx', EXCEL_PACKAGE],
  ] as const)(
    'persists one immutable %s create result with exact provenance and reload truth',
    async (mode, name, bytes) => {
      const fixture = setup(mode);
      const resultPath = path.join(fixture.workspace, name);
      fs.writeFileSync(resultPath, bytes);
      const begun = await beginCommandEveOfficeArtifactOperation(
        fixture.dataPath,
        { conversationId: 'conv-1', requestId: 'queue-create-1', action: 'create', mode },
        fixture.beginDeps
      );
      expect(begun.status).toBe('ready');
      if (begun.status !== 'ready') return;

      const notify = vi.fn();
      const fetchTranscript = vi.fn(async () => transcript(begun.marker, resultPath));
      const first = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
        ...fixture.runtimeDeps,
        fetchTranscript,
        onFreshArtifact: notify,
      });
      expect(first).toMatchObject({ pendingOperations: 1, candidates: 1, persisted: 1, refused: [] });
      expect(notify).toHaveBeenCalledOnce();
      expect(fs.readFileSync(resultPath)).toEqual(bytes);

      const records = fixture.store().listOfficeArtifacts('seat-office', 'conv-1');
      expect(records).toHaveLength(1);
      const child = records[0];
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      expect(child).toMatchObject({
        id: 'hermes-media-msg-result-0',
        conversation_id: 'conv-1',
        kind: 'file',
        status: 'active',
        payload: {
          office_mode: mode,
          origin_capability: 'office-studio',
          origin_action: 'create',
          parent_artifact_id: null,
          source_sha256: sha,
          result_sha256: sha,
          seat_id: 'seat-office',
          seat_context_revision: 7,
          source_message_id: 'msg-result',
          source_turn_id: 'turn-1',
          source_directive_index: 0,
        },
      });
      expect(child.payload.path).not.toContain(fixture.workspace);
      expect(path.isAbsolute(child.payload.path)).toBe(false);
      const immutablePath = path.join(fixture.workspace, ...child.payload.path.split('/'));
      expect(immutablePath).not.toBe(resultPath);
      expect(fs.readFileSync(immutablePath)).toEqual(bytes);

      fs.writeFileSync(resultPath, Buffer.from('renderer result changed later'));
      expect(fs.readFileSync(immutablePath)).toEqual(bytes);
      await expect(
        listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)
      ).resolves.toEqual([child]);

      const replay = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
        ...fixture.runtimeDeps,
        fetchTranscript,
      });
      expect(replay).toMatchObject({ pendingOperations: 0, persisted: 0, alreadyPersisted: 1 });
      expect(fetchTranscript).toHaveBeenCalledTimes(1);
    }
  );

  it('binds an edit child to the exact durable parent and rejects parent byte tampering', async () => {
    const fixture = setup('word');
    const parent = createParent(fixture);
    const parentSha = parent.artifact.payload.result_sha256;
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      {
        conversationId: 'conv-1',
        requestId: 'queue-edit-1',
        action: 'edit',
        mode: 'word',
        parent: {
          status: 'ready',
          path: '/private/staged/parent.docx',
          parentArtifactId: parent.artifact.id,
          sourceSha256: parentSha,
          sourceSize: parent.bytes.length,
          sourceFingerprint: parent.artifact.payload.result_fingerprint,
          seatId: 'seat-office',
          seatContextRevision: 7,
        },
      },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    fs.writeFileSync(parent.target, Buffer.from('tampered parent bytes'));
    const resultPath = path.join(fixture.workspace, 'edited.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);

    const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    expect(summary.persisted).toBe(0);
    expect(summary.refused).toContainEqual({
      operationId: commandEveOfficeOperationIdForRequest('queue-edit-1'),
      reason: 'parent-mismatch',
    });
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toEqual([parent.artifact]);
  });

  it('refuses an edit operation when the completed parent payload no longer matches its receipt', async () => {
    const fixture = setup('word');
    const parent = await persistCompletedCreateArtifact(fixture, 'queue-parent-for-begin');
    rewriteOfficeArtifactSourceTurn(parent.manifestPath);

    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      {
        conversationId: 'conv-1',
        requestId: 'queue-edit-after-parent-tamper',
        action: 'edit',
        mode: 'word',
        parent: {
          status: 'ready',
          path: '/private/staged/parent.docx',
          parentArtifactId: parent.artifact.id,
          sourceSha256: parent.artifact.payload.result_sha256,
          sourceSize: parent.artifact.payload.size,
          sourceFingerprint: parent.artifact.payload.result_fingerprint,
          seatId: 'seat-office',
          seatContextRevision: 7,
        },
      },
      fixture.beginDeps
    );

    expect(begun).toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
    expect(fixture.store().listOfficeOperations('seat-office', 'conv-1')).toHaveLength(1);
  });

  it('refuses reconciliation when a verified parent becomes receipt-invalid after edit begin', async () => {
    const fixture = setup('word');
    const parent = await persistCompletedCreateArtifact(fixture, 'queue-parent-for-reconcile');
    fixture.setProcessId(1002);
    fixture.setProcessNonce('b'.repeat(64));
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      {
        conversationId: 'conv-1',
        requestId: 'queue-edit-before-parent-tamper',
        action: 'edit',
        mode: 'word',
        parent: {
          status: 'ready',
          path: '/private/staged/parent.docx',
          parentArtifactId: parent.artifact.id,
          sourceSha256: parent.artifact.payload.result_sha256,
          sourceSize: parent.artifact.payload.size,
          sourceFingerprint: parent.artifact.payload.result_fingerprint,
          seatId: 'seat-office',
          seatContextRevision: 7,
        },
      },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    rewriteOfficeArtifactSourceTurn(parent.manifestPath);
    const resultPath = path.join(fixture.workspace, 'receipt-invalid-parent-edit.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);

    const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    const operationId = commandEveOfficeOperationIdForRequest('queue-edit-before-parent-tamper');
    expect(summary.persisted).toBe(0);
    expect(summary.refused).toContainEqual({ operationId, reason: 'parent-mismatch' });
    expect(
      fixture
        .store()
        .listOfficeArtifacts('seat-office', 'conv-1')
        .filter((artifact) => artifact.payload.origin_action === 'edit')
    ).toEqual([]);
    expect(fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId)).toBeNull();
  });

  it('refuses a new edit operation when an upstream parent invalidates the selected child chain', async () => {
    const fixture = setup('word');
    const parent = await persistCompletedCreateArtifact(fixture, 'queue-chain-parent');
    const child = await persistCompletedEditArtifact(fixture, parent.artifact.payload, 'queue-chain-child');
    rewriteOfficeArtifactSourceTurn(parent.manifestPath);

    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      {
        conversationId: 'conv-1',
        requestId: 'queue-chain-grandchild',
        action: 'edit',
        mode: 'word',
        parent: {
          status: 'ready',
          path: '/private/staged/child.docx',
          parentArtifactId: child.id,
          sourceSha256: child.payload.result_sha256,
          sourceSize: child.payload.size,
          sourceFingerprint: child.payload.result_fingerprint,
          seatId: 'seat-office',
          seatContextRevision: 7,
        },
      },
      fixture.beginDeps
    );

    expect(begun).toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
    expect(fixture.store().listOfficeOperations('seat-office', 'conv-1')).toHaveLength(2);
  });

  it('skips a leading wrong-format directive and persists every matching Office result', async () => {
    const fixture = setup('word');
    const firstPath = path.join(fixture.workspace, 'first.docx');
    const secondPath = path.join(fixture.workspace, 'second.docx');
    fs.writeFileSync(firstPath, WORD_PACKAGE);
    fs.writeFileSync(secondPath, WORD_PACKAGE);
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-multi-result', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const items = transcript(begun.marker, firstPath);
    items[1] = {
      ...items[1],
      content: {
        content:
          'MEDIA: ' + path.join(fixture.workspace, 'preview.pdf') + '\nMEDIA: ' + firstPath + '\nMEDIA: ' + secondPath,
      },
    };

    const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => items,
    });
    expect(summary).toMatchObject({ candidates: 3, persisted: 2 });
    expect(summary.refused).toContainEqual({
      operationId: commandEveOfficeOperationIdForRequest('queue-multi-result'),
      reason: 'source-format-mismatch',
    });
    expect(
      fixture
        .store()
        .listOfficeArtifacts('seat-office', 'conv-1')
        .map((artifact) => artifact.id)
        .toSorted()
    ).toEqual(['hermes-media-msg-result-1', 'hermes-media-msg-result-2']);

    const operationId = commandEveOfficeOperationIdForRequest('queue-multi-result');
    const completion = fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId);
    expect(completion?.artifact_receipts).toHaveLength(2);
    const completionFile = path.join(
      fixture.dataPath,
      'project-workspace',
      'conversation-artifacts',
      'seat-office',
      'conv-1',
      '.office-operations',
      '.completed',
      operationId + '.json'
    );
    fs.writeFileSync(
      completionFile,
      `${JSON.stringify({ ...completion, artifact_receipts: completion?.artifact_receipts.slice(0, 1) }, null, 2)}\n`
    );
    const fetchAfterTamper = vi.fn(async () => items);
    const tampered = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: fetchAfterTamper,
    });
    expect(tampered.refused).toContainEqual({ operationId: 'office-store', reason: 'store-corrupt' });
    expect(fetchAfterTamper).not.toHaveBeenCalled();
    await expect(listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)).resolves.toEqual(
      []
    );
  });

  it('repairs a partial multi-result retry from verified immutable children after the raw source disappears', async () => {
    const fixture = setup('word');
    const firstPath = path.join(fixture.workspace, 'partial-first.docx');
    const secondPath = path.join(fixture.workspace, 'partial-second.docx');
    fs.writeFileSync(firstPath, WORD_PACKAGE);
    fs.writeFileSync(secondPath, WORD_PACKAGE);
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-partial-retry', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const items = transcript(begun.marker, firstPath);
    items[1] = {
      ...items[1],
      content: { content: 'MEDIA: ' + firstPath + '\nMEDIA: ' + secondPath },
    };
    const failedArtifactKey = crypto
      .createHash('sha256')
      .update('hermes-media-msg-result-1')
      .digest('hex')
      .slice(0, 24);
    const first = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => items,
      writeImmutable: (root, target, contents) => {
        if (target.includes(failedArtifactKey)) throw new Error('injected second-result failure');
        writePrivateDocumentImmutable(root, target, contents);
      },
    });
    expect(first).toMatchObject({ persisted: 1 });
    expect(first.refused).toContainEqual({
      operationId: commandEveOfficeOperationIdForRequest('queue-partial-retry'),
      reason: 'persist-failed',
    });
    expect(
      fixture
        .store()
        .readOfficeOperationCompletion(
          'seat-office',
          'conv-1',
          commandEveOfficeOperationIdForRequest('queue-partial-retry')
        )
    ).toBeNull();

    fs.rmSync(firstPath);
    const second = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => items,
    });
    expect(second).toMatchObject({ pendingOperations: 1, persisted: 1 });
    const completion = fixture
      .store()
      .readOfficeOperationCompletion(
        'seat-office',
        'conv-1',
        commandEveOfficeOperationIdForRequest('queue-partial-retry')
      );
    expect(completion?.artifact_receipts.map((receipt) => receipt.artifact_id)).toEqual([
      'hermes-media-msg-result-0',
      'hermes-media-msg-result-1',
    ]);
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toHaveLength(2);

    const thirdFetch = vi.fn(async () => items);
    const third = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: thirdFetch,
    });
    expect(third).toMatchObject({ pendingOperations: 0, persisted: 0, alreadyPersisted: 1 });
    expect(thirdFetch).not.toHaveBeenCalled();
  });

  it('does not seal completion when a verified earlier child is absent from the retry transcript', async () => {
    const fixture = setup('word');
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-windowed-retry', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const operationId = commandEveOfficeOperationIdForRequest('queue-windowed-retry');
    persistManualCreateResult(fixture, {
      artifactId: 'hermes-media-msg-earlier-0',
      operationId,
      messageId: 'msg-earlier',
      turnId: 'turn-earlier',
      directiveIndex: 0,
    });
    const currentPath = path.join(fixture.workspace, 'windowed-current.docx');
    fs.writeFileSync(currentPath, WORD_PACKAGE);

    const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, currentPath),
    });

    expect(summary.persisted).toBe(1);
    expect(summary.refused).toContainEqual({ operationId, reason: 'completion-membership-mismatch' });
    expect(fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId)).toBeNull();
    await expect(listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)).resolves.toEqual(
      []
    );
  });

  it('never seals completion from a streaming transcript and persists the full terminal result set', async () => {
    const fixture = setup('word');
    const firstPath = path.join(fixture.workspace, 'stream-first.docx');
    const secondPath = path.join(fixture.workspace, 'stream-second.docx');
    fs.writeFileSync(firstPath, WORD_PACKAGE);
    fs.writeFileSync(secondPath, WORD_PACKAGE);
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-streaming', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const operationId = commandEveOfficeOperationIdForRequest('queue-streaming');
    const streaming = transcript(begun.marker, firstPath);
    streaming[1] = { ...streaming[1], status: undefined };
    const first = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => streaming,
    });
    expect(first).toMatchObject({ candidates: 0, persisted: 0, pendingOperations: 1 });
    expect(fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId)).toBeNull();

    const terminal = transcript(begun.marker, firstPath);
    terminal[1] = {
      ...terminal[1],
      content: { content: 'MEDIA: ' + firstPath + '\nMEDIA: ' + secondPath },
    };
    const second = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => terminal,
    });
    expect(second).toMatchObject({ candidates: 2, persisted: 2 });
    expect(
      fixture
        .store()
        .readOfficeOperationCompletion('seat-office', 'conv-1', operationId)
        ?.artifact_receipts.map((receipt) => receipt.artifact_id)
    ).toEqual(['hermes-media-msg-result-0', 'hermes-media-msg-result-1']);
  });

  it('refuses more than 32 matching results before reading or writing any result', async () => {
    const fixture = setup('word');
    const resultPaths = Array.from({ length: 33 }, (_, index) =>
      path.join(fixture.workspace, 'bounded-result-' + String(index) + '.docx')
    );
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-result-limit', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const items = transcript(begun.marker, resultPaths[0]);
    items[1] = {
      ...items[1],
      content: { content: resultPaths.map((resultPath) => 'MEDIA: ' + resultPath).join('\n') },
    };
    const readOfficeSource = vi.fn(readBoundedOfficeSource);
    const writeImmutable = vi.fn(writePrivateDocumentImmutable);
    const operationId = commandEveOfficeOperationIdForRequest('queue-result-limit');

    const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => items,
      readOfficeSource,
      writeImmutable,
    });

    expect(summary).toMatchObject({ candidates: 33, persisted: 0 });
    expect(summary.refused).toContainEqual({ operationId, reason: 'result-limit-exceeded' });
    expect(readOfficeSource).not.toHaveBeenCalled();
    expect(writeImmutable).not.toHaveBeenCalled();
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toEqual([]);
    expect(fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId)).toBeNull();
  });

  it('persists 32 results with at most two verified source reads in flight', async () => {
    const fixture = setup('word');
    const resultPaths = Array.from({ length: 32 }, (_, index) =>
      path.join(fixture.workspace, 'bounded-result-' + String(index) + '.docx')
    );
    resultPaths.forEach((resultPath) => fs.writeFileSync(resultPath, WORD_PACKAGE));
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-result-boundary', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const items = transcript(begun.marker, resultPaths[0]);
    items[1] = {
      ...items[1],
      content: { content: resultPaths.map((resultPath) => 'MEDIA: ' + resultPath).join('\n') },
    };
    let inFlight = 0;
    let maxInFlight = 0;
    const boundedRead = async (workspace: string, source: string, mode: CommandEveOfficeArtifactMode) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      try {
        return await readBoundedOfficeSource(workspace, source, mode);
      } finally {
        inFlight -= 1;
      }
    };

    const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => items,
      readOfficeSource: boundedRead,
    });

    const operationId = commandEveOfficeOperationIdForRequest('queue-result-boundary');
    expect(summary).toMatchObject({ candidates: 32, persisted: 32, refused: [] });
    expect(maxInFlight).toBe(2);
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toHaveLength(32);
    expect(
      fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId)?.artifact_receipts
    ).toHaveLength(32);

    const expectedOrder = fixture
      .store()
      .listOfficeArtifacts('seat-office', 'conv-1')
      .map((artifact) => artifact.id);
    maxInFlight = 0;
    const reloaded = await listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      readOfficeSource: boundedRead,
    });
    expect(maxInFlight).toBe(2);
    expect(reloaded.map((artifact) => artifact.id)).toEqual(expectedOrder);
  });

  it('deduplicates concurrent completion delivery and skips transcript fetch after completion', async () => {
    const fixture = setup('word');
    const resultPath = path.join(fixture.workspace, 'concurrent-result.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-concurrent-completion', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const operationId = commandEveOfficeOperationIdForRequest('queue-concurrent-completion');
    let releaseReads!: () => void;
    const bothReadsEntered = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let readCalls = 0;
    const readOfficeSource = async (workspace: string, source: string, mode: CommandEveOfficeArtifactMode) => {
      readCalls += 1;
      if (readCalls === 2) releaseReads();
      await bothReadsEntered;
      return readBoundedOfficeSource(workspace, source, mode);
    };
    const completionFile = path.join(
      fixture.dataPath,
      'project-workspace',
      'conversation-artifacts',
      'seat-office',
      'conv-1',
      '.office-operations',
      '.completed',
      operationId + '.json'
    );
    const originalLink = fs.linkSync.bind(fs);
    let completionPromotions = 0;
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(completionFile)) completionPromotions += 1;
      return originalLink(source, destination);
    });
    const deps = {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
      readOfficeSource,
    };

    const summaries = await Promise.all([
      reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', deps),
      reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', deps),
    ]);

    expect(readCalls).toBe(2);
    expect(completionPromotions).toBe(1);
    expect(summaries.flatMap((summary) => summary.refused)).not.toContainEqual({
      operationId,
      reason: 'completion-failed',
    });
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toHaveLength(1);
    expect(
      fixture
        .store()
        .readOfficeOperationCompletion('seat-office', 'conv-1', operationId)
        ?.artifact_receipts.map((receipt) => receipt.artifact_id)
    ).toEqual(['hermes-media-msg-result-0']);
    const completionBytes = fs.readFileSync(completionFile);

    const fetchAfterCompletion = vi.fn(async () => transcript(begun.marker, resultPath));
    const replay = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: fetchAfterCompletion,
    });
    expect(replay).toMatchObject({ pendingOperations: 0, persisted: 0, alreadyPersisted: 1 });
    expect(fetchAfterCompletion).not.toHaveBeenCalled();
    expect(fs.readFileSync(completionFile)).toEqual(completionBytes);
  });

  it('rejects an operation-matching child that is absent from the immutable completion receipt', async () => {
    const fixture = setup('word');
    const resultPath = path.join(fixture.workspace, 'completed-result.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-extra-child', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const operationId = commandEveOfficeOperationIdForRequest('queue-extra-child');
    await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    persistManualCreateResult(fixture, {
      artifactId: 'hermes-media-msg-injected-9',
      operationId,
      messageId: 'msg-injected',
      turnId: 'turn-injected',
      directiveIndex: 9,
    });
    const fetchAfterInjection = vi.fn(async () => transcript(begun.marker, resultPath));

    const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: fetchAfterInjection,
    });
    expect(summary.refused).toContainEqual({ operationId: 'office-store', reason: 'store-corrupt' });
    expect(fetchAfterInjection).not.toHaveBeenCalled();
    await expect(listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)).resolves.toEqual(
      []
    );
  });

  it('drops a result when the active seat revision changes during source verification', async () => {
    const fixture = setup('word');
    const resultPath = path.join(fixture.workspace, 'revision-race.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-revision-race', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;

    const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      readOfficeSource: async (workspace, source, mode) => {
        const verified = await readBoundedOfficeSource(workspace, source, mode);
        fixture.setRevision(8);
        return verified;
      },
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    expect(summary.persisted).toBe(0);
    expect(summary.refused).toContainEqual({
      operationId: commandEveOfficeOperationIdForRequest('queue-revision-race'),
      reason: 'seat-changed',
    });
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toEqual([]);
  });

  it.each(['file fsync', 'directory fsync'] as const)(
    'keeps manifests absent after an injected %s failure and repairs on retry',
    async (failureStage) => {
      const fixture = setup('word');
      const resultPath = path.join(fixture.workspace, 'fsync-result.docx');
      fs.writeFileSync(resultPath, WORD_PACKAGE);
      const begun = await beginCommandEveOfficeArtifactOperation(
        fixture.dataPath,
        {
          conversationId: 'conv-1',
          requestId: 'queue-fsync-' + failureStage.replace(' ', '-'),
          action: 'create',
          mode: 'word',
        },
        fixture.beginDeps
      );
      expect(begun.status).toBe('ready');
      if (begun.status !== 'ready') return;
      const operationId = commandEveOfficeOperationIdForRequest('queue-fsync-' + failureStage.replace(' ', '-'));
      const originalFsync = fs.fsyncSync.bind(fs);
      const originalLink = fs.linkSync.bind(fs);
      let immutableResultRead = false;
      let immutableResultPublished = false;
      let failureInjected = false;
      vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
        const result = originalLink(source, destination);
        if (String(destination).startsWith(fixture.workspace) && String(destination).endsWith('.docx')) {
          immutableResultPublished = true;
        }
        return result;
      });
      vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
        const isDirectory = fs.fstatSync(descriptor).isDirectory();
        const shouldFail =
          immutableResultRead &&
          !failureInjected &&
          ((failureStage === 'file fsync' && !isDirectory) ||
            (failureStage === 'directory fsync' && immutableResultPublished && isDirectory));
        if (shouldFail) {
          failureInjected = true;
          throw new Error('injected fsync failure');
        }
        return originalFsync(descriptor);
      });
      const failed = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
        ...fixture.runtimeDeps,
        fetchTranscript: async () => transcript(begun.marker, resultPath),
        readOfficeSource: async (workspace, source, mode) => {
          immutableResultRead = true;
          return readBoundedOfficeSource(workspace, source, mode);
        },
      });
      expect(failureInjected).toBe(true);
      expect(failed.persisted).toBe(0);
      expect(failed.refused).toContainEqual({ operationId, reason: 'persist-failed' });
      expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toEqual([]);
      expect(fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId)).toBeNull();

      vi.restoreAllMocks();
      const retry = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
        ...fixture.runtimeDeps,
        fetchTranscript: async () => transcript(begun.marker, resultPath),
      });
      expect(retry).toMatchObject({ persisted: 1 });
      expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toHaveLength(1);
      expect(fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId)).not.toBeNull();
    }
  );

  it('keeps manifests absent when create-only publication aborts after write and repairs on retry', async () => {
    const fixture = setup('word');
    const resultPath = path.join(fixture.workspace, 'publish-result.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-publish-failure', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const operationId = commandEveOfficeOperationIdForRequest('queue-publish-failure');
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      const error = new Error('injected create-only publication failure') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    });

    const failed = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    expect(failed.persisted).toBe(0);
    expect(failed.refused).toContainEqual({ operationId, reason: 'persist-failed' });
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toEqual([]);
    expect(fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId)).toBeNull();

    vi.restoreAllMocks();
    const retry = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    expect(retry.persisted).toBe(1);
    expect(fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId)).not.toBeNull();
  });

  it('persists an edit child with exact parent/source/result hashes', async () => {
    const fixture = setup('excel');
    const parent = createParent(fixture);
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      {
        conversationId: 'conv-1',
        requestId: 'queue-edit-excel',
        action: 'edit',
        mode: 'excel',
        parent: {
          status: 'ready',
          path: '/private/staged/parent.xlsx',
          parentArtifactId: parent.artifact.id,
          sourceSha256: parent.artifact.payload.result_sha256,
          sourceSize: parent.bytes.length,
          sourceFingerprint: parent.artifact.payload.result_fingerprint,
          seatId: 'seat-office',
          seatContextRevision: 7,
        },
      },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const resultPath = path.join(fixture.workspace, 'edited.xlsx');
    fs.writeFileSync(resultPath, EXCEL_PACKAGE);

    const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    expect(summary.persisted).toBe(1);
    const child = fixture
      .store()
      .listOfficeArtifacts('seat-office', 'conv-1')
      .find((artifact) => artifact.payload.origin_action === 'edit');
    expect(child?.payload).toMatchObject({
      parent_artifact_id: parent.artifact.id,
      source_sha256: parent.artifact.payload.result_sha256,
      source_size: parent.artifact.payload.size,
      source_fingerprint: parent.artifact.payload.result_fingerprint,
      result_sha256: crypto.createHash('sha256').update(EXCEL_PACKAGE).digest('hex'),
      origin_capability: 'office-studio',
      office_mode: 'excel',
      seat_id: 'seat-office',
      seat_context_revision: 7,
    });
  });

  it('replays one queue operation idempotently and refuses a conflicting retry', async () => {
    const fixture = setup('word');
    const request = {
      conversationId: 'conv-1',
      requestId: 'persisted-queue-item',
      action: 'create' as const,
      mode: 'word' as const,
    };
    const first = await beginCommandEveOfficeArtifactOperation(fixture.dataPath, request, fixture.beginDeps);
    const replay = await beginCommandEveOfficeArtifactOperation(fixture.dataPath, request, fixture.beginDeps);
    expect(replay).toEqual(first);
    expect(fixture.store().listOfficeOperations('seat-office', 'conv-1')).toHaveLength(1);

    await expect(
      beginCommandEveOfficeArtifactOperation(fixture.dataPath, { ...request, mode: 'excel' }, fixture.beginDeps)
    ).resolves.toEqual({ status: 'refused', reasonCode: 'operation-conflict' });
  });

  it('ignores wrong-conversation, wrong-seat, stale-revision and prior-process pending markers', async () => {
    const fixture = setup('word');
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-fenced', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const resultPath = path.join(fixture.workspace, 'result.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);

    const wrongConversation = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath, { conversationId: 'conv-other' }),
    });
    expect(wrongConversation).toMatchObject({ candidates: 0, persisted: 0 });

    fixture.setSeat('seat-other');
    const wrongSeatFetch = vi.fn(async () => transcript(begun.marker, resultPath));
    const wrongSeat = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: wrongSeatFetch,
    });
    expect(wrongSeat.pendingOperations).toBe(0);
    expect(wrongSeatFetch).not.toHaveBeenCalled();

    fixture.setSeat('seat-office');
    fixture.setRevision(8);
    const staleFetch = vi.fn(async () => transcript(begun.marker, resultPath));
    const stale = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: staleFetch,
    });
    expect(stale.pendingOperations).toBe(0);
    expect(staleFetch).not.toHaveBeenCalled();
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toEqual([]);

    fixture.setRevision(1);
    fixture.setProcessNonce('b'.repeat(64));
    fixture.setProcessId(2002);
    const restartFetch = vi.fn(async () => transcript(begun.marker, resultPath));
    const restarted = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: restartFetch,
    });
    expect(restarted).toMatchObject({ pendingOperations: 0, persisted: 0 });
    expect(restartFetch).not.toHaveBeenCalled();
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toEqual([]);
  });

  it('seals an operation from a dead boot as terminally abandoned instead of leaving it pending forever', async () => {
    const fixture = setup('word');
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-quit-before-reconcile', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const operationId = commandEveOfficeOperationIdForRequest('queue-quit-before-reconcile');
    const resultPath = path.join(fixture.workspace, 'quit-result.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);

    // Main quit after Hermes wrote the file but before the reconcile: a new boot
    // with a new pid/nonce can never satisfy the fence for this operation.
    fixture.setProcessId(2002);
    fixture.setProcessNonce('b'.repeat(64));
    fixture.setProcessAlive(false);

    const afterRestart = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    expect(afterRestart).toMatchObject({ abandoned: 1, pendingOperations: 0, persisted: 0, refused: [] });
    const sealed = fixture.store().readOfficeOperationAbandonment('seat-office', 'conv-1', operationId);
    expect(sealed).toMatchObject({ operation_id: operationId, reason: 'process-boot-gone' });

    // The fence is untouched: the sealed operation is still never authorized,
    // and sealing is idempotent across later boots.
    fixture.setProcessId(3003);
    fixture.setProcessNonce('c'.repeat(64));
    const laterBoot = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    expect(laterBoot).toMatchObject({ abandoned: 0, pendingOperations: 0, persisted: 0, refused: [] });
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toEqual([]);
    // The paid bytes are still on disk under their original name: sealing marks
    // the operation terminal, it never deletes the user's file.
    expect(fs.readFileSync(resultPath)).toEqual(WORD_PACKAGE);
  });

  it('never seals an operation whose boot is still alive under a stale seat revision', async () => {
    const fixture = setup('word');
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-live-boot', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    const operationId = commandEveOfficeOperationIdForRequest('queue-live-boot');
    const resultPath = path.join(fixture.workspace, 'live-result.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);

    // Same live Main, only the seat revision moved on. This work may still
    // complete, so sealing it would strand a recoverable operation.
    fixture.setRevision(8);
    const stale = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    expect(stale).toMatchObject({ abandoned: 0, refused: [] });
    expect(fixture.store().readOfficeOperationAbandonment('seat-office', 'conv-1', operationId)).toBeNull();
  });

  it('never seals a completed operation, so a delivered artifact keeps its completion receipt', async () => {
    const fixture = setup('word');
    const completed = await persistCompletedCreateArtifact(fixture, 'queue-completed-then-restart');
    const operationId = commandEveOfficeOperationIdForRequest('queue-completed-then-restart');

    fixture.setProcessId(2002);
    fixture.setProcessNonce('b'.repeat(64));
    fixture.setProcessAlive(false);

    const afterRestart = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => [],
    });
    expect(afterRestart).toMatchObject({ abandoned: 0, refused: [] });
    expect(fixture.store().readOfficeOperationAbandonment('seat-office', 'conv-1', operationId)).toBeNull();
    expect(fixture.store().readOfficeOperationCompletion('seat-office', 'conv-1', operationId)).not.toBeNull();
    expect(
      fixture
        .store()
        .listOfficeArtifacts('seat-office', 'conv-1')
        .map((artifact) => artifact.id)
    ).toEqual([completed.artifact.id]);
  });

  it('refuses symlink, hardlink, outside-workspace and malformed result sources', async () => {
    const fixture = setup('word');
    const target = path.join(fixture.workspace, 'target.docx');
    fs.writeFileSync(target, WORD_PACKAGE);
    const symlink = path.join(fixture.workspace, 'symlink.docx');
    const hardlink = path.join(fixture.workspace, 'hardlink.docx');
    const outside = path.join(fixture.root, 'outside.docx');
    const malformed = path.join(fixture.workspace, 'malformed.docx');
    fs.symlinkSync(target, symlink);
    fs.linkSync(target, hardlink);
    fs.writeFileSync(outside, WORD_PACKAGE);
    fs.writeFileSync(malformed, Buffer.from('not OOXML'));

    await Promise.all(
      [symlink, hardlink, outside, malformed].map(async (source, index) => {
        const begun = await beginCommandEveOfficeArtifactOperation(
          fixture.dataPath,
          {
            conversationId: 'conv-1',
            requestId: 'queue-unsafe-' + String(index),
            action: 'create',
            mode: 'word',
          },
          fixture.beginDeps
        );
        expect(begun.status).toBe('ready');
        if (begun.status !== 'ready') return;
        const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
          ...fixture.runtimeDeps,
          fetchTranscript: async () => transcript(begun.marker, source, { turnId: 'turn-' + String(index) }),
        });
        expect(summary.persisted).toBe(0);
      })
    );
    expect(fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toEqual([]);
  });

  it('reloads an unchanged historical source parent after Main restart but rejects a rewritten source revision', async () => {
    const fixture = setup('word');
    const parent = createParent(fixture, 'historical-parent');
    fixture.setRevision(1);
    fixture.setProcessNonce('b'.repeat(64));
    fixture.setProcessId(2002);

    await expect(listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)).resolves.toEqual(
      [parent.artifact]
    );

    const manifestPath = path.join(
      fixture.dataPath,
      'project-workspace',
      'conversation-artifacts',
      'seat-office',
      'conv-1',
      '.office-records',
      parent.artifact.id + '.json'
    );
    const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    rewritten.payload = {
      ...(rewritten.payload as Record<string, unknown>),
      seat_context_revision: 8,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(rewritten, null, 2)}\n`);

    expect(() => fixture.store().listOfficeArtifacts('seat-office', 'conv-1')).toThrow();
    await expect(listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)).resolves.toEqual(
      []
    );
  });

  it('rehashes immutable children on reload and excludes tampered bytes', async () => {
    const fixture = setup('word');
    const resultPath = path.join(fixture.workspace, 'result.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-reload', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    const child = fixture.store().listOfficeArtifacts('seat-office', 'conv-1')[0];
    const immutablePath = path.join(fixture.workspace, ...child.payload.path.split('/'));
    const manifestPath = path.join(
      fixture.dataPath,
      'project-workspace',
      'conversation-artifacts',
      'seat-office',
      'conv-1',
      '.office-records',
      child.id + '.json'
    );
    const manifestBytes = fs.readFileSync(manifestPath);
    const tamperedManifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
    tamperedManifest.payload = {
      ...(tamperedManifest.payload as Record<string, unknown>),
      seat_context_revision: 8,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(tamperedManifest, null, 2)}\n`);
    const fetchTampered = vi.fn(async () => transcript(begun.marker, resultPath));
    const tamperedReconcile = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: fetchTampered,
    });
    expect(tamperedReconcile.refused).toContainEqual({ operationId: 'office-store', reason: 'store-corrupt' });
    expect(fetchTampered).not.toHaveBeenCalled();
    await expect(listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)).resolves.toEqual(
      []
    );
    fs.writeFileSync(manifestPath, manifestBytes);

    const provenanceTamper = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
    provenanceTamper.payload = {
      ...(provenanceTamper.payload as Record<string, unknown>),
      source_turn_id: 'turn-rewritten',
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(provenanceTamper, null, 2)}\n`);
    const fetchAfterProvenanceTamper = vi.fn(async () => transcript(begun.marker, resultPath));
    const provenanceReconcile = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: fetchAfterProvenanceTamper,
    });
    expect(provenanceReconcile.refused).toContainEqual({ operationId: 'office-store', reason: 'store-corrupt' });
    expect(fetchAfterProvenanceTamper).not.toHaveBeenCalled();
    await expect(listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)).resolves.toEqual(
      []
    );
    fs.writeFileSync(manifestPath, manifestBytes);

    fixture.setRevision(1);
    fixture.setProcessNonce('b'.repeat(64));
    fixture.setProcessId(2002);
    await expect(listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)).resolves.toEqual(
      [child]
    );
    fs.writeFileSync(immutablePath, Buffer.from('tampered child'));

    await expect(listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)).resolves.toEqual(
      []
    );
  });

  it('fails closed when a durable child manifest is copied under a non-canonical artifact filename', async () => {
    const fixture = setup('word');
    const resultPath = path.join(fixture.workspace, 'copied-manifest.docx');
    fs.writeFileSync(resultPath, WORD_PACKAGE);
    const begun = await beginCommandEveOfficeArtifactOperation(
      fixture.dataPath,
      { conversationId: 'conv-1', requestId: 'queue-copied-manifest', action: 'create', mode: 'word' },
      fixture.beginDeps
    );
    expect(begun.status).toBe('ready');
    if (begun.status !== 'ready') return;
    await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript: async () => transcript(begun.marker, resultPath),
    });
    const child = fixture.store().listOfficeArtifacts('seat-office', 'conv-1')[0];
    const directory = path.join(
      fixture.dataPath,
      'project-workspace',
      'conversation-artifacts',
      'seat-office',
      'conv-1',
      '.office-records'
    );
    fs.copyFileSync(path.join(directory, child.id + '.json'), path.join(directory, 'copied-child.json'));
    const fetchTranscript = vi.fn(async () => transcript(begun.marker, resultPath));

    const summary = await reconcileConversationOfficeArtifacts(fixture.dataPath, 'conv-1', {
      ...fixture.runtimeDeps,
      fetchTranscript,
    });
    expect(summary.refused).toContainEqual({ operationId: 'office-store', reason: 'store-corrupt' });
    expect(fetchTranscript).not.toHaveBeenCalled();
    await expect(listCommandEveOfficeArtifactRecords(fixture.dataPath, 'conv-1', fixture.runtimeDeps)).resolves.toEqual(
      []
    );
  });
});

describe('Office transcript binding extractor', () => {
  it('requires a prepared-context marker and exact conversation/turn binding', () => {
    const operationId = 'officeop_' + 'a'.repeat(64);
    const marker = '<command-eve-office-operation version="1" id="' + operationId + '" />';
    const good = transcript(marker, '/workspace/result.docx');
    expect(extractCommandEveOfficeResultCandidates(good, 'conv-1')).toEqual([
      {
        operationId,
        messageId: 'msg-result',
        turnId: 'turn-1',
        directiveIndex: 0,
        source: '/workspace/result.docx',
        title: 'result.docx',
      },
    ]);
    const proseOnly = [{ ...good[0], content: { content: marker + '\nBitte erstellen.' } }, good[1]];
    expect(extractCommandEveOfficeResultCandidates(proseOnly, 'conv-1')).toEqual([]);
    const wrongTurn = [good[0], { ...good[1], turn_id: 'turn-other' }];
    expect(extractCommandEveOfficeResultCandidates(wrongTurn, 'conv-1')).toEqual([]);
    expect(extractCommandEveOfficeResultCandidates([{ ...good[0], turn_id: undefined }, good[1]], 'conv-1')).toEqual(
      []
    );
    expect(extractCommandEveOfficeResultCandidates([good[0], { ...good[1], turn_id: undefined }], 'conv-1')).toEqual(
      []
    );
    expect(
      extractCommandEveOfficeResultCandidates([{ ...good[0], conversation_id: undefined }, good[1]], 'conv-1')
    ).toEqual([]);
    expect(
      extractCommandEveOfficeResultCandidates([good[0], { ...good[1], conversation_id: undefined }], 'conv-1')
    ).toEqual([]);
    expect(extractCommandEveOfficeResultCandidates(good, 'conv-other')).toEqual([]);
  });
});
