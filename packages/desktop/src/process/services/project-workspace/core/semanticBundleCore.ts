import crypto from 'node:crypto';
import {
  parseProjectId,
  parseWorkspaceRootRef,
  type ProjectIdentityTuple,
} from '@/common/types/project-workspace/identity';
import type { ProposedDomain } from '@/common/types/project-workspace/intent';
import type { ProjectManifestV1 } from '@/common/types/project-workspace/manifest';
import type { ProjectWorkspaceReasonCode } from '@/common/types/project-workspace/reasonCodes';
import { projectScaffoldFileContents, sha256Contents } from '../templates/scaffold';

export type ProjectSemanticStoreClass =
  | 'project-manifest'
  | 'project-wiki'
  | 'project-memory-bank'
  | 'project-index'
  | 'project-policy';

export type ProjectSemanticLocalWrite = {
  store_class: ProjectSemanticStoreClass;
  relative_path: string;
  contents: string;
  sha256: string;
};

export type ProjectSemanticBundleBinding = {
  base_bundle_sha256: string;
  bundle_sha256: string;
  effect_plan_sha256: string;
  initial_conversation_binding: {
    project_id: string;
    workspace_root_ref: `root:${string}`;
  } | null;
  initial_project_binding_revision: number;
  initial_project_binding_receipt_id: string | null;
  preflight_receipt_id: string;
  semantic_context_ref: string;
  semantic_context_sha256: string;
  proposed_domains_sha256: string;
};

export type ProjectSemanticPreflightInput = {
  operation: 'create' | 'adopt';
  transaction_id: string;
  conversation_id: string;
  identity: ProjectIdentityTuple;
  manifest: ProjectManifestV1;
  proposed_domains: readonly ProposedDomain[];
  proposed_domains_sha256: string;
  base_bundle_sha256: string;
  local_writes: readonly ProjectSemanticLocalWrite[];
};

export type ProjectSemanticPreflightResult =
  | {
      ok: true;
      extension_bundle_sha256: string;
      effect_plan_sha256: string;
      initial_conversation_binding: ProjectSemanticBundleBinding['initial_conversation_binding'];
      initial_project_binding_revision: number;
      initial_project_binding_receipt_id: string | null;
      preflight_receipt_id: string;
      semantic_context_ref: string;
      semantic_context_sha256: string;
    }
  | { ok: false; reason_code?: ProjectWorkspaceReasonCode };

export type ProjectSemanticStageInput = ProjectSemanticPreflightInput & {
  binding: ProjectSemanticBundleBinding;
  assert_mutation_allowed: () => void;
};

export type ProjectSemanticLifecycleInput = {
  operation: 'create' | 'adopt';
  transaction_id: string;
  conversation_id: string;
  identity: ProjectIdentityTuple;
  binding: ProjectSemanticBundleBinding;
  project_path: string;
  assert_mutation_allowed: () => void;
};

export type ProjectSemanticRemovalFinalizeInput = ProjectSemanticLifecycleInput & {
  /** Re-read the durable service journal and reject unless filesystem removal is committed. */
  assert_removal_committed: () => void;
};

export type ProjectSemanticCoordinator = {
  /** Pure boundary/meta validation. No sidecar, Brain, Wiki, index, or conversation mutation is allowed here. */
  preflight: (input: ProjectSemanticPreflightInput) => Promise<ProjectSemanticPreflightResult>;
  /** Atomically stage the strict-private context sidecar after PASS and before scaffold mutation. */
  stage: (input: ProjectSemanticStageInput) => Promise<void>;
  /** Idempotent by bundle/ref; load and verify the strict sidecar before every mutation. */
  commit: (input: ProjectSemanticLifecycleInput) => Promise<void>;
  /** Reconcile an interrupted commit from the strict sidecar; never infer a new bundle. */
  recover: (input: ProjectSemanticLifecycleInput) => Promise<void>;
  /** Remove only coordinator-owned, unchanged writes and the verified strict sidecar. */
  rollback: (input: ProjectSemanticLifecycleInput) => Promise<void>;
  /** Remove coordinator-owned effects while retaining the strict sidecar as the restart witness. */
  prepareRemovalRollback: (input: ProjectSemanticLifecycleInput) => Promise<void>;
  /** Reconcile removal idempotently and unlink the sidecar only after durable removal-commit proof. */
  finalizeRemovalRollback: (input: ProjectSemanticRemovalFinalizeInput) => Promise<void>;
};

function sha256Canonical(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function storeClass(relativePath: string): ProjectSemanticStoreClass {
  if (relativePath === '.command-eve/project.json') return 'project-manifest';
  if (relativePath.startsWith('docs/wiki/')) return 'project-wiki';
  if (relativePath.startsWith('memory-bank/')) return 'project-memory-bank';
  if (relativePath === 'AGENTS.md') return 'project-policy';
  return 'project-index';
}

function normalizeProposedDomains(values: unknown): ProposedDomain[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const byKey = new Map<string, ProposedDomain>();
  for (const candidate of values) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      (candidate as Partial<ProposedDomain>).status !== 'proposed' ||
      typeof (candidate as Partial<ProposedDomain>).label !== 'string'
    ) {
      return undefined;
    }
    const label = (candidate as ProposedDomain).label.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (
      label.length === 0 ||
      label.length > 120 ||
      [...label].some((character) => character.codePointAt(0)! <= 0x1f || character.codePointAt(0) === 0x7f)
    ) {
      return undefined;
    }
    const key = label.toLocaleLowerCase('en-US');
    if (!byKey.has(key)) byKey.set(key, { label, status: 'proposed' });
  }
  if (byKey.size > 64) return undefined;
  return [...byKey.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function validInitialConversationBinding(value: ProjectSemanticBundleBinding['initial_conversation_binding']): boolean {
  if (value === null) return true;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'project_id') ||
    !Object.hasOwn(value, 'workspace_root_ref')
  ) {
    return false;
  }
  try {
    parseProjectId(value.project_id);
    parseWorkspaceRootRef(value.workspace_root_ref);
    return true;
  } catch {
    return false;
  }
}

function validProjectBindingReceiptId(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
  );
}

export function buildProjectSemanticBaseBundle(
  manifest: ProjectManifestV1,
  context: {
    transaction_id: string;
    conversation_id: string;
    proposed_domains_sha256: string;
  },
  includedRelativePaths?: readonly string[]
): {
  base_bundle_sha256: string;
  local_writes: ProjectSemanticLocalWrite[];
} {
  const included = includedRelativePaths ? new Set(includedRelativePaths) : undefined;
  const localWrites = Object.entries(projectScaffoldFileContents(manifest))
    .filter(([relativePath]) => !included || included.has(relativePath))
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, contents]) => ({
      store_class: storeClass(relativePath),
      relative_path: relativePath,
      contents,
      sha256: sha256Contents(contents),
    }));
  const baseBundleSha256 = sha256Canonical({
    transaction_id: context.transaction_id,
    conversation_id: context.conversation_id,
    proposed_domains_sha256: context.proposed_domains_sha256,
    identity: {
      seat_id: manifest.seat_id,
      realm_id: manifest.realm_id,
      root_id: manifest.root_id,
      project_id: manifest.project_id,
      workspace_root_ref: manifest.workspace_root_ref,
    },
    title: manifest.title,
    domain_ids: manifest.domain_ids,
    local_writes: localWrites.map(({ store_class, relative_path, sha256 }) => ({
      store_class,
      relative_path,
      sha256,
    })),
  });
  return { base_bundle_sha256: baseBundleSha256, local_writes: localWrites };
}

export async function preflightProjectSemanticBundle(input: {
  operation: 'create' | 'adopt';
  transaction_id: string;
  conversation_id: string;
  identity: ProjectIdentityTuple;
  manifest: ProjectManifestV1;
  proposed_domains: readonly ProposedDomain[];
  coordinator?: ProjectSemanticCoordinator;
  included_relative_paths?: readonly string[];
}): Promise<
  | {
      ok: true;
      binding: ProjectSemanticBundleBinding;
      preflight_input: ProjectSemanticPreflightInput;
    }
  | { ok: false; reason_code: ProjectWorkspaceReasonCode }
> {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(input.conversation_id)) {
    return { ok: false, reason_code: 'identity.invalid' };
  }
  const proposedDomains = normalizeProposedDomains(input.proposed_domains);
  if (!proposedDomains) return { ok: false, reason_code: 'semantic.preflight-rejected' };
  const proposedDomainsSha256 = sha256Canonical(proposedDomains);
  const base = buildProjectSemanticBaseBundle(
    input.manifest,
    {
      transaction_id: input.transaction_id,
      conversation_id: input.conversation_id,
      proposed_domains_sha256: proposedDomainsSha256,
    },
    input.included_relative_paths
  );
  // A project manifest/title and its navigation templates are semantic, so there is no neutral bypass here.
  if (!input.coordinator) return { ok: false, reason_code: 'semantic.coordinator-required' };
  const preflightInput: ProjectSemanticPreflightInput = {
    operation: input.operation,
    transaction_id: input.transaction_id,
    conversation_id: input.conversation_id,
    identity: input.identity,
    manifest: input.manifest,
    proposed_domains: proposedDomains,
    proposed_domains_sha256: proposedDomainsSha256,
    base_bundle_sha256: base.base_bundle_sha256,
    local_writes: base.local_writes,
  };
  const result = await input.coordinator.preflight(preflightInput);
  if (result.ok === false) {
    return { ok: false, reason_code: result.reason_code ?? 'semantic.preflight-rejected' };
  }
  if (
    !/^[0-9a-f]{64}$/.test(result.extension_bundle_sha256) ||
    !/^[0-9a-f]{64}$/.test(result.effect_plan_sha256) ||
    !validInitialConversationBinding(result.initial_conversation_binding) ||
    !Number.isSafeInteger(result.initial_project_binding_revision) ||
    result.initial_project_binding_revision < 0 ||
    !validProjectBindingReceiptId(result.initial_project_binding_receipt_id) ||
    !/^[0-9a-f]{64}$/.test(result.semantic_context_sha256) ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(result.preflight_receipt_id) ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(result.semantic_context_ref)
  ) {
    return { ok: false, reason_code: 'semantic.preflight-rejected' };
  }
  const binding: ProjectSemanticBundleBinding = {
    base_bundle_sha256: base.base_bundle_sha256,
    bundle_sha256: sha256Canonical({
      base_bundle_sha256: base.base_bundle_sha256,
      extension_bundle_sha256: result.extension_bundle_sha256,
      effect_plan_sha256: result.effect_plan_sha256,
      initial_conversation_binding: result.initial_conversation_binding,
      initial_project_binding_revision: result.initial_project_binding_revision,
      initial_project_binding_receipt_id: result.initial_project_binding_receipt_id,
      preflight_receipt_id: result.preflight_receipt_id,
      semantic_context_ref: result.semantic_context_ref,
      semantic_context_sha256: result.semantic_context_sha256,
      proposed_domains_sha256: proposedDomainsSha256,
    }),
    effect_plan_sha256: result.effect_plan_sha256,
    initial_conversation_binding: result.initial_conversation_binding,
    initial_project_binding_revision: result.initial_project_binding_revision,
    initial_project_binding_receipt_id: result.initial_project_binding_receipt_id,
    preflight_receipt_id: result.preflight_receipt_id,
    semantic_context_ref: result.semantic_context_ref,
    semantic_context_sha256: result.semantic_context_sha256,
    proposed_domains_sha256: proposedDomainsSha256,
  };
  return { ok: true, binding, preflight_input: preflightInput };
}
