import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_MANIFEST_VERSION, type ProjectManifestV1 } from '@/common/types/project-workspace/manifest';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import { PROJECT_BRAIN_KIND, readBrainIndex, readEntryBody } from '@/process/commandEve/companyBrainStoreCore';
import {
  preflightProjectSemanticBundle,
  type ProjectSemanticLifecycleInput,
  type ProjectSemanticStageInput,
} from '@/process/services/project-workspace/core/semanticBundleCore';
import type {
  PortableProjectBinding,
  ProjectBindingCasInput,
  ProjectConversationBindingClient,
} from '@/process/services/project-workspace/runtime/conversationBindingClient';
import {
  createProjectSemanticCoordinator,
  createProjectSemanticOperationSerializer,
} from '@/process/services/project-workspace/semantic/projectSemanticCoordinator';

const IDS = {
  realm: '11111111-1111-4111-8111-111111111111',
  root: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
  transaction: '44444444-4444-4444-8444-444444444444',
  otherProject: '55555555-5555-4555-8555-555555555555',
  otherRoot: '66666666-6666-4666-8666-666666666666',
} as const;

describe('project semantic coordinator', () => {
  let stateRoot: string;
  let hermesHome: string;
  let projectPath: string;
  let activeSeat: string;
  let now: Date;
  let binding: PortableProjectBinding | null;
  let bindingRevision: number;
  let bindingReceipt: string | null;
  let casCalls: ProjectBindingCasInput[];
  let failAfterCasOnce: boolean;
  let bindingClient: ProjectConversationBindingClient;

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-semantic-state-'));
    hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-semantic-hermes-'));
    projectPath = path.join(os.tmpdir(), 'eve-semantic-project-path-must-stay-private');
    activeSeat = 'seat-alpha';
    now = new Date('2026-07-20T00:00:00.000Z');
    binding = null;
    bindingRevision = 0;
    bindingReceipt = null;
    casCalls = [];
    failAfterCasOnce = false;
    bindingClient = {
      read: async () => ({
        binding,
        project_binding_revision: bindingRevision,
        project_binding_receipt_id: bindingReceipt,
      }),
      compareAndSwap: async (input) => {
        if (
          JSON.stringify(binding) !== JSON.stringify(input.expected) ||
          bindingRevision !== input.expected_project_binding_revision ||
          bindingReceipt !== input.expected_project_binding_receipt_id
        ) {
          throw new Error('CAS_CONFLICT');
        }
        casCalls.push(input);
        if (JSON.stringify(binding) !== JSON.stringify(input.next)) {
          bindingRevision += 1;
          bindingReceipt = input.project_binding_operation_id;
        }
        binding = input.next;
        if (failAfterCasOnce) {
          failAfterCasOnce = false;
          throw new Error('simulated response loss after accepted CAS');
        }
        return {
          binding,
          project_binding_revision: bindingRevision,
          project_binding_receipt_id: bindingReceipt,
        };
      },
    };
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(hermesHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const manifest = (): ProjectManifestV1 => ({
    schema_version: PROJECT_MANIFEST_VERSION,
    project_id: IDS.project,
    seat_id: 'seat-alpha',
    realm_id: IDS.realm,
    realm_label: 'Business',
    realm_path_slug: 'business',
    root_id: IDS.root,
    title: 'Atlas Research',
    slug: 'atlas-research',
    status: 'active',
    domain_ids: [],
    created_by: 'user',
    created_at: '2026-07-20T00:00:00.000Z',
    workspace_root_ref: `root:${IDS.root}`,
    manual_overrides: [],
  });

  const coordinator = (onPhase?: (phase: string) => void) =>
    createProjectSemanticCoordinator({
      state_root: stateRoot,
      binding_client: bindingClient,
      get_active_seat_id: () => activeSeat,
      resolve_hermes_home: () => hermesHome,
      now: () => now,
      on_phase: onPhase,
    });

  async function prepared(current = coordinator()) {
    const result = await preflightProjectSemanticBundle({
      operation: 'create',
      transaction_id: IDS.transaction,
      conversation_id: 'conversation-atlas',
      identity: {
        seat_id: 'seat-alpha',
        realm_id: IDS.realm,
        root_id: IDS.root,
        project_id: IDS.project,
        workspace_root_ref: `root:${IDS.root}`,
      },
      manifest: manifest(),
      proposed_domains: [{ label: 'Confidential Growth Idea', status: 'proposed' }],
      coordinator: current,
    });
    if (!result.ok) throw new Error(result.reason_code);
    const assertMutationAllowed = vi.fn();
    const stage: ProjectSemanticStageInput = {
      ...result.preflight_input,
      binding: result.binding,
      assert_mutation_allowed: assertMutationAllowed,
    };
    const lifecycle: ProjectSemanticLifecycleInput = {
      operation: 'create',
      transaction_id: IDS.transaction,
      conversation_id: 'conversation-atlas',
      identity: result.preflight_input.identity,
      binding: result.binding,
      project_path: projectPath,
      assert_mutation_allowed: assertMutationAllowed,
    };
    return { current, result, stage, lifecycle, assertMutationAllowed };
  }

  async function preparedWithLeaseHook() {
    const lease = { alive: true, replace_at: null as string | null };
    const current = coordinator((phase) => {
      if (phase === lease.replace_at) {
        lease.alive = false;
        lease.replace_at = null;
      }
    });
    const setup = await prepared(current);
    const assertLeaseAlive = vi.fn(() => {
      if (!lease.alive) throw new ProjectWorkspaceError('workspace.lease-invalid');
    });
    setup.stage.assert_mutation_allowed = assertLeaseAlive;
    setup.lifecycle.assert_mutation_allowed = assertLeaseAlive;
    return { ...setup, lease, assertLeaseAlive };
  }

  it('keeps preflight pure and rejects a stale active-seat boundary', async () => {
    const setup = await prepared();
    expect(fs.readdirSync(stateRoot)).toEqual([]);
    expect(fs.readdirSync(hermesHome)).toEqual([]);
    expect(binding).toBeNull();

    activeSeat = 'seat-beta';
    await expect(setup.current.preflight(setup.result.preflight_input)).resolves.toEqual({
      ok: false,
      reason_code: 'seat.changed',
    });
    expect(fs.readdirSync(stateRoot)).toEqual([]);
    expect(fs.readdirSync(hermesHome)).toEqual([]);
  });

  it('stages one private, path-free sidecar with explicit unavailable LLM Wiki state', async () => {
    const setup = await prepared();
    await setup.current.stage(setup.stage);
    const sidecarDirectory = path.join(stateRoot, 'semantic-sidecars');
    const sidecarFile = path.join(sidecarDirectory, `${IDS.transaction}.json`);
    const firstBytes = fs.readFileSync(sidecarFile, 'utf8');
    const sidecar = JSON.parse(firstBytes) as { effects: { llm_wiki: { status: string } } };

    expect(fs.statSync(sidecarDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(sidecarFile).mode & 0o777).toBe(0o600);
    expect(sidecar.effects.llm_wiki).toEqual({ status: 'unavailable' });
    expect(firstBytes).not.toContain(projectPath);
    expect(fs.existsSync(path.join(stateRoot, 'domain-proposals', 'queue.json'))).toBe(false);
    expect(readBrainIndex(hermesHome).entries).toEqual([]);
    expect(casCalls).toEqual([]);

    now = new Date('2026-07-20T00:01:00.000Z');
    await setup.current.stage(setup.stage);
    expect(fs.readFileSync(sidecarFile, 'utf8')).toBe(firstBytes);
  });

  it('commits and recovers idempotently with typed Brain identity, hash-only proposals, and exact CAS', async () => {
    const setup = await prepared();
    await setup.current.stage(setup.stage);
    await setup.current.commit(setup.lifecycle);

    const brain = readBrainIndex(hermesHome);
    expect(brain.entries).toHaveLength(1);
    expect(brain.entries[0]).toMatchObject({
      id: `project-${IDS.project}`,
      kind: PROJECT_BRAIN_KIND,
      author: 'eve',
      source: 'chat',
    });
    const brainBody = readEntryBody(hermesHome, brain.entries[0].id);
    expect(brain.entries[0].title).toBe('Atlas Research');
    expect(brainBody).toContain('# Project');
    expect(brainBody).toContain('Manifest ref: .command-eve/project.json');
    expect(brainBody).toContain(`Project ID: ${IDS.project}`);
    expect(brainBody).toContain(`Realm ID: ${IDS.realm}`);
    expect(brainBody).toContain(`Root ID: ${IDS.root}`);
    expect(brainBody).not.toContain(projectPath);
    expect(brainBody).not.toContain('Confidential Growth Idea');

    const queueFile = path.join(stateRoot, 'domain-proposals', 'queue.json');
    const queueBytes = fs.readFileSync(queueFile, 'utf8');
    const queue = JSON.parse(queueBytes) as { proposals: Array<Record<string, unknown>> };
    expect(queue.proposals).toHaveLength(1);
    expect(Object.keys(queue.proposals[0]).toSorted()).toEqual([
      'proposed_domains_sha256',
      'record_sha256',
      'transaction_id',
    ]);
    expect(queueBytes).not.toContain('Confidential Growth Idea');
    expect(queueBytes).not.toContain(projectPath);

    const expectedBinding = { project_id: IDS.project, workspace_root_ref: `root:${IDS.root}` };
    expect(binding).toEqual(expectedBinding);
    expect(casCalls).toEqual([
      {
        conversation_id: 'conversation-atlas',
        expected: null,
        expected_project_binding_revision: 0,
        expected_project_binding_receipt_id: null,
        project_binding_operation_id: IDS.transaction,
        next: expectedBinding,
      },
    ]);
    const sidecarFile = path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`);
    const committedSidecar = fs.readFileSync(sidecarFile, 'utf8');
    expect(JSON.parse(committedSidecar).effects).toMatchObject({
      brain: { status: 'applied' },
      proposal_queue: { status: 'applied' },
      conversation_binding: { status: 'applied', owned: true },
      llm_wiki: { status: 'unavailable' },
    });

    await setup.current.recover(setup.lifecycle);
    expect(casCalls).toHaveLength(1);
    expect(fs.readFileSync(sidecarFile, 'utf8')).toBe(committedSidecar);
    expect(fs.readFileSync(queueFile, 'utf8')).toBe(queueBytes);
    expect(readBrainIndex(hermesHome).entries).toHaveLength(1);
  });

  it('treats an exact prebound pair as idempotent without claiming or changing its revision', async () => {
    binding = { project_id: IDS.project, workspace_root_ref: `root:${IDS.root}` };
    bindingRevision = 9;
    bindingReceipt = '77777777-7777-4777-8777-777777777777';
    const setup = await prepared();

    expect(setup.result.binding).toMatchObject({
      initial_conversation_binding: binding,
      initial_project_binding_revision: 9,
      initial_project_binding_receipt_id: bindingReceipt,
    });
    await setup.current.stage(setup.stage);
    await setup.current.commit(setup.lifecycle);

    const sidecarFile = path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`);
    expect(JSON.parse(fs.readFileSync(sidecarFile, 'utf8')).effects.conversation_binding).toMatchObject({
      status: 'applied',
      expected: binding,
      expected_revision: 9,
      expected_receipt_id: bindingReceipt,
      next: binding,
      next_revision: 9,
      next_receipt_id: bindingReceipt,
      operation_id: IDS.transaction,
      owned: false,
    });
    expect(casCalls).toEqual([]);
    expect(bindingRevision).toBe(9);
    expect(bindingReceipt).toBe('77777777-7777-4777-8777-777777777777');

    await setup.current.rollback(setup.lifecycle);
    expect(binding).toEqual({ project_id: IDS.project, workspace_root_ref: `root:${IDS.root}` });
    expect(bindingRevision).toBe(9);
    expect(bindingReceipt).toBe('77777777-7777-4777-8777-777777777777');
    expect(casCalls).toEqual([]);
  });

  it('recovers response loss after an accepted binding CAS and rolls back idempotently', async () => {
    const setup = await prepared();
    await setup.current.stage(setup.stage);
    failAfterCasOnce = true;
    await expect(setup.current.commit(setup.lifecycle)).rejects.toThrow('simulated response loss');
    expect(binding).toEqual({ project_id: IDS.project, workspace_root_ref: `root:${IDS.root}` });

    await setup.current.recover(setup.lifecycle);
    expect(casCalls).toHaveLength(1);
    const sidecarFile = path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`);
    expect(JSON.parse(fs.readFileSync(sidecarFile, 'utf8')).effects.conversation_binding).toMatchObject({
      status: 'applied',
      owned: true,
    });

    await setup.current.rollback(setup.lifecycle);
    expect(binding).toBeNull();
    expect(casCalls).toHaveLength(2);
    expect(fs.existsSync(sidecarFile)).toBe(false);
    expect(readBrainIndex(hermesHome).entries).toEqual([]);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateRoot, 'domain-proposals', 'queue.json'), 'utf8')).proposals
    ).toEqual([]);

    await setup.current.rollback(setup.lifecycle);
    expect(casCalls).toHaveLength(2);
  });

  it('retains the strict sidecar through removal prepare and requires durable proof before finalization', async () => {
    const setup = await prepared();
    await setup.current.stage(setup.stage);
    await setup.current.commit(setup.lifecycle);
    const sidecarFile = path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`);

    await setup.current.prepareRemovalRollback(setup.lifecycle);
    expect(binding).toBeNull();
    expect(readBrainIndex(hermesHome).entries).toEqual([]);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateRoot, 'domain-proposals', 'queue.json'), 'utf8')).proposals
    ).toEqual([]);
    expect(fs.existsSync(sidecarFile)).toBe(true);

    let removalCommitted = false;
    const assertRemovalCommitted = vi.fn(() => {
      if (!removalCommitted) throw new ProjectWorkspaceError('workspace.recovery-required');
    });
    await expect(
      setup.current.finalizeRemovalRollback({
        ...setup.lifecycle,
        assert_removal_committed: assertRemovalCommitted,
      })
    ).rejects.toThrow('workspace.recovery-required');
    expect(fs.existsSync(sidecarFile)).toBe(true);

    removalCommitted = true;
    await setup.current.finalizeRemovalRollback({
      ...setup.lifecycle,
      assert_removal_committed: assertRemovalCommitted,
    });
    expect(fs.existsSync(sidecarFile)).toBe(false);
    expect(assertRemovalCommitted).toHaveBeenCalledTimes(4);
  });

  it('reasserts the lease immediately before the create-only sidecar write', async () => {
    const setup = await preparedWithLeaseHook();
    setup.lease.replace_at = 'sidecar:before-create';

    await expect(setup.current.stage(setup.stage)).rejects.toThrow('workspace.lease-invalid');

    expect(fs.existsSync(path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`))).toBe(false);
    expect(setup.assertLeaseAlive).toHaveBeenCalled();
  });

  it('reasserts the lease inside the sidecar lock immediately before an update', async () => {
    const setup = await preparedWithLeaseHook();
    await setup.current.stage(setup.stage);
    setup.lease.replace_at = 'sidecar:before-write';

    await expect(setup.current.commit(setup.lifecycle)).rejects.toThrow('workspace.lease-invalid');

    const sidecar = JSON.parse(
      fs.readFileSync(path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`), 'utf8')
    ) as { revision: number; effects: { brain: { status: string } } };
    expect(sidecar).toMatchObject({ revision: 0, effects: { brain: { status: 'planned' } } });
    expect(readBrainIndex(hermesHome).entries).toHaveLength(1);
    expect(fs.existsSync(path.join(stateRoot, 'domain-proposals', 'queue.json'))).toBe(false);
    expect(binding).toBeNull();
  });

  it('reasserts the lease inside the proposal queue lock immediately before its write', async () => {
    const setup = await preparedWithLeaseHook();
    await setup.current.stage(setup.stage);
    setup.lease.replace_at = 'proposal-queue:before-write';

    await expect(setup.current.commit(setup.lifecycle)).rejects.toThrow('workspace.lease-invalid');

    expect(fs.existsSync(path.join(stateRoot, 'domain-proposals', 'queue.json'))).toBe(false);
    expect(binding).toBeNull();
  });

  it('reasserts the lease at the binding CAS send boundary', async () => {
    const setup = await preparedWithLeaseHook();
    await setup.current.stage(setup.stage);
    setup.lease.replace_at = 'conversation-binding:before-cas';

    await expect(setup.current.commit(setup.lifecycle)).rejects.toThrow('workspace.lease-invalid');

    expect(binding).toBeNull();
    expect(casCalls).toEqual([]);
  });

  it('reasserts the lease at the rollback binding CAS send boundary', async () => {
    const setup = await preparedWithLeaseHook();
    await setup.current.stage(setup.stage);
    await setup.current.commit(setup.lifecycle);
    const callsBeforeRollback = casCalls.length;
    setup.lease.replace_at = 'rollback:conversation-binding:before-cas';

    await expect(setup.current.rollback(setup.lifecycle)).rejects.toThrow('workspace.lease-invalid');

    expect(binding).toEqual({ project_id: IDS.project, workspace_root_ref: `root:${IDS.root}` });
    expect(casCalls).toHaveLength(callsBeforeRollback);
    expect(readBrainIndex(hermesHome).entries).toHaveLength(1);
  });

  it('reasserts the lease inside rollback queue removal and immediately before sidecar unlink', async () => {
    const setup = await preparedWithLeaseHook();
    await setup.current.stage(setup.stage);
    await setup.current.commit(setup.lifecycle);
    const queueFile = path.join(stateRoot, 'domain-proposals', 'queue.json');
    const sidecarFile = path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`);
    setup.lease.replace_at = 'rollback:proposal-queue:before-write';

    await expect(setup.current.rollback(setup.lifecycle)).rejects.toThrow('workspace.lease-invalid');
    expect(JSON.parse(fs.readFileSync(queueFile, 'utf8')).proposals).toHaveLength(1);
    expect(readBrainIndex(hermesHome).entries).toHaveLength(1);
    expect(fs.existsSync(sidecarFile)).toBe(true);

    setup.lease.alive = true;
    await setup.current.prepareRemovalRollback(setup.lifecycle);
    setup.lease.replace_at = 'rollback:before-sidecar-unlink';
    await expect(
      setup.current.finalizeRemovalRollback({
        ...setup.lifecycle,
        assert_removal_committed: () => undefined,
      })
    ).rejects.toThrow('workspace.lease-invalid');
    expect(fs.existsSync(sidecarFile)).toBe(true);
  });

  it('rejects an exact-revision same-target transition owned by a different receipt', async () => {
    const setup = await prepared();
    await setup.current.stage(setup.stage);
    binding = { project_id: IDS.project, workspace_root_ref: `root:${IDS.root}` };
    bindingRevision = 1;
    bindingReceipt = '99999999-9999-4999-8999-999999999999';

    await expect(setup.current.commit(setup.lifecycle)).rejects.toThrow('semantic.bundle-mismatch');
    expect(casCalls).toEqual([]);
    const sidecarFile = path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`);
    expect(JSON.parse(fs.readFileSync(sidecarFile, 'utf8')).effects.conversation_binding).toMatchObject({
      status: 'planned',
      owned: false,
      next_revision: 1,
      next_receipt_id: IDS.transaction,
    });

    await expect(setup.current.rollback(setup.lifecycle)).rejects.toThrow('semantic.bundle-mismatch');
    expect(binding).toEqual({ project_id: IDS.project, workspace_root_ref: `root:${IDS.root}` });
    expect(bindingReceipt).toBe('99999999-9999-4999-8999-999999999999');
    expect(fs.existsSync(sidecarFile)).toBe(true);
  });

  it('retains queue ownership across a crash after record write and removes the record on rollback', async () => {
    let crashAt = 'proposal-queue:written';
    const current = coordinator((phase) => {
      if (phase === crashAt) {
        crashAt = '';
        throw new Error('simulated crash after proposal queue write');
      }
    });
    const setup = await prepared(current);
    await current.stage(setup.stage);

    await expect(current.commit(setup.lifecycle)).rejects.toThrow('simulated crash after proposal queue write');
    const queueFile = path.join(stateRoot, 'domain-proposals', 'queue.json');
    expect(JSON.parse(fs.readFileSync(queueFile, 'utf8')).proposals).toHaveLength(1);
    const sidecarFile = path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`);
    expect(JSON.parse(fs.readFileSync(sidecarFile, 'utf8')).effects.proposal_queue).toMatchObject({
      status: 'planned',
      created: true,
    });

    await current.recover(setup.lifecycle);
    expect(JSON.parse(fs.readFileSync(sidecarFile, 'utf8')).effects.proposal_queue).toMatchObject({
      status: 'applied',
      created: true,
    });
    await current.rollback(setup.lifecycle);
    expect(JSON.parse(fs.readFileSync(queueFile, 'utf8')).proposals).toEqual([]);
  });

  it('recovers an exact dangling Brain index plus staging body after publication failure', async () => {
    const setup = await prepared();
    await setup.current.stage(setup.stage);
    const expectedBodyPath = path.join(hermesHome, 'company-brain', 'entries', `project-${IDS.project}.md`);
    const originalLink = fs.linkSync;
    let failOnce = true;
    const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((existingPath, newPath) => {
      if (failOnce && String(newPath) === expectedBodyPath) {
        failOnce = false;
        const error = new Error('simulated crash before Brain staging publication') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return originalLink(existingPath, newPath);
    });

    await expect(setup.current.commit(setup.lifecycle)).rejects.toThrow(
      'failed to promote the SYSTEM entry staging body'
    );
    linkSpy.mockRestore();
    expect(readBrainIndex(hermesHome).entries).toHaveLength(1);
    expect(readEntryBody(hermesHome, `project-${IDS.project}`)).toBeNull();
    expect(fs.existsSync(path.join(hermesHome, 'company-brain', 'entries', `.staging-project-${IDS.project}.md`))).toBe(
      true
    );

    await expect(setup.current.recover(setup.lifecycle)).resolves.toBeUndefined();
    expect(readEntryBody(hermesHome, `project-${IDS.project}`)).toContain(`Project ID: ${IDS.project}`);
    expect(fs.existsSync(path.join(hermesHome, 'company-brain', 'entries', `.staging-project-${IDS.project}.md`))).toBe(
      false
    );
    await setup.current.rollback(setup.lifecycle);
    expect(readBrainIndex(hermesHome).entries).toEqual([]);
  });

  it('rejects tampered sidecar effects before rollback can redirect any mutation', async () => {
    const setup = await prepared();
    await setup.current.stage(setup.stage);
    await setup.current.commit(setup.lifecycle);
    const sidecarFile = path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) as {
      effects: {
        brain: { entry_id: string };
        conversation_binding: {
          expected: PortableProjectBinding | null;
          next: PortableProjectBinding;
          owned: boolean;
        };
      };
    };
    sidecar.effects.brain.entry_id = `project-${IDS.otherProject}`;
    sidecar.effects.conversation_binding.expected = null;
    sidecar.effects.conversation_binding.next = {
      project_id: IDS.otherProject,
      workspace_root_ref: `root:${IDS.otherRoot}`,
    };
    sidecar.effects.conversation_binding.owned = true;
    fs.writeFileSync(sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');

    await expect(setup.current.rollback(setup.lifecycle)).rejects.toThrow('semantic.bundle-mismatch');
    expect(readBrainIndex(hermesHome).entries.map((entry) => entry.id)).toEqual([`project-${IDS.project}`]);
    expect(binding).toEqual({ project_id: IDS.project, workspace_root_ref: `root:${IDS.root}` });
  });

  it('preserves a raw Brain body replacement that wins immediately before exact rollback removal', async () => {
    const replacement = '# Latest raw EVE body\n\nkeep this content\n';
    let replaceOnRollback = false;
    const current = coordinator((phase) => {
      if (phase !== 'rollback:brain:before-remove' || !replaceOnRollback) return;
      replaceOnRollback = false;
      const entriesDirectory = path.join(hermesHome, 'company-brain', 'entries');
      const bodyPath = path.join(entriesDirectory, `project-${IDS.project}.md`);
      const replacementPath = path.join(entriesDirectory, '.raw-eve-replacement.md');
      fs.writeFileSync(replacementPath, replacement, 'utf8');
      fs.renameSync(replacementPath, bodyPath);
    });
    const setup = await prepared(current);
    await current.stage(setup.stage);
    await current.commit(setup.lifecycle);
    replaceOnRollback = true;

    await expect(current.rollback(setup.lifecycle)).rejects.toThrow('semantic.bundle-mismatch');

    expect(readEntryBody(hermesHome, `project-${IDS.project}`)).toBe(replacement);
    expect(readBrainIndex(hermesHome).entries.map((entry) => entry.id)).toEqual([`project-${IDS.project}`]);
  });

  it.each([
    'rollback:conversation-binding',
    'rollback:proposal-queue',
    'rollback:brain',
    'rollback:before-sidecar-unlink',
  ])('retries rollback idempotently after a crash at %s', async (phaseToCrash) => {
    let crashAt = '';
    const current = coordinator((phase) => {
      if (phase === crashAt) {
        crashAt = '';
        throw new Error(`simulated crash at ${phase}`);
      }
    });
    const setup = await prepared(current);
    await current.stage(setup.stage);
    await current.commit(setup.lifecycle);
    crashAt = phaseToCrash;

    await expect(current.rollback(setup.lifecycle)).rejects.toThrow(`simulated crash at ${phaseToCrash}`);
    await expect(current.rollback(setup.lifecycle)).resolves.toBeUndefined();

    expect(binding).toBeNull();
    expect(readBrainIndex(hermesHome).entries).toEqual([]);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateRoot, 'domain-proposals', 'queue.json'), 'utf8')).proposals
    ).toEqual([]);
    expect(fs.existsSync(path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`))).toBe(false);
  });

  it('preserves a manual conversation rebind while removing only coordinator-owned effects', async () => {
    const setup = await prepared();
    await setup.current.stage(setup.stage);
    await setup.current.commit(setup.lifecycle);
    const manualBinding: PortableProjectBinding = {
      project_id: IDS.otherProject,
      workspace_root_ref: `root:${IDS.otherRoot}`,
    };
    binding = manualBinding;
    bindingRevision += 1;
    bindingReceipt = '88888888-8888-4888-8888-888888888888';
    const callsBeforeRollback = casCalls.length;

    await setup.current.rollback(setup.lifecycle);

    expect(binding).toEqual(manualBinding);
    expect(casCalls).toHaveLength(callsBeforeRollback);
    expect(readBrainIndex(hermesHome).entries).toEqual([]);
    expect(fs.existsSync(path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`))).toBe(false);
  });

  it('fails closed on a same-pair binding ABA instead of removing a still-bound project', async () => {
    const setup = await prepared();
    await setup.current.stage(setup.stage);
    await setup.current.commit(setup.lifecycle);
    bindingRevision += 2;
    bindingReceipt = '88888888-8888-4888-8888-888888888888';
    const callsBeforeRollback = casCalls.length;

    await expect(setup.current.rollback(setup.lifecycle)).rejects.toThrow('semantic.bundle-mismatch');

    expect(binding).toEqual({ project_id: IDS.project, workspace_root_ref: `root:${IDS.root}` });
    expect(casCalls).toHaveLength(callsBeforeRollback);
    expect(readBrainIndex(hermesHome).entries.map((entry) => entry.id)).toEqual([`project-${IDS.project}`]);
    expect(fs.existsSync(path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`))).toBe(true);
  });

  it('releases every keyed serializer tail after many distinct transactions', async () => {
    const serializer = createProjectSemanticOperationSerializer();
    const completed: number[] = [];
    await Promise.all(
      Array.from({ length: 256 }, (_, index) =>
        serializer.run(`transaction-${index}`, async () => {
          await Promise.resolve();
          completed.push(index);
        })
      )
    );
    expect(completed).toHaveLength(256);
    expect(serializer.active_count()).toBe(0);
  });
});
