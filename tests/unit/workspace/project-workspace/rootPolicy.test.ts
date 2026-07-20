import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalizeRoot,
  findRootOwnershipConflict,
  resolveProjectTarget,
  rootComparisonKey,
} from '@process/services/project-workspace/storage/rootPolicy';

describe('project root policy', () => {
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-root-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('canonicalizes a private writable directory without changing its identity', () => {
    const result = canonicalizeRoot(tempRoot);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason_code);
    expect(result.canonical_path).toBe(fs.realpathSync.native(tempRoot));
    expect(result.comparison_key).toBe(rootComparisonKey(result.canonical_path));
  });

  it('rejects a symlink root before registration', () => {
    const link = `${tempRoot}-link`;
    fs.symlinkSync(tempRoot, link);
    try {
      expect(canonicalizeRoot(link)).toMatchObject({ ok: false, reason_code: 'root.symlink' });
    } finally {
      fs.unlinkSync(link);
    }
  });

  it('detects identical, parent-child, case, and NFC/NFD aliases across seats', () => {
    const candidate = {
      root_id: '22222222-2222-4222-8222-222222222222',
      seat_id: 'seat-beta',
      canonical_path: '/Volumes/Data/Proje\u0301cts/Client',
      comparison_key: rootComparisonKey('/Volumes/Data/Proje\u0301cts/Client'),
    };
    const records = [
      {
        root_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        seat_id: 'seat-alpha',
        canonical_path: '/volumes/data/Proj\u00e9cts',
        comparison_key: rootComparisonKey('/volumes/data/Proj\u00e9cts'),
      },
    ];
    expect(findRootOwnershipConflict(candidate, records)).toMatchObject({
      reason_code: 'root.overlap',
      owner_seat_id: 'seat-alpha',
    });
  });

  it('rejects traversal and a project nested below another registered project', () => {
    expect(resolveProjectTarget(tempRoot, '../escape', [])).toMatchObject({
      ok: false,
      reason_code: 'root.escape',
    });
    const existing = path.join(tempRoot, 'parent');
    fs.mkdirSync(existing);
    expect(resolveProjectTarget(tempRoot, 'parent/child', [existing])).toMatchObject({
      ok: false,
      reason_code: 'root.project-overlap',
    });
  });
});
