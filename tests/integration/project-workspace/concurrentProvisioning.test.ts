import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectWorkspaceRegistryStore } from '@process/services/project-workspace/storage/registryStore';

const IDS = {
  realm: '11111111-1111-4111-8111-111111111111',
  root: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
} as const;

function runProvisioner(input: {
  stateRoot: string;
  projectRoot: string;
  slug: string;
  transactionId: string;
  operation: 'create' | 'adopt';
  mode?: 'provision' | 'recover';
  crashPhase?: string;
  holdAtLease?: boolean;
}): Promise<Record<string, unknown>> {
  const serviceModule = path.resolve(
    'packages/desktop/src/process/services/project-workspace/ProjectWorkspaceService.ts'
  );
  const registryModule = path.resolve(
    'packages/desktop/src/process/services/project-workspace/storage/registryStore.ts'
  );
  const target = path.join(input.projectRoot, input.slug);
  const program = `
    import { ProjectWorkspaceService } from ${JSON.stringify(serviceModule)};
    import { ProjectWorkspaceRegistryStore } from ${JSON.stringify(registryModule)};
    const registry = new ProjectWorkspaceRegistryStore({ state_root: ${JSON.stringify(input.stateRoot)} });
    const plan = {
      action: 'create',
      conversation_id: 'conversation-concurrent-atlas',
      seat_id: 'seat-alpha',
      realm_id: ${JSON.stringify(IDS.realm)},
      realm_label: 'Business',
      realm_path_slug: 'business',
      root_id: ${JSON.stringify(IDS.root)},
      project_id: ${JSON.stringify(IDS.project)},
      title: 'Concurrent Atlas',
      slug: ${JSON.stringify(input.slug)},
      domain_ids: [],
      proposed_domains: [],
      confidence: 1,
      workspace_root_ref: ${JSON.stringify(`root:${IDS.root}`)},
      existing_candidates: [],
      needs_human_confirmation: false,
      question_count: 0,
      snapshot: {
        seat_id: 'seat-alpha',
        realm_id: ${JSON.stringify(IDS.realm)},
        root_id: ${JSON.stringify(IDS.root)},
        workspace_root_ref: ${JSON.stringify(`root:${IDS.root}`)},
        realm_revision: 1,
        root_revision: 1,
        project_catalog_revision: 0,
      },
    };
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const service = new ProjectWorkspaceService({
      registry,
      get_active_seat_id: () => 'seat-alpha',
      random_uuid: () => ${JSON.stringify(input.transactionId)},
      semantic_coordinator: {
        preflight: async ({ transaction_id }) => ({
          ok: true,
          extension_bundle_sha256: 'e'.repeat(64),
          effect_plan_sha256: 'a'.repeat(64),
          initial_conversation_binding: null,
          initial_project_binding_revision: 0,
          initial_project_binding_receipt_id: null,
          preflight_receipt_id: 'test-boundary-pass:v1',
          semantic_context_ref: 'context:' + transaction_id,
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
      },
      on_phase: (phase) => {
        if (phase === ${JSON.stringify(input.crashPhase ?? '')}) process.exit(91);
        if (${input.holdAtLease !== false} && phase === '${input.operation === 'create' ? 'leased' : 'adopt:leased'}') Atomics.wait(wait, 0, 0, 900);
      },
    });
    const result = await ${input.mode === 'recover' ? 'service.recoverAll()' : input.operation === 'create' ? 'service.create(plan)' : `service.adopt(plan, ${JSON.stringify(target)}, true)`};
    console.log(JSON.stringify(result));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (input.crashPhase && code === 91) return resolve({ crashed: true, phase: input.crashPhase });
      if (code !== 0) return reject(new Error(stderr || `child exited ${code}`));
      resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
    });
  });
}

describe('concurrent project provisioning', () => {
  let stateRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-concurrent-state-'));
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-project-concurrent-root-'));
    const registry = new ProjectWorkspaceRegistryStore({ state_root: stateRoot });
    registry.initializeSeat('seat-alpha');
    registry.upsertRealm({
      seat_id: 'seat-alpha',
      expected_revision: 0,
      realm: { realm_id: IDS.realm, label: 'Business', path_slug: 'business', status: 'active', order: 0 },
    });
    registry.registerRoot({
      seat_id: 'seat-alpha',
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

  it('allows exactly one create committer across separate processes', async () => {
    const results = await Promise.all([
      runProvisioner({
        stateRoot,
        projectRoot,
        slug: 'concurrent-atlas',
        transactionId: '44444444-4444-4444-8444-444444444444',
        operation: 'create',
      }),
      runProvisioner({
        stateRoot,
        projectRoot,
        slug: 'concurrent-atlas',
        transactionId: '55555555-5555-4555-8555-555555555555',
        operation: 'create',
      }),
    ]);
    expect(results.filter((result) => result.ok && !result.already_existed)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ reason_code: 'workspace.concurrent-operation', recovery_required: true }),
    ]);
    const registry = new ProjectWorkspaceRegistryStore({ state_root: stateRoot });
    expect(registry.readSeatCatalogs('seat-alpha').projects.projects).toHaveLength(1);
    const manifestPath = path.join(projectRoot, 'concurrent-atlas', '.command-eve', 'project.json');
    const manifestBytes = fs.readFileSync(manifestPath, 'utf8');
    const journalDirectory = path.join(stateRoot, 'transactions');
    const journalFiles = fs
      .readdirSync(journalDirectory)
      .filter((name) => name.endsWith('.journal.json'))
      .toSorted();
    expect(journalFiles).toHaveLength(2);
    expect(
      journalFiles
        .map((name) => JSON.parse(fs.readFileSync(path.join(journalDirectory, name), 'utf8')).phase)
        .toSorted()
    ).toEqual(['committed', 'planned']);

    expect(
      await runProvisioner({
        stateRoot,
        projectRoot,
        slug: 'concurrent-atlas',
        transactionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        operation: 'create',
        mode: 'recover',
        holdAtLease: false,
      })
    ).toContainEqual(expect.objectContaining({ ok: true, action: 'rolled_back' }));
    expect(
      journalFiles
        .map((name) => JSON.parse(fs.readFileSync(path.join(journalDirectory, name), 'utf8')).phase)
        .toSorted()
    ).toEqual(['committed', 'undone']);
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(manifestBytes);
    expect(registry.readSeatCatalogs('seat-alpha').projects.projects).toHaveLength(1);
  });

  it('allows adoption to win an existing-folder create/adopt race without overwriting', async () => {
    const target = path.join(projectRoot, 'adopt-atlas');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'README.md'), 'pre-existing\n');
    const results = await Promise.all([
      runProvisioner({
        stateRoot,
        projectRoot,
        slug: 'adopt-atlas',
        transactionId: '66666666-6666-4666-8666-666666666666',
        operation: 'create',
      }),
      runProvisioner({
        stateRoot,
        projectRoot,
        slug: 'adopt-atlas',
        transactionId: '77777777-7777-4777-8777-777777777777',
        operation: 'adopt',
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ reason_code: 'workspace.collision' }),
    ]);
    expect(fs.readFileSync(path.join(target, 'README.md'), 'utf8')).toBe('pre-existing\n');
    const registry = new ProjectWorkspaceRegistryStore({ state_root: stateRoot });
    expect(registry.readSeatCatalogs('seat-alpha').projects.projects).toHaveLength(1);
  });

  it.each([
    ['create', 'lease:acquired'],
    ['adopt', 'adopt:lease:acquired'],
  ] as const)(
    'recovers a %s process death after lease acquisition from its planned journal',
    async (operation, phase) => {
      const slug = `${operation}-planned-crash`;
      const target = path.join(projectRoot, slug);
      if (operation === 'adopt') {
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'README.md'), 'pre-existing\n');
      }
      const transactionId =
        operation === 'create' ? '88888888-8888-4888-8888-888888888888' : '99999999-9999-4999-8999-999999999999';
      expect(
        await runProvisioner({
          stateRoot,
          projectRoot,
          slug,
          transactionId,
          operation,
          crashPhase: phase,
          holdAtLease: false,
        })
      ).toEqual({ crashed: true, phase });

      const journalFile = path.join(stateRoot, 'transactions', `${transactionId}.journal.json`);
      expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({
        phase: 'planned',
        transaction_id: transactionId,
      });
      const leaseFile = path.join(
        stateRoot,
        'leases',
        fs.readdirSync(path.join(stateRoot, 'leases')).find((name) => name.endsWith('.lease.json')) as string
      );
      expect(JSON.parse(fs.readFileSync(leaseFile, 'utf8'))).toMatchObject({
        transaction_id: transactionId,
        released_at_ms: null,
      });

      const recovered = await runProvisioner({
        stateRoot,
        projectRoot,
        slug,
        transactionId,
        operation,
        mode: 'recover',
        holdAtLease: false,
      });
      expect(recovered).toContainEqual(
        expect.objectContaining({ ok: true, action: 'rolled_back', transaction_id: transactionId })
      );
      expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({ phase: 'undone' });
      expect(operation === 'adopt' ? fs.existsSync(target) : !fs.existsSync(target)).toBe(true);

      const retry = await runProvisioner({
        stateRoot,
        projectRoot,
        slug,
        transactionId:
          operation === 'create' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        operation,
        holdAtLease: false,
      });
      expect(retry).toMatchObject({ ok: true, committed: true });
    }
  );

  it('survives a second process death after recovery lease takeover without rewriting journal lineage', async () => {
    const slug = 'recovery-lineage-crash';
    const transactionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    expect(
      await runProvisioner({
        stateRoot,
        projectRoot,
        slug,
        transactionId,
        operation: 'create',
        crashPhase: 'promoted',
        holdAtLease: false,
      })
    ).toEqual({ crashed: true, phase: 'promoted' });
    const journalFile = path.join(stateRoot, 'transactions', `${transactionId}.journal.json`);
    const initialJournal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, unknown>;

    expect(
      await runProvisioner({
        stateRoot,
        projectRoot,
        slug,
        transactionId,
        operation: 'create',
        mode: 'recover',
        crashPhase: 'recovery:lease:acquired',
        holdAtLease: false,
      })
    ).toEqual({ crashed: true, phase: 'recovery:lease:acquired' });
    const handoffJournal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as Record<string, unknown>;
    const leaseFile = path.join(
      stateRoot,
      'leases',
      fs.readdirSync(path.join(stateRoot, 'leases')).find((name) => name.endsWith('.lease.json')) as string
    );
    const handoffLease = JSON.parse(fs.readFileSync(leaseFile, 'utf8')) as Record<string, unknown>;
    expect(handoffJournal.owner_token_sha256).toBe(initialJournal.owner_token_sha256);
    expect(handoffLease).toMatchObject({
      transaction_id: transactionId,
      lineage_owner_token_sha256: initialJournal.owner_token_sha256,
      released_at_ms: null,
    });
    expect(handoffLease.owner_token_sha256).not.toBe(initialJournal.owner_token_sha256);

    const recovered = await runProvisioner({
      stateRoot,
      projectRoot,
      slug,
      transactionId,
      operation: 'create',
      mode: 'recover',
      holdAtLease: false,
    });
    expect(recovered).toContainEqual(
      expect.objectContaining({ ok: true, action: 'reconciled', transaction_id: transactionId })
    );
    expect(JSON.parse(fs.readFileSync(journalFile, 'utf8'))).toMatchObject({
      phase: 'committed',
      owner_token_sha256: initialJournal.owner_token_sha256,
    });
    const registry = new ProjectWorkspaceRegistryStore({ state_root: stateRoot });
    expect(registry.readSeatCatalogs('seat-alpha').projects.projects).toHaveLength(1);
  });
});
