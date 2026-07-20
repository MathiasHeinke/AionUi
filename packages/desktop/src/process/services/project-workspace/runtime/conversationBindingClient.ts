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

async function parseResponse(response: Response): Promise<ProjectBindingSnapshot> {
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
  const conversation = unwrapConversation(body);
  return {
    binding: bindingFromExtra(conversation.extra),
    project_binding_revision: revisionFromExtra(conversation.extra),
    project_binding_receipt_id: receiptFromExtra(conversation.extra),
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
}): ProjectConversationBindingClient {
  const fetchImpl = input.fetch_impl ?? globalThis.fetch.bind(globalThis);
  const url = (conversationId: string): string => {
    const port = input.get_port();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ProjectBindingClientError('PROJECT_RUNTIME_BACKEND_UNAVAILABLE');
    }
    return `http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(assertConversationId(conversationId))}`;
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
  };
}
