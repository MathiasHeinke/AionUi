import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendHttpError } from '@/common/adapter/httpBridge';
import {
  COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID,
  getCommandEveLocalRuntimeProvider,
} from '@/common/config/commandEveShell';
import {
  COMMAND_EVE_MANAGED_IMAGE_MODEL,
  COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
  COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID,
  getCommandEveManagedImageProvider,
} from '@/common/config/eveManagedImageGenerationCore';
import { migrateProviders } from '@/common/config/configMigration';
import { IMAGE_GEN_ENV_KEYS } from '@/common/config/imageGenerationMcpEnv';
import { BUILTIN_IMAGE_GEN_NAME, type IMcpServer, type IProvider } from '@/common/config/storage';
import {
  ensureCommandEveLocalRuntimeProvider,
  resolveImageGenerationMcpEnabled,
  resolveImageGenerationMigrationConfig,
  runBackendMigrations,
  secureManagedImageGenerationMcpEnv,
} from '@/process/utils/runBackendMigrations';
import { ensureCommandEveShimAuthToken } from '@/process/commandEve/ollamaOpenAiShim';
import { ensureCommandEveManagedImageProvider } from '@/process/commandEve/managedImageProviderBootstrap';

const {
  batchImportServersMock,
  configFileGetMock,
  configFileSetMock,
  createProviderMock,
  httpRequestMock,
  listServersMock,
  provisionShimAuthTokenFileMock,
  testMcpConnectionMock,
  toggleServerMock,
  updateProviderMock,
  updateServerMock,
} = vi.hoisted(() => ({
  batchImportServersMock: vi.fn(),
  configFileGetMock: vi.fn(),
  configFileSetMock: vi.fn(),
  createProviderMock: vi.fn(),
  httpRequestMock: vi.fn(),
  listServersMock: vi.fn(),
  provisionShimAuthTokenFileMock: vi.fn(),
  testMcpConnectionMock: vi.fn(),
  toggleServerMock: vi.fn(),
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
    toggleServer: { invoke: toggleServerMock },
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

vi.mock('@/process/utils/builtinMcpPath', () => ({
  getBuiltinMcpScriptPath: (name: string) => `/mock/${name}.js`,
}));

vi.mock('@/process/utils/migrateAssistants', () => ({
  migrateAssistantsToBackend: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/process/commandEve/ollamaOpenAiShim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/process/commandEve/ollamaOpenAiShim')>();
  return {
    ...actual,
    provisionCommandEveShimAuthTokenFile: provisionShimAuthTokenFileMock,
  };
});

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
const providerRowFromCreate = (body: unknown): IProvider => {
  const request = body as ReturnType<typeof getCommandEveLocalRuntimeProvider> & {
    models?: string[];
    enabled?: boolean;
  };
  return {
    ...request,
    models: request.models || [],
    enabled: request.enabled ?? true,
    created_at: 1,
    updated_at: 1,
  } as IProvider;
};

const mockBackendWithProviders = (
  providers: IProvider[],
  onCreate?: (body: unknown, rows: IProvider[]) => Promise<IProvider>,
  onUpdate?: (body: unknown, rows: IProvider[], rowIndex: number) => Promise<IProvider>,
  backendPreferences: Record<string, unknown> = {
    'tools.imageGenerationModel': {
      id: 'provider-1',
      name: 'Gemini',
      platform: 'gemini',
      use_model: 'gemini-image',
    },
  }
) => {
  const rows = [...providers];
  httpRequestMock.mockImplementation(async (method: string, path: string, body?: unknown) => {
    if (method === 'GET' && path === '/api/settings/client') {
      return backendPreferences;
    }
    if (method === 'GET' && path === '/api/providers') {
      return [...rows];
    }
    if (method === 'POST' && path === '/api/providers') {
      const created = onCreate ? await onCreate(body, rows) : providerRowFromCreate(body);
      if (!rows.some((row) => row.id === created.id)) rows.push(created);
      return created;
    }
    if (method === 'PUT' && path.startsWith('/api/providers/')) {
      const id = decodeURIComponent(path.slice('/api/providers/'.length));
      const rowIndex = rows.findIndex((row) => row.id === id);
      if (rowIndex < 0) throw new Error(`Provider ${id} not found`);
      const updated = onUpdate
        ? await onUpdate(body, rows, rowIndex)
        : ({ ...rows[rowIndex], ...(body as Partial<IProvider>), updated_at: 2 } as IProvider);
      rows[rowIndex] = updated;
      return updated;
    }
    return undefined;
  });
  return rows;
};

beforeEach(() => {
  vi.clearAllMocks();
  configFileGetMock.mockResolvedValue(undefined);
  configFileSetMock.mockResolvedValue(undefined);
  createProviderMock.mockResolvedValue({ id: COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID });
  updateProviderMock.mockResolvedValue(undefined);
  listServersMock.mockResolvedValue([]);
  provisionShimAuthTokenFileMock.mockReturnValue('/mock/user-data/command-eve-runtime/shim-auth-token');
  batchImportServersMock.mockResolvedValue([]);
  updateServerMock.mockImplementation(async ({ id, data }) => ({
    ...imageServer(),
    id,
    ...data,
  }));
  toggleServerMock.mockImplementation(async ({ id }) => ({
    ...imageServer(),
    id,
    enabled: true,
  }));
  testMcpConnectionMock.mockResolvedValue({ success: false, error: 'Command not found: npx' });
  mockBackendWithProviders([provider]);
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

  it('restores the app-managed image MCP after an older migration dropped its switch', () => {
    expect(
      resolveImageGenerationMcpEnabled(
        {
          ...getCommandEveManagedImageProvider(),
          enabled: true,
        },
        false
      )
    ).toBe(true);
  });

  it('honors an explicit opt-out and preserves generic provider state without one', () => {
    expect(
      resolveImageGenerationMcpEnabled(
        {
          ...getCommandEveManagedImageProvider(),
          enabled: true,
          switch: false,
        },
        true
      )
    ).toBe(false);
    expect(resolveImageGenerationMcpEnabled({ id: 'provider-1', enabled: true }, false)).toBe(false);
    expect(resolveImageGenerationMcpEnabled({ id: 'provider-1', enabled: true }, true)).toBe(true);
  });

  it('persists the managed loopback nonce by file path and never in MCP env plaintext', () => {
    const managedProvider = {
      ...getCommandEveManagedImageProvider(),
      api_key: 'process-local-nonce',
      models: [COMMAND_EVE_MANAGED_IMAGE_MODEL],
    } as IProvider;
    const secured = secureManagedImageGenerationMcpEnv(
      {
        ok: true,
        source: 'provider-id',
        provider: managedProvider,
        model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
        env: {
          [IMAGE_GEN_ENV_KEYS.providerId]: COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID,
          [IMAGE_GEN_ENV_KEYS.platform]: COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
          [IMAGE_GEN_ENV_KEYS.baseUrl]: managedProvider.base_url,
          [IMAGE_GEN_ENV_KEYS.apiKey]: managedProvider.api_key,
          [IMAGE_GEN_ENV_KEYS.model]: COMMAND_EVE_MANAGED_IMAGE_MODEL,
        },
      },
      '/mock/user-data/command-eve-runtime/shim-auth-token'
    );

    expect(secured.ok).toBe(true);
    if (secured.ok) {
      expect(secured.env[IMAGE_GEN_ENV_KEYS.apiKey]).toBeUndefined();
      expect(secured.env[IMAGE_GEN_ENV_KEYS.apiKeyFile]).toBe('/mock/user-data/command-eve-runtime/shim-auth-token');
    }
  });
});

describe('runBackendMigrations', () => {
  it('does not sync the built-in image MCP server when bootstrap makes no effective change', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    listServersMock.mockResolvedValue([imageServer()]);

    await runBackendMigrations(configFile as never, { userDataPath: '/mock/user-data' });

    expect(updateServerMock).not.toHaveBeenCalled();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, enabled changed: %s, will update: %s',
      'image-server-id',
      'no',
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

    await runBackendMigrations(configFile as never, { userDataPath: '/mock/user-data' });

    expect(updateServerMock).toHaveBeenCalledOnce();
    expect(toggleServerMock).not.toHaveBeenCalled();
    expect(testMcpConnectionMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      '[Migration] image MCP bootstrap decision, server id: %s, transport changed: %s, json changed: %s, enabled changed: %s, will update: %s',
      'image-server-id',
      'no',
      'yes',
      'no',
      'yes'
    );
  });

  it('restores a disabled managed image MCP through the dedicated toggle endpoint', async () => {
    const disabledServer = { ...imageServer(), enabled: false };
    listServersMock.mockResolvedValue([disabledServer]);
    updateServerMock.mockImplementation(async ({ id, data }) => ({
      ...disabledServer,
      id,
      ...data,
    }));
    mockBackendWithProviders(
      [
        {
          ...getCommandEveManagedImageProvider(),
          api_key: ensureCommandEveShimAuthToken(),
          models: [COMMAND_EVE_MANAGED_IMAGE_MODEL],
          enabled: true,
        } as IProvider,
      ],
      undefined,
      undefined,
      {
        'tools.imageGenerationModel': {
          ...getCommandEveManagedImageProvider(),
          enabled: true,
        },
      }
    );

    await runBackendMigrations(configFile as never, { userDataPath: '/mock/user-data' });

    expect(updateServerMock).toHaveBeenCalledOnce();
    expect(toggleServerMock).toHaveBeenCalledOnce();
    expect(toggleServerMock).toHaveBeenCalledWith({ id: 'image-server-id' });
  });

  it('activates the managed image capability on a fresh install without replacing an explicit provider choice', async () => {
    mockBackendWithProviders([], undefined, undefined, {});

    await runBackendMigrations(configFile as never, { userDataPath: '/mock/user-data' });

    const importedServers = batchImportServersMock.mock.calls.flatMap(([payload]) => payload.servers as IMcpServer[]);
    const importedImageServer = importedServers.find((server) => server.name === BUILTIN_IMAGE_GEN_NAME);
    expect(importedImageServer).toMatchObject({
      enabled: true,
      transport: {
        type: 'stdio',
        env: {
          [IMAGE_GEN_ENV_KEYS.providerId]: COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID,
          [IMAGE_GEN_ENV_KEYS.platform]: COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
          [IMAGE_GEN_ENV_KEYS.apiKeyFile]: '/mock/user-data/command-eve-runtime/shim-auth-token',
          [IMAGE_GEN_ENV_KEYS.model]: COMMAND_EVE_MANAGED_IMAGE_MODEL,
        },
      },
    });
    expect(
      importedImageServer?.transport.type === 'stdio'
        ? importedImageServer.transport.env?.[IMAGE_GEN_ENV_KEYS.apiKey]
        : undefined
    ).toBeUndefined();
    expect(configFileSetMock).toHaveBeenCalledWith(
      'tools.imageGenerationModel',
      expect.objectContaining({
        id: COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID,
        platform: COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
        use_model: COMMAND_EVE_MANAGED_IMAGE_MODEL,
      })
    );
  });
});

describe('ensureCommandEveManagedImageProvider', () => {
  const managedRow = (overrides: Partial<IProvider> = {}): IProvider => {
    const { use_model, ...providerConfig } = getCommandEveManagedImageProvider();
    return {
      ...providerConfig,
      api_key: ensureCommandEveShimAuthToken(),
      models: [use_model],
      enabled: true,
      is_full_url: false,
      ...overrides,
    } as IProvider;
  };

  const managedPostCalls = () =>
    httpRequestMock.mock.calls.filter(
      ([method, path, body]) =>
        method === 'POST' &&
        path === '/api/providers' &&
        typeof body === 'object' &&
        body !== null &&
        'id' in body &&
        body.id === COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID
    );

  const managedPutCalls = () =>
    httpRequestMock.mock.calls.filter(
      ([method, path]) => method === 'PUT' && path === `/api/providers/${COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID}`
    );

  it('seeds one loopback-only provider with the fixed local model and no cloud credential', async () => {
    const shimBaseUrl = 'http://127.0.0.1:41235/v1';
    mockBackendWithProviders([provider]);

    await expect(
      ensureCommandEveManagedImageProvider({ shimOpenAiBaseUrl: shimBaseUrl, sleep: async () => undefined })
    ).resolves.toMatchObject({ status: 'ready', created: true, conflict: false });

    expect(managedPostCalls()).toHaveLength(1);
    expect(managedPostCalls()[0][2]).toMatchObject({
      id: COMMAND_EVE_MANAGED_IMAGE_PROVIDER_ID,
      platform: COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
      base_url: shimBaseUrl,
      api_key: ensureCommandEveShimAuthToken(),
      models: [COMMAND_EVE_MANAGED_IMAGE_MODEL],
      enabled: true,
      is_full_url: false,
    });
    expect(JSON.stringify(managedPostCalls()[0][2])).not.toContain('openrouter');
  });

  it('is idempotent when the exact managed provider already exists', async () => {
    mockBackendWithProviders([provider, managedRow()]);

    await expect(ensureCommandEveManagedImageProvider({ sleep: async () => undefined })).resolves.toMatchObject({
      status: 'ready',
      created: false,
      conflict: false,
    });

    expect(managedPostCalls()).toHaveLength(0);
    expect(managedPutCalls()).toHaveLength(0);
  });

  it('repairs every mutable field back to the bounded loopback contract', async () => {
    mockBackendWithProviders([
      provider,
      managedRow({
        name: 'Remote image provider',
        platform: 'openai',
        base_url: 'https://credential-sink.invalid/v1',
        api_key: 'remote-secret',
        models: ['remote-model'],
        enabled: false,
        is_full_url: true,
      }),
    ]);

    await expect(ensureCommandEveManagedImageProvider({ sleep: async () => undefined })).resolves.toMatchObject({
      status: 'ready',
      created: false,
    });

    expect(managedPutCalls()).toHaveLength(1);
    expect(managedPutCalls()[0][2]).toMatchObject({
      name: 'EVE Visual Directions',
      platform: COMMAND_EVE_MANAGED_IMAGE_PLATFORM,
      base_url: 'http://127.0.0.1:25811/v1',
      api_key: ensureCommandEveShimAuthToken(),
      models: [COMMAND_EVE_MANAGED_IMAGE_MODEL],
      enabled: true,
      is_full_url: false,
    });
  });

  it('rejects non-loopback bootstrap targets without touching the backend', async () => {
    await expect(
      ensureCommandEveManagedImageProvider({
        shimOpenAiBaseUrl: 'https://credential-sink.invalid/v1',
        sleep: async () => undefined,
      })
    ).rejects.toThrow('not ready after three bounded attempts');
    expect(httpRequestMock).not.toHaveBeenCalled();
  });
});

describe('ensureCommandEveLocalRuntimeProvider', () => {
  /** The seeded provider as a persisted backend row (use_model → models). */
  const localRuntimeRow = (): IProvider => {
    const { use_model, ...rest } = getCommandEveLocalRuntimeProvider();
    return {
      ...rest,
      api_key: ensureCommandEveShimAuthToken(),
      models: [use_model],
      enabled: true,
      is_full_url: false,
    };
  };

  const providerPutCalls = () =>
    httpRequestMock.mock.calls.filter(
      ([method, path]) => method === 'PUT' && String(path).startsWith('/api/providers')
    );

  const providerPostCalls = (providerId = COMMAND_EVE_LOCAL_RUNTIME_PROVIDER_ID) =>
    httpRequestMock.mock.calls.filter(
      ([method, path, body]) =>
        method === 'POST' &&
        path === '/api/providers' &&
        typeof body === 'object' &&
        body !== null &&
        'id' in body &&
        body.id === providerId
    );

  it('seeds the provider on a fresh install with the exact default-tier shape', async () => {
    await runBackendMigrations(configFile as never);

    expect(providerPostCalls()).toHaveLength(1);
    const seeded = providerPostCalls()[0][2];
    expect(seeded).toMatchObject({
      id: 'command-eve-local-runtime',
      platform: 'custom',
      base_url: 'http://127.0.0.1:25811/v1',
      api_key: ensureCommandEveShimAuthToken(),
      models: ['custom:command-eve-gemma4-e4b-64k:latest'],
      enabled: true,
      is_full_url: false,
      capabilities: [{ type: 'text' }, { type: 'function_calling' }],
    });
    expect(seeded).not.toMatchObject({ api_key: 'command-eve-local-loopback' });
  });

  it('does not create the provider when the row already exists (second boot)', async () => {
    mockBackendWithProviders([provider, localRuntimeRow()]);

    await runBackendMigrations(configFile as never);

    expect(providerPostCalls()).toHaveLength(0);
    expect(updateProviderMock).not.toHaveBeenCalled();
    expect(providerPutCalls()).toHaveLength(0);
  });

  it('preserves user-modified non-security fields on an already-ready row', async () => {
    mockBackendWithProviders([{ ...localRuntimeRow(), models: ['custom:command-eve-bonsai-27b-q2'] }]);

    await runBackendMigrations(configFile as never);

    expect(providerPostCalls()).toHaveLength(0);
    expect(updateProviderMock).not.toHaveBeenCalled();
    expect(providerPutCalls()).toHaveLength(0);
  });

  it('reconciles stale security fields without overwriting models or the display name', async () => {
    const models = ['custom:operator-preserved-model'];
    const rows = mockBackendWithProviders([
      {
        ...localRuntimeRow(),
        platform: 'openai',
        name: 'Operator label',
        base_url: 'https://credential-sink.invalid/v1',
        api_key: 'stale-boot-token',
        models,
        enabled: false,
        is_full_url: true,
      },
    ]);

    await expect(
      ensureCommandEveLocalRuntimeProvider({ maxAttempts: 1, sleep: async () => undefined })
    ).resolves.toMatchObject({ status: 'ready', created: false, attempts: 1 });

    expect(providerPostCalls()).toHaveLength(0);
    expect(providerPutCalls()).toHaveLength(1);
    expect(providerPutCalls()[0][1]).toBe('/api/providers/command-eve-local-runtime');
    expect(providerPutCalls()[0][2]).toEqual({
      platform: 'custom',
      base_url: 'http://127.0.0.1:25811/v1',
      api_key: ensureCommandEveShimAuthToken(),
      enabled: true,
      is_full_url: false,
    });
    expect(rows[0]).toMatchObject({
      name: 'Operator label',
      models,
      platform: 'custom',
      base_url: 'http://127.0.0.1:25811/v1',
      api_key: ensureCommandEveShimAuthToken(),
      enabled: true,
      is_full_url: false,
    });
  });

  it('reconciles the provider to the active ephemeral shim URL', async () => {
    const ephemeralBaseUrl = 'http://127.0.0.1:41234/v1';
    mockBackendWithProviders([localRuntimeRow()]);

    await expect(
      ensureCommandEveLocalRuntimeProvider({
        shimOpenAiBaseUrl: ephemeralBaseUrl,
        maxAttempts: 1,
        sleep: async () => undefined,
      })
    ).resolves.toMatchObject({ status: 'ready', created: false, attempts: 1 });

    expect(providerPutCalls()).toHaveLength(1);
    expect(providerPutCalls()[0][2]).toEqual({ base_url: ephemeralBaseUrl });
  });

  it('rejects a non-loopback shim URL before reading or mutating provider state', async () => {
    await expect(
      ensureCommandEveLocalRuntimeProvider({
        shimOpenAiBaseUrl: 'https://credential-sink.invalid/v1',
        maxAttempts: 1,
        sleep: async () => undefined,
      })
    ).rejects.toThrow('is not ready after 1 bounded attempt');
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it('retries a transient security-field PUT and verifies the repaired readback', async () => {
    let updateAttempts = 0;
    mockBackendWithProviders(
      [{ ...localRuntimeRow(), api_key: 'stale-boot-token' }],
      undefined,
      async (body, rows, rowIndex) => {
        updateAttempts += 1;
        if (updateAttempts === 1) {
          throw new BackendHttpError({
            method: 'PUT',
            path: '/api/providers/command-eve-local-runtime',
            status: 500,
            body: 'transient',
          });
        }
        return { ...rows[rowIndex], ...(body as Partial<IProvider>), updated_at: 2 } as IProvider;
      }
    );

    await expect(ensureCommandEveLocalRuntimeProvider({ maxAttempts: 2, retryDelayMs: 0 })).resolves.toMatchObject({
      status: 'ready',
      attempts: 2,
      created: false,
    });
    expect(updateAttempts).toBe(2);
  });

  it('fails closed when the PUT readback still violates the security contract', async () => {
    mockBackendWithProviders(
      [{ ...localRuntimeRow(), api_key: 'stale-boot-token' }],
      undefined,
      async (_body, rows, rowIndex) => rows[rowIndex]
    );

    await expect(
      ensureCommandEveLocalRuntimeProvider({ maxAttempts: 1, sleep: async () => undefined })
    ).rejects.toThrow('is not ready after 1 bounded attempt');
    expect(providerPutCalls()).toHaveLength(1);
  });

  it('treats only a structured 409 create conflict as success and verifies readback', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const conflict = new BackendHttpError({
      method: 'POST',
      path: '/api/providers',
      status: 409,
      body: { success: false, code: 'PROVIDER_EXISTS', error: 'provider id already exists' },
    });
    mockBackendWithProviders([], async (_body, rows) => {
      rows.push(localRuntimeRow());
      throw conflict;
    });

    await expect(
      ensureCommandEveLocalRuntimeProvider({ maxAttempts: 1, sleep: async () => undefined })
    ).resolves.toMatchObject({ status: 'ready', conflict: true, created: false });

    expect(providerPostCalls()).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('retries a transient POST failure in the same process and then verifies the row', async () => {
    let attempts = 0;
    mockBackendWithProviders([], async (body) => {
      attempts += 1;
      if (attempts === 1) {
        throw new BackendHttpError({ method: 'POST', path: '/api/providers', status: 500, body: 'transient' });
      }
      return providerRowFromCreate(body);
    });

    await expect(
      ensureCommandEveLocalRuntimeProvider({ maxAttempts: 2, sleep: async () => undefined })
    ).resolves.toMatchObject({ status: 'ready', attempts: 2, created: true });
    expect(providerPostCalls()).toHaveLength(2);
  });

  it('never POSTs when the provider GET fails because backend state is unknown', async () => {
    httpRequestMock.mockImplementation(async (method: string, path: string) => {
      if (method === 'GET' && path === '/api/providers') throw new Error('read unavailable');
      return undefined;
    });

    await expect(
      ensureCommandEveLocalRuntimeProvider({ maxAttempts: 1, sleep: async () => undefined })
    ).rejects.toThrow('is not ready after 1 bounded attempt');
    expect(providerPostCalls()).toHaveLength(0);
  });

  it('does nothing when the Command EVE shell is disabled', async () => {
    await expect(ensureCommandEveLocalRuntimeProvider({ shellEnabled: false })).resolves.toEqual({
      status: 'disabled',
      attempts: 0,
      created: false,
      conflict: false,
    });
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it('logs a step failure and continues when the seed fails for a non-conflict reason', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockBackendWithProviders([], async () => {
      throw new BackendHttpError({ method: 'POST', path: '/api/providers', status: 500, body: 'boom' });
    });

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
    mockBackendWithProviders([provider], async (body) => {
      order.push('ensureCommandEveLocalRuntimeProvider');
      return providerRowFromCreate(body);
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
