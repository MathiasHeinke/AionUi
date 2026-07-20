import { z } from 'zod';
import type { ProjectIdentityTuple } from './identity';
import type { ProjectWorkspaceReasonCode } from './reasonCodes';

export const PROJECT_MANIFEST_VERSION = 'command-eve-project/v1' as const;
export const PROJECT_RECEIPT_VERSION = 'command-eve-project-receipt/v1' as const;

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const seatId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const rootRef = z.string().regex(/^root:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const domainId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);
const timestamp = z.string().datetime({ offset: true });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const relativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.startsWith('\\') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  );

const identitySchema = z
  .object({
    seat_id: seatId,
    realm_id: uuid,
    root_id: uuid,
    project_id: uuid,
    workspace_root_ref: rootRef,
  })
  .strict()
  .refine((value) => value.workspace_root_ref === `root:${value.root_id}`);

export const projectManifestV1Schema = z
  .object({
    schema_version: z.literal(PROJECT_MANIFEST_VERSION),
    project_id: uuid,
    seat_id: seatId,
    realm_id: uuid,
    realm_label: z.string().trim().min(1).max(120),
    realm_path_slug: slug,
    root_id: uuid,
    title: z.string().trim().min(1).max(200),
    slug,
    status: z.enum(['active', 'archived', 'recovery_required']),
    domain_ids: z.array(domainId).max(64),
    created_by: z.enum(['user', 'eve']),
    created_at: timestamp,
    workspace_root_ref: rootRef,
    manual_overrides: z.array(z.enum(['title', 'realm', 'root', 'domains', 'status'])).max(16),
  })
  .strict()
  .refine((value) => value.workspace_root_ref === `root:${value.root_id}`);

const legacyManifestV0Schema = z
  .object({
    schema_version: z.literal('command-eve-project/v0'),
    project_id: uuid,
    seat_id: seatId,
    realm_label: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(200),
    slug,
    status: z.enum(['active', 'archived']),
    domain_ids: z.array(domainId).max(64),
    created_by: z.enum(['user', 'eve']),
    created_at: timestamp,
  })
  .strict();

export const projectReceiptV1Schema = z
  .object({
    schema_version: z.literal(PROJECT_RECEIPT_VERSION),
    transaction_id: uuid,
    operation: z.enum(['create', 'adopt', 'recover', 'undo']),
    status: z.enum(['committed', 'undone', 'recovery_required']),
    identity: identitySchema,
    semantic_bundle_sha256: sha256,
    semantic_preflight_receipt_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/),
    created_files: z.array(z.object({ relative_path: relativePath, sha256 }).strict()).max(128),
    created_directories: z.array(relativePath).max(64),
    created_at: timestamp,
    updated_at: timestamp,
    reason_code: z.string().min(1).max(120).optional(),
  })
  .strict();

export type ProjectManifestV1 = {
  schema_version: typeof PROJECT_MANIFEST_VERSION;
  project_id: string;
  seat_id: string;
  realm_id: string;
  realm_label: string;
  realm_path_slug: string;
  root_id: string;
  title: string;
  slug: string;
  status: 'active' | 'archived' | 'recovery_required';
  domain_ids: string[];
  created_by: 'user' | 'eve';
  created_at: string;
  workspace_root_ref: `root:${string}`;
  manual_overrides: Array<'title' | 'realm' | 'root' | 'domains' | 'status'>;
};

export type ProjectReceiptV1 = {
  schema_version: typeof PROJECT_RECEIPT_VERSION;
  transaction_id: string;
  operation: 'create' | 'adopt' | 'recover' | 'undo';
  status: 'committed' | 'undone' | 'recovery_required';
  identity: {
    seat_id: string;
    realm_id: string;
    root_id: string;
    project_id: string;
    workspace_root_ref: `root:${string}`;
  };
  semantic_bundle_sha256: string;
  semantic_preflight_receipt_id: string;
  created_files: Array<{ relative_path: string; sha256: string }>;
  created_directories: string[];
  created_at: string;
  updated_at: string;
  reason_code?: string;
};

export type SchemaParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason_code: Extract<ProjectWorkspaceReasonCode, 'schema.invalid' | 'schema.unsupported'> };

function unsupportedVersion(value: unknown, expected: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const version = (value as Record<string, unknown>).schema_version;
  return typeof version === 'string' && version !== expected;
}

export function parseProjectManifest(value: unknown): SchemaParseResult<ProjectManifestV1> {
  const result = projectManifestV1Schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data as ProjectManifestV1 };
  return {
    ok: false,
    reason_code: unsupportedVersion(value, PROJECT_MANIFEST_VERSION) ? 'schema.unsupported' : 'schema.invalid',
  };
}

export function parseProjectReceipt(value: unknown): SchemaParseResult<ProjectReceiptV1> {
  const result = projectReceiptV1Schema.safeParse(value);
  if (result.success) return { ok: true, value: result.data as ProjectReceiptV1 };
  return {
    ok: false,
    reason_code: unsupportedVersion(value, PROJECT_RECEIPT_VERSION) ? 'schema.unsupported' : 'schema.invalid',
  };
}

export type ProjectManifestMigrationContext = {
  realm_id: string;
  realm_path_slug: string;
  root_id: string;
};

export type ProjectManifestMigrationResult =
  | {
      ok: true;
      value: ProjectManifestV1;
      migrated: boolean;
      from_version: string;
      to_version: typeof PROJECT_MANIFEST_VERSION;
    }
  | {
      ok: false;
      reason_code: Extract<
        ProjectWorkspaceReasonCode,
        'schema.invalid' | 'schema.unsupported' | 'schema.migration-context-required'
      >;
    };

/** Pure migration preview. Callers decide whether a migrated manifest may be persisted. */
export function migrateProjectManifest(
  value: unknown,
  context: ProjectManifestMigrationContext | undefined
): ProjectManifestMigrationResult {
  const current = parseProjectManifest(value);
  if (current.ok) {
    return {
      ok: true,
      value: current.value,
      migrated: false,
      from_version: PROJECT_MANIFEST_VERSION,
      to_version: PROJECT_MANIFEST_VERSION,
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason_code: 'schema.invalid' };
  }
  const version = (value as Record<string, unknown>).schema_version;
  if (version !== 'command-eve-project/v0') return { ok: false, reason_code: 'schema.unsupported' };
  const legacy = legacyManifestV0Schema.safeParse(value);
  if (!legacy.success) return { ok: false, reason_code: 'schema.invalid' };
  if (!context) return { ok: false, reason_code: 'schema.migration-context-required' };

  const candidate = {
    ...legacy.data,
    schema_version: PROJECT_MANIFEST_VERSION,
    realm_id: context.realm_id,
    realm_path_slug: context.realm_path_slug,
    root_id: context.root_id,
    workspace_root_ref: `root:${context.root_id}`,
    manual_overrides: [] as ProjectManifestV1['manual_overrides'],
  };
  const migrated = parseProjectManifest(candidate);
  if (migrated.ok === false) return { ok: false, reason_code: migrated.reason_code };
  return {
    ok: true,
    value: migrated.value,
    migrated: true,
    from_version: 'command-eve-project/v0',
    to_version: PROJECT_MANIFEST_VERSION,
  };
}

export function manifestIdentity(manifest: ProjectManifestV1): ProjectIdentityTuple {
  return {
    seat_id: manifest.seat_id,
    realm_id: manifest.realm_id,
    root_id: manifest.root_id,
    project_id: manifest.project_id,
    workspace_root_ref: manifest.workspace_root_ref,
  };
}
