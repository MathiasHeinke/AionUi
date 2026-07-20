import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { PROJECT_MANIFEST_VERSION, type ProjectManifestV1 } from '@/common/types/project-workspace/manifest';
import {
  PROJECT_RUNTIME_ATTESTATION_HEADER,
  deriveBackendGeneration,
} from '@/process/security/projectRuntimeAttestationCore';
import { postAttestedProjectRuntimeRequest } from '@/process/bridge/projectWorkspaceBridge';
import { ProjectWorkspaceRegistryStore } from '@/process/services/project-workspace/storage/registryStore';
import { rootComparisonKey } from '@/process/services/project-workspace/storage/rootPolicy';
import type {
  ProjectConversationBindingClient,
  PortableProjectBinding,
} from '@/process/services/project-workspace/runtime/conversationBindingClient';
import {
  type ProjectRuntimeResolutionError,
  resolveTrustedProjectRuntimeSnapshot,
} from '@/process/services/project-workspace/runtime/projectRuntimeResolver';

const IDS = {
  realm: '11111111-1111-4111-8111-111111111111',
  root: '22222222-2222-4222-8222-222222222222',
  project: '33333333-3333-4333-8333-333333333333',
} as const;
const CAPABILITY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function filesystemError(code: 'ENOENT' | 'EACCES', leakedPath: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: filesystem failure at ${leakedPath}`), {
    code,
    path: leakedPath,
  });
}

async function expectPathlessRuntimeFailure(
  failure: Promise<unknown>,
  expectedCode: string,
  leakedPath: string
): Promise<void> {
  let caught: unknown;
  try {
    await failure;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const runtimeError = caught as Error & { code?: string };
  expect(runtimeError.code).toBe(expectedCode);
  expect(
    [runtimeError.name, runtimeError.message, runtimeError.stack, JSON.stringify(runtimeError)].join('\n')
  ).not.toContain(leakedPath);
}

describe('trusted project runtime resolution and Main attestation', () => {
  let stateRoot: string;
  let ownedRoot: string;
  let projectPath: string;
  let registry: ProjectWorkspaceRegistryStore;
  let binding: PortableProjectBinding;
  let bindingClient: ProjectConversationBindingClient;
  let bindingReads: number;
  let bindingRevision: number;
  let bindingReceipt: string | null;

  beforeEach(() => {
    stateRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-runtime-state-')));
    ownedRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-runtime-root-')));
    projectPath = path.join(ownedRoot, 'alpha');
    registry = new ProjectWorkspaceRegistryStore({
      state_root: stateRoot,
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    });
    registry.initializeSeat('seat-alpha');
    registry.upsertRealm({
      seat_id: 'seat-alpha',
      expected_revision: 0,
      realm: {
        realm_id: IDS.realm,
        label: 'Business',
        path_slug: 'business',
        status: 'active',
        order: 0,
      },
    });
    const root = registry.registerRoot({
      seat_id: 'seat-alpha',
      expected_seat_revision: 0,
      expected_global_revision: 0,
      root: {
        root_id: IDS.root,
        realm_id: IDS.realm,
        label: 'Projects',
        kind: 'app_managed',
        path: ownedRoot,
        status: 'active',
      },
    });
    binding = { project_id: IDS.project, workspace_root_ref: root.workspace_root_ref };
    const manifest: ProjectManifestV1 = {
      schema_version: PROJECT_MANIFEST_VERSION,
      project_id: IDS.project,
      seat_id: 'seat-alpha',
      realm_id: IDS.realm,
      realm_label: 'Business',
      realm_path_slug: 'business',
      root_id: IDS.root,
      title: 'Alpha',
      slug: 'alpha',
      status: 'active',
      domain_ids: [],
      created_by: 'user',
      created_at: '2026-07-20T00:00:00.000Z',
      workspace_root_ref: root.workspace_root_ref,
      manual_overrides: [],
    };
    fs.mkdirSync(path.join(projectPath, '.command-eve'), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, '.command-eve', 'project.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );
    registry.registerProject({
      expected_revision: 0,
      record: {
        project_id: IDS.project,
        seat_id: 'seat-alpha',
        realm_id: IDS.realm,
        root_id: IDS.root,
        workspace_root_ref: root.workspace_root_ref,
        title: 'Alpha',
        slug: 'alpha',
        status: 'active',
        manifest_relative_path: 'alpha/.command-eve/project.json',
        canonical_project_path: projectPath,
        comparison_key: rootComparisonKey(projectPath),
        registered_at: '2026-07-20T00:00:00.000Z',
      },
    });
    bindingReads = 0;
    bindingRevision = 1;
    bindingReceipt = '77777777-7777-4777-8777-777777777777';
    bindingClient = {
      read: async () => {
        bindingReads += 1;
        return {
          binding,
          project_binding_revision: bindingRevision,
          project_binding_receipt_id: bindingReceipt,
        };
      },
      compareAndSwap: async ({ next, project_binding_operation_id }) => ({
        binding: next,
        project_binding_revision: bindingRevision + 1,
        project_binding_receipt_id: project_binding_operation_id,
      }),
    };
  });

  afterEach(() => {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(ownedRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function resolverDependencies() {
    return {
      registry,
      binding_client: bindingClient,
      get_active_seat_id: () => 'seat-alpha',
      is_seat_switch_in_flight: () => false,
      get_backend_port: () => 43123,
      get_backend_capability: () => CAPABILITY,
    };
  }

  it('resolves only the complete active identity and returns a path-free environment hint', async () => {
    const snapshot = await resolveTrustedProjectRuntimeSnapshot('conversation-alpha', resolverDependencies());
    expect(snapshot).toMatchObject({
      project_path: projectPath,
      seat_id: 'seat-alpha',
      realm_id: IDS.realm,
      root_id: IDS.root,
      project_id: IDS.project,
      workspace_root_ref: binding.workspace_root_ref,
      project_binding_revision: 1,
      project_binding_receipt_id: bindingReceipt,
      backend_generation: deriveBackendGeneration(CAPABILITY),
      backend_port: 43123,
    });
    expect(snapshot.environment_hint).not.toMatch(/[\\/]/);
    expect(bindingReads).toBe(2);
  });

  it('injects a ticket only from Main after a stable triple-read snapshot', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 }));
    const result = await postAttestedProjectRuntimeRequest<{ accepted: boolean }>(
      {
        purpose: 'send',
        conversation_id: 'conversation-alpha',
        body: { content: 'hello' },
      },
      {
        ...resolverDependencies(),
        fetch_impl: fetchImpl,
        now_seconds: () => 2_000_000_000,
        create_jti: () => 'AAECAwQFBgcICQoLDA0ODw',
      }
    );
    expect(result).toEqual({ accepted: true });
    expect(bindingReads).toBe(3);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:43123/api/conversations/conversation-alpha/messages');
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    const ticket = headers.get(PROJECT_RUNTIME_ATTESTATION_HEADER);
    expect(ticket?.split('.')).toHaveLength(3);
    const claims = JSON.parse(Buffer.from(String(ticket).split('.')[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(claims).not.toHaveProperty('path');
    expect(claims).toMatchObject({
      purpose: 'send',
      project_id: IDS.project,
      project_binding_revision: 1,
      project_binding_receipt_id: bindingReceipt,
      environment_hint: expect.stringContaining('"knowledge_boot_policy":"system_index_first"'),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      content: 'hello',
      runtime_workspace: {
        project_id: IDS.project,
        workspace_root_ref: binding.workspace_root_ref,
        project_binding_revision: 1,
        project_binding_receipt_id: bindingReceipt,
        path: projectPath,
      },
    });
  });

  it('maps a first-pass ENOENT to a stable pathless bridge error', async () => {
    const originalLstat = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation((target) => {
      if (target.toString() === projectPath) throw filesystemError('ENOENT', projectPath);
      return originalLstat(target);
    });
    const fetchImpl = vi.fn<typeof fetch>();

    await expectPathlessRuntimeFailure(
      postAttestedProjectRuntimeRequest(
        { purpose: 'warmup', conversation_id: 'conversation-alpha', body: {} },
        {
          ...resolverDependencies(),
          fetch_impl: fetchImpl,
          now_seconds: () => 2_000_000_000,
          create_jti: () => 'AAECAwQFBgcICQoLDA0ODw',
        }
      ),
      'PROJECT_RUNTIME_PATH_NOT_FOUND',
      projectPath
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps a second-pass EACCES to a stable pathless bridge error', async () => {
    const leakedCatalogPath = registry.pathsForSeat('seat-alpha').project_catalog;
    const originalReadSeatCatalogs = registry.readSeatCatalogs.bind(registry);
    let catalogReads = 0;
    vi.spyOn(registry, 'readSeatCatalogs').mockImplementation((seatId) => {
      catalogReads += 1;
      if (catalogReads === 2) throw filesystemError('EACCES', leakedCatalogPath);
      return originalReadSeatCatalogs(seatId);
    });
    const fetchImpl = vi.fn<typeof fetch>();

    await expectPathlessRuntimeFailure(
      postAttestedProjectRuntimeRequest(
        { purpose: 'send', conversation_id: 'conversation-alpha', body: { content: 'never sent' } },
        {
          ...resolverDependencies(),
          fetch_impl: fetchImpl,
          now_seconds: () => 2_000_000_000,
          create_jti: () => 'AAECAwQFBgcICQoLDA0ODw',
        }
      ),
      'PROJECT_RUNTIME_PATH_ACCESS_DENIED',
      leakedCatalogPath
    );
    expect(catalogReads).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves the pathless EACCES code during post-issuance snapshot verification', async () => {
    const manifestPath = path.join(projectPath, '.command-eve', 'project.json');
    const originalLstat = fs.lstatSync;
    let manifestReads = 0;
    vi.spyOn(fs, 'lstatSync').mockImplementation((target) => {
      if (target.toString() === manifestPath) {
        manifestReads += 1;
        if (manifestReads === 3) throw filesystemError('EACCES', manifestPath);
      }
      return originalLstat(target);
    });
    const fetchImpl = vi.fn<typeof fetch>();
    let jtiCalls = 0;

    await expectPathlessRuntimeFailure(
      postAttestedProjectRuntimeRequest(
        { purpose: 'send', conversation_id: 'conversation-alpha', body: { content: 'never sent' } },
        {
          ...resolverDependencies(),
          fetch_impl: fetchImpl,
          now_seconds: () => 2_000_000_000,
          create_jti: () => {
            jtiCalls += 1;
            return 'AAECAwQFBgcICQoLDA0ODw';
          },
        }
      ),
      'PROJECT_RUNTIME_PATH_ACCESS_DENIED',
      manifestPath
    );
    expect(manifestReads).toBe(3);
    expect(jtiCalls).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('scrubs an unknown absolute-path failure before it crosses the bridge', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    bindingClient = {
      ...bindingClient,
      read: async () => {
        throw Object.assign(new Error(`opaque dependency failed at ${projectPath}`), {
          code: 'EIO',
          path: projectPath,
        });
      },
    };

    await expectPathlessRuntimeFailure(
      postAttestedProjectRuntimeRequest(
        { purpose: 'warmup', conversation_id: 'conversation-alpha', body: {} },
        {
          ...resolverDependencies(),
          fetch_impl: fetchImpl,
          now_seconds: () => 2_000_000_000,
          create_jti: () => 'AAECAwQFBgcICQoLDA0ODw',
        }
      ),
      'PROJECT_RUNTIME_REQUEST_FAILED',
      projectPath
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('discards a ticket and performs exactly one complete re-resolution on registry drift', async () => {
    let jtiCalls = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));
    await postAttestedProjectRuntimeRequest(
      { purpose: 'warmup', conversation_id: 'conversation-alpha', body: {} },
      {
        ...resolverDependencies(),
        fetch_impl: fetchImpl,
        now_seconds: () => 2_000_000_000,
        create_jti: () => {
          jtiCalls += 1;
          if (jtiCalls === 1) {
            registry.renameRoot({
              seat_id: 'seat-alpha',
              root_id: IDS.root,
              expected_revision: 1,
              label: 'Projects Renamed',
            });
          }
          return jtiCalls === 1 ? 'AAECAwQFBgcICQoLDA0ODw' : 'EBESExQVFhcYGRobHB0eHw';
        },
      }
    );
    expect(jtiCalls).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const ticket = new Headers(fetchImpl.mock.calls[0][1]?.headers).get(PROJECT_RUNTIME_ATTESTATION_HEADER) as string;
    const claims = JSON.parse(Buffer.from(ticket.split('.')[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(claims.root_catalog_revision).toBe(2);
  });

  it('re-resolves when the realm catalog changes after ticket issuance', async () => {
    let jtiCalls = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    await postAttestedProjectRuntimeRequest(
      { purpose: 'warmup', conversation_id: 'conversation-alpha', body: {} },
      {
        ...resolverDependencies(),
        fetch_impl: fetchImpl,
        now_seconds: () => 2_000_000_000,
        create_jti: () => {
          jtiCalls += 1;
          if (jtiCalls === 1) {
            registry.renameRealm({
              seat_id: 'seat-alpha',
              realm_id: IDS.realm,
              expected_revision: 1,
              label: 'Business Renamed',
              path_slug: 'business',
            });
          }
          return jtiCalls === 1 ? 'AAECAwQFBgcICQoLDA0ODw' : 'EBESExQVFhcYGRobHB0eHw';
        },
      }
    );

    expect(jtiCalls).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('detects a same-revision ownership-record race and fully re-resolves', async () => {
    let jtiCalls = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    await postAttestedProjectRuntimeRequest(
      { purpose: 'warmup', conversation_id: 'conversation-alpha', body: {} },
      {
        ...resolverDependencies(),
        fetch_impl: fetchImpl,
        now_seconds: () => 2_000_000_000,
        create_jti: () => {
          jtiCalls += 1;
          if (jtiCalls === 1) {
            const ownershipPath = path.join(stateRoot, 'global', 'root-ownership.json');
            const ownership = JSON.parse(fs.readFileSync(ownershipPath, 'utf8')) as {
              roots: Array<{ registered_at: string }>;
            };
            ownership.roots[0].registered_at = '2026-07-20T00:00:01.000Z';
            fs.writeFileSync(ownershipPath, `${JSON.stringify(ownership, null, 2)}\n`, 'utf8');
          }
          return jtiCalls === 1 ? 'AAECAwQFBgcICQoLDA0ODw' : 'EBESExQVFhcYGRobHB0eHw';
        },
      }
    );

    expect(jtiCalls).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-reads every local source after the final asynchronous binding read', async () => {
    let jtiCalls = 0;
    bindingClient = {
      read: async () => {
        bindingReads += 1;
        if (bindingReads === 3) {
          registry.renameRoot({
            seat_id: 'seat-alpha',
            root_id: IDS.root,
            expected_revision: 1,
            label: 'Changed During Binding Read',
          });
        }
        return {
          binding,
          project_binding_revision: bindingRevision,
          project_binding_receipt_id: bindingReceipt,
        };
      },
      compareAndSwap: async ({ next, project_binding_operation_id }) => ({
        binding: next,
        project_binding_revision: bindingRevision + 1,
        project_binding_receipt_id: project_binding_operation_id,
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    await postAttestedProjectRuntimeRequest(
      { purpose: 'warmup', conversation_id: 'conversation-alpha', body: {} },
      {
        ...resolverDependencies(),
        fetch_impl: fetchImpl,
        now_seconds: () => 2_000_000_000,
        create_jti: () => {
          jtiCalls += 1;
          return jtiCalls === 1 ? 'AAECAwQFBgcICQoLDA0ODw' : 'EBESExQVFhcYGRobHB0eHw';
        },
      }
    );

    expect(jtiCalls).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a same-pair binding ABA and signs only the new monotone revision', async () => {
    let jtiCalls = 0;
    bindingClient = {
      read: async () => {
        bindingReads += 1;
        if (bindingReads === 3) {
          bindingRevision = 2;
          bindingReceipt = '88888888-8888-4888-8888-888888888888';
        }
        return {
          binding,
          project_binding_revision: bindingRevision,
          project_binding_receipt_id: bindingReceipt,
        };
      },
      compareAndSwap: async ({ next, project_binding_operation_id }) => ({
        binding: next,
        project_binding_revision: bindingRevision + 1,
        project_binding_receipt_id: project_binding_operation_id,
      }),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }));

    await postAttestedProjectRuntimeRequest(
      { purpose: 'warmup', conversation_id: 'conversation-alpha', body: {} },
      {
        ...resolverDependencies(),
        fetch_impl: fetchImpl,
        now_seconds: () => 2_000_000_000,
        create_jti: () => {
          jtiCalls += 1;
          return jtiCalls === 1 ? 'AAECAwQFBgcICQoLDA0ODw' : 'EBESExQVFhcYGRobHB0eHw';
        },
      }
    );

    expect(jtiCalls).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const compact = new Headers(fetchImpl.mock.calls[0][1]?.headers).get(PROJECT_RUNTIME_ATTESTATION_HEADER) as string;
    const claims = JSON.parse(Buffer.from(compact.split('.')[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(claims.project_binding_revision).toBe(2);
    expect(claims.project_binding_receipt_id).toBe('88888888-8888-4888-8888-888888888888');
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).runtime_workspace).toMatchObject({
      project_binding_revision: 2,
      project_binding_receipt_id: '88888888-8888-4888-8888-888888888888',
    });
  });

  it('fails closed if the manifest changes after ticket issuance', async () => {
    let jtiCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>();
    const failure = postAttestedProjectRuntimeRequest(
      { purpose: 'send', conversation_id: 'conversation-alpha', body: { content: 'secret' } },
      {
        ...resolverDependencies(),
        fetch_impl: fetchImpl,
        now_seconds: () => 2_000_000_000,
        create_jti: () => {
          jtiCalls += 1;
          const manifestPath = path.join(projectPath, '.command-eve', 'project.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ProjectManifestV1;
          fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, title: 'Tampered' }, null, 2)}\n`, 'utf8');
          return 'AAECAwQFBgcICQoLDA0ODw';
        },
      }
    );

    await expect(failure).rejects.toMatchObject<ProjectRuntimeResolutionError>({
      code: 'PROJECT_RUNTIME_MANIFEST_MISMATCH',
    });
    try {
      await failure;
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(projectPath);
      expect(JSON.stringify(error)).not.toContain(PROJECT_RUNTIME_ATTESTATION_HEADER);
    }
    expect(jtiCalls).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed without leaking the ticket or canonical path when both resolution attempts drift', async () => {
    let capability = CAPABILITY;
    let jtiCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>();
    const failure = postAttestedProjectRuntimeRequest(
      { purpose: 'send', conversation_id: 'conversation-alpha', body: { content: 'secret' } },
      {
        ...resolverDependencies(),
        get_backend_capability: () => capability,
        fetch_impl: fetchImpl,
        now_seconds: () => 2_000_000_000,
        create_jti: () => {
          jtiCalls += 1;
          capability = `${CAPABILITY.slice(0, -1)}${jtiCalls}`;
          return 'AAECAwQFBgcICQoLDA0ODw';
        },
      }
    );
    await expect(failure).rejects.toMatchObject<ProjectRuntimeResolutionError>({
      code: 'PROJECT_RUNTIME_SNAPSHOT_CHANGED',
    });
    try {
      await failure;
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(projectPath);
      expect(JSON.stringify(error)).not.toContain(PROJECT_RUNTIME_ATTESTATION_HEADER);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
