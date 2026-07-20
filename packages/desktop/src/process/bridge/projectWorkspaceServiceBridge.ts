import crypto from 'node:crypto';
import path from 'node:path';
import { bridge } from '@office-ai/platform';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import type {
  ProjectWorkspaceConversationArtifactDTO,
  ProjectWorkspaceExplicitChatIntentRequest,
  ProjectWorkspaceExplicitChatIntentResult,
  ProjectWorkspaceListDTO,
  ProjectWorkspacePreviewDTO,
  ProjectWorkspaceReceiptDTO,
  ProjectWorkspaceUiReasonCode,
} from '@/common/types/project-workspace/ui';
import { mapProjectWorkspaceReason } from '@process/services/project-workspace/core/lifecycleReasonCore';
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

/**
 * IPC error mapping (Kimi F1 review finding). The platform's subscribe wrapper
 * attaches only `.then(...)` to provider results — a provider that THROWS
 * never emits the callback, so the renderer's invoke hangs forever. Providers
 * registered here must therefore never throw across the boundary: every error
 * is converted into a method-appropriate value (fail-closed for mutations,
 * notice/empty payloads for reads).
 */
function toReasonCode(error: unknown): ProjectWorkspaceUiReasonCode {
  return error instanceof ProjectWorkspaceError ? mapProjectWorkspaceReason(error.reason_code) : 'invariant_failure';
}

function rejectedReceiptFor(error: unknown, idempotencyKey: string): ProjectWorkspaceReceiptDTO {
  const reason = toReasonCode(error);
  return {
    receipt_id: idempotencyKey,
    outcome: reason === 'recovery_required' ? 'recovery_required' : 'rejected',
    completed_at: Date.now(),
    reason_code: reason,
    safe_follow_ups: [],
  };
}

function noticeListFor(error: unknown): ProjectWorkspaceListDTO {
  return {
    seat_label: getActiveSeatLabel(),
    seat_context_revision: getActiveSeatContextRevision(),
    automatic_creation_enabled: false,
    placements: [],
    projects: [],
    notice_reason: toReasonCode(error),
  };
}

function failedPreviewFor(error: unknown, title: string): ProjectWorkspacePreviewDTO {
  return {
    preview_id: crypto.randomUUID(),
    preview_revision: 0,
    destination_label: '',
    project_title: title,
    scaffold_summary: [],
    semantic_writes: [],
    conversation_effect: '',
    warnings: [toReasonCode(error)],
    // Already expired on arrival: a create attempted from this stub fails
    // closed as stale instead of provisioning from an invalid preview.
    expires_at: Date.now(),
  };
}

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

  bridge.buildProvider<ProjectWorkspaceListDTO, void>('project-workspace.list').provider(async () => {
    try {
      return await facade.list();
    } catch (error) {
      return noticeListFor(error);
    }
  });
  bridge
    .buildProvider<ProjectWorkspaceConversationArtifactDTO[], { conversation_id: string }>(
      'project-workspace.listConversationArtifacts'
    )
    .provider(async (input) => {
      try {
        return await facade.listConversationArtifacts(input);
      } catch {
        return [];
      }
    });
  bridge
    .buildProvider<
      ProjectWorkspacePreviewDTO,
      { placement_id: string; title: string; profile?: string; seat_context_revision: number }
    >('project-workspace.previewCreate')
    .provider(async (input) => {
      try {
        return await facade.previewCreate(input);
      } catch (error) {
        return failedPreviewFor(error, input.title);
      }
    });
  bridge
    .buildProvider<
      ProjectWorkspaceReceiptDTO,
      { preview_id: string; expected_preview_revision: number; seat_context_revision: number; idempotency_key: string }
    >('project-workspace.create')
    .provider(async (input) => {
      try {
        return await facade.create(input);
      } catch (error) {
        return rejectedReceiptFor(error, input.idempotency_key);
      }
    });
  bridge
    .buildProvider<ProjectWorkspacePreviewDTO | null, { title?: string; seat_context_revision: number }>(
      'project-workspace.previewAdopt'
    )
    .provider(async (input) => {
      try {
        return await facade.previewAdopt(input);
      } catch {
        return null;
      }
    });
  bridge
    .buildProvider<
      ProjectWorkspaceReceiptDTO,
      { preview_id: string; expected_preview_revision: number; seat_context_revision: number; idempotency_key: string }
    >('project-workspace.adopt')
    .provider(async (input) => {
      try {
        return await facade.adopt(input);
      } catch (error) {
        return rejectedReceiptFor(error, input.idempotency_key);
      }
    });
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity & { title: string }>('project-workspace.updateMetadata')
    .provider(async (input) => {
      try {
        return await facade.updateMetadata(input);
      } catch (error) {
        return rejectedReceiptFor(error, input.idempotency_key);
      }
    });
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity>('project-workspace.archive')
    .provider(async (input) => {
      try {
        return await facade.archive(input);
      } catch (error) {
        return rejectedReceiptFor(error, input.idempotency_key);
      }
    });
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity>('project-workspace.restore')
    .provider(async (input) => {
      try {
        return await facade.restore(input);
      } catch (error) {
        return rejectedReceiptFor(error, input.idempotency_key);
      }
    });
  bridge
    .buildProvider<void, { project_id: string; seat_context_revision: number }>('project-workspace.reveal')
    .provider(async (input) => {
      try {
        await facade.reveal(input);
      } catch (error) {
        console.error('[ProjectWorkspace] reveal failed (mapped, non-blocking)', error);
      }
    });
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity>('project-workspace.recover')
    .provider(async (input) => {
      try {
        return await facade.recover(input);
      } catch (error) {
        return rejectedReceiptFor(error, input.idempotency_key);
      }
    });
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity>('project-workspace.undo')
    .provider(async (input) => {
      try {
        return await facade.undo(input);
      } catch (error) {
        return rejectedReceiptFor(error, input.idempotency_key);
      }
    });
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity & { conversation_id: string }>(
      'project-workspace.bindConversation'
    )
    .provider(async (input) => {
      try {
        return await facade.bindConversation(input);
      } catch (error) {
        return rejectedReceiptFor(error, input.idempotency_key);
      }
    });
  bridge
    .buildProvider<ProjectWorkspaceReceiptDTO, MutationIdentity & { conversation_id: string }>(
      'project-workspace.unbindConversation'
    )
    .provider(async (input) => {
      try {
        return await facade.unbindConversation(input);
      } catch (error) {
        return rejectedReceiptFor(error, input.idempotency_key);
      }
    });
  bridge
    .buildProvider<ProjectWorkspaceExplicitChatIntentResult, ProjectWorkspaceExplicitChatIntentRequest>(
      'project-workspace.chat-intent'
    )
    .provider(async (input) => {
      try {
        return await facade.chatIntent(input);
      } catch {
        // Defensive only — facade.chatIntent is already fail-open by contract.
        return { decision: 'pass_through' as const };
      }
    });

  // S81/R2 — boot-time recovery of interrupted workspace transactions.
  // ORDERING (Fable review finding): initAllBridges() calls initCommandEveBridge()
  // BEFORE this init, and initCommandEveBridge initializes the seat context
  // synchronously — so recoverAll here provably runs after seat readiness.
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
