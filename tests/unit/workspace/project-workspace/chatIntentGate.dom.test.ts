const mocks = vi.hoisted(() => ({
  chatIntentInvoke: vi.fn(),
  messageInfo: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    projectWorkspace: {
      chatIntent: { invoke: mocks.chatIntentInvoke },
    },
  },
}));

vi.mock('@arco-design/web-react', () => ({
  Message: { info: mocks.messageInfo },
}));

import { runProjectChatIntentGate } from '@/renderer/pages/conversation/shared/projectChatIntentGate';

describe('runProjectChatIntentGate (S81 R3)', () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.chatIntentInvoke.mockReset();
    mocks.messageInfo.mockReset();
    (window as unknown as { electronAPI?: unknown }).electronAPI = {};
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('resolves without Message.info on a fast pass_through', async () => {
    mocks.chatIntentInvoke.mockResolvedValue({ decision: 'pass_through' });

    await runProjectChatIntentGate({ conversation_id: 'conv-1', message: 'hallo welt' });

    expect(mocks.chatIntentInvoke).toHaveBeenCalledTimes(1);
    expect(mocks.chatIntentInvoke).toHaveBeenCalledWith({
      conversation_id: 'conv-1',
      input: 'hallo welt',
      seat_context_revision: 0,
      idempotency_key: expect.any(String),
      deadline_ms: expect.any(Number),
    });
    expect(mocks.messageInfo).not.toHaveBeenCalled();
  });

  it('shows Message.info with the clarification question', async () => {
    mocks.chatIntentInvoke.mockResolvedValue({ decision: 'needs_clarification', question: 'Welches Projekt?' });

    await runProjectChatIntentGate({ conversation_id: 'conv-1', message: 'atlas status' });

    expect(mocks.messageInfo).toHaveBeenCalledWith('Welches Projekt?');
  });

  it('resolves within the 250ms budget when invoke hangs', async () => {
    mocks.chatIntentInvoke.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ decision: 'pass_through' }), 5_000))
    );

    const startedAt = Date.now();
    await runProjectChatIntentGate({ conversation_id: 'conv-1', message: 'haengt' });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(350);
    expect(mocks.messageInfo).not.toHaveBeenCalled();
  });

  it('resolves without throwing when invoke rejects', async () => {
    mocks.chatIntentInvoke.mockRejectedValue(new Error('bridge boom'));

    await expect(runProjectChatIntentGate({ conversation_id: 'conv-1', message: 'fehler' })).resolves.toBeUndefined();
    expect(mocks.messageInfo).not.toHaveBeenCalled();
  });

  it('skips the bridge entirely for empty messages or missing electronAPI', async () => {
    await runProjectChatIntentGate({ conversation_id: 'conv-1', message: '   ' });
    expect(mocks.chatIntentInvoke).not.toHaveBeenCalled();

    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    await runProjectChatIntentGate({ conversation_id: 'conv-1', message: 'hallo' });
    expect(mocks.chatIntentInvoke).not.toHaveBeenCalled();
  });

  it('resolves a question_i18n ref to localized copy with joined titles (1.818 CAO-P2)', async () => {
    const { default: i18n } = await import('i18next');
    if (!i18n.isInitialized) {
      await i18n.init({
        lng: 'en-US',
        // Matches the app i18n config (interpolation.escapeValue: false).
        interpolation: { escapeValue: false },
        resources: {
          'en-US': {
            translation: {
              common: {
                projects: {
                  chatIntent: {
                    clarifyQuestion: 'Did you mean one of these projects: {{titles}}? Tell me which one you meant.',
                    listOr: ' or ',
                  },
                },
              },
            },
          },
        },
      });
    }
    mocks.chatIntentInvoke.mockResolvedValue({
      decision: 'needs_clarification',
      question: 'Did you mean one of these projects: "Atlas Alpha" or "Atlas Beta"? Tell me which one you meant.',
      question_i18n: {
        key: 'common.projects.chatIntent.clarifyQuestion',
        params: { titles: ['"Atlas Alpha"', '"Atlas Beta"'] },
      },
    });

    await runProjectChatIntentGate({ conversation_id: 'conv-1', message: 'atlas status' });

    expect(mocks.messageInfo).toHaveBeenCalledWith(
      'Did you mean one of these projects: "Atlas Alpha" or "Atlas Beta"? Tell me which one you meant.'
    );
  });

  it('falls back to the raw question when the i18n key is unknown (version skew)', async () => {
    mocks.chatIntentInvoke.mockResolvedValue({
      decision: 'needs_clarification',
      question: 'Fallback copy from main',
      question_i18n: { key: 'common.projects.chatIntent.doesNotExist' },
    });

    await runProjectChatIntentGate({ conversation_id: 'conv-1', message: 'atlas status' });

    expect(mocks.messageInfo).toHaveBeenCalledWith('Fallback copy from main');
  });
});
