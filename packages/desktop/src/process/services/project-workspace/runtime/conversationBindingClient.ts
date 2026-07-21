import { parseProjectId, parseWorkspaceRootRef } from '@/common/types/project-workspace/identity';

export type PortableProjectBinding = {
  project_id: string;
  workspace_root_ref: `root:${string}`;
};

export type ProjectBindingSnapshot = {
  binding: PortableProjectBinding | null;
  project_binding_revision: number;
  project_binding_receipt_id: string | null;
};

export type ProjectBindingCasInput = {
  conversation_id: string;
  expected: PortableProjectBinding | null;
  expected_project_binding_revision: number;
  expected_project_binding_receipt_id: string | null;
  project_binding_operation_id: string;
  next: PortableProjectBinding | null;
};

export type ProjectConversationBindingClient = {
  read: (conversationId: string) => Promise<ProjectBindingSnapshot>;
  compareAndSwap: (input: ProjectBindingCasInput) => Promise<ProjectBindingSnapshot>;
};

export type ProjectConversationMetadataClient = ProjectConversationBindingClient & {
  readMetadata: (conversationId: string) => Promise<ProjectConversationMetadata>;
  listMetadata: () => Promise<ProjectConversationMetadata[]>;
};

export type ProjectConversationMetadata = ProjectBindingSnapshot & {
  conversation_id: string;
  name: string;
};

export class ProjectBindingClientError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ProjectBindingClientError';
    this.code = code;
  }
}

function assertConversationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value)) {
    throw new ProjectBindingClientError('PROJECT_BINDING_CONVERSATION_INVALID');
  }
  return value;
}

function normalizeBinding(value: PortableProjectBinding): PortableProjectBinding {
  return {
    project_id: parseProjectId(value.project_id),
    workspace_root_ref: parseWorkspaceRootRef(value.workspace_root_ref),
  };
}

function bindingFromExtra(extra: unknown): PortableProjectBinding | null {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
  const record = extra as Record<string, unknown>;
  const projectId = record.project_id;
  const workspaceRootRef = record.workspace_root_ref;
  if (projectId === undefined && workspaceRootRef === undefined) return null;
  if (projectId === null && workspaceRootRef === null) return null;
  if (typeof projectId !== 'string' || typeof workspaceRootRef !== 'string') {
    throw new ProjectBindingClientError('PROJECT_BINDING_INVALID');
  }
  try {
    return normalizeBinding({ project_id: projectId, workspace_root_ref: workspaceRootRef as `root:${string}` });
  } catch {
    throw new ProjectBindingClientError('PROJECT_BINDING_INVALID');
  }
}

function revisionFromExtra(extra: unknown): number {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return 0;
  const revision = (extra as Record<string, unknown>).project_binding_revision;
  if (revision === undefined) return 0;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new ProjectBindingClientError('PROJECT_BINDING_REVISION_INVALID');
  }
  return revision;
}

function validReceiptId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function receiptFromExtra(extra: unknown): string | null {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
  const receipt = (extra as Record<string, unknown>).project_binding_receipt_id;
  if (receipt === undefined || receipt === null) return null;
  if (!validReceiptId(receipt)) {
    throw new ProjectBindingClientError('PROJECT_BINDING_RECEIPT_INVALID');
  }
  return receipt;
}

function unwrapConversation(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_INVALID');
  }
  const envelope = body as Record<string, unknown>;
  const candidate = Object.hasOwn(envelope, 'data') ? envelope.data : envelope;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_INVALID');
  }
  return candidate as Record<string, unknown>;
}

async function responseBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_INVALID');
  }
  if (!response.ok) {
    const code =
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      typeof (body as Record<string, unknown>).code === 'string'
        ? ((body as Record<string, unknown>).code as string)
        : 'PROJECT_BINDING_REQUEST_FAILED';
    throw new ProjectBindingClientError(code);
  }
  return body;
}

function snapshotFromConversation(conversation: Record<string, unknown>): ProjectBindingSnapshot {
  return {
    binding: bindingFromExtra(conversation.extra),
    project_binding_revision: revisionFromExtra(conversation.extra),
    project_binding_receipt_id: receiptFromExtra(conversation.extra),
  };
}

function metadataFromConversation(conversation: Record<string, unknown>): ProjectConversationMetadata {
  if (
    typeof conversation.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(conversation.id) ||
    typeof conversation.name !== 'string' ||
    !conversation.name.trim() ||
    conversation.name.length > 200
  ) {
    throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_INVALID');
  }
  return {
    conversation_id: conversation.id,
    name: conversation.name.trim(),
    ...snapshotFromConversation(conversation),
  };
}

async function parseMetadataResponse(response: Response): Promise<ProjectConversationMetadata> {
  return metadataFromConversation(unwrapConversation(await responseBody(response)));
}

async function parseResponse(response: Response): Promise<ProjectBindingSnapshot> {
  return snapshotFromConversation(unwrapConversation(await responseBody(response)));
}

/**
 * Best-effort extraction of a raw list item's conversation id for pagination.
 * Independent of the strict per-item metadata validation: an item can be
 * malformed for enrichment (empty name, bad binding) yet still carry a usable
 * id that lets the cursor advance past it.
 */
function rawConversationId(value: unknown): string | undefined {
  try {
    const record = unwrapConversation(value);
    return typeof record.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(record.id)
      ? record.id
      : undefined;
  } catch {
    return undefined;
  }
}

async function parseListResponse(response: Response): Promise<{
  items: ProjectConversationMetadata[];
  has_more: boolean;
  next_cursor?: string;
}> {
  const body = await responseBody(response);
  const envelope = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const candidate = envelope && Object.hasOwn(envelope, 'data') ? envelope.data : envelope;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_INVALID');
  }
  const page = candidate as Record<string, unknown>;
  if (!Array.isArray(page.items) || typeof page.has_more !== 'boolean') {
    throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_INVALID');
  }
  // Per-item tolerance (1.818 CAO-P2): a single malformed conversation record
  // (e.g. a legacy row with an empty or overlong name) must not zero the
  // whole metadata enrichment — skip it and keep the valid items. The page
  // envelope itself stays fail-closed (PROJECT_BINDING_RESPONSE_INVALID).
  const items: ProjectConversationMetadata[] = [];
  for (const raw of page.items) {
    try {
      items.push(metadataFromConversation(unwrapConversation(raw)));
    } catch (error) {
      console.warn('[ProjectBinding] listMetadata: skipping malformed conversation record', error);
    }
  }
  // The pagination cursor comes from the RAW last item, not the last parsed
  // one — otherwise a trailing malformed record would silently re-page or
  // strand the cursor. No usable id on the boundary record → fail closed.
  const nextCursor = page.has_more ? rawConversationId(page.items.at(-1)) : undefined;
  if (page.has_more && !nextCursor) {
    throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_INVALID');
  }
  return {
    items,
    has_more: page.has_more,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
  };
}

function expectation(
  binding: PortableProjectBinding | null,
  revision: number,
  receiptId: string | null
): {
  project_id: string | null;
  workspace_root_ref: string | null;
  project_binding_revision: number;
  project_binding_receipt_id: string | null;
} {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new ProjectBindingClientError('PROJECT_BINDING_REVISION_INVALID');
  }
  if (receiptId !== null && !validReceiptId(receiptId)) {
    throw new ProjectBindingClientError('PROJECT_BINDING_RECEIPT_INVALID');
  }
  return binding
    ? {
        project_id: binding.project_id,
        workspace_root_ref: binding.workspace_root_ref,
        project_binding_revision: revision,
        project_binding_receipt_id: receiptId,
      }
    : {
        project_id: null,
        workspace_root_ref: null,
        project_binding_revision: revision,
        project_binding_receipt_id: receiptId,
      };
}

export function createAionCoreProjectBindingClient(input: {
  get_port: () => number;
  fetch_impl?: typeof globalThis.fetch;
}): ProjectConversationMetadataClient {
  const fetchImpl = input.fetch_impl ?? globalThis.fetch.bind(globalThis);
  const url = (conversationId: string): string => {
    const port = input.get_port();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ProjectBindingClientError('PROJECT_RUNTIME_BACKEND_UNAVAILABLE');
    }
    return `http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(assertConversationId(conversationId))}`;
  };
  const listUrl = (cursor?: string): string => {
    const port = input.get_port();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ProjectBindingClientError('PROJECT_RUNTIME_BACKEND_UNAVAILABLE');
    }
    const query = new URLSearchParams({ limit: '200' });
    if (cursor) query.set('cursor', assertConversationId(cursor));
    return `http://127.0.0.1:${port}/api/conversations?${query.toString()}`;
  };
  return {
    read: async (conversationId) =>
      parseResponse(await fetchImpl(url(conversationId), { method: 'GET', redirect: 'error' })),
    compareAndSwap: async ({
      conversation_id,
      expected,
      expected_project_binding_revision,
      expected_project_binding_receipt_id,
      project_binding_operation_id,
      next,
    }) => {
      const normalizedExpected = expected ? normalizeBinding(expected) : null;
      const normalizedNext = next ? normalizeBinding(next) : null;
      if (!validReceiptId(project_binding_operation_id)) {
        throw new ProjectBindingClientError('PROJECT_BINDING_OPERATION_INVALID');
      }
      const pairChanges = JSON.stringify(normalizedExpected) !== JSON.stringify(normalizedNext);
      if (pairChanges && expected_project_binding_revision === Number.MAX_SAFE_INTEGER) {
        throw new ProjectBindingClientError('PROJECT_BINDING_REVISION_OVERFLOW');
      }
      const response = await fetchImpl(url(conversation_id), {
        method: 'PATCH',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          extra: normalizedNext
            ? {
                project_id: normalizedNext.project_id,
                workspace_root_ref: normalizedNext.workspace_root_ref,
              }
            : { project_id: null, workspace_root_ref: null },
          expected_project_binding: expectation(
            normalizedExpected,
            expected_project_binding_revision,
            expected_project_binding_receipt_id
          ),
          project_binding_operation_id,
        }),
      });
      const snapshot = await parseResponse(response);
      const expectedRevision = expected_project_binding_revision + (pairChanges ? 1 : 0);
      const expectedReceipt = pairChanges ? project_binding_operation_id : expected_project_binding_receipt_id;
      if (
        JSON.stringify(snapshot.binding) !== JSON.stringify(normalizedNext) ||
        snapshot.project_binding_revision !== expectedRevision ||
        snapshot.project_binding_receipt_id !== expectedReceipt
      ) {
        throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_MISMATCH');
      }
      return snapshot;
    },
    readMetadata: async (conversationId) => {
      const expected = assertConversationId(conversationId);
      const metadata = await parseMetadataResponse(
        await fetchImpl(url(expected), { method: 'GET', redirect: 'error' })
      );
      if (metadata.conversation_id !== expected) {
        throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_MISMATCH');
      }
      return metadata;
    },
    listMetadata: async () => {
      const all: ProjectConversationMetadata[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
        const page = await parseListResponse(await fetchImpl(listUrl(cursor), { method: 'GET', redirect: 'error' }));
        all.push(...page.items);
        if (!page.has_more) return all;
        if (!page.next_cursor || page.next_cursor === cursor) {
          throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_INVALID');
        }
        cursor = page.next_cursor;
      }
      throw new ProjectBindingClientError('PROJECT_BINDING_RESPONSE_INVALID');
    },
  };
}
