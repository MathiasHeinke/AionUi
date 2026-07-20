import { describe, expect, it } from 'vitest';
import { PROJECT_WORKSPACE_REASON_CODES } from '@/common/types/project-workspace/reasonCodes';
import {
  isKnownProjectWorkspaceReason,
  mapProjectWorkspaceReason,
} from '@/process/services/project-workspace/core/lifecycleReasonCore';

describe('project workspace lifecycle reason boundary', () => {
  it('maps every internal reason to a renderer-safe code', () => {
    for (const reason of PROJECT_WORKSPACE_REASON_CODES) {
      expect(mapProjectWorkspaceReason(reason)).toMatch(
        /^(service_unavailable|workspace_locked|stale_snapshot|seat_changed|root_conflict|ownership_conflict|nested_project|duplicate_project|foreign_manifest|corrupt_manifest|newer_manifest_version|recovery_required|capability_failure|invariant_failure|transient_precommit_failure)$/
      );
    }
  });

  it('allows retry only when durable evidence proves a precommit no-delta failure', () => {
    expect(mapProjectWorkspaceReason('workspace.io-failed')).toBe('recovery_required');
    expect(mapProjectWorkspaceReason('workspace.io-failed', { proven_precommit_no_delta: true })).toBe(
      'transient_precommit_failure'
    );
  });

  it('recognizes internal codes without accepting arbitrary error text', () => {
    expect(isKnownProjectWorkspaceReason('seat.changed')).toBe(true);
    expect(isKnownProjectWorkspaceReason('/Users/private/path')).toBe(false);
  });
});
