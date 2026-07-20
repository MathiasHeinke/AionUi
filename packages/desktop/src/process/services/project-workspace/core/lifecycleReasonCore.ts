import {
  PROJECT_WORKSPACE_REASON_CODES,
  type ProjectWorkspaceReasonCode,
} from '@/common/types/project-workspace/reasonCodes';
import type { ProjectWorkspaceUiReasonCode } from '@/common/types/project-workspace/ui';

export type ProjectWorkspaceReasonEvidence = {
  /** True only when the durable operation record proves that no mutation began. */
  proven_precommit_no_delta?: boolean;
};

/**
 * Total, path-free mapping from internal domain failures to renderer-safe codes.
 * Callers must never forward the original error message or detail.
 */
export function mapProjectWorkspaceReason(
  reason: ProjectWorkspaceReasonCode,
  evidence: ProjectWorkspaceReasonEvidence = {}
): ProjectWorkspaceUiReasonCode {
  switch (reason) {
    case 'catalog.revision-conflict':
      return 'stale_snapshot';
    case 'catalog.project-conflict':
    case 'workspace.collision':
    case 'adoption.collision':
      return 'duplicate_project';
    case 'seat.changed':
      return 'seat_changed';
    case 'workspace.concurrent-operation':
    case 'workspace.lease-invalid':
      return 'workspace_locked';
    case 'root.overlap':
    case 'root.unowned':
    case 'adoption.root-unowned':
      return 'ownership_conflict';
    case 'root.project-overlap':
    case 'adoption.root-overlap':
      return 'nested_project';
    case 'adoption.foreign-ownership':
      return 'foreign_manifest';
    case 'adoption.manifest-corrupt':
      return 'corrupt_manifest';
    case 'schema.unsupported':
    case 'adoption.schema-unsupported':
      return 'newer_manifest_version';
    case 'workspace.lease-stale-unrecoverable':
    case 'workspace.journal-corrupt':
    case 'workspace.recovery-required':
    case 'workspace.undo-hash-mismatch':
      return 'recovery_required';
    case 'workspace.io-failed':
      return evidence.proven_precommit_no_delta ? 'transient_precommit_failure' : 'recovery_required';
    case 'root.not-found':
    case 'root.not-directory':
    case 'root.not-writable':
    case 'root.symlink':
    case 'root.migration-required':
    case 'root.escape':
    case 'adoption.symlink':
      return 'root_conflict';
    case 'semantic.preflight-rejected':
    case 'semantic.coordinator-required':
      return 'capability_failure';
    case 'identity.invalid':
    case 'schema.invalid':
    case 'schema.migration-context-required':
    case 'semantic.bundle-mismatch':
      return 'invariant_failure';
    case 'realm.not-found':
    case 'realm.archived':
      return 'root_conflict';
    case 'adoption.confirmation-required':
    case 'intent.disambiguate':
      return 'stale_snapshot';
    case 'auto-create.locked':
    case 'calibration.insufficient-sample':
    case 'calibration.false-positive':
    case 'calibration.metric-undefined':
    case 'calibration.threshold-not-met':
      return 'capability_failure';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function isKnownProjectWorkspaceReason(value: unknown): value is ProjectWorkspaceReasonCode {
  return typeof value === 'string' && (PROJECT_WORKSPACE_REASON_CODES as readonly string[]).includes(value);
}
