import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  handleCommandEveImageArtifactInputResolveBridge,
  type CommandEveImageArtifactInputResolveDeps,
} from '@/process/bridge/commandEveImageArtifactBridge';
import {
  materializeCommandEveManagedImageInProject,
  resolveCommandEveManagedArtifactInput,
  type CommandEveManagedArtifactInputResolverDeps,
} from '@/process/commandEve/managedArtifactInputResolver';
import {
  bindStagedImageArtifact,
  readImageArtifactBytes,
  readImageArtifactRecordById,
  stageGeneratedImageArtifact,
} from '@/process/commandEve/imageArtifactStore';
import {
  areCommandEveFileSelectionPathsGranted,
  clearCommandEveFileSelectionGrantsForTests,
  registerCommandEveFileSelectionGrant,
} from '@/process/commandEve/fileSelectionGrantCore';
import {
  publishCanonicalArtifact,
  verifyCanonicalArtifact,
} from '@/process/services/project-workspace/storage/canonicalArtifactPlacement';
import { readApprovedGeneratedArtifactPreview } from '@/process/bridge/generatedArtifactPreviewCore';

const SEAT_A = 'seat-alpha';
const SEAT_B = 'seat-beta';
const CONVERSATION_A = 'conversation-alpha';
const CONVERSATION_B = 'conversation-beta';
const IMAGE_BYTES = Buffer.from('managed-image-input-bytes');
const PROMPT_SHA256 = crypto.createHash('sha256').update('prompt').digest('hex');

let dataPath: string;
let projectWorkspace: string;
let downloadsRoot: string;
let activeSeatId: string;
let activeSeatContextRevision: number;
let listedArtifacts: unknown[];

function seedPdfArtifact(sourcePath: string, artifactId = 'pdf-source-1', conversationId = CONVERSATION_A): void {
  listedArtifacts = [
    {
      id: artifactId,
      conversation_id: conversationId,
      kind: 'file',
      status: 'active',
      payload: {
        artifact_type: 'file',
        path: sourcePath,
        mime_type: 'application/pdf',
      },
    },
  ];
}

function seedActiveImage(conversationId = CONVERSATION_A): string {
  const staged = stageGeneratedImageArtifact(dataPath, {
    capturedSeatId: SEAT_A,
    bytes: IMAGE_BYTES,
    mimeType: 'image/png',
    tier: 'quality',
    model: 'openai/gpt-image-2',
    resolution: '1K',
    aspectRatio: '2:3',
    promptSha256: PROMPT_SHA256,
  });
  if (!staged) throw new Error('failed to stage test image');
  const bound = bindStagedImageArtifact(dataPath, {
    conversationId,
    handle: staged.handle,
    toolCallId: 'tool-call-input-resolver',
    expectedSeatId: SEAT_A,
  });
  if (!bound.ok) throw new Error(`failed to bind test image: ${bound.reason}`);
  return bound.record.id;
}

function resolverDeps(
  overrides: Partial<CommandEveManagedArtifactInputResolverDeps> = {}
): CommandEveManagedArtifactInputResolverDeps {
  const fetchArtifacts: typeof fetch = async () =>
    new Response(JSON.stringify({ data: listedArtifacts }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  return {
    getDataPath: () => dataPath,
    getActiveSeatId: () => activeSeatId,
    getActiveSeatContextRevision: () => activeSeatContextRevision,
    readRecord: readImageArtifactRecordById,
    readBytes: readImageArtifactBytes,
    resolveConversationAuthority: async () => ({
      status: 'ready',
      backendPort: 9999,
      workspace: projectWorkspace,
      seatId: activeSeatId,
      seatContextRevision: activeSeatContextRevision,
    }),
    publishCanonicalArtifact,
    verifyCanonicalArtifact,
    registerFileSelectionGrant: registerCommandEveFileSelectionGrant,
    readGeneratedArtifactPreview: readApprovedGeneratedArtifactPreview,
    getDownloadsRoot: () => downloadsRoot,
    getBackendPort: () => 9999,
    fetch: fetchArtifacts,
    ...overrides,
  };
}

beforeEach(() => {
  dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-managed-artifact-input-'));
  projectWorkspace = path.join(dataPath, 'project-workspace');
  downloadsRoot = path.join(dataPath, 'Downloads');
  activeSeatId = SEAT_A;
  activeSeatContextRevision = 1;
  listedArtifacts = [];
  fs.mkdirSync(projectWorkspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(downloadsRoot, { recursive: true, mode: 0o700 });
});

afterEach(() => {
  clearCommandEveFileSelectionGrantsForTests();
  fs.rmSync(dataPath, { recursive: true, force: true });
});

describe('resolveCommandEveManagedArtifactInput', () => {
  it('hands an exact project-relative PDF edit source to Hermes through the ordinary read grant', async () => {
    const sourcePath = path.join(projectWorkspace, 'dokumente', 'palmen-report.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sourcePath, '%PDF-1.7\nproject pdf');
    seedPdfArtifact('dokumente/palmen-report.pdf');

    const result = await resolveCommandEveManagedArtifactInput(
      { conversationId: CONVERSATION_A, artifactId: 'pdf-source-1', sourcePath: 'dokumente/palmen-report.pdf' },
      resolverDeps()
    );

    expect(result).toEqual({ status: 'ready', agentFilePath: sourcePath });
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [sourcePath],
        seatId: SEAT_A,
        purpose: 'read',
      })
    ).toBe(true);
  });

  it('accepts a selected Downloads PDF without copying it into the transcript or workspace', async () => {
    const sourcePath = path.join(downloadsRoot, 'palmen-report.pdf');
    fs.writeFileSync(sourcePath, '%PDF-1.7\ndownloaded pdf');
    seedPdfArtifact(sourcePath);

    await expect(
      resolveCommandEveManagedArtifactInput(
        { conversationId: CONVERSATION_A, artifactId: 'pdf-source-1', sourcePath },
        resolverDeps()
      )
    ).resolves.toEqual({ status: 'ready', agentFilePath: sourcePath });
  });

  it('fails closed for a PDF outside the named conversation workspace', async () => {
    const otherWorkspace = path.join(dataPath, 'other-project');
    const sourcePath = path.join(otherWorkspace, 'dokumente', 'palmen-report.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sourcePath, '%PDF-1.7\nwrong conversation');
    seedPdfArtifact('dokumente/palmen-report.pdf', 'pdf-source-1', CONVERSATION_A);

    await expect(
      resolveCommandEveManagedArtifactInput(
        { conversationId: CONVERSATION_B, artifactId: 'pdf-source-1', sourcePath: 'dokumente/palmen-report.pdf' },
        resolverDeps({
          resolveConversationAuthority: async (conversationId) =>
            conversationId === CONVERSATION_A
              ? {
                  status: 'ready',
                  backendPort: 9999,
                  workspace: projectWorkspace,
                  seatId: activeSeatId,
                  seatContextRevision: activeSeatContextRevision,
                }
              : { status: 'refused', reasonCode: 'conversation-unavailable' },
        })
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
  });

  it('fails closed for an invalid PDF signature before it grants the selected source', async () => {
    const sourcePath = path.join(projectWorkspace, 'dokumente', 'not-a-pdf.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sourcePath, 'not a pdf');
    seedPdfArtifact('dokumente/not-a-pdf.pdf');

    await expect(
      resolveCommandEveManagedArtifactInput(
        { conversationId: CONVERSATION_A, artifactId: 'pdf-source-1', sourcePath: 'dokumente/not-a-pdf.pdf' },
        resolverDeps()
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'source-unsafe' });
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [sourcePath],
        seatId: SEAT_A,
        purpose: 'read',
      })
    ).toBe(false);
  });

  it('does not return a PDF path when the active seat changes during validation', async () => {
    const sourcePath = path.join(projectWorkspace, 'dokumente', 'palmen-report.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sourcePath, '%PDF-1.7\nproject pdf');
    seedPdfArtifact('dokumente/palmen-report.pdf');

    await expect(
      resolveCommandEveManagedArtifactInput(
        { conversationId: CONVERSATION_A, artifactId: 'pdf-source-1', sourcePath: 'dokumente/palmen-report.pdf' },
        resolverDeps({
          readGeneratedArtifactPreview: async (...args) => {
            const preview = await readApprovedGeneratedArtifactPreview(...args);
            activeSeatContextRevision += 1;
            return preview;
          },
        })
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'seat-changed' });
  });

  it('refuses a syntactically valid PDF artifact id that is absent from the conversation artifact list', async () => {
    const sourcePath = path.join(projectWorkspace, 'dokumente', 'palmen-report.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sourcePath, '%PDF-1.7\nproject pdf');

    await expect(
      resolveCommandEveManagedArtifactInput(
        { conversationId: CONVERSATION_A, artifactId: 'pdf-unseeded', sourcePath: 'dokumente/palmen-report.pdf' },
        resolverDeps()
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
  });

  it('refuses when the stored PDF belongs to another artifact id', async () => {
    const sourcePath = path.join(projectWorkspace, 'dokumente', 'palmen-report.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sourcePath, '%PDF-1.7\nproject pdf');
    seedPdfArtifact('dokumente/palmen-report.pdf', 'pdf-stored');

    await expect(
      resolveCommandEveManagedArtifactInput(
        { conversationId: CONVERSATION_A, artifactId: 'pdf-requested', sourcePath: 'dokumente/palmen-report.pdf' },
        resolverDeps()
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
  });

  it('refuses when the renderer source path disagrees with the exact stored PDF artifact', async () => {
    const sourcePath = path.join(projectWorkspace, 'dokumente', 'palmen-report.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(sourcePath, '%PDF-1.7\nproject pdf');
    seedPdfArtifact('dokumente/palmen-report.pdf');

    await expect(
      resolveCommandEveManagedArtifactInput(
        { conversationId: CONVERSATION_A, artifactId: 'pdf-source-1', sourcePath: 'dokumente/anderer-report.pdf' },
        resolverDeps()
      )
    ).resolves.toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
  });

  it('materializes one exact active managed image as an immutable workspace-relative input and normal read grant', async () => {
    const artifactId = seedActiveImage();
    const record = readImageArtifactRecordById(dataPath, artifactId, SEAT_A);
    if (!record || record.status !== 'active' || !record.payload.path) throw new Error('active image record missing');

    const result = await resolveCommandEveManagedArtifactInput(
      { conversationId: CONVERSATION_A, artifactId },
      resolverDeps()
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(path.relative(projectWorkspace, result.agentFilePath).split(path.sep).join('/')).toBe(record.payload.path);
    expect(fs.readFileSync(result.agentFilePath)).toEqual(IMAGE_BYTES);
    expect(fs.lstatSync(result.agentFilePath).isSymbolicLink()).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(dataPath, 'command-eve-managed-image-artifacts', 'locations', `${artifactId}.json`),
          'utf8'
        )
      )
    ).toEqual({ workspace: projectWorkspace });
    expect(readImageArtifactRecordById(dataPath, artifactId, SEAT_A)?.payload.cleanup_notice).toBeUndefined();
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [result.agentFilePath],
        seatId: SEAT_A,
        purpose: 'read',
      })
    ).toBe(true);
  });

  it('materializes a bound image in the Main-attested project without minting an agent read grant', async () => {
    const artifactId = seedActiveImage();
    const deps = resolverDeps({
      resolveConversationAuthority: async () => {
        throw new Error('the generic conversation workspace must not choose the project target');
      },
    });

    const result = await materializeCommandEveManagedImageInProject(
      { conversationId: CONVERSATION_A, artifactId },
      {
        status: 'ready',
        backendPort: 9999,
        workspace: projectWorkspace,
        seatId: SEAT_A,
        seatContextRevision: 1,
      },
      deps
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(path.relative(projectWorkspace, result.agentFilePath).split(path.sep).join('/')).toMatch(/^bilder\//);
    expect(fs.readFileSync(result.agentFilePath)).toEqual(IMAGE_BYTES);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(dataPath, 'command-eve-managed-image-artifacts', 'locations', `${artifactId}.json`),
          'utf8'
        )
      )
    ).toEqual({ workspace: projectWorkspace });
    expect(readImageArtifactRecordById(dataPath, artifactId, SEAT_A)?.payload.cleanup_notice).toBeUndefined();
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [result.agentFilePath],
        seatId: SEAT_A,
        purpose: 'read',
      })
    ).toBe(false);
  });

  it('reuses the durable project placement and grants it to a later Hermes document turn', async () => {
    const artifactId = seedActiveImage();
    const deps = resolverDeps({
      resolveConversationAuthority: async () => ({
        status: 'temporary',
        seatId: SEAT_A,
        seatContextRevision: 1,
      }),
    });

    const materialized = await materializeCommandEveManagedImageInProject(
      { conversationId: CONVERSATION_A, artifactId },
      {
        status: 'ready',
        backendPort: 9999,
        workspace: projectWorkspace,
        seatId: SEAT_A,
        seatContextRevision: 1,
      },
      deps
    );
    expect(materialized.status).toBe('ready');

    const resolved = await resolveCommandEveManagedArtifactInput({ conversationId: CONVERSATION_A, artifactId }, deps);

    expect(resolved.status).toBe('ready');
    if (resolved.status !== 'ready') return;
    expect(path.relative(projectWorkspace, resolved.agentFilePath).split(path.sep).join('/')).toMatch(/^bilder\//);
    expect(resolved.agentFilePath).not.toContain(`hermes-temp-${CONVERSATION_A}`);
    expect(
      areCommandEveFileSelectionPathsGranted({
        filePaths: [resolved.agentFilePath],
        seatId: SEAT_A,
        purpose: 'read',
      })
    ).toBe(true);
  });

  it('refuses an active artifact when the named conversation differs', async () => {
    const artifactId = seedActiveImage();

    const result = await resolveCommandEveManagedArtifactInput(
      { conversationId: CONVERSATION_B, artifactId },
      resolverDeps()
    );

    expect(result).toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
  });

  it('refuses a cross-seat replay before it reads or stages source bytes', async () => {
    const artifactId = seedActiveImage();
    activeSeatId = SEAT_B;
    const result = await resolveCommandEveManagedArtifactInput(
      { conversationId: CONVERSATION_A, artifactId },
      resolverDeps()
    );

    expect(result).toEqual({ status: 'refused', reasonCode: 'artifact-unavailable' });
  });

  it('reuses the same immutable workspace copy for an idempotent replay', async () => {
    const artifactId = seedActiveImage();
    const request = { conversationId: CONVERSATION_A, artifactId } as const;

    const first = await resolveCommandEveManagedArtifactInput(request, resolverDeps());
    const second = await resolveCommandEveManagedArtifactInput(request, resolverDeps());

    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    if (first.status !== 'ready' || second.status !== 'ready') return;
    expect(second.agentFilePath).toBe(first.agentFilePath);
  });

  it('publishes into the exact existing ACP temp workspace when the conversation has no project', async () => {
    const artifactId = seedActiveImage();
    const tempWorkspace = path.join(dataPath, 'conversations', `hermes-temp-${CONVERSATION_A}`);
    fs.mkdirSync(tempWorkspace, { recursive: true, mode: 0o700 });

    const result = await resolveCommandEveManagedArtifactInput(
      { conversationId: CONVERSATION_A, artifactId },
      resolverDeps({
        resolveConversationAuthority: async () => ({
          status: 'temporary',
          seatId: SEAT_A,
          seatContextRevision: 1,
        }),
      })
    );

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(path.relative(fs.realpathSync.native(tempWorkspace), result.agentFilePath)).toMatch(/^bilder[/\\]/);
    expect(fs.readFileSync(result.agentFilePath)).toEqual(IMAGE_BYTES);
  });

  it('accepts the maintained CLI conversations-root symlink', async () => {
    const artifactId = seedActiveImage();
    const cliConversationsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-cli-conversations-'));
    const realTempWorkspace = path.join(cliConversationsRoot, `hermes-temp-${CONVERSATION_A}`);
    fs.mkdirSync(realTempWorkspace, { recursive: true, mode: 0o700 });
    fs.symlinkSync(cliConversationsRoot, path.join(dataPath, 'conversations'));
    try {
      const result = await resolveCommandEveManagedArtifactInput(
        { conversationId: CONVERSATION_A, artifactId },
        resolverDeps({
          resolveConversationAuthority: async () => ({
            status: 'temporary',
            seatId: SEAT_A,
            seatContextRevision: 1,
          }),
        })
      );

      expect(result.status).toBe('ready');
      if (result.status !== 'ready') return;
      expect(path.relative(fs.realpathSync.native(realTempWorkspace), result.agentFilePath)).toMatch(/^bilder[/\\]/);
    } finally {
      fs.rmSync(cliConversationsRoot, { recursive: true, force: true });
    }
  });

  it('rejects a temp-workspace child symlink that escapes the authoritative conversations root', async () => {
    const artifactId = seedActiveImage();
    const conversationsRoot = path.join(dataPath, 'conversations');
    fs.mkdirSync(conversationsRoot, { recursive: true, mode: 0o700 });
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-temp-workspace-escape-'));
    const outsideWorkspace = path.join(outsideRoot, `hermes-temp-${CONVERSATION_A}`);
    fs.mkdirSync(outsideWorkspace, { recursive: true, mode: 0o700 });
    fs.symlinkSync(outsideWorkspace, path.join(conversationsRoot, `hermes-temp-${CONVERSATION_A}`));
    try {
      const result = await resolveCommandEveManagedArtifactInput(
        { conversationId: CONVERSATION_A, artifactId },
        resolverDeps({
          resolveConversationAuthority: async () => ({
            status: 'temporary',
            seatId: SEAT_A,
            seatContextRevision: 1,
          }),
        })
      );

      expect(result).toEqual({ status: 'refused', reasonCode: 'stage-failed' });
      expect(fs.existsSync(path.join(outsideWorkspace, 'bilder'))).toBe(false);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not invent a temp workspace when the authoritative ACP directory is absent', async () => {
    const artifactId = seedActiveImage();

    const result = await resolveCommandEveManagedArtifactInput(
      { conversationId: CONVERSATION_A, artifactId },
      resolverDeps({
        resolveConversationAuthority: async () => ({
          status: 'temporary',
          seatId: SEAT_A,
          seatContextRevision: 1,
        }),
      })
    );

    expect(result).toEqual({ status: 'refused', reasonCode: 'stage-failed' });
    expect(fs.existsSync(path.join(dataPath, 'conversations', `hermes-temp-${CONVERSATION_A}`))).toBe(false);
  });

  it('rejects an authority response bound to another seat revision before publication', async () => {
    const artifactId = seedActiveImage();

    const result = await resolveCommandEveManagedArtifactInput(
      { conversationId: CONVERSATION_A, artifactId },
      resolverDeps({
        resolveConversationAuthority: async () => ({
          status: 'ready',
          backendPort: 9999,
          workspace: projectWorkspace,
          seatId: SEAT_A,
          seatContextRevision: 2,
        }),
      })
    );

    expect(result).toEqual({ status: 'refused', reasonCode: 'seat-changed' });
    expect(fs.existsSync(path.join(projectWorkspace, 'bilder'))).toBe(false);
  });

  it('fails closed when persisted source bytes no longer match the active record hash', async () => {
    const artifactId = seedActiveImage();

    const result = await resolveCommandEveManagedArtifactInput(
      { conversationId: CONVERSATION_A, artifactId },
      resolverDeps({ readBytes: () => Buffer.from('mutated-bytes') })
    );

    expect(result).toEqual({ status: 'refused', reasonCode: 'source-unsafe' });
  });

  it('ignores a mutated workspace candidate and creates a fresh immutable copy', async () => {
    const artifactId = seedActiveImage();
    const request = { conversationId: CONVERSATION_A, artifactId } as const;
    const initial = await resolveCommandEveManagedArtifactInput(request, resolverDeps());
    if (initial.status !== 'ready') throw new Error('initial stage failed');
    fs.writeFileSync(initial.agentFilePath, 'tampered-after-stage');

    const result = await resolveCommandEveManagedArtifactInput(request, resolverDeps());

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.agentFilePath).not.toBe(initial.agentFilePath);
    expect(fs.readFileSync(result.agentFilePath)).toEqual(IMAGE_BYTES);
    expect(readImageArtifactRecordById(dataPath, artifactId, SEAT_A)?.payload.path).toBe(
      path.relative(projectWorkspace, result.agentFilePath).split(path.sep).join('/')
    );
  });

  it('rejects a symbolic-link images directory', async () => {
    const artifactId = seedActiveImage();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-artifact-input-outside-'));
    try {
      fs.symlinkSync(outside, path.join(projectWorkspace, 'bilder'));

      const result = await resolveCommandEveManagedArtifactInput(
        { conversationId: CONVERSATION_A, artifactId },
        resolverDeps()
      );

      expect(result).toEqual({ status: 'refused', reasonCode: 'stage-failed' });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not return a path if the active seat changes during workspace publication', async () => {
    const artifactId = seedActiveImage();
    const deps = resolverDeps({
      verifyCanonicalArtifact: (input) => {
        const verified = verifyCanonicalArtifact(input);
        if (verified.ok) activeSeatContextRevision += 1;
        return verified;
      },
    });

    const result = await resolveCommandEveManagedArtifactInput({ conversationId: CONVERSATION_A, artifactId }, deps);

    expect(result).toEqual({ status: 'refused', reasonCode: 'seat-changed' });
  });

  it('returns the strict IPC result without a transcript or tool-result payload', async () => {
    const artifactId = seedActiveImage();
    const bridgeDeps: CommandEveImageArtifactInputResolveDeps = resolverDeps();

    const response = await handleCommandEveImageArtifactInputResolveBridge(
      { conversationId: CONVERSATION_A, artifactId },
      bridgeDeps
    );

    expect(response.success).toBe(true);
    expect(response.data.status).toBe('ready');
    if (response.data.status !== 'ready') return;
    expect(Object.keys(response.data)).toEqual(['status', 'agentFilePath']);
  });

  it('does not report a project path when the store cannot adopt the verified placement', async () => {
    const artifactId = seedActiveImage();

    const result = await resolveCommandEveManagedArtifactInput(
      { conversationId: CONVERSATION_A, artifactId },
      resolverDeps({ adoptProjectPlacement: () => false })
    );

    expect(result).toEqual({ status: 'refused', reasonCode: 'stage-failed' });
  });

  it('refuses a verified path when the ordinary read grant cannot be registered', async () => {
    const artifactId = seedActiveImage();

    const result = await resolveCommandEveManagedArtifactInput(
      { conversationId: CONVERSATION_A, artifactId },
      resolverDeps({ registerFileSelectionGrant: () => false })
    );

    expect(result).toEqual({ status: 'refused', reasonCode: 'stage-failed' });
  });
});
