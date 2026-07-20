import type { ProjectIdentityTuple } from './identity';
import type { ProjectCatalogRecord } from './registry';

export const PROJECT_LEASE_VERSION = 'command-eve-project-lease/v2' as const;
export const PROJECT_JOURNAL_VERSION = 'command-eve-project-journal/v1' as const;
export const PROJECT_UNDO_QUARANTINE_VERSION = 'command-eve-project-undo-quarantine/v1' as const;

export type ProjectLeaseV2 = {
  schema_version: typeof PROJECT_LEASE_VERSION;
  key_sha256: string;
  transaction_id: string;
  owner_token_sha256: string;
  lineage_owner_token_sha256: string;
  owner_pid: number;
  owner_process_nonce_sha256: string;
  acquired_at_ms: number;
  heartbeat_at_ms: number;
  expires_at_ms: number;
  released_at_ms: number | null;
};

export type ProjectJournalPhase =
  | 'planned'
  | 'leased'
  | 'preflighted'
  | 'semantic_staged'
  | 'staging'
  | 'staged'
  | 'promoted'
  | 'semantic_committed'
  | 'cataloged'
  | 'committed'
  | 'rollback_pending'
  | 'undo_quarantine_prepared'
  | 'undo_quarantining'
  | 'undo_quarantined'
  | 'undo_semantic_rolled_back'
  | 'undo_removal_committed'
  | 'recovery_required'
  | 'undone';

export type ProjectUndoQuarantineFileV1 = {
  relative_path: string;
  sha256: string;
  dev: number;
  ino: number;
  size: number;
};

export type ProjectUndoQuarantineDirectoryV1 = {
  relative_path: string;
  dev: number;
  ino: number;
};

export type ProjectUndoOriginV1 = 'provisioning-rollback' | 'committed-undo';

export type ProjectUndoCatalogProofV1 = {
  expected_revision: number;
  expected_record: ProjectCatalogRecord;
};

/**
 * A durable, path-relative ownership proof for two-phase project undo.
 * The effective quarantine path is always derived from the trusted project root's parent.
 */
export type ProjectUndoQuarantinePlanV1 = {
  schema_version: typeof PROJECT_UNDO_QUARANTINE_VERSION;
  transaction_id: string;
  origin: ProjectUndoOriginV1;
  mode: 'create-tree' | 'create-missing-root' | 'adopt-additions' | 'adopt-no-additions';
  quarantine_basename: string;
  receipt_relative_path: string | null;
  catalog_proof: ProjectUndoCatalogProofV1 | null;
  root_identity: { dev: number; ino: number } | null;
  quarantine_root_identity: { dev: number; ino: number } | null;
  quarantine_directories: ProjectUndoQuarantineDirectoryV1[];
  files: ProjectUndoQuarantineFileV1[];
  directories: ProjectUndoQuarantineDirectoryV1[];
};

export type ProjectTransactionJournalV1 = {
  schema_version: typeof PROJECT_JOURNAL_VERSION;
  transaction_id: string;
  conversation_id: string;
  operation: 'create' | 'adopt';
  phase: ProjectJournalPhase;
  identity: ProjectIdentityTuple;
  slug: string;
  staging_path: string;
  final_path: string;
  lease_path: string;
  owner_token_sha256: string;
  semantic_base_bundle_sha256?: string;
  semantic_bundle_sha256?: string;
  semantic_effect_plan_sha256?: string;
  semantic_initial_project_id?: string | null;
  semantic_initial_workspace_root_ref?: `root:${string}` | null;
  semantic_initial_project_binding_revision?: number;
  semantic_initial_project_binding_receipt_id?: string | null;
  semantic_preflight_receipt_id?: string;
  semantic_context_ref?: string;
  semantic_context_sha256?: string;
  proposed_domains_sha256?: string;
  undo_quarantine_plan?: ProjectUndoQuarantinePlanV1;
  created_files: Array<{ relative_path: string; sha256: string }>;
  created_directories: string[];
  created_at: string;
  updated_at: string;
  reason_code?: string;
};
