import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shell } from 'electron';
import type { ProjectSemanticCoordinator } from '@process/services/project-workspace/core/semanticBundleCore';
import {
  createProjectWorkspaceFacade,
  type ProjectWorkspaceFacade,
} from '@process/services/project-workspace/ProjectWorkspaceFacade';
import { ProjectWorkspaceLifecycleService } from '@process/services/project-workspace/ProjectWorkspaceLifecycleService';
import { ProjectWorkspaceService } from '@process/services/project-workspace/ProjectWorkspaceService';
import type { ProjectConversationMetadataClient } from '@process/services/project-workspace/runtime/conversationBindingClient';
import { ProjectWorkspaceConversationArtifactStore } from '@process/services/project-workspace/storage/conversationArtifactStore';
import { ProjectWorkspaceRegistryStore } from '@process/services/project-workspace/storage/registryStore';
import { ProjectLifecycleOperationStore } from '@process/services/project-workspace/transaction/lifecycleOperationStore';

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() },
}));

const SEAT_ID = 'seat-alpha';
const REALM_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_ID = '22222222-2222-4222-8222-222222222222';
const SEAT_REVISION = 7;

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

function fakeSemanticCoordinator(): ProjectSemanticCoordinator {
  return {
    preflight: async () => ({
      ok: true,
      extension_bundle_sha256: sha256('extension'),
      effect_plan_sha256: sha256('effect-plan'),
      initial_conversation_binding: null,
      initial_project_binding_revision: 0,
      initial_project_binding_receipt_id: null,
      preflight_receipt_id: 'preflight-receipt-1',
      semantic_context_ref: 'semantic-context-1',
      semantic_context_sha256: sha256('semantic-context'),
    }),
    stage: async () => {},
    commit: async () => {},
    recover: async () => {},
    rollback: async () => {},
    prepareRemovalRollback: async () => {},
    finalizeRemovalRollback: async () => {},
  };
}

function fakeBindingClient(
  metadata: { conversation_id: string; project_id: string | null }[]
): ProjectConversationMetadataClient {
  return {
    read: async () => ({ binding: null, project_binding_revision: 0, project_binding_receipt_id: null }),
    compareAndSwap: async (input) => ({
      binding: input.next,
      project_binding_revision: input.expected_project_binding_revision + 1,
      project_binding_receipt_id: input.project_binding_operation_id,
    }),
    readMetadata: async (conversationId) => {
      const entry = metadata.find((candidate) => candidate.conversation_id === conversationId);
      if (!entry) throw new Error('unknown conversation');
      return {
        conversation_id: entry.conversation_id,
        name: entry.conversation_id,
        binding: entry.project_id
          ? { project_id: entry.project_id, workspace_root_ref: `root:${ROOT_ID}` as const }
          : null,
        project_binding_revision: 0,
        project_binding_receipt_id: null,
      };
    },
    listMetadata: async () =>
      metadata.map((entry) => ({
        conversation_id: entry.conversation_id,
        name: entry.conversation_id,
        binding: entry.project_id
          ? { project_id: entry.project_id, workspace_root_ref: `root:${ROOT_ID}` as const }
          : null,
        project_binding_revision: 0,
        project_binding_receipt_id: null,
      })),
  };
}

type Fixture = {
  facade: ProjectWorkspaceFacade;
  registry: ProjectWorkspaceRegistryStore;
  artifactStore: ProjectWorkspaceConversationArtifactStore;
  stateRoot: string;
  rootPath: string;
  metadata: { conversation_id: string; project_id: string | null }[];
  placementId: string;
  setNowMs: (value: number) => void;
  cleanup: () => void;
};

function fixture(): Fixture {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-facade-state-'));
  const rootPath = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-facade-root-')));
  const registry = new ProjectWorkspaceRegistryStore({ state_root: stateRoot });
  registry.initializeSeat(SEAT_ID);
  registry.upsertRealm({
    seat_id: SEAT_ID,
    expected_revision: 0,
    realm: { realm_id: REALM_ID, label: 'Privat', path_slug: 'privat', status: 'active', order: 0 },
  });
  registry.registerRoot({
    seat_id: SEAT_ID,
    expected_seat_revision: 0,
    expected_global_revision: 0,
    root: {
      root_id: ROOT_ID,
      realm_id: REALM_ID,
      label: 'Home Root',
      kind: 'app_managed',
      path: rootPath,
      status: 'active',
    },
  });

  let nowMs = 1_000_000;
  const metadata: Fixture['metadata'] = [];
  const bindingClient = fakeBindingClient(metadata);
  const service = new ProjectWorkspaceService({
    registry,
    get_active_seat_id: () => SEAT_ID,
    semantic_coordinator: fakeSemanticCoordinator(),
  });
  const lifecycle = new ProjectWorkspaceLifecycleService({
    registry,
    operations: new ProjectLifecycleOperationStore(stateRoot),
    binding_client: bindingClient,
    get_active_seat_id: () => SEAT_ID,
    get_seat_context_revision: () => SEAT_REVISION,
    is_seat_switch_in_flight: () => false,
    resolve_hermes_home: () => path.join(stateRoot, 'hermes-home'),
  });
  let facade: ProjectWorkspaceFacade;
  const artifactStore = new ProjectWorkspaceConversationArtifactStore({
    state_root: stateRoot,
    on_changed: (artifact) => facade.notifyArtifactChanged(artifact),
  });
  facade = createProjectWorkspaceFacade({
    registry,
    service,
    lifecycle,
    artifact_store: artifactStore,
    binding_client: bindingClient,
    get_active_seat_id: () => SEAT_ID,
    get_active_seat_label: () => 'Alpha Seat',
    get_active_seat_context_revision: () => SEAT_REVISION,
    now_ms: () => nowMs,
  });
  return {
    facade,
    registry,
    artifactStore,
    stateRoot,
    rootPath,
    metadata,
    placementId: `${REALM_ID}:${ROOT_ID}`,
    setNowMs: (value) => {
      nowMs = value;
    },
    cleanup: () => {
      fs.rmSync(stateRoot, { recursive: true, force: true });
      fs.rmSync(rootPath, { recursive: true, force: true });
    },
  };
}

async function createProject(f: Fixture, title: string) {
  const preview = await f.facade.previewCreate({
    placement_id: f.placementId,
    title,
    seat_context_revision: SEAT_REVISION,
  });
  const receipt = await f.facade.create({
    preview_id: preview.preview_id,
    expected_preview_revision: preview.preview_revision,
    seat_context_revision: SEAT_REVISION,
    idempotency_key: crypto.randomUUID(),
  });
  if (receipt.outcome !== 'completed' || !receipt.project) throw new Error('create failed');
  return { preview, receipt, project: receipt.project };
}

describe('ProjectWorkspaceFacade (S81 R1b)', () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.cleanup();
    vi.clearAllMocks();
  });

  it('list returns path-free DTOs with conversation_count grouped by project', async () => {
    const { project } = await createProject(f, 'Atlas Projekt');
    f.metadata.push(
      { conversation_id: 'conv-one', project_id: project.project_id },
      { conversation_id: 'conv-two', project_id: project.project_id },
      { conversation_id: 'conv-unbound', project_id: null }
    );

    const dto = await f.facade.list();

    expect(dto.seat_label).toBe('Alpha Seat');
    expect(dto.seat_context_revision).toBe(SEAT_REVISION);
    expect(dto.automatic_creation_enabled).toBe(false);
    expect(dto.placements).toHaveLength(1);
    expect(dto.placements[0]).toMatchObject({
      placement_id: f.placementId,
      realm_kind: 'private',
      realm_label: 'Privat',
      root_label: 'Home Root',
      writable: true,
    });
    const summary = dto.projects.find((candidate) => candidate.project_id === project.project_id);
    expect(summary).toBeDefined();
    expect(summary?.conversation_count).toBe(2);
    expect(summary?.allowed_actions).toEqual(['edit', 'archive', 'reveal', 'undo']);
    expect(summary?.recovery_state).toBe('none');
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain(f.rootPath);
    expect(serialized).not.toContain(f.stateRoot);
    expect(serialized).not.toContain('.command-eve');
  });

  it('previewCreate -> create roundtrip commits the stashed plan', async () => {
    const { preview, receipt, project } = await createProject(f, 'Atlas Projekt');

    expect(preview.preview_revision).toBe(1);
    expect(preview.project_title).toBe('Atlas Projekt');
    expect(JSON.stringify(preview)).not.toContain(f.rootPath);
    expect(receipt.outcome).toBe('completed');
    expect(project.title).toBe('Atlas Projekt');
    expect(JSON.stringify(receipt)).not.toContain(f.rootPath);
    expect(fs.existsSync(path.join(f.rootPath, 'atlas-projekt'))).toBe(true);
  });

  it('ignores forged plan fields supplied by the caller', async () => {
    const preview = await f.facade.previewCreate({
      placement_id: f.placementId,
      title: 'Beta Projekt',
      seat_context_revision: SEAT_REVISION,
    });
    const legit = {
      preview_id: preview.preview_id,
      expected_preview_revision: preview.preview_revision,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: crypto.randomUUID(),
    };
    const forged = {
      ...legit,
      plan: { title: 'Evil', slug: 'evil', project_id: crypto.randomUUID() },
      title: 'Evil',
      slug: 'evil',
    } as unknown as Parameters<ProjectWorkspaceFacade['create']>[0];

    const receipt = await f.facade.create(forged);

    expect(receipt.outcome).toBe('completed');
    expect(receipt.project?.title).toBe('Beta Projekt');
    expect(fs.existsSync(path.join(f.rootPath, 'beta-projekt'))).toBe(true);
    expect(fs.existsSync(path.join(f.rootPath, 'evil'))).toBe(false);
  });

  it('rejects expired previews and revision mismatches with stale_snapshot', async () => {
    const expired = await f.facade.previewCreate({
      placement_id: f.placementId,
      title: 'Gamma Projekt',
      seat_context_revision: SEAT_REVISION,
    });
    f.setNowMs(1_000_000 + 300_001);
    const expiredReceipt = await f.facade.create({
      preview_id: expired.preview_id,
      expected_preview_revision: expired.preview_revision,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: crypto.randomUUID(),
    });
    expect(expiredReceipt).toMatchObject({ outcome: 'rejected', reason_code: 'stale_snapshot' });

    const preview = await f.facade.previewCreate({
      placement_id: f.placementId,
      title: 'Delta Projekt',
      seat_context_revision: SEAT_REVISION,
    });
    const mismatchReceipt = await f.facade.create({
      preview_id: preview.preview_id,
      expected_preview_revision: preview.preview_revision + 1,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: crypto.randomUUID(),
    });
    expect(mismatchReceipt).toMatchObject({ outcome: 'rejected', reason_code: 'stale_snapshot' });
  });

  // fs-heavy (full scaffold provisioning); generous timeout for parallel-suite load.
  it('undo maps the latest receipt main-side and returns a path-free receipt', { timeout: 60_000 }, async () => {
    const { project } = await createProject(f, 'Undo Projekt');
    const revision = f.registry.readSeatCatalogs(SEAT_ID).projects.revision;

    const receipt = await f.facade.undo({
      project_id: project.project_id,
      expected_revision: revision,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: crypto.randomUUID(),
    });

    expect(receipt.outcome).toBe('completed');
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(f.rootPath);
    expect(serialized).not.toContain('.command-eve');
    expect(fs.existsSync(path.join(f.rootPath, 'undo-projekt'))).toBe(false);
  });

  it('undo rejects a stale catalog revision without touching the filesystem', async () => {
    const { project } = await createProject(f, 'Stale Undo Projekt');
    const revision = f.registry.readSeatCatalogs(SEAT_ID).projects.revision;

    const receipt = await f.facade.undo({
      project_id: project.project_id,
      expected_revision: revision + 1,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: crypto.randomUUID(),
    });

    expect(receipt).toMatchObject({ outcome: 'rejected', reason_code: 'stale_snapshot' });
    expect(fs.existsSync(path.join(f.rootPath, 'stale-undo-projekt'))).toBe(true);
  });

  it('undo selects receipts by mtime, not by lexicographic filename order (Fable/Kimi fix)', async () => {
    const { project } = await createProject(f, 'Undo Mtime Projekt');
    const revision = f.registry.readSeatCatalogs(SEAT_ID).projects.revision;
    const receiptsDir = path.join(f.rootPath, 'undo-mtime-projekt', '.command-eve', 'receipts');
    const original = fs.readdirSync(receiptsDir).find((name) => name.endsWith('.json')) as string;
    const originalPath = path.join(receiptsDir, original);
    // Decoy: UUID filename sorts LAST lexicographically, but its mtime is OLDER.
    const decoyPath = path.join(receiptsDir, 'ffffffff-ffff-4fff-8fff-ffffffffffff.json');
    const content = JSON.parse(fs.readFileSync(originalPath, 'utf8')) as { transaction_id: string };
    content.transaction_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    fs.writeFileSync(decoyPath, JSON.stringify(content, null, 2));
    const now = Date.now();
    fs.utimesSync(originalPath, new Date(now), new Date(now));
    fs.utimesSync(decoyPath, new Date(now - 60_000), new Date(now - 60_000));

    const { ProjectWorkspaceService } = await import('@process/services/project-workspace/ProjectWorkspaceService');
    const undoSpy = vi
      .spyOn(ProjectWorkspaceService.prototype, 'undo')
      .mockResolvedValue({ ok: true, status: 'undone' });

    const receipt = await f.facade.undo({
      project_id: project.project_id,
      expected_revision: revision,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: crypto.randomUUID(),
    });

    // mtime-based selection picks the original receipt and completes the undo;
    // lexicographic selection would have hit the journal-less decoy and failed.
    expect(undoSpy).toHaveBeenCalledWith(originalPath);
    expect(undoSpy).not.toHaveBeenCalledWith(decoyPath);
    expect(receipt.outcome).toBe('completed');
  });

  it('reveal resolves the trusted path main-side via shell.showItemInFolder', async () => {
    const { project } = await createProject(f, 'Reveal Projekt');

    await f.facade.reveal({ project_id: project.project_id, seat_context_revision: SEAT_REVISION });

    expect(vi.mocked(shell.showItemInFolder)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(shell.showItemInFolder)).toHaveBeenCalledWith(path.join(f.rootPath, 'reveal-projekt'));
  });

  it('assertSeat throws seat.changed on revision mismatch', async () => {
    await expect(
      f.facade.previewCreate({ placement_id: f.placementId, title: 'Seat Test', seat_context_revision: 999 })
    ).rejects.toMatchObject({ reason_code: 'seat.changed' });
    await expect(
      f.facade.create({
        preview_id: crypto.randomUUID(),
        expected_preview_revision: 1,
        seat_context_revision: 999,
        idempotency_key: crypto.randomUUID(),
      })
    ).rejects.toMatchObject({ reason_code: 'seat.changed' });
    await expect(
      f.facade.reveal({ project_id: '33333333-3333-4333-8333-333333333333', seat_context_revision: 999 })
    ).rejects.toMatchObject({ reason_code: 'seat.changed' });
  });

  it('fans out artifact changes only to listeners of the same conversation', async () => {
    const seen: string[] = [];
    const unsubscribe = f.facade.subscribeConversationArtifacts({ conversation_id: 'conv-a' }, (artifact) =>
      seen.push(artifact.id)
    );
    f.facade.subscribeConversationArtifacts({ conversation_id: 'conv-b' }, (artifact) => seen.push(artifact.id));
    const payload = {
      artifact_id: 'artifact-1',
      state: 'preview' as const,
      intent_summary: 'create project',
      target_label: 'Privat / Home Root',
      project_title: 'Atlas Projekt',
      delta_summary: [],
      safe_follow_ups: [],
    };

    f.artifactStore.create({ seat_id: SEAT_ID, conversation_id: 'conv-a', artifact_id: 'artifact-1', payload });
    expect(seen).toEqual(['artifact-1']);

    unsubscribe();
    f.artifactStore.transition({
      seat_id: SEAT_ID,
      conversation_id: 'conv-a',
      artifact_id: 'artifact-1',
      expected_state: 'preview',
      payload: { ...payload, state: 'awaiting_confirmation' },
    });
    expect(seen).toEqual(['artifact-1']);

    const listed = await f.facade.listConversationArtifacts({ conversation_id: 'conv-a' });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.payload.state).toBe('awaiting_confirmation');
  });
});
