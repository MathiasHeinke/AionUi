import path from 'node:path';
import { bridge } from '@office-ai/platform';
import type {
  ProjectWorkspaceConversationArtifactDTO,
  ProjectWorkspaceExplicitChatIntentRequest,
  ProjectWorkspaceExplicitChatIntentResult,
  ProjectWorkspaceListDTO,
  ProjectWorkspacePreviewDTO,
  ProjectWorkspaceReceiptDTO,
} from '@/common/types/project-workspace/ui';
import {
  getActiveSeatContextRevision,
  getActiveSeatId,
  getActiveSeatLabel,
  resolveSeatHome,
} from '@process/commandEve/seatContextCore';
import { isCommandEveSeatSwitchInFlight } from './commandEveBridge';
import {
  createProjectWorkspaceFacade,
  type ProjectWorkspaceFacade,
} from '@process/services/project-workspace/ProjectWorkspaceFacade';
import { ProjectWorkspaceLifecycleService } from '@process/services/project-workspace/ProjectWorkspaceLifecycleService';
import { ProjectWorkspaceService } from '@process/services/project-workspace/ProjectWorkspaceService';
import { createAionCoreProjectBindingClient } from '@process/services/project-workspace/runtime/conversationBindingClient';
import { ProjectWorkspaceConversationArtifactStore } from '@process/services/project-workspace/storage/conversationArtifactStore';
import { ProjectWorkspaceRegistryStore } from '@process/services/project-workspace/storage/registryStore';
import { ProjectLifecycleOperationStore } from '@process/services/project-workspace/transaction/lifecycleOperationStore';
import { getDataPath } from '@process/utils/utils';

/**
 * S81/R1c — production wiring of the project workspace facade.
 *
 * Constructs the EAGER singletons (registry, services, facade) once at bridge
 * init and exposes the 14 request/response methods as `project-workspace.*`
 * providers. `subscribeConversationArtifacts` deliberately has NO provider —
 * artifact push flows through the `project-workspace.artifact-changed`
 * emitter with an already path-free payload.
 */

type MutationIdentity = {
  project_id: string;
  expected_revision: number;
  seat_context_revision: number;
  idempotency_key: string;
};

function backendPort(): number {
  const value = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  return typeof value === 'number' ? value : 0;
}

export function initProjectWorkspaceServiceBridge(): void {
  const state_root = path.join(getDataPath(), 'project-workspace');
  const registry = new ProjectWorkspaceRegistryStore({ state_root });
  const operations = new ProjectLifecycleOperationStore(state_root);
  const getPort = (): number => backendPort();
  const binding_client = createAionCoreProjectBindingClient({ get_port: getPort });
  const lifecycle = new ProjectWorkspaceLifecycleService({
    registry,
    operations,
    binding_client,
    get_active_seat_id: getActiveSeatId,
    get_seat_context_revision: getActiveSeatContextRevision,
    is_seat_switch_in_flight: isCommandEveSeatSwitchInFlight,
    resolve_hermes_home: (seatId) => resolveSeatHome(getDataPath(), seatId).hermesHome,
  });
  const service = new ProjectWorkspaceService({ registry, get_active_seat_id: getActiveSeatId });

  const artifactEmitter = bridge.buildEmitter<{
    conversation_id: string;
    artifact: ProjectWorkspaceConversationArtifactDTO;
  }>('project-workspace.artifact-changed');
  let facadeRef: ProjectWorkspaceFacade | undefined;
  const artifact_store = new ProjectWorkspaceConversationArtifactStore({
    state_root,
    on_changed: (artifact) => {
      facadeRef?.notifyArtifactChanged(artifact);
      // The artifact DTO is path-free by construction; only the opaque
      // conversation id + payload cross to the renderer.
      artifactEmitter.emit({ conversation_id: artifact.conversation_id, artifact });
    },
  });
  const facade = createProjectWorkspaceFacade({
    registry,
    service,
    lifecycle,
    artifact_store,
    binding_client,
    get_active_seat_id: getActiveSeatId,
    get_active_seat_label: getActiveSeatLabel,
    get_active_seat_context_revision: getActiveSeatContextRevision,
    is_seat_switch_in_flight: isCommandEveSeatSwitchInFlight,
  });
  facadeRef = facade;

  bridge.buildProvider<ProjectWorkspaceListDTO, void>('project-workspace.list').provider(() => facade.list());
  bridge
    .buildProvider<ProjectWorkspaceConversationArtifactDTO[], { conversation_id: string }>(
      'project-workspace.listConversationArtifacts'
    )
    .provider((input) => facade.listConversationArtifacts(input));
  bridge
    .buildProvider<
      ProjectWorkspacePreviewDTO,
      { placement_id: string; title: string; profile?: string; seat_context_revision: number }
    >('project-workspace.previewCreate')
    .provider((input) => facade.previewCreate(input));
  bridge
    .buildProvider<
      ProjectWorkspaceReceiptDTO,
      { preview_id: string; expected_preview_revision: number; seat_context_revision: number; idempotency_key: string }
    >('project-workspace.create')
    .provider((input) => facade.create(input));
  bridge
    .buildProvider<ProjectWorkspacePreviewDTO | null, { title?: string; seat_context_revision: number }>(
      'project-workspace.previewAdopt'
    )
    .provider((input) => facade.previewAdopt(input));
  bridge
    .buildProvider<
      ProjectWorkspaceReceiptDTO,
      { preview_id: string; expected_preview_revision: number; seat_context_revision: number; idempotency_key: string }
    >('project-workspace.adopt')
    .provider((input) => facade.adopt(input));
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity & { title: string }>('project-workspace.updateMetadata')
    .provider((input) => facade.updateMetadata(input));
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity>('project-workspace.archive')
    .provider((input) => facade.archive(input));
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity>('project-workspace.restore')
    .provider((input) => facade.restore(input));
  bridge
    .buildProvider<void, { project_id: string; seat_context_revision: number }>('project-workspace.reveal')
    .provider((input) => facade.reveal(input));
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity>('project-workspace.recover')
    .provider((input) => facade.recover(input));
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity>('project-workspace.undo')
    .provider((input) => facade.undo(input));
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity & { conversation_id: string }>(
      'project-workspace.bindConversation'
    )
    .provider((input) => facade.bindConversation(input));
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity & { conversation_id: string }>(
      'project-workspace.unbindConversation'
    )
    .provider((input) => facade.unbindConversation(input));
  bridge
    .buildProvider<ProjectWorkspaceExplicitChatIntentResult, ProjectWorkspaceExplicitChatIntentRequest>(
      'project-workspace.chat-intent'
    )
    .provider(async (input) => facade.chatIntent(input));

  // S81/R2 — boot-time recovery of interrupted workspace transactions.
  // Deliberately fire-and-forget: recovery NEVER blocks the boot path, and a
  // failure is logged, not thrown.
  void service
    .recoverAll()
    .then((results) => {
      const recovered = results.filter((result) => result.ok).length;
      if (results.length > 0) {
        console.log(`[ProjectWorkspace] boot recovery: ${recovered}/${results.length} reconciled`);
      }
    })
    .catch((error: unknown) => console.error('[ProjectWorkspace] boot recovery failed (non-blocking)', error));
}
