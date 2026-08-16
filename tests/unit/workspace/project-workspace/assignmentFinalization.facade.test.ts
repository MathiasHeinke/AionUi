import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectWorkspaceAssignmentPreviewRequest } from '@/common/types/project-workspace/ui';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import {
  createProjectWorkspaceFacade,
  type ProjectWorkspaceFacade,
} from '@process/services/project-workspace/ProjectWorkspaceFacade';
import type { ProjectWorkspaceLifecycleService } from '@process/services/project-workspace/ProjectWorkspaceLifecycleService';
import type { ProjectWorkspaceService } from '@process/services/project-workspace/ProjectWorkspaceService';
import type {
  ProjectBindingSnapshot,
  ProjectConversationMetadataClient,
} from '@process/services/project-workspace/runtime/conversationBindingClient';
import { ProjectWorkspaceConversationArtifactStore } from '@process/services/project-workspace/storage/conversationArtifactStore';
import type {
  ProjectWorkspaceRegistryStore,
  SeatCatalogBundle,
} from '@process/services/project-workspace/storage/registryStore';

const SEAT_ID = 'seat-alpha';
const SEAT_REVISION = 7;
const REALM_ID = '11111111-1111-4111-8111-111111111111';
const ROOT_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_A = '33333333-3333-4333-8333-333333333333';
const PROJECT_B = '44444444-4444-4444-8444-444444444444';
const OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const CONVERSATION_ID = 'conversation-alpha';
const ARTIFACT_ID = 'artifact-alpha';

type Fixture = {
  facade: ProjectWorkspaceFacade;
  artifactStore: ProjectWorkspaceConversationArtifactStore;
  catalogs: SeatCatalogBundle;
  binding: ProjectBindingSnapshot;
  compareAndSwap: ReturnType<typeof vi.fn>;
  updateMetadata: ReturnType<typeof vi.fn>;
  changed: ReturnType<typeof vi.fn>;
  cleanup: () => void;
};

const projectRecord = (projectId: string, title: string, slug: string) => ({
  project_id: projectId,
  seat_id: SEAT_ID,
  realm_id: REALM_ID,
  root_id: ROOT_ID,
  workspace_root_ref: `root:${ROOT_ID}` as const,
  title,
  slug,
  status: 'active' as const,
  manifest_relative_path: `${slug}/.command-eve/project.json`,
  canonical_project_path: `/managed/${slug}`,
  comparison_key: `/managed/${slug}`,
  registered_at: '2026-08-16T00:00:00.000Z',
});

function fixture(): Fixture {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-assignment-finalization-'));
  const changed = vi.fn();
  let now = 1_000;
  const artifactStore = new ProjectWorkspaceConversationArtifactStore({
    state_root: stateRoot,
    now: () => now++,
    on_changed: changed,
  });
  artifactStore.create({
    seat_id: SEAT_ID,
    conversation_id: CONVERSATION_ID,
    artifact_id: ARTIFACT_ID,
    payload: {
      artifact_id: ARTIFACT_ID,
      state: 'preview',
      project_id: PROJECT_A,
      intent_summary: 'Conversation assigned automatically',
      target_label: 'Alpha',
      project_title: 'Alpha',
      delta_summary: ['assign conversation'],
      safe_follow_ups: [],
    },
  });
  artifactStore.transition({
    seat_id: SEAT_ID,
    conversation_id: CONVERSATION_ID,
    artifact_id: ARTIFACT_ID,
    expected_state: 'preview',
    payload: {
      artifact_id: ARTIFACT_ID,
      state: 'completed',
      project_id: PROJECT_A,
      intent_summary: 'Conversation assigned automatically',
      target_label: 'Alpha',
      project_title: 'Alpha',
      delta_summary: ['assign conversation'],
      safe_follow_ups: ['reveal', 'edit'],
    },
  });

  const catalogs: SeatCatalogBundle = {
    realms: {
      schema_version: 'command-eve-realm-catalog/v1',
      seat_id: SEAT_ID,
      revision: 1,
      realms: [{ realm_id: REALM_ID, label: 'Business', path_slug: 'business', status: 'active', order: 0 }],
      updated_at: '2026-08-16T00:00:00.000Z',
    },
    roots: {
      schema_version: 'command-eve-root-catalog/v1',
      seat_id: SEAT_ID,
      revision: 1,
      roots: [
        {
          root_id: ROOT_ID,
          realm_id: REALM_ID,
          label: 'Managed',
          kind: 'app_managed',
          canonical_path: '/managed',
          comparison_key: '/managed',
          workspace_root_ref: `root:${ROOT_ID}`,
          status: 'active',
        },
      ],
      updated_at: '2026-08-16T00:00:00.000Z',
    },
    projects: {
      schema_version: 'command-eve-project-catalog/v1',
      seat_id: SEAT_ID,
      revision: 2,
      projects: [projectRecord(PROJECT_A, 'Alpha', 'alpha'), projectRecord(PROJECT_B, 'Beta', 'beta')],
      updated_at: '2026-08-16T00:00:00.000Z',
    },
  };
  const registry = {
    stateRoot,
    readSeatCatalogs: (seatId: string) => {
      if (seatId !== SEAT_ID) throw new Error('wrong seat');
      return catalogs;
    },
  } as unknown as ProjectWorkspaceRegistryStore;
  const binding: ProjectBindingSnapshot = {
    binding: { project_id: PROJECT_A, workspace_root_ref: `root:${ROOT_ID}` },
    project_binding_revision: 4,
    project_binding_receipt_id: '66666666-6666-4666-8666-666666666666',
  };
  const compareAndSwap = vi.fn(async (input) => {
    expect(input.expected).toEqual(binding.binding);
    expect(input.expected_project_binding_revision).toBe(binding.project_binding_revision);
    expect(input.expected_project_binding_receipt_id).toBe(binding.project_binding_receipt_id);
    binding.binding = input.next;
    binding.project_binding_revision += 1;
    binding.project_binding_receipt_id = input.project_binding_operation_id;
    return { ...binding };
  });
  const bindingClient: ProjectConversationMetadataClient = {
    read: async () => ({ ...binding }),
    compareAndSwap,
    readMetadata: async (conversationId) => {
      if (conversationId !== CONVERSATION_ID) throw new Error('wrong conversation');
      return {
        conversation_id: CONVERSATION_ID,
        name: 'Conversation',
        conversation_type: 'acp',
        backend: 'hermes',
        is_temporary_workspace: false,
        custom_workspace: false,
        ...binding,
      };
    },
    listMetadata: async () => [],
  };
  const updateMetadata = vi.fn(async (request) => {
    if (request.expected_revision !== catalogs.projects.revision) {
      throw new ProjectWorkspaceError('catalog.revision-conflict');
    }
    catalogs.projects.projects = catalogs.projects.projects.map((project) =>
      project.project_id === request.project_id ? { ...project, title: request.title } : project
    );
    catalogs.projects.revision += 1;
    return {
      receipt_id: request.idempotency_key,
      outcome: 'completed' as const,
      completed_at: now,
      safe_follow_ups: [],
    };
  });
  const facade = createProjectWorkspaceFacade({
    registry,
    service: {} as ProjectWorkspaceService,
    lifecycle: { updateMetadata } as unknown as ProjectWorkspaceLifecycleService,
    artifact_store: artifactStore,
    binding_client: bindingClient,
    get_active_seat_id: () => SEAT_ID,
    get_active_seat_label: () => 'Alpha seat',
    get_active_seat_context_revision: () => SEAT_REVISION,
    now_ms: () => now++,
  });
  return {
    facade,
    artifactStore,
    catalogs,
    binding,
    compareAndSwap,
    updateMetadata,
    changed,
    cleanup: () => fs.rmSync(stateRoot, { recursive: true, force: true }),
  };
}

function previewRequest(f: Fixture, choice: ProjectWorkspaceAssignmentPreviewRequest['choice']) {
  const artifact = f.artifactStore.list(SEAT_ID, CONVERSATION_ID)[0];
  return {
    conversation_id: CONVERSATION_ID,
    artifact_id: ARTIFACT_ID,
    expected_artifact_updated_at: artifact.updated_at,
    expected_catalog_revision: f.catalogs.projects.revision,
    expected_current_project_revision: f.catalogs.projects.revision,
    seat_context_revision: SEAT_REVISION,
    choice,
  } satisfies ProjectWorkspaceAssignmentPreviewRequest;
}

describe('ProjectWorkspaceFacade assignment finalization', () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.cleanup();
    vi.restoreAllMocks();
  });

  it('reassigns A to B in one binding CAS and persists a finalized artifact', async () => {
    const preview = await f.facade.previewAssignment(
      previewRequest(f, { kind: 'project', project_id: PROJECT_B, expected_project_revision: 2 })
    );
    const receipt = await f.facade.commitAssignment({
      preview_id: preview.preview_id,
      expected_preview_revision: preview.preview_revision,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: OPERATION_ID,
    });

    expect(f.compareAndSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        expected: { project_id: PROJECT_A, workspace_root_ref: `root:${ROOT_ID}` },
        next: { project_id: PROJECT_B, workspace_root_ref: `root:${ROOT_ID}` },
      })
    );
    expect(receipt).toMatchObject({ outcome: 'completed', assignment: 'project', project: { project_id: PROJECT_B } });
    expect(receipt.artifact?.payload).toMatchObject({
      project_id: PROJECT_B,
      project_title: 'Beta',
      target_label: 'Business / Managed',
      assignment_finalized_at: expect.any(Number),
    });
  });

  it('switches to temporary with one A to null CAS and no renderer-side gap', async () => {
    const preview = await f.facade.previewAssignment(previewRequest(f, { kind: 'temporary' }));
    const receipt = await f.facade.commitAssignment({
      preview_id: preview.preview_id,
      expected_preview_revision: preview.preview_revision,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: OPERATION_ID,
    });

    expect(f.compareAndSwap).toHaveBeenCalledWith(expect.objectContaining({ next: null }));
    expect(receipt).toMatchObject({ outcome: 'completed', assignment: 'temporary' });
    expect(receipt.artifact?.payload.project_id).toBeUndefined();
    expect(receipt.artifact?.payload).toMatchObject({
      project_title: 'Temp',
      target_label: 'Temporary Space',
    });
  });

  it('journals a bounded keep-title revision before finalizing the artifact', async () => {
    const preview = await f.facade.previewAssignment(previewRequest(f, { kind: 'keep', title: 'Alpha final' }));
    const receipt = await f.facade.commitAssignment({
      preview_id: preview.preview_id,
      expected_preview_revision: preview.preview_revision,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: OPERATION_ID,
    });

    expect(f.updateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: PROJECT_A, expected_revision: 2, title: 'Alpha final' })
    );
    expect(f.compareAndSwap).not.toHaveBeenCalled();
    expect(receipt.project).toMatchObject({ project_id: PROJECT_A, title: 'Alpha final', revision: 3 });
    expect(receipt.artifact?.payload).toMatchObject({
      project_title: 'Alpha final',
      target_label: 'Business / Managed',
      assignment_finalized_at: expect.any(Number),
    });
  });

  it('replays the same commit without a second binding write or artifact revision', async () => {
    const preview = await f.facade.previewAssignment(
      previewRequest(f, { kind: 'project', project_id: PROJECT_B, expected_project_revision: 2 })
    );
    const request = {
      preview_id: preview.preview_id,
      expected_preview_revision: preview.preview_revision,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: OPERATION_ID,
    };
    const first = await f.facade.commitAssignment(request);
    const changedAfterFirst = f.changed.mock.calls.length;
    const second = await f.facade.commitAssignment(request);

    expect(second).toEqual(first);
    expect(f.compareAndSwap).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenCalledTimes(changedAfterFirst);
  });

  it('rejects a stale artifact revision before it creates a preview', async () => {
    await expect(
      f.facade.previewAssignment({
        ...previewRequest(f, { kind: 'keep' }),
        expected_artifact_updated_at: 0,
      })
    ).rejects.toMatchObject({ reason_code: 'catalog.revision-conflict' });
    expect(f.compareAndSwap).not.toHaveBeenCalled();
  });

  it('rejects a binding revision changed after preview without overwriting it', async () => {
    const preview = await f.facade.previewAssignment(
      previewRequest(f, { kind: 'project', project_id: PROJECT_B, expected_project_revision: 2 })
    );
    f.binding.project_binding_revision += 1;

    await expect(
      f.facade.commitAssignment({
        preview_id: preview.preview_id,
        expected_preview_revision: preview.preview_revision,
        seat_context_revision: SEAT_REVISION,
        idempotency_key: OPERATION_ID,
      })
    ).rejects.toMatchObject({ reason_code: 'catalog.revision-conflict' });
    expect(f.compareAndSwap).not.toHaveBeenCalled();
  });

  it('rejects a seat revision changed after preview before any binding write', async () => {
    const preview = await f.facade.previewAssignment(
      previewRequest(f, { kind: 'project', project_id: PROJECT_B, expected_project_revision: 2 })
    );

    await expect(
      f.facade.commitAssignment({
        preview_id: preview.preview_id,
        expected_preview_revision: preview.preview_revision,
        seat_context_revision: SEAT_REVISION + 1,
        idempotency_key: OPERATION_ID,
      })
    ).rejects.toMatchObject({ reason_code: 'seat.changed' });
    expect(f.compareAndSwap).not.toHaveBeenCalled();
  });

  it('rejects a catalog revision changed after preview before any binding write', async () => {
    const preview = await f.facade.previewAssignment(
      previewRequest(f, { kind: 'project', project_id: PROJECT_B, expected_project_revision: 2 })
    );
    f.catalogs.projects.revision += 1;

    await expect(
      f.facade.commitAssignment({
        preview_id: preview.preview_id,
        expected_preview_revision: preview.preview_revision,
        seat_context_revision: SEAT_REVISION,
        idempotency_key: OPERATION_ID,
      })
    ).rejects.toMatchObject({ reason_code: 'catalog.revision-conflict' });
    expect(f.compareAndSwap).not.toHaveBeenCalled();
  });

  it('rejects an artifact updated after preview before any binding write', async () => {
    const preview = await f.facade.previewAssignment(
      previewRequest(f, { kind: 'project', project_id: PROJECT_B, expected_project_revision: 2 })
    );
    const current = f.artifactStore.list(SEAT_ID, CONVERSATION_ID)[0];
    f.artifactStore.reviseCompleted({
      seat_id: SEAT_ID,
      conversation_id: CONVERSATION_ID,
      artifact_id: ARTIFACT_ID,
      expected_updated_at: current.updated_at,
      payload: { ...current.payload, question: 'A newer assignment decision exists' },
    });

    await expect(
      f.facade.commitAssignment({
        preview_id: preview.preview_id,
        expected_preview_revision: preview.preview_revision,
        seat_context_revision: SEAT_REVISION,
        idempotency_key: OPERATION_ID,
      })
    ).rejects.toMatchObject({ reason_code: 'catalog.revision-conflict' });
    expect(f.compareAndSwap).not.toHaveBeenCalled();
  });

  it('rejects an archived target even when the renderer revisions match', async () => {
    f.catalogs.projects.projects = f.catalogs.projects.projects.map((project) =>
      project.project_id === PROJECT_B ? { ...project, status: 'archived' as const } : project
    );
    await expect(
      f.facade.previewAssignment(
        previewRequest(f, { kind: 'project', project_id: PROJECT_B, expected_project_revision: 2 })
      )
    ).rejects.toMatchObject({ reason_code: 'catalog.revision-conflict' });
  });
});
