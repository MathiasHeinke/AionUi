/**
 * Renderer-safe Project Workspace transport contract.
 *
 * Main may use absolute paths, journals and capability material internally,
 * but none of those values are members of these DTOs or requests.
 */
export const PROJECT_WORKSPACE_UI_REASON_CODES = [
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

export type ProjectWorkspaceUiReasonCode = (typeof PROJECT_WORKSPACE_UI_REASON_CODES)[number];
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
  disabled_reason?: ProjectWorkspaceUiReasonCode;
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
  revision: number;
  recovery_state: ProjectWorkspaceRecoveryState;
  allowed_actions: ProjectWorkspaceAction[];
};

export type ProjectWorkspaceListDTO = {
  seat_label: string;
  seat_context_revision: number;
  automatic_creation_enabled: boolean;
  placements: ProjectPlacementDTO[];
  projects: ProjectSummaryDTO[];
  notice_reason?: ProjectWorkspaceUiReasonCode;
};

export type ProjectWorkspacePreviewDTO = {
  preview_id: string;
  preview_revision: number;
  destination_label: string;
  project_title: string;
  scaffold_summary: string[];
  semantic_writes: string[];
  conversation_effect: string;
  warnings: ProjectWorkspaceUiReasonCode[];
  expires_at: number;
};

export type ProjectWorkspaceReceiptDTO = {
  receipt_id: string;
  outcome: 'completed' | 'rejected' | 'recovery_required';
  completed_at: number;
  project?: ProjectSummaryDTO;
  reason_code?: ProjectWorkspaceUiReasonCode;
  safe_follow_ups: ProjectWorkspaceAction[];
};

export type ProjectWorkspaceArtifactState =
  'preview' | 'awaiting_confirmation' | 'committing' | 'completed' | 'rejected' | 'recovery_required';

/**
 * Reference to a renderer-owned i18n key plus interpolation params (1.818
 * CAO-P2). The main process never bakes locale-specific UI copy into DTOs;
 * it ships the key + params and an English raw fallback, and the renderer
 * localizes via its de/en i18n system. `string[]` param values are joined
 * renderer-side with the locale-appropriate list conjunction.
 */
export type ProjectWorkspaceI18nRef = {
  key: string;
  params?: Record<string, string | string[]>;
};

export type ProjectWorkspaceArtifactDTO = {
  artifact_id: string;
  state: ProjectWorkspaceArtifactState;
  project_id?: string;
  intent_summary: string;
  intent_summary_i18n?: ProjectWorkspaceI18nRef;
  target_label: string;
  project_title: string;
  delta_summary: string[];
  question?: string;
  question_i18n?: ProjectWorkspaceI18nRef;
  reason_code?: ProjectWorkspaceUiReasonCode;
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

export type ProjectWorkspaceMutationIdentity = {
  project_id: string;
  expected_revision: number;
  seat_context_revision: number;
  idempotency_key: string;
};

export type ProjectWorkspaceEnvelope<T> =
  { ok: true; data: T } | { ok: false; reason_code: ProjectWorkspaceUiReasonCode };

export type ProjectWorkspaceExplicitChatIntentRequest = {
  conversation_id: string;
  input: string;
  seat_context_revision: number;
  idempotency_key: string;
  /** Optional renderer wall-clock deadline (ms epoch). Main must not commit a binding after it. */
  deadline_ms?: number;
};

export type ProjectWorkspaceExplicitChatIntentResult =
  | { decision: 'pass_through' }
  | { decision: 'needs_clarification'; question: string; question_i18n?: ProjectWorkspaceI18nRef }
  | { decision: 'handled'; artifact_id: string };

/**
 * 1.820.4 post-turn auto-project outcome (MAT-1772). Strictly path-free: the
 * renderer learns THAT a project was provisioned/bound (or why not), never
 * where it lives. `noop` covers every ineligible turn (non-EVE, errored,
 * already-bound, custom/non-temporary workspace, missing durable title) —
 * eligibility is re-derived main-side, the renderer only transports the turn
 * hint `{ conversation_id, turn_id }` and can never assert it.
 */
export type ProjectWorkspaceEnsureAutoProjectRequest = {
  conversation_id: string;
  turn_id: string;
};

export type ProjectWorkspaceEnsureAutoProjectResult =
  | { status: 'created'; project_id: string; project_title: string }
  | { status: 'noop' }
  | { status: 'rejected'; reason_code: ProjectWorkspaceUiReasonCode };
