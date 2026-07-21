import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_MANIFEST_VERSION,
  PROJECT_RECEIPT_VERSION,
  parseProjectManifest,
  parseProjectReceipt,
  type ProjectManifestV1,
  type ProjectReceiptV1,
} from '@/common/types/project-workspace/manifest';
import type { ProjectIntentPlan } from '@/common/types/project-workspace/intent';
import type { ProjectCatalogRecord, RealmRecord, RootRecord } from '@/common/types/project-workspace/registry';
import { parseTransactionId } from '@/common/types/project-workspace/identity';
import { ProjectWorkspaceError, type ProjectWorkspaceReasonCode } from '@/common/types/project-workspace/reasonCodes';
import {
  PROJECT_JOURNAL_VERSION,
  type ProjectJournalPhase,
  type ProjectTransactionJournalV1,
  type ProjectUndoCatalogProofV1,
  type ProjectUndoQuarantinePlanV1,
} from '@/common/types/project-workspace/transaction';
import { verifyImmutableTargetSnapshot } from './core/preflightCore';
import {
  buildProjectSemanticBaseBundle,
  preflightProjectSemanticBundle,
  type ProjectSemanticBundleBinding,
  type ProjectSemanticCoordinator,
  type ProjectSemanticLifecycleInput,
} from './core/semanticBundleCore';
import {
  ensurePrivateDirectory,
  readJson,
  syncDirectoryDurable,
  writeFileCreateOnly,
  writeJsonAtomic,
} from './storage/atomicJson';
import type { ProjectWorkspaceRegistryStore, SeatCatalogBundle } from './storage/registryStore';
import { canonicalizeRoot, resolveProjectTarget, rootComparisonKey } from './storage/rootPolicy';
import {
  PROJECT_SCAFFOLD_DIRECTORIES,
  materializeProjectScaffold,
  projectScaffoldFileContents,
  sha256Contents,
  validateMaterializedProjectScaffold,
} from './templates/scaffold';
import {
  acquireProjectLease,
  advanceProjectJournal,
  buildProjectUndoQuarantinePlan,
  establishProjectUndoQuarantine,
  leaseOwnerTokenSha256,
  listProjectJournals,
  prepareProjectUndoQuarantine,
  projectLeasePath,
  projectJournalPath,
  purgeProjectUndoQuarantine,
  readProjectJournal,
  releaseProjectLease,
  hasOnlyExpectedFiles,
  verifyCreatedFiles,
  heartbeatProjectLease,
  inspectProjectAdoption,
  isProjectLeaseReleased,
  writeProjectJournal,
} from './transaction';

const PROVISIONING_UNDO_SOURCE_PHASES: ReadonlySet<ProjectJournalPhase> = new Set([
  'planned',
  'leased',
  'preflighted',
  'semantic_staged',
  'staging',
  'staged',
]);

const ACTIVE_UNDO_PHASES: ReadonlySet<ProjectJournalPhase> = new Set([
  'undo_quarantine_prepared',
  'undo_quarantining',
  'undo_quarantined',
  'undo_semantic_rolled_back',
  'undo_removal_committed',
]);

export type ProjectWorkspaceServiceOptions = {
  registry: ProjectWorkspaceRegistryStore;
  get_active_seat_id: () => string;
  now?: () => Date;
  lease_now_ms?: () => number;
  random_uuid?: () => string;
  lease_ttl_ms?: number;
  on_phase?: (phase: string) => void;
  semantic_coordinator?: ProjectSemanticCoordinator;
};

export type ProjectCreateResult =
  | {
      ok: true;
      committed: true;
      project_path: string;
      receipt_path: string;
      transaction_id: string;
      already_existed?: boolean;
    }
  | { ok: false; reason_code: ProjectWorkspaceReasonCode; recovery_required?: boolean };

export type ProjectRecoveryResult =
  | { ok: true; action: 'reconciled' | 'rolled_back'; transaction_id: string }
  | { ok: false; reason_code: ProjectWorkspaceReasonCode; transaction_id: string };

export type ProjectUndoResult =
  | { ok: true; status: 'undone' }
  | {
      ok: false;
      status: 'recovery_required';
      reason_code: 'workspace.undo-hash-mismatch' | 'workspace.recovery-required';
    };

function deterministicUuid(seed: string): string {
  const digest = Buffer.from(crypto.createHash('sha256').update(seed).digest().subarray(0, 16));
  digest[6] = (digest[6] & 0x0f) | 0x40;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function identitiesMatch(manifest: ProjectManifestV1, plan: ProjectIntentPlan): boolean {
  return (
    manifest.project_id === plan.project_id &&
    manifest.seat_id === plan.seat_id &&
    manifest.realm_id === plan.realm_id &&
    manifest.root_id === plan.root_id &&
    manifest.workspace_root_ref === plan.workspace_root_ref
  );
}

export class ProjectWorkspaceService {
  private readonly registry: ProjectWorkspaceRegistryStore;
  private readonly getActiveSeatId: () => string;
  private readonly now: () => Date;
  private readonly leaseNowMs: () => number;
  private readonly randomUuid: () => string;
  private readonly leaseTtlMs: number;
  private readonly onPhase?: (phase: string) => void;
  private readonly semanticCoordinator?: ProjectSemanticCoordinator;

  constructor(options: ProjectWorkspaceServiceOptions) {
    this.registry = options.registry;
    this.getActiveSeatId = options.get_active_seat_id;
    this.now = options.now ?? (() => new Date());
    this.leaseNowMs = options.lease_now_ms ?? Date.now;
    this.randomUuid = options.random_uuid ?? crypto.randomUUID;
    this.leaseTtlMs = options.lease_ttl_ms ?? 30_000;
    this.onPhase = options.on_phase;
    this.semanticCoordinator = options.semantic_coordinator;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private runPhase(phase: string): void {
    this.onPhase?.(phase);
  }

  private refreshLease(leasePath: string, ownerToken: string): void {
    if (!heartbeatProjectLease(leasePath, ownerToken, this.leaseNowMs(), this.leaseTtlMs)) {
      throw new ProjectWorkspaceError('workspace.concurrent-operation');
    }
  }

  private async withLeaseHeartbeat<T>(
    leasePath: string,
    ownerToken: string,
    operation: (assertLeaseAlive: () => void) => Promise<T>
  ): Promise<T> {
    this.refreshLease(leasePath, ownerToken);
    let heartbeatFailure: ProjectWorkspaceError | undefined;
    const assertLeaseAlive = (): void => {
      if (heartbeatFailure) throw heartbeatFailure;
      try {
        this.refreshLease(leasePath, ownerToken);
      } catch {
        heartbeatFailure = new ProjectWorkspaceError('workspace.concurrent-operation');
        throw heartbeatFailure;
      }
    };
    const intervalMs = Math.max(100, Math.min(1_000, Math.floor(this.leaseTtlMs / 3)));
    const timer = setInterval(() => {
      try {
        this.refreshLease(leasePath, ownerToken);
      } catch {
        heartbeatFailure = new ProjectWorkspaceError('workspace.concurrent-operation');
      }
    }, intervalMs);
    timer.unref?.();
    try {
      const result = await operation(assertLeaseAlive);
      assertLeaseAlive();
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  private semanticBinding(journal: ProjectTransactionJournalV1): ProjectSemanticBundleBinding {
    if (
      !journal.semantic_base_bundle_sha256 ||
      !journal.semantic_bundle_sha256 ||
      !journal.semantic_effect_plan_sha256 ||
      !Object.hasOwn(journal, 'semantic_initial_project_id') ||
      !Object.hasOwn(journal, 'semantic_initial_workspace_root_ref') ||
      journal.semantic_initial_project_binding_revision === undefined ||
      !Object.hasOwn(journal, 'semantic_initial_project_binding_receipt_id') ||
      !journal.semantic_preflight_receipt_id ||
      !journal.semantic_context_ref ||
      !journal.semantic_context_sha256 ||
      !journal.proposed_domains_sha256
    ) {
      throw new ProjectWorkspaceError('semantic.bundle-mismatch');
    }
    return {
      base_bundle_sha256: journal.semantic_base_bundle_sha256,
      bundle_sha256: journal.semantic_bundle_sha256,
      effect_plan_sha256: journal.semantic_effect_plan_sha256,
      initial_conversation_binding:
        journal.semantic_initial_project_id === null && journal.semantic_initial_workspace_root_ref === null
          ? null
          : {
              project_id: String(journal.semantic_initial_project_id),
              workspace_root_ref: String(journal.semantic_initial_workspace_root_ref) as `root:${string}`,
            },
      initial_project_binding_revision: journal.semantic_initial_project_binding_revision,
      initial_project_binding_receipt_id: journal.semantic_initial_project_binding_receipt_id ?? null,
      preflight_receipt_id: journal.semantic_preflight_receipt_id,
      semantic_context_ref: journal.semantic_context_ref,
      semantic_context_sha256: journal.semantic_context_sha256,
      proposed_domains_sha256: journal.proposed_domains_sha256,
    };
  }

  private semanticLifecycleInput(input: {
    journal: ProjectTransactionJournalV1;
    project_path: string;
    root_record: RootRecord;
    assert_lease_alive: () => void;
  }): ProjectSemanticLifecycleInput {
    const coordinator = this.semanticCoordinator;
    if (!coordinator) throw new ProjectWorkspaceError('semantic.coordinator-required');
    return {
      operation: input.journal.operation,
      transaction_id: input.journal.transaction_id,
      conversation_id: input.journal.conversation_id,
      identity: input.journal.identity,
      binding: this.semanticBinding(input.journal),
      project_path: input.project_path,
      assert_mutation_allowed: () => {
        input.assert_lease_alive();
        this.assertProjectMutationAllowed(input.journal.identity.seat_id, input.root_record, input.project_path);
      },
    };
  }

  private semanticBaseContext(journal: ProjectTransactionJournalV1): {
    transaction_id: string;
    conversation_id: string;
    proposed_domains_sha256: string;
  } {
    return {
      transaction_id: journal.transaction_id,
      conversation_id: journal.conversation_id,
      proposed_domains_sha256: this.semanticBinding(journal).proposed_domains_sha256,
    };
  }

  private validConversationId(value: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value);
  }

  private async continueProjectUndo(input: {
    journal: ProjectTransactionJournalV1;
    physical_path: string;
    semantic_project_path: string;
    root_record: RootRecord;
    lease_path: string;
    owner_token: string;
    receipt_relative_path?: string;
    catalog_proof?: ProjectUndoCatalogProofV1;
  }): Promise<ProjectTransactionJournalV1> {
    return this.withLeaseHeartbeat(input.lease_path, input.owner_token, async (assertLeaseAlive) => {
      let journal = input.journal;
      const assertMutationAllowed = (targetPath: string): void => {
        this.runPhase('undo:before-filesystem-mutation');
        assertLeaseAlive();
        this.assertProjectMutationAllowed(journal.identity.seat_id, input.root_record, targetPath);
      };
      const advance = (
        phase: ProjectJournalPhase,
        changes: Partial<ProjectTransactionJournalV1> = {}
      ): ProjectTransactionJournalV1 => {
        this.runPhase(`undo:before-${phase}`);
        assertLeaseAlive();
        this.assertProjectMutationAllowed(journal.identity.seat_id, input.root_record, input.semantic_project_path);
        journal = advanceProjectJournal(this.registry.stateRoot, journal, phase, this.timestamp(), changes);
        this.runPhase(`undo:${phase}`);
        return journal;
      };

      if (journal.phase === 'rollback_pending') {
        throw new ProjectWorkspaceError('workspace.recovery-required');
      }

      if (PROVISIONING_UNDO_SOURCE_PHASES.has(journal.phase) || journal.phase === 'committed') {
        const committedUndo = journal.phase === 'committed';
        const plan = buildProjectUndoQuarantinePlan({
          transaction_id: journal.transaction_id,
          origin: committedUndo ? 'committed-undo' : 'provisioning-rollback',
          operation: journal.operation,
          root: input.physical_path,
          created_files: journal.created_files,
          created_directories: journal.created_directories,
          ...(committedUndo ? { receipt_relative_path: input.receipt_relative_path } : {}),
          catalog_proof: committedUndo ? (input.catalog_proof ?? null) : null,
        });
        if (!plan) throw new ProjectWorkspaceError('workspace.recovery-required');
        advance('undo_quarantine_prepared', { undo_quarantine_plan: plan });
      }

      if (!ACTIVE_UNDO_PHASES.has(journal.phase) || !journal.undo_quarantine_plan) {
        if (journal.phase === 'undone') return journal;
        throw new ProjectWorkspaceError('workspace.recovery-required');
      }

      let plan: ProjectUndoQuarantinePlanV1 = journal.undo_quarantine_plan;
      if (journal.phase === 'undo_quarantine_prepared') {
        const prepared = prepareProjectUndoQuarantine(input.physical_path, plan, assertMutationAllowed);
        if (!prepared) throw new ProjectWorkspaceError('workspace.recovery-required');
        if (JSON.stringify(prepared) !== JSON.stringify(plan)) {
          plan = prepared;
          advance('undo_quarantine_prepared', { undo_quarantine_plan: plan });
        }
        advance('undo_quarantining');
      }

      if (journal.phase === 'undo_quarantining') {
        assertLeaseAlive();
        if (!establishProjectUndoQuarantine(input.physical_path, plan, assertMutationAllowed)) {
          throw new ProjectWorkspaceError('workspace.recovery-required');
        }
        advance('undo_quarantined');
      }

      if (journal.phase === 'undo_quarantined') {
        if (journal.semantic_preflight_receipt_id) {
          if (!this.semanticCoordinator) throw new ProjectWorkspaceError('semantic.coordinator-required');
          await this.semanticCoordinator.prepareRemovalRollback(
            this.semanticLifecycleInput({
              journal,
              project_path: input.semantic_project_path,
              root_record: input.root_record,
              assert_lease_alive: assertLeaseAlive,
            })
          );
        }
        advance('undo_semantic_rolled_back');
      }

      if (journal.phase === 'undo_semantic_rolled_back') {
        advance('undo_removal_committed');
      }

      if (journal.phase === 'undo_removal_committed') {
        assertLeaseAlive();
        if (!purgeProjectUndoQuarantine(input.physical_path, plan, assertMutationAllowed)) {
          throw new ProjectWorkspaceError('workspace.recovery-required');
        }
        if (plan.catalog_proof) {
          assertLeaseAlive();
          this.assertProjectMutationAllowed(journal.identity.seat_id, input.root_record, input.semantic_project_path);
          this.registry.removeProjectIfMatches({
            seat_id: journal.identity.seat_id,
            expected_revision: plan.catalog_proof.expected_revision,
            expected_record: plan.catalog_proof.expected_record,
            allow_already_absent: true,
          });
        }
        if (journal.semantic_preflight_receipt_id) {
          if (!this.semanticCoordinator) throw new ProjectWorkspaceError('semantic.coordinator-required');
          const assertRemovalCommitted = (): void => {
            assertLeaseAlive();
            this.assertProjectMutationAllowed(journal.identity.seat_id, input.root_record, input.semantic_project_path);
            const durable = readProjectJournal(projectJournalPath(this.registry.stateRoot, journal.transaction_id));
            if (
              durable.phase !== 'undo_removal_committed' ||
              JSON.stringify(durable.undo_quarantine_plan) !== JSON.stringify(plan)
            ) {
              throw new ProjectWorkspaceError('workspace.recovery-required');
            }
          };
          await this.semanticCoordinator.finalizeRemovalRollback({
            ...this.semanticLifecycleInput({
              journal,
              project_path: input.semantic_project_path,
              root_record: input.root_record,
              assert_lease_alive: assertLeaseAlive,
            }),
            assert_removal_committed: assertRemovalCommitted,
          });
        }
        advance('undone', { undo_quarantine_plan: undefined });
      }

      if (journal.phase !== 'undone') throw new ProjectWorkspaceError('workspace.recovery-required');
      return journal;
    });
  }

  private assertActiveSeat(expectedSeatId: string): void {
    if (this.getActiveSeatId() !== expectedSeatId) throw new ProjectWorkspaceError('seat.changed');
  }

  private assertRootStillOwned(
    seatId: string,
    rootRecord: RootRecord
  ): { canonical_path: string; comparison_key: string } {
    if (rootRecord.status !== 'active') throw new ProjectWorkspaceError('root.unowned');
    const canonical = canonicalizeRoot(rootRecord.canonical_path);
    if (
      canonical.ok === false ||
      canonical.canonical_path !== rootRecord.canonical_path ||
      canonical.comparison_key !== rootRecord.comparison_key
    ) {
      throw new ProjectWorkspaceError(canonical.ok === false ? canonical.reason_code : 'root.unowned');
    }
    const owner = this.registry.readGlobalRoots().roots.find((record) => record.root_id === rootRecord.root_id);
    if (
      !owner ||
      owner.seat_id !== seatId ||
      owner.canonical_path !== rootRecord.canonical_path ||
      owner.comparison_key !== rootRecord.comparison_key ||
      owner.workspace_root_ref !== rootRecord.workspace_root_ref
    ) {
      throw new ProjectWorkspaceError('root.unowned');
    }
    return canonical;
  }

  private assertMutationPath(rootPath: string, candidatePath: string): void {
    const root = path.resolve(rootPath);
    const candidate = path.resolve(candidatePath);
    const relative = path.relative(root, candidate);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ProjectWorkspaceError('root.escape');
    }
    let current = root;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new ProjectWorkspaceError('root.symlink');
      } catch (error) {
        if (error instanceof ProjectWorkspaceError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw new ProjectWorkspaceError('workspace.io-failed');
      }
    }
  }

  private assertProjectMutationAllowed(seatId: string, rootRecord: RootRecord, targetPath: string): void {
    this.assertActiveSeat(seatId);
    const canonical = this.assertRootStillOwned(seatId, rootRecord);
    this.assertMutationPath(canonical.canonical_path, targetPath);
  }

  private trustedJournalContext(journal: ProjectTransactionJournalV1): {
    catalogs: SeatCatalogBundle;
    root_record: RootRecord;
    final_path: string;
    staging_path: string;
    lease_path: string;
    comparison_key: string;
  } {
    const catalogs = this.registry.readSeatCatalogs(journal.identity.seat_id);
    const rootRecord = catalogs.roots.roots.find((record) => record.root_id === journal.identity.root_id);
    const realm = catalogs.realms.realms.find((record) => record.realm_id === journal.identity.realm_id);
    if (!rootRecord || !realm || realm.status !== 'active') throw new ProjectWorkspaceError('root.unowned');
    if (
      rootRecord.workspace_root_ref !== journal.identity.workspace_root_ref ||
      (rootRecord.realm_id !== undefined && rootRecord.realm_id !== journal.identity.realm_id)
    ) {
      throw new ProjectWorkspaceError('workspace.journal-corrupt');
    }
    const canonical = this.assertRootStillOwned(journal.identity.seat_id, rootRecord);
    const finalPath = path.join(canonical.canonical_path, journal.slug);
    const stagingPath =
      journal.operation === 'create'
        ? path.join(canonical.canonical_path, `.command-eve-stage-${journal.transaction_id}`)
        : finalPath;
    const comparisonKey = rootComparisonKey(finalPath);
    const leaseKey = `${journal.identity.seat_id}|${journal.identity.realm_id}|${comparisonKey}`;
    const leasePath = projectLeasePath(path.join(this.registry.stateRoot, 'leases'), leaseKey);
    if (journal.final_path !== finalPath || journal.staging_path !== stagingPath || journal.lease_path !== leasePath) {
      throw new ProjectWorkspaceError('workspace.journal-corrupt');
    }
    this.assertMutationPath(canonical.canonical_path, finalPath);
    this.assertMutationPath(canonical.canonical_path, stagingPath);
    return {
      catalogs,
      root_record: rootRecord,
      final_path: finalPath,
      staging_path: stagingPath,
      lease_path: leasePath,
      comparison_key: comparisonKey,
    };
  }

  private transactionId(plan: ProjectIntentPlan): string {
    const requested = parseTransactionId(this.randomUuid());
    const file = projectJournalPath(this.registry.stateRoot, requested);
    if (!fs.existsSync(file)) return requested;
    const existing = readProjectJournal(file);
    if (existing.identity.project_id === plan.project_id) return requested;
    return deterministicUuid(`${requested}:${plan.project_id}`);
  }

  private projectManifest(plan: ProjectIntentPlan, realm: RealmRecord, createdAt: string): ProjectManifestV1 {
    if (!plan.project_id) throw new ProjectWorkspaceError('identity.invalid');
    return {
      schema_version: PROJECT_MANIFEST_VERSION,
      project_id: plan.project_id,
      seat_id: plan.seat_id,
      realm_id: plan.realm_id,
      realm_label: plan.realm_label ?? realm.label,
      realm_path_slug: plan.realm_path_slug ?? realm.path_slug,
      root_id: plan.root_id,
      title: plan.title,
      slug: plan.slug,
      status: 'active',
      domain_ids: plan.domain_ids,
      created_by: 'user',
      created_at: createdAt,
      workspace_root_ref: plan.workspace_root_ref,
      manual_overrides: [],
    };
  }

  private existingProjectResult(plan: ProjectIntentPlan): ProjectCreateResult | undefined {
    if (!plan.project_id) return undefined;
    const catalogs = this.registry.readSeatCatalogs(plan.seat_id);
    const record = catalogs.projects.projects.find((candidate) => candidate.project_id === plan.project_id);
    if (!record) return undefined;
    const root = catalogs.roots.roots.find((candidate) => candidate.root_id === record.root_id);
    if (
      !root ||
      record.status === 'recovery_required' ||
      record.seat_id !== plan.seat_id ||
      record.realm_id !== plan.realm_id ||
      record.root_id !== plan.root_id ||
      record.workspace_root_ref !== plan.workspace_root_ref
    ) {
      return { ok: false, reason_code: 'catalog.project-conflict', recovery_required: true };
    }
    try {
      this.assertActiveSeat(plan.seat_id);
      const canonicalRoot = this.assertRootStillOwned(plan.seat_id, root);
      const expectedProjectPath = path.join(canonicalRoot.canonical_path, record.slug);
      if (
        record.canonical_project_path !== expectedProjectPath ||
        record.comparison_key !== rootComparisonKey(expectedProjectPath) ||
        fs.lstatSync(expectedProjectPath).isSymbolicLink() ||
        !fs.statSync(expectedProjectPath).isDirectory() ||
        fs.realpathSync.native(expectedProjectPath) !== expectedProjectPath
      ) {
        throw new ProjectWorkspaceError('workspace.recovery-required');
      }
      this.assertMutationPath(canonicalRoot.canonical_path, expectedProjectPath);
    } catch (error) {
      return {
        ok: false,
        reason_code: error instanceof ProjectWorkspaceError ? error.reason_code : 'workspace.recovery-required',
        recovery_required: true,
      };
    }
    const manifestFile = path.join(record.canonical_project_path, '.command-eve', 'project.json');
    let parsed;
    try {
      if (fs.lstatSync(manifestFile).isSymbolicLink()) {
        return { ok: false, reason_code: 'workspace.recovery-required', recovery_required: true };
      }
      parsed = parseProjectManifest(readJson(manifestFile));
    } catch {
      return { ok: false, reason_code: 'workspace.recovery-required', recovery_required: true };
    }
    if (parsed.ok === false || !identitiesMatch(parsed.value, plan)) {
      return { ok: false, reason_code: 'catalog.project-conflict', recovery_required: true };
    }
    const receiptDirectory = path.join(record.canonical_project_path, '.command-eve', 'receipts');
    try {
      this.assertMutationPath(root.canonical_path, receiptDirectory);
    } catch {
      return { ok: false, reason_code: 'workspace.recovery-required', recovery_required: true };
    }
    const receipts = fs.existsSync(receiptDirectory)
      ? fs
          .readdirSync(receiptDirectory)
          .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
          .toSorted()
      : [];
    return {
      ok: true,
      committed: true,
      project_path: record.canonical_project_path,
      receipt_path: receipts.length > 0 ? path.join(receiptDirectory, receipts.at(-1) as string) : '',
      transaction_id: receipts.length > 0 ? (receipts.at(-1) as string).replace(/\.json$/, '') : '',
      already_existed: true,
    };
  }

  async create(plan: ProjectIntentPlan): Promise<ProjectCreateResult> {
    if (plan.action !== 'create' || !plan.project_id || !this.validConversationId(plan.conversation_id)) {
      return { ok: false, reason_code: 'identity.invalid' };
    }
    const existing = this.existingProjectResult(plan);
    if (existing) return existing;

    let catalogs = this.registry.readSeatCatalogs(plan.seat_id);
    const firstPreflight = verifyImmutableTargetSnapshot(plan, this.getActiveSeatId(), catalogs);
    if (firstPreflight.ok === false) return { ok: false, reason_code: firstPreflight.reason_code };
    const rootRecord = catalogs.roots.roots.find((root) => root.root_id === plan.root_id);
    const realmRecord = catalogs.realms.realms.find((realm) => realm.realm_id === plan.realm_id);
    if (!rootRecord || !realmRecord) return { ok: false, reason_code: 'root.not-found' };
    let canonicalRoot: { canonical_path: string; comparison_key: string };
    try {
      canonicalRoot = this.assertRootStillOwned(plan.seat_id, rootRecord);
    } catch (error) {
      return {
        ok: false,
        reason_code: error instanceof ProjectWorkspaceError ? error.reason_code : 'root.unowned',
      };
    }
    const target = resolveProjectTarget(
      canonicalRoot.canonical_path,
      plan.slug,
      catalogs.projects.projects.map((project) => project.canonical_project_path)
    );
    if (target.ok === false) return { ok: false, reason_code: target.reason_code };
    if (fs.existsSync(target.target_path)) return { ok: false, reason_code: 'workspace.collision' };

    const transactionId = this.transactionId(plan);
    const ownerToken = `${crypto.randomUUID()}:${process.pid}:${Date.now()}`;
    const leaseDirectory = path.join(this.registry.stateRoot, 'leases');
    const leaseKey = `${plan.seat_id}|${plan.realm_id}|${target.comparison_key}`;
    const leasePath = projectLeasePath(leaseDirectory, leaseKey);
    const stagingPath = path.join(canonicalRoot.canonical_path, `.command-eve-stage-${transactionId}`);
    const identity = {
      seat_id: plan.seat_id,
      realm_id: plan.realm_id,
      root_id: plan.root_id,
      project_id: plan.project_id,
      workspace_root_ref: plan.workspace_root_ref,
    };
    const createdAt = this.timestamp();
    const manifest = this.projectManifest(plan, realmRecord, createdAt);
    let journal: ProjectTransactionJournalV1 = {
      schema_version: PROJECT_JOURNAL_VERSION,
      transaction_id: transactionId,
      conversation_id: plan.conversation_id,
      operation: 'create',
      phase: 'planned',
      identity,
      slug: plan.slug,
      staging_path: stagingPath,
      final_path: target.target_path,
      lease_path: leasePath,
      owner_token_sha256: leaseOwnerTokenSha256(ownerToken),
      created_files: [],
      created_directories: [],
      created_at: createdAt,
      updated_at: createdAt,
    };
    try {
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, stagingPath);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, target.target_path);
      writeProjectJournal(this.registry.stateRoot, journal);
    } catch (error) {
      return {
        ok: false,
        reason_code: error instanceof ProjectWorkspaceError ? error.reason_code : 'workspace.io-failed',
      };
    }
    const acquired = acquireProjectLease({
      lease_directory: leaseDirectory,
      key: leaseKey,
      transaction_id: transactionId,
      lineage_owner_token_sha256: journal.owner_token_sha256,
      owner_token: ownerToken,
      ttl_ms: this.leaseTtlMs,
      now_ms: this.leaseNowMs(),
      can_take_over_stale: (lease) => lease.transaction_id === transactionId,
    });
    if (acquired.ok === false) {
      // No lease means no authority to advance even our own undo journal. Keep
      // the mutation-free `planned` record so recoverAll can acquire the lease
      // later and drive the bounded no-op quarantine state machine.
      return { ok: false, reason_code: acquired.reason_code, recovery_required: true };
    }
    let escapedCrash = false;
    let recoveryRequired = false;

    try {
      this.runPhase('lease:acquired');
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'leased', this.timestamp());
      this.runPhase('leased');
      this.refreshLease(acquired.lease_path, ownerToken);
      catalogs = this.registry.readSeatCatalogs(plan.seat_id);
      const leasedPreflight = verifyImmutableTargetSnapshot(plan, this.getActiveSeatId(), catalogs);
      if (leasedPreflight.ok === false) throw new ProjectWorkspaceError(leasedPreflight.reason_code);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, stagingPath);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, target.target_path);
      if (fs.existsSync(stagingPath) || fs.existsSync(target.target_path)) {
        throw new ProjectWorkspaceError('workspace.collision');
      }

      const semanticPreflight = await this.withLeaseHeartbeat(acquired.lease_path, ownerToken, () =>
        preflightProjectSemanticBundle({
          operation: 'create',
          transaction_id: transactionId,
          conversation_id: plan.conversation_id,
          identity,
          manifest,
          proposed_domains: plan.proposed_domains,
          coordinator: this.semanticCoordinator,
        })
      );
      if (semanticPreflight.ok === false) throw new ProjectWorkspaceError(semanticPreflight.reason_code);
      catalogs = this.registry.readSeatCatalogs(plan.seat_id);
      const semanticSnapshot = verifyImmutableTargetSnapshot(plan, this.getActiveSeatId(), catalogs);
      if (semanticSnapshot.ok === false) throw new ProjectWorkspaceError(semanticSnapshot.reason_code);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, stagingPath);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, target.target_path);
      if (fs.existsSync(stagingPath) || fs.existsSync(target.target_path)) {
        throw new ProjectWorkspaceError('workspace.collision');
      }
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'preflighted', this.timestamp(), {
        semantic_base_bundle_sha256: semanticPreflight.binding.base_bundle_sha256,
        semantic_bundle_sha256: semanticPreflight.binding.bundle_sha256,
        semantic_effect_plan_sha256: semanticPreflight.binding.effect_plan_sha256,
        semantic_initial_project_id: semanticPreflight.binding.initial_conversation_binding?.project_id ?? null,
        semantic_initial_workspace_root_ref:
          semanticPreflight.binding.initial_conversation_binding?.workspace_root_ref ?? null,
        semantic_initial_project_binding_revision: semanticPreflight.binding.initial_project_binding_revision,
        semantic_initial_project_binding_receipt_id: semanticPreflight.binding.initial_project_binding_receipt_id,
        semantic_preflight_receipt_id: semanticPreflight.binding.preflight_receipt_id,
        semantic_context_ref: semanticPreflight.binding.semantic_context_ref,
        semantic_context_sha256: semanticPreflight.binding.semantic_context_sha256,
        proposed_domains_sha256: semanticPreflight.binding.proposed_domains_sha256,
      });
      this.runPhase('preflighted');
      this.refreshLease(acquired.lease_path, ownerToken);

      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, target.target_path);
      if (!this.semanticCoordinator) throw new ProjectWorkspaceError('semantic.coordinator-required');
      await this.withLeaseHeartbeat(acquired.lease_path, ownerToken, (assertLeaseAlive) =>
        this.semanticCoordinator!.stage({
          ...semanticPreflight.preflight_input,
          binding: semanticPreflight.binding,
          assert_mutation_allowed: () => {
            assertLeaseAlive();
            this.assertProjectMutationAllowed(plan.seat_id, rootRecord, target.target_path);
          },
        })
      );
      catalogs = this.registry.readSeatCatalogs(plan.seat_id);
      const stagedSemanticSnapshot = verifyImmutableTargetSnapshot(plan, this.getActiveSeatId(), catalogs);
      if (stagedSemanticSnapshot.ok === false) throw new ProjectWorkspaceError(stagedSemanticSnapshot.reason_code);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, stagingPath);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, target.target_path);
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'semantic_staged', this.timestamp());
      this.runPhase('semantic_staged');
      this.refreshLease(acquired.lease_path, ownerToken);

      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'staging', this.timestamp());
      this.runPhase('staging');
      this.refreshLease(acquired.lease_path, ownerToken);
      const scaffold = materializeProjectScaffold(stagingPath, manifest, (targetPath) => {
        this.assertProjectMutationAllowed(plan.seat_id, rootRecord, targetPath);
      });
      if (!validateMaterializedProjectScaffold(stagingPath, manifest, scaffold)) {
        throw new ProjectWorkspaceError('workspace.io-failed', 'scaffold validation failed');
      }
      for (const relativeDirectory of PROJECT_SCAFFOLD_DIRECTORIES.toReversed()) {
        syncDirectoryDurable(path.join(stagingPath, relativeDirectory));
      }
      syncDirectoryDurable(stagingPath);
      syncDirectoryDurable(canonicalRoot.canonical_path);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, stagingPath);
      if (fs.statSync(stagingPath).dev !== fs.statSync(canonicalRoot.canonical_path).dev) {
        throw new ProjectWorkspaceError('workspace.io-failed', 'staging is not on the root volume');
      }
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'staged', this.timestamp(), scaffold);
      this.runPhase('staged');
      this.refreshLease(acquired.lease_path, ownerToken);

      catalogs = this.registry.readSeatCatalogs(plan.seat_id);
      const promotionPreflight = verifyImmutableTargetSnapshot(plan, this.getActiveSeatId(), catalogs);
      if (promotionPreflight.ok === false) throw new ProjectWorkspaceError(promotionPreflight.reason_code);
      if (
        buildProjectSemanticBaseBundle(manifest, this.semanticBaseContext(journal)).base_bundle_sha256 !==
        journal.semantic_base_bundle_sha256
      ) {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, stagingPath);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, target.target_path);
      fs.renameSync(stagingPath, target.target_path);
      syncDirectoryDurable(canonicalRoot.canonical_path);
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'promoted', this.timestamp());
      this.runPhase('promotion:renamed');
      this.runPhase('promoted');
      this.refreshLease(acquired.lease_path, ownerToken);

      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, target.target_path);
      if (!this.semanticCoordinator) throw new ProjectWorkspaceError('semantic.coordinator-required');
      await this.withLeaseHeartbeat(acquired.lease_path, ownerToken, (assertLeaseAlive) =>
        this.semanticCoordinator!.commit(
          this.semanticLifecycleInput({
            journal,
            project_path: target.target_path,
            root_record: rootRecord,
            assert_lease_alive: assertLeaseAlive,
          })
        )
      );
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, target.target_path);
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'semantic_committed', this.timestamp());
      this.runPhase('semantic_committed');
      this.refreshLease(acquired.lease_path, ownerToken);

      const record: ProjectCatalogRecord = {
        project_id: plan.project_id,
        seat_id: plan.seat_id,
        realm_id: plan.realm_id,
        root_id: plan.root_id,
        workspace_root_ref: plan.workspace_root_ref,
        title: plan.title,
        slug: plan.slug,
        status: 'active',
        manifest_relative_path: `${plan.slug}/.command-eve/project.json`,
        canonical_project_path: target.target_path,
        comparison_key: target.comparison_key,
        registered_at: this.timestamp(),
      };
      this.registry.registerProject({ record, expected_revision: plan.snapshot.project_catalog_revision });
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'cataloged', this.timestamp());
      this.runPhase('cataloged');
      this.refreshLease(acquired.lease_path, ownerToken);

      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, target.target_path);
      const receipt: ProjectReceiptV1 = {
        schema_version: PROJECT_RECEIPT_VERSION,
        transaction_id: transactionId,
        operation: 'create',
        status: 'committed',
        identity,
        semantic_bundle_sha256: this.semanticBinding(journal).bundle_sha256,
        semantic_preflight_receipt_id: this.semanticBinding(journal).preflight_receipt_id,
        created_files: journal.created_files,
        created_directories: journal.created_directories,
        created_at: journal.created_at,
        updated_at: this.timestamp(),
      };
      const receiptPath = path.join(target.target_path, '.command-eve', 'receipts', `${transactionId}.json`);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, receiptPath);
      writeFileCreateOnly(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'committed', this.timestamp());
      this.runPhase('committed');
      releaseProjectLease(acquired.lease_path, ownerToken);
      return {
        ok: true,
        committed: true,
        project_path: target.target_path,
        receipt_path: receiptPath,
        transaction_id: transactionId,
      };
    } catch (error) {
      if (!(error instanceof ProjectWorkspaceError)) {
        escapedCrash = true;
        throw error;
      }
      if (PROVISIONING_UNDO_SOURCE_PHASES.has(journal.phase) || ACTIVE_UNDO_PHASES.has(journal.phase)) {
        try {
          journal = await this.continueProjectUndo({
            journal,
            physical_path: stagingPath,
            semantic_project_path: target.target_path,
            root_record: rootRecord,
            lease_path: acquired.lease_path,
            owner_token: ownerToken,
          });
        } catch (rollbackError) {
          if (!(rollbackError instanceof ProjectWorkspaceError)) {
            escapedCrash = true;
            throw rollbackError;
          }
          recoveryRequired = true;
          journal = readProjectJournal(projectJournalPath(this.registry.stateRoot, journal.transaction_id));
        }
      } else if (
        journal.phase === 'promoted' ||
        journal.phase === 'semantic_committed' ||
        journal.phase === 'cataloged'
      ) {
        recoveryRequired = true;
        journal = advanceProjectJournal(this.registry.stateRoot, journal, journal.phase, this.timestamp(), {
          reason_code: error.reason_code,
        });
      }
      releaseProjectLease(acquired.lease_path, ownerToken);
      return {
        ok: false,
        reason_code: error.reason_code,
        ...(recoveryRequired || journal.phase !== 'undone' ? { recovery_required: true } : {}),
      };
    } finally {
      if (!escapedCrash && fs.existsSync(acquired.lease_path)) releaseProjectLease(acquired.lease_path, ownerToken);
    }
  }

  async adopt(plan: ProjectIntentPlan, directory: string, confirmed: boolean): Promise<ProjectCreateResult> {
    if (!confirmed) return { ok: false, reason_code: 'adoption.confirmation-required' };
    if (plan.action !== 'create' || !plan.project_id || !this.validConversationId(plan.conversation_id)) {
      return { ok: false, reason_code: 'identity.invalid' };
    }
    const existing = this.existingProjectResult(plan);
    if (existing) return existing;
    let catalogs = this.registry.readSeatCatalogs(plan.seat_id);
    const preflight = verifyImmutableTargetSnapshot(plan, this.getActiveSeatId(), catalogs);
    if (preflight.ok === false) return { ok: false, reason_code: preflight.reason_code };
    const rootRecord = catalogs.roots.roots.find((root) => root.root_id === plan.root_id);
    const realmRecord = catalogs.realms.realms.find((realm) => realm.realm_id === plan.realm_id);
    if (!rootRecord || !realmRecord) return { ok: false, reason_code: 'root.not-found' };
    try {
      this.assertRootStillOwned(plan.seat_id, rootRecord);
    } catch (error) {
      return {
        ok: false,
        reason_code: error instanceof ProjectWorkspaceError ? error.reason_code : 'root.unowned',
      };
    }
    let canonicalDirectory: string;
    try {
      canonicalDirectory = fs.realpathSync.native(directory);
    } catch {
      return { ok: false, reason_code: 'adoption.root-unowned' };
    }
    if (path.basename(canonicalDirectory) !== plan.slug) {
      return { ok: false, reason_code: 'adoption.collision' };
    }
    const identity = {
      seat_id: plan.seat_id,
      realm_id: plan.realm_id,
      root_id: plan.root_id,
      project_id: plan.project_id,
      workspace_root_ref: plan.workspace_root_ref,
    };
    let inspection = inspectProjectAdoption({
      directory: canonicalDirectory,
      expected_identity: identity,
      owned_root_path: rootRecord.canonical_path,
      registered_project_paths: catalogs.projects.projects.map((project) => project.canonical_project_path),
    });
    if (inspection.action === 'reject') {
      return { ok: false, reason_code: inspection.reason_code ?? 'adoption.collision' };
    }
    if (inspection.action === 'continue_existing') {
      return { ok: false, reason_code: 'catalog.project-conflict', recovery_required: true };
    }

    const transactionId = this.transactionId(plan);
    const ownerToken = `${crypto.randomUUID()}:adopt:${process.pid}:${Date.now()}`;
    const comparisonKey = rootComparisonKey(canonicalDirectory);
    const leaseKey = `${plan.seat_id}|${plan.realm_id}|${comparisonKey}`;
    const leaseDirectory = path.join(this.registry.stateRoot, 'leases');
    const leasePath = projectLeasePath(leaseDirectory, leaseKey);
    const createdAt = this.timestamp();
    const manifest = this.projectManifest(plan, realmRecord, createdAt);
    let journal: ProjectTransactionJournalV1 = {
      schema_version: PROJECT_JOURNAL_VERSION,
      transaction_id: transactionId,
      conversation_id: plan.conversation_id,
      operation: 'adopt',
      phase: 'planned',
      identity,
      slug: plan.slug,
      staging_path: canonicalDirectory,
      final_path: canonicalDirectory,
      lease_path: leasePath,
      owner_token_sha256: leaseOwnerTokenSha256(ownerToken),
      created_files: [],
      created_directories: [],
      created_at: createdAt,
      updated_at: createdAt,
    };
    try {
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, canonicalDirectory);
      writeProjectJournal(this.registry.stateRoot, journal);
    } catch (error) {
      return {
        ok: false,
        reason_code: error instanceof ProjectWorkspaceError ? error.reason_code : 'workspace.io-failed',
      };
    }
    const acquired = acquireProjectLease({
      lease_directory: leaseDirectory,
      key: leaseKey,
      transaction_id: transactionId,
      lineage_owner_token_sha256: journal.owner_token_sha256,
      owner_token: ownerToken,
      ttl_ms: this.leaseTtlMs,
      now_ms: this.leaseNowMs(),
      can_take_over_stale: (lease) => lease.transaction_id === transactionId,
    });
    if (acquired.ok === false) {
      // See create(): the durable planned journal is intentionally left for a
      // later lease-owning recovery pass instead of claiming an undo occurred.
      return { ok: false, reason_code: acquired.reason_code, recovery_required: true };
    }
    let escapedCrash = false;
    try {
      this.runPhase('adopt:lease:acquired');
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'leased', this.timestamp());
      this.runPhase('adopt:leased');
      this.refreshLease(acquired.lease_path, ownerToken);
      catalogs = this.registry.readSeatCatalogs(plan.seat_id);
      const leasedPreflight = verifyImmutableTargetSnapshot(plan, this.getActiveSeatId(), catalogs);
      if (leasedPreflight.ok === false) throw new ProjectWorkspaceError(leasedPreflight.reason_code);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, canonicalDirectory);
      inspection = inspectProjectAdoption({
        directory: canonicalDirectory,
        expected_identity: identity,
        owned_root_path: rootRecord.canonical_path,
        registered_project_paths: catalogs.projects.projects.map((project) => project.canonical_project_path),
      });
      if (inspection.action !== 'preview') {
        throw new ProjectWorkspaceError(inspection.reason_code ?? 'adoption.collision');
      }
      const semanticPreflight = await this.withLeaseHeartbeat(acquired.lease_path, ownerToken, () =>
        preflightProjectSemanticBundle({
          operation: 'adopt',
          transaction_id: transactionId,
          conversation_id: plan.conversation_id,
          identity,
          manifest,
          proposed_domains: plan.proposed_domains,
          coordinator: this.semanticCoordinator,
          included_relative_paths: inspection.missing,
        })
      );
      if (semanticPreflight.ok === false) throw new ProjectWorkspaceError(semanticPreflight.reason_code);
      catalogs = this.registry.readSeatCatalogs(plan.seat_id);
      const semanticSnapshot = verifyImmutableTargetSnapshot(plan, this.getActiveSeatId(), catalogs);
      if (semanticSnapshot.ok === false) throw new ProjectWorkspaceError(semanticSnapshot.reason_code);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, canonicalDirectory);
      const postPreflightInspection = inspectProjectAdoption({
        directory: canonicalDirectory,
        expected_identity: identity,
        owned_root_path: rootRecord.canonical_path,
        registered_project_paths: catalogs.projects.projects.map((project) => project.canonical_project_path),
      });
      if (
        postPreflightInspection.action !== 'preview' ||
        JSON.stringify(postPreflightInspection.missing) !== JSON.stringify(inspection.missing) ||
        JSON.stringify(postPreflightInspection.collisions) !== JSON.stringify(inspection.collisions)
      ) {
        throw new ProjectWorkspaceError('adoption.collision');
      }
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'preflighted', this.timestamp(), {
        semantic_base_bundle_sha256: semanticPreflight.binding.base_bundle_sha256,
        semantic_bundle_sha256: semanticPreflight.binding.bundle_sha256,
        semantic_effect_plan_sha256: semanticPreflight.binding.effect_plan_sha256,
        semantic_initial_project_id: semanticPreflight.binding.initial_conversation_binding?.project_id ?? null,
        semantic_initial_workspace_root_ref:
          semanticPreflight.binding.initial_conversation_binding?.workspace_root_ref ?? null,
        semantic_initial_project_binding_revision: semanticPreflight.binding.initial_project_binding_revision,
        semantic_initial_project_binding_receipt_id: semanticPreflight.binding.initial_project_binding_receipt_id,
        semantic_preflight_receipt_id: semanticPreflight.binding.preflight_receipt_id,
        semantic_context_ref: semanticPreflight.binding.semantic_context_ref,
        semantic_context_sha256: semanticPreflight.binding.semantic_context_sha256,
        proposed_domains_sha256: semanticPreflight.binding.proposed_domains_sha256,
      });
      this.runPhase('adopt:preflighted');
      this.refreshLease(acquired.lease_path, ownerToken);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, canonicalDirectory);
      if (!this.semanticCoordinator) throw new ProjectWorkspaceError('semantic.coordinator-required');
      await this.withLeaseHeartbeat(acquired.lease_path, ownerToken, (assertLeaseAlive) =>
        this.semanticCoordinator!.stage({
          ...semanticPreflight.preflight_input,
          binding: semanticPreflight.binding,
          assert_mutation_allowed: () => {
            assertLeaseAlive();
            this.assertProjectMutationAllowed(plan.seat_id, rootRecord, canonicalDirectory);
          },
        })
      );
      catalogs = this.registry.readSeatCatalogs(plan.seat_id);
      const stagedSemanticSnapshot = verifyImmutableTargetSnapshot(plan, this.getActiveSeatId(), catalogs);
      if (stagedSemanticSnapshot.ok === false) throw new ProjectWorkspaceError(stagedSemanticSnapshot.reason_code);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, canonicalDirectory);
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'semantic_staged', this.timestamp());
      this.runPhase('adopt:semantic_staged');
      this.refreshLease(acquired.lease_path, ownerToken);
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'staging', this.timestamp());
      for (const relativeDirectory of PROJECT_SCAFFOLD_DIRECTORIES) {
        const absolute = path.join(canonicalDirectory, relativeDirectory);
        this.assertProjectMutationAllowed(plan.seat_id, rootRecord, absolute);
        if (fs.existsSync(absolute)) continue;
        ensurePrivateDirectory(absolute);
        journal = advanceProjectJournal(this.registry.stateRoot, journal, 'staging', this.timestamp(), {
          created_directories: [...journal.created_directories, relativeDirectory],
        });
      }
      for (const [relativePath, contents] of Object.entries(projectScaffoldFileContents(manifest)).toSorted(
        ([left], [right]) => left.localeCompare(right)
      )) {
        const file = path.join(canonicalDirectory, relativePath);
        this.assertProjectMutationAllowed(plan.seat_id, rootRecord, file);
        if (fs.existsSync(file)) continue;
        writeFileCreateOnly(file, contents);
        journal = advanceProjectJournal(this.registry.stateRoot, journal, 'staging', this.timestamp(), {
          created_files: [...journal.created_files, { relative_path: relativePath, sha256: sha256Contents(contents) }],
        });
      }
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'staged', this.timestamp());
      this.runPhase('adopt:staged');
      this.refreshLease(acquired.lease_path, ownerToken);
      catalogs = this.registry.readSeatCatalogs(plan.seat_id);
      const finalPreflight = verifyImmutableTargetSnapshot(plan, this.getActiveSeatId(), catalogs);
      if (finalPreflight.ok === false) throw new ProjectWorkspaceError(finalPreflight.reason_code);
      if (
        buildProjectSemanticBaseBundle(
          manifest,
          this.semanticBaseContext(journal),
          journal.created_files.map((entry) => entry.relative_path)
        ).base_bundle_sha256 !== journal.semantic_base_bundle_sha256
      ) {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, canonicalDirectory);
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'promoted', this.timestamp());
      this.runPhase('adopt:promoted');
      this.refreshLease(acquired.lease_path, ownerToken);
      if (!this.semanticCoordinator) throw new ProjectWorkspaceError('semantic.coordinator-required');
      await this.withLeaseHeartbeat(acquired.lease_path, ownerToken, (assertLeaseAlive) =>
        this.semanticCoordinator!.commit(
          this.semanticLifecycleInput({
            journal,
            project_path: canonicalDirectory,
            root_record: rootRecord,
            assert_lease_alive: assertLeaseAlive,
          })
        )
      );
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, canonicalDirectory);
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'semantic_committed', this.timestamp());
      this.runPhase('adopt:semantic_committed');
      this.refreshLease(acquired.lease_path, ownerToken);
      const record: ProjectCatalogRecord = {
        project_id: plan.project_id,
        seat_id: plan.seat_id,
        realm_id: plan.realm_id,
        root_id: plan.root_id,
        workspace_root_ref: plan.workspace_root_ref,
        title: plan.title,
        slug: plan.slug,
        status: 'active',
        manifest_relative_path: `${plan.slug}/.command-eve/project.json`,
        canonical_project_path: canonicalDirectory,
        comparison_key: comparisonKey,
        registered_at: this.timestamp(),
      };
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, canonicalDirectory);
      this.registry.registerProject({ record, expected_revision: plan.snapshot.project_catalog_revision });
      journal = advanceProjectJournal(this.registry.stateRoot, journal, 'cataloged', this.timestamp());
      const receipt: ProjectReceiptV1 = {
        schema_version: PROJECT_RECEIPT_VERSION,
        transaction_id: transactionId,
        operation: 'adopt',
        status: 'committed',
        identity,
        semantic_bundle_sha256: this.semanticBinding(journal).bundle_sha256,
        semantic_preflight_receipt_id: this.semanticBinding(journal).preflight_receipt_id,
        created_files: journal.created_files,
        created_directories: journal.created_directories,
        created_at: journal.created_at,
        updated_at: this.timestamp(),
      };
      const receiptPath = path.join(canonicalDirectory, '.command-eve', 'receipts', `${transactionId}.json`);
      this.assertProjectMutationAllowed(plan.seat_id, rootRecord, receiptPath);
      writeFileCreateOnly(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      advanceProjectJournal(this.registry.stateRoot, journal, 'committed', this.timestamp());
      releaseProjectLease(acquired.lease_path, ownerToken);
      return {
        ok: true,
        committed: true,
        project_path: canonicalDirectory,
        receipt_path: receiptPath,
        transaction_id: transactionId,
      };
    } catch (error) {
      if (!(error instanceof ProjectWorkspaceError)) {
        escapedCrash = true;
        throw error;
      }
      if (PROVISIONING_UNDO_SOURCE_PHASES.has(journal.phase) || ACTIVE_UNDO_PHASES.has(journal.phase)) {
        try {
          journal = await this.continueProjectUndo({
            journal,
            physical_path: canonicalDirectory,
            semantic_project_path: canonicalDirectory,
            root_record: rootRecord,
            lease_path: acquired.lease_path,
            owner_token: ownerToken,
          });
        } catch (rollbackError) {
          if (!(rollbackError instanceof ProjectWorkspaceError)) {
            escapedCrash = true;
            throw rollbackError;
          }
          journal = readProjectJournal(projectJournalPath(this.registry.stateRoot, journal.transaction_id));
        }
      } else {
        advanceProjectJournal(this.registry.stateRoot, journal, journal.phase, this.timestamp(), {
          reason_code: error.reason_code,
        });
      }
      releaseProjectLease(acquired.lease_path, ownerToken);
      return {
        ok: false,
        reason_code: error.reason_code,
        ...(journal.phase !== 'undone' ? { recovery_required: true } : {}),
      };
    } finally {
      if (!escapedCrash && fs.existsSync(acquired.lease_path)) releaseProjectLease(acquired.lease_path, ownerToken);
    }
  }

  async recoverAll(): Promise<ProjectRecoveryResult[]> {
    const results: ProjectRecoveryResult[] = [];
    for (const entry of listProjectJournals(this.registry.stateRoot)) {
      let journal = entry.journal;
      const terminalPhase =
        journal.phase === 'committed' || journal.phase === 'undone' || journal.phase === 'recovery_required';
      if (entry.file !== projectJournalPath(this.registry.stateRoot, journal.transaction_id)) {
        results.push({
          ok: false,
          reason_code: 'workspace.journal-corrupt',
          transaction_id: journal.transaction_id,
        });
        continue;
      }
      // Boot-seat fence (1.818 CAO-P2): boot recovery runs ONLY for the seat
      // that is active right now. A foreign-seat journal belongs to that
      // seat's own boot recovery — it must not be leased, advanced, or
      // reported as a failed recovery under the wrong active seat. The
      // assertActiveSeat below stays as defense-in-depth.
      if (journal.identity.seat_id !== this.getActiveSeatId()) continue;
      let context: ReturnType<ProjectWorkspaceService['trustedJournalContext']>;
      try {
        this.assertActiveSeat(journal.identity.seat_id);
        context = this.trustedJournalContext(journal);
      } catch (error) {
        results.push({
          ok: false,
          reason_code: error instanceof ProjectWorkspaceError ? error.reason_code : 'workspace.journal-corrupt',
          transaction_id: journal.transaction_id,
        });
        continue;
      }
      if (journal.semantic_preflight_receipt_id && !this.semanticCoordinator) {
        results.push({
          ok: false,
          reason_code: 'semantic.coordinator-required',
          transaction_id: journal.transaction_id,
        });
        continue;
      }
      if (terminalPhase && (!fs.existsSync(context.lease_path) || isProjectLeaseReleased(context.lease_path))) {
        continue;
      }
      const ownerToken = `${crypto.randomUUID()}:recovery:${process.pid}`;
      const key = `${journal.identity.seat_id}|${journal.identity.realm_id}|${context.comparison_key}`;
      const acquired = acquireProjectLease({
        lease_directory: path.join(this.registry.stateRoot, 'leases'),
        key,
        transaction_id: journal.transaction_id,
        lineage_owner_token_sha256: journal.owner_token_sha256,
        owner_token: ownerToken,
        ttl_ms: this.leaseTtlMs,
        now_ms: this.leaseNowMs(),
        can_take_over_stale: (lease) => lease.transaction_id === journal.transaction_id,
      });
      if (acquired.ok === false) {
        results.push({ ok: false, reason_code: acquired.reason_code, transaction_id: journal.transaction_id });
        continue;
      }
      this.runPhase('recovery:lease:acquired');
      journal = advanceProjectJournal(this.registry.stateRoot, journal, journal.phase, this.timestamp());
      try {
        this.assertProjectMutationAllowed(journal.identity.seat_id, context.root_record, context.final_path);
        if (terminalPhase) {
          results.push({ ok: true, action: 'reconciled', transaction_id: journal.transaction_id });
          continue;
        }
        const observedCreatePromotion =
          journal.operation === 'create' &&
          journal.phase === 'staged' &&
          !fs.existsSync(context.staging_path) &&
          fs.existsSync(context.final_path);
        if (journal.phase === 'rollback_pending') {
          journal = advanceProjectJournal(this.registry.stateRoot, journal, 'recovery_required', this.timestamp(), {
            reason_code: 'workspace.recovery-required',
          });
          results.push({
            ok: false,
            reason_code: 'workspace.recovery-required',
            transaction_id: journal.transaction_id,
          });
          continue;
        }
        if (
          ACTIVE_UNDO_PHASES.has(journal.phase) ||
          (!observedCreatePromotion && PROVISIONING_UNDO_SOURCE_PHASES.has(journal.phase))
        ) {
          const undoOrigin = journal.undo_quarantine_plan?.origin;
          const physicalPath =
            undoOrigin === 'committed-undo' || journal.operation === 'adopt'
              ? context.final_path
              : context.staging_path;
          journal = await this.continueProjectUndo({
            journal,
            physical_path: physicalPath,
            semantic_project_path: context.final_path,
            root_record: context.root_record,
            lease_path: acquired.lease_path,
            owner_token: ownerToken,
          });
          results.push({ ok: true, action: 'rolled_back', transaction_id: journal.transaction_id });
          continue;
        }
        if (
          !observedCreatePromotion &&
          journal.phase !== 'promoted' &&
          journal.phase !== 'semantic_committed' &&
          journal.phase !== 'cataloged'
        ) {
          continue;
        }
        let parsed;
        try {
          parsed = parseProjectManifest(readJson(path.join(context.final_path, '.command-eve', 'project.json')));
        } catch {
          parsed = { ok: false as const, reason_code: 'schema.invalid' as const };
        }
        if (
          !parsed.ok ||
          parsed.value.project_id !== journal.identity.project_id ||
          parsed.value.seat_id !== journal.identity.seat_id ||
          parsed.value.realm_id !== journal.identity.realm_id ||
          parsed.value.root_id !== journal.identity.root_id ||
          parsed.value.workspace_root_ref !== journal.identity.workspace_root_ref ||
          parsed.value.slug !== journal.slug ||
          !verifyCreatedFiles(context.final_path, journal.created_files)
        ) {
          advanceProjectJournal(this.registry.stateRoot, journal, 'recovery_required', this.timestamp(), {
            reason_code: 'workspace.recovery-required',
          });
          results.push({
            ok: false,
            reason_code: 'workspace.recovery-required',
            transaction_id: journal.transaction_id,
          });
          continue;
        }
        const recoveryBase = buildProjectSemanticBaseBundle(
          parsed.value,
          this.semanticBaseContext(journal),
          journal.operation === 'adopt' ? journal.created_files.map((fileEntry) => fileEntry.relative_path) : undefined
        );
        if (recoveryBase.base_bundle_sha256 !== journal.semantic_base_bundle_sha256) {
          advanceProjectJournal(this.registry.stateRoot, journal, 'recovery_required', this.timestamp(), {
            reason_code: 'semantic.bundle-mismatch',
          });
          results.push({
            ok: false,
            reason_code: 'semantic.bundle-mismatch',
            transaction_id: journal.transaction_id,
          });
          continue;
        }
        this.assertProjectMutationAllowed(journal.identity.seat_id, context.root_record, context.final_path);
        const catalogs = this.registry.readSeatCatalogs(journal.identity.seat_id);
        const root = catalogs.roots.roots.find((record) => record.root_id === journal.identity.root_id);
        if (!root || root.workspace_root_ref !== journal.identity.workspace_root_ref) {
          results.push({ ok: false, reason_code: 'root.unowned', transaction_id: journal.transaction_id });
          continue;
        }
        this.assertProjectMutationAllowed(journal.identity.seat_id, root, context.final_path);
        if (journal.phase === 'promoted' || observedCreatePromotion) {
          if (!this.semanticCoordinator) throw new ProjectWorkspaceError('semantic.coordinator-required');
          await this.withLeaseHeartbeat(acquired.lease_path, ownerToken, (assertLeaseAlive) =>
            this.semanticCoordinator!.recover(
              this.semanticLifecycleInput({
                journal,
                project_path: context.final_path,
                root_record: root,
                assert_lease_alive: assertLeaseAlive,
              })
            )
          );
          journal = advanceProjectJournal(this.registry.stateRoot, journal, 'semantic_committed', this.timestamp());
        }
        const record: ProjectCatalogRecord = {
          project_id: parsed.value.project_id,
          seat_id: parsed.value.seat_id,
          realm_id: parsed.value.realm_id,
          root_id: parsed.value.root_id,
          workspace_root_ref: parsed.value.workspace_root_ref,
          title: parsed.value.title,
          slug: parsed.value.slug,
          status: parsed.value.status,
          manifest_relative_path: `${parsed.value.slug}/.command-eve/project.json`,
          canonical_project_path: context.final_path,
          comparison_key: context.comparison_key,
          registered_at: this.timestamp(),
        };
        this.registry.registerProject({ record, expected_revision: catalogs.projects.revision });
        const receipt: ProjectReceiptV1 = {
          schema_version: PROJECT_RECEIPT_VERSION,
          transaction_id: journal.transaction_id,
          operation: 'recover',
          status: 'committed',
          identity: journal.identity,
          semantic_bundle_sha256: this.semanticBinding(journal).bundle_sha256,
          semantic_preflight_receipt_id: this.semanticBinding(journal).preflight_receipt_id,
          created_files: journal.created_files,
          created_directories: journal.created_directories,
          created_at: journal.created_at,
          updated_at: this.timestamp(),
        };
        const receiptPath = path.join(context.final_path, '.command-eve', 'receipts', `${journal.transaction_id}.json`);
        this.assertProjectMutationAllowed(journal.identity.seat_id, root, receiptPath);
        if (fs.existsSync(receiptPath)) {
          let existingReceipt;
          try {
            existingReceipt = parseProjectReceipt(readJson(receiptPath));
          } catch {
            existingReceipt = { ok: false as const, reason_code: 'schema.invalid' as const };
          }
          if (
            !existingReceipt.ok ||
            existingReceipt.value.transaction_id !== receipt.transaction_id ||
            existingReceipt.value.status !== 'committed' ||
            existingReceipt.value.identity.seat_id !== receipt.identity.seat_id ||
            existingReceipt.value.identity.realm_id !== receipt.identity.realm_id ||
            existingReceipt.value.identity.root_id !== receipt.identity.root_id ||
            existingReceipt.value.identity.project_id !== receipt.identity.project_id ||
            existingReceipt.value.identity.workspace_root_ref !== receipt.identity.workspace_root_ref ||
            existingReceipt.value.semantic_bundle_sha256 !== receipt.semantic_bundle_sha256 ||
            existingReceipt.value.semantic_preflight_receipt_id !== receipt.semantic_preflight_receipt_id ||
            JSON.stringify(existingReceipt.value.created_files) !== JSON.stringify(receipt.created_files) ||
            JSON.stringify(existingReceipt.value.created_directories) !== JSON.stringify(receipt.created_directories)
          ) {
            throw new ProjectWorkspaceError('workspace.recovery-required');
          }
        } else {
          writeFileCreateOnly(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
        }
        advanceProjectJournal(this.registry.stateRoot, journal, 'committed', this.timestamp());
        results.push({ ok: true, action: 'reconciled', transaction_id: journal.transaction_id });
      } catch (error) {
        const reasonCode = error instanceof ProjectWorkspaceError ? error.reason_code : 'workspace.io-failed';
        if (reasonCode === 'semantic.bundle-mismatch' && journal.phase !== 'recovery_required') {
          journal = advanceProjectJournal(this.registry.stateRoot, journal, 'recovery_required', this.timestamp(), {
            reason_code: reasonCode,
          });
        }
        results.push({
          ok: false,
          reason_code: reasonCode,
          transaction_id: journal.transaction_id,
        });
      } finally {
        releaseProjectLease(acquired.lease_path, ownerToken);
      }
    }
    return results;
  }

  async undo(receiptPath: string): Promise<ProjectUndoResult> {
    const resolvedReceiptPath = path.resolve(receiptPath);
    let parsed;
    try {
      const receiptStat = fs.lstatSync(resolvedReceiptPath);
      if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
        return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
      }
      parsed = parseProjectReceipt(readJson(resolvedReceiptPath));
    } catch {
      return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
    }
    if (parsed.ok === false) {
      return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
    }
    const receipt = parsed.value;
    try {
      this.assertActiveSeat(receipt.identity.seat_id);
    } catch {
      return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
    }
    const catalogs = this.registry.readSeatCatalogs(receipt.identity.seat_id);
    const project = catalogs.projects.projects.find((record) => record.project_id === receipt.identity.project_id);
    const root = catalogs.roots.roots.find((record) => record.root_id === receipt.identity.root_id);
    if (
      !project ||
      !root ||
      project.seat_id !== receipt.identity.seat_id ||
      project.realm_id !== receipt.identity.realm_id ||
      project.root_id !== receipt.identity.root_id ||
      project.workspace_root_ref !== receipt.identity.workspace_root_ref ||
      root.workspace_root_ref !== receipt.identity.workspace_root_ref
    ) {
      return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
    }
    let projectPath: string;
    try {
      const canonicalRoot = this.assertRootStillOwned(receipt.identity.seat_id, root);
      projectPath = path.join(canonicalRoot.canonical_path, project.slug);
      if (
        project.canonical_project_path !== projectPath ||
        project.comparison_key !== rootComparisonKey(projectPath) ||
        fs.lstatSync(projectPath).isSymbolicLink() ||
        !fs.statSync(projectPath).isDirectory() ||
        fs.realpathSync.native(projectPath) !== projectPath
      ) {
        throw new ProjectWorkspaceError('workspace.recovery-required');
      }
      const expectedReceiptPath = path.join(projectPath, '.command-eve', 'receipts', `${receipt.transaction_id}.json`);
      if (
        resolvedReceiptPath !== expectedReceiptPath ||
        fs.realpathSync.native(resolvedReceiptPath) !== expectedReceiptPath
      ) {
        throw new ProjectWorkspaceError('workspace.recovery-required');
      }
      this.assertProjectMutationAllowed(receipt.identity.seat_id, root, resolvedReceiptPath);
    } catch {
      return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
    }

    const journalFile = projectJournalPath(this.registry.stateRoot, receipt.transaction_id);
    if (!fs.existsSync(journalFile)) {
      return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
    }
    let journal: ProjectTransactionJournalV1;
    try {
      journal = readProjectJournal(journalFile);
      const context = this.trustedJournalContext(journal);
      if (
        journal.phase !== 'committed' ||
        context.final_path !== projectPath ||
        journal.identity.project_id !== receipt.identity.project_id ||
        journal.owner_token_sha256.length !== 64 ||
        journal.semantic_bundle_sha256 !== receipt.semantic_bundle_sha256 ||
        journal.semantic_preflight_receipt_id !== receipt.semantic_preflight_receipt_id ||
        JSON.stringify(journal.created_files) !== JSON.stringify(receipt.created_files) ||
        JSON.stringify(journal.created_directories) !== JSON.stringify(receipt.created_directories)
      ) {
        throw new ProjectWorkspaceError('workspace.recovery-required');
      }
    } catch {
      return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
    }
    if (!this.semanticCoordinator) {
      return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
    }

    const relativeReceipt = path.relative(projectPath, resolvedReceiptPath).split(path.sep).join('/');
    const ownerToken = `${crypto.randomUUID()}:undo:${process.pid}:${Date.now()}`;
    const leaseKey = `${receipt.identity.seat_id}|${receipt.identity.realm_id}|${rootComparisonKey(projectPath)}`;
    const acquired = acquireProjectLease({
      lease_directory: path.join(this.registry.stateRoot, 'leases'),
      key: leaseKey,
      transaction_id: receipt.transaction_id,
      lineage_owner_token_sha256: journal.owner_token_sha256,
      owner_token: ownerToken,
      ttl_ms: this.leaseTtlMs,
      now_ms: this.leaseNowMs(),
      can_take_over_stale: () => false,
    });
    if (acquired.ok === false) {
      return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
    }

    try {
      this.assertProjectMutationAllowed(receipt.identity.seat_id, root, projectPath);
      const unchanged =
        verifyCreatedFiles(projectPath, receipt.created_files) &&
        (journal.operation === 'adopt' || hasOnlyExpectedFiles(projectPath, receipt.created_files, [relativeReceipt]));
      if (!unchanged) {
        const recoveryReceipt: ProjectReceiptV1 = {
          ...receipt,
          status: 'recovery_required',
          updated_at: this.timestamp(),
          reason_code: 'workspace.undo-hash-mismatch',
        };
        this.refreshLease(acquired.lease_path, ownerToken);
        this.assertProjectMutationAllowed(receipt.identity.seat_id, root, resolvedReceiptPath);
        writeJsonAtomic(resolvedReceiptPath, recoveryReceipt);
        this.refreshLease(acquired.lease_path, ownerToken);
        this.registry.markProjectRecoveryRequired(receipt.identity.seat_id, receipt.identity.project_id);
        this.refreshLease(acquired.lease_path, ownerToken);
        advanceProjectJournal(this.registry.stateRoot, journal, 'recovery_required', this.timestamp(), {
          reason_code: 'workspace.undo-hash-mismatch',
        });
        return { ok: false, status: 'recovery_required', reason_code: 'workspace.undo-hash-mismatch' };
      }
      const catalogProof: ProjectUndoCatalogProofV1 = {
        expected_revision: catalogs.projects.revision,
        expected_record: project,
      };
      if (
        !buildProjectUndoQuarantinePlan({
          transaction_id: journal.transaction_id,
          origin: 'committed-undo',
          operation: journal.operation,
          root: projectPath,
          created_files: journal.created_files,
          created_directories: journal.created_directories,
          receipt_relative_path: relativeReceipt,
          catalog_proof: catalogProof,
        })
      ) {
        return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
      }
      journal = await this.continueProjectUndo({
        journal,
        physical_path: projectPath,
        semantic_project_path: projectPath,
        root_record: root,
        lease_path: acquired.lease_path,
        owner_token: ownerToken,
        receipt_relative_path: relativeReceipt,
        catalog_proof: catalogProof,
      });
      if (journal.phase !== 'undone') {
        return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
      }
      return { ok: true, status: 'undone' };
    } catch (error) {
      if (!(error instanceof ProjectWorkspaceError)) throw error;
      return { ok: false, status: 'recovery_required', reason_code: 'workspace.recovery-required' };
    } finally {
      releaseProjectLease(acquired.lease_path, ownerToken);
    }
  }
}
