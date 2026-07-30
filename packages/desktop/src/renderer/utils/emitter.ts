/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { VideoGenerationArtifact } from '@/common/config/videoGenerationRequestCore';
import EventEmitter from 'eventemitter3';
import type { DependencyList } from 'react';
import { useEffect } from 'react';
import type { FileOrFolderItem } from '@/renderer/utils/file/fileTypes';
import type { PreviewContentType } from '@/common/types/office/preview';
import type { TConversationRuntimeSummary } from '@/common/config/storage';

export type ReplyQuote = {
  messageId: string;
  content: string;
  position: 'left' | 'right' | 'center' | 'pop';
};

interface EventTypes {
  'aionrs.selected.file': [Array<string | FileOrFolderItem>];
  'aionrs.selected.file.append': [Array<string | FileOrFolderItem>];
  'aionrs.selected.file.clear': void;
  'aionrs.workspace.refresh': void;
  'acp.selected.file': [Array<string | FileOrFolderItem>];
  /** A managed video finished generating and is ready to show and save. */
  'acp.video.generated': [{ conversation_id: string; artifact: VideoGenerationArtifact }];
  'acp.selected.file.append': [Array<string | FileOrFolderItem>];
  'acp.selected.file.clear': void;
  'acp.workspace.refresh': void;
  // Live permission-mode broadcast: AgentModeSelector fires this whenever the
  // conversation's effective permission mode changes (initial sync + every
  // in-session pick) so the ACP message handler can decide whether an incoming
  // request_permission should be auto-allowed (YOLO/"Nicht fragen") or gated.
  // This renderer-side signal covers permission events replayed while the stable
  // backend config-options acknowledgement is still settling.
  'acp.permission.mode': [{ conversation_id: string; mode: string }];
  'codex.selected.file': [Array<string | FileOrFolderItem>];
  'codex.selected.file.append': [Array<string | FileOrFolderItem>];
  'codex.selected.file.clear': void;
  'codex.workspace.refresh': void;
  'chat.history.refresh': void;
  // Durable conversation recovery signals. The database/runtime are the source
  // of truth when a renderer misses a realtime user/terminal frame.
  'conversation.messages.refresh': [{ conversation_id: string; expectedTerminalMessageId?: string }];
  'conversation.messages.reconcile': [{ conversation_id: string }];
  'conversation.runtime.recovered': [
    { conversation_id: string; runtime: TConversationRuntimeSummary; recoveredTurnId: string | null },
  ];
  // 会话删除事件 / Conversation deletion event
  'conversation.deleted': [string]; // conversation_id
  // 预览面板事件 / Preview panel events
  'preview.open': [
    {
      content: string;
      contentType: PreviewContentType;
      metadata?: { title?: string; file_name?: string; conversation_id?: string };
    },
  ];
  // 填充输入框事件 / Fill sendbox input event
  'sendbox.fill': [string]; // prompt text to fill
  'sendbox.reply': [ReplyQuote]; // reply/quote a message
  'sendbox.reply.clear': void; // clear reply quote
}

export const emitter = new EventEmitter<EventTypes>();

export const addEventListener = <T extends EventEmitter.EventNames<EventTypes>>(
  event: T,
  fn: EventEmitter.EventListener<EventTypes, T>
) => {
  emitter.on(event, fn);
  return () => {
    emitter.off(event, fn);
  };
};

export const useAddEventListener = <T extends EventEmitter.EventNames<EventTypes>>(
  event: T,
  fn: EventEmitter.EventListener<EventTypes, T>,
  deps?: DependencyList
) => {
  useEffect(() => {
    return addEventListener(event, fn);
  }, deps || []);
};
