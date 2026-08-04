import { describe, expect, it, vi } from 'vitest';
import type { ProjectConversationMetadataClient } from '@process/services/project-workspace/runtime/conversationBindingClient';
import {
  createAutoProjectCompletionCoordinator,
  deriveTitleSource,
  parseSuccessfulTurnCompletion,
  runAutoProjectAfterCompletion,
} from '@process/services/project-workspace/runtime/autoProjectTurnCompletionRelay';

const successfulTurn = () => ({
  session_id: 'conv-1',
  turn_id: 'turn-1',
  status: 'finished',
  state: 'ai_waiting_input',
  can_send_message: true,
  has_substantive_output: true,
  runtime: {
    state: 'idle',
    can_send_message: true,
    has_task: false,
    is_processing: false,
    pending_confirmations: 0,
    turn_id: 'turn-1',
  },
  last_message: { content: { content: 'Gern, ich erstelle den Releaseplan.' }, created_at: 1 },
});

const metadata = (name: string) => ({
  conversation_id: 'conv-1',
  name,
  conversation_type: 'acp',
  backend: 'hermes',
  is_temporary_workspace: true,
  custom_workspace: false,
  binding: null,
  project_binding_revision: 0,
  project_binding_receipt_id: null,
});

const messagesResponse = () =>
  new Response(
    JSON.stringify({
      data: {
        items: [
          { type: 'text', position: 'right', content: { content: 'Hallo' } },
          {
            type: 'text',
            position: 'right',
            content: { content: 'Bitte baue den notarisierten Release und lade ihn auf R2.' },
          },
          { type: 'text', position: 'left', content: { content: 'Ich prüfe zuerst die Release-Gates.' } },
        ],
      },
    }),
    { status: 200 }
  );

function bindingClient(names: string[]): ProjectConversationMetadataClient {
  let index = 0;
  return {
    read: vi.fn(),
    compareAndSwap: vi.fn(),
    listMetadata: vi.fn(),
    readMetadata: vi.fn(async () => metadata(names[Math.min(index++, names.length - 1)])),
  } as unknown as ProjectConversationMetadataClient;
}

describe('Main-owned auto-project completion relay', () => {
  it('accepts only explicit, substantive, sendable successful completion evidence', () => {
    expect(parseSuccessfulTurnCompletion(successfulTurn())).toMatchObject({
      conversation_id: 'conv-1',
      turn_id: 'turn-1',
    });
    expect(parseSuccessfulTurnCompletion({ ...successfulTurn(), has_substantive_output: false })).toBeNull();
    expect(parseSuccessfulTurnCompletion({ ...successfulTurn(), state: 'error' })).toBeNull();
    expect(
      parseSuccessfulTurnCompletion({
        ...successfulTurn(),
        runtime: { ...successfulTurn().runtime, is_processing: true },
      })
    ).toBeNull();
  });

  it('skips greeting-only turns and derives a bounded first substantive exchange', () => {
    const source = deriveTitleSource(
      [
        { type: 'text', position: 'right', content: { content: 'Moin' } },
        { type: 'text', position: 'right', content: { content: 'Baue den Release' } },
        { type: 'text', position: 'left', content: { content: 'Mache ich.' } },
      ],
      ''
    );
    expect(source).toEqual({
      first_user_text: 'Baue den Release',
      text: 'User: Baue den Release\n\nEVE: Mache ich.',
    });
  });

  it('names through the DeepSeek gateway, persists the session title, then creates the identical project', async () => {
    const client = bindingClient([
      'Bitte baue den notarisierten Release und lade ihn auf R2.',
      'Release notarisiert ausliefern',
    ]);
    const ensure = vi.fn().mockResolvedValue({
      status: 'created',
      project_id: 'project-1',
      project_title: 'Release notarisiert ausliefern',
    });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/messages?')) return messagesResponse();
      if (url.endsWith('/eve-title')) {
        const body = JSON.parse(String(init?.body)) as { text: string; locale: string };
        expect(body.text).toContain('Bitte baue den notarisierten Release');
        expect(body.locale).toBe('de-DE');
        return new Response(JSON.stringify({ ok: true, title: 'Release notarisiert ausliefern' }), { status: 200 });
      }
      if (init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({ name: 'Release notarisiert ausliefern' });
        return new Response(JSON.stringify({ data: true }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(
      runAutoProjectAfterCompletion(successfulTurn(), {
        binding_client: client,
        fetch_impl: fetchImpl as typeof globalThis.fetch,
        get_port: () => 4173,
        read_license: () => 'signed-license-wire',
        ensure_after_successful_turn: ensure,
        title_function_url: 'https://example.test/eve-title',
      })
    ).resolves.toEqual({
      status: 'completed',
      result: { status: 'created', project_id: 'project-1', project_title: 'Release notarisiert ausliefern' },
    });
    expect(ensure).toHaveBeenCalledWith({ conversation_id: 'conv-1', turn_id: 'turn-1' });
  });

  it('fails closed without a DeepSeek title and never creates a prompt-named folder', async () => {
    const ensure = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/messages?')
        ? messagesResponse()
        : new Response(JSON.stringify({ ok: false, error: 'provider_timeout' }), { status: 504 })
    );
    await expect(
      runAutoProjectAfterCompletion(successfulTurn(), {
        binding_client: bindingClient(['Bitte baue den notarisierten Release und lade ihn auf R2.']),
        fetch_impl: fetchImpl as typeof globalThis.fetch,
        get_port: () => 4173,
        read_license: () => 'signed-license-wire',
        ensure_after_successful_turn: ensure,
        title_function_url: 'https://example.test/eve-title',
      })
    ).resolves.toEqual({ status: 'retryable', reason: 'deepseek-title-unavailable' });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('preserves a deliberate short manual title and does not call the title gateway', async () => {
    const ensure = vi.fn().mockResolvedValue({ status: 'created', project_title: 'Alois Relaunch' });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/messages?')) return messagesResponse();
      throw new Error('The model gateway must not run for a manual title.');
    });
    const outcome = await runAutoProjectAfterCompletion(successfulTurn(), {
      binding_client: bindingClient(['Alois Relaunch']),
      fetch_impl: fetchImpl as typeof globalThis.fetch,
      get_port: () => 4173,
      read_license: () => 'signed-license-wire',
      ensure_after_successful_turn: ensure,
      title_function_url: 'https://example.test/eve-title',
    });
    expect(outcome.status).toBe('completed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('deduplicates replayed completion events independently of any mounted renderer', async () => {
    const ensure = vi.fn().mockResolvedValue({ status: 'created', project_title: 'Alois Relaunch' });
    const coordinator = createAutoProjectCompletionCoordinator({
      binding_client: bindingClient(['Alois Relaunch']),
      fetch_impl: vi.fn(async () => messagesResponse()) as unknown as typeof globalThis.fetch,
      get_port: () => 4173,
      read_license: () => 'signed-license-wire',
      ensure_after_successful_turn: ensure,
      title_function_url: 'https://example.test/eve-title',
    });
    await coordinator.handle(successfulTurn());
    await expect(coordinator.handle(successfulTurn())).resolves.toEqual({
      status: 'ignored',
      reason: 'duplicate-turn',
    });
    expect(ensure).toHaveBeenCalledTimes(1);
  });
});
