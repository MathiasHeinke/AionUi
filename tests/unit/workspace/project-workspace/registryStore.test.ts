import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withExclusiveFileLock } from '@process/services/project-workspace/storage/atomicJson';
import { ProjectWorkspaceRegistryStore } from '@process/services/project-workspace/storage/registryStore';

const REALM_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_ID = '22222222-2222-4222-8222-222222222222';

describe('project workspace registries', () => {
  let stateRoot: string;
  let rootPath: string;
  let store: ProjectWorkspaceRegistryStore;

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-registry-'));
    rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-owned-root-'));
    store = new ProjectWorkspaceRegistryStore({
      state_root: stateRoot,
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    });
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(rootPath, { recursive: true, force: true });
  });

  it('keeps realm/root/project catalogs isolated per seat', () => {
    store.initializeSeat('seat-alpha');
    store.initializeSeat('seat-beta');
    store.upsertRealm({
      seat_id: 'seat-alpha',
      expected_revision: 0,
      realm: {
        realm_id: REALM_ID,
        label: 'Business',
        path_slug: 'business',
        status: 'active',
        order: 0,
      },
    });
    expect(store.readSeatCatalogs('seat-alpha').realms.realms).toHaveLength(1);
    expect(store.readSeatCatalogs('seat-beta').realms.realms).toHaveLength(0);
  });

  it('preserves realm and root identity across display renames', () => {
    store.initializeSeat('seat-alpha');
    store.upsertRealm({
      seat_id: 'seat-alpha',
      expected_revision: 0,
      realm: {
        realm_id: REALM_ID,
        label: 'Business',
        path_slug: 'business',
        status: 'active',
        order: 0,
      },
    });
    store.registerRoot({
      seat_id: 'seat-alpha',
      expected_seat_revision: 0,
      expected_global_revision: 0,
      root: {
        root_id: ROOT_ID,
        realm_id: REALM_ID,
        label: 'Default Root',
        kind: 'app_managed',
        path: rootPath,
        status: 'active',
      },
    });
    store.renameRealm({
      seat_id: 'seat-alpha',
      realm_id: REALM_ID,
      expected_revision: 1,
      label: 'Company',
      path_slug: 'company',
    });
    store.renameRoot({
      seat_id: 'seat-alpha',
      root_id: ROOT_ID,
      expected_revision: 1,
      label: 'Company Projects',
    });
    const catalogs = store.readSeatCatalogs('seat-alpha');
    expect(catalogs.realms.realms[0].realm_id).toBe(REALM_ID);
    expect(catalogs.roots.roots[0]).toMatchObject({
      root_id: ROOT_ID,
      label: 'Company Projects',
      canonical_path: fs.realpathSync.native(rootPath),
      workspace_root_ref: `root:${ROOT_ID}`,
    });
  });

  it('requires an explicit migration instead of reusing a root identity at a new path', () => {
    const movedPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-moved-root-'));
    try {
      store.initializeSeat('seat-alpha');
      store.registerRoot({
        seat_id: 'seat-alpha',
        expected_seat_revision: 0,
        expected_global_revision: 0,
        root: {
          root_id: ROOT_ID,
          label: 'Default Root',
          kind: 'app_managed',
          path: rootPath,
          status: 'active',
        },
      });
      expect(() =>
        store.registerRoot({
          seat_id: 'seat-alpha',
          expected_seat_revision: 1,
          expected_global_revision: 1,
          root: {
            root_id: ROOT_ID,
            label: 'Moved Root',
            kind: 'app_managed',
            path: movedPath,
            status: 'active',
          },
        })
      ).toThrow(/root\.migration-required/);
      expect(store.readSeatCatalogs('seat-alpha').roots.roots[0].canonical_path).toBe(fs.realpathSync.native(rootPath));
    } finally {
      fs.rmSync(movedPath, { recursive: true, force: true });
    }
  });

  it('rejects an alias owned by another seat globally', () => {
    store.initializeSeat('seat-alpha');
    store.initializeSeat('seat-beta');
    store.registerRoot({
      seat_id: 'seat-alpha',
      expected_seat_revision: 0,
      expected_global_revision: 0,
      root: {
        root_id: ROOT_ID,
        label: 'Alpha Root',
        kind: 'external',
        path: rootPath,
        status: 'active',
      },
    });
    expect(() =>
      store.registerRoot({
        seat_id: 'seat-beta',
        expected_seat_revision: 0,
        expected_global_revision: 1,
        root: {
          root_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          label: 'Alias Root',
          kind: 'external',
          path: rootPath,
          status: 'active',
        },
      })
    ).toThrow(/root\.overlap/);
  });

  it('fails closed on corrupt or future-version registries', () => {
    store.initializeSeat('seat-alpha');
    const paths = store.pathsForSeat('seat-alpha');
    fs.writeFileSync(paths.realm_catalog, '{broken', 'utf8');
    expect(() => store.readSeatCatalogs('seat-alpha')).toThrow(/schema\.invalid/);
    fs.writeFileSync(paths.realm_catalog, JSON.stringify({ schema_version: 'realm-catalog/v99' }), 'utf8');
    expect(() => store.readSeatCatalogs('seat-alpha')).toThrow(/schema\.unsupported/);
  });

  it('recovers a lock left by a dead process but never steals a live owner lock', () => {
    const lockPath = path.join(stateRoot, 'lock-recovery', 'catalog.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 'command-eve-exclusive-file-lock/v1',
        owner_token: 'dead-owner-token-00000000',
        pid: 2_147_483_647,
        acquired_at_ms: 1,
        expires_at_ms: 2,
      })}\n`,
      'utf8'
    );
    let recovered = false;
    withExclusiveFileLock(lockPath, () => {
      recovered = true;
      expect(() => withExclusiveFileLock(lockPath, () => undefined)).toThrow(/workspace\.concurrent-operation/);
    });
    expect(recovered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('serializes root registration against root rename through the seat root-catalog lock', () => {
    store.initializeSeat('seat-alpha');
    const rootCatalogLock = `${store.pathsForSeat('seat-alpha').root_catalog}.lock`;
    withExclusiveFileLock(rootCatalogLock, () => {
      expect(() =>
        store.registerRoot({
          seat_id: 'seat-alpha',
          expected_seat_revision: 0,
          expected_global_revision: 0,
          root: {
            root_id: ROOT_ID,
            label: 'Default Root',
            kind: 'app_managed',
            path: rootPath,
            status: 'active',
          },
        })
      ).toThrow(/workspace\.concurrent-operation/);
    });
    expect(store.readSeatCatalogs('seat-alpha').roots.roots).toEqual([]);
    expect(store.readGlobalRoots().roots).toEqual([]);
  });

  it('replays pending global/local root registration only while both registry locks are held', () => {
    store.initializeSeat('seat-alpha');
    store.registerRoot({
      seat_id: 'seat-alpha',
      expected_seat_revision: 0,
      expected_global_revision: 0,
      root: {
        root_id: ROOT_ID,
        label: 'Default Root',
        kind: 'app_managed',
        path: rootPath,
        status: 'active',
      },
    });
    const capturedGlobal = store.readGlobalRoots();
    const paths = store.pathsForSeat('seat-alpha');
    const capturedRoots = store.readSeatCatalogs('seat-alpha').roots;
    fs.writeFileSync(
      path.join(stateRoot, 'global', 'root-ownership.json'),
      `${JSON.stringify({ ...capturedGlobal, revision: 0, roots: [] })}\n`,
      'utf8'
    );
    fs.writeFileSync(paths.root_catalog, `${JSON.stringify({ ...capturedRoots, revision: 0, roots: [] })}\n`, 'utf8');
    fs.writeFileSync(
      path.join(stateRoot, 'global', 'root-registration.pending.json'),
      `${JSON.stringify({
        schema_version: 'command-eve-root-registration-journal/v1',
        seat_id: 'seat-alpha',
        global: capturedGlobal,
        roots: capturedRoots,
      })}\n`,
      'utf8'
    );

    const globalLock = path.join(stateRoot, 'global', 'root-ownership.lock');
    withExclusiveFileLock(globalLock, () => {
      expect(() => store.readGlobalRoots()).toThrow(/workspace\.concurrent-operation/);
      expect(JSON.parse(fs.readFileSync(paths.root_catalog, 'utf8')).roots).toEqual([]);
    });
    expect(store.readGlobalRoots().roots).toHaveLength(1);
    expect(store.readSeatCatalogs('seat-alpha').roots.roots).toHaveLength(1);
    expect(fs.existsSync(path.join(stateRoot, 'global', 'root-registration.pending.json'))).toBe(false);
  });
});
