import { z } from 'zod';
import type { SchemaParseResult } from './manifest';

export const REALM_CATALOG_VERSION = 'command-eve-realm-catalog/v1' as const;
export const ROOT_CATALOG_VERSION = 'command-eve-root-catalog/v1' as const;
export const PROJECT_CATALOG_VERSION = 'command-eve-project-catalog/v1' as const;
export const GLOBAL_ROOT_OWNERSHIP_VERSION = 'command-eve-root-ownership/v1' as const;

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const seatId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const rootRef = z.string().regex(/^root:[0-9a-f-]{36}$/i);
const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const timestamp = z.string().datetime({ offset: true });
const revision = z.number().int().nonnegative();
const absolutePath = z
  .string()
  .min(1)
  .regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/);

export const realmRecordSchema = z
  .object({
    realm_id: uuid,
    label: z.string().trim().min(1).max(120),
    path_slug: slug,
    status: z.enum(['active', 'archived']),
    order: z.number().int().nonnegative(),
  })
  .strict();

export const rootRecordSchema = z
  .object({
    root_id: uuid,
    realm_id: uuid.optional(),
    label: z.string().trim().min(1).max(120),
    kind: z.enum(['app_managed', 'external']),
    canonical_path: absolutePath,
    comparison_key: z.string().min(1),
    workspace_root_ref: rootRef,
    status: z.enum(['active', 'archived']),
  })
  .strict()
  .refine((value) => value.workspace_root_ref === `root:${value.root_id}`);

export const projectCatalogRecordSchema = z
  .object({
    project_id: uuid,
    seat_id: seatId,
    realm_id: uuid,
    root_id: uuid,
    workspace_root_ref: rootRef,
    title: z.string().trim().min(1).max(200),
    slug,
    status: z.enum(['active', 'archived', 'recovery_required']),
    manifest_relative_path: z.string().regex(/^[^/\\]+\/\.command-eve\/project\.json$/),
    canonical_project_path: absolutePath,
    comparison_key: z.string().min(1),
    registered_at: timestamp,
  })
  .strict()
  .refine((value) => value.workspace_root_ref === `root:${value.root_id}`);

export const rootOwnershipRecordSchema = z
  .object({
    root_id: uuid,
    seat_id: seatId,
    canonical_path: absolutePath,
    comparison_key: z.string().min(1),
    workspace_root_ref: rootRef,
    registered_at: timestamp,
  })
  .strict()
  .refine((value) => value.workspace_root_ref === `root:${value.root_id}`);

export const realmCatalogSchema = z
  .object({
    schema_version: z.literal(REALM_CATALOG_VERSION),
    seat_id: seatId,
    revision,
    realms: z.array(realmRecordSchema),
    updated_at: timestamp,
  })
  .strict();

export const rootCatalogSchema = z
  .object({
    schema_version: z.literal(ROOT_CATALOG_VERSION),
    seat_id: seatId,
    revision,
    roots: z.array(rootRecordSchema),
    updated_at: timestamp,
  })
  .strict();

export const projectCatalogSchema = z
  .object({
    schema_version: z.literal(PROJECT_CATALOG_VERSION),
    seat_id: seatId,
    revision,
    projects: z.array(projectCatalogRecordSchema),
    updated_at: timestamp,
  })
  .strict();

export const globalRootOwnershipSchema = z
  .object({
    schema_version: z.literal(GLOBAL_ROOT_OWNERSHIP_VERSION),
    revision,
    roots: z.array(rootOwnershipRecordSchema),
    updated_at: timestamp,
  })
  .strict();

export type RealmRecord = {
  realm_id: string;
  label: string;
  path_slug: string;
  status: 'active' | 'archived';
  order: number;
};

export type RootRecord = {
  root_id: string;
  realm_id?: string;
  label: string;
  kind: 'app_managed' | 'external';
  canonical_path: string;
  comparison_key: string;
  workspace_root_ref: `root:${string}`;
  status: 'active' | 'archived';
};

export type ProjectCatalogRecord = {
  project_id: string;
  seat_id: string;
  realm_id: string;
  root_id: string;
  workspace_root_ref: `root:${string}`;
  title: string;
  slug: string;
  status: 'active' | 'archived' | 'recovery_required';
  manifest_relative_path: string;
  canonical_project_path: string;
  comparison_key: string;
  registered_at: string;
};

export type RootOwnershipRecord = {
  root_id: string;
  seat_id: string;
  canonical_path: string;
  comparison_key: string;
  workspace_root_ref: `root:${string}`;
  registered_at: string;
};

export type RealmCatalogV1 = {
  schema_version: typeof REALM_CATALOG_VERSION;
  seat_id: string;
  revision: number;
  realms: RealmRecord[];
  updated_at: string;
};

export type RootCatalogV1 = {
  schema_version: typeof ROOT_CATALOG_VERSION;
  seat_id: string;
  revision: number;
  roots: RootRecord[];
  updated_at: string;
};

export type ProjectCatalogV1 = {
  schema_version: typeof PROJECT_CATALOG_VERSION;
  seat_id: string;
  revision: number;
  projects: ProjectCatalogRecord[];
  updated_at: string;
};

export type GlobalRootOwnershipV1 = {
  schema_version: typeof GLOBAL_ROOT_OWNERSHIP_VERSION;
  revision: number;
  roots: RootOwnershipRecord[];
  updated_at: string;
};

function parseCatalog<T>(schema: z.ZodTypeAny, expected: string, value: unknown): SchemaParseResult<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data as T };
  const version =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).schema_version
      : undefined;
  return {
    ok: false,
    reason_code: typeof version === 'string' && version !== expected ? 'schema.unsupported' : 'schema.invalid',
  };
}

export const parseRealmCatalog = (value: unknown): SchemaParseResult<RealmCatalogV1> =>
  parseCatalog<RealmCatalogV1>(realmCatalogSchema, REALM_CATALOG_VERSION, value);
export const parseRootCatalog = (value: unknown): SchemaParseResult<RootCatalogV1> =>
  parseCatalog<RootCatalogV1>(rootCatalogSchema, ROOT_CATALOG_VERSION, value);
export const parseProjectCatalog = (value: unknown): SchemaParseResult<ProjectCatalogV1> =>
  parseCatalog<ProjectCatalogV1>(projectCatalogSchema, PROJECT_CATALOG_VERSION, value);
export const parseGlobalRootOwnership = (value: unknown): SchemaParseResult<GlobalRootOwnershipV1> =>
  parseCatalog<GlobalRootOwnershipV1>(globalRootOwnershipSchema, GLOBAL_ROOT_OWNERSHIP_VERSION, value);
