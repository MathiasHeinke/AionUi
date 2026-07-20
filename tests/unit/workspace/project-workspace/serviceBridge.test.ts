import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    expect(dto.placements).toEqual([]);
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
});
