import type { ProjectIntentPlan } from '@/common/types/project-workspace/intent';
import { assertIdentityTuple, parseRealmId, parseRootId } from '@/common/types/project-workspace/identity';
import type { RealmCatalogV1, RootCatalogV1, ProjectCatalogV1 } from '@/common/types/project-workspace/registry';
import type { ProjectWorkspaceReasonCode } from '@/common/types/project-workspace/reasonCodes';

export type ProjectPreflightResult = { ok: true } | { ok: false; reason_code: ProjectWorkspaceReasonCode };

export function verifyImmutableTargetSnapshot(
  plan: ProjectIntentPlan,
  activeSeatId: string,
  catalogs: { realms: RealmCatalogV1; roots: RootCatalogV1; projects: ProjectCatalogV1 }
): ProjectPreflightResult {
  try {
    if (!plan.project_id) return { ok: false, reason_code: 'identity.invalid' };
    assertIdentityTuple({
      seat_id: plan.seat_id,
      realm_id: plan.realm_id,
      root_id: plan.root_id,
      project_id: plan.project_id,
      workspace_root_ref: plan.workspace_root_ref,
    });
    parseRealmId(plan.snapshot.realm_id);
    parseRootId(plan.snapshot.root_id);
  } catch {
    return { ok: false, reason_code: 'identity.invalid' };
  }
  if (activeSeatId !== plan.seat_id || plan.snapshot.seat_id !== plan.seat_id) {
    return { ok: false, reason_code: 'seat.changed' };
  }
  if (
    catalogs.realms.revision !== plan.snapshot.realm_revision ||
    catalogs.roots.revision !== plan.snapshot.root_revision ||
    catalogs.projects.revision !== plan.snapshot.project_catalog_revision
  ) {
    return { ok: false, reason_code: 'catalog.revision-conflict' };
  }
  const realm = catalogs.realms.realms.find((candidate) => candidate.realm_id === plan.realm_id);
  if (!realm) return { ok: false, reason_code: 'realm.not-found' };
  if (realm.status !== 'active') return { ok: false, reason_code: 'realm.archived' };
  const root = catalogs.roots.roots.find((candidate) => candidate.root_id === plan.root_id);
  if (!root) return { ok: false, reason_code: 'root.not-found' };
  if (root.status !== 'active' || root.workspace_root_ref !== plan.workspace_root_ref) {
    return { ok: false, reason_code: 'root.unowned' };
  }
  if (root.realm_id && root.realm_id !== plan.realm_id) return { ok: false, reason_code: 'root.unowned' };
  return { ok: true };
}
