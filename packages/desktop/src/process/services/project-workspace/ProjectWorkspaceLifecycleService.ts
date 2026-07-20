import fs from 'node:fs';
import path from 'node:path';
import { parseProjectManifest, type ProjectManifestV1 } from '@/common/types/project-workspace/manifest';
import type { ProjectCatalogRecord } from '@/common/types/project-workspace/registry';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import type { ProjectWorkspaceReceiptDTO } from '@/common/types/project-workspace/ui';
import { PROJECT_BRAIN_KIND, upsertSystemEntry } from '@process/commandEve/companyBrainStoreCore';
import { mapProjectWorkspaceReason } from './core/lifecycleReasonCore';
import type { ProjectConversationMetadataClient, PortableProjectBinding } from './runtime/conversationBindingClient';
import { readJson, writeFileAtomic, writeJsonAtomic } from './storage/atomicJson';
import { ProjectWorkspaceRegistryStore } from './storage/registryStore';
import {
  hashProjectLifecycleRequest,
  ProjectLifecycleOperationStore,
  type ProjectLifecycleOperationName,
  type ProjectLifecycleOperationV1,
} from './transaction/lifecycleOperationStore';

type MutationRequest = {
  project_id: string;
  expected_revision: number;
  seat_context_revision: number;
  idempotency_key: string;
};

export type ProjectWorkspaceLifecycleServiceOptions = {
  registry: ProjectWorkspaceRegistryStore;
  operations: ProjectLifecycleOperationStore;
  binding_client: ProjectConversationMetadataClient;
  get_active_seat_id: () => string;
  get_seat_context_revision: () => number;
  is_seat_switch_in_flight: () => boolean;
  resolve_hermes_home: (seatId: string) => string;
  write_project_brain?: (input: {
    seat_id: string;
    record: ProjectCatalogRecord;
    title: string;
    now: () => Date;
  }) => void;
  now?: () => Date;
};

function sameBinding(left: PortableProjectBinding | null, right: PortableProjectBinding | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function receipt(record: ProjectLifecycleOperationV1): ProjectWorkspaceReceiptDTO | undefined {
  if (!record.receipt) return undefined;
  return { ...record.receipt, safe_follow_ups: [] };
}

function projectBrainBody(record: ProjectCatalogRecord): string {
  return [
    '# Project',
    '',
    'Manifest ref: .command-eve/project.json',
    `Project ID: ${record.project_id}`,
    `Realm ID: ${record.realm_id}`,
    `Root ID: ${record.root_id}`,
    `Workspace root ref: ${record.workspace_root_ref}`,
    '',
  ].join('\n');
}

export class ProjectWorkspaceLifecycleService {
  private readonly now: () => Date;

  constructor(private readonly options: ProjectWorkspaceLifecycleServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private assertSeat(seatId: string, seatContextRevision: number): void {
    if (
      this.options.is_seat_switch_in_flight() ||
      this.options.get_active_seat_id() !== seatId ||
      this.options.get_seat_context_revision() !== seatContextRevision
    ) {
      throw new ProjectWorkspaceError('seat.changed');
    }
  }

  private activeSeat(seatContextRevision: number): string {
    const seatId = this.options.get_active_seat_id();
    this.assertSeat(seatId, seatContextRevision);
    return seatId;
  }

  private trustedProject(
    seatId: string,
    projectId: string
  ): {
    record: ProjectCatalogRecord;
    revision: number;
    manifest: ProjectManifestV1;
  } {
    const catalogs = this.options.registry.readSeatCatalogs(seatId);
    const record = catalogs.projects.projects.find((candidate) => candidate.project_id === projectId);
    const root = record ? catalogs.roots.roots.find((candidate) => candidate.root_id === record.root_id) : undefined;
    const realm = record
      ? catalogs.realms.realms.find((candidate) => candidate.realm_id === record.realm_id)
      : undefined;
    const owner = record
      ? this.options.registry.readGlobalRoots().roots.find((candidate) => candidate.root_id === record.root_id)
      : undefined;
    if (
      !record ||
      !root ||
      !realm ||
      !owner ||
      record.seat_id !== seatId ||
      root.status !== 'active' ||
      owner.seat_id !== seatId ||
      owner.workspace_root_ref !== record.workspace_root_ref ||
      root.workspace_root_ref !== record.workspace_root_ref ||
      root.canonical_path !== owner.canonical_path
    ) {
      throw new ProjectWorkspaceError('root.unowned');
    }
    let projectStat: fs.Stats;
    let realProjectPath: string;
    try {
      projectStat = fs.lstatSync(record.canonical_project_path);
      realProjectPath = fs.realpathSync.native(record.canonical_project_path);
    } catch {
      throw new ProjectWorkspaceError('root.not-found');
    }
    if (
      !projectStat.isDirectory() ||
      projectStat.isSymbolicLink() ||
      realProjectPath !== record.canonical_project_path
    ) {
      throw new ProjectWorkspaceError('root.symlink');
    }
    const manifestFile = path.join(record.canonical_project_path, '.command-eve', 'project.json');
    let parsed: ReturnType<typeof parseProjectManifest>;
    try {
      const stat = fs.lstatSync(manifestFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe manifest');
      parsed = parseProjectManifest(readJson(manifestFile));
    } catch {
      throw new ProjectWorkspaceError('schema.invalid');
    }
    if (
      parsed.ok === false ||
      parsed.value.project_id !== record.project_id ||
      parsed.value.seat_id !== seatId ||
      parsed.value.realm_id !== record.realm_id ||
      parsed.value.root_id !== record.root_id ||
      parsed.value.workspace_root_ref !== record.workspace_root_ref ||
      parsed.value.slug !== record.slug
    ) {
      throw new ProjectWorkspaceError(parsed.ok === false ? parsed.reason_code : 'semantic.bundle-mismatch');
    }
    return { record, revision: catalogs.projects.revision, manifest: parsed.value };
  }

  private updateGeneratedTitleLine(file: string, expected: string, desired: string, prefix: string): void {
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ProjectWorkspaceError('root.symlink');
    const current = fs.readFileSync(file, 'utf8');
    const expectedLine = `${prefix}${expected}`;
    if (!current.split('\n').includes(expectedLine)) return;
    const next = current
      .split('\n')
      .map((line) => (line === expectedLine ? `${prefix}${desired}` : line))
      .join('\n');
    writeFileAtomic(file, next);
  }

  private applyMetadata(record: ProjectLifecycleOperationV1): void {
    const trusted = this.trustedProject(record.seat_id, record.project_id);
    const expectedTitle = record.expected_title ?? trusted.record.title;
    const desiredTitle = record.desired_title ?? expectedTitle;
    const expectedStatus = record.expected_status ?? trusted.record.status;
    const desiredStatus = record.desired_status ?? expectedStatus;
    const catalogAlreadyApplied = trusted.record.title === desiredTitle && trusted.record.status === desiredStatus;
    if (
      !catalogAlreadyApplied &&
      (trusted.record.title !== expectedTitle || trusted.record.status !== expectedStatus)
    ) {
      throw new ProjectWorkspaceError('workspace.recovery-required');
    }
    if (trusted.manifest.title !== desiredTitle || trusted.manifest.status !== desiredStatus) {
      if (trusted.manifest.title !== expectedTitle || trusted.manifest.status !== expectedStatus) {
        throw new ProjectWorkspaceError('workspace.recovery-required');
      }
      const override: ProjectManifestV1['manual_overrides'][number] =
        desiredTitle !== expectedTitle ? 'title' : 'status';
      const nextManifest: ProjectManifestV1 = {
        ...trusted.manifest,
        title: desiredTitle,
        status: desiredStatus,
        manual_overrides: [...new Set([...trusted.manifest.manual_overrides, override])],
      };
      writeJsonAtomic(path.join(trusted.record.canonical_project_path, '.command-eve', 'project.json'), nextManifest);
      if (desiredTitle !== expectedTitle) {
        this.updateGeneratedTitleLine(
          path.join(trusted.record.canonical_project_path, 'memory-bank', 'projectbrief.md'),
          expectedTitle,
          desiredTitle,
          'Project: '
        );
        this.updateGeneratedTitleLine(
          path.join(trusted.record.canonical_project_path, 'docs', 'wiki', 'project.md'),
          expectedTitle,
          desiredTitle,
          '# '
        );
      }
    }
    this.assertSeat(record.seat_id, record.seat_context_revision);
    if (this.options.write_project_brain) {
      this.options.write_project_brain({
        seat_id: record.seat_id,
        record: trusted.record,
        title: desiredTitle,
        now: this.now,
      });
    } else {
      upsertSystemEntry(this.options.resolve_hermes_home(record.seat_id), {
        id: `project-${trusted.record.project_id}`,
        kind: PROJECT_BRAIN_KIND,
        title: desiredTitle,
        body: projectBrainBody(trusted.record),
        author: 'eve',
        source: 'chat',
        now: this.now,
      });
    }
    this.assertSeat(record.seat_id, record.seat_context_revision);
    if (!catalogAlreadyApplied) {
      this.options.registry.replaceProjectIfRevision({
        seat_id: record.seat_id,
        expected_revision: trusted.revision,
        expected_record: trusted.record,
        next_record: { ...trusted.record, title: desiredTitle, status: desiredStatus },
      });
    }
  }

  private async applyBinding(record: ProjectLifecycleOperationV1): Promise<void> {
    if (!record.conversation_id) throw new ProjectWorkspaceError('workspace.journal-corrupt');
    const trusted = this.trustedProject(record.seat_id, record.project_id);
    const expected: PortableProjectBinding | null =
      record.operation === 'bind'
        ? null
        : { project_id: trusted.record.project_id, workspace_root_ref: trusted.record.workspace_root_ref };
    const next: PortableProjectBinding | null =
      record.operation === 'bind'
        ? { project_id: trusted.record.project_id, workspace_root_ref: trusted.record.workspace_root_ref }
        : null;
    this.assertSeat(record.seat_id, record.seat_context_revision);
    const observed = await this.options.binding_client.read(record.conversation_id);
    this.assertSeat(record.seat_id, record.seat_context_revision);
    if (!sameBinding(observed.binding, next)) {
      if (
        !sameBinding(observed.binding, expected) ||
        observed.project_binding_revision !== record.expected_project_binding_revision ||
        observed.project_binding_receipt_id !== record.expected_project_binding_receipt_id
      ) {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      await this.options.binding_client.compareAndSwap({
        conversation_id: record.conversation_id,
        expected,
        expected_project_binding_revision: observed.project_binding_revision,
        expected_project_binding_receipt_id: observed.project_binding_receipt_id,
        project_binding_operation_id: record.idempotency_key,
        next,
      });
      this.assertSeat(record.seat_id, record.seat_context_revision);
      this.options.registry.touchProjectIfRevision({
        seat_id: record.seat_id,
        project_id: record.project_id,
        expected_revision: trusted.revision,
      });
    } else if (
      observed.project_binding_receipt_id === record.idempotency_key &&
      trusted.revision === record.expected_revision
    ) {
      this.options.registry.touchProjectIfRevision({
        seat_id: record.seat_id,
        project_id: record.project_id,
        expected_revision: trusted.revision,
      });
    }
  }

  private async complete(record: ProjectLifecycleOperationV1): Promise<ProjectWorkspaceReceiptDTO> {
    this.assertSeat(record.seat_id, record.seat_context_revision);
    if (record.operation === 'bind' || record.operation === 'unbind') await this.applyBinding(record);
    else this.applyMetadata(record);
    const completedAt = this.now().getTime();
    const terminal = this.options.operations.transition(
      record.seat_id,
      record.idempotency_key,
      'mutating',
      'committed',
      {
        receipt_id: record.idempotency_key,
        outcome: 'completed',
        completed_at: completedAt,
      }
    );
    return receipt(terminal)!;
  }

  private async execute(input: {
    request: MutationRequest;
    operation: ProjectLifecycleOperationName;
    desired_title?: string;
    desired_status?: 'active' | 'archived';
    conversation_id?: string;
  }): Promise<ProjectWorkspaceReceiptDTO> {
    const seatId = this.activeSeat(input.request.seat_context_revision);
    const existing = this.options.operations.read(seatId, input.request.idempotency_key);
    if (existing) {
      if (
        existing.request_sha256 !== hashProjectLifecycleRequest(input.request) ||
        existing.operation !== input.operation ||
        existing.project_id !== input.request.project_id
      ) {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      const replay = receipt(existing);
      if (replay) return replay;
      const resumable =
        existing.phase === 'recovery_required'
          ? this.options.operations.transition(seatId, existing.idempotency_key, 'recovery_required', 'mutating')
          : existing;
      if (resumable.phase === 'mutating') {
        return this.complete({ ...resumable, seat_context_revision: input.request.seat_context_revision });
      }
    }
    const trusted = this.trustedProject(seatId, input.request.project_id);
    if (trusted.revision !== input.request.expected_revision)
      throw new ProjectWorkspaceError('catalog.revision-conflict');
    const binding = input.conversation_id ? await this.options.binding_client.read(input.conversation_id) : undefined;
    this.assertSeat(seatId, input.request.seat_context_revision);
    const prepared = this.options.operations.prepare({
      idempotency_key: input.request.idempotency_key,
      operation: input.operation,
      seat_id: seatId,
      project_id: input.request.project_id,
      expected_revision: input.request.expected_revision,
      seat_context_revision: input.request.seat_context_revision,
      ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
      ...(binding
        ? {
            expected_project_binding_revision: binding.project_binding_revision,
            expected_project_binding_receipt_id: binding.project_binding_receipt_id,
          }
        : {}),
      expected_title: trusted.record.title,
      desired_title: input.desired_title ?? trusted.record.title,
      expected_status: trusted.record.status,
      desired_status: input.desired_status ?? trusted.record.status,
      request: input.request,
    });
    const replayReceipt = receipt(prepared.record);
    if (replayReceipt) return replayReceipt;
    if (prepared.record.phase === 'recovery_required') {
      const resumed = this.options.operations.transition(
        seatId,
        input.request.idempotency_key,
        'recovery_required',
        'mutating'
      );
      return this.complete(resumed);
    }
    const mutating =
      prepared.record.phase === 'mutating'
        ? prepared.record
        : this.options.operations.transition(seatId, input.request.idempotency_key, 'planned', 'mutating');
    try {
      return await this.complete(mutating);
    } catch (error) {
      const reason = error instanceof ProjectWorkspaceError ? error.reason_code : 'workspace.io-failed';
      try {
        this.options.operations.transition(seatId, input.request.idempotency_key, 'mutating', 'recovery_required', {
          receipt_id: input.request.idempotency_key,
          outcome: 'recovery_required',
          completed_at: this.now().getTime(),
          reason_code: mapProjectWorkspaceReason(reason),
        });
      } catch {
        // Preserve the original failure; an unreadable journal is discovered by recover/list.
      }
      throw error;
    }
  }

  updateMetadata(request: MutationRequest & { title: string }): Promise<ProjectWorkspaceReceiptDTO> {
    const title = request.title.trim();
    if (!title || title.length > 200) throw new ProjectWorkspaceError('identity.invalid');
    return this.execute({ request, operation: 'update_metadata', desired_title: title });
  }

  archive(request: MutationRequest): Promise<ProjectWorkspaceReceiptDTO> {
    return this.execute({ request, operation: 'archive', desired_status: 'archived' });
  }

  restore(request: MutationRequest): Promise<ProjectWorkspaceReceiptDTO> {
    return this.execute({ request, operation: 'restore', desired_status: 'active' });
  }

  bindConversation(request: MutationRequest & { conversation_id: string }): Promise<ProjectWorkspaceReceiptDTO> {
    return this.execute({ request, operation: 'bind', conversation_id: request.conversation_id });
  }

  unbindConversation(request: MutationRequest & { conversation_id: string }): Promise<ProjectWorkspaceReceiptDTO> {
    return this.execute({ request, operation: 'unbind', conversation_id: request.conversation_id });
  }

  async recoverProject(input: {
    project_id: string;
    seat_context_revision: number;
  }): Promise<ProjectWorkspaceReceiptDTO[]> {
    const seatId = this.activeSeat(input.seat_context_revision);
    const results: ProjectWorkspaceReceiptDTO[] = [];
    for (const pending of this.options.operations.listRecoverable(seatId, input.project_id)) {
      const mutating =
        pending.phase === 'recovery_required'
          ? this.options.operations.transition(seatId, pending.idempotency_key, 'recovery_required', 'mutating')
          : pending;
      results.push(await this.complete({ ...mutating, seat_context_revision: input.seat_context_revision }));
    }
    return results;
  }
}
