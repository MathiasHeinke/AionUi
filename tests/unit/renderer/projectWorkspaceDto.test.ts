import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIdempotencyKey,
  createSafeProjectWorkspaceClient,
  mergeProjectWorkspaceArtifacts,
  ProjectWorkspaceClientError,
  type RawProjectWorkspaceClient,
} from '@/renderer/pages/projects/client';
import {
  parseProjectWorkspaceArtifactDTO,
  parseProjectWorkspaceListDTO,
  parseProjectWorkspacePreviewDTO,
  UnsafeProjectWorkspaceDTOError,
} from '@/renderer/pages/projects/dto';
import type { ProjectWorkspaceConversationArtifactDTO } from '@/renderer/pages/projects/types';

const project = {
  project_id: 'project-1',
  title: 'Market launch',
  realm_kind: 'business' as const,
  realm_label: 'Business',
  root_label: 'Operations',
  status: 'active' as const,
  last_safe_update: 42,
  conversation_count: 2,
  recovery_state: 'none' as const,
  revision: 3,
  allowed_actions: ['edit', 'archive', 'reveal'] as const,
};

const listResponse = {
  seat_label: 'Founder',
  seat_context_revision: 4,
  automatic_creation_enabled: false,
  placements: [
    {
      placement_id: 'placement-1',
      realm_kind: 'business',
      realm_label: 'Business',
      root_label: 'Operations',
      writable: true,
    },
  ],
  projects: [{ ...project, allowed_actions: [...project.allowed_actions] }],
};

const previewResponse = {
  preview_id: 'preview-1',
  preview_revision: 1,
  destination_label: 'Business · Operations',
  project_title: 'Market launch',
  scaffold_summary: ['Project index', '.command-eve/project.json'],
  semantic_writes: ['Company Brain project entry'],
  conversation_effect: 'No conversation is changed before confirmation.',
  warnings: [],
  expires_at: 100,
};

const receiptResponse = {
  receipt_id: 'receipt-1',
  outcome: 'completed',
  completed_at: 100,
  project: { ...project, allowed_actions: [...project.allowed_actions] },
  safe_follow_ups: ['reveal'],
};

const artifact = (updatedAt: number, state: 'preview' | 'completed'): ProjectWorkspaceConversationArtifactDTO => ({
  id: 'artifact-1',
  conversation_id: 'conversation-1',
  kind: 'project_workspace',
  status: 'active',
  created_at: 10,
  updated_at: updatedAt,
  payload: {
    artifact_id: 'artifact-1',
    state,
    intent_summary: 'Create a launch project',
    target_label: 'Business · Operations',
    project_title: 'Market launch',
    delta_summary: ['Create the project index'],
    safe_follow_ups: state === 'completed' ? ['reveal'] : [],
  },
});

const rawClient = (overrides: Partial<RawProjectWorkspaceClient> = {}): RawProjectWorkspaceClient => ({
  list: async () => listResponse,
  listConversationArtifacts: async () => [],
  subscribeConversationArtifacts: () => () => {},
  previewCreate: async () => previewResponse,
  create: async () => receiptResponse,
  previewAdopt: async () => previewResponse,
  adopt: async () => receiptResponse,
  updateMetadata: async () => receiptResponse,
  archive: async () => receiptResponse,
  restore: async () => receiptResponse,
  reveal: async () => undefined,
  recover: async () => receiptResponse,
  undo: async () => receiptResponse,
  bindConversation: async () => receiptResponse,
  unbindConversation: async () => receiptResponse,
  ...overrides,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('project workspace DTO boundary', () => {
  it('accepts exact safe list and preview DTOs including relative manifest references', () => {
    expect(parseProjectWorkspaceListDTO(listResponse).projects[0].title).toBe('Market launch');
    expect(parseProjectWorkspacePreviewDTO(previewResponse).scaffold_summary).toContain('.command-eve/project.json');
  });

  it.each([
    { ...listResponse, canonical_path: '/Users/example/project' },
    { ...listResponse, projects: [{ ...project, allowed_actions: [], title: '/home/user/project' }] },
    { ...listResponse, placements: [{ ...listResponse.placements[0], root_label: 'C:\\Users\\person\\Project' }] },
  ])('rejects unknown, sensitive, and path-valued fields', (forged) => {
    expect(() => parseProjectWorkspaceListDTO(forged)).toThrow(UnsafeProjectWorkspaceDTOError);
  });

  it('rejects a key-clean artifact whose target label contains an absolute path', () => {
    expect(() =>
      parseProjectWorkspaceArtifactDTO({
        ...artifact(20, 'completed').payload,
        target_label: '/Volumes/Company/Launch',
      })
    ).toThrow(/local path/);
  });

  it('rejects forged preview and receipt responses through the safe client adapter', async () => {
    const client = createSafeProjectWorkspaceClient(
      rawClient({
        previewCreate: async () => ({ ...previewResponse, ticket: 'forged' }),
        create: async () => ({ ...receiptResponse, journal: { phase: 'committed' } }),
      })
    );
    await expect(
      client.previewCreate({ placement_id: 'placement-1', title: 'Launch', seat_context_revision: 1 })
    ).rejects.toThrow(UnsafeProjectWorkspaceDTOError);
    await expect(
      client.create({
        preview_id: 'preview-1',
        expected_preview_revision: 1,
        seat_context_revision: 1,
        idempotency_key: '6f1cb6cb-07fe-4b9e-85f9-2b63cc94d4d3',
      })
    ).rejects.toThrow(UnsafeProjectWorkspaceDTOError);
  });

  it('rejects non-void reveal responses instead of leaking Main data', async () => {
    const client = createSafeProjectWorkspaceClient(rawClient({ reveal: async () => ({ path: '/tmp/project' }) }));
    await expect(client.reveal({ project_id: 'project-1', seat_context_revision: 1 })).rejects.toThrow(
      UnsafeProjectWorkspaceDTOError
    );
  });
});

describe('project artifact monotone merge', () => {
  it('keeps an early live completion when a delayed stale list arrives', () => {
    expect(
      mergeProjectWorkspaceArtifacts([artifact(20, 'completed')], [artifact(10, 'preview')])[0].payload.state
    ).toBe('completed');
  });

  it('ignores an out-of-order event and accepts a strictly newer event', () => {
    const current = [artifact(20, 'completed')];
    expect(mergeProjectWorkspaceArtifacts(current, [artifact(15, 'preview')])).toEqual(current);
    expect(
      mergeProjectWorkspaceArtifacts([artifact(10, 'preview')], [artifact(20, 'completed')])[0].payload.state
    ).toBe('completed');
  });

  it('rejects a newer timestamp that attempts to downgrade a terminal lifecycle state', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const current = [artifact(20, 'completed')];
    expect(mergeProjectWorkspaceArtifacts(current, [artifact(30, 'preview')])).toEqual(current);
    expect(consoleSpy).toHaveBeenCalledWith('[ProjectWorkspaceArtifacts] Lifecycle downgrade ignored');
  });

  it('keeps the existing artifact on conflicting equal timestamps', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      mergeProjectWorkspaceArtifacts([artifact(20, 'completed')], [artifact(20, 'preview')])[0].payload.state
    ).toBe('completed');
    expect(consoleSpy).toHaveBeenCalledOnce();
  });
});

describe('project operation idempotency', () => {
  it('accepts only a lowercase RFC 4122 UUIDv4 from Web Crypto', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '6f1cb6cb-07fe-4b9e-85f9-2b63cc94d4d3' });
    expect(createIdempotencyKey()).toBe('6f1cb6cb-07fe-4b9e-85f9-2b63cc94d4d3');
  });

  it.each([
    undefined,
    { randomUUID: () => 'not-a-uuid' },
    { randomUUID: () => '6F1CB6CB-07FE-4B9E-85F9-2B63CC94D4D3' },
  ])('fails closed when Web Crypto is missing or returns a malformed key', (cryptoValue) => {
    vi.stubGlobal('crypto', cryptoValue);
    expect(() => createIdempotencyKey()).toThrow(ProjectWorkspaceClientError);
  });
});
