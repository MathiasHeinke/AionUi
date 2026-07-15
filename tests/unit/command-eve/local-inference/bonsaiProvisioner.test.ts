import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildProgressEmitter,
  downloadPinnedBonsaiArtifact,
  readBonsaiInstallStatus,
} from '@/process/commandEve/localInference/bonsaiProvisioner';
import {
  BONSAI_MODEL_ARTIFACT,
  BONSAI_RUNTIME_RELEASE,
  COMMAND_EVE_BONSAI_PILOT_VERSION,
  resolveBonsaiPilotPaths,
  type BonsaiPinnedArtifact,
} from '@/process/commandEve/localInference/bonsaiManifest';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; destinationPath: string; payload: Uint8Array; artifact: BonsaiPinnedArtifact } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-download-'));
  roots.push(root);
  const payload = new TextEncoder().encode('trusted-model-bytes');
  return {
    root,
    destinationPath: path.join(root, 'model.gguf'),
    payload,
    artifact: {
      id: 'model',
      url: 'https://example.test/model.gguf',
      fileName: 'model.gguf',
      sizeBytes: payload.byteLength,
      sha256: crypto.createHash('sha256').update(payload).digest('hex'),
    },
  };
}

describe('Bonsai resumable provisioner', () => {
  it('reports installed only when the pinned receipt, runtime, and exact model size agree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-install-status-'));
    roots.push(root);
    const paths = resolveBonsaiPilotPaths(root);
    fs.mkdirSync(path.dirname(paths.modelPath), { recursive: true });
    fs.mkdirSync(path.dirname(paths.serverPath), { recursive: true });
    fs.writeFileSync(paths.modelPath, '');
    fs.truncateSync(paths.modelPath, BONSAI_MODEL_ARTIFACT.sizeBytes);
    fs.writeFileSync(paths.serverPath, 'server');
    fs.mkdirSync(path.dirname(paths.receiptPath), { recursive: true });
    fs.writeFileSync(
      paths.receiptPath,
      `${JSON.stringify({
        version: COMMAND_EVE_BONSAI_PILOT_VERSION,
        status: 'ready',
        model: { sha256: BONSAI_MODEL_ARTIFACT.sha256 },
        runtime: { server_sha256: BONSAI_RUNTIME_RELEASE.serverSha256 },
      })}\n`
    );

    expect(readBonsaiInstallStatus(root)).toMatchObject({
      installed: true,
      installedSizeBytes: BONSAI_MODEL_ARTIFACT.sizeBytes,
    });

    fs.truncateSync(paths.modelPath, BONSAI_MODEL_ARTIFACT.sizeBytes - 1);
    expect(readBonsaiInstallStatus(root).installed).toBe(false);
  });

  it('ignores malformed progress receipts instead of surfacing untrusted UI state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-progress-status-'));
    roots.push(root);
    const paths = resolveBonsaiPilotPaths(root);
    fs.mkdirSync(path.dirname(paths.provisionProgressPath), { recursive: true });
    fs.writeFileSync(
      paths.provisionProgressPath,
      `${JSON.stringify({
        version: 'command-eve-bonsai-provision-progress/v0',
        status: 'pulling',
        total: 'not-a-number',
        completed: 1,
        percent: 999,
        updated_at: 'not-a-date',
      })}\n`
    );

    expect(readBonsaiInstallStatus(root).progress).toBeUndefined();
  });

  it('throttles durable progress writes while preserving the terminal receipt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bonsai-progress-throttle-'));
    roots.push(root);
    const paths = resolveBonsaiPilotPaths(root);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const rename = vi.spyOn(fs, 'renameSync');
    const emit = buildProgressEmitter(paths);

    for (let downloadedBytes = 1; downloadedBytes <= 1_000; downloadedBytes += 1) {
      emit({
        stage: 'download',
        artifact: 'model',
        downloadedBytes,
        expectedBytes: BONSAI_MODEL_ARTIFACT.sizeBytes,
        message: 'downloading',
      });
    }
    expect(rename).toHaveBeenCalledTimes(1);

    emit({ stage: 'ready', message: 'ready' });
    expect(rename).toHaveBeenCalledTimes(2);
    expect(readBonsaiInstallStatus(root).progress).toMatchObject({ status: 'done', percent: 100 });
  });

  it('writes on the destination volume, verifies the complete hash, and locks file permissions', async () => {
    const { destinationPath, payload, artifact } = fixture();
    const fetchImpl = vi.fn(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { 'content-length': String(payload.byteLength), etag: '"model-v1"' },
        })
    ) as unknown as typeof fetch;

    await downloadPinnedBonsaiArtifact({ destinationPath, artifact, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(destinationPath)).toEqual(Buffer.from(payload));
    expect(fs.statSync(destinationPath).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${destinationPath}.part`)).toBe(false);
  });

  it('binds a resumed range to its ETag and still rehashes the assembled file', async () => {
    const { destinationPath, payload, artifact } = fixture();
    const first = payload.slice(0, 6);
    const rest = payload.slice(6);
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        let reads = 0;
        return {
          ok: true,
          status: 200,
          url: artifact.url,
          headers: new Headers({ 'content-length': String(payload.byteLength), etag: '"model-v1"' }),
          body: {
            getReader: () => ({
              read: async () => {
                reads += 1;
                if (reads === 1) return { value: first, done: false };
                throw new Error('simulated interruption');
              },
            }),
          },
        } as unknown as Response;
      }
      expect(new Headers(init?.headers).get('range')).toBe(`bytes=${first.byteLength}-`);
      expect(new Headers(init?.headers).get('if-range')).toBe('"model-v1"');
      return new Response(rest, {
        status: 206,
        headers: {
          'content-length': String(rest.byteLength),
          'content-range': `bytes ${first.byteLength}-${payload.byteLength - 1}/${payload.byteLength}`,
          etag: '"model-v1"',
        },
      });
    }) as unknown as typeof fetch;

    await expect(downloadPinnedBonsaiArtifact({ destinationPath, artifact, fetchImpl })).rejects.toThrow(
      /simulated interruption/
    );
    await expect(downloadPinnedBonsaiArtifact({ destinationPath, artifact, fetchImpl })).resolves.toBeUndefined();

    expect(fs.readFileSync(destinationPath)).toEqual(Buffer.from(payload));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails before writing when the response length does not match the pin', async () => {
    const { destinationPath, payload, artifact } = fixture();
    const fetchImpl = vi.fn(
      async () =>
        new Response(payload, {
          status: 200,
          headers: { 'content-length': String(payload.byteLength - 1), etag: '"model-v1"' },
        })
    ) as unknown as typeof fetch;

    await expect(downloadPinnedBonsaiArtifact({ destinationPath, artifact, fetchImpl })).rejects.toThrow(
      /content length mismatch/
    );
    expect(fs.existsSync(destinationPath)).toBe(false);
  });
});
