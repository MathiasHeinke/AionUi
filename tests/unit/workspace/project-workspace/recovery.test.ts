import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildProjectUndoQuarantinePlan,
  establishProjectUndoQuarantine,
  prepareProjectUndoQuarantine,
  projectUndoQuarantineBasename,
  purgeProjectUndoQuarantine,
  reconcileProjectUndoQuarantine,
  removeAdoptionAdditions,
  removeCreatedTree,
  restoreProjectUndoQuarantine,
} from '@process/services/project-workspace/transaction/recovery';

const TRANSACTION_ID = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const REALM_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_ID = '22222222-2222-4222-8222-222222222222';

function sha256(contents: string): string {
  return crypto.createHash('sha256').update(contents, 'utf8').digest('hex');
}

function catalogProof(root: string) {
  return {
    expected_revision: 7,
    expected_record: {
      project_id: PROJECT_ID,
      seat_id: 'seat-alpha',
      realm_id: REALM_ID,
      root_id: ROOT_ID,
      workspace_root_ref: `root:${ROOT_ID}` as const,
      title: 'Project Fixture',
      slug: 'project-fixture',
      status: 'active' as const,
      manifest_relative_path: 'project-fixture/.command-eve/project.json',
      canonical_project_path: root,
      comparison_key: root,
      registered_at: '2026-07-20T00:00:00.000Z',
    },
  };
}

describe('project workspace removal identity fences', () => {
  let parent: string;

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-removal-'));
  });

  afterEach(() => {
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it.each([
    ['create', removeCreatedTree],
    ['adopt', removeAdoptionAdditions],
  ] as const)('refuses a %s deletion when content changes after the initial hash check', (_mode, remove) => {
    const root = path.join(parent, 'project');
    fs.mkdirSync(root);
    const file = path.join(root, 'AGENTS.md');
    fs.writeFileSync(file, 'owned\n');
    const removed = remove(root, [{ relative_path: 'AGENTS.md', sha256: sha256('owned\n') }], [], [], (target) => {
      if (target === file) fs.appendFileSync(file, 'user edit\n');
    });
    expect(removed).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('owned\nuser edit\n');
  });

  it.each([
    ['create', removeCreatedTree],
    ['adopt', removeAdoptionAdditions],
  ] as const)('refuses a same-hash/new-inode ABA replacement during %s deletion', (_mode, remove) => {
    const root = path.join(parent, 'project');
    fs.mkdirSync(root);
    const file = path.join(root, 'AGENTS.md');
    fs.writeFileSync(file, 'owned\n');
    const originalInode = fs.lstatSync(file).ino;
    const removed = remove(root, [{ relative_path: 'AGENTS.md', sha256: sha256('owned\n') }], [], [], (target) => {
      if (target !== file) return;
      const replacement = path.join(parent, 'replacement');
      fs.writeFileSync(replacement, 'owned\n');
      fs.renameSync(replacement, file);
    });
    expect(removed).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('owned\n');
    expect(fs.lstatSync(file).ino).not.toBe(originalInode);
  });

  it('retains an allowed receipt when its inode changes immediately before unlink', () => {
    const root = path.join(parent, 'project');
    const receipt = path.join(root, '.command-eve', 'receipts', 'receipt.json');
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    fs.writeFileSync(receipt, '{"status":"committed"}\n');
    const removed = removeCreatedTree(
      root,
      [],
      ['.command-eve/receipts', '.command-eve'],
      ['.command-eve/receipts/receipt.json'],
      (target) => {
        if (target !== receipt) return;
        const replacement = path.join(parent, 'receipt-replacement');
        fs.writeFileSync(replacement, '{"status":"committed"}\n');
        fs.renameSync(replacement, receipt);
      }
    );
    expect(removed).toBe(false);
    expect(fs.readFileSync(receipt, 'utf8')).toContain('committed');
  });

  it('refuses to remove a created directory whose inode was swapped', () => {
    const root = path.join(parent, 'project');
    const docs = path.join(root, 'docs');
    fs.mkdirSync(docs, { recursive: true });
    const originalInode = fs.lstatSync(docs).ino;
    const removed = removeAdoptionAdditions(root, [], ['docs'], [], (target) => {
      if (target !== docs) return;
      fs.renameSync(docs, path.join(parent, 'original-docs'));
      fs.mkdirSync(docs);
    });
    expect(removed).toBe(false);
    expect(fs.lstatSync(docs).ino).not.toBe(originalInode);
  });

  it('refuses to remove a create root whose inode was swapped', () => {
    const root = path.join(parent, 'project');
    fs.mkdirSync(root);
    const originalInode = fs.lstatSync(root).ino;
    const removed = removeCreatedTree(root, [], [], [], (target) => {
      if (target !== root) return;
      fs.renameSync(root, path.join(parent, 'original-project'));
      fs.mkdirSync(root);
    });
    expect(removed).toBe(false);
    expect(fs.lstatSync(root).ino).not.toBe(originalInode);
  });

  it.each([
    ['create', removeCreatedTree],
    ['adopt', removeAdoptionAdditions],
  ] as const)('quarantines and preserves a file swapped at the %s removal primitive', (_mode, remove) => {
    const root = path.join(parent, 'project');
    fs.mkdirSync(root);
    const file = path.join(root, 'AGENTS.md');
    const saved = path.join(parent, 'original-agents');
    fs.writeFileSync(file, 'owned\n');
    const originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      if (String(oldPath) === file) {
        originalRename(file, saved);
        fs.writeFileSync(file, 'foreign replacement\n');
      }
      return originalRename(oldPath, newPath);
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync');
    try {
      expect(remove(root, [{ relative_path: 'AGENTS.md', sha256: sha256('owned\n') }], [])).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe('foreign replacement\n');
      expect(unlinkSpy.mock.calls.some(([target]) => String(target) === file)).toBe(false);
    } finally {
      unlinkSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  it('quarantines and preserves a directory swapped at the removal primitive', () => {
    const root = path.join(parent, 'project');
    const docs = path.join(root, 'docs');
    const saved = path.join(parent, 'original-docs-at-primitive');
    fs.mkdirSync(docs, { recursive: true });
    const originalRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      if (String(oldPath) === docs) {
        originalRename(docs, saved);
        fs.mkdirSync(docs);
      }
      return originalRename(oldPath, newPath);
    });
    const rmdirSpy = vi.spyOn(fs, 'rmdirSync');
    try {
      expect(removeAdoptionAdditions(root, [], ['docs'])).toBe(false);
      expect(fs.lstatSync(docs).isDirectory()).toBe(true);
      expect(rmdirSpy.mock.calls.some(([target]) => String(target) === docs)).toBe(false);
    } finally {
      rmdirSpy.mockRestore();
      renameSpy.mockRestore();
    }
  });

  function quarantineFixture(operation: 'create' | 'adopt') {
    const root = path.join(parent, `project-${operation}`);
    fs.mkdirSync(root);
    if (operation === 'adopt') fs.writeFileSync(path.join(root, 'user-owned.txt'), 'keep me\n');
    fs.mkdirSync(path.join(root, '.command-eve', 'receipts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'index.md'), 'owned\n');
    const receiptRelativePath = `.command-eve/receipts/${TRANSACTION_ID}.json`;
    fs.writeFileSync(path.join(root, receiptRelativePath), '{"status":"committed"}\n');
    const plan = buildProjectUndoQuarantinePlan({
      transaction_id: TRANSACTION_ID,
      origin: 'committed-undo',
      operation,
      root,
      created_files: [{ relative_path: 'docs/index.md', sha256: sha256('owned\n') }],
      created_directories: ['.command-eve', '.command-eve/receipts', 'docs'],
      receipt_relative_path: receiptRelativePath,
      catalog_proof: catalogProof(root),
    });
    expect(plan).toBeDefined();
    if (!plan) throw new Error('expected undo quarantine plan');
    const prepared = prepareProjectUndoQuarantine(root, plan);
    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('expected prepared undo quarantine plan');
    return {
      root,
      plan: prepared,
      quarantine: path.join(parent, projectUndoQuarantineBasename(TRANSACTION_ID)),
      receiptRelativePath,
    };
  }

  it('reconciles a partial create-tree hardlink without recapturing identities', () => {
    const fixture = quarantineFixture('create');
    const originalLink = fs.linkSync;
    let crashed = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      const result = originalLink(source, destination);
      if (!crashed) {
        crashed = true;
        throw new Error('SIMULATED_DEATH_AFTER_LINK');
      }
      return result;
    });
    try {
      expect(() => establishProjectUndoQuarantine(fixture.root, fixture.plan)).toThrow('SIMULATED_DEATH_AFTER_LINK');
    } finally {
      linkSpy.mockRestore();
    }
    expect(reconcileProjectUndoQuarantine(fixture.root, fixture.plan)).toBe('partial');
    expect(fs.lstatSync(fixture.root).isDirectory()).toBe(true);
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    expect(restoreProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    expect(fs.readFileSync(path.join(fixture.root, 'docs', 'index.md'), 'utf8')).toBe('owned\n');
  });

  it('reconciles a partial adoption move and never captures an adopted user file', () => {
    const fixture = quarantineFixture('adopt');
    const originalLink = fs.linkSync;
    let crashed = false;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      const result = originalLink(source, destination);
      if (!crashed) {
        crashed = true;
        throw new Error('SIMULATED_PARTIAL_MOVE');
      }
      return result;
    });
    try {
      expect(() => establishProjectUndoQuarantine(fixture.root, fixture.plan)).toThrow('SIMULATED_PARTIAL_MOVE');
    } finally {
      linkSpy.mockRestore();
    }
    expect(reconcileProjectUndoQuarantine(fixture.root, fixture.plan)).toBe('partial');
    expect(fs.readFileSync(path.join(fixture.root, 'user-owned.txt'), 'utf8')).toBe('keep me\n');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    expect(reconcileProjectUndoQuarantine(fixture.root, fixture.plan)).toBe('quarantined');
    expect(fs.readFileSync(path.join(fixture.root, 'user-owned.txt'), 'utf8')).toBe('keep me\n');
  });

  it('calls the mutation gate for both paths around every hardlink direction', () => {
    const fixture = quarantineFixture('adopt');
    const source = path.join(fixture.root, 'docs', 'index.md');
    const destination = path.join(fixture.quarantine, 'docs', 'index.md');
    const establishCalls: string[] = [];
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan, (target) => establishCalls.push(target))).toBe(
      true
    );
    expect(establishCalls.filter((target) => target === source).length).toBeGreaterThanOrEqual(2);
    expect(establishCalls.filter((target) => target === destination).length).toBeGreaterThanOrEqual(2);

    const restoreCalls: string[] = [];
    expect(restoreProjectUndoQuarantine(fixture.root, fixture.plan, (target) => restoreCalls.push(target))).toBe(true);
    expect(restoreCalls.filter((target) => target === source).length).toBeGreaterThanOrEqual(2);
    expect(restoreCalls.filter((target) => target === destination).length).toBeGreaterThanOrEqual(2);
  });

  it('durably treats a missing create root as a mutation-free provisioning rollback', () => {
    const root = path.join(parent, 'never-created-project');
    const plan = buildProjectUndoQuarantinePlan({
      transaction_id: TRANSACTION_ID,
      origin: 'provisioning-rollback',
      operation: 'create',
      root,
      created_files: [],
      created_directories: [],
      catalog_proof: null,
    });
    expect(plan).toMatchObject({ mode: 'create-missing-root', root_identity: null });
    const prepared = plan ? prepareProjectUndoQuarantine(root, plan) : undefined;
    expect(prepared).toEqual(plan);
    if (!prepared) throw new Error('expected logical empty plan');
    expect(establishProjectUndoQuarantine(root, prepared)).toBe(true);
    expect(reconcileProjectUndoQuarantine(root, prepared)).toBe('quarantined');
    expect(restoreProjectUndoQuarantine(root, prepared)).toBe(true);
    expect(purgeProjectUndoQuarantine(root, prepared)).toBe(true);
    expect(fs.existsSync(path.join(parent, projectUndoQuarantineBasename(TRANSACTION_ID)))).toBe(false);

    fs.mkdirSync(root);
    expect(establishProjectUndoQuarantine(root, prepared)).toBe(false);
    expect(purgeProjectUndoQuarantine(root, prepared)).toBe(false);
  });

  it('quarantines and purges an already-created empty create root without a directory rename', () => {
    const root = path.join(parent, 'empty-created-project');
    fs.mkdirSync(root);
    const plan = buildProjectUndoQuarantinePlan({
      transaction_id: TRANSACTION_ID,
      origin: 'provisioning-rollback',
      operation: 'create',
      root,
      created_files: [],
      created_directories: [],
      catalog_proof: null,
    });
    expect(plan).toMatchObject({ mode: 'create-tree' });
    const prepared = plan ? prepareProjectUndoQuarantine(root, plan) : undefined;
    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('expected prepared empty create plan');
    const renameSpy = vi.spyOn(fs, 'renameSync');
    try {
      expect(establishProjectUndoQuarantine(root, prepared)).toBe(true);
      expect(renameSpy).not.toHaveBeenCalled();
    } finally {
      renameSpy.mockRestore();
    }
    expect(purgeProjectUndoQuarantine(root, prepared)).toBe(true);
    expect(fs.existsSync(root)).toBe(false);
  });

  it('durably treats an unchanged adopt root with no additions as a mutation-free rollback', () => {
    const root = path.join(parent, 'adopt-no-additions');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'user-owned.txt'), 'keep\n');
    const plan = buildProjectUndoQuarantinePlan({
      transaction_id: TRANSACTION_ID,
      origin: 'provisioning-rollback',
      operation: 'adopt',
      root,
      created_files: [],
      created_directories: [],
      catalog_proof: null,
    });
    expect(plan).toMatchObject({ mode: 'adopt-no-additions' });
    const prepared = plan ? prepareProjectUndoQuarantine(root, plan) : undefined;
    expect(prepared).toEqual(plan);
    if (!prepared) throw new Error('expected logical empty plan');
    expect(establishProjectUndoQuarantine(root, prepared)).toBe(true);
    expect(restoreProjectUndoQuarantine(root, prepared)).toBe(true);
    expect(purgeProjectUndoQuarantine(root, prepared)).toBe(true);
    expect(fs.readFileSync(path.join(root, 'user-owned.txt'), 'utf8')).toBe('keep\n');

    fs.renameSync(root, path.join(parent, 'original-adopt-no-additions'));
    fs.mkdirSync(root);
    expect(establishProjectUndoQuarantine(root, prepared)).toBe(false);
  });

  it('refuses to unlink a crash-created hardlink after its exact bytes change', () => {
    const root = path.join(parent, 'linked-edit-adopt');
    fs.mkdirSync(root);
    const source = path.join(root, 'owned.md');
    fs.writeFileSync(source, 'owned\n');
    const plan = buildProjectUndoQuarantinePlan({
      transaction_id: TRANSACTION_ID,
      origin: 'provisioning-rollback',
      operation: 'adopt',
      root,
      created_files: [{ relative_path: 'owned.md', sha256: sha256('owned\n') }],
      created_directories: [],
      catalog_proof: null,
    });
    const prepared = plan ? prepareProjectUndoQuarantine(root, plan) : undefined;
    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('expected prepared plan');
    let linkedDestination: string | undefined;
    const originalLink = fs.linkSync;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      originalLink(from, to);
      linkedDestination = String(to);
      throw new Error('SIMULATED_DEATH_AFTER_LINK');
    });
    try {
      expect(() => establishProjectUndoQuarantine(root, prepared)).toThrow('SIMULATED_DEATH_AFTER_LINK');
    } finally {
      linkSpy.mockRestore();
    }
    if (!linkedDestination) throw new Error('expected linked destination');
    fs.appendFileSync(linkedDestination, 'edited through quarantine link\n');
    expect(establishProjectUndoQuarantine(root, prepared)).toBe(false);
    expect(fs.readFileSync(source, 'utf8')).toContain('edited through quarantine link');
    expect(fs.lstatSync(source).ino).toBe(fs.lstatSync(linkedDestination).ino);
  });

  it('restores a same-inode edit made through an open descriptor while quarantined', () => {
    const fixture = quarantineFixture('adopt');
    const source = path.join(fixture.root, 'docs', 'index.md');
    const descriptor = fs.openSync(source, 'a');
    try {
      expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
      fs.writeSync(descriptor, Buffer.from('user edit\n'), 0, Buffer.byteLength('user edit\n'), null);
      expect(restoreProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    } finally {
      fs.closeSync(descriptor);
    }
    expect(fs.readFileSync(source, 'utf8')).toBe('owned\nuser edit\n');
    expect(fs.existsSync(fixture.quarantine)).toBe(false);
  });

  it('resumes restore after files and planned quarantine directories were already restored', () => {
    const fixture = quarantineFixture('adopt');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    expect(() =>
      restoreProjectUndoQuarantine(fixture.root, fixture.plan, (target) => {
        if (target === fixture.quarantine) throw new Error('SIMULATED_DEATH_BEFORE_QUARANTINE_ROOT_CLEANUP');
      })
    ).toThrow('SIMULATED_DEATH_BEFORE_QUARANTINE_ROOT_CLEANUP');
    expect(fs.lstatSync(fixture.quarantine).isDirectory()).toBe(true);
    expect(fs.readdirSync(fixture.quarantine)).toEqual([]);
    expect(restoreProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    expect(fs.readFileSync(path.join(fixture.root, 'docs', 'index.md'), 'utf8')).toBe('owned\n');
    expect(fs.existsSync(fixture.quarantine)).toBe(false);
  });

  it('refuses to restore a replacement inode and never overwrites it', () => {
    const fixture = quarantineFixture('adopt');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    const quarantined = path.join(fixture.quarantine, 'docs', 'index.md');
    const original = `${quarantined}.original`;
    fs.renameSync(quarantined, original);
    fs.writeFileSync(quarantined, 'owned\n');

    expect(restoreProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(false);
    expect(fs.readFileSync(quarantined, 'utf8')).toBe('owned\n');
    expect(fs.existsSync(path.join(fixture.root, 'docs', 'index.md'))).toBe(false);
  });

  it('fails closed when an adoption restore source parent becomes a symlink', () => {
    const fixture = quarantineFixture('adopt');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    const source = path.join(fixture.root, 'docs', 'index.md');
    const docs = path.dirname(source);
    const savedDocs = path.join(parent, 'saved-docs');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'index.md'), 'outside sentinel\n');
    let swapped = false;

    expect(
      restoreProjectUndoQuarantine(fixture.root, fixture.plan, (target) => {
        if (target !== source || swapped) return;
        swapped = true;
        fs.renameSync(docs, savedDocs);
        fs.symlinkSync(outside, docs);
      })
    ).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'index.md'), 'utf8')).toBe('outside sentinel\n');
    expect(fs.readFileSync(path.join(fixture.quarantine, 'docs', 'index.md'), 'utf8')).toBe('owned\n');
  });

  it('fails closed when an adoption quarantine destination parent is replaced before rename', () => {
    const fixture = quarantineFixture('adopt');
    const source = path.join(fixture.root, 'docs', 'index.md');
    const destination = path.join(fixture.quarantine, 'docs', 'index.md');
    const quarantineDocs = path.dirname(destination);
    const savedDocs = path.join(parent, 'saved-quarantine-docs');
    const outside = path.join(parent, 'outside-destination');
    fs.mkdirSync(outside);
    let swapped = false;

    expect(
      establishProjectUndoQuarantine(fixture.root, fixture.plan, (target) => {
        if (target !== destination || swapped) return;
        swapped = true;
        fs.renameSync(quarantineDocs, savedDocs);
        fs.symlinkSync(outside, quarantineDocs);
      })
    ).toBe(false);
    expect(fs.readFileSync(source, 'utf8')).toBe('owned\n');
    expect(fs.existsSync(path.join(outside, 'index.md'))).toBe(false);
  });

  it('resumes adoption purge after quarantine cleanup and removes source directories under guards', () => {
    const fixture = quarantineFixture('adopt');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    const sourceDocs = path.join(fixture.root, 'docs');
    expect(() =>
      purgeProjectUndoQuarantine(fixture.root, fixture.plan, (target) => {
        if (target === sourceDocs) throw new Error('SIMULATED_DEATH_BEFORE_SOURCE_DIRECTORY_CLEANUP');
      })
    ).toThrow('SIMULATED_DEATH_BEFORE_SOURCE_DIRECTORY_CLEANUP');
    expect(fs.existsSync(fixture.quarantine)).toBe(false);
    expect(fs.existsSync(sourceDocs)).toBe(true);
    expect(purgeProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    expect(fs.existsSync(sourceDocs)).toBe(false);
    expect(fs.existsSync(fixture.root)).toBe(true);
  });

  it('resumes create-tree purge after quarantine cleanup and removes the root last', () => {
    const fixture = quarantineFixture('create');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    expect(() =>
      purgeProjectUndoQuarantine(fixture.root, fixture.plan, (target) => {
        if (target === fixture.root) throw new Error('SIMULATED_DEATH_BEFORE_ROOT_CLEANUP');
      })
    ).toThrow('SIMULATED_DEATH_BEFORE_ROOT_CLEANUP');
    expect(fs.existsSync(fixture.quarantine)).toBe(false);
    expect(fs.lstatSync(fixture.root).isDirectory()).toBe(true);
    expect(fs.readdirSync(fixture.root)).toEqual([]);
    expect(purgeProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    expect(fs.existsSync(fixture.root)).toBe(false);
  });

  it('reopens and rehashes a quarantine file after the purge callback', () => {
    const fixture = quarantineFixture('create');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    const quarantined = path.join(fixture.quarantine, 'docs', 'index.md');
    let edited = false;
    expect(
      purgeProjectUndoQuarantine(fixture.root, fixture.plan, (target) => {
        if (target === quarantined && !edited) {
          edited = true;
          fs.appendFileSync(quarantined, 'callback edit\n');
        }
      })
    ).toBe(false);
    expect(fs.readFileSync(quarantined, 'utf8')).toContain('callback edit');
    expect(fs.existsSync(fixture.root)).toBe(true);
  });

  it('rejects unexpected empty directories and symlinks in the quarantine tree', () => {
    const fixture = quarantineFixture('adopt');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    const unexpectedDirectory = path.join(fixture.quarantine, 'unexpected-empty');
    fs.mkdirSync(unexpectedDirectory);
    expect(purgeProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(false);
    fs.rmdirSync(unexpectedDirectory);
    const unexpectedSymlink = path.join(fixture.quarantine, 'unexpected-link');
    fs.symlinkSync('missing-target', unexpectedSymlink);
    expect(purgeProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(false);
    expect(fs.lstatSync(unexpectedSymlink).isSymbolicLink()).toBe(true);
  });

  it('rejects an unexpected empty directory added to a planned create tree', () => {
    const fixture = quarantineFixture('create');
    fs.mkdirSync(path.join(fixture.root, 'unexpected-empty'));
    expect(reconcileProjectUndoQuarantine(fixture.root, fixture.plan)).toBe('conflict');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(false);
    expect(fs.existsSync(path.join(fixture.root, 'docs', 'index.md'))).toBe(true);
  });

  it('rejects edited or wrong-kind quarantine entries instead of purging them', () => {
    const edited = quarantineFixture('create');
    expect(establishProjectUndoQuarantine(edited.root, edited.plan)).toBe(true);
    fs.appendFileSync(path.join(edited.quarantine, 'docs', 'index.md'), 'user edit\n');
    expect(purgeProjectUndoQuarantine(edited.root, edited.plan)).toBe(false);
    expect(fs.readFileSync(path.join(edited.quarantine, 'docs', 'index.md'), 'utf8')).toContain('user edit');

    fs.rmSync(edited.quarantine, { recursive: true, force: true });
    const wrongKind = quarantineFixture('adopt');
    expect(establishProjectUndoQuarantine(wrongKind.root, wrongKind.plan)).toBe(true);
    const quarantined = path.join(wrongKind.quarantine, 'docs', 'index.md');
    fs.unlinkSync(quarantined);
    fs.mkdirSync(quarantined);
    expect(restoreProjectUndoQuarantine(wrongKind.root, wrongKind.plan)).toBe(false);
    expect(purgeProjectUndoQuarantine(wrongKind.root, wrongKind.plan)).toBe(false);
    expect(fs.lstatSync(quarantined).isDirectory()).toBe(true);
  });

  it('treats a broken symlink quarantine entry as conflict, never missing', () => {
    const fixture = quarantineFixture('adopt');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    const quarantined = path.join(fixture.quarantine, 'docs', 'index.md');
    fs.unlinkSync(quarantined);
    fs.symlinkSync('missing-target', quarantined);
    expect(reconcileProjectUndoQuarantine(fixture.root, fixture.plan)).toBe('conflict');
    expect(restoreProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(false);
    expect(purgeProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(false);
    expect(fs.lstatSync(quarantined).isSymbolicLink()).toBe(true);
  });

  it('treats a FIFO quarantine entry as conflict, never missing', () => {
    if (process.platform === 'win32') return;
    const fixture = quarantineFixture('adopt');
    expect(establishProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(true);
    const quarantined = path.join(fixture.quarantine, 'docs', 'index.md');
    fs.unlinkSync(quarantined);
    execFileSync('mkfifo', [quarantined]);
    expect(reconcileProjectUndoQuarantine(fixture.root, fixture.plan)).toBe('conflict');
    expect(restoreProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(false);
    expect(purgeProjectUndoQuarantine(fixture.root, fixture.plan)).toBe(false);
    expect(fs.lstatSync(quarantined).isFIFO()).toBe(true);
  });

  it('does not adopt a pre-existing empty deterministic quarantine without a journaled inode', () => {
    const adoptRoot = path.join(parent, 'ownership-proof-adopt');
    fs.mkdirSync(adoptRoot);
    fs.writeFileSync(path.join(adoptRoot, 'owned.md'), 'owned\n');
    const plan = buildProjectUndoQuarantinePlan({
      transaction_id: TRANSACTION_ID,
      origin: 'provisioning-rollback',
      operation: 'adopt',
      root: adoptRoot,
      created_files: [{ relative_path: 'owned.md', sha256: sha256('owned\n') }],
      created_directories: [],
      catalog_proof: null,
    });
    expect(plan).toBeDefined();
    const quarantine = path.join(parent, projectUndoQuarantineBasename(TRANSACTION_ID));
    fs.mkdirSync(quarantine);
    expect(plan ? prepareProjectUndoQuarantine(adoptRoot, plan) : undefined).toBeUndefined();
    expect(fs.readFileSync(path.join(adoptRoot, 'owned.md'), 'utf8')).toBe('owned\n');
  });

  it('rejects a committed catalog proof whose exact record has an extra key', () => {
    const root = path.join(parent, 'tampered-catalog-proof');
    const receiptRelativePath = `.command-eve/receipts/${TRANSACTION_ID}.json`;
    fs.mkdirSync(path.join(root, '.command-eve', 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(root, receiptRelativePath), '{"status":"committed"}\n');
    const proof = catalogProof(root);
    const tamperedProof = {
      ...proof,
      expected_record: { ...proof.expected_record, raw_intent: 'must-not-be-captured' },
    } as typeof proof;
    expect(
      buildProjectUndoQuarantinePlan({
        transaction_id: TRANSACTION_ID,
        origin: 'committed-undo',
        operation: 'create',
        root,
        created_files: [],
        created_directories: ['.command-eve', '.command-eve/receipts'],
        receipt_relative_path: receiptRelativePath,
        catalog_proof: tamperedProof,
      })
    ).toBeUndefined();
  });

  it('supports a coordinator-owned file in a pre-existing adopt directory without capturing siblings', () => {
    const root = path.join(parent, 'pre-existing-parent-adopt');
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'user.txt'), 'keep\n');
    fs.writeFileSync(path.join(shared, 'owned.md'), 'owned\n');
    const plan = buildProjectUndoQuarantinePlan({
      transaction_id: TRANSACTION_ID,
      origin: 'provisioning-rollback',
      operation: 'adopt',
      root,
      created_files: [{ relative_path: 'shared/owned.md', sha256: sha256('owned\n') }],
      created_directories: [],
      catalog_proof: null,
    });
    expect(plan).toBeDefined();
    const prepared = plan ? prepareProjectUndoQuarantine(root, plan) : undefined;
    expect(prepared).toBeDefined();
    if (!prepared) throw new Error('expected prepared plan');
    expect(establishProjectUndoQuarantine(root, prepared)).toBe(true);
    expect(fs.readFileSync(path.join(shared, 'user.txt'), 'utf8')).toBe('keep\n');
    expect(fs.existsSync(path.join(shared, 'owned.md'))).toBe(false);

    const savedShared = path.join(parent, 'saved-pre-existing-shared');
    const outside = path.join(parent, 'outside-pre-existing-parent');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'owned.md'), 'outside sentinel\n');
    let swapped = false;
    expect(
      restoreProjectUndoQuarantine(root, prepared, (target) => {
        if (target !== path.join(shared, 'owned.md') || swapped) return;
        swapped = true;
        fs.renameSync(shared, savedShared);
        fs.symlinkSync(outside, shared);
      })
    ).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'owned.md'), 'utf8')).toBe('outside sentinel\n');
    expect(fs.readFileSync(path.join(savedShared, 'user.txt'), 'utf8')).toBe('keep\n');
  });

  it('rejects user content inside a journal-created adoption directory', () => {
    const root = path.join(parent, 'unsafe-created-directory');
    const docs = path.join(root, 'docs');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'owned.md'), 'owned\n');
    fs.writeFileSync(path.join(docs, 'user.txt'), 'keep\n');
    expect(
      buildProjectUndoQuarantinePlan({
        transaction_id: TRANSACTION_ID,
        origin: 'provisioning-rollback',
        operation: 'adopt',
        root,
        created_files: [{ relative_path: 'docs/owned.md', sha256: sha256('owned\n') }],
        created_directories: ['docs'],
        catalog_proof: null,
      })
    ).toBeUndefined();
  });

  it('rejects non-v4 transaction ids and accepts the expanded quarantine directory bound', () => {
    const root = path.join(parent, 'transaction-grammar');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'owned.md'), 'owned\n');
    for (const transactionId of [
      'abcdefab-cdef-1abc-8def-abcdefabcdef',
      'abcdefab-cdef-5abc-8def-abcdefabcdef',
      'abcdefab-cdef-7abc-8def-abcdefabcdef',
      TRANSACTION_ID.toUpperCase(),
    ]) {
      expect(
        buildProjectUndoQuarantinePlan({
          transaction_id: transactionId,
          origin: 'provisioning-rollback',
          operation: 'create',
          root,
          created_files: [{ relative_path: 'owned.md', sha256: sha256('owned\n') }],
          created_directories: [],
          catalog_proof: null,
        })
      ).toBeUndefined();
    }

    const deepRoot = path.join(parent, 'too-many-quarantine-directories');
    fs.mkdirSync(deepRoot);
    const createdFiles: Array<{ relative_path: string; sha256: string }> = [];
    for (let index = 0; index < 65; index += 1) {
      const relative = `preexisting-${index}/owned.md`;
      fs.mkdirSync(path.join(deepRoot, `preexisting-${index}`));
      fs.writeFileSync(path.join(deepRoot, relative), 'owned\n');
      createdFiles.push({ relative_path: relative, sha256: sha256('owned\n') });
    }
    expect(
      buildProjectUndoQuarantinePlan({
        transaction_id: TRANSACTION_ID,
        origin: 'provisioning-rollback',
        operation: 'adopt',
        root: deepRoot,
        created_files: createdFiles,
        created_directories: [],
        catalog_proof: null,
      })
    ).toBeDefined();
    expect(fs.existsSync(path.join(parent, projectUndoQuarantineBasename(TRANSACTION_ID)))).toBe(false);
  });
});
