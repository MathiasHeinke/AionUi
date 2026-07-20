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
        preflight: ({ transaction_id }) => ({
          ok: true,
          extension_bundle_sha256: 'e'.repeat(64),
          preflight_receipt_id: 'test-boundary-pass:v1',
          semantic_context_ref: 'context:' + transaction_id,
          semantic_context_sha256: 'f'.repeat(64),
        }),
        stage: ({ assert_mutation_allowed }) => assert_mutation_allowed(),
        commit: ({ assert_mutation_allowed }) => assert_mutation_allowed(),
        recover: ({ assert_mutation_allowed }) => assert_mutation_allowed(),
        rollback: ({ assert_mutation_allowed }) => assert_mutation_allowed(),
      },
      on_phase: (phase) => {
        if (phase === '${input.operation === 'create' ? 'leased' : 'adopt:leased'}') Atomics.wait(wait, 0, 0, 900);
      },
    });
    const result = ${input.operation === 'create' ? 'service.create(plan)' : `service.adopt(plan, ${JSON.stringify(target)}, true)`};
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
      expect.objectContaining({ reason_code: 'workspace.concurrent-operation' }),
    ]);
    const registry = new ProjectWorkspaceRegistryStore({ state_root: stateRoot });
    expect(registry.readSeatCatalogs('seat-alpha').projects.projects).toHaveLength(1);
    expect(fs.existsSync(path.join(projectRoot, 'concurrent-atlas', '.command-eve', 'project.json'))).toBe(true);
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
});
