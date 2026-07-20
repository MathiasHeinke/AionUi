import type { ProjectIdentityTuple } from './identity';

export const PROJECT_LEASE_VERSION = 'command-eve-project-lease/v1' as const;
export const PROJECT_JOURNAL_VERSION = 'command-eve-project-journal/v1' as const;

export type ProjectLeaseV1 = {
  schema_version: typeof PROJECT_LEASE_VERSION;
  key_sha256: string;
  owner_token_sha256: string;
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
  | 'recovery_required'
  | 'undone';

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
  semantic_preflight_receipt_id?: string;
  semantic_context_ref?: string;
  semantic_context_sha256?: string;
  proposed_domains_sha256?: string;
  created_files: Array<{ relative_path: string; sha256: string }>;
  created_directories: string[];
  created_at: string;
  updated_at: string;
  reason_code?: string;
};
