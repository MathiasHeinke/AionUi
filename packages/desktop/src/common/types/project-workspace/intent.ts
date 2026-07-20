import type { ProjectWorkspaceReasonCode } from './reasonCodes';

export type ProjectIntentAction = 'one_off' | 'continue_existing' | 'propose_create' | 'create' | 'disambiguate';

export type ImmutableProjectTargetSnapshot = {
  seat_id: string;
  realm_id: string;
  root_id: string;
  workspace_root_ref: `root:${string}`;
  realm_revision: number;
  root_revision: number;
  project_catalog_revision: number;
};

export type ExistingProjectCandidate = {
  project_id: string;
  seat_id: string;
  realm_id: string;
  root_id: string;
  workspace_root_ref: `root:${string}`;
  title: string;
  slug: string;
  status: 'active' | 'archived' | 'recovery_required';
};

export type ProposedDomain = { label: string; status: 'proposed' };

export type ProjectIntentRouterInput = {
  conversation_id: string;
  snapshot: ImmutableProjectTargetSnapshot;
  title: string;
  confidence: number;
  explicit_create: boolean;
  explicit_one_off: boolean;
  durable_signal_count: number;
  ambiguous_scope: boolean;
  sensitive_root_choice: boolean;
  auto_create_requested: boolean;
  candidates: ExistingProjectCandidate[];
  accepted_domain_ids: string[];
  proposed_domain_labels: string[];
  project_id?: string;
};

export type ProjectIntentPlan = {
  action: ProjectIntentAction;
  conversation_id: string;
  seat_id: string;
  realm_id: string;
  realm_label?: string;
  realm_path_slug?: string;
  root_id: string;
  project_id?: string;
  title: string;
  slug: string;
  domain_ids: string[];
  proposed_domains: ProposedDomain[];
  confidence: number;
  workspace_root_ref: `root:${string}`;
  existing_candidates: ExistingProjectCandidate[];
  needs_human_confirmation: boolean;
  question_count: 0 | 1;
  snapshot: ImmutableProjectTargetSnapshot;
  reason_code?: ProjectWorkspaceReasonCode;
};

export type CalibrationClass = ProjectIntentAction;

export type CalibrationReceiptV1 = {
  schema_version: 'command-eve-project-calibration/v1';
  dataset_version: string;
  router_version: string;
  policy_version: string;
  seat_id: string;
  evaluated_at: string;
  sample_size: number;
  class_counts: Record<CalibrationClass, number>;
  harmful_false_positive_count: number;
  false_positive_rate: number | undefined;
  false_positive_wilson_upper: number | undefined;
  create_precision: number | undefined;
  class_recall: Record<CalibrationClass, number | undefined>;
  abstention_rate: number | undefined;
  cao_verdict: 'PASS' | 'REJECT' | 'PARK';
  controller_gate: 'HG-2.5' | 'none';
};

export type CalibrationExpectation = {
  seat_id: string;
  dataset_version: string;
  router_version: string;
  policy_version: string;
};
