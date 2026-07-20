import type { ProjectWorkspaceConversationArtifactDTO } from '@/common/types/project-workspace/ui';

const mocks = vi.hoisted(() => {
  const artifactListenerRef: { current: ((payload: unknown) => void) | undefined } = { current: undefined };
  const unsubscribe = vi.fn();
  const makeProvider = () => ({ invoke: vi.fn(async (request?: unknown) => Promise.resolve(request ?? null)) });
  const projectWorkspace = {
    list: makeProvider(),
    listConversationArtifacts: makeProvider(),
    previewCreate: makeProvider(),
    create: makeProvider(),
    previewAdopt: makeProvider(),
    adopt: makeProvider(),
    updateMetadata: makeProvider(),
    archive: makeProvider(),
    restore: makeProvider(),
    reveal: makeProvider(),
    recover: makeProvider(),
    undo: makeProvider(),
    bindConversation: makeProvider(),
    unbindConversation: makeProvider(),
    artifactChanged: {
      on: vi.fn((callback: (payload: unknown) => void) => {
        artifactListenerRef.current = callback;
        return unsubscribe;
      }),
    },
  };
  return { projectWorkspace, artifactListenerRef, unsubscribe };
});

vi.mock('@/common', () => ({
  ipcBridge: { projectWorkspace: mocks.projectWorkspace },
}));

import { rawProjectWorkspaceClient } from '@renderer/pages/projects/rawClient';

describe('rawProjectWorkspaceClient (S81 R1c)', () => {
  it('maps every request/response method onto the ipcBridge provider', async () => {
    await rawProjectWorkspaceClient.list();
    expect(mocks.projectWorkspace.list.invoke).toHaveBeenCalledWith();

    const mutation = {
      project_id: '33333333-3333-4333-8333-333333333333',
      expected_revision: 1,
      seat_context_revision: 2,
      idempotency_key: '44444444-4444-4444-8444-444444444444',
    };
    const cases = [
      ['listConversationArtifacts', { conversation_id: 'conv-1' }],
      ['previewCreate', { placement_id: 'realm:root', title: 'Atlas', seat_context_revision: 2 }],
      ['create', { preview_id: 'p', expected_preview_revision: 1, seat_context_revision: 2, idempotency_key: 'k' }],
      ['previewAdopt', { title: 'Atlas', seat_context_revision: 2 }],
      ['adopt', { preview_id: 'p', expected_preview_revision: 1, seat_context_revision: 2, idempotency_key: 'k' }],
      ['updateMetadata', { ...mutation, title: 'Neu' }],
      ['archive', mutation],
      ['restore', mutation],
      ['reveal', { project_id: mutation.project_id, seat_context_revision: 2 }],
      ['recover', mutation],
      ['undo', mutation],
      ['bindConversation', { ...mutation, conversation_id: 'conv-1' }],
      ['unbindConversation', { ...mutation, conversation_id: 'conv-1' }],
    ] as const;
    for (const [method, request] of cases) {
      await (rawProjectWorkspaceClient[method] as (req: unknown) => Promise<unknown>)(request);
      expect(mocks.projectWorkspace[method].invoke).toHaveBeenCalledWith(request);
    }
  });

  it('filters artifact pushes by conversation_id and unsubscribes', () => {
    const seen: string[] = [];
    const artifact = { id: 'artifact-1' } as ProjectWorkspaceConversationArtifactDTO;
    const unsubscribe = rawProjectWorkspaceClient.subscribeConversationArtifacts(
      { conversation_id: 'conv-a' },
      (candidate) => seen.push(candidate.id)
    );

    const listener = mocks.artifactListenerRef.current;
    expect(listener).toBeDefined();
    listener?.({ conversation_id: 'conv-b', artifact });
    expect(seen).toEqual([]);
    listener?.({ conversation_id: 'conv-a', artifact });
    expect(seen).toEqual(['artifact-1']);

    unsubscribe();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
