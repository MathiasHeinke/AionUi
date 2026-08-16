import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveCommandEveOfficeArtifactAttachment,
  validateOfficePackageBuffer,
  type CommandEveOfficeArtifactAttachmentDeps,
} from '@/process/commandEve/officeArtifactAttachmentCore';
import {
  handleCommandEveArtifactContextEnvelope,
  type CommandEveArtifactContextEnvelopeDeps,
} from '@/process/bridge/commandEveVideoBridge';

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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
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
    content: { content: `Fertig.\nMEDIA: ${source}` },
  };
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
  });

  it.each([
    ['word', '/private/staged/report.docx'],
    ['excel', '/private/staged/model.xlsx'],
  ] as const)('extends the existing envelope with the exact selected %s source', async (mode, stagedPath) => {
    const resolver = vi.fn().mockResolvedValue({ status: 'ready', path: stagedPath });
    const deps: CommandEveArtifactContextEnvelopeDeps = {
      getDataPath: () => '/private/data',
      buildEntries: () => [],
      isVideoEditEnabled: () => false,
      isImageEditEnabled: () => false,
      resolveOfficeAttachment: resolver,
    };
    const result = await handleCommandEveArtifactContextEnvelope(
      {
        conversationId: 'conv-1',
        selectedArtifactIds: ['artifact-1'],
        requestedOfficeMode: mode,
      },
      deps
    );
    expect(result).toEqual({
      envelope: '',
      officeAttachment: { status: 'ready', path: stagedPath },
    });
    expect(resolver).toHaveBeenCalledWith({ conversationId: 'conv-1', artifactId: 'artifact-1', mode });
  });

  it('refuses an Office envelope request with no single selected artifact', async () => {
    const resolver = vi.fn();
    const result = await handleCommandEveArtifactContextEnvelope(
      { conversationId: 'conv-1', selectedArtifactIds: [], requestedOfficeMode: 'excel' },
      {
        getDataPath: () => '/private/data',
        buildEntries: () => [],
        isVideoEditEnabled: () => false,
        isImageEditEnabled: () => false,
        resolveOfficeAttachment: resolver,
      }
    );
    expect(result).toEqual({
      envelope: '',
      officeAttachment: { status: 'refused', reasonCode: 'invalid-request' },
    });
    expect(resolver).not.toHaveBeenCalled();
  });
});
