import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readApprovedGeneratedArtifactPreview } from '@/process/bridge/generatedArtifactPreviewCore';

const temporaryRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eve-artifact-preview-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('generated artifact preview boundary', () => {
  it('reads a bounded PDF below the approved Downloads root', async () => {
    const root = await createRoot();
    const filePath = path.join(root, 'eve-output.pdf');
    await fs.writeFile(filePath, Buffer.from('%PDF-1.7\ncommand eve'));

    await expect(readApprovedGeneratedArtifactPreview({ path: filePath, kind: 'pdf' }, root)).resolves.toEqual({
      data: Buffer.from('%PDF-1.7\ncommand eve').toString('base64'),
      encoding: 'base64',
      mimeType: 'application/pdf',
      size: 20,
    });
  });

  it('rejects files outside the approved root and mismatched content', async () => {
    const root = await createRoot();
    const outside = await createRoot();
    const outsidePath = path.join(outside, 'private.pdf');
    const fakePdf = path.join(root, 'fake.pdf');
    await fs.writeFile(outsidePath, '%PDF-1.7\nprivate');
    await fs.writeFile(fakePdf, 'not a pdf');

    await expect(readApprovedGeneratedArtifactPreview({ path: outsidePath, kind: 'pdf' }, root)).resolves.toBeNull();
    await expect(readApprovedGeneratedArtifactPreview({ path: fakePdf, kind: 'pdf' }, root)).resolves.toBeNull();
  });

  it('rejects a symlink even when its target is below the approved root', async () => {
    const root = await createRoot();
    const target = path.join(root, 'target.pdf');
    const link = path.join(root, 'linked.pdf');
    await fs.writeFile(target, '%PDF-1.7\nprivate');
    await fs.symlink(target, link);

    await expect(readApprovedGeneratedArtifactPreview({ path: link, kind: 'pdf' }, root)).resolves.toBeNull();
  });

  it('rejects an artifact that exceeds the preview memory budget', async () => {
    const root = await createRoot();
    const filePath = path.join(root, 'oversized.html');
    await fs.writeFile(filePath, '<!doctype html>');
    await fs.truncate(filePath, 2 * 1024 * 1024 + 1);

    await expect(readApprovedGeneratedArtifactPreview({ path: filePath, kind: 'html' }, root)).resolves.toBeNull();
  });
});
