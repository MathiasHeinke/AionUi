/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 C3 — the app-owned capability surface.
 *
 * Two claims are being tested, and they pull in opposite directions:
 *
 *   - the READ half must actually work, or the whole envelope story is a demo;
 *   - the SPENDING half must be unreachable on a kill-switched or ineligible
 *     seat, because an MCP tool call does NOT pass through Hermes' approval
 *     prompt. Since 1.820.2 an ELIGIBLE seat (licence wire readable) is open BY
 *     DEFAULT and exactly `'0'` in the env is the kill-switch — the resolver in
 *     `agentVideoEditFlag.ts` decides, and it is enforced here rather than
 *     promised in a comment.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  artifactCapabilityBearerFilePath,
  artifactCapabilityCallHandler,
  COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG,
  ensureArtifactCapabilityBearer,
  isAgentVideoEditEnabled,
  provisionArtifactCapabilityBearerFile,
  type ArtifactCapabilityLoopbackDeps,
} from '@/process/commandEve/artifactCapabilityLoopback';
import { buildCommandEveArtifactContextHermesMcpServer } from '@/process/commandEve/runtimeBootstrapCore';
import {
  buildVideoConversationArtifact,
  type CommandEveVideoConversationArtifact,
} from '@/common/config/videoGenerationRequestCore';
import type { ArtifactCapabilityGrant } from '@/common/config/eveArtifactCapabilityHandleCore';
import { TYPED_UI_MIME_TYPE } from '@/common/typedUI';
import { typedUIFixture } from './typed-ui/fixtures';

let tmpRoot: string;

const HANDLE = `evecap_${'a'.repeat(64)}`;
const PERMIT = `evespend_${'c'.repeat(64)}`;

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
    id: 'video-1',
    conversationId: 'conv-1',
    createdAtMs: 1_754_000_000_000,
    path: '/tmp/videos/conv-1/video-1.mp4',
    artifact: {
      mimeType: 'video/mp4',
      sha256: 'b'.repeat(64),
      bytes: 10,
      durationSeconds: 5,
      resolution: '480p',
      estimatedCredits: 500,
      model: 'grok-imagine-video',
      dataBase64: '',
      tierId: 'sd',
    } as never,
  });
}

function deps(overrides: Partial<ArtifactCapabilityLoopbackDeps> = {}): ArtifactCapabilityLoopbackDeps {
  return {
    getDataPath: () => tmpRoot,
    listArtifactRecords: () => [artifact()],
    readGrant: () => GRANT,
    videoEdit: vi.fn(async () => ({
      ok: true as const,
      artifact: {} as never,
      conversationArtifact: { ...artifact(), id: 'video-edited' },
      mediaDirective: 'MEDIA: /tmp/videos/conv-1/video-edited.mp4',
      sourceArtifactId: 'video-1',
    })),
    isVideoEditEnabled: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ceve-capability-loopback-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('the loopback bearer', () => {
  it('is 32 bytes, 0600 and delivered only as a path', () => {
    const file = provisionArtifactCapabilityBearerFile(tmpRoot);
    expect(file).toBe(artifactCapabilityBearerFilePath(tmpRoot));
    expect(fs.statSync(file).mode & 0o077).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toHaveLength(64);
    expect(fs.readFileSync(file, 'utf8')).toBe(ensureArtifactCapabilityBearer());
  });
});

describe('the read half works', () => {
  it('publishes only a schema/catalog-valid declarative Typed UI envelope', async () => {
    const envelope = typedUIFixture();
    const result = await artifactCapabilityCallHandler({ operation: 'typed_ui_publish', envelope }, deps());
    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({
      ok: true,
      artifact_type: 'file',
      mime_type: TYPED_UI_MIME_TYPE,
      content: JSON.stringify(envelope),
    });

    const executable = structuredClone(envelope) as unknown as Record<string, unknown>;
    executable.javascript = 'alert(1)';
    const refused = await artifactCapabilityCallHandler(
      { operation: 'typed_ui_publish', envelope: executable },
      deps()
    );
    expect(refused).toMatchObject({ status: 400, payload: { ok: false, reason: 'typed-ui-envelope-invalid' } });

    const oversized = typedUIFixture();
    oversized.state.payload = 'x'.repeat(512 * 1024);
    await expect(
      artifactCapabilityCallHandler({ operation: 'typed_ui_publish', envelope: oversized }, deps())
    ).resolves.toMatchObject({
      status: 400,
      payload: { ok: false, reason: 'typed-ui-envelope-invalid' },
    });
  });

  it('answers artifact_get for a handle it minted', async () => {
    const result = await artifactCapabilityCallHandler({ operation: 'artifact_get', handle: HANDLE }, deps());
    expect(result.status).toBe(200);
    const payload = result.payload as { ok: boolean; artifact: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.artifact.artifact_id).toBe('video-1');
    expect(payload.artifact.duration_seconds).toBe(5);
    expect(payload.artifact.editable).toBe(true);
    // Legacy records still expose no absolute path or bytes.
    expect(JSON.stringify(payload)).not.toContain('/tmp/videos');
    expect(JSON.stringify(payload)).not.toContain('data:');
  });

  it('returns the verified workspace-relative path and reports external mutation in German', async () => {
    const workspace = path.join(tmpRoot, 'workspace');
    const relativePath = 'videos/launch-film-2026-08-17.mp4';
    const absolutePath = path.join(workspace, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const bytes = Buffer.from('video bytes');
    fs.writeFileSync(absolutePath, bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const stored = buildVideoConversationArtifact({
      id: 'video-1',
      conversationId: 'conv-1',
      createdAtMs: 1_754_000_000_000,
      path: absolutePath,
      relativePath,
      artifact: {
        mimeType: 'video/mp4',
        sha256,
        bytes: bytes.length,
        durationSeconds: 5,
        resolution: '480p',
        estimatedCredits: 500,
        model: 'grok-imagine-video',
        dataBase64: '',
        tierId: 'sd',
      } as never,
    });
    const canonicalGrant = { ...GRANT, artifact_sha256: sha256 };
    const d = deps({
      resolveWorkspace: async () => ({ status: 'ready', workspace }),
      readGrant: () => canonicalGrant,
      listArtifactRecords: () => [stored],
    });

    const present = await artifactCapabilityCallHandler({ operation: 'artifact_get', handle: HANDLE }, d);
    expect(present).toMatchObject({
      status: 200,
      payload: { artifact: { file_path: relativePath } },
    });
    expect(JSON.stringify(present.payload)).not.toContain(workspace);

    fs.writeFileSync(absolutePath, 'changed');
    const changed = await artifactCapabilityCallHandler({ operation: 'artifact_get', handle: HANDLE }, d);
    expect(changed).toEqual({
      status: 409,
      payload: {
        ok: false,
        reason: 'artifact-changed',
        message:
          'Die Datei wurde außerhalb von EVE verändert oder verschoben. Lege sie wieder am ursprünglichen Ort ab oder wähle sie erneut aus.',
      },
    });
  });

  it.each([
    ['image', true],
    ['image', false],
    ['video', true],
    ['video', false],
  ] as const)('returns a file path only for a project %s artifact (project=%s)', async (kind, hasProject) => {
    const relativePath = `${kind}s/asset.${kind === 'image' ? 'png' : 'mp4'}`;
    const workspace = hasProject
      ? path.join(tmpRoot, 'workspace')
      : path.join(tmpRoot, 'command-eve-temp-artifacts', 'conv-1');
    const absolutePath = path.join(workspace, ...relativePath.split('/'));
    const bytes = Buffer.from(`${kind} bytes`);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const grant = {
      ...GRANT,
      artifact_id: `${kind}-1`,
      artifact_sha256: sha256,
      operation: kind === 'image' ? 'image_edit' : 'video_edit',
    };
    const d = deps({
      ...(hasProject ? { resolveWorkspace: async () => ({ status: 'ready' as const, workspace }) } : {}),
      readGrant: () => grant,
      ...(kind === 'image'
        ? {
            readImageRecord: () =>
              ({
                id: 'image-1',
                status: 'active',
                payload: {
                  path: relativePath,
                  sha256,
                  size: bytes.length,
                  mime_type: 'image/png',
                },
              }) as never,
          }
        : {
            listArtifactRecords: () => [
              buildVideoConversationArtifact({
                id: 'video-1',
                conversationId: 'conv-1',
                createdAtMs: 1_754_000_000_000,
                path: absolutePath,
                relativePath,
                artifact: {
                  mimeType: 'video/mp4',
                  sha256,
                  bytes: bytes.length,
                  durationSeconds: 5,
                  resolution: '480p',
                  estimatedCredits: 500,
                  model: 'grok-imagine-video',
                  dataBase64: '',
                  tierId: 'sd',
                } as never,
              }),
            ],
          }),
    });

    const result = await artifactCapabilityCallHandler({ operation: 'artifact_get', handle: HANDLE }, d);
    expect(result.status).toBe(200);
    const artifact = (result.payload as { artifact: Record<string, unknown> }).artifact;
    if (hasProject) {
      expect(artifact.file_path).toBe(relativePath);
    } else {
      expect(Object.hasOwn(artifact, 'file_path')).toBe(false);
    }
  });

  it('refuses a handle it did not mint', async () => {
    const result = await artifactCapabilityCallHandler(
      { operation: 'artifact_get', handle: HANDLE },
      deps({ readGrant: () => undefined })
    );
    expect(result.status).toBe(404);
    expect((result.payload as { reason: string }).reason).toBe('handle-unknown');
  });

  it('refuses an operation it does not have', async () => {
    const result = await artifactCapabilityCallHandler({ operation: 'artifact_delete', handle: HANDLE }, deps());
    expect(result.status).toBe(400);
    expect((result.payload as { reason: string }).reason).toBe('unsupported-operation');
  });

  it('refuses a body that is not a request', async () => {
    expect((await artifactCapabilityCallHandler('edit the video', deps())).status).toBe(400);
    expect((await artifactCapabilityCallHandler(null, deps())).status).toBe(400);
  });
});

describe('the spending half follows the one resolver decision', () => {
  it('the MCP CHILD surface stays closed even when a stale carrier says "1"', () => {
    expect(isAgentVideoEditEnabled({})).toBe(false);
    expect(isAgentVideoEditEnabled({ [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '' })).toBe(false);
    expect(isAgentVideoEditEnabled({ [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: 'true' })).toBe(false);
    expect(isAgentVideoEditEnabled({ [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '0' })).toBe(false);
    expect(isAgentVideoEditEnabled({ [COMMAND_EVE_AGENT_VIDEO_EDIT_FLAG]: '1' })).toBe(false);
  });

  it('never reaches the edit path on a kill-switched or ineligible seat', async () => {
    const videoEdit = vi.fn();
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_edit', handle: HANDLE, instruction: 'gib der Aubergine ein Gesicht' },
      deps({ isVideoEditEnabled: () => false, videoEdit: videoEdit as never })
    );
    // 403, not 404. The capability exists and is deliberately closed; "unknown"
    // would teach the model to retry a door that will never open on its own.
    expect(result.status).toBe(403);
    expect((result.payload as { reason: string }).reason).toBe('agent-video-edit-disabled');
    expect(videoEdit).not.toHaveBeenCalled();
  });

  it('passes the handle, the permit and the instruction through UNCHANGED when enabled', async () => {
    const d = deps();
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_edit', handle: HANDLE, permit: PERMIT, instruction: 'gib der Aubergine ein Gesicht' },
      d
    );
    // The permit is forwarded verbatim and NOT defaulted or repaired here — the
    // shared handler is the only place that decides what an absent credential
    // means, so the two lanes cannot disagree about it.
    expect(d.videoEdit).toHaveBeenCalledWith({
      handle: HANDLE,
      permit: PERMIT,
      instruction: 'gib der Aubergine ein Gesicht',
    });
    expect(result.status).toBe(200);
    const payload = result.payload as Record<string, unknown>;
    expect(payload.artifact_id).toBe('video-edited');
    expect(payload.parent_artifact_id).toBe('video-1');
  });

  it('forwards an ABSENT permit as empty rather than inventing one', async () => {
    const d = deps();
    await artifactCapabilityCallHandler({ operation: 'video_edit', handle: HANDLE, instruction: 'x' }, d);
    expect(d.videoEdit).toHaveBeenCalledWith({ handle: HANDLE, permit: '', instruction: 'x' });
  });

  it('returns NO filesystem path to the model, in either direction', async () => {
    // The envelope's own rule is "no paths, ever". The first build broke it on
    // the way back out: `MEDIA: /Users/<name>/Downloads/…` shipped the account
    // name to a third-party API and into the transcript.
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_edit', handle: HANDLE, permit: PERMIT, instruction: 'gib der Aubergine ein Gesicht' },
      deps()
    );
    const serialized = JSON.stringify(result.payload);
    expect(serialized).not.toContain('MEDIA:');
    expect(serialized).not.toContain('/tmp/videos');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('data:');
    // POSITIVE CONTROL: the underlying handler DID return a path-bearing media
    // directive, so the assertions above are about this loopback stripping it
    // and not about a fixture that never carried one.
    const raw = await deps().videoEdit({ handle: HANDLE, instruction: 'x', permit: PERMIT });
    expect(raw.ok === true && raw.mediaDirective).toContain('/tmp/videos');
  });

  it('reports a REPLAYED result as replayed rather than as a fresh charge', async () => {
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_edit', handle: HANDLE, permit: PERMIT, instruction: 'x' },
      deps({
        videoEdit: (async () => ({
          ok: true as const,
          artifact: {} as never,
          conversationArtifact: { ...artifact(), id: 'video-edited' },
          mediaDirective: 'MEDIA: /tmp/videos/conv-1/video-edited.mp4',
          sourceArtifactId: 'video-1',
          replayed: true,
        })) as never,
      })
    );
    expect((result.payload as Record<string, unknown>).replayed).toBe(true);
  });

  it('reports the desktop refusal reason verbatim rather than a generic failure', async () => {
    const result = await artifactCapabilityCallHandler(
      { operation: 'video_edit', handle: HANDLE, instruction: 'x' },
      deps({
        videoEdit: (async () => ({
          ok: false as const,
          reasonCode: 'video-edit-artifact-changed',
          message: 'Die Videodatei hat sich geändert.',
          retryable: false,
        })) as never,
      })
    );
    expect(result.status).toBe(400);
    expect((result.payload as { reason: string }).reason).toBe('video-edit-artifact-changed');
  });
});

describe('the Hermes config entry', () => {
  const valid = {
    nodeExecutable: '/Applications/Command EVE.app/Contents/Resources/node',
    scriptPath: '/Applications/Command EVE.app/Contents/Resources/builtin-mcp-eve-artifacts.js',
    shimBaseUrl: 'http://127.0.0.1:25811',
    bearerFile: '/Users/test/Library/Application Support/eve/command-eve-runtime/artifact-capability-bearer',
  };

  it('emits a stdio entry that names only the PATH to the bearer', () => {
    const server = buildCommandEveArtifactContextHermesMcpServer(valid);
    expect(server?.id).toBe('aionui-eve-artifacts');
    expect(server?.command).toBe(valid.nodeExecutable);
    expect(server?.args).toEqual([valid.scriptPath]);
    expect(server?.env?.AIONUI_EVE_ARTIFACT_BEARER_FILE).toBe(valid.bearerFile);
    expect(server?.env?.AIONUI_EVE_ARTIFACT_BASE_URL).toBe('http://127.0.0.1:25811');
    // The secret itself must never enter config.yaml — only the path to the
    // 0600 file the child reads for itself.
    expect(JSON.stringify(server)).not.toContain(ensureArtifactCapabilityBearer());
  });

  it('refuses anything that is not an absolute path or a loopback URL', () => {
    expect(buildCommandEveArtifactContextHermesMcpServer({ ...valid, nodeExecutable: 'node' })).toBeUndefined();
    expect(buildCommandEveArtifactContextHermesMcpServer({ ...valid, scriptPath: './server.js' })).toBeUndefined();
    expect(buildCommandEveArtifactContextHermesMcpServer({ ...valid, bearerFile: 'bearer' })).toBeUndefined();
    // Not loopback: this is the one that would turn an app-owned capability into
    // off-host egress.
    expect(
      buildCommandEveArtifactContextHermesMcpServer({ ...valid, shimBaseUrl: 'http://example.com:25811' })
    ).toBeUndefined();
    expect(
      buildCommandEveArtifactContextHermesMcpServer({ ...valid, shimBaseUrl: 'https://127.0.0.1:25811' })
    ).toBeUndefined();
  });
});
