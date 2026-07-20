import fs from 'node:fs';
import path from 'node:path';
import { parseRealmId, parseRootId, parseSeatId, toWorkspaceRootRef } from '@/common/types/project-workspace/identity';
import {
  GLOBAL_ROOT_OWNERSHIP_VERSION,
  PROJECT_CATALOG_VERSION,
  REALM_CATALOG_VERSION,
  ROOT_CATALOG_VERSION,
  parseGlobalRootOwnership,
  parseProjectCatalog,
  parseRealmCatalog,
  parseRootCatalog,
  type GlobalRootOwnershipV1,
  type ProjectCatalogRecord,
  type ProjectCatalogV1,
  type RealmCatalogV1,
  type RealmRecord,
  type RootCatalogV1,
  type RootRecord,
} from '@/common/types/project-workspace/registry';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import {
  ensurePrivateDirectory,
  readJson,
  syncDirectoryDurable,
  withExclusiveFileLock,
  writeFileCreateOnly,
  writeJsonAtomic,
} from './atomicJson';
import { canonicalizeRoot, findRootOwnershipConflict, rootComparisonKey } from './rootPolicy';

export type SeatCatalogPaths = {
  realm_catalog: string;
  root_catalog: string;
  project_catalog: string;
};

export type SeatCatalogBundle = {
  realms: RealmCatalogV1;
  roots: RootCatalogV1;
  projects: ProjectCatalogV1;
};

type RegistryStoreOptions = {
  state_root: string;
  now?: () => Date;
};

type PendingRootRegistration = {
  schema_version: 'command-eve-root-registration-journal/v1';
  seat_id: string;
  global: GlobalRootOwnershipV1;
  roots: RootCatalogV1;
};

function writeInitialJson(file: string, value: unknown): void {
  try {
    writeFileCreateOnly(file, `${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

function exactProjectRecord(left: ProjectCatalogRecord, right: ProjectCatalogRecord): boolean {
  return (
    left.project_id === right.project_id &&
    left.seat_id === right.seat_id &&
    left.realm_id === right.realm_id &&
    left.root_id === right.root_id &&
    left.workspace_root_ref === right.workspace_root_ref &&
    left.title === right.title &&
    left.slug === right.slug &&
    left.status === right.status &&
    left.manifest_relative_path === right.manifest_relative_path &&
    left.canonical_project_path === right.canonical_project_path &&
    left.comparison_key === right.comparison_key &&
    left.registered_at === right.registered_at
  );
}

export class ProjectWorkspaceRegistryStore {
  readonly stateRoot: string;
  private readonly now: () => Date;

  constructor(options: RegistryStoreOptions) {
    this.stateRoot = path.resolve(options.state_root);
    this.now = options.now ?? (() => new Date());
    ensurePrivateDirectory(this.stateRoot);
    ensurePrivateDirectory(this.globalDirectory());
    ensurePrivateDirectory(this.seatsDirectory());
    this.ensureGlobalRegistry();
    this.recoverPendingRootRegistration();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private globalDirectory(): string {
    return path.join(this.stateRoot, 'global');
  }

  private seatsDirectory(): string {
    return path.join(this.stateRoot, 'seats');
  }

  private globalRegistryPath(): string {
    return path.join(this.globalDirectory(), 'root-ownership.json');
  }

  private globalRegistryLockPath(): string {
    return path.join(this.globalDirectory(), 'root-ownership.lock');
  }

  private pendingRootRegistrationPath(): string {
    return path.join(this.globalDirectory(), 'root-registration.pending.json');
  }

  private ensureGlobalRegistry(): void {
    const file = this.globalRegistryPath();
    if (fs.existsSync(file)) return;
    writeInitialJson(file, {
      schema_version: GLOBAL_ROOT_OWNERSHIP_VERSION,
      revision: 0,
      roots: [],
      updated_at: this.timestamp(),
    } satisfies GlobalRootOwnershipV1);
  }

  pathsForSeat(seatIdValue: string): SeatCatalogPaths {
    const seatId = parseSeatId(seatIdValue);
    const directory = path.join(this.seatsDirectory(), seatId);
    return {
      realm_catalog: path.join(directory, 'realms.json'),
      root_catalog: path.join(directory, 'roots.json'),
      project_catalog: path.join(directory, 'projects.json'),
    };
  }

  initializeSeat(seatIdValue: string): SeatCatalogBundle {
    const seatId = parseSeatId(seatIdValue);
    const paths = this.pathsForSeat(seatId);
    ensurePrivateDirectory(path.dirname(paths.realm_catalog));
    if (!fs.existsSync(paths.realm_catalog)) {
      writeInitialJson(paths.realm_catalog, {
        schema_version: REALM_CATALOG_VERSION,
        seat_id: seatId,
        revision: 0,
        realms: [],
        updated_at: this.timestamp(),
      } satisfies RealmCatalogV1);
    }
    if (!fs.existsSync(paths.root_catalog)) {
      writeInitialJson(paths.root_catalog, {
        schema_version: ROOT_CATALOG_VERSION,
        seat_id: seatId,
        revision: 0,
        roots: [],
        updated_at: this.timestamp(),
      } satisfies RootCatalogV1);
    }
    if (!fs.existsSync(paths.project_catalog)) {
      writeInitialJson(paths.project_catalog, {
        schema_version: PROJECT_CATALOG_VERSION,
        seat_id: seatId,
        revision: 0,
        projects: [],
        updated_at: this.timestamp(),
      } satisfies ProjectCatalogV1);
    }
    return this.readSeatCatalogs(seatId);
  }

  private readRealmCatalog(file: string, expectedSeatId?: string): RealmCatalogV1 {
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      throw new ProjectWorkspaceError('schema.invalid', file);
    }
    const parsed = parseRealmCatalog(raw);
    if (parsed.ok === false) throw new ProjectWorkspaceError(parsed.reason_code, file);
    if (expectedSeatId !== undefined && parsed.value.seat_id !== expectedSeatId) {
      throw new ProjectWorkspaceError('schema.invalid', file);
    }
    return parsed.value;
  }

  private readRootCatalog(file: string, expectedSeatId?: string): RootCatalogV1 {
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      throw new ProjectWorkspaceError('schema.invalid', file);
    }
    const parsed = parseRootCatalog(raw);
    if (parsed.ok === false) throw new ProjectWorkspaceError(parsed.reason_code, file);
    if (expectedSeatId !== undefined && parsed.value.seat_id !== expectedSeatId) {
      throw new ProjectWorkspaceError('schema.invalid', file);
    }
    return parsed.value;
  }

  private readProjectCatalog(file: string, expectedSeatId?: string): ProjectCatalogV1 {
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      throw new ProjectWorkspaceError('schema.invalid', file);
    }
    const parsed = parseProjectCatalog(raw);
    if (parsed.ok === false) throw new ProjectWorkspaceError(parsed.reason_code, file);
    if (expectedSeatId !== undefined && parsed.value.seat_id !== expectedSeatId) {
      throw new ProjectWorkspaceError('schema.invalid', file);
    }
    return parsed.value;
  }

  private readGlobalRootsRaw(): GlobalRootOwnershipV1 {
    let raw: unknown;
    try {
      raw = readJson(this.globalRegistryPath());
    } catch {
      throw new ProjectWorkspaceError('schema.invalid', this.globalRegistryPath());
    }
    const parsed = parseGlobalRootOwnership(raw);
    if (parsed.ok === false) throw new ProjectWorkspaceError(parsed.reason_code, this.globalRegistryPath());
    return parsed.value;
  }

  private readSeatCatalogsRaw(seatIdValue: string): SeatCatalogBundle {
    const seatId = parseSeatId(seatIdValue);
    const paths = this.pathsForSeat(seatId);
    const catalogs = {
      realms: this.readRealmCatalog(paths.realm_catalog, seatId),
      roots: this.readRootCatalog(paths.root_catalog, seatId),
      projects: this.readProjectCatalog(paths.project_catalog, seatId),
    };
    if (
      catalogs.realms.seat_id !== seatId ||
      catalogs.roots.seat_id !== seatId ||
      catalogs.projects.seat_id !== seatId
    ) {
      throw new ProjectWorkspaceError('schema.invalid', `catalog seat mismatch: ${seatId}`);
    }
    return catalogs;
  }

  private withRootRegistryLocks<T>(seatIdValue: string, callback: () => T): T {
    const seatId = parseSeatId(seatIdValue);
    const rootCatalogLock = `${this.pathsForSeat(seatId).root_catalog}.lock`;
    return withExclusiveFileLock(this.globalRegistryLockPath(), () => {
      this.recoverPendingRootRegistrationUnderGlobalLock();
      return withExclusiveFileLock(rootCatalogLock, callback);
    });
  }

  readGlobalRoots(): GlobalRootOwnershipV1 {
    this.recoverPendingRootRegistration();
    return this.readGlobalRootsRaw();
  }

  readSeatCatalogs(seatIdValue: string): SeatCatalogBundle {
    this.recoverPendingRootRegistration();
    return this.readSeatCatalogsRaw(seatIdValue);
  }

  upsertRealm(input: { seat_id: string; expected_revision: number; realm: RealmRecord }): RealmCatalogV1 {
    const seatId = parseSeatId(input.seat_id);
    const realmId = parseRealmId(input.realm.realm_id);
    const paths = this.pathsForSeat(seatId);
    return withExclusiveFileLock(`${paths.realm_catalog}.lock`, () => {
      const catalog = this.readRealmCatalog(paths.realm_catalog, seatId);
      if (catalog.revision !== input.expected_revision) {
        throw new ProjectWorkspaceError('catalog.revision-conflict', 'realm catalog');
      }
      const pathSlugConflict = catalog.realms.some(
        (realm) => realm.realm_id !== realmId && realm.status === 'active' && realm.path_slug === input.realm.path_slug
      );
      if (pathSlugConflict) throw new ProjectWorkspaceError('catalog.project-conflict', 'realm path_slug');
      const nextRealms = [
        ...catalog.realms.filter((realm) => realm.realm_id !== realmId),
        { ...input.realm, realm_id: realmId },
      ].toSorted((left, right) => left.order - right.order || left.realm_id.localeCompare(right.realm_id));
      const next: RealmCatalogV1 = {
        ...catalog,
        revision: catalog.revision + 1,
        realms: nextRealms,
        updated_at: this.timestamp(),
      };
      const validated = parseRealmCatalog(next);
      if (validated.ok === false) throw new ProjectWorkspaceError(validated.reason_code, 'realm catalog');
      writeJsonAtomic(paths.realm_catalog, validated.value);
      return validated.value;
    });
  }

  renameRealm(input: {
    seat_id: string;
    realm_id: string;
    expected_revision: number;
    label: string;
    path_slug: string;
  }): RealmCatalogV1 {
    const catalogs = this.readSeatCatalogs(input.seat_id);
    const current = catalogs.realms.realms.find((realm) => realm.realm_id === input.realm_id);
    if (!current) throw new ProjectWorkspaceError('realm.not-found');
    return this.upsertRealm({
      seat_id: input.seat_id,
      expected_revision: input.expected_revision,
      realm: { ...current, label: input.label, path_slug: input.path_slug },
    });
  }

  registerRoot(input: {
    seat_id: string;
    expected_seat_revision: number;
    expected_global_revision: number;
    root: {
      root_id: string;
      realm_id?: string;
      label: string;
      kind: 'app_managed' | 'external';
      path: string;
      status: 'active' | 'archived';
    };
  }): RootRecord {
    const seatId = parseSeatId(input.seat_id);
    const rootId = parseRootId(input.root.root_id);
    const canonical = canonicalizeRoot(input.root.path);
    if (canonical.ok === false) throw new ProjectWorkspaceError(canonical.reason_code, input.root.path);
    return this.withRootRegistryLocks(seatId, () => {
      const catalogs = this.readSeatCatalogsRaw(seatId);
      const global = this.readGlobalRootsRaw();
      if (
        catalogs.roots.revision !== input.expected_seat_revision ||
        global.revision !== input.expected_global_revision
      ) {
        throw new ProjectWorkspaceError('catalog.revision-conflict', 'root catalog');
      }
      if (input.root.realm_id) {
        const realmId = parseRealmId(input.root.realm_id);
        const realm = catalogs.realms.realms.find((candidate) => candidate.realm_id === realmId);
        if (!realm) throw new ProjectWorkspaceError('realm.not-found');
        if (realm.status !== 'active') throw new ProjectWorkspaceError('realm.archived');
      }
      const workspaceRootRef = toWorkspaceRootRef(rootId);
      const rootRecord: RootRecord = {
        root_id: rootId,
        ...(input.root.realm_id ? { realm_id: parseRealmId(input.root.realm_id) } : {}),
        label: input.root.label,
        kind: input.root.kind,
        canonical_path: canonical.canonical_path,
        comparison_key: canonical.comparison_key,
        workspace_root_ref: workspaceRootRef,
        status: input.root.status,
      };
      const ownership = {
        root_id: rootId,
        seat_id: seatId,
        canonical_path: canonical.canonical_path,
        comparison_key: canonical.comparison_key,
        workspace_root_ref: workspaceRootRef,
        registered_at: this.timestamp(),
      };
      const rootIdOwner = global.roots.find((record) => record.root_id === rootId);
      if (rootIdOwner && rootIdOwner.seat_id !== seatId) {
        throw new ProjectWorkspaceError('root.overlap', `root_id owned by ${rootIdOwner.seat_id}`);
      }
      if (
        rootIdOwner &&
        (rootIdOwner.canonical_path !== canonical.canonical_path ||
          rootIdOwner.comparison_key !== canonical.comparison_key)
      ) {
        throw new ProjectWorkspaceError('root.migration-required', 'physical root moves require HG-3');
      }
      if (rootIdOwner) {
        const existing = catalogs.roots.roots.find((record) => record.root_id === rootId);
        if (!existing) throw new ProjectWorkspaceError('workspace.recovery-required', 'global/local root drift');
        return existing;
      }
      const conflict = findRootOwnershipConflict(ownership, global.roots);
      if (conflict) throw new ProjectWorkspaceError(conflict.reason_code, conflict.owner_seat_id);
      const nextGlobal: GlobalRootOwnershipV1 = {
        ...global,
        revision: global.revision + 1,
        roots: [...global.roots.filter((record) => record.root_id !== rootId), ownership],
        updated_at: this.timestamp(),
      };
      const nextRoots: RootCatalogV1 = {
        ...catalogs.roots,
        revision: catalogs.roots.revision + 1,
        roots: [...catalogs.roots.roots.filter((record) => record.root_id !== rootId), rootRecord],
        updated_at: this.timestamp(),
      };
      const validatedGlobal = parseGlobalRootOwnership(nextGlobal);
      const validatedRoots = parseRootCatalog(nextRoots);
      if (validatedGlobal.ok === false || validatedRoots.ok === false) {
        throw new ProjectWorkspaceError('schema.invalid', 'root registration');
      }
      const pending: PendingRootRegistration = {
        schema_version: 'command-eve-root-registration-journal/v1',
        seat_id: seatId,
        global: validatedGlobal.value,
        roots: validatedRoots.value,
      };
      writeJsonAtomic(this.pendingRootRegistrationPath(), pending);
      writeJsonAtomic(this.globalRegistryPath(), validatedGlobal.value);
      writeJsonAtomic(this.pathsForSeat(seatId).root_catalog, validatedRoots.value);
      this.removePendingRootRegistration();
      return rootRecord;
    });
  }

  renameRoot(input: { seat_id: string; root_id: string; expected_revision: number; label: string }): RootCatalogV1 {
    const seatId = parseSeatId(input.seat_id);
    const rootId = parseRootId(input.root_id);
    const paths = this.pathsForSeat(seatId);
    this.recoverPendingRootRegistration();
    return withExclusiveFileLock(`${paths.root_catalog}.lock`, () => {
      const catalog = this.readRootCatalog(paths.root_catalog, seatId);
      if (catalog.revision !== input.expected_revision) {
        throw new ProjectWorkspaceError('catalog.revision-conflict', 'root catalog');
      }
      const current = catalog.roots.find((root) => root.root_id === rootId);
      if (!current) throw new ProjectWorkspaceError('root.not-found');
      const next: RootCatalogV1 = {
        ...catalog,
        revision: catalog.revision + 1,
        roots: catalog.roots.map((root) =>
          root.root_id === rootId ? Object.assign({}, root, { label: input.label }) : root
        ),
        updated_at: this.timestamp(),
      };
      const validated = parseRootCatalog(next);
      if (validated.ok === false) throw new ProjectWorkspaceError(validated.reason_code, 'root catalog');
      writeJsonAtomic(paths.root_catalog, validated.value);
      return validated.value;
    });
  }

  private readPendingRootRegistration(file: string): PendingRootRegistration {
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch {
      throw new ProjectWorkspaceError('schema.invalid', file);
    }
    if (
      typeof raw !== 'object' ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 4 ||
      !['schema_version', 'seat_id', 'global', 'roots'].every((key) => Object.hasOwn(raw, key))
    ) {
      throw new ProjectWorkspaceError('schema.invalid', file);
    }
    const pending = raw as PendingRootRegistration;
    if (pending.schema_version !== 'command-eve-root-registration-journal/v1') {
      throw new ProjectWorkspaceError('schema.unsupported', file);
    }
    try {
      parseSeatId(pending.seat_id);
    } catch {
      throw new ProjectWorkspaceError('schema.invalid', file);
    }
    const global = parseGlobalRootOwnership(pending.global);
    const roots = parseRootCatalog(pending.roots);
    if (global.ok === false || roots.ok === false || roots.value.seat_id !== pending.seat_id) {
      throw new ProjectWorkspaceError('schema.invalid', file);
    }
    return {
      schema_version: pending.schema_version,
      seat_id: pending.seat_id,
      global: global.value,
      roots: roots.value,
    };
  }

  private removePendingRootRegistration(): void {
    const file = this.pendingRootRegistrationPath();
    try {
      fs.unlinkSync(file);
      syncDirectoryDurable(path.dirname(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private recoverPendingRootRegistration(): void {
    const file = this.pendingRootRegistrationPath();
    if (!fs.existsSync(file)) return;
    withExclusiveFileLock(this.globalRegistryLockPath(), () => {
      this.recoverPendingRootRegistrationUnderGlobalLock();
    });
  }

  private recoverPendingRootRegistrationUnderGlobalLock(): void {
    const file = this.pendingRootRegistrationPath();
    if (!fs.existsSync(file)) return;
    const pending = this.readPendingRootRegistration(file);
    const rootCatalogLock = `${this.pathsForSeat(pending.seat_id).root_catalog}.lock`;
    withExclusiveFileLock(rootCatalogLock, () => {
      writeJsonAtomic(this.globalRegistryPath(), pending.global);
      writeJsonAtomic(this.pathsForSeat(pending.seat_id).root_catalog, pending.roots);
      this.removePendingRootRegistration();
    });
  }

  registerProject(input: { record: ProjectCatalogRecord; expected_revision: number }): ProjectCatalogRecord {
    const seatId = parseSeatId(input.record.seat_id);
    const paths = this.pathsForSeat(seatId);
    return withExclusiveFileLock(`${paths.project_catalog}.lock`, () => {
      const catalog = this.readProjectCatalog(paths.project_catalog, seatId);
      const roots = this.readRootCatalog(paths.root_catalog, seatId);
      const realms = this.readRealmCatalog(paths.realm_catalog, seatId);
      const root = roots.roots.find((record) => record.root_id === input.record.root_id);
      const realm = realms.realms.find((record) => record.realm_id === input.record.realm_id);
      const globalOwner = this.readGlobalRoots().roots.find((record) => record.root_id === input.record.root_id);
      if (
        !root ||
        !realm ||
        root.status !== 'active' ||
        realm.status !== 'active' ||
        root.workspace_root_ref !== input.record.workspace_root_ref ||
        (root.realm_id !== undefined && root.realm_id !== input.record.realm_id) ||
        !globalOwner ||
        globalOwner.seat_id !== seatId ||
        globalOwner.workspace_root_ref !== root.workspace_root_ref ||
        globalOwner.canonical_path !== root.canonical_path ||
        globalOwner.comparison_key !== root.comparison_key
      ) {
        throw new ProjectWorkspaceError('root.unowned');
      }
      const canonical = canonicalizeRoot(root.canonical_path);
      const expectedProjectPath = path.join(root.canonical_path, input.record.slug);
      if (
        canonical.ok === false ||
        canonical.canonical_path !== root.canonical_path ||
        canonical.comparison_key !== root.comparison_key ||
        input.record.canonical_project_path !== expectedProjectPath ||
        input.record.comparison_key !== rootComparisonKey(expectedProjectPath) ||
        input.record.manifest_relative_path !== `${input.record.slug}/.command-eve/project.json`
      ) {
        throw new ProjectWorkspaceError('root.unowned');
      }
      const existing = catalog.projects.find((record) => record.project_id === input.record.project_id);
      if (existing) {
        if (
          existing.seat_id === input.record.seat_id &&
          existing.realm_id === input.record.realm_id &&
          existing.root_id === input.record.root_id &&
          existing.slug === input.record.slug &&
          existing.canonical_project_path === input.record.canonical_project_path &&
          existing.comparison_key === input.record.comparison_key &&
          existing.workspace_root_ref === input.record.workspace_root_ref
        ) {
          return existing;
        }
        throw new ProjectWorkspaceError('catalog.project-conflict', input.record.project_id);
      }
      if (catalog.revision !== input.expected_revision) {
        throw new ProjectWorkspaceError('catalog.revision-conflict', 'project catalog');
      }
      const overlap = catalog.projects.some((record) => {
        const left = record.comparison_key.endsWith('/') ? record.comparison_key : `${record.comparison_key}/`;
        const right = input.record.comparison_key.endsWith('/')
          ? input.record.comparison_key
          : `${input.record.comparison_key}/`;
        return (
          record.comparison_key === input.record.comparison_key ||
          record.comparison_key.startsWith(right) ||
          input.record.comparison_key.startsWith(left)
        );
      });
      if (overlap) throw new ProjectWorkspaceError('root.project-overlap');
      const next: ProjectCatalogV1 = {
        ...catalog,
        revision: catalog.revision + 1,
        projects: [...catalog.projects, input.record].toSorted((a, b) => a.project_id.localeCompare(b.project_id)),
        updated_at: this.timestamp(),
      };
      const validated = parseProjectCatalog(next);
      if (validated.ok === false) throw new ProjectWorkspaceError(validated.reason_code, 'project catalog');
      writeJsonAtomic(paths.project_catalog, validated.value);
      return input.record;
    });
  }

  /**
   * Coarse, active-seat project-catalog CAS used by the 1.817 lifecycle UI.
   * Project identity and physical placement are immutable here; root migration
   * remains a separate HG-3 operation.
   */
  replaceProjectIfRevision(input: {
    seat_id: string;
    expected_revision: number;
    expected_record: ProjectCatalogRecord;
    next_record: ProjectCatalogRecord;
  }): { record: ProjectCatalogRecord; revision: number; updated_at: string } {
    const seatId = parseSeatId(input.seat_id);
    if (
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0 ||
      input.expected_record.seat_id !== seatId ||
      input.next_record.seat_id !== seatId ||
      input.expected_record.project_id !== input.next_record.project_id
    ) {
      throw new ProjectWorkspaceError('catalog.revision-conflict', 'project catalog');
    }
    const immutableIdentityMatches =
      input.expected_record.realm_id === input.next_record.realm_id &&
      input.expected_record.root_id === input.next_record.root_id &&
      input.expected_record.workspace_root_ref === input.next_record.workspace_root_ref &&
      input.expected_record.slug === input.next_record.slug &&
      input.expected_record.manifest_relative_path === input.next_record.manifest_relative_path &&
      input.expected_record.canonical_project_path === input.next_record.canonical_project_path &&
      input.expected_record.comparison_key === input.next_record.comparison_key &&
      input.expected_record.registered_at === input.next_record.registered_at;
    if (!immutableIdentityMatches) throw new ProjectWorkspaceError('root.migration-required');

    const paths = this.pathsForSeat(seatId);
    return withExclusiveFileLock(`${paths.project_catalog}.lock`, () => {
      const catalog = this.readProjectCatalog(paths.project_catalog, seatId);
      if (catalog.revision !== input.expected_revision) {
        throw new ProjectWorkspaceError('catalog.revision-conflict', 'project catalog');
      }
      const existing = catalog.projects.find((record) => record.project_id === input.expected_record.project_id);
      if (!existing || !exactProjectRecord(existing, input.expected_record)) {
        throw new ProjectWorkspaceError('catalog.project-conflict', input.expected_record.project_id);
      }
      const next = {
        ...catalog,
        revision: catalog.revision + 1,
        projects: catalog.projects.map((record) =>
          record.project_id === input.next_record.project_id ? input.next_record : record
        ),
        updated_at: this.timestamp(),
      } satisfies ProjectCatalogV1;
      const validated = parseProjectCatalog(next);
      if (validated.ok === false) throw new ProjectWorkspaceError(validated.reason_code, 'project catalog');
      writeJsonAtomic(paths.project_catalog, validated.value);
      return {
        record: input.next_record,
        revision: validated.value.revision,
        updated_at: validated.value.updated_at,
      };
    });
  }

  touchProjectIfRevision(input: { seat_id: string; project_id: string; expected_revision: number }): {
    record: ProjectCatalogRecord;
    revision: number;
    updated_at: string;
  } {
    const catalogs = this.readSeatCatalogs(input.seat_id);
    if (catalogs.projects.revision !== input.expected_revision) {
      throw new ProjectWorkspaceError('catalog.revision-conflict', 'project catalog');
    }
    const current = catalogs.projects.projects.find((record) => record.project_id === input.project_id);
    if (!current) throw new ProjectWorkspaceError('catalog.project-conflict', input.project_id);
    return this.replaceProjectIfRevision({
      seat_id: input.seat_id,
      expected_revision: input.expected_revision,
      expected_record: current,
      next_record: current,
    });
  }

  removeProject(seatIdValue: string, projectId: string): boolean {
    const seatId = parseSeatId(seatIdValue);
    const paths = this.pathsForSeat(seatId);
    return withExclusiveFileLock(`${paths.project_catalog}.lock`, () => {
      const catalog = this.readProjectCatalog(paths.project_catalog, seatId);
      const nextProjects = catalog.projects.filter((record) => record.project_id !== projectId);
      if (nextProjects.length === catalog.projects.length) return false;
      const next = {
        ...catalog,
        revision: catalog.revision + 1,
        projects: nextProjects,
        updated_at: this.timestamp(),
      } satisfies ProjectCatalogV1;
      const validated = parseProjectCatalog(next);
      if (validated.ok === false) throw new ProjectWorkspaceError(validated.reason_code, 'project catalog');
      writeJsonAtomic(paths.project_catalog, validated.value);
      return true;
    });
  }

  removeProjectIfMatches(input: {
    seat_id: string;
    expected_revision: number;
    expected_record: ProjectCatalogRecord;
    allow_already_absent: boolean;
  }): 'removed' | 'already_absent' {
    const seatId = parseSeatId(input.seat_id);
    if (
      !Number.isSafeInteger(input.expected_revision) ||
      input.expected_revision < 0 ||
      input.expected_record.seat_id !== seatId
    ) {
      throw new ProjectWorkspaceError('catalog.revision-conflict', 'project catalog');
    }
    const paths = this.pathsForSeat(seatId);
    return withExclusiveFileLock(`${paths.project_catalog}.lock`, () => {
      const catalog = this.readProjectCatalog(paths.project_catalog, seatId);
      const existing = catalog.projects.find((record) => record.project_id === input.expected_record.project_id);
      if (!existing) {
        if (input.allow_already_absent && catalog.revision >= input.expected_revision + 1) {
          return 'already_absent';
        }
        throw new ProjectWorkspaceError('catalog.revision-conflict', 'project catalog');
      }
      if (!exactProjectRecord(existing, input.expected_record)) {
        throw new ProjectWorkspaceError('catalog.project-conflict', input.expected_record.project_id);
      }
      if (catalog.revision < input.expected_revision) {
        throw new ProjectWorkspaceError('catalog.revision-conflict', 'project catalog');
      }
      const next = {
        ...catalog,
        revision: catalog.revision + 1,
        projects: catalog.projects.filter((record) => record.project_id !== input.expected_record.project_id),
        updated_at: this.timestamp(),
      } satisfies ProjectCatalogV1;
      const validated = parseProjectCatalog(next);
      if (validated.ok === false) throw new ProjectWorkspaceError(validated.reason_code, 'project catalog');
      writeJsonAtomic(paths.project_catalog, validated.value);
      return 'removed';
    });
  }

  markProjectRecoveryRequired(seatIdValue: string, projectId: string): void {
    const seatId = parseSeatId(seatIdValue);
    const paths = this.pathsForSeat(seatId);
    withExclusiveFileLock(`${paths.project_catalog}.lock`, () => {
      const catalog = this.readProjectCatalog(paths.project_catalog, seatId);
      const projects = catalog.projects.map((record) =>
        record.project_id === projectId ? { ...record, status: 'recovery_required' as const } : record
      );
      const next = {
        ...catalog,
        revision: catalog.revision + 1,
        projects,
        updated_at: this.timestamp(),
      } satisfies ProjectCatalogV1;
      const validated = parseProjectCatalog(next);
      if (validated.ok === false) throw new ProjectWorkspaceError(validated.reason_code, 'project catalog');
      writeJsonAtomic(paths.project_catalog, validated.value);
    });
  }
}
