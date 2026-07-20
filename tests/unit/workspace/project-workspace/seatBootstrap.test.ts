import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureProjectWorkspaceSeatBootstrap } from '@process/services/project-workspace/seatBootstrap';
import { ProjectWorkspaceRegistryStore } from '@process/services/project-workspace/storage/registryStore';

describe('ensureProjectWorkspaceSeatBootstrap (live-gap fix)', () => {
  let stateRoot: string;
  let dataPath: string;
  let registry: ProjectWorkspaceRegistryStore;

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-bootstrap-state-'));
    dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-bootstrap-data-'));
    registry = new ProjectWorkspaceRegistryStore({ state_root: stateRoot });
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(dataPath, { recursive: true, force: true });
  });

  it('seeds the two default realms with one app-managed root each, on disk', () => {
    ensureProjectWorkspaceSeatBootstrap({ registry, seat_id: 'seat-1', data_path: dataPath });

    const catalogs = registry.readSeatCatalogs('seat-1');
    expect(catalogs.realms.realms.map((realm) => realm.path_slug)).toEqual(['privat', 'geschaeftlich']);
    expect(catalogs.realms.realms.map((realm) => realm.label)).toEqual(['Privat', 'Geschäftlich']);

    expect(catalogs.roots.roots).toHaveLength(2);
    for (const root of catalogs.roots.roots) {
      expect(root.kind).toBe('app_managed');
      expect(root.status).toBe('active');
      expect(root.workspace_root_ref).toBe(`root:${root.root_id}`);
      expect(fs.statSync(root.canonical_path).isDirectory()).toBe(true);
    }
    const realmIds = new Set(catalogs.roots.roots.map((root) => root.realm_id));
    expect(realmIds.size).toBe(2);

    const global = registry.readGlobalRoots();
    expect(global.roots).toHaveLength(2);
  });

  it('is idempotent: a second call changes nothing (no duplicate realms/roots, no revision churn)', () => {
    ensureProjectWorkspaceSeatBootstrap({ registry, seat_id: 'seat-1', data_path: dataPath });
    const first = registry.readSeatCatalogs('seat-1');

    ensureProjectWorkspaceSeatBootstrap({ registry, seat_id: 'seat-1', data_path: dataPath });
    const second = registry.readSeatCatalogs('seat-1');

    expect(second.realms.revision).toBe(first.realms.revision);
    expect(second.roots.revision).toBe(first.roots.revision);
    expect(second.realms.realms).toHaveLength(2);
    expect(second.roots.roots).toHaveLength(2);
    expect(second.realms.realms.map((realm) => realm.realm_id)).toEqual(
      first.realms.realms.map((realm) => realm.realm_id)
    );
    expect(second.roots.roots.map((root) => root.root_id)).toEqual(first.roots.roots.map((root) => root.root_id));
  });

  it('only fills gaps: an operator-added realm survives untouched', () => {
    registry.initializeSeat('seat-1');
    registry.upsertRealm({
      seat_id: 'seat-1',
      expected_revision: 0,
      realm: {
        realm_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        label: 'Client Work',
        path_slug: 'client-work',
        status: 'active',
        order: 5,
      },
    });

    ensureProjectWorkspaceSeatBootstrap({ registry, seat_id: 'seat-1', data_path: dataPath });

    const catalogs = registry.readSeatCatalogs('seat-1');
    expect(catalogs.realms.realms.map((realm) => realm.path_slug)).toEqual(
      expect.arrayContaining(['client-work', 'privat', 'geschaeftlich'])
    );
    expect(catalogs.realms.realms).toHaveLength(3);
    // Only two seeded roots (the custom realm has none and gets none).
    expect(catalogs.roots.roots).toHaveLength(2);
  });
});
