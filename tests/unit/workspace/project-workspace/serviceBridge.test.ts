import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import type { ProjectWorkspaceListDTO } from '@/common/types/project-workspace/ui';

const mocks = vi.hoisted(() => {
  const providers: { key: string; provider: unknown }[] = [];
  const emitters: { key: string; emit: ReturnType<typeof vi.fn> }[] = [];
  return {
    providers,
    emitters,
    getDataPath: vi.fn((): string => {
      throw new Error('getDataPath not initialized');
    }),
  };
});

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (key: string) => ({
      provider: (fn: unknown) => {
        mocks.providers.push({ key, provider: fn });
      },
      invoke: vi.fn(),
    }),
    buildEmitter: (key: string) => {
      const record = { key, emit: vi.fn() };
      mocks.emitters.push(record);
      return { on: vi.fn(() => () => {}), emit: record.emit };
    },
  },
}));

vi.mock('@process/utils/utils', () => ({
  getDataPath: () => mocks.getDataPath(),
}));

vi.mock('@process/bridge/commandEveBridge', () => ({
  isCommandEveSeatSwitchInFlight: () => false,
}));

const EXPECTED_PROVIDER_CHANNELS = [
  'project-workspace.list',
  'project-workspace.listConversationArtifacts',
  'project-workspace.previewCreate',
  'project-workspace.create',
  'project-workspace.previewAdopt',
  'project-workspace.adopt',
  'project-workspace.updateMetadata',
  'project-workspace.archive',
  'project-workspace.restore',
  'project-workspace.reveal',
  'project-workspace.recover',
  'project-workspace.undo',
  'project-workspace.bindConversation',
  'project-workspace.unbindConversation',
  'project-workspace.chat-intent',
] as const;

describe('initProjectWorkspaceServiceBridge (S81 R1c)', () => {
  let dataRoot: string;

  beforeEach(async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-service-bridge-'));
    mocks.getDataPath.mockImplementation(() => dataRoot);
    (globalThis as { __backendPort?: number }).__backendPort = 4173;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: { items: [], has_more: false } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        )
      )
    );
    const { ProjectWorkspaceRegistryStore } = await import('@process/services/project-workspace/storage/registryStore');
    new ProjectWorkspaceRegistryStore({ state_root: path.join(dataRoot, 'project-workspace') }).initializeSeat(
      'seat-1'
    );
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.resetModules();
    mocks.providers.length = 0;
    mocks.emitters.length = 0;
  });

  it('registers all 15 providers under the exact channel names plus the artifact emitter', async () => {
    const { initProjectWorkspaceServiceBridge } = await import('@process/bridge/projectWorkspaceServiceBridge');
    initProjectWorkspaceServiceBridge();

    expect(mocks.providers.map((entry) => entry.key)).toEqual([...EXPECTED_PROVIDER_CHANNELS]);
    expect(mocks.emitters.map((entry) => entry.key)).toEqual(['project-workspace.artifact-changed']);
  });

  it('routes the list provider through to the facade', async () => {
    const { initProjectWorkspaceServiceBridge } = await import('@process/bridge/projectWorkspaceServiceBridge');
    initProjectWorkspaceServiceBridge();

    const listProvider = mocks.providers.find((entry) => entry.key === 'project-workspace.list');
    if (!listProvider) throw new Error('project-workspace.list provider not registered');
    const dto = await (listProvider.provider as () => Promise<ProjectWorkspaceListDTO>)();

    expect(dto.seat_context_revision).toBe(0);
    expect(dto.seat_label).toBe('Founder');
    expect(dto.automatic_creation_enabled).toBe(false);
    // The bridge init bootstraps the seat: default realms/roots are seeded
    // (Privat/Geschäftlich), so placements are offerable on first list.
    expect(dto.placements).toEqual([
      expect.objectContaining({ realm_kind: 'private', realm_label: 'Privat', writable: true }),
      expect.objectContaining({ realm_kind: 'business', realm_label: 'Geschäftlich', writable: true }),
    ]);
    expect(dto.projects).toEqual([]);
  });

  it('runs boot recovery exactly once per init (S81 R2)', async () => {
    const { ProjectWorkspaceService } = await import('@process/services/project-workspace/ProjectWorkspaceService');
    const recoverAll = vi.spyOn(ProjectWorkspaceService.prototype, 'recoverAll');
    const { initProjectWorkspaceServiceBridge } = await import('@process/bridge/projectWorkspaceServiceBridge');

    initProjectWorkspaceServiceBridge();

    expect(recoverAll).toHaveBeenCalledTimes(1);
    recoverAll.mockRestore();
  });

  it('ignores a repeated init: no duplicate providers, emitter, or boot recovery (Fable #6 / Grok #13)', async () => {
    const { ProjectWorkspaceService } = await import('@process/services/project-workspace/ProjectWorkspaceService');
    const recoverAll = vi.spyOn(ProjectWorkspaceService.prototype, 'recoverAll');
    const { initProjectWorkspaceServiceBridge } = await import('@process/bridge/projectWorkspaceServiceBridge');

    initProjectWorkspaceServiceBridge();
    initProjectWorkspaceServiceBridge();

    expect(mocks.providers.map((entry) => entry.key)).toEqual([...EXPECTED_PROVIDER_CHANNELS]);
    expect(mocks.emitters.map((entry) => entry.key)).toEqual(['project-workspace.artifact-changed']);
    expect(recoverAll).toHaveBeenCalledTimes(1);
    recoverAll.mockRestore();
  });

  it('swallows a boot recovery failure without blocking init (S81 R2)', async () => {
    const { ProjectWorkspaceService } = await import('@process/services/project-workspace/ProjectWorkspaceService');
    const recoverAll = vi
      .spyOn(ProjectWorkspaceService.prototype, 'recoverAll')
      .mockRejectedValue(new Error('recovery boom'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { initProjectWorkspaceServiceBridge } = await import('@process/bridge/projectWorkspaceServiceBridge');

    expect(() => initProjectWorkspaceServiceBridge()).not.toThrow();
    expect(recoverAll).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        '[ProjectWorkspace] boot recovery failed (non-blocking)',
        expect.any(Error)
      );
    });
    recoverAll.mockRestore();
    consoleError.mockRestore();
  });

  describe('IPC error mapping (Kimi F1): providers never throw across the boundary', () => {
    async function initWithThrowingFacade(method: string): Promise<void> {
      const { ProjectWorkspaceFacade } = await import('@process/services/project-workspace/ProjectWorkspaceFacade');
      // NOTE: afterEach runs vi.resetModules(), so the class used here must be
      // imported dynamically from the SAME fresh registry the bridge gets —
      // the static top-level import would be a different class instance and
      // instanceof in the bridge's toReasonCode would fail.
      const { ProjectWorkspaceError: FreshError } = await import('@/common/types/project-workspace/reasonCodes');
      vi.spyOn(ProjectWorkspaceFacade.prototype, method as never).mockImplementation(() => {
        throw new FreshError('seat.changed');
      });
      const { initProjectWorkspaceServiceBridge } = await import('@process/bridge/projectWorkspaceServiceBridge');
      initProjectWorkspaceServiceBridge();
    }

    function providerFor(key: string): (input?: unknown) => Promise<unknown> {
      const record = mocks.providers.find((entry) => entry.key === key);
      if (!record) throw new Error(`${key} provider not registered`);
      return record.provider as (input?: unknown) => Promise<unknown>;
    }

    it('maps a thrown ProjectWorkspaceError to a rejected receipt with reason code (mutations)', async () => {
      await initWithThrowingFacade('updateMetadata');
      const receipt = (await providerFor('project-workspace.updateMetadata')({
        project_id: 'p1',
        expected_revision: 0,
        seat_context_revision: 0,
        idempotency_key: '11111111-1111-4111-8111-111111111111',
        title: 'x',
      })) as { outcome: string; reason_code?: string; receipt_id: string };
      expect(receipt.outcome).toBe('rejected');
      expect(receipt.reason_code).toBe('seat_changed');
      expect(receipt.receipt_id).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('maps a thrown error in list to a notice DTO instead of hanging', async () => {
      await initWithThrowingFacade('list');
      const dto = (await providerFor('project-workspace.list')()) as ProjectWorkspaceListDTO;
      expect(dto.notice_reason).toBe('seat_changed');
      expect(dto.placements).toEqual([]);
      expect(dto.projects).toEqual([]);
    });

    it('maps a thrown error in previewCreate to an expired warning stub', async () => {
      await initWithThrowingFacade('previewCreate');
      const preview = (await providerFor('project-workspace.previewCreate')({
        placement_id: 'p',
        title: 'T',
        seat_context_revision: 0,
      })) as { warnings: string[]; expires_at: number; preview_revision: number };
      expect(preview.warnings).toEqual(['seat_changed']);
      expect(preview.preview_revision).toBe(0);
      expect(preview.expires_at).toBeLessThanOrEqual(Date.now());
    });

    it('maps a thrown error in reveal to a logged void resolution', async () => {
      await initWithThrowingFacade('reveal');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(
        providerFor('project-workspace.reveal')({ project_id: 'p1', seat_context_revision: 0 })
      ).resolves.toBeUndefined();
      consoleError.mockRestore();
    });

    it('maps a thrown error in chatIntent to pass_through', async () => {
      await initWithThrowingFacade('chatIntent');
      const result = (await providerFor('project-workspace.chat-intent')({
        conversation_id: 'c1',
        input: 'hello',
        seat_context_revision: 0,
        idempotency_key: '11111111-1111-4111-8111-111111111111',
      })) as { decision: string };
      expect(result.decision).toBe('pass_through');
    });

    it('maps a thrown error in listConversationArtifacts to an empty list', async () => {
      await initWithThrowingFacade('listConversationArtifacts');
      const artifacts = (await providerFor('project-workspace.listConversationArtifacts')({
        conversation_id: 'c1',
      })) as unknown[];
      expect(artifacts).toEqual([]);
    });
  });
});
