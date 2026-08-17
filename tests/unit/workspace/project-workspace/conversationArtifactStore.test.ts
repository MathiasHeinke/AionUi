import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_EVE_OFFICE_LINEAGE_VERSION,
  COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
  commandEveOfficeFingerprint,
  commandEveOfficeMimeType,
  type CommandEveOfficeConversationArtifactPayload,
} from '@/common/types/office/artifactLineage';
import {
  commandEveOfficeArtifactRelativePath,
  commandEveOfficeSourceOperationId,
  ProjectWorkspaceConversationArtifactStore,
} from '@/process/services/project-workspace/storage/conversationArtifactStore';

const roots: string[] = [];
const payload = {
  artifact_id: 'artifact-alpha',
  state: 'preview' as const,
  intent_summary: 'Create a project for this conversation',
  target_label: 'Business · Managed',
  project_title: 'Launch',
  delta_summary: ['Project index', '.command-eve/project.json'],
  safe_follow_ups: [],
};
const officeSha = 'a'.repeat(64);
const officePayload: CommandEveOfficeConversationArtifactPayload = {
  artifact_type: 'file',
  artifact_id: 'office-alpha',
  title: 'Report.docx',
  file_name: 'Report.docx',
  mime_type: commandEveOfficeMimeType('word'),
  path: commandEveOfficeArtifactRelativePath('conversation-alpha', 'office-alpha', officeSha, 'word'),
  size: 42,
  hash: officeSha,
  managed_office: true,
  office_mode: 'word',
  origin_capability: COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
  origin_action: 'create',
  parent_artifact_id: null,
  source_sha256: officeSha,
  source_size: 42,
  source_fingerprint: commandEveOfficeFingerprint('word', officeSha, 42),
  result_sha256: officeSha,
  result_fingerprint: commandEveOfficeFingerprint('word', officeSha, 42),
  operation_id: 'officeop_' + '1'.repeat(64),
  seat_id: 'seat-alpha',
  seat_context_revision: 7,
  source_message_id: 'msg-office',
  source_turn_id: 'turn-office',
  source_directive_index: 0,
  source_tool: 'hermes_media_directive',
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-artifact-'));
  roots.push(root);
  const changed = vi.fn();
  const officeChanged = vi.fn();
  const store = new ProjectWorkspaceConversationArtifactStore({
    state_root: root,
    now: () => 42,
    on_changed: changed,
    on_office_changed: officeChanged,
  });
  return { root, store, changed, officeChanged };
}

function officeArtifactFile(root: string): string {
  return path.join(
    root,
    'conversation-artifacts',
    'seat-alpha',
    'conversation-alpha',
    '.office-records',
    officePayload.artifact_id + '.json'
  );
}

function officeOperationInput() {
  return {
    operation_id: 'officeop_' + '2'.repeat(64),
    request_id: 'queue-item-1',
    seat_id: 'seat-alpha',
    seat_context_revision: 7,
    process_id: 1001,
    process_nonce_sha256: '3'.repeat(64),
    workspace_identity_sha256: '4'.repeat(64),
    conversation_id: 'conversation-alpha',
    action: 'create' as const,
    mode: 'word' as const,
    parent_artifact_id: null,
    source_sha256: null,
    source_size: null,
    source_fingerprint: null,
  };
}

function officeSourcePayload(
  sourceTool: 'office_transcript_import' | 'aioncore_artifact_import'
): CommandEveOfficeConversationArtifactPayload {
  const messageId = sourceTool === 'office_transcript_import' ? 'msg-source' : null;
  const turnId = sourceTool === 'office_transcript_import' ? 'turn-source' : null;
  const directiveIndex = sourceTool === 'office_transcript_import' ? 0 : null;
  return {
    ...officePayload,
    origin_action: 'source',
    operation_id: commandEveOfficeSourceOperationId({
      seatId: 'seat-alpha',
      seatContextRevision: 7,
      conversationId: 'conversation-alpha',
      artifactId: officePayload.artifact_id,
      mode: 'word',
      resultSha256: officeSha,
      resultSize: 42,
      sourceTool,
      sourceMessageId: messageId,
      sourceTurnId: turnId,
      sourceDirectiveIndex: directiveIndex,
    }),
    source_message_id: messageId,
    source_turn_id: turnId,
    source_directive_index: directiveIndex,
    source_tool: sourceTool,
  };
}

function officeSecondSourcePayload(): CommandEveOfficeConversationArtifactPayload {
  const sha = 'c'.repeat(64);
  return {
    ...officePayload,
    artifact_id: 'office-beta',
    path: commandEveOfficeArtifactRelativePath('conversation-alpha', 'office-beta', sha, 'word'),
    hash: sha,
    source_sha256: sha,
    source_fingerprint: commandEveOfficeFingerprint('word', sha, 42),
    result_sha256: sha,
    result_fingerprint: commandEveOfficeFingerprint('word', sha, 42),
    origin_action: 'source',
    operation_id: commandEveOfficeSourceOperationId({
      seatId: 'seat-alpha',
      seatContextRevision: 7,
      conversationId: 'conversation-alpha',
      artifactId: 'office-beta',
      mode: 'word',
      resultSha256: sha,
      resultSize: 42,
      sourceTool: 'office_transcript_import',
      sourceMessageId: 'msg-source-beta',
      sourceTurnId: 'turn-source-beta',
      sourceDirectiveIndex: 0,
    }),
    source_message_id: 'msg-source-beta',
    source_turn_id: 'turn-source-beta',
    source_directive_index: 0,
    source_tool: 'office_transcript_import',
  };
}

describe('ProjectWorkspaceConversationArtifactStore', () => {
  it('persists before emitting and lists only the requested seat and conversation', () => {
    const { store, changed } = setup();
    store.create({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      payload,
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(store.list('seat-alpha', 'conversation-alpha')).toHaveLength(1);
    expect(store.list('seat-beta', 'conversation-alpha')).toEqual([]);
  });

  it('keeps timestamps monotone when multiple states share one clock tick', () => {
    const { store } = setup();
    const created = store.create({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      payload,
    });
    const committed = store.transition({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      expected_state: 'preview',
      payload: {
        ...payload,
        state: 'completed',
        receipt: { receipt_id: 'receipt-alpha', outcome: 'completed', completed_at: 42 },
      },
    });
    expect(committed.updated_at).toBeGreaterThan(created.updated_at);
  });

  it('rejects path-valued payloads before persistence or emission', () => {
    const { store, changed } = setup();
    expect(() =>
      store.create({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: payload.artifact_id,
        payload: { ...payload, target_label: '/Users/person/Private' },
      })
    ).toThrow();
    expect(changed).not.toHaveBeenCalled();
  });

  it('does not permit a terminal lifecycle downgrade', () => {
    const { store } = setup();
    store.create({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      payload,
    });
    store.transition({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      expected_state: 'preview',
      payload: { ...payload, state: 'completed' },
    });
    expect(() =>
      store.transition({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: payload.artifact_id,
        expected_state: 'completed',
        payload,
      })
    ).toThrow();
  });

  it('revises a completed artifact only at its exact persisted revision', () => {
    const { store } = setup();
    store.create({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      payload,
    });
    const completed = store.transition({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      expected_state: 'preview',
      payload: { ...payload, state: 'completed' },
    });
    const revised = store.reviseCompleted({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      expected_updated_at: completed.updated_at,
      payload: { ...payload, state: 'completed', project_title: 'Final', assignment_finalized_at: 43 },
    });
    expect(revised.updated_at).toBeGreaterThan(completed.updated_at);
    expect(revised.payload).toMatchObject({ project_title: 'Final', assignment_finalized_at: 43 });
  });

  it('rejects a stale completed-artifact rewrite without emitting', () => {
    const { store, changed } = setup();
    store.create({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      payload,
    });
    const completed = store.transition({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: payload.artifact_id,
      expected_state: 'preview',
      payload: { ...payload, state: 'completed' },
    });
    changed.mockClear();
    expect(() =>
      store.reviseCompleted({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: payload.artifact_id,
        expected_updated_at: completed.updated_at - 1,
        payload: { ...payload, state: 'completed', project_title: 'Stale' },
      })
    ).toThrow();
    expect(changed).not.toHaveBeenCalled();
  });

  it('rejects a fresh Office artifact whose embedded seat differs before writing store state', () => {
    const { root, store, officeChanged } = setup();
    expect(() =>
      store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: officePayload.artifact_id,
        payload: { ...officePayload, seat_id: 'seat-other' },
      })
    ).toThrow();
    expect(fs.existsSync(path.join(root, 'conversation-artifacts'))).toBe(false);
    expect(officeChanged).not.toHaveBeenCalled();
  });

  it.each(['artifact', 'operation', 'completion'] as const)(
    'refuses a symlinked seat directory before any %s lock, witness or record is written outside state root',
    (recordKind) => {
      const { root, store } = setup();
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-office-store-outside-'));
      roots.push(outside);
      const artifactRoot = path.join(root, 'conversation-artifacts');
      fs.mkdirSync(artifactRoot);
      fs.symlinkSync(outside, path.join(artifactRoot, 'seat-alpha'), 'dir');

      const write = () => {
        if (recordKind === 'artifact') {
          store.createOfficeArtifact({
            seat_id: 'seat-alpha',
            conversation_id: 'conversation-alpha',
            artifact_id: officePayload.artifact_id,
            payload: officePayload,
          });
          return;
        }
        if (recordKind === 'operation') {
          store.createOfficeOperation(officeOperationInput());
          return;
        }
        store.createOfficeOperationCompletion({
          seat_id: 'seat-alpha',
          seat_context_revision: 7,
          conversation_id: 'conversation-alpha',
          operation_id: 'officeop_' + '8'.repeat(64),
          artifact_receipts: [{ artifact_id: 'office-result-a', payload_sha256: 'a'.repeat(64) }],
        });
      };

      expect(write).toThrow();
      expect(fs.readdirSync(outside)).toEqual([]);
    }
  );

  it('uses the existing store substrate for immutable Office artifacts without widening the project facade', () => {
    const { store } = setup();
    const first = store.createOfficeArtifact({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: officePayload.artifact_id,
      payload: officePayload,
    });
    const replay = store.createOfficeArtifact({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: officePayload.artifact_id,
      payload: officePayload,
    });
    expect(replay).toEqual(first);
    expect(store.list('seat-alpha', 'conversation-alpha')).toEqual([]);
    expect(store.listOfficeArtifacts('seat-alpha', 'conversation-alpha')).toEqual([first]);
    expect(store.listOfficeArtifacts('seat-beta', 'conversation-alpha')).toEqual([]);

    const conflictingSha = 'b'.repeat(64);
    expect(() =>
      store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: officePayload.artifact_id,
        payload: {
          ...officePayload,
          hash: conflictingSha,
          source_sha256: conflictingSha,
          source_fingerprint: commandEveOfficeFingerprint('word', conflictingSha, 42),
          result_sha256: conflictingSha,
          result_fingerprint: commandEveOfficeFingerprint('word', conflictingSha, 42),
        },
      })
    ).toThrow();
  });

  it('rejects a manifest whose embedded conversation or seat no longer matches its directory membership', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-artifact-membership-'));
    roots.push(root);
    const store = new ProjectWorkspaceConversationArtifactStore({ state_root: root, now: () => 42 });
    store.createOfficeArtifact({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: officePayload.artifact_id,
      payload: officePayload,
    });
    const file = officeArtifactFile(root);
    const tampered = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    tampered.conversation_id = 'conversation-other';
    fs.writeFileSync(file, JSON.stringify(tampered));
    expect(() => store.readOfficeArtifact('seat-alpha', 'conversation-alpha', officePayload.artifact_id)).toThrow();
    expect(() => store.listOfficeArtifacts('seat-alpha', 'conversation-alpha')).toThrow();
    expect(() =>
      store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: officePayload.artifact_id,
        payload: officePayload,
      })
    ).toThrow();
  });

  it('rejects an Office manifest whose canonical filename differs from its embedded artifact id', () => {
    const { root, store } = setup();
    store.createOfficeArtifact({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: officePayload.artifact_id,
      payload: officePayload,
    });
    const file = officeArtifactFile(root);
    fs.copyFileSync(file, path.join(path.dirname(file), 'office-copy.json'));

    expect(() => store.listOfficeArtifacts('seat-alpha', 'conversation-alpha')).toThrow();
  });

  // One unreadable record used to hide EVERY Office document of the same
  // conversation, indefinitely and silently. The authority read still refuses
  // the whole directory; the display read withholds only the bad record and says
  // how many it withheld.
  it.each([
    [
      'a truncated record',
      (file: string) => {
        fs.writeFileSync(file, '{ this is not json');
      },
    ],
    [
      'a hardlinked record',
      (file: string) => {
        fs.linkSync(file, file + '.backup-link');
      },
    ],
  ])('isolates %s from the rest of the conversation on the display read', (_label, damage) => {
    const { root, store } = setup();
    const survivorPayload = officeSourcePayload('office_transcript_import');
    const survivor = store.createOfficeArtifact({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: survivorPayload.artifact_id,
      payload: survivorPayload,
    });
    const secondPayload = officeSecondSourcePayload();
    const damaged = store.createOfficeArtifact({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: secondPayload.artifact_id,
      payload: secondPayload,
    });
    expect(store.listOfficeArtifacts('seat-alpha', 'conversation-alpha')).toHaveLength(2);

    damage(path.join(path.dirname(officeArtifactFile(root)), damaged.id + '.json'));

    // Authority read: unchanged, still refuses the whole directory.
    expect(() => store.listOfficeArtifacts('seat-alpha', 'conversation-alpha')).toThrow();

    // Display read: the survivor is served, the damaged record is counted.
    const readable = store.listReadableOfficeArtifacts('seat-alpha', 'conversation-alpha');
    expect(readable.artifacts).toEqual([survivor]);
    expect(readable.skipped).toBe(1);

    const verified = store.listReadableOfficeArtifactsWithVerifiedRecordLineage('seat-alpha', 'conversation-alpha');
    expect(verified.artifacts).toEqual([survivor]);
    expect(verified.skipped).toBe(1);
  });

  it('serves an intact conversation identically on both reads and reports nothing skipped', () => {
    const { store } = setup();
    const sourcePayload = officeSourcePayload('office_transcript_import');
    const artifact = store.createOfficeArtifact({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: sourcePayload.artifact_id,
      payload: sourcePayload,
    });
    expect(store.listReadableOfficeArtifacts('seat-alpha', 'conversation-alpha')).toEqual({
      artifacts: [artifact],
      skipped: 0,
    });
    expect(store.listReadableOfficeArtifactsWithVerifiedRecordLineage('seat-alpha', 'conversation-alpha')).toEqual({
      artifacts: store.listOfficeArtifactsWithVerifiedRecordLineage('seat-alpha', 'conversation-alpha'),
      skipped: 0,
    });
    // A foreign seat still sees nothing at all.
    expect(store.listReadableOfficeArtifacts('seat-beta', 'conversation-alpha')).toEqual({
      artifacts: [],
      skipped: 0,
    });
  });

  it.each(['office_transcript_import', 'aioncore_artifact_import'] as const)(
    'rejects changed source tuple, seat revision and canonical path for %s parents',
    (sourceTool) => {
      const { root, store } = setup();
      const sourcePayload = officeSourcePayload(sourceTool);
      const artifact = store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: sourcePayload.artifact_id,
        payload: sourcePayload,
      });
      const file = officeArtifactFile(root);
      const replacements: CommandEveOfficeConversationArtifactPayload[] = [
        {
          ...sourcePayload,
          source_sha256: 'b'.repeat(64),
          source_fingerprint: commandEveOfficeFingerprint('word', 'b'.repeat(64), 42),
        },
        { ...sourcePayload, seat_context_revision: 8 },
        {
          ...sourcePayload,
          path: commandEveOfficeArtifactRelativePath(
            'conversation-alpha',
            sourcePayload.artifact_id,
            'b'.repeat(64),
            'word'
          ),
        },
      ];

      for (const replacement of replacements) {
        fs.writeFileSync(file, `${JSON.stringify({ ...artifact, payload: replacement }, null, 2)}\n`);
        expect(() => store.readOfficeArtifact('seat-alpha', 'conversation-alpha', sourcePayload.artifact_id)).toThrow();
        expect(() => store.listOfficeArtifacts('seat-alpha', 'conversation-alpha')).toThrow();
      }
    }
  );

  it('accepts an identical create-only race winner without replacing its bytes', () => {
    const { root, store, officeChanged } = setup();
    const file = officeArtifactFile(root);
    const winner = {
      id: officePayload.artifact_id,
      conversation_id: 'conversation-alpha',
      kind: 'file' as const,
      status: 'active' as const,
      payload: officePayload,
      created_at: 99,
      updated_at: 99,
    };
    const winnerBytes = Buffer.from(`${JSON.stringify(winner, null, 2)}\n`);
    const originalLink = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(file)) {
        fs.writeFileSync(destination, winnerBytes, { mode: 0o600 });
      }
      return originalLink(source, destination);
    });

    expect(
      store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: officePayload.artifact_id,
        payload: officePayload,
      })
    ).toEqual(winner);
    expect(fs.readFileSync(file)).toEqual(winnerBytes);
    expect(officeChanged).not.toHaveBeenCalled();
  });

  it('refuses a wrong-conversation create-only race winner without replacing its bytes or emitting', () => {
    const { root, store, officeChanged } = setup();
    const file = officeArtifactFile(root);
    const winner = {
      id: officePayload.artifact_id,
      conversation_id: 'conversation-other',
      kind: 'file' as const,
      status: 'active' as const,
      payload: officePayload,
      created_at: 99,
      updated_at: 99,
    };
    const winnerBytes = Buffer.from(`${JSON.stringify(winner, null, 2)}\n`);
    const originalLink = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(file)) {
        fs.writeFileSync(destination, winnerBytes, { mode: 0o600 });
      }
      return originalLink(source, destination);
    });

    expect(() =>
      store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: officePayload.artifact_id,
        payload: officePayload,
      })
    ).toThrow();
    expect(fs.readFileSync(file)).toEqual(winnerBytes);
    expect(officeChanged).not.toHaveBeenCalled();
  });

  it('leaves no final Office manifest when create-only promotion aborts after the write', () => {
    const { root, store, officeChanged } = setup();
    const file = officeArtifactFile(root);
    const originalLink = fs.linkSync.bind(fs);
    let writtenTemporarySeen = false;
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(file)) {
        writtenTemporarySeen = fs.readFileSync(source, 'utf8').includes(officePayload.artifact_id);
        const error = new Error('injected Office manifest promotion failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return originalLink(source, destination);
    });

    expect(() =>
      store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: officePayload.artifact_id,
        payload: officePayload,
      })
    ).toThrow('injected Office manifest promotion failure');
    expect(writtenTemporarySeen).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(
      fs.existsSync(path.dirname(file))
        ? fs.readdirSync(path.dirname(file)).filter((entry) => entry.includes(officePayload.artifact_id))
        : []
    ).toEqual([]);
    expect(officeChanged).not.toHaveBeenCalled();
  });

  it('rejects a published Office manifest when temp cleanup leaves a mutable hardlink alias', () => {
    const { root, store, officeChanged } = setup();
    const file = officeArtifactFile(root);
    const originalUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((candidate) => {
      const name = path.basename(String(candidate));
      if (name.startsWith('.' + officePayload.artifact_id + '.json.') && name.endsWith('.tmp')) {
        const error = new Error('injected Office manifest temp cleanup failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return originalUnlink(candidate);
    });

    expect(() =>
      store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: officePayload.artifact_id,
        payload: officePayload,
      })
    ).toThrow();
    const aliases = fs
      .readdirSync(path.dirname(file))
      .filter((entry) => entry.startsWith('.' + officePayload.artifact_id + '.json.') && entry.endsWith('.tmp'));
    expect(aliases).toHaveLength(1);
    expect(fs.lstatSync(file).nlink).toBe(2);
    expect(() => store.readOfficeArtifact('seat-alpha', 'conversation-alpha', officePayload.artifact_id)).toThrow();
    expect(() => store.listOfficeArtifacts('seat-alpha', 'conversation-alpha')).toThrow();
    expect(() =>
      store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: officePayload.artifact_id,
        payload: officePayload,
      })
    ).toThrow();
    expect(officeChanged).not.toHaveBeenCalled();
  });

  it('rejects a canonical-path inode swap during an immutable Office manifest read', () => {
    const { root, store } = setup();
    store.createOfficeArtifact({
      seat_id: 'seat-alpha',
      conversation_id: 'conversation-alpha',
      artifact_id: officePayload.artifact_id,
      payload: officePayload,
    });
    const file = officeArtifactFile(root);
    const displaced = file + '.displaced';
    const originalReadFile = fs.readFileSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((source: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const result = originalReadFile(
        source,
        ...(args as Parameters<typeof fs.readFileSync> extends [unknown, ...infer Rest] ? Rest : never)
      );
      if (!swapped && typeof source === 'number') {
        const opened = fs.fstatSync(source);
        const named = fs.lstatSync(file);
        if (opened.dev === named.dev && opened.ino === named.ino) {
          fs.renameSync(file, displaced);
          fs.writeFileSync(file, result, { encoding: 'utf8', mode: 0o600 });
          swapped = true;
        }
      }
      return result;
    }) as typeof fs.readFileSync);

    expect(() => store.readOfficeArtifact('seat-alpha', 'conversation-alpha', officePayload.artifact_id)).toThrow();
    expect(swapped).toBe(true);
  });

  it('repairs strict directory-chain durability before accepting a linked manifest retry', () => {
    const { root, store, officeChanged } = setup();
    const file = officeArtifactFile(root);
    const originalLink = fs.linkSync.bind(fs);
    const originalFsync = fs.fsyncSync.bind(fs);
    let published = false;
    let directoryFlushesAfterPublish = 0;
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      const result = originalLink(source, destination);
      if (path.resolve(String(destination)) === path.resolve(file)) published = true;
      return result;
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (published && fs.fstatSync(descriptor).isDirectory()) {
        directoryFlushesAfterPublish += 1;
        if (directoryFlushesAfterPublish === 2) throw new Error('injected Office record chain failure');
      }
      return originalFsync(descriptor);
    });

    expect(() =>
      store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: officePayload.artifact_id,
        payload: officePayload,
      })
    ).toThrow('injected Office record chain failure');
    expect(fs.existsSync(file)).toBe(true);
    expect(officeChanged).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    let repairFlushes = 0;
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) repairFlushes += 1;
      return originalFsync(descriptor);
    });
    expect(
      store.createOfficeArtifact({
        seat_id: 'seat-alpha',
        conversation_id: 'conversation-alpha',
        artifact_id: officePayload.artifact_id,
        payload: officePayload,
      })
    ).toMatchObject({ id: officePayload.artifact_id });
    expect(repairFlushes).toBeGreaterThan(0);
    expect(officeChanged).not.toHaveBeenCalled();
  });

  it('persists one idempotent Office operation and rejects changed retry provenance', () => {
    const { store } = setup();
    const input = officeOperationInput();
    const first = store.createOfficeOperation(input);
    expect(store.createOfficeOperation(input)).toEqual(first);
    expect(store.listOfficeOperations('seat-alpha', 'conversation-alpha')).toEqual([first]);
    expect(() => store.createOfficeOperation({ ...input, mode: 'excel' })).toThrow();
  });

  it('creates one immutable Office completion receipt and rejects changed retry provenance', () => {
    const { store } = setup();
    const input = {
      seat_id: 'seat-alpha',
      seat_context_revision: 7,
      conversation_id: 'conversation-alpha',
      operation_id: 'officeop_' + '4'.repeat(64),
      artifact_receipts: [
        { artifact_id: 'office-result-b', payload_sha256: 'b'.repeat(64) },
        { artifact_id: 'office-result-a', payload_sha256: 'a'.repeat(64) },
      ],
    };
    const first = store.createOfficeOperationCompletion(input);
    expect(first.artifact_receipts.map((receipt) => receipt.artifact_id)).toEqual([
      'office-result-a',
      'office-result-b',
    ]);
    expect(
      store.createOfficeOperationCompletion({
        ...input,
        artifact_receipts: input.artifact_receipts.toReversed(),
      })
    ).toEqual(first);
    expect(store.readOfficeOperationCompletion('seat-alpha', 'conversation-alpha', input.operation_id)).toEqual(first);
    expect(() =>
      store.createOfficeOperationCompletion({ ...input, artifact_receipts: [input.artifact_receipts[1]] })
    ).toThrow();
    expect(() => store.createOfficeOperationCompletion({ ...input, seat_context_revision: 8 })).toThrow();
  });

  it('accepts identical operation and completion race winners with independent timestamps', () => {
    const { root, store } = setup();
    const operationInput = officeOperationInput();
    const completionInput = {
      seat_id: 'seat-alpha',
      seat_context_revision: 7,
      conversation_id: 'conversation-alpha',
      operation_id: operationInput.operation_id,
      artifact_receipts: [{ artifact_id: 'office-result-a', payload_sha256: 'a'.repeat(64) }],
    };
    const operationWinner = {
      version: COMMAND_EVE_OFFICE_LINEAGE_VERSION,
      ...operationInput,
      origin_capability: COMMAND_EVE_OFFICE_ORIGIN_CAPABILITY,
      created_at: 99,
    };
    const completionWinner = {
      version: COMMAND_EVE_OFFICE_LINEAGE_VERSION,
      ...completionInput,
      completed_at: 101,
    };
    const operationFile = path.join(
      root,
      'conversation-artifacts',
      'seat-alpha',
      'conversation-alpha',
      '.office-operations',
      operationInput.operation_id + '.json'
    );
    const completionFile = path.join(path.dirname(operationFile), '.completed', operationInput.operation_id + '.json');
    const winnerByPath = new Map([
      [path.resolve(operationFile), `${JSON.stringify(operationWinner, null, 2)}\n`],
      [path.resolve(completionFile), `${JSON.stringify(completionWinner, null, 2)}\n`],
    ]);
    const originalLink = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      const winner = winnerByPath.get(path.resolve(String(destination)));
      if (winner) fs.writeFileSync(destination, winner, { mode: 0o600 });
      return originalLink(source, destination);
    });

    expect(store.createOfficeOperation(operationInput)).toEqual(operationWinner);
    expect(store.createOfficeOperationCompletion(completionInput)).toEqual(completionWinner);
    expect(fs.readFileSync(operationFile, 'utf8')).toBe(winnerByPath.get(path.resolve(operationFile)));
    expect(fs.readFileSync(completionFile, 'utf8')).toBe(winnerByPath.get(path.resolve(completionFile)));
  });

  it('fails closed on wrong Office completion seat, conversation and file membership', () => {
    const { root, store } = setup();
    const operationId = 'officeop_' + '5'.repeat(64);
    const completion = store.createOfficeOperationCompletion({
      seat_id: 'seat-alpha',
      seat_context_revision: 7,
      conversation_id: 'conversation-alpha',
      operation_id: operationId,
      artifact_receipts: [{ artifact_id: 'office-result-a', payload_sha256: 'a'.repeat(64) }],
    });
    const directory = path.join(
      root,
      'conversation-artifacts',
      'seat-alpha',
      'conversation-alpha',
      '.office-operations',
      '.completed'
    );
    const file = path.join(directory, operationId + '.json');

    for (const tampered of [
      { ...completion, seat_id: 'seat-other' },
      { ...completion, conversation_id: 'conversation-other' },
      { ...completion, operation_id: 'officeop_' + '6'.repeat(64) },
    ]) {
      fs.writeFileSync(file, JSON.stringify(tampered));
      expect(() => store.readOfficeOperationCompletion('seat-alpha', 'conversation-alpha', operationId)).toThrow();
    }

    fs.writeFileSync(file, JSON.stringify(completion));
    const wrongFileOperationId = 'officeop_' + '7'.repeat(64);
    fs.writeFileSync(path.join(directory, wrongFileOperationId + '.json'), JSON.stringify(completion));
    expect(() =>
      store.readOfficeOperationCompletion('seat-alpha', 'conversation-alpha', wrongFileOperationId)
    ).toThrow();
  });
});
