import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectSemanticCoordinator } from '@process/services/project-workspace/core/semanticBundleCore';
import {
  createProjectWorkspaceFacade,
  type ProjectWorkspaceFacade,
} from '@process/services/project-workspace/ProjectWorkspaceFacade';
import { ProjectWorkspaceLifecycleService } from '@process/services/project-workspace/ProjectWorkspaceLifecycleService';
import { ProjectWorkspaceService } from '@process/services/project-workspace/ProjectWorkspaceService';
import type { ProjectConversationMetadataClient } from '@process/services/project-workspace/runtime/conversationBindingClient';
import { ProjectWorkspaceConversationArtifactStore } from '@process/services/project-workspace/storage/conversationArtifactStore';
import { ProjectWorkspaceRegistryStore } from '@process/services/project-workspace/storage/registryStore';
import { ProjectLifecycleOperationStore } from '@process/services/project-workspace/transaction/lifecycleOperationStore';

vi.mock('electron', () => ({
  shell: { showItemInFolder: vi.fn() },
}));

const SEAT_ID = 'seat-alpha';
const SEAT_REVISION = 7;
const PRIVAT_REALM_ID = '11111111-1111-4111-8111-111111111111';
const PRIVAT_ROOT_ID = '22222222-2222-4222-8222-222222222222';
const BUSINESS_REALM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BUSINESS_ROOT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECOND_BUSINESS_ROOT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

function fakeSemanticCoordinator(bindingClient: ProjectConversationMetadataClient): ProjectSemanticCoordinator {
  return {
    preflight: async (input) => {
      let initial = {
        binding: null,
        project_binding_revision: 0,
        project_binding_receipt_id: null,
      } as Awaited<ReturnType<ProjectConversationMetadataClient['read']>>;
      try {
        initial = await bindingClient.read(input.conversation_id);
      } catch {
        // Manual UI creates use a synthetic conversation id. Production treats
        // that missing binding target as a semantic no-op while still creating
        // the project, so this coordinator fake must preserve the same rule.
      }
      return {
        ok: true,
        extension_bundle_sha256: sha256('extension'),
        effect_plan_sha256: sha256('effect-plan'),
        initial_conversation_binding: initial.binding,
        initial_project_binding_revision: initial.project_binding_revision,
        initial_project_binding_receipt_id: initial.project_binding_receipt_id,
        preflight_receipt_id: 'preflight-receipt-1',
        semantic_context_ref: 'semantic-context-1',
        semantic_context_sha256: sha256('semantic-context'),
      };
    },
    stage: async () => {},
    commit: async (input) => {
      try {
        await bindingClient.compareAndSwap({
          conversation_id: input.conversation_id,
          expected: input.binding.initial_conversation_binding,
          expected_project_binding_revision: input.binding.initial_project_binding_revision,
          expected_project_binding_receipt_id: input.binding.initial_project_binding_receipt_id,
          project_binding_operation_id: `${input.transaction_id}:semantic-binding`,
          next: {
            project_id: input.identity.project_id,
            workspace_root_ref: input.identity.workspace_root_ref,
          },
        });
      } catch {
        // Same synthetic-UI no-op as preflight. Auto-project tests still prove
        // a real CAS because the facade re-reads and requires the committed bind.
      }
    },
    recover: async () => {},
    rollback: async () => {},
    prepareRemovalRollback: async () => {},
    finalizeRemovalRollback: async () => {},
  };
}

type MetadataEntry = {
  conversation_id: string;
  name: string;
  conversation_type: string;
  backend: string | null;
  is_temporary_workspace: boolean;
  custom_workspace: boolean;
  project_id: string | null;
};

function eligibleEntry(conversationId: string, name: string): MetadataEntry {
  return {
    conversation_id: conversationId,
    name,
    conversation_type: 'acp',
    backend: 'hermes',
    is_temporary_workspace: true,
    custom_workspace: false,
    project_id: null,
  };
}

/** Stateful trusted-metadata fake: the CAS actually commits, so a later readMetadata observes the binding. */
function fakeBindingClient(metadata: MetadataEntry[], casCalls: string[]): ProjectConversationMetadataClient {
  const snapshotFor = (entry: MetadataEntry) => ({
    binding: entry.project_id
      ? { project_id: entry.project_id, workspace_root_ref: `root:${BUSINESS_ROOT_ID}` as const }
      : null,
    project_binding_revision: 0,
    project_binding_receipt_id: null,
  });
  const metadataFor = (entry: MetadataEntry) => ({
    conversation_id: entry.conversation_id,
    name: entry.name,
    conversation_type: entry.conversation_type,
    backend: entry.backend,
    is_temporary_workspace: entry.is_temporary_workspace,
    custom_workspace: entry.custom_workspace,
    ...snapshotFor(entry),
  });
  return {
    read: async (conversationId) => {
      const entry = metadata.find((candidate) => candidate.conversation_id === conversationId);
      if (!entry) throw new Error('unknown conversation');
      return snapshotFor(entry);
    },
    compareAndSwap: async (input) => {
      const entry = metadata.find((candidate) => candidate.conversation_id === input.conversation_id);
      if (!entry) throw new Error('unknown conversation');
      casCalls.push(input.conversation_id);
      entry.project_id = input.next ? input.next.project_id : null;
      return {
        binding: input.next,
        project_binding_revision: input.expected_project_binding_revision + 1,
        project_binding_receipt_id: input.project_binding_operation_id,
      };
    },
    readMetadata: async (conversationId) => {
      const entry = metadata.find((candidate) => candidate.conversation_id === conversationId);
      if (!entry) throw new Error('unknown conversation');
      return metadataFor(entry);
    },
    listMetadata: async () => metadata.map(metadataFor),
  };
}

type Fixture = {
  facade: ProjectWorkspaceFacade;
  registry: ProjectWorkspaceRegistryStore;
  artifactStore: ProjectWorkspaceConversationArtifactStore;
  stateRoot: string;
  businessRootPath: string;
  metadata: MetadataEntry[];
  bindingCasCalls: string[];
  setSeatSwitchInFlight: (value: boolean) => void;
  cleanup: () => void;
};

function fixture(options?: { secondBusinessRoot?: boolean; onlyPrivatRealm?: boolean }): Fixture {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-autoproject-state-'));
  const privatRootPath = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-autoproject-privat-')));
  const businessRootPath = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-autoproject-business-')));
  const registry = new ProjectWorkspaceRegistryStore({ state_root: stateRoot });
  registry.initializeSeat(SEAT_ID);
  registry.upsertRealm({
    seat_id: SEAT_ID,
    expected_revision: 0,
    realm: { realm_id: PRIVAT_REALM_ID, label: 'Privat', path_slug: 'privat', status: 'active', order: 0 },
  });
  registry.registerRoot({
    seat_id: SEAT_ID,
    expected_seat_revision: 0,
    expected_global_revision: 0,
    root: {
      root_id: PRIVAT_ROOT_ID,
      realm_id: PRIVAT_REALM_ID,
      label: 'Privat',
      kind: 'app_managed',
      path: privatRootPath,
      status: 'active',
    },
  });
  if (!options?.onlyPrivatRealm) {
    const realmRevision = registry.readSeatCatalogs(SEAT_ID).realms.revision;
    registry.upsertRealm({
      seat_id: SEAT_ID,
      expected_revision: realmRevision,
      realm: {
        realm_id: BUSINESS_REALM_ID,
        label: 'Geschäftlich',
        path_slug: 'geschaeftlich',
        status: 'active',
        order: 1,
      },
    });
    const rootRevision = registry.readSeatCatalogs(SEAT_ID).roots.revision;
    const globalRevision = registry.readGlobalRoots().revision;
    registry.registerRoot({
      seat_id: SEAT_ID,
      expected_seat_revision: rootRevision,
      expected_global_revision: globalRevision,
      root: {
        root_id: BUSINESS_ROOT_ID,
        realm_id: BUSINESS_REALM_ID,
        label: 'Geschäftlich',
        kind: 'app_managed',
        path: businessRootPath,
        status: 'active',
      },
    });
    if (options?.secondBusinessRoot) {
      const secondRootPath = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-autoproject-biz2-')));
      registry.registerRoot({
        seat_id: SEAT_ID,
        expected_seat_revision: registry.readSeatCatalogs(SEAT_ID).roots.revision,
        expected_global_revision: registry.readGlobalRoots().revision,
        root: {
          root_id: SECOND_BUSINESS_ROOT_ID,
          realm_id: BUSINESS_REALM_ID,
          label: 'Geschäftlich 2',
          kind: 'app_managed',
          path: secondRootPath,
          status: 'active',
        },
      });
    }
  }

  let seatSwitchInFlight = false;
  const metadata: MetadataEntry[] = [];
  const bindingCasCalls: string[] = [];
  const bindingClient = fakeBindingClient(metadata, bindingCasCalls);
  const service = new ProjectWorkspaceService({
    registry,
    get_active_seat_id: () => SEAT_ID,
    semantic_coordinator: fakeSemanticCoordinator(bindingClient),
  });
  const lifecycle = new ProjectWorkspaceLifecycleService({
    registry,
    operations: new ProjectLifecycleOperationStore(stateRoot),
    binding_client: bindingClient,
    get_active_seat_id: () => SEAT_ID,
    get_seat_context_revision: () => SEAT_REVISION,
    is_seat_switch_in_flight: () => seatSwitchInFlight,
    resolve_hermes_home: () => path.join(stateRoot, 'hermes-home'),
  });
  let facade: ProjectWorkspaceFacade;
  const artifactStore = new ProjectWorkspaceConversationArtifactStore({
    state_root: stateRoot,
    on_changed: (artifact) => facade.notifyArtifactChanged(artifact),
  });
  facade = createProjectWorkspaceFacade({
    registry,
    service,
    lifecycle,
    artifact_store: artifactStore,
    binding_client: bindingClient,
    get_active_seat_id: () => SEAT_ID,
    get_active_seat_label: () => 'Alpha Seat',
    get_active_seat_context_revision: () => SEAT_REVISION,
    is_seat_switch_in_flight: () => seatSwitchInFlight,
    now_ms: () => 1_000_000,
    auto_project_title_reread_delay_ms: 1,
  });
  return {
    facade,
    registry,
    artifactStore,
    stateRoot,
    businessRootPath,
    metadata,
    bindingCasCalls,
    setSeatSwitchInFlight: (value) => {
      seatSwitchInFlight = value;
    },
    cleanup: () => {
      fs.rmSync(stateRoot, { recursive: true, force: true });
      fs.rmSync(privatRootPath, { recursive: true, force: true });
      fs.rmSync(businessRootPath, { recursive: true, force: true });
    },
  };
}

function manifestCreatedBy(f: Fixture, slug: string): string {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(f.businessRootPath, slug, '.command-eve', 'project.json'), 'utf8')
  ) as { created_by: string };
  return manifest.created_by;
}

describe('ProjectWorkspaceFacade.ensureAfterSuccessfulTurn (1.820.4 MAT-1772)', () => {
  let f: Fixture;

  beforeEach(() => {
    f = fixture();
  });

  afterEach(() => {
    f.cleanup();
    vi.clearAllMocks();
  });

  it('happy path: creates the durable project, binds the real conversation, and writes a path-free completed artifact', async () => {
    f.metadata.push(eligibleEntry('conv-1', 'Q3 Planung'));

    const outcome = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-1', turn_id: 'turn-1' });

    expect(outcome.status).toBe('created');
    if (outcome.status !== 'created') throw new Error('expected created');
    expect(outcome.project_title).toBe('Q3 Planung');
    // Pathless outcome DTO: no root path, no state root, no absolute path.
    expect(JSON.stringify(outcome)).not.toContain(f.businessRootPath);
    expect(JSON.stringify(outcome)).not.toContain(f.stateRoot);

    // Real project in the trusted catalog, in the business placement.
    const catalogs = f.registry.readSeatCatalogs(SEAT_ID);
    const record = catalogs.projects.projects.find((candidate) => candidate.project_id === outcome.project_id);
    expect(record).toBeDefined();
    expect(record?.realm_id).toBe(BUSINESS_REALM_ID);
    expect(record?.root_id).toBe(BUSINESS_ROOT_ID);
    expect(record?.title).toBe('Q3 Planung');
    expect(fs.existsSync(path.join(f.businessRootPath, 'q3-planung'))).toBe(true);

    // The auto-created manifest is provenance-marked as EVE.
    expect(manifestCreatedBy(f, 'q3-planung')).toBe('eve');

    // Real conversation binding committed through the CAS lifecycle path.
    const metadata = f.metadata.find((candidate) => candidate.conversation_id === 'conv-1');
    expect(metadata?.project_id).toBe(outcome.project_id);
    expect(f.bindingCasCalls).toEqual(['conv-1']);

    // The composer-facing artifact: newest COMPLETED project artifact carries the title, path-free.
    const artifacts = await f.facade.listConversationArtifacts({ conversation_id: 'conv-1' });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.payload.state).toBe('completed');
    expect(artifacts[0]?.payload.project_title).toBe('Q3 Planung');
    expect(artifacts[0]?.payload.receipt?.outcome).toBe('completed');
    expect(JSON.stringify(artifacts)).not.toContain(f.businessRootPath);
    expect(JSON.stringify(artifacts)).not.toContain(f.stateRoot);
  });

  it('keeps manual UI creates on created_by user while the auto path marks eve', async () => {
    const preview = await f.facade.previewCreate({
      placement_id: `${BUSINESS_REALM_ID}:${BUSINESS_ROOT_ID}`,
      title: 'Manuelles Projekt',
      seat_context_revision: SEAT_REVISION,
    });
    const receipt = await f.facade.create({
      preview_id: preview.preview_id,
      expected_preview_revision: preview.preview_revision,
      seat_context_revision: SEAT_REVISION,
      idempotency_key: crypto.randomUUID(),
    });
    expect(receipt.outcome).toBe('completed');
    expect(manifestCreatedBy(f, 'manuelles-projekt')).toBe('user');

    f.metadata.push(eligibleEntry('conv-2', 'Automatisches Projekt'));
    const outcome = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-2', turn_id: 'turn-9' });
    expect(outcome.status).toBe('created');
    expect(manifestCreatedBy(f, 'automatisches-projekt')).toBe('eve');
  });

  it('is idempotent across duplicate/replayed finish events: one project, one artifact', async () => {
    f.metadata.push(eligibleEntry('conv-1', 'Q3 Planung'));

    const first = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-1', turn_id: 'turn-1' });
    const second = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-1', turn_id: 'turn-1' });
    const third = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-1', turn_id: 'turn-1' });

    expect(first.status).toBe('created');
    // The binding re-check catches the replay: the conversation is bound now.
    expect(second).toEqual({ status: 'noop' });
    expect(third).toEqual({ status: 'noop' });
    expect(f.registry.readSeatCatalogs(SEAT_ID).projects.projects).toHaveLength(1);
    const artifacts = await f.facade.listConversationArtifacts({ conversation_id: 'conv-1' });
    expect(artifacts).toHaveLength(1);
  });

  it('no-ops on an already-bound conversation without creating anything', async () => {
    const entry = eligibleEntry('conv-1', 'Q3 Planung');
    entry.project_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    f.metadata.push(entry);

    const outcome = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-1', turn_id: 'turn-1' });

    expect(outcome).toEqual({ status: 'noop' });
    expect(f.registry.readSeatCatalogs(SEAT_ID).projects.projects).toHaveLength(0);
  });

  it('no-ops on custom and non-temporary workspaces', async () => {
    const custom = eligibleEntry('conv-custom', 'Q3 Planung');
    custom.custom_workspace = true;
    const nonTemporary = eligibleEntry('conv-nontemp', 'Q3 Planung');
    nonTemporary.is_temporary_workspace = false;
    f.metadata.push(custom, nonTemporary);

    await expect(
      f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-custom', turn_id: 'turn-1' })
    ).resolves.toEqual({ status: 'noop' });
    await expect(
      f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-nontemp', turn_id: 'turn-2' })
    ).resolves.toEqual({ status: 'noop' });
    expect(f.registry.readSeatCatalogs(SEAT_ID).projects.projects).toHaveLength(0);
  });

  it('no-ops on non-EVE backends, non-ACP conversations, and unreadable metadata', async () => {
    const otherBackend = eligibleEntry('conv-other', 'Q3 Planung');
    otherBackend.backend = 'claude';
    const nonAcp = eligibleEntry('conv-codex', 'Q3 Planung');
    nonAcp.conversation_type = 'codex';
    f.metadata.push(otherBackend, nonAcp);

    await expect(
      f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-other', turn_id: 'turn-1' })
    ).resolves.toEqual({ status: 'noop' });
    await expect(
      f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-codex', turn_id: 'turn-2' })
    ).resolves.toEqual({ status: 'noop' });
    await expect(
      f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-missing', turn_id: 'turn-3' })
    ).resolves.toEqual({ status: 'noop' });
    expect(f.registry.readSeatCatalogs(SEAT_ID).projects.projects).toHaveLength(0);
  });

  it('re-reads a default title a bounded number of times and uses the durable one when it appears', async () => {
    const entry = eligibleEntry('conv-1', 'Neuer Chat');
    f.metadata.push(entry);
    const bindingClient = (f.facade as unknown as { deps: { binding_client: ProjectConversationMetadataClient } }).deps
      .binding_client;
    // The durable title lands after the first read (the finish/title-write race).
    const originalRead = bindingClient.readMetadata;
    let reads = 0;
    bindingClient.readMetadata = async (conversationId: string) => {
      reads += 1;
      if (reads >= 2) entry.name = 'Q3 Planung';
      return originalRead(conversationId);
    };

    const outcome = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-1', turn_id: 'turn-1' });

    expect(outcome.status).toBe('created');
    // Initial eligibility read + one title-race re-read + one post-commit
    // binding proof. The extra read is deliberate; it replaces a dangerous
    // second CAS bind.
    expect(reads).toBe(3);
    expect(f.registry.readSeatCatalogs(SEAT_ID).projects.projects[0]?.title).toBe('Q3 Planung');
  });

  it('no-ops safely when the title never becomes durable (default or greeting-only)', async () => {
    f.metadata.push(eligibleEntry('conv-default', 'New Chat'), eligibleEntry('conv-greeting', 'Hallo'));

    await expect(
      f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-default', turn_id: 'turn-1' })
    ).resolves.toEqual({ status: 'noop' });
    await expect(
      f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-greeting', turn_id: 'turn-2' })
    ).resolves.toEqual({ status: 'noop' });
    expect(f.registry.readSeatCatalogs(SEAT_ID).projects.projects).toHaveLength(0);
  });

  it('fails closed while a seat switch is in flight', async () => {
    f.metadata.push(eligibleEntry('conv-1', 'Q3 Planung'));
    f.setSeatSwitchInFlight(true);

    const outcome = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-1', turn_id: 'turn-1' });

    expect(outcome).toEqual({ status: 'noop' });
    expect(f.registry.readSeatCatalogs(SEAT_ID).projects.projects).toHaveLength(0);
  });

  it('fails closed when the default business placement is missing', async () => {
    f.cleanup();
    f = fixture({ onlyPrivatRealm: true });
    f.metadata.push(eligibleEntry('conv-1', 'Q3 Planung'));

    const outcome = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-1', turn_id: 'turn-1' });

    expect(outcome).toEqual({ status: 'noop' });
    expect(f.registry.readSeatCatalogs(SEAT_ID).projects.projects).toHaveLength(0);
  });

  it('fails closed when the default business placement is ambiguous (two app-managed roots)', async () => {
    f.cleanup();
    f = fixture({ secondBusinessRoot: true });
    f.metadata.push(eligibleEntry('conv-1', 'Q3 Planung'));

    const outcome = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-1', turn_id: 'turn-1' });

    expect(outcome).toEqual({ status: 'noop' });
    expect(f.registry.readSeatCatalogs(SEAT_ID).projects.projects).toHaveLength(0);
  });

  it('no-ops when an equal-title project already exists instead of duplicating it', async () => {
    f.metadata.push(eligibleEntry('conv-1', 'Q3 Planung'), eligibleEntry('conv-2', 'Q3 Planung'));

    const first = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-1', turn_id: 'turn-1' });
    // A second conversation with the SAME durable title must not force a
    // duplicate project nor hijack the existing one: derivePlan fails closed.
    const second = await f.facade.ensureAfterSuccessfulTurn({ conversation_id: 'conv-2', turn_id: 'turn-2' });

    expect(first.status).toBe('created');
    expect(second).toEqual({ status: 'noop' });
    expect(f.registry.readSeatCatalogs(SEAT_ID).projects.projects).toHaveLength(1);
    expect(f.metadata.find((candidate) => candidate.conversation_id === 'conv-2')?.project_id).toBeNull();
  });

  it('reports the auto-project policy as active in list (separated from the calibration release lock)', async () => {
    const dto = await f.facade.list();
    expect(dto.automatic_creation_enabled).toBe(true);
  });
});
