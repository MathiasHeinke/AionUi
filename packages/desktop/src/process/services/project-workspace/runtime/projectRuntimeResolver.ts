import fs from 'node:fs';
import path from 'node:path';
import { parseProjectManifest } from '@/common/types/project-workspace/manifest';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import {
  buildProjectEnvironmentHint,
  deriveBackendGeneration,
  sha256Utf8,
} from '@process/security/projectRuntimeAttestationCore';
import type { ProjectWorkspaceRegistryStore } from '../storage/registryStore';
import { rootComparisonKey } from '../storage/rootPolicy';
import type { ProjectConversationBindingClient } from './conversationBindingClient';

export type TrustedProjectRuntimeSnapshot = {
  conversation_id: string;
  project_path: string;
  canonical_path_sha256: string;
  seat_id: string;
  realm_id: string;
  root_id: string;
  project_id: string;
  workspace_root_ref: `root:${string}`;
  project_binding_revision: number;
  project_binding_receipt_id: string | null;
  realm_catalog_revision: number;
  root_catalog_revision: number;
  root_ownership_revision: number;
  project_catalog_revision: number;
  realm_record_sha256: string;
  root_record_sha256: string;
  root_ownership_record_sha256: string;
  project_record_sha256: string;
  manifest_sha256: string;
  backend_generation: string;
  backend_port: number;
  environment_hint: string;
};

export type ProjectRuntimeResolverDependencies = {
  registry: ProjectWorkspaceRegistryStore;
  binding_client: ProjectConversationBindingClient;
  get_active_seat_id: () => string;
  is_seat_switch_in_flight: () => boolean;
  get_backend_port: () => number;
  get_backend_capability: () => string;
};

const PROJECT_RUNTIME_REASON_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;

export class ProjectRuntimeResolutionError extends Error {
  readonly code: string;

  constructor(code: string) {
    const pathlessCode = PROJECT_RUNTIME_REASON_CODE.test(code) ? code : 'PROJECT_RUNTIME_REQUEST_FAILED';
    super(pathlessCode);
    this.name = 'ProjectRuntimeResolutionError';
    this.code = pathlessCode;
    this.stack = `${this.name}: ${pathlessCode}`;
  }
}

function filesystemResolutionError(error: unknown): ProjectRuntimeResolutionError | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return new ProjectRuntimeResolutionError('PROJECT_RUNTIME_PATH_NOT_FOUND');
  if (code === 'EACCES' || code === 'EPERM') {
    return new ProjectRuntimeResolutionError('PROJECT_RUNTIME_PATH_ACCESS_DENIED');
  }
  return undefined;
}

export function pathlessProjectRuntimeResolutionError(
  error: unknown,
  fallbackCode = 'PROJECT_RUNTIME_REQUEST_FAILED'
): ProjectRuntimeResolutionError {
  const filesystemError = filesystemResolutionError(error);
  if (filesystemError) return filesystemError;
  if (error instanceof ProjectRuntimeResolutionError) return new ProjectRuntimeResolutionError(error.code);
  return new ProjectRuntimeResolutionError(fallbackCode);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertBackendState(deps: ProjectRuntimeResolverDependencies): { port: number; generation: string } {
  const port = deps.get_backend_port();
  const capability = deps.get_backend_capability();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || capability.length === 0) {
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_BACKEND_UNAVAILABLE');
  }
  return { port, generation: deriveBackendGeneration(capability) };
}

function assertRegularCanonicalDirectory(directory: string): void {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(directory) !== directory) {
      throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_PROJECT_UNSAFE');
    }
  } catch (error) {
    if (error instanceof ProjectRuntimeResolutionError) throw error;
    const filesystemError = filesystemResolutionError(error);
    if (filesystemError) throw filesystemError;
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_PROJECT_UNAVAILABLE');
  }
}

function readManifest(projectPath: string): ReturnType<typeof parseProjectManifest> {
  const manifestPath = path.join(projectPath, '.command-eve', 'project.json');
  try {
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe manifest');
    return parseProjectManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown);
  } catch (error) {
    const filesystemError = filesystemResolutionError(error);
    if (filesystemError) throw filesystemError;
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_MANIFEST_INVALID');
  }
}

export async function resolveTrustedProjectRuntimeSnapshot(
  conversationId: string,
  deps: ProjectRuntimeResolverDependencies
): Promise<TrustedProjectRuntimeSnapshot> {
  if (deps.is_seat_switch_in_flight()) throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_SEAT_SWITCH');
  const initialSeat = deps.get_active_seat_id();
  const initialBackend = assertBackendState(deps);
  const bindingSnapshot = await deps.binding_client.read(conversationId);
  const binding = bindingSnapshot.binding;
  if (!binding) throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_BINDING_REQUIRED');

  let catalogs;
  let ownership;
  try {
    catalogs = deps.registry.readSeatCatalogs(initialSeat);
    ownership = deps.registry.readGlobalRoots();
  } catch (error) {
    if (error instanceof ProjectWorkspaceError)
      throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_REGISTRY_INVALID');
    throw pathlessProjectRuntimeResolutionError(error, 'PROJECT_RUNTIME_REGISTRY_INVALID');
  }
  const project = catalogs.projects.projects.find((candidate) => candidate.project_id === binding.project_id);
  if (!project || project.status !== 'active')
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_PROJECT_INACTIVE');
  const root = catalogs.roots.roots.find((candidate) => candidate.root_id === project.root_id);
  const realm = catalogs.realms.realms.find((candidate) => candidate.realm_id === project.realm_id);
  const owner = ownership.roots.find((candidate) => candidate.root_id === project.root_id);
  if (
    !root ||
    root.status !== 'active' ||
    !realm ||
    realm.status !== 'active' ||
    !owner ||
    owner.seat_id !== initialSeat ||
    project.seat_id !== initialSeat ||
    project.workspace_root_ref !== binding.workspace_root_ref ||
    root.workspace_root_ref !== binding.workspace_root_ref ||
    owner.workspace_root_ref !== binding.workspace_root_ref ||
    (root.realm_id !== undefined && root.realm_id !== project.realm_id) ||
    owner.canonical_path !== root.canonical_path ||
    owner.comparison_key !== root.comparison_key
  ) {
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_BINDING_FOREIGN');
  }

  assertRegularCanonicalDirectory(root.canonical_path);
  assertRegularCanonicalDirectory(project.canonical_project_path);
  const expectedProjectPath = path.join(root.canonical_path, project.slug);
  const relative = path.relative(root.canonical_path, project.canonical_project_path);
  if (
    project.canonical_project_path !== expectedProjectPath ||
    project.comparison_key !== rootComparisonKey(expectedProjectPath) ||
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_PROJECT_UNSAFE');
  }
  const manifest = readManifest(project.canonical_project_path);
  if (
    !manifest.ok ||
    manifest.value.status !== 'active' ||
    manifest.value.seat_id !== initialSeat ||
    manifest.value.realm_id !== project.realm_id ||
    manifest.value.root_id !== project.root_id ||
    manifest.value.project_id !== project.project_id ||
    manifest.value.workspace_root_ref !== project.workspace_root_ref ||
    manifest.value.title !== project.title ||
    manifest.value.slug !== project.slug
  ) {
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_MANIFEST_MISMATCH');
  }
  const realmRecordSha256 = sha256Utf8(canonicalJson(realm));
  const rootRecordSha256 = sha256Utf8(canonicalJson(root));
  const rootOwnershipRecordSha256 = sha256Utf8(canonicalJson(owner));
  const projectRecordSha256 = sha256Utf8(canonicalJson(project));
  const manifestSha256 = sha256Utf8(canonicalJson(manifest.value));

  const secondBindingSnapshot = await deps.binding_client.read(conversationId);
  let secondCatalogs;
  let secondOwnership;
  try {
    secondCatalogs = deps.registry.readSeatCatalogs(initialSeat);
    secondOwnership = deps.registry.readGlobalRoots();
  } catch (error) {
    if (error instanceof ProjectWorkspaceError) {
      throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_REGISTRY_INVALID');
    }
    throw pathlessProjectRuntimeResolutionError(error, 'PROJECT_RUNTIME_REGISTRY_INVALID');
  }
  const secondRealm = secondCatalogs.realms.realms.find((candidate) => candidate.realm_id === realm.realm_id);
  const secondRoot = secondCatalogs.roots.roots.find((candidate) => candidate.root_id === root.root_id);
  const secondOwner = secondOwnership.roots.find((candidate) => candidate.root_id === owner.root_id);
  const secondProject = secondCatalogs.projects.projects.find(
    (candidate) => candidate.project_id === project.project_id
  );
  const secondManifest = readManifest(project.canonical_project_path);
  const finalBackend = assertBackendState(deps);
  if (
    deps.is_seat_switch_in_flight() ||
    deps.get_active_seat_id() !== initialSeat ||
    secondCatalogs.realms.revision !== catalogs.realms.revision ||
    secondCatalogs.roots.revision !== catalogs.roots.revision ||
    secondCatalogs.projects.revision !== catalogs.projects.revision ||
    secondOwnership.revision !== ownership.revision ||
    !sameBindingSnapshot(secondBindingSnapshot, bindingSnapshot) ||
    !secondRealm ||
    !secondRoot ||
    !secondOwner ||
    !secondProject ||
    !secondManifest.ok ||
    sha256Utf8(canonicalJson(secondRealm)) !== realmRecordSha256 ||
    sha256Utf8(canonicalJson(secondRoot)) !== rootRecordSha256 ||
    sha256Utf8(canonicalJson(secondOwner)) !== rootOwnershipRecordSha256 ||
    sha256Utf8(canonicalJson(secondProject)) !== projectRecordSha256 ||
    sha256Utf8(canonicalJson(secondManifest.value)) !== manifestSha256 ||
    finalBackend.port !== initialBackend.port ||
    finalBackend.generation !== initialBackend.generation
  ) {
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_SNAPSHOT_CHANGED');
  }

  return {
    conversation_id: conversationId,
    project_path: project.canonical_project_path,
    canonical_path_sha256: sha256Utf8(project.canonical_project_path),
    seat_id: initialSeat,
    realm_id: project.realm_id,
    root_id: project.root_id,
    project_id: project.project_id,
    workspace_root_ref: project.workspace_root_ref,
    project_binding_revision: bindingSnapshot.project_binding_revision,
    project_binding_receipt_id: bindingSnapshot.project_binding_receipt_id,
    realm_catalog_revision: catalogs.realms.revision,
    root_catalog_revision: catalogs.roots.revision,
    root_ownership_revision: ownership.revision,
    project_catalog_revision: catalogs.projects.revision,
    realm_record_sha256: realmRecordSha256,
    root_record_sha256: rootRecordSha256,
    root_ownership_record_sha256: rootOwnershipRecordSha256,
    project_record_sha256: projectRecordSha256,
    manifest_sha256: manifestSha256,
    backend_generation: initialBackend.generation,
    backend_port: initialBackend.port,
    environment_hint: buildProjectEnvironmentHint({
      project_id: project.project_id,
      workspace_root_ref: project.workspace_root_ref,
      realm_id: project.realm_id,
      project_title: project.title,
    }),
  };
}

function sameBinding(
  left: { project_id: string; workspace_root_ref: string } | null,
  right: { project_id: string; workspace_root_ref: string } | null
): boolean {
  return left?.project_id === right?.project_id && left?.workspace_root_ref === right?.workspace_root_ref;
}

function sameBindingSnapshot(
  left: {
    binding: { project_id: string; workspace_root_ref: string } | null;
    project_binding_revision: number;
    project_binding_receipt_id: string | null;
  },
  right: {
    binding: { project_id: string; workspace_root_ref: string } | null;
    project_binding_revision: number;
    project_binding_receipt_id: string | null;
  }
): boolean {
  return (
    left.project_binding_revision === right.project_binding_revision &&
    left.project_binding_receipt_id === right.project_binding_receipt_id &&
    sameBinding(left.binding, right.binding)
  );
}

export async function assertRuntimeSnapshotStillCurrent(
  snapshot: TrustedProjectRuntimeSnapshot,
  deps: ProjectRuntimeResolverDependencies
): Promise<void> {
  let catalogs;
  let ownership;
  let binding;
  let manifest;
  try {
    binding = await deps.binding_client.read(snapshot.conversation_id);
    catalogs = deps.registry.readSeatCatalogs(snapshot.seat_id);
    ownership = deps.registry.readGlobalRoots();
    assertRegularCanonicalDirectory(snapshot.project_path);
    manifest = readManifest(snapshot.project_path);
  } catch (error) {
    const filesystemError = filesystemResolutionError(error);
    if (filesystemError) throw filesystemError;
    if (
      error instanceof ProjectRuntimeResolutionError &&
      (error.code === 'PROJECT_RUNTIME_PATH_NOT_FOUND' || error.code === 'PROJECT_RUNTIME_PATH_ACCESS_DENIED')
    ) {
      throw new ProjectRuntimeResolutionError(error.code);
    }
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_SNAPSHOT_CHANGED');
  }
  const backend = assertBackendState(deps);
  const realm = catalogs.realms.realms.find((candidate) => candidate.realm_id === snapshot.realm_id);
  const root = catalogs.roots.roots.find((candidate) => candidate.root_id === snapshot.root_id);
  const owner = ownership.roots.find((candidate) => candidate.root_id === snapshot.root_id);
  const project = catalogs.projects.projects.find((candidate) => candidate.project_id === snapshot.project_id);
  if (
    deps.is_seat_switch_in_flight() ||
    deps.get_active_seat_id() !== snapshot.seat_id ||
    backend.port !== snapshot.backend_port ||
    backend.generation !== snapshot.backend_generation ||
    catalogs.realms.revision !== snapshot.realm_catalog_revision ||
    catalogs.roots.revision !== snapshot.root_catalog_revision ||
    ownership.revision !== snapshot.root_ownership_revision ||
    catalogs.projects.revision !== snapshot.project_catalog_revision ||
    !realm ||
    !root ||
    !owner ||
    !project ||
    !manifest.ok ||
    sha256Utf8(canonicalJson(realm)) !== snapshot.realm_record_sha256 ||
    sha256Utf8(canonicalJson(root)) !== snapshot.root_record_sha256 ||
    sha256Utf8(canonicalJson(owner)) !== snapshot.root_ownership_record_sha256 ||
    sha256Utf8(canonicalJson(project)) !== snapshot.project_record_sha256 ||
    sha256Utf8(canonicalJson(manifest.value)) !== snapshot.manifest_sha256 ||
    !sameBindingSnapshot(binding, {
      binding: {
        project_id: snapshot.project_id,
        workspace_root_ref: snapshot.workspace_root_ref,
      },
      project_binding_revision: snapshot.project_binding_revision,
      project_binding_receipt_id: snapshot.project_binding_receipt_id,
    })
  ) {
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_SNAPSHOT_CHANGED');
  }
}
