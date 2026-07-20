import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectIntentPlan } from '@/common/types/project-workspace/intent';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import { ProjectWorkspaceService } from '@process/services/project-workspace/ProjectWorkspaceService';
import type { ProjectSemanticCoordinator } from '@process/services/project-workspace/core/semanticBundleCore';
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
  preflight: ({ transaction_id }) => ({
    ok: true,
    extension_bundle_sha256: 'e'.repeat(64),
    preflight_receipt_id: 'test-boundary-pass:v1',
    semantic_context_ref: `context:${transaction_id}`,
    semantic_context_sha256: 'f'.repeat(64),
  }),
  stage: ({ assert_mutation_allowed }) => assert_mutation_allowed(),
  commit: ({ assert_mutation_allowed }) => assert_mutation_allowed(),
  recover: ({ assert_mutation_allowed }) => assert_mutation_allowed(),
  rollback: ({ assert_mutation_allowed }) => assert_mutation_allowed(),
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
    preflight: (input) => {
      const context = semanticContextForTest(input);
      return {
        ok: true,
        extension_bundle_sha256: 'e'.repeat(64),
        preflight_receipt_id: 'test-boundary-pass:v1',
        semantic_context_ref: `context:${input.transaction_id}`,
        semantic_context_sha256: canonicalSha256(context),
      };
    },
    stage: (input) => {
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
    commit: (input) => {
      hooks.commit_calls += 1;
      readVerified(input);
      commitMarker(input);
      if (hooks.crash_commit_once) {
        hooks.crash_commit_once = false;
        throw new Error('SIMULATED_SEMANTIC_COMMIT_CRASH');
      }
    },
    recover: (input) => {
      hooks.recover_calls += 1;
      readVerified(input);
      commitMarker(input);
    },
    rollback: (input) => {
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
  };
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

  it('stages and promotes exactly one complete scaffold with a durable receipt', () => {
    const proposalLabel = 'Confidential Growth Idea';
    const result = service().create({
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

  it('fails closed without a semantic coordinator and persists no proposal payload', () => {
    const proposed = {
      ...plan(),
      proposed_domains: [{ label: 'Confidential Growth Idea', status: 'proposed' as const }],
    };
    expect(service(undefined, null).create(proposed)).toMatchObject({
      ok: false,
      reason_code: 'semantic.coordinator-required',
    });
    expect(fs.existsSync(path.join(projectRoot, proposed.slug))).toBe(false);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
    const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
    const journal = fs.readFileSync(journalFile, 'utf8');
    expect(journal).not.toContain('Confidential Growth Idea');
    expect(JSON.parse(journal)).toMatchObject({ phase: 'undone', conversation_id: IDS.conversation });
    const leaseFiles = fs.readdirSync(path.join(stateRoot, 'leases'));
    expect(leaseFiles).toHaveLength(1);
    expect(isProjectLeaseReleased(path.join(stateRoot, 'leases', leaseFiles[0]))).toBe(true);
  });

  it('rechecks the immutable seat snapshot after pure semantic preflight and before stage', () => {
    let stageCalls = 0;
    const switchingCoordinator: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      preflight: (input) => {
        activeSeat = 'seat-beta';
        return semanticCoordinator.preflight(input);
      },
      stage: () => {
        stageCalls += 1;
      },
    };
    expect(service(undefined, switchingCoordinator).create(plan())).toMatchObject({
      ok: false,
      reason_code: 'seat.changed',
    });
    expect(stageCalls).toBe(0);
    expect(fs.existsSync(path.join(projectRoot, 'atlas-research'))).toBe(false);
    expect(registry.readSeatCatalogs('seat-alpha').projects.projects).toHaveLength(0);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`), 'utf8'))
    ).toMatchObject({ phase: 'undone' });
  });

  it('is idempotent for project identity and normalized target', () => {
    expect(service().create(plan())).toMatchObject({ ok: true, committed: true });
    expect(service().create(plan())).toMatchObject({ ok: true, already_existed: true });
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
  });

  it('invalidates an immutable plan after a seat switch before promotion', () => {
    const result = service((phase) => {
      if (phase === 'staged') activeSeat = 'seat-beta';
    }).create(plan());
    expect(result).toMatchObject({ ok: false, reason_code: 'seat.changed' });
    expect(fs.existsSync(path.join(projectRoot, 'atlas-research'))).toBe(false);
    expect(registry.readSeatCatalogs('seat-alpha').projects.projects).toHaveLength(0);
  });

  it('rejects recovery with a semantic receipt when the coordinator is unavailable', () => {
    const crashing = service((phase) => {
      if (phase === 'promoted') throw new Error('SIMULATED_CRASH');
    });
    expect(() => crashing.create(plan())).toThrow('SIMULATED_CRASH');
    now = new Date(now.getTime() + 31_000);
    expect(service(undefined, null).recoverAll()).toContainEqual({
      ok: false,
      reason_code: 'semantic.coordinator-required',
      transaction_id: IDS.transaction,
    });
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
    expect(service().recoverAll()).toContainEqual(
      expect.objectContaining({ ok: true, action: 'reconciled', transaction_id: IDS.transaction })
    );
  });

  it('replays a crashed semantic commit from a hash-bound private sidecar exactly once', () => {
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
    expect(() => service(undefined, durableCoordinator(sidecarDirectory, firstHooks)).create(proposed)).toThrow(
      'SIMULATED_SEMANTIC_COMMIT_CRASH'
    );
    expect(firstHooks).toMatchObject({ stage_calls: 1, commit_calls: 1, recover_calls: 0 });
    const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
    const crashedJournal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, string>;
    expect(crashedJournal).toMatchObject({ phase: 'promoted', conversation_id: IDS.conversation });
    expect(JSON.stringify(crashedJournal)).not.toContain('Possible Growth Domain');
    const sidecarFile = path.join(sidecarDirectory, `${crashedJournal.semantic_context_ref}.json`);
    expect(fs.readFileSync(sidecarFile, 'utf8')).toContain('Possible Growth Domain');

    now = new Date(now.getTime() + 31_000);
    const recoveryHooks: DurableCoordinatorHooks = {
      stage_calls: 0,
      commit_calls: 0,
      recover_calls: 0,
      rollback_calls: 0,
    };
    const recovering = service(undefined, durableCoordinator(sidecarDirectory, recoveryHooks));
    expect(recovering.recoverAll()).toContainEqual(
      expect.objectContaining({ ok: true, action: 'reconciled', transaction_id: IDS.transaction })
    );
    expect(recoveryHooks.recover_calls).toBe(1);
    expect(recovering.recoverAll()).toEqual([]);
    expect(recoveryHooks.recover_calls).toBe(1);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
  });

  it('removes the verified private sidecar during prepromotion crash recovery', () => {
    const sidecarDirectory = path.join(stateRoot, 'semantic-sidecars');
    const hooks: DurableCoordinatorHooks = {
      crash_stage_once: true,
      stage_calls: 0,
      commit_calls: 0,
      recover_calls: 0,
      rollback_calls: 0,
    };
    const coordinator = durableCoordinator(sidecarDirectory, hooks);
    expect(() =>
      service(undefined, coordinator).create({
        ...plan(),
        proposed_domains: [{ label: 'Sidecar Only', status: 'proposed' }],
      })
    ).toThrow('SIMULATED_SEMANTIC_STAGE_CRASH');
    expect(fs.readdirSync(sidecarDirectory)).toHaveLength(1);
    expect(
      JSON.parse(fs.readFileSync(path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`), 'utf8'))
    ).toMatchObject({ phase: 'preflighted' });
    now = new Date(now.getTime() + 31_000);
    expect(service(undefined, coordinator).recoverAll()).toContainEqual(
      expect.objectContaining({ ok: true, action: 'rolled_back', transaction_id: IDS.transaction })
    );
    expect(hooks.rollback_calls).toBe(1);
    expect(fs.readdirSync(sidecarDirectory)).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, 'atlas-research'))).toBe(false);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
  });

  it('quarantines a sidecar binding mismatch without deleting it or mutating project state', () => {
    const sidecarDirectory = path.join(stateRoot, 'semantic-sidecars');
    const hooks: DurableCoordinatorHooks = {
      crash_stage_once: true,
      stage_calls: 0,
      commit_calls: 0,
      recover_calls: 0,
      rollback_calls: 0,
    };
    const coordinator = durableCoordinator(sidecarDirectory, hooks);
    expect(() => service(undefined, coordinator).create(plan())).toThrow('SIMULATED_SEMANTIC_STAGE_CRASH');
    const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
    const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, string>;
    const sidecarFile = path.join(sidecarDirectory, `${journal.semantic_context_ref}.json`);
    const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) as {
      binding: { bundle_sha256: string };
    };
    sidecar.binding.bundle_sha256 = 'a'.repeat(64);
    fs.writeFileSync(sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`);

    now = new Date(now.getTime() + 31_000);
    expect(service(undefined, coordinator).recoverAll()).toContainEqual({
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

  it('does not replay semantic recovery after semantic_committed is durable', () => {
    let recoverCalls = 0;
    const trackingCoordinator: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      recover: ({ assert_mutation_allowed }) => {
        recoverCalls += 1;
        assert_mutation_allowed();
      },
    };
    expect(() =>
      service((phase) => {
        if (phase === 'semantic_committed') throw new Error('SIMULATED_CRASH');
      }, trackingCoordinator).create(plan())
    ).toThrow('SIMULATED_CRASH');
    now = new Date(now.getTime() + 31_000);
    expect(service(undefined, trackingCoordinator).recoverAll()).toContainEqual(
      expect.objectContaining({ ok: true, action: 'reconciled', transaction_id: IDS.transaction })
    );
    expect(recoverCalls).toBe(0);
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
  ] as const)('recovers idempotently after a crash at %s', (crashPhase, recoveryAction, shouldExist) => {
    const crashing = service((phase) => {
      if (phase === crashPhase) throw new Error('SIMULATED_CRASH');
    });
    expect(() => crashing.create(plan())).toThrow('SIMULATED_CRASH');

    now = new Date(now.getTime() + 31_000);
    const recovered = service().recoverAll();
    expect(recovered).toContainEqual(expect.objectContaining({ ok: true, action: recoveryAction }));
    expect(service().recoverAll()).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, 'atlas-research'))).toBe(shouldExist);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(shouldExist ? 1 : 0);
  });

  it('rejects a tampered recovery target before lease or filesystem mutation', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-journal-outside-'));
    try {
      const sentinel = path.join(outside, 'sentinel.txt');
      fs.writeFileSync(sentinel, 'do not touch\n');
      const crashing = service((phase) => {
        if (phase === 'promoted') throw new Error('SIMULATED_CRASH');
      });
      expect(() => crashing.create(plan())).toThrow('SIMULATED_CRASH');
      const journalFile = path.join(stateRoot, 'transactions', `${IDS.transaction}.journal.json`);
      const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(journalFile, `${JSON.stringify({ ...journal, final_path: outside }, null, 2)}\n`);

      now = new Date(now.getTime() + 31_000);
      expect(service().recoverAll()).toContainEqual(
        expect.objectContaining({ ok: false, reason_code: 'workspace.journal-corrupt' })
      );
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('do not touch\n');
      expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('undoes only unchanged transaction files and preserves modified work', () => {
    const unchanged = service().create(plan());
    if (!unchanged.ok) throw new Error(unchanged.reason_code);
    expect(service().undo(unchanged.receipt_path)).toMatchObject({ ok: true, status: 'undone' });
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
    const modified = service().create(secondPlan);
    if (!modified.ok) throw new Error(modified.reason_code);
    fs.appendFileSync(path.join(modified.project_path, 'AGENTS.md'), '\nuser edit\n');
    expect(service().undo(modified.receipt_path)).toMatchObject({
      ok: false,
      status: 'recovery_required',
      reason_code: 'workspace.undo-hash-mismatch',
    });
    expect(fs.existsSync(path.join(modified.project_path, 'AGENTS.md'))).toBe(true);
  });

  it('rolls semantic stores back before removing project files or the catalog record', () => {
    let rollbackCalls = 0;
    const orderingCoordinator: ProjectSemanticCoordinator = {
      ...semanticCoordinator,
      rollback: (input) => {
        rollbackCalls += 1;
        expect(fs.existsSync(path.join(input.project_path, '.command-eve', 'project.json'))).toBe(true);
        expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
        expect(input.transaction_id).toBe(IDS.transaction);
        expect(input.conversation_id).toBe(IDS.conversation);
        input.assert_mutation_allowed();
      },
    };
    const created = service(undefined, orderingCoordinator).create(plan());
    if (!created.ok) throw new Error(created.reason_code);
    expect(service(undefined, orderingCoordinator).undo(created.receipt_path)).toEqual({ ok: true, status: 'undone' });
    expect(rollbackCalls).toBe(1);
    expect(fs.existsSync(created.project_path)).toBe(false);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
  });

  it('adopts add-only and undo preserves every pre-existing file', () => {
    const adoptedDirectory = path.join(projectRoot, 'atlas-adopted');
    fs.mkdirSync(adoptedDirectory);
    fs.writeFileSync(path.join(adoptedDirectory, 'AGENTS.md'), 'pre-existing policy\n');
    const adoptPlan: ProjectIntentPlan = {
      ...plan(),
      project_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Atlas Adopted',
      slug: 'atlas-adopted',
    };
    const adopted = service().adopt(adoptPlan, adoptedDirectory, true);
    expect(adopted).toMatchObject({ ok: true, committed: true });
    if (adopted.ok === false) throw new Error(adopted.reason_code);
    expect(fs.readFileSync(path.join(adoptedDirectory, 'AGENTS.md'), 'utf8')).toBe('pre-existing policy\n');
    expect(fs.existsSync(path.join(adoptedDirectory, '.command-eve', 'project.json'))).toBe(true);

    expect(service().undo(adopted.receipt_path)).toMatchObject({ ok: true, status: 'undone' });
    expect(fs.existsSync(adoptedDirectory)).toBe(true);
    expect(fs.readFileSync(path.join(adoptedDirectory, 'AGENTS.md'), 'utf8')).toBe('pre-existing policy\n');
    expect(fs.existsSync(path.join(adoptedDirectory, '.command-eve', 'project.json'))).toBe(false);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(0);
  });

  it('refuses a symlinked receipt and leaves the project untouched', () => {
    const created = service().create(plan());
    if (!created.ok) throw new Error(created.reason_code);
    const outside = path.join(stateRoot, 'outside-receipt.json');
    fs.copyFileSync(created.receipt_path, outside);
    fs.unlinkSync(created.receipt_path);
    fs.symlinkSync(outside, created.receipt_path);

    expect(service().undo(created.receipt_path)).toMatchObject({
      ok: false,
      status: 'recovery_required',
      reason_code: 'workspace.recovery-required',
    });
    expect(fs.existsSync(path.join(created.project_path, 'AGENTS.md'))).toBe(true);
    expect(registry.readSeatCatalogs(activeSeat).projects.projects).toHaveLength(1);
  });
});
