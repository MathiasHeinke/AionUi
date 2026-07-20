import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseProjectId,
  parseRealmId,
  parseRootId,
  parseSeatId,
  parseTransactionId,
  parseWorkspaceRootRef,
  type ProjectId,
  type RealmId,
  type RootId,
  type WorkspaceRootRef,
} from '@/common/types/project-workspace/identity';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import {
  PROJECT_BRAIN_KIND,
  readBrainIndex,
  readEntryBody,
  recoverSystemEntryPromotion,
  removeExactSystemEntry,
  upsertSystemEntry,
  withCompanyBrainMutationLock,
} from '@process/commandEve/companyBrainStoreCore';
import { enforceMemoryBoundary, type MemoryBoundaryStore } from '@process/commandEve/memoryBoundaryContractCore';
import type {
  ProjectSemanticBundleBinding,
  ProjectSemanticCoordinator,
  ProjectSemanticLifecycleInput,
  ProjectSemanticPreflightInput,
  ProjectSemanticStageInput,
} from '../core/semanticBundleCore';
import { readJson, withExclusiveFileLock, writeFileCreateOnly, writeJsonAtomic } from '../storage/atomicJson';
import {
  ProjectBindingClientError,
  type PortableProjectBinding,
  type ProjectBindingSnapshot,
  type ProjectConversationBindingClient,
} from '../runtime/conversationBindingClient';

const SIDECAR_VERSION = 'command-eve-project-semantic-sidecar/v1' as const;
const PROPOSAL_QUEUE_VERSION = 'command-eve-project-domain-proposal-queue/v1' as const;
const EXTENSION_VERSION = 'command-eve-project-semantic-extension/v1' as const;
const NOOP_RELEASE = (): void => undefined;
const BRAIN_LOCK_MAX_ATTEMPTS = 100;
const BRAIN_LOCK_RETRY_MS = 10;
const brainOperationTails = new Map<string, Promise<void>>();

type ProjectBrainIdentity = {
  project_id: ProjectId;
  realm_id: RealmId;
  root_id: RootId;
  workspace_root_ref: WorkspaceRootRef;
};

type EffectStatus = 'planned' | 'applied';

type SemanticSidecar = {
  schema_version: typeof SIDECAR_VERSION;
  revision: number;
  context: ProjectSemanticPreflightInput;
  binding: ProjectSemanticBundleBinding;
  effects: {
    brain: {
      status: EffectStatus;
      entry_id: string;
      title: string;
      body: string;
      body_sha256: string;
      updated_at: string;
      created: boolean;
    };
    proposal_queue: {
      status: EffectStatus;
      record_sha256: string;
      created: boolean;
    };
    conversation_binding: {
      status: EffectStatus;
      expected: PortableProjectBinding | null;
      expected_revision: number;
      expected_receipt_id: string | null;
      next: PortableProjectBinding;
      next_revision: number;
      next_receipt_id: string | null;
      operation_id: string;
      owned: boolean;
    };
    llm_wiki: { status: 'unavailable' };
  };
};

type ProposalQueueRecord = {
  transaction_id: string;
  proposed_domains_sha256: string;
  record_sha256: string;
};

type ProposalQueue = {
  schema_version: typeof PROPOSAL_QUEUE_VERSION;
  revision: number;
  proposals: ProposalQueueRecord[];
};

export type ProjectSemanticCoordinatorOptions = {
  state_root: string;
  binding_client: ProjectConversationBindingClient;
  get_active_seat_id: () => string;
  resolve_hermes_home: (seatId: string) => string;
  now?: () => Date;
  on_phase?: (phase: string) => void;
};

export type ProjectSemanticOperationSerializer = {
  run: <T>(transactionId: string, operation: () => Promise<T>) => Promise<T>;
  active_count: () => number;
};

export function createProjectSemanticOperationSerializer(): ProjectSemanticOperationSerializer {
  const activeOperations = new Map<string, Promise<void>>();
  return {
    run: async <T>(transactionId: string, operation: () => Promise<T>): Promise<T> => {
      const previous = activeOperations.get(transactionId) ?? Promise.resolve();
      let release: () => void = NOOP_RELEASE;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = previous.then(() => current);
      activeOperations.set(transactionId, queued);
      await previous;
      try {
        return await operation();
      } finally {
        release();
        if (activeOperations.get(transactionId) === queued) activeOperations.delete(transactionId);
      }
    },
    active_count: () => activeOperations.size,
  };
}

async function withSemanticBrainLock<T>(
  hermesHome: string,
  assertMutationAllowed: () => void,
  operation: () => T
): Promise<T> {
  const queueKey = path.resolve(hermesHome);
  const previous = brainOperationTails.get(queueKey) ?? Promise.resolve();
  let release: () => void = NOOP_RELEASE;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  brainOperationTails.set(queueKey, queued);
  await previous;
  try {
    for (let attempt = 0; attempt < BRAIN_LOCK_MAX_ATTEMPTS; attempt += 1) {
      assertMutationAllowed();
      try {
        return withCompanyBrainMutationLock(queueKey, operation);
      } catch (error) {
        if (
          !(error instanceof ProjectWorkspaceError) ||
          error.reason_code !== 'workspace.concurrent-operation' ||
          attempt === BRAIN_LOCK_MAX_ATTEMPTS - 1
        ) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, BRAIN_LOCK_RETRY_MS));
      }
    }
    throw new ProjectWorkspaceError('workspace.concurrent-operation');
  } finally {
    release();
    if (brainOperationTails.get(queueKey) === queued) brainOperationTails.delete(queueKey);
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(record: object, expected: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key));
}

function validEffectStatus(status: unknown): status is EffectStatus {
  return status === 'planned' || status === 'applied';
}

function expectedExtensionSha256(): string {
  return hashJson({
    schema_version: EXTENSION_VERSION,
    boundary_stores: ['project-memory-bank', 'project-wiki'],
    brain_kind: PROJECT_BRAIN_KIND,
    proposal_queue: 'hash-only-cas',
    llm_wiki: 'optional-unavailable',
  });
}

function expectedBundleSha256(baseBundleSha256: string, binding: ProjectSemanticBundleBinding): string {
  return hashJson({
    base_bundle_sha256: baseBundleSha256,
    extension_bundle_sha256: expectedExtensionSha256(),
    effect_plan_sha256: binding.effect_plan_sha256,
    initial_conversation_binding: binding.initial_conversation_binding,
    initial_project_binding_revision: binding.initial_project_binding_revision,
    initial_project_binding_receipt_id: binding.initial_project_binding_receipt_id,
    preflight_receipt_id: binding.preflight_receipt_id,
    semantic_context_ref: binding.semantic_context_ref,
    semantic_context_sha256: binding.semantic_context_sha256,
    proposed_domains_sha256: binding.proposed_domains_sha256,
  });
}

function effectPlan(
  context: ProjectSemanticPreflightInput,
  initialConversationBinding: PortableProjectBinding | null,
  initialProjectBindingRevision: number,
  initialProjectBindingReceiptId: string | null
): {
  brain: { entry_id: string; title: string; body: string; body_sha256: string; created: true };
  proposal_queue: { record_sha256: string; created: true };
  conversation_binding: {
    expected: PortableProjectBinding | null;
    expected_revision: number;
    expected_receipt_id: string | null;
    next: PortableProjectBinding;
    next_revision: number;
    next_receipt_id: string | null;
    operation_id: string;
  };
  llm_wiki: { status: 'unavailable' };
} {
  const identity = typedBrainIdentity(context);
  const body = projectBrainBody(identity);
  const nextBinding: PortableProjectBinding = {
    project_id: identity.project_id,
    workspace_root_ref: identity.workspace_root_ref,
  };
  const pairChanges = !same(initialConversationBinding, nextBinding);
  if (
    !Number.isSafeInteger(initialProjectBindingRevision) ||
    initialProjectBindingRevision < 0 ||
    !(
      initialProjectBindingReceiptId === null ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(initialProjectBindingReceiptId)
    ) ||
    (pairChanges && initialProjectBindingRevision === Number.MAX_SAFE_INTEGER)
  ) {
    throw new ProjectWorkspaceError('semantic.bundle-mismatch');
  }
  return {
    brain: {
      entry_id: `project-${identity.project_id}`,
      title: context.manifest.title,
      body,
      body_sha256: sha256(`${body.replace(/\s+$/, '')}\n`),
      created: true,
    },
    proposal_queue: {
      record_sha256: hashJson({
        transaction_id: context.transaction_id,
        proposed_domains_sha256: context.proposed_domains_sha256,
      }),
      created: true,
    },
    conversation_binding: {
      expected: initialConversationBinding,
      expected_revision: initialProjectBindingRevision,
      expected_receipt_id: initialProjectBindingReceiptId,
      next: nextBinding,
      next_revision: initialProjectBindingRevision + (pairChanges ? 1 : 0),
      next_receipt_id: pairChanges ? context.transaction_id : initialProjectBindingReceiptId,
      operation_id: context.transaction_id,
    },
    llm_wiki: { status: 'unavailable' },
  };
}

function expectedEffectPlanSha256(
  context: ProjectSemanticPreflightInput,
  initialConversationBinding: PortableProjectBinding | null,
  initialProjectBindingRevision: number,
  initialProjectBindingReceiptId: string | null
): string {
  return hashJson(
    effectPlan(context, initialConversationBinding, initialProjectBindingRevision, initialProjectBindingReceiptId)
  );
}

function typedBrainIdentity(input: ProjectSemanticPreflightInput): ProjectBrainIdentity {
  const projectId = parseProjectId(input.identity.project_id);
  const realmId = parseRealmId(input.identity.realm_id);
  const rootId = parseRootId(input.identity.root_id);
  const workspaceRootRef = parseWorkspaceRootRef(input.identity.workspace_root_ref);
  if (workspaceRootRef !== `root:${rootId}`) throw new ProjectWorkspaceError('identity.invalid');
  return {
    project_id: projectId,
    realm_id: realmId,
    root_id: rootId,
    workspace_root_ref: workspaceRootRef,
  };
}

function projectBrainBody(identity: ProjectBrainIdentity): string {
  return [
    '# Project',
    '',
    'Manifest ref: .command-eve/project.json',
    `Project ID: ${identity.project_id}`,
    `Realm ID: ${identity.realm_id}`,
    `Root ID: ${identity.root_id}`,
    `Workspace root ref: ${identity.workspace_root_ref}`,
    '',
  ].join('\n');
}

function boundaryStore(relativePath: string): MemoryBoundaryStore {
  return relativePath.startsWith('docs/wiki/') ? 'project-wiki' : 'project-memory-bank';
}

function assertSemanticPreflight(input: ProjectSemanticPreflightInput, activeSeatId: string): void {
  if (parseTransactionId(input.transaction_id) !== input.transaction_id) {
    throw new ProjectWorkspaceError('identity.invalid');
  }
  const seatId = parseSeatId(input.identity.seat_id);
  if (seatId !== activeSeatId || input.manifest.seat_id !== seatId) throw new ProjectWorkspaceError('seat.changed');
  typedBrainIdentity(input);
  if (input.proposed_domains_sha256 !== hashJson(input.proposed_domains)) {
    throw new ProjectWorkspaceError('semantic.bundle-mismatch');
  }
  for (const write of input.local_writes) {
    if (sha256(write.contents) !== write.sha256) throw new ProjectWorkspaceError('semantic.bundle-mismatch');
    const decision = enforceMemoryBoundary({
      operation: 'write',
      store: boundaryStore(write.relative_path),
      activeSeatId,
      targetSeatId: seatId,
      payloadText: write.contents,
      egress: 'local-only',
    });
    if (!decision.ok) throw new ProjectWorkspaceError('semantic.preflight-rejected');
  }
  const brainDecision = enforceMemoryBoundary({
    operation: 'write',
    store: 'company-brain',
    activeSeatId,
    targetSeatId: seatId,
    payloadText: projectBrainBody(typedBrainIdentity(input)),
    egress: 'local-only',
  });
  if (!brainDecision.ok) throw new ProjectWorkspaceError('semantic.preflight-rejected');
}

function parseQueue(value: unknown): ProposalQueue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectWorkspaceError('schema.invalid');
  const record = value as Record<string, unknown>;
  if (
    record.schema_version !== PROPOSAL_QUEUE_VERSION ||
    typeof record.revision !== 'number' ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    !Array.isArray(record.proposals)
  ) {
    throw new ProjectWorkspaceError('schema.invalid');
  }
  const proposals = record.proposals.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new ProjectWorkspaceError('schema.invalid');
    }
    const item = candidate as Record<string, unknown>;
    if (
      Object.keys(item).length !== 3 ||
      typeof item.transaction_id !== 'string' ||
      typeof item.proposed_domains_sha256 !== 'string' ||
      typeof item.record_sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.proposed_domains_sha256) ||
      !/^[0-9a-f]{64}$/.test(item.record_sha256)
    ) {
      throw new ProjectWorkspaceError('schema.invalid');
    }
    parseTransactionId(item.transaction_id);
    const expectedHash = hashJson({
      transaction_id: item.transaction_id,
      proposed_domains_sha256: item.proposed_domains_sha256,
    });
    if (expectedHash !== item.record_sha256) throw new ProjectWorkspaceError('schema.invalid');
    return item as ProposalQueueRecord;
  });
  return { schema_version: PROPOSAL_QUEUE_VERSION, revision: record.revision, proposals };
}

function parseSidecar(value: unknown): SemanticSidecar {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProjectWorkspaceError('semantic.bundle-mismatch');
  const candidate = value as SemanticSidecar;
  if (
    !exactKeys(candidate, ['schema_version', 'revision', 'context', 'binding', 'effects']) ||
    candidate.schema_version !== SIDECAR_VERSION ||
    !Number.isSafeInteger(candidate.revision) ||
    candidate.revision < 0 ||
    !candidate.context ||
    !candidate.binding ||
    !candidate.effects ||
    candidate.effects.llm_wiki?.status !== 'unavailable'
  ) {
    throw new ProjectWorkspaceError('semantic.bundle-mismatch');
  }
  assertSemanticPreflight(candidate.context, candidate.context.identity.seat_id);
  parseTransactionId(candidate.context.transaction_id);
  const binding = candidate.binding;
  if (
    !exactKeys(binding, [
      'base_bundle_sha256',
      'bundle_sha256',
      'effect_plan_sha256',
      'initial_conversation_binding',
      'initial_project_binding_revision',
      'initial_project_binding_receipt_id',
      'preflight_receipt_id',
      'semantic_context_ref',
      'semantic_context_sha256',
      'proposed_domains_sha256',
    ]) ||
    ![binding.base_bundle_sha256, binding.bundle_sha256, binding.effect_plan_sha256].every((hash) =>
      /^[0-9a-f]{64}$/.test(hash)
    ) ||
    !Number.isSafeInteger(binding.initial_project_binding_revision) ||
    binding.initial_project_binding_revision < 0 ||
    !(
      binding.initial_project_binding_receipt_id === null ||
      (typeof binding.initial_project_binding_receipt_id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          binding.initial_project_binding_receipt_id
        ))
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(binding.preflight_receipt_id) ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(binding.semantic_context_ref) ||
    !/^[0-9a-f]{64}$/.test(binding.semantic_context_sha256) ||
    !/^[0-9a-f]{64}$/.test(binding.proposed_domains_sha256)
  ) {
    throw new ProjectWorkspaceError('semantic.bundle-mismatch');
  }
  const plan = effectPlan(
    candidate.context,
    binding.initial_conversation_binding,
    binding.initial_project_binding_revision,
    binding.initial_project_binding_receipt_id
  );
  const effects = candidate.effects;
  const brain = effects.brain;
  const proposal = effects.proposal_queue;
  const conversation = effects.conversation_binding;
  if (
    !same(binding.initial_conversation_binding, plan.conversation_binding.expected) ||
    (binding.initial_conversation_binding !== null &&
      !same(binding.initial_conversation_binding, plan.conversation_binding.next)) ||
    binding.effect_plan_sha256 !== hashJson(plan) ||
    binding.semantic_context_sha256 !== hashJson(candidate.context) ||
    binding.proposed_domains_sha256 !== candidate.context.proposed_domains_sha256 ||
    binding.base_bundle_sha256 !== candidate.context.base_bundle_sha256 ||
    binding.preflight_receipt_id !== `project-semantic-v1-${candidate.context.transaction_id}` ||
    binding.semantic_context_ref !== `project-semantic-${candidate.context.transaction_id}` ||
    binding.bundle_sha256 !== expectedBundleSha256(candidate.context.base_bundle_sha256, binding) ||
    !exactKeys(effects, ['brain', 'proposal_queue', 'conversation_binding', 'llm_wiki']) ||
    !exactKeys(brain, ['status', 'entry_id', 'title', 'body', 'body_sha256', 'updated_at', 'created']) ||
    !validEffectStatus(brain.status) ||
    brain.entry_id !== plan.brain.entry_id ||
    brain.title !== plan.brain.title ||
    brain.body !== plan.brain.body ||
    brain.body_sha256 !== plan.brain.body_sha256 ||
    brain.created !== true ||
    typeof brain.updated_at !== 'string' ||
    new Date(brain.updated_at).toISOString() !== brain.updated_at ||
    !exactKeys(proposal, ['status', 'record_sha256', 'created']) ||
    !validEffectStatus(proposal.status) ||
    proposal.record_sha256 !== plan.proposal_queue.record_sha256 ||
    proposal.created !== true ||
    !exactKeys(conversation, [
      'status',
      'expected',
      'expected_revision',
      'expected_receipt_id',
      'next',
      'next_revision',
      'next_receipt_id',
      'operation_id',
      'owned',
    ]) ||
    !validEffectStatus(conversation.status) ||
    !same(conversation.expected, plan.conversation_binding.expected) ||
    conversation.expected_revision !== plan.conversation_binding.expected_revision ||
    conversation.expected_receipt_id !== plan.conversation_binding.expected_receipt_id ||
    !same(conversation.next, plan.conversation_binding.next) ||
    conversation.next_revision !== plan.conversation_binding.next_revision ||
    conversation.next_receipt_id !== plan.conversation_binding.next_receipt_id ||
    conversation.operation_id !== plan.conversation_binding.operation_id ||
    conversation.owned !==
      (conversation.status === 'applied' &&
        plan.conversation_binding.expected_revision !== plan.conversation_binding.next_revision) ||
    !exactKeys(effects.llm_wiki, ['status']) ||
    effects.llm_wiki.status !== 'unavailable'
  ) {
    throw new ProjectWorkspaceError('semantic.bundle-mismatch');
  }
  const statuses = [brain.status, proposal.status, conversation.status];
  const appliedCount = statuses.filter((status) => status === 'applied').length;
  if (
    candidate.revision !== appliedCount ||
    statuses.some((status, index) => status === 'applied' && statuses.slice(0, index).includes('planned'))
  ) {
    throw new ProjectWorkspaceError('semantic.bundle-mismatch');
  }
  return candidate;
}

export function createProjectSemanticCoordinator(
  options: ProjectSemanticCoordinatorOptions
): ProjectSemanticCoordinator {
  const stateRoot = path.resolve(options.state_root);
  const now = options.now ?? (() => new Date());
  const sidecarDirectory = path.join(stateRoot, 'semantic-sidecars');
  const queueFile = path.join(stateRoot, 'domain-proposals', 'queue.json');
  const sidecarFile = (transactionId: string): string => path.join(sidecarDirectory, `${transactionId}.json`);
  const sidecarLock = (transactionId: string): string => `${sidecarFile(transactionId)}.lock`;
  const queueLock = `${queueFile}.lock`;
  const operationSerializer = createProjectSemanticOperationSerializer();
  const serialized = operationSerializer.run;

  // A conversation that does not exist (yet) has no binding state. UI-driven
  // creates use a synthetic conversation id unknown to the backend, so a
  // NOT_FOUND read must resolve to the null snapshot instead of rejecting the
  // whole create (live dev-app proof caught this as a preflight capability
  // failure). Real backend failures (401/5xx/network) still throw.
  const readBindingSnapshotOrNull = async (conversationId: string): Promise<ProjectBindingSnapshot> => {
    try {
      return await options.binding_client.read(conversationId);
    } catch (error) {
      if (error instanceof ProjectBindingClientError && error.code === 'NOT_FOUND') {
        return { binding: null, project_binding_revision: 0, project_binding_receipt_id: null };
      }
      throw error;
    }
  };

  const readSidecar = (transactionId: string): SemanticSidecar => {
    try {
      return parseSidecar(readJson(sidecarFile(transactionId)));
    } catch (error) {
      if (error instanceof ProjectWorkspaceError) throw error;
      throw new ProjectWorkspaceError('semantic.bundle-mismatch');
    }
  };

  const verifyLifecycle = (sidecar: SemanticSidecar, input: ProjectSemanticLifecycleInput): void => {
    input.assert_mutation_allowed();
    if (
      sidecar.context.transaction_id !== input.transaction_id ||
      sidecar.context.conversation_id !== input.conversation_id ||
      !same(sidecar.context.identity, input.identity) ||
      !same(sidecar.binding, input.binding) ||
      options.get_active_seat_id() !== input.identity.seat_id
    ) {
      throw new ProjectWorkspaceError('semantic.bundle-mismatch');
    }
  };

  const updateSidecar = (
    transactionId: string,
    expectedRevision: number,
    assertMutationAllowed: () => void,
    mutate: (current: SemanticSidecar) => SemanticSidecar
  ): SemanticSidecar =>
    withExclusiveFileLock(sidecarLock(transactionId), () => {
      const current = readSidecar(transactionId);
      if (current.revision !== expectedRevision) throw new ProjectWorkspaceError('catalog.revision-conflict');
      const next = mutate(current);
      options.on_phase?.('sidecar:before-write');
      assertMutationAllowed();
      writeJsonAtomic(sidecarFile(transactionId), { ...next, revision: expectedRevision + 1 });
      return readSidecar(transactionId);
    });

  const readQueue = (): ProposalQueue => {
    if (!fs.existsSync(queueFile)) return { schema_version: PROPOSAL_QUEUE_VERSION, revision: 0, proposals: [] };
    return parseQueue(readJson(queueFile));
  };

  const applyQueue = (sidecar: SemanticSidecar, assertMutationAllowed: () => void): boolean =>
    withExclusiveFileLock(queueLock, () => {
      const queue = readQueue();
      const effect = sidecar.effects.proposal_queue;
      const existing = queue.proposals.find((record) => record.transaction_id === sidecar.context.transaction_id);
      if (existing) {
        if (existing.record_sha256 !== effect.record_sha256)
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        return false;
      }
      const record: ProposalQueueRecord = {
        transaction_id: sidecar.context.transaction_id,
        proposed_domains_sha256: sidecar.context.proposed_domains_sha256,
        record_sha256: effect.record_sha256,
      };
      options.on_phase?.('proposal-queue:before-write');
      assertMutationAllowed();
      writeJsonAtomic(queueFile, {
        schema_version: PROPOSAL_QUEUE_VERSION,
        revision: queue.revision + 1,
        proposals: [...queue.proposals, record].toSorted((left, right) =>
          left.transaction_id.localeCompare(right.transaction_id)
        ),
      } satisfies ProposalQueue);
      return true;
    });

  const removeQueue = (sidecar: SemanticSidecar, assertMutationAllowed: () => void): void => {
    withExclusiveFileLock(queueLock, () => {
      const queue = readQueue();
      const existing = queue.proposals.find((record) => record.transaction_id === sidecar.context.transaction_id);
      if (!existing) return;
      if (existing.record_sha256 !== sidecar.effects.proposal_queue.record_sha256) {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      options.on_phase?.('rollback:proposal-queue:before-write');
      assertMutationAllowed();
      writeJsonAtomic(queueFile, {
        schema_version: PROPOSAL_QUEUE_VERSION,
        revision: queue.revision + 1,
        proposals: queue.proposals.filter((record) => record.transaction_id !== sidecar.context.transaction_id),
      } satisfies ProposalQueue);
    });
  };

  const brainMatches = (sidecar: SemanticSidecar, hermesHome: string): boolean => {
    const effect = sidecar.effects.brain;
    const entry = readBrainIndex(hermesHome).entries.find((candidate) => candidate.id === effect.entry_id);
    const body = readEntryBody(hermesHome, effect.entry_id);
    return (
      entry?.kind === PROJECT_BRAIN_KIND &&
      entry.title === effect.title &&
      entry.updated_at === effect.updated_at &&
      entry.author === 'eve' &&
      entry.source === 'chat' &&
      body !== null &&
      sha256(body) === effect.body_sha256
    );
  };

  const brainOwnershipState = (sidecar: SemanticSidecar, hermesHome: string): 'owned' | 'absent' | 'mismatch' => {
    const effect = sidecar.effects.brain;
    const entry = readBrainIndex(hermesHome).entries.find((candidate) => candidate.id === effect.entry_id);
    const body = readEntryBody(hermesHome, effect.entry_id);
    if (!entry && body === null) return 'absent';
    const metadataMatches =
      entry?.kind === PROJECT_BRAIN_KIND &&
      entry.title === effect.title &&
      entry.updated_at === effect.updated_at &&
      entry.author === 'eve' &&
      entry.source === 'chat';
    if (metadataMatches && (body === null || sha256(body) === effect.body_sha256)) return 'owned';
    return 'mismatch';
  };

  const commit = async (input: ProjectSemanticLifecycleInput): Promise<void> =>
    serialized(input.transaction_id, async () => {
      let sidecar = readSidecar(input.transaction_id);
      verifyLifecycle(sidecar, input);
      const hermesHome = options.resolve_hermes_home(input.identity.seat_id);
      if (sidecar.effects.brain.status === 'planned') {
        sidecar = await withSemanticBrainLock(hermesHome, input.assert_mutation_allowed, () => {
          const current = readSidecar(input.transaction_id);
          verifyLifecycle(current, input);
          const brainEffect = current.effects.brain;
          if (brainEffect.status === 'applied') return current;
          if (!brainMatches(current, hermesHome)) {
            const existing = readBrainIndex(hermesHome).entries.find((entry) => entry.id === brainEffect.entry_id);
            if (existing) {
              options.on_phase?.('brain:before-recover');
              input.assert_mutation_allowed();
              const recovered = recoverSystemEntryPromotion(hermesHome, {
                id: brainEffect.entry_id,
                kind: PROJECT_BRAIN_KIND,
                title: brainEffect.title,
                body: brainEffect.body,
                author: 'eve',
                source: 'chat',
                updated_at: brainEffect.updated_at,
              });
              if (!recovered || !brainMatches(current, hermesHome)) {
                throw new ProjectWorkspaceError('semantic.bundle-mismatch');
              }
            } else {
              options.on_phase?.('brain:before-write');
              input.assert_mutation_allowed();
              const written = upsertSystemEntry(hermesHome, {
                id: brainEffect.entry_id,
                kind: PROJECT_BRAIN_KIND,
                title: brainEffect.title,
                body: brainEffect.body,
                author: 'eve',
                source: 'chat',
                now: () => new Date(brainEffect.updated_at),
              });
              if (!written.created || !brainMatches(current, hermesHome)) {
                throw new ProjectWorkspaceError('semantic.bundle-mismatch');
              }
              options.on_phase?.('brain:written');
            }
          }
          return updateSidecar(input.transaction_id, current.revision, input.assert_mutation_allowed, (latest) => ({
            ...latest,
            effects: { ...latest.effects, brain: { ...latest.effects.brain, status: 'applied' } },
          }));
        });
      }

      if (sidecar.effects.proposal_queue.status === 'planned') {
        applyQueue(sidecar, input.assert_mutation_allowed);
        options.on_phase?.('proposal-queue:written');
        sidecar = updateSidecar(input.transaction_id, sidecar.revision, input.assert_mutation_allowed, (current) => ({
          ...current,
          effects: {
            ...current.effects,
            proposal_queue: { ...current.effects.proposal_queue, status: 'applied' },
          },
        }));
      }

      const bindingEffect = sidecar.effects.conversation_binding;
      if (bindingEffect.status === 'planned') {
        input.assert_mutation_allowed();
        const observed = await readBindingSnapshotOrNull(input.conversation_id);
        input.assert_mutation_allowed();
        const pairChanges = !same(bindingEffect.expected, bindingEffect.next);
        let owned = false;
        if (
          same(observed.binding, bindingEffect.next) &&
          observed.project_binding_revision === bindingEffect.next_revision &&
          observed.project_binding_receipt_id === bindingEffect.next_receipt_id
        ) {
          owned = pairChanges;
        } else if (
          same(observed.binding, bindingEffect.expected) &&
          observed.project_binding_revision === bindingEffect.expected_revision &&
          observed.project_binding_receipt_id === bindingEffect.expected_receipt_id
        ) {
          options.on_phase?.('conversation-binding:before-cas');
          input.assert_mutation_allowed();
          try {
            await options.binding_client.compareAndSwap({
              conversation_id: input.conversation_id,
              expected: bindingEffect.expected,
              expected_project_binding_revision: bindingEffect.expected_revision,
              expected_project_binding_receipt_id: bindingEffect.expected_receipt_id,
              project_binding_operation_id: bindingEffect.operation_id,
              next: bindingEffect.next,
            });
            owned = pairChanges;
            options.on_phase?.('conversation-binding:written');
          } catch (error) {
            // Binding a conversation that does not exist (e.g. the synthetic
            // UI conversation id) is a no-op, not a commit failure: the project
            // must still commit. Live dev-app proof caught this 404 rolling
            // back fully promoted projects.
            if (error instanceof ProjectBindingClientError && error.code === 'NOT_FOUND') {
              // The desired end state (no binding anywhere, project committed)
              // IS achieved, so the effect is owned exactly like a written CAS.
              // parseSidecar enforces owned === (applied && revisions differ);
              // leaving owned=false here wedges the transaction into a
              // permanently invalid sidecar (live dev-app proof).
              owned = pairChanges;
              options.on_phase?.('conversation-binding:skipped-not-found');
            } else {
              throw error;
            }
          }
        } else {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        input.assert_mutation_allowed();
        sidecar = updateSidecar(input.transaction_id, sidecar.revision, input.assert_mutation_allowed, (current) => ({
          ...current,
          effects: {
            ...current.effects,
            conversation_binding: { ...current.effects.conversation_binding, status: 'applied', owned },
          },
        }));
      }
    });

  const rollbackEffects = async (
    input: ProjectSemanticLifecycleInput,
    unlinkSidecar: boolean,
    assertRemovalCommitted?: () => void
  ): Promise<void> => {
    if (!fs.existsSync(sidecarFile(input.transaction_id))) return;
    let sidecar = readSidecar(input.transaction_id);
    verifyLifecycle(sidecar, input);
    const hermesHome = options.resolve_hermes_home(input.identity.seat_id);
    if (sidecar.effects.brain.created) {
      sidecar = await withSemanticBrainLock(hermesHome, input.assert_mutation_allowed, () => {
        const current = readSidecar(input.transaction_id);
        verifyLifecycle(current, input);
        if (brainOwnershipState(current, hermesHome) === 'mismatch') {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        return current;
      });
    }
    const bindingEffect = sidecar.effects.conversation_binding;
    const currentBinding = await readBindingSnapshotOrNull(input.conversation_id);
    input.assert_mutation_allowed();
    const bindingPairChanged = !same(bindingEffect.expected, bindingEffect.next);
    if (bindingPairChanged && same(currentBinding.binding, bindingEffect.next)) {
      if (
        currentBinding.project_binding_revision !== bindingEffect.next_revision ||
        currentBinding.project_binding_receipt_id !== bindingEffect.next_receipt_id
      ) {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      options.on_phase?.('rollback:conversation-binding:before-cas');
      input.assert_mutation_allowed();
      await options.binding_client.compareAndSwap({
        conversation_id: input.conversation_id,
        expected: bindingEffect.next,
        expected_project_binding_revision: bindingEffect.next_revision,
        expected_project_binding_receipt_id: bindingEffect.next_receipt_id,
        project_binding_operation_id: bindingEffect.operation_id,
        next: bindingEffect.expected,
      });
      options.on_phase?.('rollback:conversation-binding');
    }
    if (sidecar.effects.proposal_queue.created) {
      removeQueue(sidecar, input.assert_mutation_allowed);
      options.on_phase?.('rollback:proposal-queue');
    }
    if (sidecar.effects.brain.created) {
      await withSemanticBrainLock(hermesHome, input.assert_mutation_allowed, () => {
        const current = readSidecar(input.transaction_id);
        verifyLifecycle(current, input);
        const brainState = brainOwnershipState(current, hermesHome);
        if (brainState === 'mismatch') throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        if (brainState === 'owned') {
          options.on_phase?.('rollback:brain:before-remove');
          input.assert_mutation_allowed();
          const removed = removeExactSystemEntry(hermesHome, {
            id: current.effects.brain.entry_id,
            kind: PROJECT_BRAIN_KIND,
            title: current.effects.brain.title,
            body: current.effects.brain.body,
            author: 'eve',
            source: 'chat',
            updated_at: current.effects.brain.updated_at,
          });
          if (!removed.ok || (!removed.removed && !removed.already_absent)) {
            throw new ProjectWorkspaceError('semantic.bundle-mismatch');
          }
          options.on_phase?.('rollback:brain');
        }
      });
    }
    if (!unlinkSidecar) return;
    options.on_phase?.('rollback:before-sidecar-unlink');
    input.assert_mutation_allowed();
    assertRemovalCommitted?.();
    withExclusiveFileLock(sidecarLock(input.transaction_id), () => {
      const current = readSidecar(input.transaction_id);
      verifyLifecycle(current, input);
      input.assert_mutation_allowed();
      assertRemovalCommitted?.();
      fs.unlinkSync(sidecarFile(input.transaction_id));
    });
  };

  return {
    preflight: async (input) => {
      try {
        assertSemanticPreflight(input, options.get_active_seat_id());
        const identity = typedBrainIdentity(input);
        const nextBinding: PortableProjectBinding = {
          project_id: identity.project_id,
          workspace_root_ref: identity.workspace_root_ref,
        };
        const observed = await readBindingSnapshotOrNull(input.conversation_id);
        if (observed.binding !== null && !same(observed.binding, nextBinding)) {
          throw new ProjectWorkspaceError('semantic.preflight-rejected');
        }
        return {
          ok: true,
          extension_bundle_sha256: expectedExtensionSha256(),
          effect_plan_sha256: expectedEffectPlanSha256(
            input,
            observed.binding,
            observed.project_binding_revision,
            observed.project_binding_receipt_id
          ),
          initial_conversation_binding: observed.binding,
          initial_project_binding_revision: observed.project_binding_revision,
          initial_project_binding_receipt_id: observed.project_binding_receipt_id,
          preflight_receipt_id: `project-semantic-v1-${input.transaction_id}`,
          semantic_context_ref: `project-semantic-${input.transaction_id}`,
          semantic_context_sha256: hashJson(input),
        } as const;
      } catch (error) {
        return {
          ok: false,
          reason_code: error instanceof ProjectWorkspaceError ? error.reason_code : 'semantic.preflight-rejected',
        };
      }
    },
    stage: async (input: ProjectSemanticStageInput) =>
      serialized(input.transaction_id, async () => {
        input.assert_mutation_allowed();
        assertSemanticPreflight(input, options.get_active_seat_id());
        const stagedContext: ProjectSemanticPreflightInput = {
          operation: input.operation,
          transaction_id: input.transaction_id,
          conversation_id: input.conversation_id,
          identity: input.identity,
          manifest: input.manifest,
          proposed_domains: input.proposed_domains,
          proposed_domains_sha256: input.proposed_domains_sha256,
          base_bundle_sha256: input.base_bundle_sha256,
          local_writes: input.local_writes,
        };
        if (
          input.binding.semantic_context_sha256 !== hashJson(stagedContext) ||
          input.binding.effect_plan_sha256 !==
            expectedEffectPlanSha256(
              stagedContext,
              input.binding.initial_conversation_binding,
              input.binding.initial_project_binding_revision,
              input.binding.initial_project_binding_receipt_id
            ) ||
          input.binding.bundle_sha256 !== expectedBundleSha256(input.base_bundle_sha256, input.binding)
        ) {
          throw new ProjectWorkspaceError('semantic.bundle-mismatch');
        }
        const file = sidecarFile(input.transaction_id);
        if (fs.existsSync(file)) {
          const existing = readSidecar(input.transaction_id);
          if (!same(existing.context, stagedContext) || !same(existing.binding, input.binding)) {
            throw new ProjectWorkspaceError('semantic.bundle-mismatch');
          }
          return;
        }
        const plan = effectPlan(
          stagedContext,
          input.binding.initial_conversation_binding,
          input.binding.initial_project_binding_revision,
          input.binding.initial_project_binding_receipt_id
        );
        const hermesHome = options.resolve_hermes_home(input.identity.seat_id);
        const existingBrain = readBrainIndex(hermesHome).entries.find((entry) => entry.id === plan.brain.entry_id);
        if (existingBrain) throw new ProjectWorkspaceError('semantic.preflight-rejected');
        const observedBinding = await readBindingSnapshotOrNull(input.conversation_id);
        input.assert_mutation_allowed();
        if (
          !same(observedBinding.binding, input.binding.initial_conversation_binding) ||
          observedBinding.project_binding_revision !== input.binding.initial_project_binding_revision ||
          observedBinding.project_binding_receipt_id !== input.binding.initial_project_binding_receipt_id
        ) {
          throw new ProjectWorkspaceError('semantic.preflight-rejected');
        }
        const sidecar: SemanticSidecar = {
          schema_version: SIDECAR_VERSION,
          revision: 0,
          context: stagedContext,
          binding: input.binding,
          effects: {
            brain: {
              ...plan.brain,
              status: 'planned',
              updated_at: now().toISOString(),
            },
            proposal_queue: { ...plan.proposal_queue, status: 'planned' },
            conversation_binding: {
              ...plan.conversation_binding,
              status: 'planned',
              owned: false,
            },
            llm_wiki: plan.llm_wiki,
          },
        };
        options.on_phase?.('sidecar:before-create');
        input.assert_mutation_allowed();
        try {
          writeFileCreateOnly(file, `${JSON.stringify(sidecar, null, 2)}\n`);
        } catch (error) {
          const concurrent =
            (error as NodeJS.ErrnoException).code === 'EEXIST' ? readSidecar(input.transaction_id) : null;
          if (!concurrent || !same(concurrent.context, stagedContext) || !same(concurrent.binding, input.binding)) {
            throw new ProjectWorkspaceError('semantic.bundle-mismatch');
          }
        }
      }),
    commit,
    recover: commit,
    rollback: async (input) => serialized(input.transaction_id, () => rollbackEffects(input, true)),
    prepareRemovalRollback: async (input) => serialized(input.transaction_id, () => rollbackEffects(input, false)),
    finalizeRemovalRollback: async (input) =>
      serialized(input.transaction_id, async () => {
        input.assert_removal_committed();
        await rollbackEffects(input, true, input.assert_removal_committed);
      }),
  };
}
