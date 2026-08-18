import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishCanonicalArtifact,
  verifyCanonicalArtifact,
} from '@/process/services/project-workspace/storage/canonicalArtifactPlacement';

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-canonical-artifact-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const dataPath = path.join(root, 'data');
  fs.mkdirSync(workspace);
  fs.mkdirSync(dataPath);
  return { root, workspace, dataPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('canonical visible artifact placement', () => {
  it.each([
    ['bilder', 'png'],
    ['videos', 'mp4'],
    ['dokumente', 'pdf'],
    ['dokumente', 'pptx'],
    ['dokumente', 'xlsx'],
    ['dokumente', 'docx'],
  ] as const)('publishes %s/%s with a speaking dated name and no empty sibling folders', (folder, extension) => {
    const { workspace, dataPath } = fixture();
    const placed = publishCanonicalArtifact({
      dataPath,
      workspaceRoot: workspace,
      folder,
      nameHint: 'Kampagne JABADS',
      fallbackName: 'artefakt',
      extension,
      nowMs: new Date(2026, 7, 17, 12).getTime(),
      bytes: Buffer.from(`${folder}-${extension}`),
    });

    expect(placed.relativePath).toBe(`${folder}/kampagne-jabads-2026-08-17.${extension}`);
    expect(fs.statSync(placed.absolutePath).nlink).toBe(1);
    expect(fs.readFileSync(placed.absolutePath, 'utf8')).toBe(`${folder}-${extension}`);
    for (const sibling of ['bilder', 'videos', 'dokumente']) {
      expect(fs.existsSync(path.join(workspace, sibling))).toBe(sibling === folder);
    }
  });

  it('uses -2/-3 collisions without replacing an existing user file', () => {
    const { workspace, dataPath } = fixture();
    const write = (contents: string) =>
      publishCanonicalArtifact({
        dataPath,
        workspaceRoot: workspace,
        folder: 'bilder',
        nameHint: 'Logo',
        fallbackName: 'bild',
        extension: 'png',
        nowMs: new Date(2026, 7, 17, 12).getTime(),
        bytes: Buffer.from(contents),
      });
    expect(write('one').relativePath).toBe('bilder/logo-2026-08-17.png');
    expect(write('two').relativePath).toBe('bilder/logo-2026-08-17-2.png');
    expect(write('three').relativePath).toBe('bilder/logo-2026-08-17-3.png');
    expect(fs.readFileSync(path.join(workspace, 'bilder/logo-2026-08-17.png'), 'utf8')).toBe('one');
  });

  it('reports a moved or externally changed file honestly instead of serving stale bytes', () => {
    const { workspace, dataPath } = fixture();
    const bytes = Buffer.from('original');
    const placed = publishCanonicalArtifact({
      dataPath,
      workspaceRoot: workspace,
      folder: 'dokumente',
      nameHint: 'Bericht',
      fallbackName: 'dokument',
      extension: 'pdf',
      bytes,
    });
    fs.writeFileSync(placed.absolutePath, 'changed');
    expect(
      verifyCanonicalArtifact({
        workspaceRoot: workspace,
        relativePath: placed.relativePath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      })
    ).toEqual({
      ok: false,
      message:
        'Die Datei wurde außerhalb von EVE verändert oder verschoben. Lege sie wieder am ursprünglichen Ort ab oder wähle sie erneut aus.',
    });
  });

  it('rejects a file reached through a symlinked intermediate workspace folder', () => {
    const { root, workspace } = fixture();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const bytes = Buffer.from('outside-but-named-like-a-project-file');
    const externalFile = path.join(outside, 'bild.png');
    fs.writeFileSync(externalFile, bytes);
    fs.symlinkSync(outside, path.join(workspace, 'bilder'));

    expect(
      verifyCanonicalArtifact({
        workspaceRoot: workspace,
        relativePath: 'bilder/bild.png',
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      })
    ).toEqual({
      ok: false,
      message:
        'Die Datei wurde außerhalb von EVE verändert oder verschoben. Lege sie wieder am ursprünglichen Ort ab oder wähle sie erneut aus.',
    });
  });

  it('rejects a same-size path replacement that occurs while the verified descriptor is being read', () => {
    const { workspace, dataPath } = fixture();
    const bytes = Buffer.from('ORIGINAL');
    const placed = publishCanonicalArtifact({
      dataPath,
      workspaceRoot: workspace,
      folder: 'bilder',
      nameHint: 'Race',
      fallbackName: 'bild',
      extension: 'png',
      bytes,
    });
    const moved = `${placed.absolutePath}.moved`;
    const realRead = fs.readFileSync;
    let replaced = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const result = (realRead as (...args: unknown[]) => Buffer)(file, ...rest);
      if (typeof file === 'number' && !replaced) {
        replaced = true;
        fs.renameSync(placed.absolutePath, moved);
        fs.writeFileSync(placed.absolutePath, 'REPLACED', { mode: 0o600 });
      }
      return result;
    }) as typeof fs.readFileSync);

    expect(
      verifyCanonicalArtifact({
        workspaceRoot: workspace,
        relativePath: placed.relativePath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      })
    ).toEqual({
      ok: false,
      message:
        'Die Datei wurde außerhalb von EVE verändert oder verschoben. Lege sie wieder am ursprünglichen Ort ab oder wähle sie erneut aus.',
    });
  });

  it('emits the cleanup notice once at 100 and then only at the next doubling', () => {
    const { workspace, dataPath } = fixture();
    const notices: number[] = [];
    for (let index = 1; index <= 200; index += 1) {
      const placed = publishCanonicalArtifact({
        dataPath,
        workspaceRoot: workspace,
        folder: 'videos',
        nameHint: `clip ${index}`,
        fallbackName: 'video',
        extension: 'mp4',
        bytes: Buffer.from([index % 255]),
      });
      if (placed.cleanupNotice) notices.push(index);
    }
    expect(notices).toEqual([100, 200]);
  });
});
