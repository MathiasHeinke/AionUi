import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendHttpError } from '@/common/adapter/httpBridge';
import {
  COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID,
  getCommandEveLocalRuntimeProvider,
} from '@/common/config/commandEveShell';
import { migrateProviders } from '@/common/config/configMigration';
import { IMAGE_GEN_ENV_KEYS } from '@/common/config/imageGenerationMcpEnv';
import { BUILTIN_IMAGE_GEN_NAME, type IMcpServer, type IProvider } from '@/common/config/storage';
import {
  ensureCommandEveLocalRuntimeProvider,
  resolveImageGenerationMigrationConfig,
  runBackendMigrations,
} from '@/process/utils/runBackendMigrations';

const {
  batchImportServersMock,
  configFileGetMock,
  configFileSetMock,
  createProviderMock,
  httpRequestMock,
  listServersMock,
  testMcpConnectionMock,
  updateProviderMock,
  updateServerMock,
} = vi.hoisted(() => ({
  batchImportServersMock: vi.fn(),
  configFileGetMock: vi.fn(),
  configFileSetMock: vi.fn(),
  createProviderMock: vi.fn(),
  httpRequestMock: vi.fn(),
  listServersMock: vi.fn(),
  testMcpConnectionMock: vi.fn(),
  updateProviderMock: vi.fn(),
  updateServerMock: vi.fn(),
}));

vi.mock('@/common/adapter/httpBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common/adapter/httpBridge')>();
  return {
    ...actual,
    httpRequest: httpRequestMock,
  };
});

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: {
    listServers: { invoke: listServersMock },
    batchImportServers: { invoke: batchImportServersMock },
    updateServer: { invoke: updateServerMock },
    testMcpConnection: { invoke: testMcpConnectionMock },
  },
  mode: {
    createProvider: { invoke: createProviderMock },
    updateProvider: { invoke: updateProviderMock },
  },
}));

vi.mock('@/common/config/configMigration', () => ({
  migrateConfigStorage: vi.fn().mockResolvedValue(undefined),
  migrateLegacyMcpConfigToDb: vi.fn().mockResolvedValue(undefined),
  migrateProviders: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/process/utils/initStorage', () => ({
  getBuiltinMcpScriptPath: (name: string) => `/mock/${name}.js`,
}));

vi.mock('@/process/utils/migrateAssistants', () => ({
  migrateAssistantsToBackend: vi.fn().mockResolvedValue(true),
}));

const provider: IProvider = {
  id: 'provider-1',
  platform: 'gemini',
  name: 'Gemini',
  base_url: 'https://generativelanguage.googleapis.com',
  api_key: 'provider-key',
  models: ['gemini-image'],
  enabled: true,
};

const imageEnv = {
  [IMAGE_GEN_ENV_KEYS.providerId]: 'provider-1',
  [IMAGE_GEN_ENV_KEYS.platform]: 'gemini',
  [IMAGE_GEN_ENV_KEYS.baseUrl]: 'https://generativelanguage.googleapis.com',
  [IMAGE_GEN_ENV_KEYS.apiKey]: 'provider-key',
  [IMAGE_GEN_ENV_KEYS.model]: 'gemini-image',
};

const imageServer = (): IMcpServer => ({
  id: 'image-server-id',
  name: BUILTIN_IMAGE_GEN_NAME,
  description: 'Built-in image generation tool powered by AI models. Configure the model in Settings > Tools.',
  enabled: true,
  builtin: true,
  transport: {
    type: 'stdio',
    command: 'node',
    args: ['/mock/builtin-mcp-image-gen.js'],
    env: imageEnv,
  },
  created_at: 1,
  updated_at: 1,
  original_json: JSON.stringify(
    {
      mcpServers: {
        [BUILTIN_IMAGE_GEN_NAME]: {
          command: 'node',
          args: ['/mock/builtin-mcp-image-gen.js'],
          env: imageEnv,
        },
      },
    },
    null,
    2
  ),
});

const configFile = {
  get: configFileGetMock,
  set: configFileSetMock,
};

/**
 * Same backend shape as the default beforeEach mock, but with a caller-chosen
 * /api/providers listing — used by the local-runtime seed specs.
 */
const mockBackendWithProviders = (providers: IProvider[]) => {
  httpRequestMock.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path === '/api/settings/client') {
      return {
        'tools.imageGenerationModel': {
          id: 'provider-1',
          name: 'Gemini',
          platform: 'gemini',
          use_model: 'gemini-image',
        },
      };
    }
    if (method === 'GET' && path === '/api/providers') {
      return providers;
    }
    return undefined;
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  configFileGetMock.mockResolvedValue(undefined);
  configFileSetMock.mockResolvedValue(undefined);
  createProviderMock.mockResolvedValue({ id: COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID });
  updateProviderMock.mockResolvedValue(undefined);
  listServersMock.mockResolvedValue([]);
  batchImportServersMock.mockResolvedValue([]);
  updateServerMock.mockImplementation(async ({ id, data }) => ({
    ...imageServer(),
    id,
    ...data,
  }));
  testMcpConnectionMock.mockResolvedValue({ success: false, error: 'Command not found: npx' });
  httpRequestMock.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET' && path === '/api/settings/client') {
      return {
        'tools.imageGenerationModel': {
          id: 'provider-1',
          name: 'Gemini',
          platform: 'gemini',
          use_model: 'gemini-image',
        },
      };
    }
    if (method === 'GET' && path === '/api/providers') {
      return [provider];
    }
    return undefined;
  });
});

describe('resolveImageGenerationMigrationConfig', () => {
  it('uses backend client preference when local config file no longer has the image model', () => {
    const backendConfig = {
      id: 'gemini',
      name: 'Gemini',
      platform: 'gemini',
      base_url: 'https://example.test',
      api_key: 'backend-key',
      use_model: 'gemini-image',
    };

    expect(resolveImageGenerationMigrationConfig({ 'tools.imageGenerationModel': backendConfig }, undefined)).toEqual(
      backendConfig
    );
  });
});

describe('runBackendMigrations', () => {
  it('does not sync the built-in image MCP server when bootstrap makes no effective change', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    listServersMock.mockResolvedValue([imageServer()]);

    await runBackendMigrations(configFile as never);

    expect(updateServerMock).not.toHaveBeenCalled();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      'image-server-id',
      'no',
      'no',
      'no'
    );
  });

  it('does not sync agents when only the stored image MCP JSON representation differs', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    listServersMock.mockResolvedValue([
      {
        ...imageServer(),
        original_json: '{"legacy":true}',
      },
    ]);

    await runBackendMigrations(configFile as never);

    expect(updateServerMock).toHaveBeenCalledOnce();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, will update: %s',
      'image-server-id',
      'no',
      'yes',
      'yes'
    );
  });
});

describe('ensureCommandEveLocalRuntimeProvider', () => {
  /** The seeded provider as a persisted backend row (use_model → models). */
  const localRuntimeRow = (): IProvider => {
    const { use_model, ...rest } = getCommandEveLocalRuntimeProvider();
    return { ...rest, models: [use_model], enabled: true };
  };

  const providerPutCalls = () =>
    httpRequestMock.mock.calls.filter(
      ([method, path]) => method === 'PUT' && String(path).startsWith('/api/providers')
    );

  it('seeds the provider on a fresh install with the exact default-tier shape', async () => {
    await runBackendMigrations(configFile as never);

    expect(createProviderMock).toHaveBeenCalledTimes(1);
    expect(createProviderMock).toHaveBeenCalledWith(getCommandEveLocalRuntimeProvider());
    const seeded = createProviderMock.mock.calls[0][0];
    expect(seeded).toMatchObject({
      id: 'command-eve-local-runtime',
      platform: 'custom',
      base_url: 'http://127.0.0.1:25811/v1',
      api_key: 'command-eve-local-loopback',
      use_model: 'custom:command-eve-gemma4-e4b-64k:latest',
      capabilities: [{ type: 'text' }, { type: 'function_calling' }],
    });
  });

  it('does not create the provider when the row already exists (second boot)', async () => {
    mockBackendWithProviders([provider, localRuntimeRow()]);

    await runBackendMigrations(configFile as never);

    expect(createProviderMock).not.toHaveBeenCalled();
    expect(updateProviderMock).not.toHaveBeenCalled();
    expect(providerPutCalls()).toHaveLength(0);
  });

  it('never overwrites an existing user-modified row', async () => {
    mockBackendWithProviders([{ ...localRuntimeRow(), models: ['custom:command-eve-bonsai-27b-q2'] }]);

    await runBackendMigrations(configFile as never);

    expect(createProviderMock).not.toHaveBeenCalled();
    expect(updateProviderMock).not.toHaveBeenCalled();
    expect(providerPutCalls()).toHaveLength(0);
  });

  it('treats a create conflict from a concurrent seed as success (race-safe)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBackendWithProviders([]);
    const conflict = new BackendHttpError({
      method: 'POST',
      path: '/api/providers',
      status: 409,
      body: { success: false, code: 'PROVIDER_EXISTS', error: 'provider id already exists' },
    });
    createProviderMock
      .mockResolvedValueOnce({ id: COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID })
      .mockRejectedValueOnce(conflict);

    await expect(
      Promise.all([ensureCommandEveLocalRuntimeProvider(), ensureCommandEveLocalRuntimeProvider()])
    ).resolves.toEqual([undefined, undefined]);

    // Two parallel seeds → one create succeeds, one conflicts — and the
    // conflict is success, so nothing reaches the error channel.
    expect(createProviderMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('logs a step failure and continues when the seed fails for a non-conflict reason', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBackendWithProviders([]);
    createProviderMock.mockRejectedValue(
      new BackendHttpError({ method: 'POST', path: '/api/providers', status: 500, body: 'boom' })
    );

    await expect(runBackendMigrations(configFile as never)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[CommandEVE] Backend migration step failed: ensureCommandEveLocalRuntimeProvider'),
      expect.anything()
    );
    // The failure must not block the remaining steps.
    expect(listServersMock).toHaveBeenCalled();
  });

  it('runs after migrateProviders and before ensureBootstrapMcpServersInDb', async () => {
    const order: string[] = [];
    vi.mocked(migrateProviders).mockImplementationOnce(async () => {
      order.push('migrateProviders');
    });
    createProviderMock.mockImplementationOnce(async () => {
      order.push('ensureCommandEveLocalRuntimeProvider');
      return { id: COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID };
    });
    listServersMock.mockImplementationOnce(async () => {
      order.push('ensureBootstrapMcpServersInDb');
      return [];
    });

    await runBackendMigrations(configFile as never);

    expect(order.indexOf('migrateProviders')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('migrateProviders')).toBeLessThan(order.indexOf('ensureCommandEveLocalRuntimeProvider'));
    expect(order.indexOf('ensureCommandEveLocalRuntimeProvider')).toBeLessThan(
      order.indexOf('ensureBootstrapMcpServersInDb')
    );
  });
});
