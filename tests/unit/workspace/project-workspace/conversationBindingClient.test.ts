import { vi } from 'vitest';
import {
  createAionCoreProjectBindingClient,
  type ProjectBindingClientError,
} from '@process/services/project-workspace/runtime/conversationBindingClient';

const A = {
  project_id: '11111111-1111-4111-8111-111111111111',
  workspace_root_ref: 'root:22222222-2222-4222-8222-222222222222' as const,
};
const B = {
  project_id: '33333333-3333-4333-8333-333333333333',
  workspace_root_ref: 'root:44444444-4444-4444-8444-444444444444' as const,
};
const RECEIPT_A = '55555555-5555-4555-8555-555555555555';
const OPERATION = '66666666-6666-4666-8666-666666666666';

describe('AionCore project conversation binding CAS client', () => {
  it('reads the portable pair and sends an exact expected-pair CAS without any path', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: 'conversation-a',
              extra: { ...A, project_binding_revision: 7, project_binding_receipt_id: RECEIPT_A, unrelated: true },
            },
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: 'conversation-a',
              extra: { ...B, project_binding_revision: 8, project_binding_receipt_id: OPERATION, unrelated: true },
            },
          }),
          { status: 200 }
        )
      );
    const client = createAionCoreProjectBindingClient({ get_port: () => 43123, fetch_impl: fetchImpl });
    expect(await client.read('conversation-a')).toEqual({
      binding: A,
      project_binding_revision: 7,
      project_binding_receipt_id: RECEIPT_A,
    });
    expect(
      await client.compareAndSwap({
        conversation_id: 'conversation-a',
        expected: A,
        expected_project_binding_revision: 7,
        expected_project_binding_receipt_id: RECEIPT_A,
        project_binding_operation_id: OPERATION,
        next: B,
      })
    ).toEqual({ binding: B, project_binding_revision: 8, project_binding_receipt_id: OPERATION });

    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('http://127.0.0.1:43123/api/conversations/conversation-a');
    expect(init?.method).toBe('PATCH');
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      extra: B,
      expected_project_binding: {
        ...A,
        project_binding_revision: 7,
        project_binding_receipt_id: RECEIPT_A,
      },
      project_binding_operation_id: OPERATION,
    });
    expect(JSON.stringify(body)).not.toContain('path');
  });

  it('unbinds only with the expected pair and propagates stale/foreign CAS failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'PROJECT_BINDING_CAS_MISMATCH' }), { status: 409 }));
    const client = createAionCoreProjectBindingClient({ get_port: () => 43123, fetch_impl: fetchImpl });
    await expect(
      client.compareAndSwap({
        conversation_id: 'conversation-a',
        expected: A,
        expected_project_binding_revision: 4,
        expected_project_binding_receipt_id: RECEIPT_A,
        project_binding_operation_id: OPERATION,
        next: null,
      })
    ).rejects.toMatchObject<ProjectBindingClientError>({ code: 'PROJECT_BINDING_CAS_MISMATCH' });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      extra: { project_id: null, workspace_root_ref: null },
      expected_project_binding: {
        ...A,
        project_binding_revision: 4,
        project_binding_receipt_id: RECEIPT_A,
      },
      project_binding_operation_id: OPERATION,
    });
  });

  it('accepts both missing and exact null-pair unbound echoes', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { extra: {} } }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              extra: {
                project_id: null,
                workspace_root_ref: null,
                project_binding_revision: 6,
                project_binding_receipt_id: OPERATION,
              },
            },
          }),
          { status: 200 }
        )
      );
    const client = createAionCoreProjectBindingClient({ get_port: () => 43123, fetch_impl: fetchImpl });

    await expect(client.read('conversation-a')).resolves.toEqual({
      binding: null,
      project_binding_revision: 0,
      project_binding_receipt_id: null,
    });
    await expect(
      client.compareAndSwap({
        conversation_id: 'conversation-a',
        expected: A,
        expected_project_binding_revision: 5,
        expected_project_binding_receipt_id: RECEIPT_A,
        project_binding_operation_id: OPERATION,
        next: null,
      })
    ).resolves.toEqual({ binding: null, project_binding_revision: 6, project_binding_receipt_id: OPERATION });
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      extra: { project_id: null, workspace_root_ref: null },
      expected_project_binding: {
        ...A,
        project_binding_revision: 5,
        project_binding_receipt_id: RECEIPT_A,
      },
      project_binding_operation_id: OPERATION,
    });
  });

  it('preserves the monotone revision for an idempotent same-pair CAS', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { extra: { ...A, project_binding_revision: 7, project_binding_receipt_id: RECEIPT_A } },
        }),
        { status: 200 }
      )
    );
    const client = createAionCoreProjectBindingClient({ get_port: () => 43123, fetch_impl: fetchImpl });

    await expect(
      client.compareAndSwap({
        conversation_id: 'conversation-a',
        expected: A,
        expected_project_binding_revision: 7,
        expected_project_binding_receipt_id: RECEIPT_A,
        project_binding_operation_id: OPERATION,
        next: A,
      })
    ).resolves.toEqual({ binding: A, project_binding_revision: 7, project_binding_receipt_id: RECEIPT_A });
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual({
      extra: A,
      expected_project_binding: {
        ...A,
        project_binding_revision: 7,
        project_binding_receipt_id: RECEIPT_A,
      },
      project_binding_operation_id: OPERATION,
    });
  });

  it('rejects a changing CAS at revision overflow before any request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createAionCoreProjectBindingClient({ get_port: () => 43123, fetch_impl: fetchImpl });

    await expect(
      client.compareAndSwap({
        conversation_id: 'conversation-a',
        expected: A,
        expected_project_binding_revision: Number.MAX_SAFE_INTEGER,
        expected_project_binding_receipt_id: RECEIPT_A,
        project_binding_operation_id: OPERATION,
        next: B,
      })
    ).rejects.toMatchObject<ProjectBindingClientError>({ code: 'PROJECT_BINDING_REVISION_OVERFLOW' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when AionCore acknowledges a different pair or a partial binding', async () => {
    const mismatchFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ data: { extra: A } }), { status: 200 }));
    const mismatchClient = createAionCoreProjectBindingClient({ get_port: () => 43123, fetch_impl: mismatchFetch });
    await expect(
      mismatchClient.compareAndSwap({
        conversation_id: 'conversation-a',
        expected: A,
        expected_project_binding_revision: 0,
        expected_project_binding_receipt_id: null,
        project_binding_operation_id: OPERATION,
        next: B,
      })
    ).rejects.toMatchObject<ProjectBindingClientError>({ code: 'PROJECT_BINDING_RESPONSE_MISMATCH' });

    const partialClient = createAionCoreProjectBindingClient({
      get_port: () => 43123,
      fetch_impl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ data: { extra: { project_id: A.project_id } } }), { status: 200 })
        ),
    });
    await expect(partialClient.read('conversation-a')).rejects.toMatchObject<ProjectBindingClientError>({
      code: 'PROJECT_BINDING_INVALID',
    });

    await Promise.all(
      [
        { project_id: null, workspace_root_ref: A.workspace_root_ref },
        { project_id: A.project_id, workspace_root_ref: null },
      ].map(async (extra) => {
        const mixedNullClient = createAionCoreProjectBindingClient({
          get_port: () => 43123,
          fetch_impl: vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response(JSON.stringify({ data: { extra } }), { status: 200 })),
        });
        await expect(mixedNullClient.read('conversation-a')).rejects.toMatchObject<ProjectBindingClientError>({
          code: 'PROJECT_BINDING_INVALID',
        });
      })
    );
  });

  it('rejects an exact-revision same-target response carrying a different operation receipt', async () => {
    const foreignReceipt = '99999999-9999-4999-8999-999999999999';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            extra: { ...B, project_binding_revision: 8, project_binding_receipt_id: foreignReceipt },
          },
        }),
        { status: 200 }
      )
    );
    const client = createAionCoreProjectBindingClient({ get_port: () => 43123, fetch_impl: fetchImpl });

    await expect(
      client.compareAndSwap({
        conversation_id: 'conversation-a',
        expected: A,
        expected_project_binding_revision: 7,
        expected_project_binding_receipt_id: RECEIPT_A,
        project_binding_operation_id: OPERATION,
        next: B,
      })
    ).rejects.toMatchObject<ProjectBindingClientError>({ code: 'PROJECT_BINDING_RESPONSE_MISMATCH' });
  });

  it('fails closed on malformed or unsafe project binding revisions', async () => {
    await Promise.all(
      [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(async (project_binding_revision) => {
        const client = createAionCoreProjectBindingClient({
          get_port: () => 43123,
          fetch_impl: vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              new Response(JSON.stringify({ data: { extra: { ...A, project_binding_revision } } }), { status: 200 })
            ),
        });
        await expect(client.read('conversation-a')).rejects.toMatchObject<ProjectBindingClientError>({
          code: 'PROJECT_BINDING_REVISION_INVALID',
        });
      })
    );
  });

  it('rejects non-v4, uppercase, or path-bearing binding receipts', async () => {
    await Promise.all(
      [
        'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        '77777777-7777-7777-8777-777777777777',
        '../77777777-7777-4777-8777-777777777777',
      ].map(async (project_binding_receipt_id) => {
        const client = createAionCoreProjectBindingClient({
          get_port: () => 43123,
          fetch_impl: vi.fn<typeof fetch>().mockResolvedValue(
            new Response(
              JSON.stringify({
                data: { extra: { ...A, project_binding_revision: 7, project_binding_receipt_id } },
              }),
              { status: 200 }
            )
          ),
        });
        await expect(client.read('conversation-a')).rejects.toMatchObject<ProjectBindingClientError>({
          code: 'PROJECT_BINDING_RECEIPT_INVALID',
        });
      })
    );
  });

  it('rejects a non-canonical operation id before any request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createAionCoreProjectBindingClient({ get_port: () => 43123, fetch_impl: fetchImpl });
    await expect(
      client.compareAndSwap({
        conversation_id: 'conversation-a',
        expected: A,
        expected_project_binding_revision: 7,
        expected_project_binding_receipt_id: RECEIPT_A,
        project_binding_operation_id: '77777777-7777-7777-8777-777777777777',
        next: B,
      })
    ).rejects.toMatchObject<ProjectBindingClientError>({ code: 'PROJECT_BINDING_OPERATION_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
