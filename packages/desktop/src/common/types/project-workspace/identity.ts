import { ProjectWorkspaceError } from './reasonCodes';

declare const seatIdBrand: unique symbol;
declare const realmIdBrand: unique symbol;
declare const rootIdBrand: unique symbol;
declare const projectIdBrand: unique symbol;
declare const transactionIdBrand: unique symbol;
declare const workspaceRootRefBrand: unique symbol;

export type SeatId = string & { readonly [seatIdBrand]: true };
export type RealmId = string & { readonly [realmIdBrand]: true };
export type RootId = string & { readonly [rootIdBrand]: true };
export type ProjectId = string & { readonly [projectIdBrand]: true };
export type TransactionId = string & { readonly [transactionIdBrand]: true };
export type WorkspaceRootRef = `root:${string}` & { readonly [workspaceRootRefBrand]: true };

export const OPAQUE_PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SAFE_SEAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function parseOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OPAQUE_PROJECT_ID_PATTERN.test(value)) {
    throw new ProjectWorkspaceError('identity.invalid', `${label} must be an opaque UUID`);
  }
  return value.toLowerCase();
}

export function parseSeatId(value: unknown): SeatId {
  if (typeof value !== 'string' || !SAFE_SEAT_ID_PATTERN.test(value)) {
    throw new ProjectWorkspaceError('identity.invalid', 'seat_id is invalid');
  }
  return value as SeatId;
}

export function parseRealmId(value: unknown): RealmId {
  return parseOpaqueId(value, 'realm_id') as RealmId;
}

export function parseRootId(value: unknown): RootId {
  return parseOpaqueId(value, 'root_id') as RootId;
}

export function parseProjectId(value: unknown): ProjectId {
  return parseOpaqueId(value, 'project_id') as ProjectId;
}

export function parseTransactionId(value: unknown): TransactionId {
  if (typeof value !== 'string' || !TRANSACTION_ID_PATTERN.test(value)) {
    throw new ProjectWorkspaceError('identity.invalid', 'transaction_id must be a canonical lowercase UUIDv4');
  }
  return value as TransactionId;
}

export function toWorkspaceRootRef(rootId: RootId): WorkspaceRootRef {
  return `root:${rootId}` as WorkspaceRootRef;
}

export function parseWorkspaceRootRef(value: unknown): WorkspaceRootRef {
  if (typeof value !== 'string' || !value.startsWith('root:')) {
    throw new ProjectWorkspaceError('identity.invalid', 'workspace_root_ref must use root:<root_id>');
  }
  const rootId = parseRootId(value.slice('root:'.length));
  if (value !== `root:${rootId}`) {
    throw new ProjectWorkspaceError('identity.invalid', 'workspace_root_ref is not canonical');
  }
  return value as WorkspaceRootRef;
}

export type ProjectIdentityTuple = {
  seat_id: SeatId | string;
  realm_id: RealmId | string;
  root_id: RootId | string;
  project_id: ProjectId | string;
  workspace_root_ref: WorkspaceRootRef | `root:${string}`;
};

export function assertIdentityTuple(value: ProjectIdentityTuple): ProjectIdentityTuple {
  const seatId = parseSeatId(value.seat_id);
  const realmId = parseRealmId(value.realm_id);
  const rootId = parseRootId(value.root_id);
  const projectId = parseProjectId(value.project_id);
  const workspaceRootRef = parseWorkspaceRootRef(value.workspace_root_ref);
  if (workspaceRootRef !== toWorkspaceRootRef(rootId)) {
    throw new ProjectWorkspaceError('identity.invalid', 'root_id and workspace_root_ref disagree');
  }
  return {
    seat_id: seatId,
    realm_id: realmId,
    root_id: rootId,
    project_id: projectId,
    workspace_root_ref: workspaceRootRef,
  };
}
