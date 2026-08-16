import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import {
  parseProjectWorkspaceAssignmentPreviewResult,
  parseProjectWorkspaceAssignmentReceiptDTO,
  parseProjectWorkspaceConversationArtifactDTO,
  parseProjectWorkspaceListDTO,
  parseProjectWorkspacePreviewDTO,
  parseProjectWorkspaceReceiptDTO,
  parseProjectWorkspaceVoidResponse,
} from './dto';
import type {
  ProjectSummaryDTO,
  ProjectWorkspaceAction,
  ProjectWorkspaceAssignmentCommitRequest,
  ProjectWorkspaceAssignmentPreviewRequest,
  ProjectWorkspaceAssignmentPreviewResult,
  ProjectWorkspaceAssignmentReceiptDTO,
  ProjectWorkspaceConversationArtifactDTO,
  ProjectWorkspaceListDTO,
  ProjectWorkspacePreviewDTO,
  ProjectWorkspaceReasonCode,
  ProjectWorkspaceReceiptDTO,
} from './types';

export class ProjectWorkspaceClientError extends Error {
  constructor(readonly reason_code: ProjectWorkspaceReasonCode) {
    super(reason_code);
    this.name = 'ProjectWorkspaceClientError';
  }
}

type MutationIdentity = {
  project_id: string;
  expected_revision: number;
  seat_context_revision: number;
  idempotency_key: string;
};

export type ProjectWorkspaceClient = {
  list: () => Promise<ProjectWorkspaceListDTO>;
  listConversationArtifacts: (request: {
    conversation_id: string;
  }) => Promise<ProjectWorkspaceConversationArtifactDTO[]>;
  subscribeConversationArtifacts: (
    request: { conversation_id: string },
    listener: (artifact: ProjectWorkspaceConversationArtifactDTO) => void
  ) => () => void;
  previewCreate: (request: {
    placement_id: string;
    title: string;
    profile?: string;
    seat_context_revision: number;
  }) => Promise<ProjectWorkspacePreviewDTO>;
  create: (request: {
    preview_id: string;
    expected_preview_revision: number;
    seat_context_revision: number;
    idempotency_key: string;
  }) => Promise<ProjectWorkspaceReceiptDTO>;
  previewAdopt: (request: {
    title?: string;
    seat_context_revision: number;
  }) => Promise<ProjectWorkspacePreviewDTO | null>;
  adopt: (request: {
    preview_id: string;
    expected_preview_revision: number;
    seat_context_revision: number;
    idempotency_key: string;
  }) => Promise<ProjectWorkspaceReceiptDTO>;
  updateMetadata: (request: MutationIdentity & { title: string }) => Promise<ProjectWorkspaceReceiptDTO>;
  archive: (request: MutationIdentity) => Promise<ProjectWorkspaceReceiptDTO>;
  restore: (request: MutationIdentity) => Promise<ProjectWorkspaceReceiptDTO>;
  reveal: (request: Pick<MutationIdentity, 'project_id' | 'seat_context_revision'>) => Promise<void>;
  recover: (request: MutationIdentity) => Promise<ProjectWorkspaceReceiptDTO>;
  undo: (request: MutationIdentity) => Promise<ProjectWorkspaceReceiptDTO>;
  bindConversation: (request: MutationIdentity & { conversation_id: string }) => Promise<ProjectWorkspaceReceiptDTO>;
  unbindConversation: (request: MutationIdentity & { conversation_id: string }) => Promise<ProjectWorkspaceReceiptDTO>;
  previewAssignment: (
    request: ProjectWorkspaceAssignmentPreviewRequest
  ) => Promise<ProjectWorkspaceAssignmentPreviewResult>;
  commitAssignment: (request: ProjectWorkspaceAssignmentCommitRequest) => Promise<ProjectWorkspaceAssignmentReceiptDTO>;
};

export type RawProjectWorkspaceClient = {
  [Method in keyof ProjectWorkspaceClient]: ProjectWorkspaceClient[Method] extends (...args: infer Args) => unknown
    ? (...args: Args) => Method extends 'subscribeConversationArtifacts' ? () => void : Promise<unknown>
    : never;
};

const unavailable = (): never => {
  throw new ProjectWorkspaceClientError('service_unavailable');
};

export const unavailableProjectWorkspaceClient: ProjectWorkspaceClient = {
  list: async () => unavailable(),
  listConversationArtifacts: async () => [],
  subscribeConversationArtifacts: () => () => {},
  previewCreate: async () => unavailable(),
  create: async () => unavailable(),
  previewAdopt: async () => unavailable(),
  adopt: async () => unavailable(),
  updateMetadata: async () => unavailable(),
  archive: async () => unavailable(),
  restore: async () => unavailable(),
  reveal: async () => unavailable(),
  recover: async () => unavailable(),
  undo: async () => unavailable(),
  bindConversation: async () => unavailable(),
  unbindConversation: async () => unavailable(),
  previewAssignment: async () => unavailable(),
  commitAssignment: async () => unavailable(),
};

const ProjectWorkspaceClientContext = createContext<ProjectWorkspaceClient>(unavailableProjectWorkspaceClient);

export const createSafeProjectWorkspaceClient = (raw: RawProjectWorkspaceClient): ProjectWorkspaceClient => ({
  list: async () => parseProjectWorkspaceListDTO(await raw.list()),
  listConversationArtifacts: async (request) => {
    const response = await raw.listConversationArtifacts(request);
    if (!Array.isArray(response)) throw new ProjectWorkspaceClientError('invariant_failure');
    return response.map(parseProjectWorkspaceConversationArtifactDTO);
  },
  subscribeConversationArtifacts: (request, listener) =>
    raw.subscribeConversationArtifacts(request, (candidate) => {
      try {
        listener(parseProjectWorkspaceConversationArtifactDTO(candidate));
      } catch {
        console.error('[ProjectWorkspaceArtifacts] Unsafe subscribed artifact rejected');
      }
    }),
  previewCreate: async (request) => parseProjectWorkspacePreviewDTO(await raw.previewCreate(request)),
  create: async (request) => parseProjectWorkspaceReceiptDTO(await raw.create(request)),
  previewAdopt: async (request) => {
    const response = await raw.previewAdopt(request);
    return response === null ? null : parseProjectWorkspacePreviewDTO(response);
  },
  adopt: async (request) => parseProjectWorkspaceReceiptDTO(await raw.adopt(request)),
  updateMetadata: async (request) => parseProjectWorkspaceReceiptDTO(await raw.updateMetadata(request)),
  archive: async (request) => parseProjectWorkspaceReceiptDTO(await raw.archive(request)),
  restore: async (request) => parseProjectWorkspaceReceiptDTO(await raw.restore(request)),
  reveal: async (request) => parseProjectWorkspaceVoidResponse(await raw.reveal(request)),
  recover: async (request) => parseProjectWorkspaceReceiptDTO(await raw.recover(request)),
  undo: async (request) => parseProjectWorkspaceReceiptDTO(await raw.undo(request)),
  bindConversation: async (request) => parseProjectWorkspaceReceiptDTO(await raw.bindConversation(request)),
  unbindConversation: async (request) => parseProjectWorkspaceReceiptDTO(await raw.unbindConversation(request)),
  previewAssignment: async (request) =>
    parseProjectWorkspaceAssignmentPreviewResult(await raw.previewAssignment(request)),
  commitAssignment: async (request) => parseProjectWorkspaceAssignmentReceiptDTO(await raw.commitAssignment(request)),
});

export const ProjectWorkspaceClientProvider: React.FC<
  React.PropsWithChildren<{ client: RawProjectWorkspaceClient }>
> = ({ client, children }) => {
  const safeClient = useMemo(() => createSafeProjectWorkspaceClient(client), [client]);
  return <ProjectWorkspaceClientContext.Provider value={safeClient}>{children}</ProjectWorkspaceClientContext.Provider>;
};
export const useProjectWorkspaceClient = (): ProjectWorkspaceClient => useContext(ProjectWorkspaceClientContext);

const ARTIFACT_TRANSITIONS: Record<
  ProjectWorkspaceConversationArtifactDTO['payload']['state'],
  ReadonlySet<ProjectWorkspaceConversationArtifactDTO['payload']['state']>
> = {
  preview: new Set(['preview', 'awaiting_confirmation', 'committing', 'completed', 'rejected', 'recovery_required']),
  awaiting_confirmation: new Set(['awaiting_confirmation', 'committing', 'completed', 'rejected', 'recovery_required']),
  committing: new Set(['committing', 'completed', 'rejected', 'recovery_required']),
  completed: new Set(['completed']),
  rejected: new Set(['rejected']),
  recovery_required: new Set(['recovery_required', 'completed', 'rejected']),
};

export const mergeProjectWorkspaceArtifacts = (
  current: ProjectWorkspaceConversationArtifactDTO[],
  incoming: ProjectWorkspaceConversationArtifactDTO[]
): ProjectWorkspaceConversationArtifactDTO[] => {
  const merged = new Map(current.map((artifact) => [artifact.id, artifact]));
  for (const candidate of incoming) {
    const existing = merged.get(candidate.id);
    if (!existing) {
      merged.set(candidate.id, candidate);
      continue;
    }
    if (candidate.updated_at < existing.updated_at) continue;
    if (candidate.updated_at === existing.updated_at) {
      if (JSON.stringify(candidate) !== JSON.stringify(existing)) {
        console.error('[ProjectWorkspaceArtifacts] Conflicting equal-revision artifact ignored');
      }
      continue;
    }
    if (candidate.created_at !== existing.created_at) {
      console.error('[ProjectWorkspaceArtifacts] Changed artifact origin ignored');
      continue;
    }
    if (!ARTIFACT_TRANSITIONS[existing.payload.state].has(candidate.payload.state)) {
      console.error('[ProjectWorkspaceArtifacts] Lifecycle downgrade ignored');
      continue;
    }
    merged.set(candidate.id, candidate);
  }
  return Array.from(merged.values()).toSorted((left, right) => left.created_at - right.created_at);
};

export const useProjectWorkspaceConversationArtifacts = (
  conversationId?: string
): ProjectWorkspaceConversationArtifactDTO[] => {
  const client = useProjectWorkspaceClient();
  const [state, setState] = useState<{
    conversationId?: string;
    artifacts: ProjectWorkspaceConversationArtifactDTO[];
  }>({ artifacts: [] });

  useEffect(() => {
    let active = true;
    setState({ conversationId, artifacts: [] });
    if (!conversationId) return () => undefined;

    const upsert = (candidate: ProjectWorkspaceConversationArtifactDTO) => {
      if (!active || candidate.conversation_id !== conversationId) return;
      try {
        const artifact = parseProjectWorkspaceConversationArtifactDTO(candidate);
        setState((current) => ({
          conversationId,
          artifacts: mergeProjectWorkspaceArtifacts(
            current.conversationId === conversationId ? current.artifacts : [],
            [artifact]
          ),
        }));
      } catch {
        console.error('[ProjectWorkspaceArtifacts] Unsafe live artifact rejected');
      }
    };

    let unsubscribe: () => void = (): void => undefined;
    try {
      unsubscribe = client.subscribeConversationArtifacts({ conversation_id: conversationId }, upsert);
    } catch {
      console.error('[ProjectWorkspaceArtifacts] Artifact subscription unavailable');
    }
    void client
      .listConversationArtifacts({ conversation_id: conversationId })
      .then((items) => {
        if (!active) return;
        const safeItems = items
          .map(parseProjectWorkspaceConversationArtifactDTO)
          .filter((item) => item.conversation_id === conversationId);
        setState((current) => ({
          conversationId,
          artifacts: mergeProjectWorkspaceArtifacts(
            current.conversationId === conversationId ? current.artifacts : [],
            safeItems
          ),
        }));
      })
      .catch(() => {
        if (active) console.error('[ProjectWorkspaceArtifacts] Artifact list unavailable');
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, conversationId]);

  return state.conversationId === conversationId ? state.artifacts : [];
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const assertProjectIdempotencyKey = (value: string): string => {
  if (!UUID_V4.test(value)) throw new ProjectWorkspaceClientError('invariant_failure');
  return value;
};

export const createIdempotencyKey = (): string => {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new ProjectWorkspaceClientError('invariant_failure');
  }
  return assertProjectIdempotencyKey(crypto.randomUUID());
};

export type ProjectActionRequest = {
  project: ProjectSummaryDTO;
  action: ProjectWorkspaceAction;
};
