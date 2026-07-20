import type { ProjectWorkspaceAction, ProjectWorkspaceReasonCode } from './types';

export type ProjectWorkspaceReasonPresentation = {
  titleKey: `common.projects.reasons.${ProjectWorkspaceReasonCode}.title`;
  descriptionKey: `common.projects.reasons.${ProjectWorkspaceReasonCode}.description`;
  action: 'retry' | 'refresh' | 'recover' | 'choose_root' | 'repair' | 'contact_operator' | 'none';
};

const ACTION_BY_REASON: Record<ProjectWorkspaceReasonCode, ProjectWorkspaceReasonPresentation['action']> = {
  service_unavailable: 'refresh',
  workspace_locked: 'refresh',
  stale_snapshot: 'refresh',
  seat_changed: 'refresh',
  root_conflict: 'choose_root',
  ownership_conflict: 'choose_root',
  nested_project: 'choose_root',
  duplicate_project: 'refresh',
  foreign_manifest: 'repair',
  corrupt_manifest: 'repair',
  newer_manifest_version: 'contact_operator',
  recovery_required: 'recover',
  capability_failure: 'contact_operator',
  invariant_failure: 'contact_operator',
  transient_precommit_failure: 'retry',
};

export const getProjectWorkspaceReasonPresentation = (
  code: ProjectWorkspaceReasonCode
): ProjectWorkspaceReasonPresentation => ({
  titleKey: `common.projects.reasons.${code}.title`,
  descriptionKey: `common.projects.reasons.${code}.description`,
  action: ACTION_BY_REASON[code],
});

export const getProjectWorkspaceActionKey = (
  action: ProjectWorkspaceAction
): `common.projects.actions.${ProjectWorkspaceAction}` => `common.projects.actions.${action}`;
