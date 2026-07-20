/** Stable, user-safe reason codes for the Project Workspace domain. */
export const PROJECT_WORKSPACE_REASON_CODES = [
  'identity.invalid',
  'schema.invalid',
  'schema.unsupported',
  'schema.migration-context-required',
  'catalog.revision-conflict',
  'catalog.project-conflict',
  'realm.not-found',
  'realm.archived',
  'root.not-found',
  'root.not-directory',
  'root.not-writable',
  'root.symlink',
  'root.unowned',
  'root.overlap',
  'root.migration-required',
  'root.project-overlap',
  'root.escape',
  'seat.changed',
  'workspace.concurrent-operation',
  'workspace.lease-invalid',
  'workspace.lease-stale-unrecoverable',
  'workspace.collision',
  'workspace.journal-corrupt',
  'workspace.recovery-required',
  'workspace.undo-hash-mismatch',
  'workspace.io-failed',
  'semantic.preflight-rejected',
  'semantic.bundle-mismatch',
  'semantic.coordinator-required',
  'adoption.manifest-corrupt',
  'adoption.foreign-ownership',
  'adoption.schema-unsupported',
  'adoption.root-unowned',
  'adoption.root-overlap',
  'adoption.collision',
  'adoption.confirmation-required',
  'adoption.symlink',
  'intent.disambiguate',
  'auto-create.locked',
  'calibration.insufficient-sample',
  'calibration.false-positive',
  'calibration.metric-undefined',
  'calibration.threshold-not-met',
] as const;

export type ProjectWorkspaceReasonCode = (typeof PROJECT_WORKSPACE_REASON_CODES)[number];

export class ProjectWorkspaceError extends Error {
  readonly reason_code: ProjectWorkspaceReasonCode;

  constructor(reasonCode: ProjectWorkspaceReasonCode, detail?: string) {
    super(detail ? `${reasonCode}: ${detail}` : reasonCode);
    this.name = 'ProjectWorkspaceError';
    this.reason_code = reasonCode;
  }
}
