import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withExclusiveFileLock } from '@process/services/project-workspace/storage/atomicJson';
import { ProjectWorkspaceRegistryStore } from '@process/services/project-workspace/storage/registryStore';
import { rootComparisonKey } from '@process/services/project-workspace/storage/rootPolicy';

const REALM_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';

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

  function seedProject() {
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
    const root = store.registerRoot({
      seat_id: 'seat-alpha',
      expected_seat_revision: 0,
      expected_global_revision: 0,
      root: {
        root_id: ROOT_ID,
        realm_id: REALM_ID,
        label: 'Projects',
        kind: 'app_managed',
        path: rootPath,
        status: 'active',
      },
    });
    const projectPath = path.join(root.canonical_path, 'alpha');
    const record = {
      project_id: PROJECT_ID,
      seat_id: 'seat-alpha',
      realm_id: REALM_ID,
      root_id: ROOT_ID,
      workspace_root_ref: root.workspace_root_ref,
      title: 'Alpha',
      slug: 'alpha',
      status: 'active' as const,
      manifest_relative_path: 'alpha/.command-eve/project.json',
      canonical_project_path: projectPath,
      comparison_key: rootComparisonKey(projectPath),
      registered_at: '2026-07-20T00:00:00.000Z',
    };
    store.registerProject({ expected_revision: 0, record });
    return record;
  }

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

  it('updates only mutable project metadata through an exact catalog-revision CAS', () => {
    const record = seedProject();
    const updated = store.replaceProjectIfRevision({
      seat_id: 'seat-alpha',
      expected_revision: 1,
      expected_record: record,
      next_record: { ...record, title: 'Alpha Renamed', status: 'archived' },
    });
    expect(updated).toMatchObject({ revision: 2, record: { title: 'Alpha Renamed', status: 'archived' } });
    expect(() =>
      store.replaceProjectIfRevision({
        seat_id: 'seat-alpha',
        expected_revision: 1,
        expected_record: record,
        next_record: { ...record, title: 'Stale' },
      })
    ).toThrow(/catalog\.revision-conflict/);
  });

  it('touches a binding mutation without changing physical project identity', () => {
    const record = seedProject();
    const touched = store.touchProjectIfRevision({
      seat_id: 'seat-alpha',
      project_id: record.project_id,
      expected_revision: 1,
    });
    expect(touched.revision).toBe(2);
    expect(touched.record).toEqual(record);
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

  it.each(['realm_catalog', 'root_catalog', 'project_catalog'] as const)(
    'rejects a valid %s whose seat_id does not match the requested seat',
    (catalogKey) => {
      store.initializeSeat('seat-alpha');
      const file = store.pathsForSeat('seat-alpha')[catalogKey];
      const catalog = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(file, `${JSON.stringify({ ...catalog, seat_id: 'seat-beta' }, null, 2)}\n`, 'utf8');
      expect(() => store.readSeatCatalogs('seat-alpha')).toThrow(/schema\.invalid/);
    }
  );

  it('binds every realm writer to the requested catalog seat under lock', () => {
    store.initializeSeat('seat-alpha');
    const file = store.pathsForSeat('seat-alpha').realm_catalog;
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, `${JSON.stringify({ ...catalog, seat_id: 'seat-beta' }, null, 2)}\n`, 'utf8');

    expect(() =>
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
      })
    ).toThrow(/schema\.invalid/);
  });

  it('binds every root writer to the requested catalog seat under lock', () => {
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
        label: 'Projects',
        kind: 'app_managed',
        path: rootPath,
        status: 'active',
      },
    });
    const file = store.pathsForSeat('seat-alpha').root_catalog;
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, `${JSON.stringify({ ...catalog, seat_id: 'seat-beta' }, null, 2)}\n`, 'utf8');

    expect(() =>
      store.renameRoot({ seat_id: 'seat-alpha', root_id: ROOT_ID, expected_revision: 1, label: 'Renamed' })
    ).toThrow(/schema\.invalid/);
  });

  it('binds register, remove, and recovery-status project writers to the requested catalog seat', () => {
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
    const root = store.registerRoot({
      seat_id: 'seat-alpha',
      expected_seat_revision: 0,
      expected_global_revision: 0,
      root: {
        root_id: ROOT_ID,
        realm_id: REALM_ID,
        label: 'Projects',
        kind: 'app_managed',
        path: rootPath,
        status: 'active',
      },
    });
    const file = store.pathsForSeat('seat-alpha').project_catalog;
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, `${JSON.stringify({ ...catalog, seat_id: 'seat-beta' }, null, 2)}\n`, 'utf8');
    const projectPath = path.join(rootPath, 'alpha');
    const record = {
      project_id: PROJECT_ID,
      seat_id: 'seat-alpha',
      realm_id: REALM_ID,
      root_id: ROOT_ID,
      workspace_root_ref: root.workspace_root_ref,
      title: 'Alpha',
      slug: 'alpha',
      status: 'active' as const,
      manifest_relative_path: 'alpha/.command-eve/project.json',
      canonical_project_path: projectPath,
      comparison_key: rootComparisonKey(projectPath),
      registered_at: '2026-07-20T00:00:00.000Z',
    };

    expect(() => store.registerProject({ expected_revision: 0, record })).toThrow(/schema\.invalid/);
    expect(() => store.removeProject('seat-alpha', PROJECT_ID)).toThrow(/schema\.invalid/);
    expect(() => store.markProjectRecoveryRequired('seat-alpha', PROJECT_ID)).toThrow(/schema\.invalid/);
  });

  it('removes only the exact revision-bound project record and recognizes its idempotent absence', () => {
    const record = seedProject();
    expect(
      store.removeProjectIfMatches({
        seat_id: 'seat-alpha',
        expected_revision: 1,
        expected_record: record,
        allow_already_absent: false,
      })
    ).toBe('removed');
    expect(
      store.removeProjectIfMatches({
        seat_id: 'seat-alpha',
        expected_revision: 1,
        expected_record: record,
        allow_already_absent: true,
      })
    ).toBe('already_absent');
  });

  it('removes an exact target despite unrelated catalog revision drift', () => {
    const record = seedProject();
    const otherPath = path.join(path.dirname(record.canonical_project_path), 'beta');
    store.registerProject({
      expected_revision: 1,
      record: {
        ...record,
        project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        title: 'Beta',
        slug: 'beta',
        manifest_relative_path: 'beta/.command-eve/project.json',
        canonical_project_path: otherPath,
        comparison_key: rootComparisonKey(otherPath),
      },
    });

    expect(
      store.removeProjectIfMatches({
        seat_id: 'seat-alpha',
        expected_revision: 1,
        expected_record: record,
        allow_already_absent: false,
      })
    ).toBe('removed');
    expect(store.readSeatCatalogs('seat-alpha').projects.projects).toEqual([
      expect.objectContaining({ project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
    ]);
  });

  it('preserves a same-id successor whose exact catalog record differs', () => {
    const record = seedProject();
    expect(store.removeProject('seat-alpha', PROJECT_ID)).toBe(true);
    const successorPath = path.join(path.dirname(record.canonical_project_path), 'successor');
    const successor = {
      ...record,
      title: 'Successor',
      slug: 'successor',
      manifest_relative_path: 'successor/.command-eve/project.json',
      canonical_project_path: successorPath,
      comparison_key: rootComparisonKey(successorPath),
      registered_at: '2026-07-20T00:01:00.000Z',
    };
    store.registerProject({ expected_revision: 2, record: successor });

    expect(() =>
      store.removeProjectIfMatches({
        seat_id: 'seat-alpha',
        expected_revision: 1,
        expected_record: record,
        allow_already_absent: true,
      })
    ).toThrow(/catalog\.project-conflict/);
    expect(store.readSeatCatalogs('seat-alpha').projects.projects).toEqual([successor]);
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

  it('bounds an expired live lock as recovery-required and distinguishes PID reuse by process nonce', () => {
    const lockPath = path.join(stateRoot, 'lock-recovery', 'catalog.lock');
    let liveRecord: Record<string, unknown> | undefined;
    withExclusiveFileLock(lockPath, () => {
      liveRecord = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(lockPath, `${JSON.stringify({ ...liveRecord, acquired_at_ms: 1, expires_at_ms: 2 })}\n`, 'utf8');
      const startedAt = Date.now();
      expect(() => withExclusiveFileLock(lockPath, () => undefined)).toThrow(/workspace\.recovery-required/);
      expect(Date.now() - startedAt).toBeLessThan(250);
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual({
        ...liveRecord,
        acquired_at_ms: 1,
        expires_at_ms: 2,
      });
    });
    expect(liveRecord).toBeDefined();

    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        ...liveRecord,
        owner_token: 'reused-pid-owner-token-00000000',
        process_nonce_sha256: 'f'.repeat(64),
        acquired_at_ms: 1,
        expires_at_ms: 2,
      })}\n`,
      'utf8'
    );
    let recovered = false;
    withExclusiveFileLock(lockPath, () => {
      recovered = true;
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
