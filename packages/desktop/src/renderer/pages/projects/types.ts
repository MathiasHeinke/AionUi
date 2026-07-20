export const PROJECT_WORKSPACE_REASON_CODES = [
  'service_unavailable',
  'workspace_locked',
  'stale_snapshot',
  'seat_changed',
  'root_conflict',
  'ownership_conflict',
  'nested_project',
  'duplicate_project',
  'foreign_manifest',
  'corrupt_manifest',
  'newer_manifest_version',
  'recovery_required',
  'capability_failure',
  'invariant_failure',
  'transient_precommit_failure',
] as const;

export type ProjectWorkspaceReasonCode = (typeof PROJECT_WORKSPACE_REASON_CODES)[number];
export type ProjectWorkspaceRealmKind = 'private' | 'business' | 'custom';
export type ProjectWorkspaceStatus = 'active' | 'archived' | 'locked' | 'recovery_required';
export type ProjectWorkspaceRecoveryState = 'none' | 'available' | 'required';
export type ProjectWorkspaceAction = 'edit' | 'archive' | 'restore' | 'reveal' | 'recover' | 'undo' | 'bind' | 'unbind';

export type ProjectPlacementDTO = {
  placement_id: string;
  realm_kind: ProjectWorkspaceRealmKind;
  realm_label: string;
  root_label: string;
  writable: boolean;
  disabled_reason?: ProjectWorkspaceReasonCode;
};

export type ProjectSummaryDTO = {
  project_id: string;
  title: string;
  realm_kind: ProjectWorkspaceRealmKind;
  realm_label: string;
  root_label: string;
  status: ProjectWorkspaceStatus;
  last_safe_update: number;
  conversation_count: number;
  recovery_state: ProjectWorkspaceRecoveryState;
  revision: number;
  allowed_actions: ProjectWorkspaceAction[];
};

export type ProjectWorkspaceListDTO = {
  seat_label: string;
  seat_context_revision: number;
  automatic_creation_enabled: boolean;
  placements: ProjectPlacementDTO[];
  projects: ProjectSummaryDTO[];
  notice_reason?: ProjectWorkspaceReasonCode;
};

export type ProjectWorkspacePreviewDTO = {
  preview_id: string;
  preview_revision: number;
  destination_label: string;
  project_title: string;
  scaffold_summary: string[];
  semantic_writes: string[];
  conversation_effect: string;
  warnings: ProjectWorkspaceReasonCode[];
  expires_at: number;
};

export type ProjectWorkspaceReceiptDTO = {
  receipt_id: string;
  outcome: 'completed' | 'rejected' | 'recovery_required';
  completed_at: number;
  project?: ProjectSummaryDTO;
  reason_code?: ProjectWorkspaceReasonCode;
  safe_follow_ups: ProjectWorkspaceAction[];
};

export type ProjectWorkspaceArtifactState =
  | 'preview'
  | 'awaiting_confirmation'
  | 'committing'
  | 'completed'
  | 'rejected'
  | 'recovery_required';

export type ProjectWorkspaceArtifactDTO = {
  artifact_id: string;
  state: ProjectWorkspaceArtifactState;
  project_id?: string;
  intent_summary: string;
  target_label: string;
  project_title: string;
  delta_summary: string[];
  question?: string;
  reason_code?: ProjectWorkspaceReasonCode;
  receipt?: Pick<ProjectWorkspaceReceiptDTO, 'receipt_id' | 'outcome' | 'completed_at'>;
  safe_follow_ups: ProjectWorkspaceAction[];
};

export type ProjectWorkspaceConversationArtifactDTO = {
  id: string;
  conversation_id: string;
  kind: 'project_workspace';
  status: 'active';
  payload: ProjectWorkspaceArtifactDTO;
  created_at: number;
  updated_at: number;
};
