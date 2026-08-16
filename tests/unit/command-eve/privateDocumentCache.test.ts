import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writePrivateDocumentImmutable } from '@/process/commandEve/document/privateDocumentCache';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(name = 'artifact.docx') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-private-document-'));
  roots.push(root);
  return { root, target: path.join(root, 'immutable', name), bytes: Buffer.from('durable-office-bytes') };
}

describe('writePrivateDocumentImmutable', () => {
  it('flushes bytes before create-only publication and flushes the directory before returning', () => {
    const { root, target, bytes } = fixture();
    const events: string[] = [];
    const originalFsync = fs.fsyncSync.bind(fs);
    const originalLink = fs.linkSync.bind(fs);
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      events.push(fs.fstatSync(descriptor).isDirectory() ? 'directory-flush' : 'byte-flush');
      return originalFsync(descriptor);
    });
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      events.push('create-only-publish');
      return originalLink(source, destination);
    });

    writePrivateDocumentImmutable(root, target, bytes);

    expect(events).toEqual(['directory-flush', 'byte-flush', 'create-only-publish', 'directory-flush']);
    expect(fs.readFileSync(target)).toEqual(bytes);
    expect(fs.lstatSync(target).nlink).toBe(1);
  });

  it('leaves no published file when byte flush fails before publication', () => {
    const { root, target, bytes } = fixture();
    const originalFsync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (!fs.fstatSync(descriptor).isDirectory()) throw new Error('injected byte flush failure');
      return originalFsync(descriptor);
    });

    expect(() => writePrivateDocumentImmutable(root, target, bytes)).toThrow('injected byte flush failure');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.dirname(target))).toEqual([]);
  });

  it('leaves no published file when atomic create-only publication fails after the byte flush', () => {
    const { root, target, bytes } = fixture();
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      const error = new Error('injected publication failure') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    });

    expect(() => writePrivateDocumentImmutable(root, target, bytes)).toThrow('injected publication failure');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.dirname(target))).toEqual([]);
  });

  it('requires directory durability again after an interrupted publication window', () => {
    const { root, target, bytes } = fixture();
    const originalFsync = fs.fsyncSync.bind(fs);
    const originalLink = fs.linkSync.bind(fs);
    let published = false;
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      const result = originalLink(source, destination);
      published = true;
      return result;
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (published && fs.fstatSync(descriptor).isDirectory()) {
        throw new Error('injected directory flush failure');
      }
      return originalFsync(descriptor);
    });

    expect(() => writePrivateDocumentImmutable(root, target, bytes)).toThrow('injected directory flush failure');
    expect(fs.readFileSync(target)).toEqual(bytes);
    vi.restoreAllMocks();
    expect(() => writePrivateDocumentImmutable(root, target, bytes)).not.toThrow();
  });

  it.each([1, 2, 3])(
    'refuses publication when new-directory parent flush %s fails and repairs the chain on retry',
    (failedParentFlush) => {
      const { root, bytes } = fixture();
      const target = path.join(root, 'level-one', 'level-two', 'level-three', 'artifact.docx');
      const originalFsync = fs.fsyncSync.bind(fs);
      const publish = vi.spyOn(fs, 'linkSync');
      let directoryFlushes = 0;
      vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
        if (fs.fstatSync(descriptor).isDirectory()) {
          directoryFlushes += 1;
          if (directoryFlushes === failedParentFlush) {
            throw new Error('injected parent directory flush failure');
          }
        }
        return originalFsync(descriptor);
      });

      expect(() => writePrivateDocumentImmutable(root, target, bytes)).toThrow(
        'injected parent directory flush failure'
      );
      expect(publish).not.toHaveBeenCalled();
      expect(fs.existsSync(target)).toBe(false);

      vi.restoreAllMocks();
      expect(() => writePrivateDocumentImmutable(root, target, bytes)).not.toThrow();
      expect(fs.readFileSync(target)).toEqual(bytes);
    }
  );

  it('refuses symlink, hardlink and conflicting-byte targets without replacing them', () => {
    const { root, bytes } = fixture();
    const existing = path.join(root, 'existing.docx');
    fs.writeFileSync(existing, bytes);
    const symlink = path.join(root, 'symlink.docx');
    const hardlink = path.join(root, 'hardlink.docx');
    const conflicting = path.join(root, 'conflicting.docx');
    fs.symlinkSync(existing, symlink);
    fs.linkSync(existing, hardlink);
    fs.writeFileSync(conflicting, Buffer.from('different bytes'));

    for (const target of [symlink, hardlink, conflicting]) {
      expect(() => writePrivateDocumentImmutable(root, target, bytes)).toThrow(
        'Immutable document target conflicts with persisted bytes.'
      );
    }
    expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(existing).nlink).toBe(2);
    expect(fs.readFileSync(conflicting)).toEqual(Buffer.from('different bytes'));
  });
});
