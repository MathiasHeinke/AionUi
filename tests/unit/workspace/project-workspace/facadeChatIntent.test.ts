import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function fakeBindingClient(): ProjectConversationMetadataClient {
  return {
    read: async () => ({ binding: null, project_binding_revision: 0, project_binding_receipt_id: null }),
    compareAndSwap: async (input) => ({
      binding: input.next,
      project_binding_revision: input.expected_project_binding_revision + 1,
      project_binding_receipt_id: input.project_binding_operation_id,
    }),
    readMetadata: async () => {
      throw new Error('not needed');
    },
    listMetadata: async () => [],
  };
}

type Fixture = {
  facade: ProjectWorkspaceFacade;
  registry: ProjectWorkspaceRegistryStore;
  lifecycle: ProjectWorkspaceLifecycleService;
  artifactStore: ProjectWorkspaceConversationArtifactStore;
  stateRoot: string;
  rootPath: string;
  setSeatSwitchInFlight: (value: boolean) => void;
  cleanup: () => void;
};

function fixture(): Fixture {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-intent-state-'));
  const rootPath = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-intent-root-')));
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

  let seatSwitchInFlight = false;
  const bindingClient = fakeBindingClient();
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
    is_seat_switch_in_flight: () => seatSwitchInFlight,
    resolve_hermes_home: () => path.join(stateRoot, 'hermes-home'),
  });
  const artifactStore = new ProjectWorkspaceConversationArtifactStore({ state_root: stateRoot });
  const facade = createProjectWorkspaceFacade({
    registry,
    service,
    lifecycle,
    artifact_store: artifactStore,
    binding_client: bindingClient,
    get_active_seat_id: () => SEAT_ID,
    get_active_seat_label: () => 'Alpha Seat',
    get_active_seat_context_revision: () => SEAT_REVISION,
    is_seat_switch_in_flight: () => seatSwitchInFlight,
  });
  return {
    facade,
    registry,
    lifecycle,
    artifactStore,
    stateRoot,
    rootPath,
    setSeatSwitchInFlight: (value) => {
      seatSwitchInFlight = value;
    },
    cleanup: () => {
      fs.rmSync(stateRoot, { recursive: true, force: true });
      fs.rmSync(rootPath, { recursive: true, force: true });
    },
  };
}

async function createProject(f: Fixture, title: string): Promise<string> {
  const preview = await f.facade.previewCreate({
    placement_id: `${REALM_ID}:${ROOT_ID}`,
    title,
    seat_context_revision: SEAT_REVISION,
  });
  const receipt = await f.facade.create({
    preview_id: preview.preview_id,
    expected_preview_revision: preview.preview_revision,
    seat_context_revision: SEAT_REVISION,
    idempotency_key: crypto.randomUUID(),
  });
  if (receipt.outcome !== 'completed' || !receipt.project) throw new Error(`create failed for ${title}`);
  return receipt.project.project_id;
}

function chatRequest(input: string, seatContextRevision = 0) {
  return {
    conversation_id: 'conv-chat',
    input,
    seat_context_revision: seatContextRevision,
    idempotency_key: crypto.randomUUID(),
  };
}

describe('ProjectWorkspaceFacade.chatIntent (S81 R3)', () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.cleanup();
    vi.restoreAllMocks();
  });

  it('passes through with zero candidates: no artifact, no binding call', async () => {
    await createProject(f, 'Atlas Projekt');
    const bindSpy = vi.spyOn(f.lifecycle, 'bindConversation');

    const result = await f.facade.chatIntent(chatRequest('voellig unrelated themenwelt xqzv'));

    expect(result).toEqual({ decision: 'pass_through' });
    expect(bindSpy).not.toHaveBeenCalled();
    expect(f.artifactStore.list(SEAT_ID, 'conv-chat')).toEqual([]);
  });

  it('binds the single match and completes the artifact', async () => {
    const projectId = await createProject(f, 'Atlas Projekt');
    const bindSpy = vi.spyOn(f.lifecycle, 'bindConversation');
    const expectedRevision = f.registry.readSeatCatalogs(SEAT_ID).projects.revision;
    const request = chatRequest('bitte analysiere das atlas projekt budget');

    const result = await f.facade.chatIntent(request);

    expect(result.decision).toBe('handled');
    expect(bindSpy).toHaveBeenCalledTimes(1);
    expect(bindSpy).toHaveBeenCalledWith({
      project_id: projectId,
      expected_revision: expectedRevision,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: request.idempotency_key,
      conversation_id: 'conv-chat',
    });
    const artifacts = f.artifactStore.list(SEAT_ID, 'conv-chat');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.payload.state).toBe('completed');
    expect(artifacts[0]?.payload.project_id).toBe(projectId);
    expect(artifacts[0]?.payload.receipt?.outcome).toBe('completed');
    if (result.decision === 'handled') expect(artifacts[0]?.id).toBe(result.artifact_id);
  });

  it('asks for clarification on multiple matches without binding', async () => {
    await createProject(f, 'Atlas Alpha');
    await createProject(f, 'Atlas Beta');
    const bindSpy = vi.spyOn(f.lifecycle, 'bindConversation');

    const result = await f.facade.chatIntent(chatRequest('atlas alpha beta status bitte'));

    expect(result.decision).toBe('needs_clarification');
    if (result.decision === 'needs_clarification') {
      expect(result.question).toContain('Atlas Alpha');
      expect(result.question).toContain('Atlas Beta');
    }
    expect(bindSpy).not.toHaveBeenCalled();
    const artifacts = f.artifactStore.list(SEAT_ID, 'conv-chat');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.payload.state).toBe('awaiting_confirmation');
  });

  it('does not bind when the renderer deadline has already passed (Fable/Grok race fix)', async () => {
    await createProject(f, 'Atlas Projekt');
    const bindSpy = vi.spyOn(f.lifecycle, 'bindConversation');

    const result = await f.facade.chatIntent({
      ...chatRequest('bitte analysiere das atlas projekt budget'),
      deadline_ms: Date.now() - 1,
    });

    expect(result).toEqual({ decision: 'pass_through' });
    expect(bindSpy).not.toHaveBeenCalled();
    expect(f.artifactStore.list(SEAT_ID, 'conv-chat')).toEqual([]);
  });

  it('binds when the renderer deadline is still in the future', async () => {
    await createProject(f, 'Atlas Projekt');
    const bindSpy = vi.spyOn(f.lifecycle, 'bindConversation');

    const result = await f.facade.chatIntent({
      ...chatRequest('bitte analysiere das atlas projekt budget'),
      deadline_ms: Date.now() + 60_000,
    });

    expect(result.decision).toBe('handled');
    expect(bindSpy).toHaveBeenCalledTimes(1);
  });

  it('passes through on a stale seat context revision', async () => {
    await createProject(f, 'Atlas Projekt');
    const bindSpy = vi.spyOn(f.lifecycle, 'bindConversation');

    const result = await f.facade.chatIntent(chatRequest('bitte analysiere das atlas projekt budget', 999));

    expect(result).toEqual({ decision: 'pass_through' });
    expect(bindSpy).not.toHaveBeenCalled();
  });

  it('passes through while a seat switch is in flight', async () => {
    await createProject(f, 'Atlas Projekt');
    f.setSeatSwitchInFlight(true);
    const bindSpy = vi.spyOn(f.lifecycle, 'bindConversation');

    const result = await f.facade.chatIntent(chatRequest('bitte analysiere das atlas projekt budget'));

    expect(result).toEqual({ decision: 'pass_through' });
    expect(bindSpy).not.toHaveBeenCalled();
  });

  it('fails open when the binding call throws', async () => {
    await createProject(f, 'Atlas Projekt');
    vi.spyOn(f.lifecycle, 'bindConversation').mockRejectedValue(new Error('binding boom'));

    const result = await f.facade.chatIntent(chatRequest('bitte analysiere das atlas projekt budget'));

    expect(result).toEqual({ decision: 'pass_through' });
  });

  it('fails open with a rejected artifact when the bind receipt is rejected (1.818 CAO-P2)', async () => {
    await createProject(f, 'Atlas Projekt');
    vi.spyOn(f.lifecycle, 'bindConversation').mockResolvedValue({
      receipt_id: 'receipt-rejected-1',
      outcome: 'rejected',
      completed_at: Date.now(),
      reason_code: 'stale_snapshot',
      safe_follow_ups: [],
    });

    const result = await f.facade.chatIntent(chatRequest('bitte analysiere das atlas projekt budget'));

    // The send goes out unbound; the artifact records the actual rejection
    // instead of claiming a completed bind that never happened.
    expect(result).toEqual({ decision: 'pass_through' });
    const artifacts = f.artifactStore.list(SEAT_ID, 'conv-chat');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.payload.state).toBe('rejected');
    expect(artifacts[0]?.payload.receipt?.outcome).toBe('rejected');
    expect(artifacts[0]?.payload.reason_code).toBe('stale_snapshot');
    expect(artifacts[0]?.payload.safe_follow_ups).toEqual([]);
    expect(artifacts[0]?.payload.intent_summary_i18n).toEqual({
      key: 'common.projects.chatIntent.bindRejectedSummary',
      params: { title: 'Atlas Projekt' },
    });
  });

  it('fails open with a recovery artifact and safe recover action when the bind needs recovery', async () => {
    await createProject(f, 'Atlas Projekt');
    vi.spyOn(f.lifecycle, 'bindConversation').mockResolvedValue({
      receipt_id: 'receipt-recovery-1',
      outcome: 'recovery_required',
      completed_at: Date.now(),
      reason_code: 'recovery_required',
      safe_follow_ups: ['recover'],
    });

    const result = await f.facade.chatIntent(chatRequest('bitte analysiere das atlas projekt budget'));

    expect(result).toEqual({ decision: 'pass_through' });
    const artifacts = f.artifactStore.list(SEAT_ID, 'conv-chat');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.payload).toMatchObject({
      state: 'recovery_required',
      reason_code: 'recovery_required',
      safe_follow_ups: ['recover'],
      receipt: { receipt_id: 'receipt-recovery-1', outcome: 'recovery_required' },
      intent_summary_i18n: {
        key: 'common.projects.chatIntent.bindRecoveryRequiredSummary',
        params: { title: 'Atlas Projekt' },
      },
    });
  });

  it('ships the bound summary as an i18n ref with an English fallback (1.818 CAO-P2)', async () => {
    await createProject(f, 'Atlas Projekt');

    const result = await f.facade.chatIntent(chatRequest('bitte analysiere das atlas projekt budget'));

    expect(result.decision).toBe('handled');
    const artifacts = f.artifactStore.list(SEAT_ID, 'conv-chat');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.payload.intent_summary).toBe('Conversation assigned to project "Atlas Projekt"');
    expect(artifacts[0]?.payload.intent_summary_i18n).toEqual({
      key: 'common.projects.chatIntent.boundSummary',
      params: { title: 'Atlas Projekt' },
    });
  });

  it('ships the clarification copy as an i18n ref with an English fallback (1.818 CAO-P2)', async () => {
    await createProject(f, 'Atlas Alpha');
    await createProject(f, 'Atlas Beta');

    const result = await f.facade.chatIntent(chatRequest('atlas alpha beta status bitte'));

    expect(result.decision).toBe('needs_clarification');
    if (result.decision === 'needs_clarification') {
      expect(result.question_i18n?.key).toBe('common.projects.chatIntent.clarifyQuestion');
      expect(result.question_i18n?.params?.titles).toHaveLength(2);
      expect(result.question_i18n?.params?.titles).toEqual(expect.arrayContaining(['"Atlas Alpha"', '"Atlas Beta"']));
      // English fallback keeps the titles for version-skew rendering.
      expect(result.question).toContain('Atlas Alpha');
      expect(result.question).toContain('Atlas Beta');
    }
    const artifacts = f.artifactStore.list(SEAT_ID, 'conv-chat');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.payload.question_i18n?.key).toBe('common.projects.chatIntent.clarifyQuestion');
    expect(artifacts[0]?.payload.intent_summary_i18n).toEqual({ key: 'common.projects.chatIntent.ambiguousSummary' });
  });
});
