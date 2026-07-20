/**
 * @vitest-environment node
 */

import { conversation, projectWorkspaceRuntime } from '@/common/adapter/ipcBridge';
import { BackendHttpError } from '@/common/adapter/httpBridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backendPort = 18_817;

const jsonResponse = (data: unknown): Response =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const bindingRequiredResponse = (
  code = 'BAD_REQUEST',
  error = 'PROJECT_RUNTIME_BINDING_REQUIRED',
  status = 400
): Response =>
  new Response(JSON.stringify({ success: false, error, code }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('project runtime renderer fallback', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = backendPort;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps an unbound send on the byte-compatible direct HTTP path', async () => {
    const directResult = { msg_id: 'message-1', turn_id: 'turn-1', runtime: {} };
    const fetchMock = vi.mocked(fetch).mockResolvedValue(jsonResponse(directResult));
    const main = vi.spyOn(projectWorkspaceRuntime.send, 'invoke');

    await expect(
      conversation.sendMessage.invoke({
        conversation_id: 'conversation-1',
        input: 'hello',
        files: ['note.txt'],
        loading_id: 'loading-1',
        inject_skills: ['skill-a'],
      })
    ).resolves.toEqual(directResult);

    expect(main).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:${backendPort}/api/conversations/conversation-1/messages`);
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toBe(
      '{"content":"hello","files":["note.txt"],"loading_id":"loading-1","inject_skills":["skill-a"]}'
    );
  });

  it('keeps an unbound warmup on the byte-compatible direct HTTP path', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const main = vi.spyOn(projectWorkspaceRuntime.warmup, 'invoke');

    await expect(conversation.warmup.invoke({ conversation_id: 'conversation-1' })).resolves.toBeUndefined();

    expect(main).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://127.0.0.1:${backendPort}/api/conversations/conversation-1/warmup`);
    expect(init?.method).toBe('POST');
    expect(String(init?.body)).toBe('{"conversation_id":"conversation-1"}');
  });

  it('falls back to Main only for the exact typed binding-required response', async () => {
    vi.mocked(fetch).mockResolvedValue(bindingRequiredResponse());
    const mainResult = { msg_id: 'message-2', turn_id: 'turn-2', runtime: {} };
    const main = vi.spyOn(projectWorkspaceRuntime.send, 'invoke').mockResolvedValue(mainResult as never);
    const params = { conversation_id: 'conversation-2', input: 'project turn' };

    await expect(conversation.sendMessage.invoke(params)).resolves.toEqual(mainResult);
    expect(main).toHaveBeenCalledOnce();
    expect(main).toHaveBeenCalledWith(params);
  });

  it('also accepts the future structured binding-required code only at status 400', async () => {
    vi.mocked(fetch).mockResolvedValue(bindingRequiredResponse('PROJECT_RUNTIME_BINDING_REQUIRED'));
    const mainResult = { msg_id: 'message-structured', turn_id: 'turn-structured', runtime: {} };
    const main = vi.spyOn(projectWorkspaceRuntime.send, 'invoke').mockResolvedValue(mainResult as never);

    await expect(
      conversation.sendMessage.invoke({ conversation_id: 'conversation-structured', input: 'project turn' })
    ).resolves.toEqual(mainResult);
    expect(main).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 409, 500])('never switches lanes for binding-required code at HTTP %s', async (status) => {
    vi.mocked(fetch).mockResolvedValue(bindingRequiredResponse('PROJECT_RUNTIME_BINDING_REQUIRED', undefined, status));
    const main = vi.spyOn(projectWorkspaceRuntime.send, 'invoke');

    await expect(
      conversation.sendMessage.invoke({ conversation_id: `conversation-${status}`, input: 'blocked' })
    ).rejects.toBeInstanceOf(BackendHttpError);
    expect(main).not.toHaveBeenCalled();
  });

  it('does not fall back for any other backend error code', async () => {
    vi.mocked(fetch).mockResolvedValue(bindingRequiredResponse('BAD_REQUEST', 'CONVERSATION_ARCHIVED'));
    const main = vi.spyOn(projectWorkspaceRuntime.send, 'invoke');

    const failure = conversation.sendMessage.invoke({ conversation_id: 'conversation-3', input: 'blocked' });
    await expect(failure).rejects.toBeInstanceOf(BackendHttpError);
    await expect(failure).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(main).not.toHaveBeenCalled();
  });

  it('fails immediately in WebUI instead of invoking an unavailable Main provider', async () => {
    Reflect.set(globalThis, 'window', {});
    Reflect.set(globalThis, 'document', {});
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'PROJECT_RUNTIME_BINDING_REQUIRED',
          code: 'BAD_REQUEST',
          details: { path: '/private/project/path must not escape through the fallback error' },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const main = vi.spyOn(projectWorkspaceRuntime.warmup, 'invoke');

    const failure = conversation.warmup.invoke({ conversation_id: 'conversation-4' });
    await expect(failure).rejects.toThrow('PROJECT_RUNTIME_ATTESTATION_UNAVAILABLE');
    try {
      await failure;
    } catch (error) {
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('/private/project/path');
    }
    expect(main).not.toHaveBeenCalled();
  });
});
