import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import MessageAcpPermission from '@/renderer/pages/conversation/Messages/acp/MessageAcpPermission';
import { addEventListener } from '@/renderer/utils/emitter';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { confirmMessageMock, artifactFixtures } = vi.hoisted(() => ({
  confirmMessageMock: vi.fn(),
  artifactFixtures: { current: [] as Array<Record<string, unknown>> },
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  conversation: { confirmMessage: { invoke: confirmMessageMock } },
}));

vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({
  useConversationArtifacts: () => artifactFixtures.current,
  isVisibleConversationArtifact: () => true,
  isUsableMediaEditSource: () => true,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      String(options?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (token, name: string) =>
        options?.[name] === undefined ? token : String(options[name])
      ),
  }),
}));

function clarifyMessage(
  interactionKind: 'clarify' | 'artifact_followup' = 'artifact_followup',
  artifactMode: 'image' | 'video' | 'word' | 'excel' = 'image',
  artifactId = 'img-source'
): IMessageAcpPermission {
  const visibleQuestion = 'Soll ich im Linienmotiv die Linie von Grün auf Blau ändern?';
  const wireQuestion =
    interactionKind === 'artifact_followup'
      ? `[command_eve:artifact_target:${artifactId}] ${visibleQuestion}`
      : visibleQuestion;
  return {
    id: 'clarify-message',
    msg_id: 'clarify-message',
    type: 'acp_permission',
    position: 'left',
    conversation_id: 'conversation-1',
    content: {
      session_id: 'conversation-1',
      status: 'pending',
      options: [
        { option_id: 'clarify_choice_0', name: 'Ja, Linie blau ändern', kind: 'allow_once' },
        { option_id: 'clarify_cancel', name: 'Cancel', kind: 'reject_once' },
      ],
      tool_call: {
        tool_call_id: 'clarify-0123456789abcdef0123456789abcdef',
        title: wireQuestion,
        kind: 'execute',
        raw_input: {
          question: wireQuestion,
          choices: ['Ja, Linie blau ändern'],
          metadata: {
            interaction_kind: interactionKind,
            ...(interactionKind === 'artifact_followup' ? { artifact_mode: artifactMode } : {}),
            question: wireQuestion,
            choices: ['Ja, Linie blau ändern'],
            source_user_turn: 'Nee, machen wir die Linie doch lieber blau.',
          },
        },
      },
    },
  } as IMessageAcpPermission;
}

describe('native Hermes clarify rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmMessageMock.mockResolvedValue(undefined);
    artifactFixtures.current = [
      {
        id: 'img-source',
        conversation_id: 'conversation-1',
        kind: 'image',
        status: 'active',
        created_at: 100,
        payload: {
          artifact_type: 'image',
          title: 'Linienmotiv',
          managed_image: true,
        },
      },
      {
        id: 'img-newer',
        conversation_id: 'conversation-1',
        kind: 'image',
        status: 'active',
        created_at: 300,
        payload: { artifact_type: 'image', title: 'Anderes Bild', managed_image: true },
      },
    ];
  });

  it('shows a compact choice card instead of the security permission surface', () => {
    render(<MessageAcpPermission message={clarifyMessage()} isCommandEve />);

    expect(screen.getByTestId('message-acp-clarify-card')).toBeInTheDocument();
    expect(screen.queryByTestId('message-acp-permission-unverified')).not.toBeInTheDocument();
    expect(screen.getByText('Soll ich im Linienmotiv die Linie von Grün auf Blau ändern?')).toBeInTheDocument();
    expect(screen.queryByText(/command_eve:artifact_target/)).not.toBeInTheDocument();
    expect(screen.getByTestId('message-acp-clarify-artifact')).toHaveTextContent('Linienmotiv');
  });

  it('re-drives the exact visible artifact and authoritative source turn only after the first choice lands', async () => {
    const events: unknown[] = [];
    const unsubscribe = addEventListener('commandEve.composer.followup.confirmed', (event) => events.push(event));
    render(<MessageAcpPermission message={clarifyMessage()} isCommandEve />);

    fireEvent.click(screen.getByTestId('message-acp-clarify-option-0'));

    await waitFor(() => expect(confirmMessageMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(events).toEqual([
        {
          conversation_id: 'conversation-1',
          artifact_id: 'img-source',
          source_user_turn: 'Nee, machen wir die Linie doch lieber blau.',
        },
      ])
    );
    unsubscribe();
  });

  it('cancels without selecting an artifact or dispatching another turn', async () => {
    const events: unknown[] = [];
    const unsubscribe = addEventListener('commandEve.composer.followup.confirmed', (event) => events.push(event));
    render(<MessageAcpPermission message={clarifyMessage()} isCommandEve />);

    fireEvent.click(screen.getByTestId('message-acp-clarify-option-1'));

    await waitFor(() => expect(confirmMessageMock).toHaveBeenCalledTimes(1));
    expect(events).toEqual([]);
    unsubscribe();
  });

  it('falls back to the security surface when the app-authored choice order is altered', () => {
    const message = clarifyMessage();
    const content = message.content as Extract<IMessageAcpPermission['content'], object> & {
      options: Array<Record<string, unknown>>;
    };
    content.options = [
      { option_id: 'clarify_cancel', name: 'Abbrechen', kind: 'reject_once' },
      { option_id: 'clarify_choice_0', name: 'Ja, Linie blau ändern', kind: 'allow_once' },
    ];
    render(<MessageAcpPermission message={message} isCommandEve />);

    expect(screen.queryByTestId('message-acp-clarify-card')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-acp-permission-card')).toBeInTheDocument();
  });

  it('keeps the exact registry target even when a newer same-medium artifact arrives', async () => {
    const message = clarifyMessage();
    const events: unknown[] = [];
    const unsubscribe = addEventListener('commandEve.composer.followup.confirmed', (event) => events.push(event));
    const view = render(<MessageAcpPermission message={message} isCommandEve />);
    expect(screen.getByTestId('message-acp-clarify-artifact')).toHaveTextContent('Linienmotiv');

    artifactFixtures.current = [
      ...artifactFixtures.current,
      {
        id: 'img-newest',
        conversation_id: 'conversation-1',
        kind: 'image',
        status: 'active',
        created_at: 500,
        payload: { artifact_type: 'image', title: 'Noch ein Bild', managed_image: true },
      },
    ];
    view.rerender(<MessageAcpPermission message={message} isCommandEve />);

    expect(screen.getByTestId('message-acp-clarify-artifact')).toHaveTextContent('Linienmotiv');
    fireEvent.click(screen.getByTestId('message-acp-clarify-option-0'));
    await waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ artifact_id: 'img-source' });
    unsubscribe();
  });

  it('admits only one confirmation while the non-idempotent ACP response is in flight', async () => {
    let resolveConfirmation: ((value: unknown) => void) | undefined;
    confirmMessageMock.mockReturnValue(
      new Promise((resolve) => {
        resolveConfirmation = resolve;
      })
    );
    const events: unknown[] = [];
    const unsubscribe = addEventListener('commandEve.composer.followup.confirmed', (event) => events.push(event));
    render(<MessageAcpPermission message={clarifyMessage()} isCommandEve />);

    const choice = screen.getByTestId('message-acp-clarify-option-0');
    fireEvent.click(choice);
    fireEvent.click(choice);
    expect(confirmMessageMock).toHaveBeenCalledTimes(1);

    resolveConfirmation?.(undefined);
    await waitFor(() => expect(events).toHaveLength(1));
    expect(confirmMessageMock).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps ordinary clarify choices generic and never manufactures artifact authority', async () => {
    const events: unknown[] = [];
    const unsubscribe = addEventListener('commandEve.composer.followup.confirmed', (event) => events.push(event));
    render(<MessageAcpPermission message={clarifyMessage('clarify')} isCommandEve />);

    expect(screen.queryByTestId('message-acp-clarify-artifact')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('message-acp-clarify-option-0'));
    await waitFor(() => expect(confirmMessageMock).toHaveBeenCalledTimes(1));
    expect(events).toEqual([]);
    unsubscribe();
  });

  it.each([
    ['a non-EVE conversation', (message: IMessageAcpPermission) => message, false],
    [
      'a non-app clarify call id',
      (message: IMessageAcpPermission) => {
        if (message.content?.tool_call) message.content.tool_call.tool_call_id = 'model-authored-call';
        return message;
      },
      true,
    ],
    [
      'mismatched visible choices',
      (message: IMessageAcpPermission) => {
        const rawInput = message.content?.tool_call?.raw_input as Record<string, unknown>;
        rawInput.choices = ['Something else'];
        return message;
      },
      true,
    ],
    [
      'foreign spend metadata',
      (message: IMessageAcpPermission) => {
        const rawInput = message.content?.tool_call?.raw_input as Record<string, unknown>;
        const metadata = rawInput.metadata as Record<string, unknown>;
        metadata.spend_permit = 'invented-permit';
        return message;
      },
      true,
    ],
    [
      'foreign tool authority metadata',
      (message: IMessageAcpPermission) => {
        const rawInput = message.content?.tool_call?.raw_input as Record<string, unknown>;
        const metadata = rawInput.metadata as Record<string, unknown>;
        metadata.tool_authority = 'always';
        return message;
      },
      true,
    ],
  ] as const)('keeps the security permission surface for %s', (_label, mutate, isCommandEve) => {
    const message = mutate(clarifyMessage());
    render(<MessageAcpPermission message={message} isCommandEve={isCommandEve} />);

    expect(screen.queryByTestId('message-acp-clarify-card')).not.toBeInTheDocument();
  });

  it('does not emit after an explicit confirmation rejection', async () => {
    confirmMessageMock.mockResolvedValue({ success: false });
    const events: unknown[] = [];
    const unsubscribe = addEventListener('commandEve.composer.followup.confirmed', (event) => events.push(event));
    render(<MessageAcpPermission message={clarifyMessage()} isCommandEve />);

    fireEvent.click(screen.getByTestId('message-acp-clarify-option-0'));

    await waitFor(() => expect(screen.getByText(/nichts ausgeführt/i)).toBeInTheDocument());
    expect(events).toEqual([]);
    unsubscribe();
  });

  it.each([
    ['a stale target', 'missing-artifact', 'conversation-1'],
    ['a target from another conversation', 'img-source', 'conversation-2'],
  ])('fails closed for %s without confirming or emitting', async (_label, artifactId, artifactConversationId) => {
    if (artifactConversationId !== 'conversation-1') {
      artifactFixtures.current = artifactFixtures.current.map((artifact) =>
        artifact.id === artifactId ? { ...artifact, conversation_id: artifactConversationId } : artifact
      );
    }
    const events: unknown[] = [];
    const unsubscribe = addEventListener('commandEve.composer.followup.confirmed', (event) => events.push(event));
    render(<MessageAcpPermission message={clarifyMessage('artifact_followup', 'image', artifactId)} isCommandEve />);

    expect(screen.getByTestId('message-acp-clarify-reference-unavailable')).toBeInTheDocument();
    const primary = screen.getByTestId('message-acp-clarify-option-0');
    expect(primary).toBeDisabled();
    fireEvent.click(primary);
    await Promise.resolve();
    expect(confirmMessageMock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    unsubscribe();
  });

  it('shows the exact inherited video-edit cost on the single action card before confirmation', () => {
    artifactFixtures.current = [
      {
        id: 'video-source',
        conversation_id: 'conversation-1',
        kind: 'video',
        status: 'active',
        created_at: 100,
        payload: {
          artifact_type: 'video',
          title: 'Auberginenclip',
          description: '720p · 5s',
          path: '/fixture/video-source.mp4',
          mime_type: 'video/mp4',
          hash: 'a'.repeat(64),
          size: 24,
          duration_seconds: 5,
          origin_capability: 'video_generation',
          tier_id: 'fast',
        },
      },
    ];

    render(
      <MessageAcpPermission message={clarifyMessage('artifact_followup', 'video', 'video-source')} isCommandEve />
    );

    expect(screen.getByTestId('message-acp-clarify-artifact')).toHaveTextContent('Auberginenclip');
    expect(screen.getByTestId('message-acp-clarify-video-cost')).toHaveTextContent(
      'Dieses ~5s-Video kostet ca. 1200 Credits — fortfahren?'
    );
    expect(confirmMessageMock).not.toHaveBeenCalled();
  });

  it.each(['image', 'video', 'word', 'excel'] as const)(
    'resolves the exact %s artifact id before offering the executable first choice',
    async (mode) => {
      artifactFixtures.current = [
        {
          id: `${mode}-target`,
          conversation_id: 'conversation-1',
          kind: mode,
          status: 'active',
          created_at: 200,
          payload: {
            artifact_type: mode,
            title: `${mode} target`,
            ...(mode === 'image' ? { managed_image: true } : {}),
          },
        },
      ];
      const events: unknown[] = [];
      const unsubscribe = addEventListener('commandEve.composer.followup.confirmed', (event) => events.push(event));
      render(
        <MessageAcpPermission message={clarifyMessage('artifact_followup', mode, `${mode}-target`)} isCommandEve />
      );

      expect(screen.getByTestId('message-acp-clarify-artifact')).toHaveTextContent(`${mode} target`);
      fireEvent.click(screen.getByTestId('message-acp-clarify-option-0'));
      await waitFor(() => expect(events).toHaveLength(1));
      expect(events[0]).toMatchObject({ artifact_id: `${mode}-target` });
      unsubscribe();
    }
  );
});
