import { bridge } from '@office-ai/platform';
import path from 'node:path';
import type { ISendMessageResult } from '@/common/adapter/ipcBridge';
import type { CommandEveAttachmentGroundingRequest } from '@/common/config/eveAttachmentGroundingCore';
import { getActiveSeatId } from '@process/commandEve/seatContextCore';
import { isCommandEveSeatSwitchInFlight } from '@process/bridge/commandEveBridge';
import {
  PROJECT_RUNTIME_ATTESTATION_HEADER,
  createProjectRuntimeJti,
  deriveBackendGeneration,
  issueProjectRuntimeAttestation,
  type ProjectRuntimeAttestationClaimsV1,
  type ProjectRuntimePurpose,
} from '@process/security/projectRuntimeAttestationCore';
import { getMainProcessLocalBackendCapability } from '@process/security/localBackendCapabilityCore';
import { ProjectWorkspaceRegistryStore } from '@process/services/project-workspace/storage/registryStore';
import {
  assertRuntimeSnapshotStillCurrent,
  pathlessProjectRuntimeResolutionError,
  ProjectRuntimeResolutionError,
  resolveTrustedProjectRuntimeSnapshot,
  type ProjectRuntimeResolverDependencies,
} from '@process/services/project-workspace/runtime/projectRuntimeResolver';
import { createAionCoreProjectBindingClient } from '@process/services/project-workspace/runtime/conversationBindingClient';
import { getDataPath } from '@process/utils/utils';

type RuntimeSendParams = {
  input: string;
  conversation_id: string;
  files?: string[];
  attachment_grounding?: CommandEveAttachmentGroundingRequest;
  loading_id?: string;
  inject_skills?: string[];
};

type RuntimeWarmupParams = { conversation_id: string };

type ProjectRuntimeBridgeDependencies = ProjectRuntimeResolverDependencies & {
  fetch_impl: typeof globalThis.fetch;
  now_seconds: () => number;
  create_jti: () => string;
};

let registry: ProjectWorkspaceRegistryStore | undefined;

function backendPort(): number {
  const value = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  return typeof value === 'number' ? value : 0;
}

function mainDependencies(): ProjectRuntimeBridgeDependencies {
  registry ??= new ProjectWorkspaceRegistryStore({
    state_root: path.join(getDataPath(), 'project-workspace'),
  });
  const getPort = () => backendPort();
  return {
    registry,
    binding_client: createAionCoreProjectBindingClient({ get_port: getPort }),
    get_active_seat_id: getActiveSeatId,
    is_seat_switch_in_flight: isCommandEveSeatSwitchInFlight,
    get_backend_port: getPort,
    get_backend_capability: getMainProcessLocalBackendCapability,
    fetch_impl: globalThis.fetch.bind(globalThis),
    now_seconds: () => Math.floor(Date.now() / 1000),
    create_jti: createProjectRuntimeJti,
  };
}

async function responseData<T>(response: Response): Promise<T> {
  const raw = await response.text();
  let body: unknown;
  try {
    body = raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_RESPONSE_INVALID');
  }
  if (!response.ok) {
    const code =
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      typeof (body as Record<string, unknown>).code === 'string'
        ? ((body as Record<string, unknown>).code as string)
        : 'PROJECT_RUNTIME_REQUEST_FAILED';
    throw new ProjectRuntimeResolutionError(code);
  }
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'data')) {
    return (body as { data: T }).data;
  }
  return body as T;
}

export async function postAttestedProjectRuntimeRequest<T>(
  input: {
    purpose: ProjectRuntimePurpose;
    conversation_id: string;
    body: Record<string, unknown>;
  },
  deps: ProjectRuntimeBridgeDependencies = mainDependencies()
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const snapshot = await resolveTrustedProjectRuntimeSnapshot(input.conversation_id, deps);
      const capability = deps.get_backend_capability();
      if (deriveBackendGeneration(capability) !== snapshot.backend_generation) {
        throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_SNAPSHOT_CHANGED');
      }
      const iat = deps.now_seconds();
      const claims: ProjectRuntimeAttestationClaimsV1 = {
        v: 1,
        iss: 'aionui-main',
        aud: 'aioncore-project-runtime',
        sub: input.conversation_id,
        purpose: input.purpose,
        backend_generation: snapshot.backend_generation,
        seat_id: snapshot.seat_id,
        realm_id: snapshot.realm_id,
        root_id: snapshot.root_id,
        project_id: snapshot.project_id,
        workspace_root_ref: snapshot.workspace_root_ref,
        project_binding_revision: snapshot.project_binding_revision,
        project_binding_receipt_id: snapshot.project_binding_receipt_id,
        canonical_path_sha256: snapshot.canonical_path_sha256,
        root_catalog_revision: snapshot.root_catalog_revision,
        root_ownership_revision: snapshot.root_ownership_revision,
        project_catalog_revision: snapshot.project_catalog_revision,
        root_record_sha256: snapshot.root_record_sha256,
        project_record_sha256: snapshot.project_record_sha256,
        environment_hint: snapshot.environment_hint,
        iat,
        nbf: iat - 1,
        exp: iat + 10,
        jti: deps.create_jti(),
      };
      const ticket = issueProjectRuntimeAttestation({ capability, claims });
      await assertRuntimeSnapshotStillCurrent(snapshot, deps);
      const route =
        input.purpose === 'send'
          ? `/api/conversations/${encodeURIComponent(input.conversation_id)}/messages`
          : `/api/conversations/${encodeURIComponent(input.conversation_id)}/warmup`;
      const response = await deps.fetch_impl(`http://127.0.0.1:${snapshot.backend_port}${route}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          [PROJECT_RUNTIME_ATTESTATION_HEADER]: ticket,
        },
        body: JSON.stringify({
          ...input.body,
          runtime_workspace: {
            project_id: snapshot.project_id,
            workspace_root_ref: snapshot.workspace_root_ref,
            project_binding_revision: snapshot.project_binding_revision,
            project_binding_receipt_id: snapshot.project_binding_receipt_id,
            path: snapshot.project_path,
          },
        }),
      });
      return await responseData<T>(response);
    } catch (error) {
      const pathlessError = pathlessProjectRuntimeResolutionError(error);
      if (attempt === 0 && pathlessError.code === 'PROJECT_RUNTIME_SNAPSHOT_CHANGED') {
        continue;
      }
      throw pathlessError;
    }
  }
  throw new ProjectRuntimeResolutionError('PROJECT_RUNTIME_SNAPSHOT_CHANGED');
}

export function initProjectWorkspaceBridge(): void {
  bridge
    .buildProvider<ISendMessageResult, RuntimeSendParams>('project-workspace.runtime-send')
    .provider(async (input) =>
      postAttestedProjectRuntimeRequest<ISendMessageResult>({
        purpose: 'send',
        conversation_id: input.conversation_id,
        body: {
          content: input.input,
          files: input.files,
          attachment_grounding: input.attachment_grounding,
          loading_id: input.loading_id,
          inject_skills: input.inject_skills,
        },
      })
    );
  bridge.buildProvider<void, RuntimeWarmupParams>('project-workspace.runtime-warmup').provider(async (input) =>
    postAttestedProjectRuntimeRequest<void>({
      purpose: 'warmup',
      conversation_id: input.conversation_id,
      body: {},
    })
  );
}
