import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectIntentPlan } from '@/common/types/project-workspace/intent';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import { readBrainIndex } from '@process/commandEve/companyBrainStoreCore';
import { ProjectWorkspaceService } from '@process/services/project-workspace/ProjectWorkspaceService';
import type { ProjectSemanticCoordinator } from '@process/services/project-workspace/core/semanticBundleCore';
import type { ProjectConversationBindingClient } from '@process/services/project-workspace/runtime/conversationBindingClient';
import { createProjectSemanticCoordinator } from '@process/services/project-workspace/semantic/projectSemanticCoordinator';
import { ProjectWorkspaceRegistryStore } from '@process/services/project-workspace/storage/registryStore';
import { isProjectLeaseReleased } from '@process/services/project-workspace/transaction/leaseStore';

const IDS = {
  conversation: 'conversation-atlas',
  realm: '11111111-1111-4111-8111-111111111111',
  root: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
  transaction: '44444444-4444-4444-8444-444444444444',
} as const;

function plan(): ProjectIntentPlan {
  return {
    action: 'create',
    conversation_id: IDS.conversation,
    seat_id: 'seat-alpha',
    realm_id: IDS.realm,
    realm_label: 'Business',
    realm_path_slug: 'business',
    root_id: IDS.root,
    project_id: IDS.project,
    title: 'Atlas Research',
    slug: 'atlas-research',
    domain_ids: ['domain:research'],
    proposed_domains: [],
    confidence: 1,
    workspace_root_ref: `root:${IDS.root}`,
    existing_candidates: [],
    needs_human_confirmation: false,
    question_count: 0,
    snapshot: {
      seat_id: 'seat-alpha',
      realm_id: IDS.realm,
      root_id: IDS.root,
      workspace_root_ref: `root:${IDS.root}`,
      realm_revision: 1,
      root_revision: 1,
      project_catalog_revision: 0,
    },
  };
}

const semanticCoordinator: ProjectSemanticCoordinator = {
  preflight: async ({ transaction_id }) => ({
    ok: true,
    extension_bundle_sha256: 'e'.repeat(64),
    effect_plan_sha256: 'a'.repeat(64),
    initial_conversation_binding: null,
    initial_project_binding_revision: 0,
    initial_project_binding_receipt_id: null,
    preflight_receipt_id: 'test-boundary-pass:v1',
    semantic_context_ref: `context:${transaction_id}`,
    semantic_context_sha256: 'f'.repeat(64),
  }),
  stage: async ({ assert_mutation_allowed }) => assert_mutation_allowed(),
  commit: async ({ assert_mutation_allowed }) => assert_mutation_allowed(),
  recover: async ({ assert_mutation_allowed }) => assert_mutation_allowed(),
  rollback: async ({ assert_mutation_allowed }) => assert_mutation_allowed(),
  prepareRemovalRollback: async ({ assert_mutation_allowed }) => assert_mutation_allowed(),
  finalizeRemovalRollback: async ({ assert_mutation_allowed, assert_removal_committed }) => {
    assert_mutation_allowed();
    assert_removal_committed();
  },
};

type DurableCoordinatorHooks = {
  crash_stage_once?: boolean;
  crash_commit_once?: boolean;
  stage_calls: number;
  commit_calls: number;
  recover_calls: number;
  rollback_calls: number;
};

function canonicalSha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function semanticContextForTest(input: Parameters<ProjectSemanticCoordinator['preflight']>[0]) {
  return {
    schema_version: 'test-project-semantic-context/v1',
    operation: input.operation,
    transaction_id: input.transaction_id,
    conversation_id: input.conversation_id,
    identity: input.identity,
    manifest: input.manifest,
    proposed_domains: input.proposed_domains,
    proposed_domains_sha256: input.proposed_domains_sha256,
    base_bundle_sha256: input.base_bundle_sha256,
  };
}

function durableCoordinator(directory: string, hooks: DurableCoordinatorHooks): ProjectSemanticCoordinator {
  const sidecarPath = (ref: string) => path.join(directory, `${ref}.json`);
  const markerPath = (ref: string) => path.join(directory, `${ref}.committed.json`);
  const readVerified = (input: Parameters<ProjectSemanticCoordinator['commit']>[0]) => {
    const file = sidecarPath(input.binding.semantic_context_ref);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ProjectWorkspaceError('semantic.bundle-mismatch');
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      context: Record<string, unknown>;
      binding: typeof input.binding;
    };
    if (
      envelope.context.transaction_id !== input.transaction_id ||
      envelope.context.conversation_id !== input.conversation_id ||
      JSON.stringify(envelope.context.identity) !== JSON.stringify(input.identity) ||
      canonicalSha256(envelope.context) !== input.binding.semantic_context_sha256 ||
      JSON.stringify(envelope.binding) !== JSON.stringify(input.binding)
    ) {
      throw new ProjectWorkspaceError('semantic.bundle-mismatch');
    }
    return envelope;
  };
  const commitMarker = (input: Parameters<ProjectSemanticCoordinator['commit']>[0]) => {
    input.assert_mutation_allowed();
    const contents = `${JSON.stringify({ bundle_sha256: input.binding.bundle_sha256 }, null, 2)}\n`;
    const file = markerPath(input.binding.semantic_context_ref);
    try {
      fs.writeFileSync(file, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== contents) throw error;
    }
  };
  return {
    preflight: async (input) => {
      const context = semanticContextForTest(input);
      return {
        ok: true,
        extension_bundle_sha256: 'e'.repeat(64),
        effect_plan_sha256: 'a'.repeat(64),
        initial_conversation_binding: null,
        initial_project_binding_revision: 0,
        initial_project_binding_receipt_id: null,
        preflight_receipt_id: 'test-boundary-pass:v1',
        semantic_context_ref: `context:${input.transaction_id}`,
        semantic_context_sha256: canonicalSha256(context),
      };
    },
    stage: async (input) => {
      hooks.stage_calls += 1;
      input.assert_mutation_allowed();
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const context = semanticContextForTest(input);
      if (canonicalSha256(context) !== input.binding.semantic_context_sha256) {
        throw new ProjectWorkspaceError('semantic.bundle-mismatch');
      }
      const contents = `${JSON.stringify({ context, binding: input.binding }, null, 2)}\n`;
      const file = sidecarPath(input.binding.semantic_context_ref);
      try {
        fs.writeFileSync(file, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== contents)
          throw error;
      }
      if (hooks.crash_stage_once) {
        hooks.crash_stage_once = false;
        throw new Error('SIMULATED_SEMANTIC_STAGE_CRASH');
      }
    },
    commit: async (input) => {
      hooks.commit_calls += 1;
      readVerified(input);
      commitMarker(input);
      if (hooks.crash_commit_once) {
        hooks.crash_commit_once = false;
        throw new Error('SIMULATED_SEMANTIC_COMMIT_CRASH');
      }
    },
    recover: async (input) => {
      hooks.recover_calls += 1;
      readVerified(input);
      commitMarker(input);
    },
    rollback: async (input) => {
      hooks.rollback_calls += 1;
      const sidecar = sidecarPath(input.binding.semantic_context_ref);
      const marker = markerPath(input.binding.semantic_context_ref);
      if (!fs.existsSync(sidecar) && !fs.existsSync(marker)) return;
      readVerified(input);
      for (const file of [marker, sidecar]) {
        if (!fs.existsSync(file)) continue;
        input.assert_mutation_allowed();
        fs.unlinkSync(file);
      }
    },
    prepareRemovalRollback: async (input) => {
      hooks.rollback_calls += 1;
      const sidecar = sidecarPath(input.binding.semantic_context_ref);
      const marker = markerPath(input.binding.semantic_context_ref);
      if (!fs.existsSync(sidecar) && !fs.existsSync(marker)) return;
      readVerified(input);
      if (fs.existsSync(marker)) {
        input.assert_mutation_allowed();
        fs.unlinkSync(marker);
      }
    },
    finalizeRemovalRollback: async (input) => {
      input.assert_removal_committed();
      const sidecar = sidecarPath(input.binding.semantic_context_ref);
      const marker = markerPath(input.binding.semantic_context_ref);
      if (!fs.existsSync(sidecar) && !fs.existsSync(marker)) return;
      readVerified(input);
      if (fs.existsSync(marker)) {
        input.assert_mutation_allowed();
        fs.unlinkSync(marker);
      }
      if (fs.existsSync(sidecar)) {
        input.assert_mutation_allowed();
        input.assert_removal_committed();
        fs.unlinkSync(sidecar);
      }
    },
  };
}

function simulateLeaseOwnerDeath(stateRoot: string): void {
  const leaseDirectory = path.join(stateRoot, 'leases');
  if (!fs.existsSync(leaseDirectory)) return;
  for (const name of fs.readdirSync(leaseDirectory).filter((entry) => entry.endsWith('.lease.json'))) {
    const file = path.join(leaseDirectory, name);
    const lease = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(file, `${JSON.stringify({ ...lease, owner_pid: 2_147_483_647 }, null, 2)}\n`, 'utf8');
  }
}

function crashAtPromotion(phase: string): void {
  if (phase === 'promoted') throw new Error('SIMULATED_CRASH');
}

describe('project workspace transaction and recovery', () => {
  let stateRoot: string;
  let projectRoot: string;
  let activeSeat: string;
  let now: Date;
  let registry: ProjectWorkspaceRegistryStore;

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-state-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-work-'));
    activeSeat = 'seat-alpha';
    now = new Date('2026-07-20T00:00:00.000Z');
    registry = new ProjectWorkspaceRegistryStore({
      state_root: stateRoot,
      now: () => now,
    });
    registry.initializeSeat(activeSeat);
    registry.upsertRealm({
      seat_id: activeSeat,
      expected_revision: 0,
      realm: {
        realm_id: IDS.realm,
        label: 'Business',
        path_slug: 'business',
        status: 'active',
        order: 0,
      },
    });
    registry.registerRoot({
      seat_id: activeSeat,
      expected_seat_revision: 0,
      expected_global_revision: 0,
      root: {
        root_id: IDS.root,
        realm_id: IDS.realm,
        label: 'Projects',
        kind: 'app_managed',
        path: projectRoot,
        status: 'active',
      },
    });
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function service(
    onPhase?: (phase: string) => void,
    coordinator: ProjectSemanticCoordinator | null = semanticCoordinator
  ): ProjectWorkspaceService {
    return new ProjectWorkspaceService({
      registry,
      get_active_seat_id: () => activeSeat,
      now: () => now,
      random_uuid: () => IDS.transaction,
      on_phase: onPhase,
      ...(coordinator ? { semantic_coordinator: coordinator } : {}),
    });
  }

  it('stages and promotes exactly one complete scaffold with a durable receipt', async () => {
    const proposalLabel = 'Confidential Growth Idea';
    const result = await service().create({
      ...plan(),
      proposed_domains: [{ label: proposalLabel, status: 'proposed' }],
    });
    expect(result).toMatchObject({ ok: true, committed: true });
    if (!result.ok) throw new Error(result.reason_code);
    const expected = [
      '.command-eve/project.json',
      'AGENTS.md',
      'memory-bank/system-index.md',
      'memory-bank/projectbrief.md',
      'memory-bank/activeContext.md',
      'memory-bank/progress.md',
      'memory-bank/knowledge-index.md',
      'docs/wiki/project.md',
      'docs/decisions/README.md',
      'docs/page-index.md',
    ];
    for (const relativePath of expected) {
      expect(fs.existsSync(path.join(result.project_path, relativePath)), relativePath).toBe(true);
    }
    expect(fs.existsSync(result.receipt_path)).toBe(true);
    const persistedContractFiles = [
      path.join(result.project_path, '.command-eve', 'project.json'),
      result.receipt_path,
      path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`),
    ];
    for (const file of persistedContractFiles) expect(fs.readFileSync(file, 'utf8')).not.toContain(proposalLabel);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
  });

  it('fails closed without a semantic coordinator and persists no proposal payload', async () => {
    const proposed = {
      ...plan(),
      proposed_domains: [{ label: 'Confidential Growth Idea', status: 'proposed' as const }],
    };
    expect(await service(undefined, null).create(proposed)).toMatchObject({
      ok: false,
      reason_code: 'semantic.coordinator-required',
    });
    expect(fs.existsSync(path.join(projectRoot, proposed.slug))).toBe(false);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
    const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
    const journal = fs.readFileSync(journalFile, 'utf8');
    expect(journal).not.toContain('Confidential Growth Idea');
    expect(JSON.parse(journal)).toMatchObject({ phase: 'undone', conversation_id: IDS.conversation });
    const leaseFiles = fs.readdirSync(path.join(stateRoot, 'leases')).filter((name) => name.endsWith('.lease.json'));
    expect(leaseFiles).toHaveLength(1);
    expect(isProjectLeaseReleased(path.join(stateRoot, 'leases', leaseFiles[0]))).toBe(true);
  });

  it('rechecks the immutable seat snapshot after pure semantic preflight and before stage', async () => {
    let stageCalls = 0;
    const switchingCoordinator: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      preflight: async (input) => {
        activeSeat = 'seat-beta';
        return await semanticCoordinator.preflight(input);
      },
      stage: async () => {
        stageCalls += 1;
      },
    };
    expect(await service(undefined, switchingCoordinator).create(plan())).toMatchObject({
      ok: false,
      reason_code: 'seat.changed',
    });
    expect(stageCalls).toBe(0);
    expect(fs.existsSync(path.join(projectRoot, 'atlas-research'))).toBe(false);
    expect(registry.readSeatCatalogs('seat-alpha').projects.projects).toHaveLength(0);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`), 'utf8'))
    ).toMatchObject({ phase: 'leased' });
  });

  it.each([
    ['seat_id', (value: ProjectIntentPlan) => ({ ...value.snapshot, seat_id: 'seat-beta' }), 'seat.changed'],
    [
      'realm_id',
      (value: ProjectIntentPlan) => ({ ...value.snapshot, realm_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
      'identity.invalid',
    ],
    [
      'root_id',
      (value: ProjectIntentPlan) => ({ ...value.snapshot, root_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
      'identity.invalid',
    ],
    [
      'workspace_root_ref',
      (value: ProjectIntentPlan) => ({
        ...value.snapshot,
        workspace_root_ref: 'root:cccccccc-cccc-4ccc-8ccc-cccccccccccc' as const,
      }),
      'identity.invalid',
    ],
    [
      'realm_revision',
      (value: ProjectIntentPlan) => ({ ...value.snapshot, realm_revision: value.snapshot.realm_revision + 1 }),
      'catalog.revision-conflict',
    ],
    [
      'root_revision',
      (value: ProjectIntentPlan) => ({ ...value.snapshot, root_revision: value.snapshot.root_revision + 1 }),
      'catalog.revision-conflict',
    ],
    [
      'project_catalog_revision',
      (value: ProjectIntentPlan) => ({
        ...value.snapshot,
        project_catalog_revision: value.snapshot.project_catalog_revision + 1,
      }),
      'catalog.revision-conflict',
    ],
  ] as const)('binds immutable snapshot field %s before journal or lease mutation', async (_field, mutate, reason) => {
    const baseline = plan();
    const result = await service().create({ ...baseline, snapshot: mutate(baseline) });
    expect(result).toMatchObject({ ok: false, reason_code: reason });
    expect(fs.existsSync(path.join(projectRoot, baseline.slug))).toBe(false);
    expect(fs.existsSync(path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`))).toBe(false);
    const leaseDirectory = path.join(stateRoot, 'leases');
    expect(
      fs.existsSync(leaseDirectory) ? fs.readdirSync(leaseDirectory).filter((name) => name.endsWith('.lease.json')) : []
    ).toEqual([]);
  });

  it('heartbeats a live lease throughout an arbitrarily long async semantic stage', async () => {
    let leaseNowMs = 1_000;
    let releaseStage: (() => void) | undefined;
    let announceStage: (() => void) | undefined;
    const stageStarted = new Promise<void>((resolve) => (announceStage = resolve));
    const stageRelease = new Promise<void>((resolve) => (releaseStage = resolve));
    const delayedCoordinator: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      stage: async ({ assert_mutation_allowed }) => {
        announceStage?.();
        await stageRelease;
        assert_mutation_allowed();
      },
    };
    const provisioner = new ProjectWorkspaceService({
      registry,
      get_active_seat_id: () => activeSeat,
      now: () => now,
      lease_now_ms: () => leaseNowMs,
      random_uuid: () => IDS.transaction,
      lease_ttl_ms: 1_000,
      semantic_coordinator: delayedCoordinator,
    });
    const creation = provisioner.create(plan());
    await stageStarted;
    leaseNowMs = 2_500;
    await new Promise((resolve) => setTimeout(resolve, 450));

    const leaseDirectory = path.join(stateRoot, 'leases');
    const leaseFile = path.join(
      leaseDirectory,
      fs.readdirSync(leaseDirectory).find((name) => name.endsWith('.lease.json')) as string
    );
    expect(JSON.parse(fs.readFileSync(leaseFile, 'utf8'))).toMatchObject({
      heartbeat_at_ms: 2_500,
      expires_at_ms: 3_500,
      released_at_ms: null,
    });
    expect(await service(undefined, delayedCoordinator).recoverAll()).toContainEqual(
      expect.objectContaining({ ok: false, reason_code: 'workspace.concurrent-operation' })
    );

    releaseStage?.();
    expect(await creation).toMatchObject({ ok: true, committed: true });
  });

  it('stops after a delayed stage binding read when its lease is replaced', async () => {
    const hermesHome = path.join(stateRoot, 'hermes-home');
    let readCount = 0;
    let casCalls = 0;
    let announceStageRead: (() => void) | undefined;
    let releaseStageRead: (() => void) | undefined;
    const stageReadStarted = new Promise<void>((resolve) => (announceStageRead = resolve));
    const stageReadRelease = new Promise<void>((resolve) => (releaseStageRead = resolve));
    const bindingClient: ProjectConversationBindingClient = {
      read: async () => {
        readCount += 1;
        if (readCount === 2) {
          announceStageRead?.();
          await stageReadRelease;
        }
        return {
          binding: null,
          project_binding_revision: 0,
          project_binding_receipt_id: null,
        };
      },
      compareAndSwap: async () => {
        casCalls += 1;
        throw new Error('binding CAS must remain unreachable after lease replacement');
      },
    };
    const coordinator = createProjectSemanticCoordinator({
      state_root: stateRoot,
      binding_client: bindingClient,
      get_active_seat_id: () => activeSeat,
      resolve_hermes_home: () => hermesHome,
      now: () => now,
    });
    const creation = service(undefined, coordinator).create(plan());
    await stageReadStarted;

    const leaseDirectory = path.join(stateRoot, 'leases');
    const leaseFile = path.join(
      leaseDirectory,
      fs.readdirSync(leaseDirectory).find((name) => name.endsWith('.lease.json')) as string
    );
    const currentLease = JSON.parse(fs.readFileSync(leaseFile, 'utf8')) as Record<string, unknown>;
    const successorBytes = `${JSON.stringify({ ...currentLease, owner_token_sha256: 'f'.repeat(64) }, null, 2)}\n`;
    const successorTemp = path.join(leaseDirectory, '.successor-lease.tmp');
    fs.writeFileSync(successorTemp, successorBytes, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(successorTemp, leaseFile);
    releaseStageRead?.();

    expect(await creation).toMatchObject({
      ok: false,
      reason_code: 'workspace.concurrent-operation',
      recovery_required: true,
    });
    expect(fs.existsSync(path.join(stateRoot, 'semantic-sidecars', `${IDS.transaction}.json`))).toBe(false);
    expect(readBrainIndex(hermesHome).entries).toEqual([]);
    expect(fs.existsSync(path.join(stateRoot, 'domain-proposals', 'queue.json'))).toBe(false);
    expect(casCalls).toBe(0);
    expect(fs.existsSync(path.join(projectRoot, `.command-eve-stage-${IDS.transaction}`))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, plan().slug))).toBe(false);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toEqual([]);
    expect(fs.readFileSync(leaseFile, 'utf8')).toBe(successorBytes);
  });

  it('is idempotent for project identity and normalized target', async () => {
    expect(await service().create(plan())).toMatchObject({ ok: true, committed: true });
    expect(await service().create(plan())).toMatchObject({ ok: true, already_existed: true });
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
  });

  it('invalidates an immutable plan after a seat switch before promotion', async () => {
    const result = await service((phase) => {
      if (phase === 'staged') activeSeat = 'seat-beta';
    }).create(plan());
    expect(result).toMatchObject({ ok: false, reason_code: 'seat.changed' });
    expect(fs.existsSync(path.join(projectRoot, 'atlas-research'))).toBe(false);
    expect(registry.readSeatCatalogs('seat-alpha').projects.projects).toHaveLength(0);
  });

  it('skips foreign-seat journals during boot recovery (1.818 CAO-P2: recoverAll only on the boot seat)', async () => {
    const betaRealm = '55555555-5555-4555-8555-555555555555';
    const betaRootId = '66666666-6666-4666-8666-666666666666';
    const betaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-beta-'));
    try {
      registry.initializeSeat('seat-beta');
      registry.upsertRealm({
        seat_id: 'seat-beta',
        expected_revision: 0,
        realm: { realm_id: betaRealm, label: 'Beta', path_slug: 'beta', status: 'active', order: 0 },
      });
      registry.registerRoot({
        seat_id: 'seat-beta',
        expected_seat_revision: registry.readSeatCatalogs('seat-beta').roots.revision,
        expected_global_revision: registry.readGlobalRoots().revision,
        root: {
          root_id: betaRootId,
          realm_id: betaRealm,
          label: 'Beta Projects',
          kind: 'app_managed',
          path: betaRoot,
          status: 'active',
        },
      });
      // A crashed create under seat-beta leaves a seat-beta journal behind.
      activeSeat = 'seat-beta';
      const betaPlan: ProjectIntentPlan = {
        ...plan(),
        seat_id: 'seat-beta',
        realm_id: betaRealm,
        root_id: betaRootId,
        workspace_root_ref: `root:${betaRootId}`,
        snapshot: {
          seat_id: 'seat-beta',
          realm_id: betaRealm,
          root_id: betaRootId,
          workspace_root_ref: `root:${betaRootId}`,
          realm_revision: 1,
          root_revision: 1,
          project_catalog_revision: 0,
        },
      };
      const crashing = service((phase) => {
        if (phase === 'promoted') throw new Error('SIMULATED_CRASH');
      });
      await expect(crashing.create(betaPlan)).rejects.toThrow('SIMULATED_CRASH');
      const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
      const crashedJournal = fs.readFileSync(journalFile, 'utf8');
      expect(JSON.parse(crashedJournal)).toMatchObject({
        phase: 'promoted',
        identity: expect.objectContaining({ seat_id: 'seat-beta' }),
      });

      // Boot under seat-alpha: the foreign-seat journal must be ignored
      // entirely — no recovery attempt, no failure entry, no journal mutation.
      activeSeat = 'seat-alpha';
      expect(await service().recoverAll()).toEqual([]);
      expect(fs.readFileSync(journalFile, 'utf8')).toBe(crashedJournal);
      expect(registry.readSeatCatalogs('seat-beta').projects.projects).toHaveLength(0);
    } finally {
      fs.rmSync(betaRoot, { recursive: true, force: true });
    }
  });

  it('aborts a boot-seat recovery pass before journal mutation when the active seat changes', async () => {
    const alphaTransaction = '11111111-1111-4111-8111-111111111111';
    const betaTransaction = '99999999-9999-4999-8999-999999999999';
    const betaRealm = '55555555-5555-4555-8555-555555555555';
    const betaRootId = '66666666-6666-4666-8666-666666666666';
    const betaProjectId = '77777777-7777-4777-8777-777777777777';
    const betaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-beta-switch-'));
    try {
      registry.initializeSeat('seat-beta');
      registry.upsertRealm({
        seat_id: 'seat-beta',
        expected_revision: 0,
        realm: { realm_id: betaRealm, label: 'Beta', path_slug: 'beta', status: 'active', order: 0 },
      });
      registry.registerRoot({
        seat_id: 'seat-beta',
        expected_seat_revision: registry.readSeatCatalogs('seat-beta').roots.revision,
        expected_global_revision: registry.readGlobalRoots().revision,
        root: {
          root_id: betaRootId,
          realm_id: betaRealm,
          label: 'Beta Projects',
          kind: 'app_managed',
          path: betaRoot,
          status: 'active',
        },
      });

      const createService = (transactionId: string, onPhase: (phase: string) => void) =>
        new ProjectWorkspaceService({
          registry,
          get_active_seat_id: () => activeSeat,
          now: () => now,
          random_uuid: () => transactionId,
          on_phase: onPhase,
          semantic_coordinator: semanticCoordinator,
        });

      activeSeat = 'seat-beta';
      const betaPlan: ProjectIntentPlan = {
        ...plan(),
        seat_id: 'seat-beta',
        realm_id: betaRealm,
        root_id: betaRootId,
        project_id: betaProjectId,
        workspace_root_ref: `root:${betaRootId}`,
        snapshot: {
          seat_id: 'seat-beta',
          realm_id: betaRealm,
          root_id: betaRootId,
          workspace_root_ref: `root:${betaRootId}`,
          realm_revision: 1,
          root_revision: 1,
          project_catalog_revision: 0,
        },
      };
      await expect(createService(betaTransaction, crashAtPromotion).create(betaPlan)).rejects.toThrow(
        'SIMULATED_CRASH'
      );

      activeSeat = 'seat-alpha';
      await expect(createService(alphaTransaction, crashAtPromotion).create(plan())).rejects.toThrow('SIMULATED_CRASH');
      simulateLeaseOwnerDeath(stateRoot);
      now = new Date(now.getTime() + 31_000);

      const alphaJournal = path.join(stateRoot, 'transactions', `${alphaTransaction}.journal.json`);
      const betaJournal = path.join(stateRoot, 'transactions', `${betaTransaction}.journal.json`);
      const betaLease = fs
        .readdirSync(path.join(stateRoot, 'leases'))
        .filter((name) => name.endsWith('.lease.json'))
        .map((name) => path.join(stateRoot, 'leases', name))
        .find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).transaction_id === betaTransaction);
      if (!betaLease) throw new Error('beta lease missing');
      const alphaBefore = fs.readFileSync(alphaJournal, 'utf8');
      const betaBefore = fs.readFileSync(betaJournal, 'utf8');
      const betaLeaseBefore = fs.readFileSync(betaLease, 'utf8');
      const recovering = new ProjectWorkspaceService({
        registry,
        get_active_seat_id: () => activeSeat,
        now: () => now,
        on_phase: (phase) => {
          if (phase === 'recovery:lease:acquired') activeSeat = 'seat-beta';
        },
        semantic_coordinator: semanticCoordinator,
      });

      expect(await recovering.recoverAll()).toEqual([
        { ok: false, reason_code: 'seat.changed', transaction_id: alphaTransaction },
      ]);
      expect(fs.readFileSync(alphaJournal, 'utf8')).toBe(alphaBefore);
      expect(fs.readFileSync(betaJournal, 'utf8')).toBe(betaBefore);
      expect(fs.readFileSync(betaLease, 'utf8')).toBe(betaLeaseBefore);
      expect(registry.readSeatCatalogs('seat-beta').projects.projects).toEqual([]);
    } finally {
      fs.rmSync(betaRoot, { recursive: true, force: true });
    }
  });

  it('rejects recovery with a semantic receipt when the coordinator is unavailable', async () => {
    const crashing = service((phase) => {
      if (phase === 'promoted') throw new Error('SIMULATED_CRASH');
    });
    await expect(crashing.create(plan())).rejects.toThrow('SIMULATED_CRASH');
    simulateLeaseOwnerDeath(stateRoot);
    now = new Date(now.getTime() + 31_000);
    expect(await service(undefined, null).recoverAll()).toContainEqual({
      ok: false,
      reason_code: 'semantic.coordinator-required',
      transaction_id: IDS.transaction,
    });
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
    expect(await service().recoverAll()).toContainEqual(
      expect.objectContaining({ ok: true, action: 'reconciled', transaction_id: IDS.transaction })
    );
  });

  it('replays a crashed semantic commit from a hash-bound private sidecar exactly once', async () => {
    const sidecarDirectory = path.join(stateRoot, 'semantic-sidecars');
    const firstHooks: DurableCoordinatorHooks = {
      crash_commit_once: true,
      stage_calls: 0,
      commit_calls: 0,
      recover_calls: 0,
      rollback_calls: 0,
    };
    const proposed = {
      ...plan(),
      proposed_domains: [{ label: 'Possible Growth Domain', status: 'proposed' as const }],
    };
    await expect(service(undefined, durableCoordinator(sidecarDirectory, firstHooks)).create(proposed)).rejects.toThrow(
      'SIMULATED_SEMANTIC_COMMIT_CRASH'
    );
    expect(firstHooks).toMatchObject({ stage_calls: 1, commit_calls: 1, recover_calls: 0 });
    const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
    const crashedJournal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, string>;
    expect(crashedJournal).toMatchObject({ phase: 'promoted', conversation_id: IDS.conversation });
    expect(JSON.stringify(crashedJournal)).not.toContain('Possible Growth Domain');
    const sidecarFile = path.join(sidecarDirectory, `${crashedJournal.semantic_context_ref}.json`);
    expect(fs.readFileSync(sidecarFile, 'utf8')).toContain('Possible Growth Domain');

    simulateLeaseOwnerDeath(stateRoot);
    now = new Date(now.getTime() + 31_000);
    const recoveryHooks: DurableCoordinatorHooks = {
      stage_calls: 0,
      commit_calls: 0,
      recover_calls: 0,
      rollback_calls: 0,
    };
    const recovering = service(undefined, durableCoordinator(sidecarDirectory, recoveryHooks));
    expect(await recovering.recoverAll()).toContainEqual(
      expect.objectContaining({ ok: true, action: 'reconciled', transaction_id: IDS.transaction })
    );
    expect(recoveryHooks.recover_calls).toBe(1);
    expect(await recovering.recoverAll()).toEqual([]);
    expect(recoveryHooks.recover_calls).toBe(1);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
  });

  it('removes the verified private sidecar during prepromotion crash recovery', async () => {
    const sidecarDirectory = path.join(stateRoot, 'semantic-sidecars');
    const hooks: DurableCoordinatorHooks = {
      crash_stage_once: true,
      stage_calls: 0,
      commit_calls: 0,
      recover_calls: 0,
      rollback_calls: 0,
    };
    const coordinator = durableCoordinator(sidecarDirectory, hooks);
    await expect(
      service(undefined, coordinator).create({
        ...plan(),
        proposed_domains: [{ label: 'Sidecar Only', status: 'proposed' }],
      })
    ).rejects.toThrow('SIMULATED_SEMANTIC_STAGE_CRASH');
    expect(fs.readdirSync(sidecarDirectory)).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`), 'utf8'))
    ).toMatchObject({ phase: 'preflighted' });
    simulateLeaseOwnerDeath(stateRoot);
    now = new Date(now.getTime() + 31_000);
    expect(await service(undefined, coordinator).recoverAll()).toContainEqual(
      expect.objectContaining({ ok: true, action: 'rolled_back', transaction_id: IDS.transaction })
    );
    expect(hooks.rollback_calls).toBe(1);
    expect(fs.readdirSync(sidecarDirectory)).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, 'atlas-research'))).toBe(false);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
  });

  it('quarantines a sidecar binding mismatch without deleting it or mutating project state', async () => {
    const sidecarDirectory = path.join(stateRoot, 'semantic-sidecars');
    const hooks: DurableCoordinatorHooks = {
      crash_stage_once: true,
      stage_calls: 0,
      commit_calls: 0,
      recover_calls: 0,
      rollback_calls: 0,
    };
    const coordinator = durableCoordinator(sidecarDirectory, hooks);
    await expect(service(undefined, coordinator).create(plan())).rejects.toThrow('SIMULATED_SEMANTIC_STAGE_CRASH');
    const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, string>;
    const sidecarFile = path.join(sidecarDirectory, `${journal.semantic_context_ref}.json`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) as {
      binding: { bundle_sha256: string };
    };
    sidecar.binding.bundle_sha256 = 'a'.repeat(64);
    fs.writeFileSync(sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`);

    simulateLeaseOwnerDeath(stateRoot);
    now = new Date(now.getTime() + 31_000);
    expect(await service(undefined, coordinator).recoverAll()).toContainEqual({
      ok: false,
      reason_code: 'semantic.bundle-mismatch',
      transaction_id: IDS.transaction,
    });
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({
      phase: 'recovery_required',
      reason_code: 'semantic.bundle-mismatch',
    });
    expect(fs.existsSync(sidecarFile)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'atlas-research'))).toBe(false);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
  });

  it('does not replay semantic recovery after semantic_committed is durable', async () => {
    let recoverCalls = 0;
    const trackingCoordinator: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      recover: async ({ assert_mutation_allowed }) => {
        recoverCalls += 1;
        assert_mutation_allowed();
      },
    };
    await expect(
      service((phase) => {
        if (phase === 'semantic_committed') throw new Error('SIMULATED_CRASH');
      }, trackingCoordinator).create(plan())
    ).rejects.toThrow('SIMULATED_CRASH');
    simulateLeaseOwnerDeath(stateRoot);
    now = new Date(now.getTime() + 31_000);
    expect(await service(undefined, trackingCoordinator).recoverAll()).toContainEqual(
      expect.objectContaining({ ok: true, action: 'reconciled', transaction_id: IDS.transaction })
    );
    expect(recoverCalls).toBe(0);
  });

  it('keeps a typed promotion-hook failure recoverable after the final directory exists', async () => {
    const result = await service((phase) => {
      if (phase === 'promotion:renamed') throw new ProjectWorkspaceError('workspace.io-failed');
    }).create(plan());
    expect(result).toMatchObject({
      ok: false,
      reason_code: 'workspace.io-failed',
      recovery_required: true,
    });
    const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({
      phase: 'promoted',
      reason_code: 'workspace.io-failed',
    });
    expect(fs.existsSync(path.join(projectRoot, 'atlas-research'))).toBe(true);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);

    expect(await service().recoverAll()).toContainEqual(
      expect.objectContaining({ ok: true, action: 'reconciled', transaction_id: IDS.transaction })
    );
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({ phase: 'committed' });
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
  });

  it.each([
    ['leased', 'rolled_back', false],
    ['preflighted', 'rolled_back', false],
    ['semantic_staged', 'rolled_back', false],
    ['staging', 'rolled_back', false],
    ['staged', 'rolled_back', false],
    ['promotion:renamed', 'reconciled', true],
    ['promoted', 'reconciled', true],
    ['semantic_committed', 'reconciled', true],
    ['cataloged', 'reconciled', true],
    ['committed', 'reconciled', true],
  ] as const)(
    'recovers idempotently after a crash at %s',
    async (crashPhase, recoveryAction, shouldExist) => {
      const crashing = service((phase) => {
        if (phase === crashPhase) throw new Error('SIMULATED_CRASH');
      });
      await expect(crashing.create(plan())).rejects.toThrow('SIMULATED_CRASH');

      simulateLeaseOwnerDeath(stateRoot);
      now = new Date(now.getTime() + 31_000);
      const recovered = await service().recoverAll();
      expect(recovered).toContainEqual(expect.objectContaining({ ok: true, action: recoveryAction }));
      expect(await service().recoverAll()).toEqual([]);
      expect(fs.existsSync(path.join(projectRoot, 'atlas-research'))).toBe(shouldExist);
      expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(shouldExist ? 1 : 0);
    },
    60_000
  );

  it.each([
    ['undo:before-undo_quarantining', 'undo_quarantine_prepared', true, true, 1, false, 1, 1],
    ['undo:before-undo_quarantined', 'undo_quarantining', false, true, 1, false, 1, 1],
    ['undo:before-undo_semantic_rolled_back', 'undo_quarantined', false, true, 1, true, 2, 1],
    ['undo:before-undo_removal_committed', 'undo_semantic_rolled_back', false, true, 1, true, 1, 1],
    ['undo:before-undone', 'undo_removal_committed', false, false, 0, false, 1, 2],
  ] as const)(
    'resumes committed undo after an effect-before-marker crash at %s',
    async (
      crashPhase,
      durablePhase,
      sourceManifestExistsAfterCrash,
      quarantineExistsAfterCrash,
      catalogCountAfterCrash,
      semanticMarkerExistsAfterCrash,
      expectedPrepareCalls,
      expectedFinalizeCalls
    ) => {
      let prepareCalls = 0;
      let finalizeCalls = 0;
      const semanticMarker = path.join(stateRoot, 'undo-semantic-marker');
      const trackingCoordinator: ProjectSemanticCoordinator = {
        ...semanticCoordinator,
        prepareRemovalRollback: async ({ assert_mutation_allowed }) => {
          prepareCalls += 1;
          assert_mutation_allowed();
          if (!fs.existsSync(semanticMarker)) fs.writeFileSync(semanticMarker, 'removed\n', { flag: 'wx' });
          else expect(fs.readFileSync(semanticMarker, 'utf8')).toBe('removed\n');
        },
        finalizeRemovalRollback: async ({ assert_mutation_allowed, assert_removal_committed }) => {
          finalizeCalls += 1;
          assert_mutation_allowed();
          assert_removal_committed();
          if (fs.existsSync(semanticMarker)) fs.unlinkSync(semanticMarker);
        },
      };
      const created = await service(undefined, trackingCoordinator).create(plan());
      if (!created.ok) throw new Error(created.reason_code);
      let crashOnce = true;
      const crashing = service((phase) => {
        if (crashOnce && phase === crashPhase) {
          crashOnce = false;
          throw new Error('SIMULATED_UNDO_CRASH');
        }
      }, trackingCoordinator);

      await expect(crashing.undo(created.receipt_path)).rejects.toThrow('SIMULATED_UNDO_CRASH');

      const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
      expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({ phase: durablePhase });
      expect(fs.existsSync(path.join(created.project_path, '.command-eve', 'project.json'))).toBe(
        sourceManifestExistsAfterCrash
      );
      const quarantinePath = path.join(projectRoot, `.command-eve-undo-${IDS.transaction}`);
      expect(fs.existsSync(quarantinePath)).toBe(quarantineExistsAfterCrash);
      expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(catalogCountAfterCrash);
      expect(fs.existsSync(semanticMarker)).toBe(semanticMarkerExistsAfterCrash);

      expect(await service(undefined, trackingCoordinator).recoverAll()).toContainEqual(
        expect.objectContaining({ ok: true, action: 'rolled_back', transaction_id: IDS.transaction })
      );
      const recoveredJournal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, unknown>;
      expect(recoveredJournal).toMatchObject({ phase: 'undone' });
      expect(recoveredJournal).not.toHaveProperty('undo_quarantine_plan');
      expect(fs.existsSync(created.project_path)).toBe(false);
      expect(fs.existsSync(quarantinePath)).toBe(false);
      expect(fs.existsSync(semanticMarker)).toBe(false);
      expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
      expect(prepareCalls).toBe(expectedPrepareCalls);
      expect(finalizeCalls).toBe(expectedFinalizeCalls);
      expect(await service(undefined, trackingCoordinator).recoverAll()).toEqual([]);
    },
    60_000
  );

  it('resumes a provisioning rollback that crashes after its quarantine is durably prepared', async () => {
    let failStagedOnce = true;
    let crashUndoOnce = true;
    const semanticRemovalPaths: string[] = [];
    const trackingCoordinator: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      prepareRemovalRollback: async (input) => {
        semanticRemovalPaths.push(input.project_path);
        input.assert_mutation_allowed();
      },
    };
    const crashing = service((phase) => {
      if (failStagedOnce && phase === 'staged') {
        failStagedOnce = false;
        throw new ProjectWorkspaceError('workspace.io-failed');
      }
      if (crashUndoOnce && phase === 'undo:before-undo_semantic_rolled_back') {
        crashUndoOnce = false;
        throw new Error('SIMULATED_PROVISIONING_UNDO_CRASH');
      }
    }, trackingCoordinator);

    await expect(crashing.create(plan())).rejects.toThrow('SIMULATED_PROVISIONING_UNDO_CRASH');

    const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({
      phase: 'undo_quarantined',
      undo_quarantine_plan: {
        origin: 'provisioning-rollback',
        receipt_relative_path: null,
        catalog_proof: null,
      },
    });
    const stagingPath = path.join(projectRoot, `.command-eve-stage-${IDS.transaction}`);
    const quarantinePath = path.join(projectRoot, `.command-eve-undo-${IDS.transaction}`);
    const semanticProjectPath = path.join(fs.realpathSync(projectRoot), plan().slug);
    expect(fs.existsSync(path.join(stagingPath, '.command-eve', 'project.json'))).toBe(false);
    expect(fs.existsSync(path.join(quarantinePath, '.command-eve', 'project.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, plan().slug))).toBe(false);
    expect(semanticRemovalPaths).toEqual([semanticProjectPath]);

    simulateLeaseOwnerDeath(stateRoot);
    now = new Date(now.getTime() + 31_000);
    expect(await service(undefined, trackingCoordinator).recoverAll()).toContainEqual(
      expect.objectContaining({ ok: true, action: 'rolled_back', transaction_id: IDS.transaction })
    );
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({ phase: 'undone' });
    expect(fs.existsSync(stagingPath)).toBe(false);
    expect(fs.existsSync(quarantinePath)).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, plan().slug))).toBe(false);
    expect(semanticRemovalPaths).toEqual([semanticProjectPath, semanticProjectPath]);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
  });

  it('parks a legacy rollback_pending journal without touching its committed project or catalog', async () => {
    let prepareCalls = 0;
    let finalizeCalls = 0;
    const trackingCoordinator: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      prepareRemovalRollback: async () => {
        prepareCalls += 1;
      },
      finalizeRemovalRollback: async () => {
        finalizeCalls += 1;
      },
    };
    const created = await service(undefined, trackingCoordinator).create(plan());
    if (!created.ok) throw new Error(created.reason_code);

    const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(journalFile, `${JSON.stringify({ ...journal, phase: 'rollback_pending' }, null, 2)}\n`, 'utf8');
    const manifestPath = path.join(created.project_path, '.command-eve', 'project.json');
    const manifestBefore = fs.readFileSync(manifestPath, 'utf8');
    const manifestInode = fs.lstatSync(manifestPath).ino;
    const receiptBefore = fs.readFileSync(created.receipt_path, 'utf8');
    const catalogBefore = registry.readSeatCatalogs(activeSeat).projects;
    const quarantinePath = path.join(projectRoot, `.command-eve-undo-${IDS.transaction}`);

    expect(await service(undefined, trackingCoordinator).recoverAll()).toContainEqual({
      ok: false,
      reason_code: 'workspace.recovery-required',
      transaction_id: IDS.transaction,
    });
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({
      phase: 'recovery_required',
      reason_code: 'workspace.recovery-required',
    });
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(fs.lstatSync(manifestPath).ino).toBe(manifestInode);
    expect(fs.readFileSync(created.receipt_path, 'utf8')).toBe(receiptBefore);
    expect(registry.readSeatCatalogs(activeSeat).projects).toEqual(catalogBefore);
    expect(fs.existsSync(quarantinePath)).toBe(false);
    expect(prepareCalls).toBe(0);
    expect(finalizeCalls).toBe(0);
    expect(await service(undefined, trackingCoordinator).recoverAll()).toEqual([]);
  });

  it('rejects a tampered recovery target before lease or filesystem mutation', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-journal-outside-'));
    try {
      const sentinel = path.join(outside, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'do not touch\n');
      const crashing = service((phase) => {
        if (phase === 'promoted') throw new Error('SIMULATED_CRASH');
      });
      await expect(crashing.create(plan())).rejects.toThrow('SIMULATED_CRASH');
      const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
      const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(journalFile, `${JSON.stringify({ ...journal, final_path: outside }, null, 2)}\n`);

      simulateLeaseOwnerDeath(stateRoot);
      now = new Date(now.getTime() + 31_000);
      expect(await service().recoverAll()).toContainEqual(
        expect.objectContaining({ ok: false, reason_code: 'workspace.journal-corrupt' })
      );
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('do not touch\n');
      expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('undoes only unchanged transaction files and preserves modified work', async () => {
    const unchanged = await service().create(plan());
    if (!unchanged.ok) throw new Error(unchanged.reason_code);
    expect(await service().undo(unchanged.receipt_path)).toMatchObject({ ok: true, status: 'undone' });
    expect(fs.existsSync(unchanged.project_path)).toBe(false);

    const secondPlan = {
      ...plan(),
      project_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      slug: 'atlas-modified',
      title: 'Atlas Modified',
      snapshot: {
        ...plan().snapshot,
        project_catalog_revision: registry.readSeatCatalogs(activeSeat).projects.revision,
      },
    };
    const modified = await service().create(secondPlan);
    if (!modified.ok) throw new Error(modified.reason_code);
    fs.appendFileSync(path.join(modified.project_path, 'AGENTS.md'), '\nuser edit\n');
    expect(await service().undo(modified.receipt_path)).toMatchObject({
      ok: false,
      status: 'recovery_required',
      reason_code: 'workspace.undo-hash-mismatch',
    });
    expect(fs.existsSync(path.join(modified.project_path, 'AGENTS.md'))).toBe(true);
  });

  it('quarantines project files before semantic rollback and retains the catalog until removal is committed', async () => {
    let rollbackCalls = 0;
    const orderingCoordinator: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      prepareRemovalRollback: async (input) => {
        rollbackCalls += 1;
        expect(fs.existsSync(path.join(input.project_path, '.command-eve', 'project.json'))).toBe(false);
        expect(
          fs.existsSync(
            path.join(projectRoot, `.command-eve-undo-${input.transaction_id}`, '.command-eve', 'project.json')
          )
        ).toBe(true);
        expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
        expect(input.transaction_id).toBe(IDS.transaction);
        expect(input.conversation_id).toBe(IDS.conversation);
        input.assert_mutation_allowed();
      },
    };
    const created = await service(undefined, orderingCoordinator).create(plan());
    if (!created.ok) throw new Error(created.reason_code);
    expect(await service(undefined, orderingCoordinator).undo(created.receipt_path)).toEqual({
      ok: true,
      status: 'undone',
    });
    expect(rollbackCalls).toBe(1);
    expect(fs.existsSync(created.project_path)).toBe(false);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
  });

  it('fails closed when semantic rollback swaps a receipt-owned file with the same hash and a new inode', async () => {
    let originalInode = 0;
    const replacingCoordinator: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      prepareRemovalRollback: async (input) => {
        const file = path.join(input.project_path, 'AGENTS.md');
        const quarantined = path.join(projectRoot, `.command-eve-undo-${input.transaction_id}`, 'AGENTS.md');
        const contents = fs.readFileSync(quarantined);
        originalInode = fs.lstatSync(quarantined).ino;
        const replacement = path.join(stateRoot, 'agents-replacement');
        fs.writeFileSync(replacement, contents);
        fs.renameSync(replacement, file);
      },
    };
    const created = await service(undefined, replacingCoordinator).create(plan());
    if (!created.ok) throw new Error(created.reason_code);

    expect(await service(undefined, replacingCoordinator).undo(created.receipt_path)).toEqual({
      ok: false,
      status: 'recovery_required',
      reason_code: 'workspace.recovery-required',
    });
    const file = path.join(created.project_path, 'AGENTS.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.lstatSync(file).ino).not.toBe(originalInode);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
  });

  it('revalidates the active seat before the first create-cleanup mutation', async () => {
    const switchingRollback: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      prepareRemovalRollback: async (input) => {
        input.assert_mutation_allowed();
        activeSeat = 'seat-beta';
      },
    };
    const result = await service((phase) => {
      if (phase === 'staged') throw new ProjectWorkspaceError('workspace.io-failed');
    }, switchingRollback).create(plan());

    expect(result).toMatchObject({
      ok: false,
      reason_code: 'workspace.io-failed',
      recovery_required: true,
    });
    const stagingPath = path.join(projectRoot, `.command-eve-stage-${IDS.transaction}`);
    const quarantinePath = path.join(projectRoot, `.command-eve-undo-${IDS.transaction}`);
    expect(fs.existsSync(path.join(stagingPath, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(stagingPath, '.command-eve', 'project.json'))).toBe(false);
    expect(fs.existsSync(path.join(quarantinePath, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(quarantinePath, '.command-eve', 'project.json'))).toBe(true);
  });

  it('revalidates the active seat before cleaning additions from an adopted user root', async () => {
    const adoptedDirectory = path.join(projectRoot, 'seat-fenced-adopt');
    fs.mkdirSync(adoptedDirectory);
    const userFile = path.join(adoptedDirectory, 'user-owned.txt');
    fs.writeFileSync(userFile, 'keep me\n');
    const switchingRollback: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      prepareRemovalRollback: async (input) => {
        input.assert_mutation_allowed();
        activeSeat = 'seat-beta';
      },
    };
    const adoptPlan: ProjectIntentPlan = {
      ...plan(),
      project_id: 'abababab-abab-4bab-8bab-abababababab',
      title: 'Seat Fenced Adopt',
      slug: 'seat-fenced-adopt',
    };
    const result = await service((phase) => {
      if (phase === 'adopt:staged') throw new ProjectWorkspaceError('workspace.io-failed');
    }, switchingRollback).adopt(adoptPlan, adoptedDirectory, true);

    expect(result).toMatchObject({
      ok: false,
      reason_code: 'workspace.io-failed',
      recovery_required: true,
    });
    expect(fs.readFileSync(userFile, 'utf8')).toBe('keep me\n');
    expect(fs.existsSync(path.join(adoptedDirectory, '.command-eve', 'project.json'))).toBe(false);
    expect(
      fs.existsSync(path.join(projectRoot, `.command-eve-undo-${IDS.transaction}`, '.command-eve', 'project.json'))
    ).toBe(true);
  });

  it('adopts add-only and undo preserves every pre-existing file', async () => {
    const adoptedDirectory = path.join(projectRoot, 'atlas-adopted');
    fs.mkdirSync(adoptedDirectory);
    fs.writeFileSync(path.join(adoptedDirectory, 'AGENTS.md'), 'pre-existing policy\n');
    const adoptPlan: ProjectIntentPlan = {
      ...plan(),
      project_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Atlas Adopted',
      slug: 'atlas-adopted',
    };
    const adopted = await service().adopt(adoptPlan, adoptedDirectory, true);
    expect(adopted).toMatchObject({ ok: true, committed: true });
    if (adopted.ok === false) throw new Error(adopted.reason_code);
    expect(fs.readFileSync(path.join(adoptedDirectory, 'AGENTS.md'), 'utf8')).toBe('pre-existing policy\n');
    expect(fs.existsSync(path.join(adoptedDirectory, '.command-eve', 'project.json'))).toBe(true);

    expect(await service().undo(adopted.receipt_path)).toMatchObject({ ok: true, status: 'undone' });
    expect(fs.existsSync(adoptedDirectory)).toBe(true);
    expect(fs.readFileSync(path.join(adoptedDirectory, 'AGENTS.md'), 'utf8')).toBe('pre-existing policy\n');
    expect(fs.existsSync(path.join(adoptedDirectory, '.command-eve', 'project.json'))).toBe(false);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
  });

  it('never chmods an existing user-owned adoption root', async () => {
    if (process.platform === 'win32') return;
    const adoptedDirectory = path.join(projectRoot, 'mode-preserved');
    fs.mkdirSync(adoptedDirectory, { mode: 0o755 });
    fs.chmodSync(adoptedDirectory, 0o755);
    fs.writeFileSync(path.join(adoptedDirectory, 'README.md'), 'pre-existing\n');
    const beforeMode = fs.statSync(adoptedDirectory).mode & 0o777;
    const adopted = await service().adopt(
      {
        ...plan(),
        project_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        title: 'Mode Preserved',
        slug: 'mode-preserved',
      },
      adoptedDirectory,
      true
    );
    expect(adopted).toMatchObject({ ok: true, committed: true });
    if (!adopted.ok) throw new Error(adopted.reason_code);
    expect(fs.statSync(adoptedDirectory).mode & 0o777).toBe(beforeMode);
    expect(await service().undo(adopted.receipt_path)).toEqual({ ok: true, status: 'undone' });
    expect(fs.statSync(adoptedDirectory).mode & 0o777).toBe(beforeMode);
  });

  it('refuses a symlinked receipt and leaves the project untouched', async () => {
    const created = await service().create(plan());
    if (!created.ok) throw new Error(created.reason_code);
    const outside = path.join(stateRoot, 'outside-receipt.json');
    fs.copyFileSync(created.receipt_path, outside);
    fs.unlinkSync(created.receipt_path);
    fs.symlinkSync(outside, created.receipt_path);

    expect(await service().undo(created.receipt_path)).toMatchObject({
      ok: false,
      status: 'recovery_required',
      reason_code: 'workspace.recovery-required',
    });
    expect(fs.existsSync(path.join(created.project_path, 'AGENTS.md'))).toBe(true);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
  });
});
