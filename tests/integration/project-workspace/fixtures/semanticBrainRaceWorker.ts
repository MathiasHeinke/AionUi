import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_MANIFEST_VERSION, type ProjectManifestV1 } from '@/common/types/project-workspace/manifest';
import { ProjectWorkspaceError } from '@/common/types/project-workspace/reasonCodes';
import { upsertEntry } from '@/process/commandEve/companyBrainStoreCore';
import { preflightProjectSemanticBundle } from '@/process/services/project-workspace/core/semanticBundleCore';
import type {
  PortableProjectBinding,
  ProjectBindingCasInput,
  ProjectConversationBindingClient,
} from '@/process/services/project-workspace/runtime/conversationBindingClient';
import { createProjectSemanticCoordinator } from '@/process/services/project-workspace/semantic/projectSemanticCoordinator';

type CommitConfig = {
  action: 'commit';
  state_root: string;
  hermes_home: string;
  transaction_id: string;
  conversation_id: string;
  realm_id: string;
  root_id: string;
  project_id: string;
  title: string;
  slug: string;
  marker_file?: string;
  release_file?: string;
};

type RollbackConfig = {
  action: 'rollback';
  state_root: string;
  hermes_home: string;
  transaction_id: string;
  marker_file?: string;
};

type UserUpsertConfig = {
  action: 'user-upsert';
  hermes_home: string;
  entry_id: string;
};

type Config = CommitConfig | RollbackConfig | UserUpsertConfig;

function configFromEnvironment(): Config {
  const raw = process.env.EVE_SEMANTIC_BRAIN_RACE_CONFIG;
  if (!raw) throw new Error('missing EVE_SEMANTIC_BRAIN_RACE_CONFIG');
  return JSON.parse(raw) as Config;
}

function pauseBeforeBrainIndexPublication(config: CommitConfig): void {
  if (!config.marker_file || !config.release_file) return;
  const originalRename = fs.renameSync.bind(fs);
  const brainIndex = path.join(config.hermes_home, 'company-brain', 'brain.json');
  let paused = false;
  Object.defineProperty(fs, 'renameSync', {
    configurable: true,
    writable: true,
    value: (source: fs.PathLike, destination: fs.PathLike): void => {
      if (!paused && path.resolve(String(destination)) === brainIndex) {
        paused = true;
        fs.writeFileSync(config.marker_file!, 'ready\n', 'utf8');
        const waitArray = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(config.release_file!)) Atomics.wait(waitArray, 0, 0, 10);
      }
      originalRename(source, destination);
    },
  });
}

async function commit(config: CommitConfig): Promise<void> {
  pauseBeforeBrainIndexPublication(config);
  let binding: PortableProjectBinding | null = null;
  let bindingRevision = 0;
  let bindingReceipt: string | null = null;
  const bindingClient: ProjectConversationBindingClient = {
    read: async () => ({
      binding,
      project_binding_revision: bindingRevision,
      project_binding_receipt_id: bindingReceipt,
    }),
    compareAndSwap: async (input: ProjectBindingCasInput) => {
      if (
        JSON.stringify(binding) !== JSON.stringify(input.expected) ||
        bindingRevision !== input.expected_project_binding_revision ||
        bindingReceipt !== input.expected_project_binding_receipt_id
      ) {
        throw new Error('CAS_CONFLICT');
      }
      if (JSON.stringify(binding) !== JSON.stringify(input.next)) {
        bindingRevision += 1;
        bindingReceipt = input.project_binding_operation_id;
      }
      binding = input.next;
      return {
        binding,
        project_binding_revision: bindingRevision,
        project_binding_receipt_id: bindingReceipt,
      };
    },
  };
  const coordinator = createProjectSemanticCoordinator({
    state_root: config.state_root,
    binding_client: bindingClient,
    get_active_seat_id: () => 'seat-alpha',
    resolve_hermes_home: () => config.hermes_home,
    now: () => new Date('2026-07-20T00:00:00.000Z'),
  });
  const manifest: ProjectManifestV1 = {
    schema_version: PROJECT_MANIFEST_VERSION,
    project_id: config.project_id,
    seat_id: 'seat-alpha',
    realm_id: config.realm_id,
    realm_label: 'Business',
    realm_path_slug: 'business',
    root_id: config.root_id,
    title: config.title,
    slug: config.slug,
    status: 'active',
    domain_ids: [],
    created_by: 'user',
    created_at: '2026-07-20T00:00:00.000Z',
    workspace_root_ref: `root:${config.root_id}`,
    manual_overrides: [],
  };
  const result = await preflightProjectSemanticBundle({
    operation: 'create',
    transaction_id: config.transaction_id,
    conversation_id: config.conversation_id,
    identity: {
      seat_id: 'seat-alpha',
      realm_id: config.realm_id,
      root_id: config.root_id,
      project_id: config.project_id,
      workspace_root_ref: `root:${config.root_id}`,
    },
    manifest,
    proposed_domains: [],
    coordinator,
  });
  if (!result.ok) throw new Error(result.reason_code);
  const assertMutationAllowed = (): void => undefined;
  await coordinator.stage({
    ...result.preflight_input,
    binding: result.binding,
    assert_mutation_allowed: assertMutationAllowed,
  });
  await coordinator.commit({
    operation: 'create',
    transaction_id: config.transaction_id,
    conversation_id: config.conversation_id,
    identity: result.preflight_input.identity,
    binding: result.binding,
    project_path: path.join(config.hermes_home, 'private-project-path'),
    assert_mutation_allowed: assertMutationAllowed,
  });
}

async function rollback(config: RollbackConfig): Promise<void> {
  const sidecarFile = path.join(config.state_root, 'semantic-sidecars', `${config.transaction_id}.json`);
  const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) as {
    context: {
      operation: 'create' | 'adopt';
      transaction_id: string;
      conversation_id: string;
      identity: {
        seat_id: string;
        realm_id: string;
        root_id: string;
        project_id: string;
        workspace_root_ref: `root:${string}`;
      };
    };
    binding: Parameters<ReturnType<typeof createProjectSemanticCoordinator>['rollback']>[0]['binding'];
    effects: {
      conversation_binding: {
        next: PortableProjectBinding;
        next_revision: number;
        next_receipt_id: string | null;
      };
    };
  };
  let binding: PortableProjectBinding | null = sidecar.effects.conversation_binding.next;
  let bindingRevision = sidecar.effects.conversation_binding.next_revision;
  let bindingReceipt = sidecar.effects.conversation_binding.next_receipt_id;
  const bindingClient: ProjectConversationBindingClient = {
    read: async () => ({
      binding,
      project_binding_revision: bindingRevision,
      project_binding_receipt_id: bindingReceipt,
    }),
    compareAndSwap: async (input) => {
      binding = input.next;
      if (input.next === null) {
        bindingRevision += 1;
        bindingReceipt = input.project_binding_operation_id;
      }
      return {
        binding,
        project_binding_revision: bindingRevision,
        project_binding_receipt_id: bindingReceipt,
      };
    },
  };
  const coordinator = createProjectSemanticCoordinator({
    state_root: config.state_root,
    binding_client: bindingClient,
    get_active_seat_id: () => sidecar.context.identity.seat_id,
    resolve_hermes_home: () => config.hermes_home,
  });
  if (config.marker_file) fs.writeFileSync(config.marker_file, 'ready\n', 'utf8');
  await coordinator.rollback({
    operation: sidecar.context.operation,
    transaction_id: sidecar.context.transaction_id,
    conversation_id: sidecar.context.conversation_id,
    identity: sidecar.context.identity,
    binding: sidecar.binding,
    project_path: path.join(config.hermes_home, 'private-project-path'),
    assert_mutation_allowed: () => undefined,
  });
}

function userUpsert(config: UserUpsertConfig): { ok: true } | { ok: false; reason_code: string } {
  try {
    upsertEntry(config.hermes_home, {
      id: config.entry_id,
      kind: 'note',
      title: 'User note',
      body: 'normal user write',
      author: 'user',
      source: 'settings',
      now: () => new Date('2026-07-20T00:01:00.000Z'),
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof ProjectWorkspaceError) return { ok: false, reason_code: error.reason_code };
    throw error;
  }
}

const config = configFromEnvironment();
let result: { ok: true } | { ok: false; reason_code: string } = { ok: true };
if (config.action === 'commit') await commit(config);
else if (config.action === 'rollback') await rollback(config);
else result = userUpsert(config);
await new Promise<void>((resolve, reject) => {
  process.stdout.write(`EVE_SEMANTIC_BRAIN_RACE_RESULT=${JSON.stringify(result)}\n`, (error) => {
    if (error) reject(error);
    else resolve();
  });
});
// This fixture imports the real desktop storage graph, which keeps a Bun handle
// alive after the one-shot worker has completed. The parent contract waits for
// process exit (not merely stdout), so terminate only after the JSON receipt is
// flushed. Without this, every race test leaked orphan workers indefinitely.
process.exit(0);
