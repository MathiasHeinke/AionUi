/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IGeneratedConversationArtifact } from '@/common/adapter/ipcBridge';
import type { TMessage } from '@/common/chat/chatLib';
import {
  TYPED_UI_CATALOG_VERSION,
  TYPED_UI_MIME_TYPE,
  TYPED_UI_SCHEMA_VERSION,
  type TypedUIEnvelope,
} from '@/common/typedUI';
import { stageConversationArtifact } from '@/renderer/pages/conversation/Messages/artifacts';
import { useAddOrUpdateMessage } from '@/renderer/pages/conversation/Messages/hooks';
import {
  clearConversationGenerating,
  markConversationGenerating,
} from '@/renderer/services/commandEveGenerationActivity';
import React, { useEffect } from 'react';

const STREAM_TICK_MS = 35;
const ENABLED_CONVERSATION_KEY = 'aionui:e2e-message-stream-conversation-id';

type RunScenarioOptions = {
  historyPairs?: number;
  lines?: number;
  seedHistoryOnly?: boolean;
};

type StreamController = {
  runScenario: (options?: RunScenarioOptions) => Promise<void>;
  emitTypedUIArtifact: () => Promise<string>;
  emitInfoTip: (code: string, content: string) => Promise<void>;
  emitFollowUpExchange: () => Promise<void>;
  beginGenerating: () => void;
  clearGenerating: () => void;
};

type StreamRegistry = {
  controllers: Record<string, StreamController>;
};

declare global {
  interface Window {
    __AIONUI_E2E_MESSAGE_STREAM__?: StreamRegistry;
  }
}

const createSeedMessages = (conversationId: string, historyPairs: number): TMessage[] => {
  const baseCreatedAt = Date.now() - 100_000;
  const messages: TMessage[] = [];

  for (let index = 0; index < historyPairs; index += 1) {
    messages.push({
      id: `e2e-seed-user-${index}`,
      msg_id: `e2e-seed-user-${index}`,
      conversation_id: conversationId,
      type: 'text',
      position: 'right',
      created_at: baseCreatedAt + index * 2,
      content: {
        content: `User seed message ${index + 1}: keep the list tall enough to overflow.`,
      },
    });

    messages.push({
      id: `e2e-seed-assistant-${index}`,
      msg_id: `e2e-seed-assistant-${index}`,
      conversation_id: conversationId,
      type: 'text',
      position: 'left',
      created_at: baseCreatedAt + index * 2 + 1,
      content: {
        content: `Assistant seed reply ${index + 1}: this is stable history used to create a realistic scroll range.`,
      },
    });
  }

  messages.push({
    id: 'e2e-seed-user-final',
    msg_id: 'e2e-seed-user-final',
    conversation_id: conversationId,
    type: 'text',
    position: 'right',
    created_at: baseCreatedAt + historyPairs * 2 + 1,
    content: {
      content: 'Please stream a long reply line by line so the message list keeps growing.',
    },
  });

  return messages;
};

const createStreamChunks = (lines: number): string[] => {
  return Array.from(
    { length: lines },
    (_, index) =>
      `${index + 1}. Streamed line ${index + 1} keeps extending the assistant reply to stress-test bottom-follow scrolling.\n`
  );
};

const createTypedUIEnvelope = (artifactId: string): TypedUIEnvelope => ({
  schema_version: TYPED_UI_SCHEMA_VERSION,
  catalog_version: TYPED_UI_CATALOG_VERSION,
  root: 'root',
  elements: {
    root: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12, align: 'stretch' },
      children: ['heading', 'goal', 'run', 'decision', 'reply'],
    },
    heading: {
      type: 'Heading',
      props: { text: 'Typed release cockpit', level: 2 },
      children: [],
    },
    goal: {
      type: 'Goal',
      props: {
        id: 'goal-typed-ui',
        title: 'Reach the integration gate',
        status: 'active',
        progress: 82,
        owner: 'CTO',
        summary: 'Declarative UI only; renderer and authority remain host-owned.',
      },
      children: [],
    },
    run: {
      type: 'WorkerRun',
      props: {
        id: 'worker-run-typed-ui',
        worker: 'AionUI verifier',
        status: 'running',
        startedAt: '2026-08-11T12:00:00.000Z',
        summary: 'Schema, security and accessibility gates are running.',
        receiptRef: 'receipt-local-typed-ui',
      },
      children: [],
      on: { press: 'openCurrentArtifact' },
    },
    decision: {
      type: 'DecisionCard',
      props: {
        id: 'decision-typed-ui',
        title: 'Prepare the isolated integration branch?',
        status: 'open',
        rationale: 'No merge, release or deploy is part of this action.',
        humanGate: 'HG-2.5',
        statePath: '/decision',
        options: [
          { id: 'prepare', label: 'Prepare' },
          { id: 'later', label: 'Later' },
        ],
      },
      children: [],
      on: { 'select:prepare': 'selectPrepare', approve: 'requestApproval' },
    },
    reply: {
      type: 'Button',
      props: { label: 'Reply with verified state', variant: 'primary', disabled: false },
      children: [],
      on: { press: 'replyState' },
    },
  },
  state: { decision: null, verification: 'Ready' },
  actions: {
    openCurrentArtifact: { type: 'open_artifact', params: { artifact_id: artifactId } },
    selectPrepare: {
      type: 'select_option',
      params: { state_path: '/decision', value: 'prepare', option_id: 'prepare' },
    },
    requestApproval: {
      type: 'request_approval',
      params: { gate_action: 'prepare_pr', summary: 'Prepare the bounded integration branch.' },
    },
    replyState: {
      type: 'reply_with_state',
      params: { state_paths: ['/decision', '/verification'], message: 'Verified Typed UI state' },
    },
  },
  provenance: {
    provider: 'e2e-local',
    model: 'deterministic-visual-fixture',
    request_id: `request-${artifactId}`,
    generated_at: '2026-08-11T12:00:00.000Z',
    source_message_id: `message-${artifactId}`,
  },
});

const createTypedUIArtifact = (conversationId: string): IGeneratedConversationArtifact => {
  const createdAt = Date.now();
  const artifactId = `e2e-typed-ui-${createdAt}`;
  return {
    id: artifactId,
    conversation_id: conversationId,
    kind: 'file',
    status: 'active',
    created_at: createdAt,
    updated_at: createdAt,
    payload: {
      artifact_type: 'file',
      title: 'Typed Generative UI · Integration gate',
      mime_type: TYPED_UI_MIME_TYPE,
      typed_ui: createTypedUIEnvelope(artifactId),
    } as IGeneratedConversationArtifact['payload'] & { typed_ui: TypedUIEnvelope },
  };
};

const AcpE2EStreamInjector: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  const addOrUpdateMessage = useAddOrUpdateMessage();

  useEffect(() => {
    const enabledConversationId =
      typeof window !== 'undefined' ? window.sessionStorage.getItem(ENABLED_CONVERSATION_KEY) : null;
    if (enabledConversationId !== conversationId) {
      return;
    }

    const registry = (window.__AIONUI_E2E_MESSAGE_STREAM__ ??= { controllers: {} });

    registry.controllers[conversationId] = {
      emitTypedUIArtifact: async () => {
        const artifact = createTypedUIArtifact(conversationId);
        stageConversationArtifact(conversationId, artifact);
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, STREAM_TICK_MS);
        });
        return artifact.id;
      },
      runScenario: async (options?: RunScenarioOptions) => {
        const historyPairs = options?.historyPairs ?? 18;
        const lines = options?.lines ?? 160;
        const streamMsgId = `e2e-stream-${Date.now()}`;

        if (historyPairs > 0) {
          createSeedMessages(conversationId, historyPairs).forEach((message) => addOrUpdateMessage(message, true));
        }

        if (options?.seedHistoryOnly) {
          return;
        }

        const chunks = createStreamChunks(lines);
        await new Promise<void>((resolve) => {
          let chunkIndex = 0;

          const pushNextChunk = () => {
            if (chunkIndex >= chunks.length) {
              resolve();
              return;
            }

            addOrUpdateMessage({
              id: `${streamMsgId}-${chunkIndex}`,
              msg_id: streamMsgId,
              conversation_id: conversationId,
              type: 'text',
              position: 'left',
              created_at: Date.now() + chunkIndex,
              content: {
                content: chunks[chunkIndex],
              },
            });
            chunkIndex += 1;
            window.setTimeout(pushNextChunk, STREAM_TICK_MS);
          };

          pushNextChunk();
        });
      },
      emitInfoTip: async (code: string, content: string) => {
        const msgId = `e2e-info-tip-${Date.now()}`;

        addOrUpdateMessage(
          {
            id: msgId,
            msg_id: msgId,
            conversation_id: conversationId,
            type: 'tips',
            position: 'center',
            status: 'finish',
            created_at: Date.now(),
            content: {
              content,
              type: 'info',
              code,
            },
          },
          true
        );

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, STREAM_TICK_MS);
        });
      },
      beginGenerating: () => {
        markConversationGenerating(conversationId);
      },
      clearGenerating: () => {
        clearConversationGenerating(conversationId);
      },
      emitFollowUpExchange: async () => {
        const userMsgId = `e2e-follow-up-user-${Date.now()}`;
        const assistantMsgId = `e2e-follow-up-assistant-${Date.now()}`;

        addOrUpdateMessage(
          {
            id: userMsgId,
            msg_id: userMsgId,
            conversation_id: conversationId,
            type: 'text',
            position: 'right',
            status: 'finish',
            created_at: Date.now(),
            content: {
              content: 'Please continue after the neutral info tip.',
            },
          },
          true
        );

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, STREAM_TICK_MS);
        });

        addOrUpdateMessage(
          {
            id: assistantMsgId,
            msg_id: assistantMsgId,
            conversation_id: conversationId,
            type: 'text',
            position: 'left',
            status: 'finish',
            created_at: Date.now() + 1,
            content: {
              content: 'Follow-up reply arrived after the neutral empty-turn tip.',
            },
          },
          true
        );

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, STREAM_TICK_MS);
        });
      },
    };

    return () => {
      if (window.__AIONUI_E2E_MESSAGE_STREAM__) {
        delete window.__AIONUI_E2E_MESSAGE_STREAM__.controllers[conversationId];
      }
    };
  }, [addOrUpdateMessage, conversationId]);

  return null;
};

export default AcpE2EStreamInjector;
