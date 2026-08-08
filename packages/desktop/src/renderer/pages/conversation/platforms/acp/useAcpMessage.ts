/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { conversation as conversationBridge } from '@/common/adapter/ipcBridge';
import { transformMessage } from '@/common/chat/chatLib';
import { isCommandEveAcpConversation } from '@/common/config/commandEveShell';
import {
  collectBrowserNavigationFromToolCallUpdate,
  shouldOpenBrowserPreview,
} from '@/common/config/browserNavigationBindCore';
import {
  collectHtmlWriteFromToolCallStart,
  isCompletedToolCallUpdate,
  shouldOpenHtmlPreview,
} from '@/common/config/htmlArtifactPreviewCore';
import { collectImageBindFromToolCallUpdate } from '@/common/config/imageArtifactBindCore';
import { classifyAcpExternalWriteBlock } from '@/renderer/pages/conversation/Messages/acp/externalWriteRecoveryPolicy';
import type { AvailableCommand, IMessageThinking } from '@/common/chat/chatLib';
import type { AcpPermissionRequest } from '@/common/types/platform/acpTypes';
import { resolveAcpAutoApprove } from './acpAutoApprove';
import { addEventListener, emitter } from '@/renderer/utils/emitter';
import { getFileTypeInfo } from '@renderer/utils/file/fileType';
import { usePreviewLauncher } from '@renderer/hooks/file/usePreviewLauncher';
import type { SlashCommandItem } from '@/common/chat/slash/types';
import { mapAcpCommandsToSlashCommands } from '@/common/chat/slash/acpMapping';
import type { IResponseMessage } from '@/common/adapter/ipcBridge';
import type { TokenUsageData } from '@/common/config/storage';
import { useAddOrUpdateMessage } from '@/renderer/pages/conversation/Messages/hooks';
import {
  buildReportedConversationArtifact,
  stageConversationArtifact,
} from '@/renderer/pages/conversation/Messages/artifacts';
import type { ThoughtData } from '@/renderer/components/chat/ThoughtDisplay';
import { useQuotaWall, type QuotaWallState } from '@renderer/hooks/useQuotaWall';
import {
  clearConversationGenerating,
  ensureAcpGenerationTracking,
} from '@renderer/services/commandEveGenerationActivity';
import { getConversationRuntimeViewSnapshot } from '@/renderer/pages/conversation/runtime/conversationRuntimeViewStore';
import { warmupConversation } from '@/renderer/pages/conversation/utils/warmupConversation';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

const THINKING_MESSAGE_THROTTLE_MS = 50;

export type UseAcpMessageReturn = {
  thought: ThoughtData;
  setThought: React.Dispatch<React.SetStateAction<ThoughtData>>;
  running: boolean;
  hasHydratedRunningState: boolean;
  acpStatus: 'connecting' | 'connected' | 'authenticated' | 'session_active' | 'disconnected' | 'error' | null;
  aiProcessing: boolean;
  setAiProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  resetState: () => void;
  tokenUsage: TokenUsageData | null;
  context_limit: number;
  hasThinkingMessage: boolean;
  slashCommands: SlashCommandItem[];
  fetchSlashCommands: () => void;
  runtimeActivity: AcpRuntimeActivity;
  /**
   * Lane-3 402 quota-exhausted wall controller. Fed by the LIVE ACP stream-error
   * path: when an EVE-inference turn errors with a 402 quota_exhausted body, the
   * wall body is set and surfaces <QuotaExhaustedWall/> (idle-suppressed). The
   * container renders `<QuotaExhaustedWall {...quotaWall} jobInFlight=… />`.
   */
  quotaWall: QuotaWallState;
};

export type AcpRuntimeActivityPhase =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'submitting'
  | 'thinking'
  | 'streaming'
  | 'tool_wait'
  | 'heartbeat_only'
  | 'ui_backlog'
  | 'done'
  | 'error';

export type AcpRuntimeActivity = {
  phase: AcpRuntimeActivityPhase;
  backend?: string;
  modelId?: string;
  contextUsed?: number;
  contextSize?: number;
  startedAt?: number;
  updatedAt: number;
  elapsedMs?: number;
  detail?: string;
};

export type AcpStreamWatchdogStatus =
  | 'idle'
  | 'streaming'
  | 'tool_wait'
  | 'heartbeat_only'
  | 'ui_backlog'
  | 'stopped'
  | 'failed';

export function classifyAcpStreamWatchdog(input: {
  now: number;
  lastBackendEventAt?: number;
  lastRendererCommitAt?: number;
  pendingBufferedSinceAt?: number;
  pendingBufferedEvents: number;
  activeToolName?: string;
  runStopped?: boolean;
  runFailed?: boolean;
}): AcpStreamWatchdogStatus {
  if (input.pendingBufferedEvents > 0) {
    const backlogBaselineCandidates = [input.lastRendererCommitAt, input.pendingBufferedSinceAt].filter(
      (value): value is number => typeof value === 'number'
    );
    const backlogBaseline = backlogBaselineCandidates.length ? Math.max(...backlogBaselineCandidates) : undefined;
    if (backlogBaseline !== undefined && input.now - backlogBaseline > 3000) return 'ui_backlog';
  }
  if (input.runStopped) return 'stopped';
  if (input.runFailed) return 'failed';
  if (input.activeToolName) return 'tool_wait';
  if (input.lastBackendEventAt && input.now - input.lastBackendEventAt < 5000) return 'streaming';
  if (input.lastBackendEventAt) return 'heartbeat_only';
  return 'idle';
}

type AcpToolActivityWire = {
  update?: {
    sessionUpdate?: string;
    session_update?: string;
    tool_call_id?: string;
    toolCallId?: string;
    status?: string;
    title?: string;
    kind?: string;
  };
};

function getFirstActiveToolName(activeTools: Map<string, string>): string | undefined {
  return activeTools.values().next().value;
}

function extractAcpToolActivity(message: IResponseMessage): { callId: string; active: boolean; name?: string } | null {
  if (message.type !== 'acp_tool_call') return null;
  const update = (message.data as AcpToolActivityWire | undefined)?.update;
  const sessionUpdate = update?.sessionUpdate ?? update?.session_update;
  if (!update || (sessionUpdate !== 'tool_call' && sessionUpdate !== 'tool_call_update')) return null;
  const callId = update.tool_call_id ?? update.toolCallId;
  if (!callId) return null;
  return {
    callId,
    active: update.status === 'pending' || update.status === 'in_progress' || update.status === 'running',
    name: update.title || update.kind || callId,
  };
}

export const useAcpMessage = (conversation_id: string, options?: { skipWarmup?: boolean }): UseAcpMessageReturn => {
  const addOrUpdateMessage = useAddOrUpdateMessage();
  // B7 — opens an html artifact from DISK once its write completes.
  const { launchPreview } = usePreviewLauncher();
  const [running, setRunning] = useState(false);
  const [hasHydratedRunningState, setHasHydratedRunningState] = useState(false);
  const [thought, setThought] = useState<ThoughtData>({
    description: '',
    subject: '',
  });
  const [acpStatus, setAcpStatus] = useState<
    'connecting' | 'connected' | 'authenticated' | 'session_active' | 'disconnected' | 'error' | null
  >(null);
  const [aiProcessing, setAiProcessing] = useState(false); // New loading state for AI response
  const [tokenUsage, setTokenUsage] = useState<TokenUsageData | null>(null);
  const [context_limit, setContextLimit] = useState<number>(0);
  const [slashCommands, setSlashCommands] = useState<SlashCommandItem[]>([]);
  const [runtimeActivity, setRuntimeActivity] = useState<AcpRuntimeActivity>({
    phase: 'idle',
    updatedAt: Date.now(),
  });

  // Lane-3: the 402 quota-exhausted wall controller. The live stream-error path
  // (the 'error' case below) feeds it via reportInferenceError; the container
  // renders the wall from this state.
  const quotaWall = useQuotaWall();
  const reportInferenceError = quotaWall.reportInferenceError;

  // Use refs to sync state for immediate access in event handlers
  const runningRef = useRef(running);
  const aiProcessingRef = useRef(aiProcessing);
  const lastBackendEventAtRef = useRef<number | undefined>(undefined);
  const lastRendererCommitAtRef = useRef<number | undefined>(undefined);
  const lastPendingBufferedAtRef = useRef<number | undefined>(undefined);
  const activeToolCallsRef = useRef<Map<string, string>>(new Map());

  // Live renderer permission authority for THIS conversation. Plain EVE
  // `dont_ask` leaves escalations gated; the selector publishes the separate,
  // conversation-scoped HG4 grant only after backend acknowledgement.
  const permissionModeRef = useRef<string | undefined>(undefined);
  const permissionBackendRef = useRef<string | undefined>(undefined);
  // Once the selector publishes local authority, a later/stale request_trace may
  // report backend `dont_ask` but must never widen a just-revoked renderer grant.
  const hasLocalPermissionAuthorityRef = useRef(false);

  // Guard against double auto-responding the same permission request: a stream
  // can re-deliver an acp_permission (reconnect/replay), and confirmMessage is
  // not idempotent on the backend — answer each call_id at most once.
  const autoApprovedCallIdsRef = useRef<Set<string>>(new Set());

  // A failed ACP frame can be replayed after reconnect. External-write recovery
  // is terminal and non-idempotent at the renderer boundary (cancel + stage), so
  // each tool call id is consumed once for the lifetime of this conversation.
  const recoveredExternalWriteCallIdsRef = useRef<Set<string>>(new Set());
  // B1 — the last url this conversation opened in the preview panel. A page visit
  // is one navigation followed by a stream of snapshots/clicks/scrolls on the SAME
  // url; re-opening for each of those would yank the panel out from under the user
  // mid-read. Per-hook, so two conversations never dedupe against each other.
  const lastBrowserPreviewUrlRef = useRef<string | undefined>(undefined);
  // B7 — html writes seen on this turn, keyed by tool-call id, spent when that id
  // completes. Two phases because the path is only on the START update: the
  // completion carries tool_call_id/kind/status/content and nothing else
  // (acp_adapter/tools.py:1305-1329).
  const pendingHtmlWritesRef = useRef<Map<string, string>>(new Map());
  const lastHtmlPreviewPathRef = useRef<string | undefined>(undefined);

  // Track whether current turn has content output
  const hasContentInTurnRef = useRef(false);

  // Guard: after finish arrives, prevent auto-recover from setting running=true
  // until a new 'start' signal arrives for the next turn
  const turnFinishedRef = useRef(false);

  // 1.820.3 — staged image handles (`img_h_…`) seen in THIS turn's tool call
  // outputs, keyed by tool call id. Collected as the `acp_tool_call` messages
  // arrive and bound to the conversation at the terminal `finish` — BEFORE the
  // artifact refresh fires, so the first render already sees the bound record.
  const pendingImageBindsRef = useRef<Map<string, string>>(new Map());

  // Track whether current turn has a thinking message in the conversation
  const hasThinkingMessageRef = useRef(false);
  const [hasThinkingMessage, setHasThinkingMessage] = useState(false);

  const thinkingMessageThrottleRef = useRef<{
    lastUpdate: number;
    pending: IMessageThinking | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ lastUpdate: Number.NEGATIVE_INFINITY, pending: null, timer: null });

  // 1.7.3 — ensure the renderer-global generation-activity tracker is attached to
  // the GLOBAL ACP response stream while a conversation view is alive. The tracker
  // is driven by that stream (start → generating, finish/error → done), NOT by this
  // component's mount, so a turn that keeps streaming after the user navigates away
  // is still seen by the seat-switch guard (Codex 1.7.3 audit #1). Idempotent.
  useEffect(() => {
    ensureAcpGenerationTracking();
  }, []);
  // Track the in-flight thinking block so a synthetic done update (with a
  // computed duration) can be emitted when the turn finishes or the first
  // non-thinking message arrives, even if the backend never sends a done.
  const activeThinkingRef = useRef<{ msgId: string; startedAt: number } | null>(null);

  // Track request trace state for displaying complete request lifecycle
  const requestTraceRef = useRef<{
    startTime: number;
    backend: string;
    model_id: string;
    session_mode?: string;
  } | null>(null);

  // Throttle thought updates to reduce render frequency
  const thoughtThrottleRef = useRef<{
    lastUpdate: number;
    pending: ThoughtData | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ lastUpdate: 0, pending: null, timer: null });

  const throttledSetThought = useMemo(() => {
    const THROTTLE_MS = 50;
    return (data: ThoughtData) => {
      const now = Date.now();
      const ref = thoughtThrottleRef.current;
      if (now - ref.lastUpdate >= THROTTLE_MS) {
        ref.lastUpdate = now;
        ref.pending = null;
        if (ref.timer) {
          clearTimeout(ref.timer);
          ref.timer = null;
        }
        setThought(data);
      } else {
        ref.pending = data;
        if (!ref.timer) {
          ref.timer = setTimeout(
            () => {
              ref.lastUpdate = Date.now();
              ref.timer = null;
              if (ref.pending) {
                setThought(ref.pending);
                ref.pending = null;
              }
            },
            THROTTLE_MS - (now - ref.lastUpdate)
          );
        }
      }
    };
  }, []);

  // Clean up throttle timer
  useEffect(() => {
    return () => {
      if (thoughtThrottleRef.current.timer) {
        clearTimeout(thoughtThrottleRef.current.timer);
      }
    };
  }, []);

  const clearThinkingMessageThrottle = useCallback(() => {
    const ref = thinkingMessageThrottleRef.current;
    if (ref.timer) {
      clearTimeout(ref.timer);
    }
    ref.lastUpdate = Number.NEGATIVE_INFINITY;
    ref.pending = null;
    ref.timer = null;
    lastPendingBufferedAtRef.current = undefined;
  }, []);

  const commitMessage = useCallback(
    (message: Parameters<typeof addOrUpdateMessage>[0]) => {
      addOrUpdateMessage(message);
      lastRendererCommitAtRef.current = Date.now();
    },
    [addOrUpdateMessage]
  );

  const applyContextUsage = useCallback((usage: { used: number; size: number } | null | undefined) => {
    if (!usage || typeof usage.used !== 'number' || typeof usage.size !== 'number') return;

    setTokenUsage({ total_tokens: usage.used });
    if (usage.size > 0) {
      setContextLimit(usage.size);
    }
    setRuntimeActivity((prev) => ({
      ...prev,
      contextUsed: usage.used,
      contextSize: usage.size,
      updatedAt: Date.now(),
    }));
  }, []);

  const mergeThinkingMessage = useCallback(
    (pending: IMessageThinking, incoming: IMessageThinking): IMessageThinking => {
      return {
        ...incoming,
        id: pending.id,
        content: {
          ...pending.content,
          ...incoming.content,
          content: `${pending.content.content}${incoming.content.content}`,
          subject: incoming.content.subject || pending.content.subject,
          duration: incoming.content.duration ?? pending.content.duration,
        },
      };
    },
    []
  );

  const flushPendingThinkingMessage = useCallback(() => {
    const ref = thinkingMessageThrottleRef.current;
    if (ref.timer) {
      clearTimeout(ref.timer);
      ref.timer = null;
    }
    const pending = ref.pending;
    if (!pending) return;
    ref.pending = null;
    ref.lastUpdate = Date.now();
    lastPendingBufferedAtRef.current = undefined;
    commitMessage(pending);
  }, [commitMessage]);

  const enqueueThinkingMessage = useCallback(
    (message: IMessageThinking | undefined) => {
      if (!message) return;
      const now = Date.now();
      const ref = thinkingMessageThrottleRef.current;
      if (
        ref.pending &&
        (ref.pending.msg_id !== message.msg_id || ref.pending.conversation_id !== message.conversation_id)
      ) {
        flushPendingThinkingMessage();
        ref.lastUpdate = Number.NEGATIVE_INFINITY;
      }

      const canSendImmediately = now - ref.lastUpdate >= THINKING_MESSAGE_THROTTLE_MS && !ref.timer && !ref.pending;
      if (canSendImmediately) {
        ref.lastUpdate = now;
        commitMessage(message);
        return;
      }
      if (!ref.pending) {
        lastPendingBufferedAtRef.current = now;
      }
      ref.pending = ref.pending ? mergeThinkingMessage(ref.pending, message) : message;

      if (!ref.timer) {
        const delay = Math.max(0, THINKING_MESSAGE_THROTTLE_MS - (now - ref.lastUpdate));
        ref.timer = setTimeout(flushPendingThinkingMessage, delay);
      }
    },
    [commitMessage, flushPendingThinkingMessage, mergeThinkingMessage]
  );

  useEffect(() => {
    return clearThinkingMessageThrottle;
  }, [clearThinkingMessageThrottle]);

  const completeActiveThinking = useCallback(
    (
      boundaryMessage: Pick<IResponseMessage, 'conversation_id' | 'created_at'>,
      completeOptions?: {
        duration?: number;
      }
    ) => {
      const activeThinking = activeThinkingRef.current;
      if (!activeThinking) return;

      flushPendingThinkingMessage();

      const endTime = boundaryMessage.created_at ?? Date.now();
      const duration = completeOptions?.duration ?? Math.max(0, endTime - activeThinking.startedAt);

      commitMessage({
        id: `${activeThinking.msgId}-thinking-done`,
        type: 'thinking',
        msg_id: activeThinking.msgId,
        conversation_id: boundaryMessage.conversation_id,
        position: 'left',
        created_at: endTime,
        content: {
          content: '',
          duration,
          status: 'done',
        },
      });

      activeThinkingRef.current = null;
    },
    [commitMessage, flushPendingThinkingMessage]
  );

  const handleResponseMessage = useCallback(
    (message: IResponseMessage) => {
      if (conversation_id !== message.conversation_id) {
        return;
      }

      const now = Date.now();
      lastBackendEventAtRef.current = now;

      const toolActivity = extractAcpToolActivity(message);
      if (toolActivity) {
        if (toolActivity.active) {
          activeToolCallsRef.current.set(toolActivity.callId, toolActivity.name ?? toolActivity.callId);
        } else {
          activeToolCallsRef.current.delete(toolActivity.callId);
        }
      }

      if (message.type === 'skill_suggest' || message.type === 'cron_trigger') {
        // MAT-1773 — these are NOT chat messages; they are EVE's IN-SESSION
        // self-reported artifacts. Dropping them here (the old behavior) left
        // the chat artifact tray stale until a full reload re-read
        // `listArtifacts`. Stage them into the shared conversation artifact
        // store instead: the tray (and the elements rail) render them with
        // the turn, and the terminal-finish artifact refresh reconciles
        // against the durable list afterwards.
        const reportedArtifact = buildReportedConversationArtifact(message);
        if (reportedArtifact) stageConversationArtifact(conversation_id, reportedArtifact);
        return;
      }

      // Close out an in-flight thinking block as soon as the first message that
      // isn't part of the thinking stream arrives (text, finish, error, …), so
      // ThoughtDisplay shows a finished duration instead of spinning forever.
      const shouldCompleteThinking =
        activeThinkingRef.current &&
        ![
          'thought',
          'thinking',
          'start',
          'request_trace',
          'acp_context_usage',
          'acp_model_info',
          'codex_model_info',
          'available_commands',
          'slash_commands_updated',
          'agent_status',
          'user_content',
          'teammate_message',
        ].includes(message.type);

      if (shouldCompleteThinking) {
        completeActiveThinking(message);
      }

      const transformedMessage = transformMessage(message);
      switch (message.type) {
        case 'thought':
          // Thought events are now handled by AcpAgentManager (converted to thinking messages)
          // Only auto-recover running state if turn hasn't finished
          if (!runningRef.current && !turnFinishedRef.current) {
            setRunning(true);
            runningRef.current = true;
          }
          break;
        case 'thinking': {
          const thinkingData = message.data as { status?: string; duration?: number; duration_ms?: number };
          if (thinkingData?.status === 'done') {
            // Backend sent its own done signal — complete the active block with
            // the backend-reported duration when it matches the in-flight block.
            if (activeThinkingRef.current?.msgId === message.msg_id) {
              completeActiveThinking(message, {
                duration: thinkingData.duration ?? thinkingData.duration_ms,
              });
            }
            break;
          }

          // Only set running for active thinking, not for done signal
          if (!runningRef.current && !turnFinishedRef.current) {
            setRunning(true);
            runningRef.current = true;
          }
          if (!activeThinkingRef.current || activeThinkingRef.current.msgId !== message.msg_id) {
            activeThinkingRef.current = {
              msgId: message.msg_id,
              startedAt: message.created_at ?? Date.now(),
            };
          }
          hasThinkingMessageRef.current = true;
          setHasThinkingMessage(true);
          enqueueThinkingMessage(transformedMessage?.type === 'thinking' ? transformedMessage : undefined);
          break;
        }
        case 'start':
          // New turn starting — clear the finished guard and content flag
          turnFinishedRef.current = false;
          hasContentInTurnRef.current = false;
          // A new turn owns no staged image references yet; anything collected
          // last turn was either bound at its finish or is abandoned with it.
          pendingImageBindsRef.current.clear();
          setRunning(true);
          runningRef.current = true;
          setRuntimeActivity((prev) => ({
            ...prev,
            phase: 'submitting',
            backend: requestTraceRef.current?.backend ?? prev.backend,
            modelId: requestTraceRef.current?.model_id ?? prev.modelId,
            startedAt: requestTraceRef.current?.startTime ?? Date.now(),
            updatedAt: Date.now(),
          }));
          // Don't reset aiProcessing here - let content arrival handle it
          break;
        case 'finish':
          {
            // Mark turn as finished to prevent auto-recover from late messages
            turnFinishedRef.current = true;
            // 1.820.3 — BIND BEFORE REFRESH, and display authority is separate
            // from spend authority by design. A managed image produced inside
            // THIS turn was staged in Main WITHOUT a conversation; the staged
            // handles collected from this turn's tool outputs are bound to THIS
            // conversation now, and only then does the artifact refresh fire —
            // so the same-turn inline card and the Artefakte entry appear with
            // the turn, not after a manual reload. Each bind is awaited but a
            // refusal never blocks the finish: it costs the card, not the
            // message. Main makes the bind idempotent on the tool call id, so
            // a re-delivered finish binds nothing twice.
            const pendingImageBinds = [...pendingImageBindsRef.current.entries()];
            pendingImageBindsRef.current.clear();
            const emitArtifactRefresh = () => emitter.emit('commandEve.artifacts.refresh', { conversation_id });
            if (pendingImageBinds.length === 0) {
              emitArtifactRefresh();
            } else {
              void (async () => {
                for (const [toolCallId, handle] of pendingImageBinds) {
                  try {
                    // eslint-disable-next-line no-await-in-loop
                    await ipcBridge.commandEve.imageArtifactBind.invoke({
                      conversationId: conversation_id,
                      handle,
                      toolCallId,
                    });
                  } catch {
                    /* a refused bind costs the inline card, never the turn */
                  }
                }
                emitArtifactRefresh();
              })();
            }
            // (The refresh above is also the 1.820.3 timing-correct artifact
            // refresh for agent-lane VIDEO edits: the child is persisted in
            // Main's durable store by the time the terminal `finish` arrives —
            // and NOT before — which is why the refresh lives here rather than
            // at send-acceptance.)
            // Immediate state reset (notification is handled by centralized hook)
            setRunning(false);
            runningRef.current = false;
            setAiProcessing(false);
            aiProcessingRef.current = false;
            activeToolCallsRef.current.clear();
            setThought({ subject: '', description: '' });
            hasContentInTurnRef.current = false;
            hasThinkingMessageRef.current = false;
            activeThinkingRef.current = null;
            setHasThinkingMessage(false);
            // Log request completion
            // Snapshot the trace before the updater. `setRuntimeActivity`'s callback
            // runs LATER, after React schedules it, so the `if` above narrows nothing
            // inside it — and a ref is mutable, so by the time it runs
            // `requestTraceRef.current` may legitimately be a different object or
            // null. Reading the fields off a captured const is not just what makes
            // this type-check; it is what makes the reported activity belong to the
            // request that finished, rather than to whichever one is current when
            // React gets round to it.
            const finishedTrace = requestTraceRef.current;
            if (finishedTrace) {
              const duration = Date.now() - finishedTrace.startTime;
              setRuntimeActivity((prev) => ({
                ...prev,
                phase: 'done',
                backend: finishedTrace.backend,
                modelId: finishedTrace.model_id,
                startedAt: finishedTrace.startTime,
                updatedAt: Date.now(),
                elapsedMs: duration,
              }));
              console.log(
                `%c[RequestTrace]%c FINISH | ${finishedTrace.backend} → ${finishedTrace.model_id} | ${duration}ms | ${new Date().toISOString()}`,
                'color: #52c41a; font-weight: bold',
                'color: inherit'
              );
              requestTraceRef.current = null;
            }
          }
          break;
        case 'text':
        case 'content': {
          // First content token — AI has started responding, clear processing indicator
          if (!hasContentInTurnRef.current) {
            hasContentInTurnRef.current = true;
            setAiProcessing(false);
            aiProcessingRef.current = false;
          }
          setRuntimeActivity((prev) => ({
            ...prev,
            phase: 'streaming',
            backend: requestTraceRef.current?.backend ?? prev.backend,
            modelId: requestTraceRef.current?.model_id ?? prev.modelId,
            startedAt: requestTraceRef.current?.startTime ?? prev.startedAt ?? Date.now(),
            updatedAt: Date.now(),
          }));
          // Auto-recover running state only if turn hasn't finished
          if (!runningRef.current && !turnFinishedRef.current) {
            setRunning(true);
            runningRef.current = true;
          }
          // Clear thought when final answer arrives
          setThought({ subject: '', description: '' });
          commitMessage(transformedMessage);
          break;
        }
        case 'agent_status': {
          // Auto-recover running state only if turn hasn't finished
          if (!runningRef.current && !turnFinishedRef.current) {
            setRunning(true);
            runningRef.current = true;
          }
          // Update ACP/Agent status
          const agentData = message.data as {
            status?: 'connecting' | 'connected' | 'authenticated' | 'session_active' | 'disconnected' | 'error';
            backend?: string;
          };
          if (agentData?.status) {
            setAcpStatus(agentData.status);
            setRuntimeActivity((prev) => ({
              ...prev,
              phase:
                agentData.status === 'connecting'
                  ? 'connecting'
                  : agentData.status === 'connected' ||
                      agentData.status === 'authenticated' ||
                      agentData.status === 'session_active'
                    ? 'ready'
                    : agentData.status === 'error'
                      ? 'error'
                      : 'idle',
              backend: agentData.backend ?? prev.backend,
              modelId: prev.modelId,
              startedAt: prev.startedAt,
              updatedAt: Date.now(),
            }));
            // Reset running state when authentication is complete
            if (['authenticated', 'session_active'].includes(agentData.status)) {
              setRunning(false);
              runningRef.current = false;
            }
            // Reset all loading states on error or disconnect so UI doesn't stay stuck
            if (['error', 'disconnected'].includes(agentData.status)) {
              setRunning(false);
              runningRef.current = false;
              setAiProcessing(false);
              aiProcessingRef.current = false;
              activeToolCallsRef.current.clear();
            }
          }
          commitMessage(transformedMessage);
          break;
        }
        case 'user_content':
          commitMessage(transformedMessage);
          break;
        case 'teammate_message': {
          const tmMsg = message.data as import('@/common/chat/chatLib').TMessage;
          if (tmMsg && tmMsg.conversation_id === conversation_id) {
            if (tmMsg.type === 'text') {
              const raw = tmMsg.content as unknown;
              if (typeof raw === 'string') {
                try {
                  const parsed = JSON.parse(raw) as Record<string, unknown>;
                  if (typeof parsed.content === 'string') {
                    tmMsg.content = {
                      content: parsed.content,
                      ...(parsed.teammate_message ? { teammateMessage: true } : {}),
                      ...(parsed.sender_name ? { senderName: parsed.sender_name as string } : {}),
                      ...(parsed.sender_backend ? { senderAgentType: parsed.sender_backend as string } : {}),
                      ...(parsed.sender_conversation_id
                        ? { senderConversationId: parsed.sender_conversation_id as string }
                        : {}),
                    };
                  }
                } catch {
                  /* keep original */
                }
              } else if (typeof raw === 'object' && raw !== null) {
                const obj = raw as Record<string, unknown>;
                if (obj.teammate_message && !obj.teammateMessage) {
                  tmMsg.content = {
                    content: (obj.content as string) ?? '',
                    teammateMessage: true,
                    ...(obj.sender_name ? { senderName: obj.sender_name as string } : {}),
                    ...(obj.sender_backend ? { senderAgentType: obj.sender_backend as string } : {}),
                    ...(obj.sender_conversation_id
                      ? { senderConversationId: obj.sender_conversation_id as string }
                      : {}),
                  };
                }
              }
            }
            commitMessage(tmMsg);
          }
          break;
        }
        case 'acp_tool_call': {
          const externalWriteBlock = classifyAcpExternalWriteBlock(message.data);
          if (externalWriteBlock) {
            // Replay/duplicate: the original failed card, stop request, staging
            // request and Preview opening already own this tool call.
            if (recoveredExternalWriteCallIdsRef.current.has(externalWriteBlock.toolCallId)) break;
            const failedTurnId = typeof message.turn_id === 'string' ? message.turn_id.trim() : '';
            const activeTurnId = getConversationRuntimeViewSnapshot(conversation_id).activeTurnId;
            if (!failedTurnId || !activeTurnId || failedTurnId !== activeTurnId) {
              // A missing/stale failure frame may still be shown, but it must
              // never terminalize or cancel a newer turn and must never stage
              // old report bytes into that turn's workspace.
              commitMessage(transformedMessage);
              break;
            }
            recoveredExternalWriteCallIdsRef.current.add(externalWriteBlock.toolCallId);

            // Preserve the existing ACP card as the visible failure receipt,
            // then terminalize every local running surface immediately. The
            // display-only watchdog remains unchanged and grants no authority.
            commitMessage(transformedMessage);
            turnFinishedRef.current = true;
            setRunning(false);
            runningRef.current = false;
            setAiProcessing(false);
            aiProcessingRef.current = false;
            activeToolCallsRef.current.clear();
            pendingImageBindsRef.current.clear();
            activeThinkingRef.current = null;
            clearThinkingMessageThrottle();
            setThought({ subject: '', description: '' });
            setHasThinkingMessage(false);
            hasThinkingMessageRef.current = false;
            hasContentInTurnRef.current = false;
            requestTraceRef.current = null;
            setRuntimeActivity((prev) => ({
              ...prev,
              phase: 'error',
              updatedAt: Date.now(),
              elapsedMs: prev.startedAt ? Math.max(0, Date.now() - prev.startedAt) : prev.elapsedMs,
              detail: 'external_write_hard_blocked',
            }));
            clearConversationGenerating(conversation_id);

            // The failed frame's own turn identity was proven equal to the
            // active runtime turn above. Cancel exactly once and only then ask
            // Main to stage. Neither step retries or falls back to another path.
            void (async () => {
              try {
                await ipcBridge.conversation.stop.invoke({ conversation_id, turn_id: failedTurnId });
              } catch {
                return;
              }

              try {
                const staged = await ipcBridge.report.stageWorkspace.invoke({
                  conversation_id,
                  turn_id: failedTurnId,
                  tool_call_id: externalWriteBlock.toolCallId,
                  markdown: externalWriteBlock.markdown,
                  suggested_name: externalWriteBlock.suggestedName,
                });
                const fileName = staged?.success && staged.data?.ok ? staged.data.file_name : undefined;
                if (!fileName || fileName.length > 255 || fileName.includes('/') || fileName.includes('\\')) return;
                emitter.emit('preview.open', {
                  content: externalWriteBlock.markdown,
                  contentType: 'markdown',
                  metadata: {
                    title: fileName.replace(/\.md$/i, ''),
                    file_name: fileName,
                    conversation_id,
                  },
                });
              } catch {
                // Staging is a single bounded attempt. The failed ACP card is
                // already visible; never retry an alternate tool or path.
              }
            })();
            break;
          }

          const activeToolName = getFirstActiveToolName(activeToolCallsRef.current);
          if (!runningRef.current && !turnFinishedRef.current) {
            setRunning(true);
            runningRef.current = true;
          }
          // 1.820.3 — collect staged image references as the tool outputs
          // arrive; they are BOUND at the terminal finish, not here, because
          // only the finished turn proves the image belongs to this
          // conversation's display. The parser is pure; a miss means "nothing
          // to bind", never an error.
          const imageBind = collectImageBindFromToolCallUpdate(
            (message.data as AcpToolActivityWire | undefined)?.update
          );
          if (imageBind) pendingImageBindsRef.current.set(imageBind.toolCallId, imageBind.handle);
          // B1 (CEVE-1821) — SHOW the browser arm. EVE has had the browser tools
          // on this lane all along (`hermes-acp` in the bundled wheel) and the
          // URL-preview panel has been fully built and never once told to open.
          //
          // BOUND ON ARRIVAL, deliberately unlike the image bind above: a
          // navigation is live state, and a page the user only sees after the
          // turn finishes is a log entry, not a browser. The parser is pure and
          // returns undefined on every miss, and it accepts only http/https —
          // this url goes straight into a real <webview>.
          const browserNav = collectBrowserNavigationFromToolCallUpdate(
            (message.data as AcpToolActivityWire | undefined)?.update
          );
          // B7 (CEVE-1821) — SHOW what EVE builds. Phase one: remember the path an
          // html `write_file` START names. The file is not on disk yet and the
          // approval may still be pending, so nothing is opened here.
          const htmlWrite = collectHtmlWriteFromToolCallStart(
            (message.data as AcpToolActivityWire | undefined)?.update,
            (fileName) => getFileTypeInfo(fileName).contentType
          );
          if (htmlWrite) pendingHtmlWritesRef.current.set(htmlWrite.toolCallId, htmlWrite.path);
          // Phase two: that tool call COMPLETED, so the file exists. Open it from
          // DISK via launchPreview rather than from the diff on the wire — the diff
          // can be truncated, the file is the truth.
          const completedCallId = isCompletedToolCallUpdate((message.data as AcpToolActivityWire | undefined)?.update);
          if (completedCallId) {
            const writtenPath = pendingHtmlWritesRef.current.get(completedCallId);
            pendingHtmlWritesRef.current.delete(completedCallId);
            if (writtenPath && shouldOpenHtmlPreview(writtenPath, lastHtmlPreviewPathRef.current)) {
              lastHtmlPreviewPathRef.current = writtenPath;
              const info = getFileTypeInfo(writtenPath);
              void launchPreview({
                relativePath: writtenPath,
                originalPath: writtenPath,
                file_name: writtenPath.split(/[\\/]/).pop() || writtenPath,
                contentType: info.contentType,
                editable: info.editable,
                language: info.language,
              }).catch(() => {
                // A preview that cannot open costs the panel, never the turn.
              });
            }
          }
          if (browserNav && shouldOpenBrowserPreview(browserNav.url, lastBrowserPreviewUrlRef.current)) {
            lastBrowserPreviewUrlRef.current = browserNav.url;
            emitter.emit('preview.open', {
              content: browserNav.url,
              contentType: 'url',
              metadata: { title: browserNav.title, conversation_id },
            });
          }
          setRuntimeActivity((prev) => ({
            ...prev,
            phase: activeToolName ? 'tool_wait' : 'streaming',
            backend: requestTraceRef.current?.backend ?? prev.backend,
            modelId: requestTraceRef.current?.model_id ?? prev.modelId,
            startedAt: requestTraceRef.current?.startTime ?? prev.startedAt ?? now,
            updatedAt: now,
            detail: activeToolName,
          }));
          commitMessage(transformedMessage);
          break;
        }
        case 'acp_permission': {
          // Auto-recover running state only if turn hasn't finished
          if (!runningRef.current && !turnFinishedRef.current) {
            setRunning(true);
            runningRef.current = true;
          }

          // Renderer fallback. Hermes already consumes routine authority, so any
          // EVE permission that reaches this layer is an escalation and remains a
          // visible manual gate. Other ACP backends retain their native renderer
          // auto-mode behavior through resolveAcpAutoApprove.
          const request = message.data as AcpPermissionRequest | undefined;
          const callId = request?.tool_call?.tool_call_id || message.msg_id;
          const decision = resolveAcpAutoApprove(permissionModeRef.current, request, permissionBackendRef.current);
          if (decision.autoApprove && decision.optionId) {
            // Already auto-answered this call (stream replay/reconnect): silently
            // no-op. confirmMessage is not idempotent and the dialog must NOT pop
            // for a request we already allowed.
            if (autoApprovedCallIdsRef.current.has(callId)) {
              break;
            }
            autoApprovedCallIdsRef.current.add(callId);
            void conversationBridge.confirmMessage
              .invoke({
                confirm_key: decision.optionId,
                msg_id: message.msg_id,
                conversation_id: message.conversation_id,
                call_id: callId,
              })
              .catch((error: unknown) => {
                // If the auto-allow POST fails, fall back to the manual dialog so
                // the user is never silently stuck waiting on an agent that asked.
                autoApprovedCallIdsRef.current.delete(callId);
                console.warn('[useAcpMessage] auto-approve failed, falling back to dialog:', error);
                commitMessage(transformedMessage);
              });
            // Do NOT render the gating dialog for an auto-approved request.
            break;
          }

          commitMessage(transformedMessage);
          break;
        }
        case 'acp_model_info':
          // Model info updates are handled by AcpModelSelector, no action needed here
          break;
        case 'slash_commands_updated':
          // Slash commands became available (often during bootstrap when
          // agent_status events are suppressed). Update acpStatus so
          // useSlashCommands re-fetches.
          setAcpStatus((prev) => prev ?? 'session_active');
          break;
        case 'available_commands': {
          const cmdData = message.data as { commands?: AvailableCommand[] };
          if (cmdData?.commands && Array.isArray(cmdData.commands)) {
            // Use the shared mapper so hint + empty-turn tip metadata survive,
            // matching the HTTP slash-command path (useSlashCommands).
            setSlashCommands(mapAcpCommandsToSlashCommands(cmdData.commands));
          }
          break;
        }
        case 'acp_context_usage': {
          applyContextUsage(message.data as { used: number; size: number });
          break;
        }
        case 'request_trace':
          {
            const trace = message.data as Record<string, unknown>;
            // Bound as well as stored: the updater below reads the trace that this
            // event carries, not "whatever the ref holds when React runs the
            // callback". Same reasoning as the 'done' branch above.
            const startedTrace = {
              startTime: Number(trace.timestamp) || Date.now(),
              backend: String(trace.backend || 'unknown'),
              model_id: String(trace.model_id || 'unknown'),
              session_mode: trace.session_mode as string | undefined,
            };
            requestTraceRef.current = startedTrace;
            if (typeof trace.backend === 'string') {
              permissionBackendRef.current = trace.backend;
            }
            if (typeof trace.session_mode === 'string' && !hasLocalPermissionAuthorityRef.current) {
              permissionModeRef.current = trace.session_mode;
            }
            setRuntimeActivity((prev) => ({
              ...prev,
              phase: 'thinking',
              backend: startedTrace.backend,
              modelId: startedTrace.model_id,
              startedAt: startedTrace.startTime,
              updatedAt: Date.now(),
            }));
            console.log(
              `%c[RequestTrace]%c START | ${trace.backend} → ${trace.model_id} | ${new Date().toISOString()}`,
              'color: #1890ff; font-weight: bold',
              'color: inherit',
              trace
            );
          }
          break;
        case 'error': {
          // Lane-3 402 wall: capture whether a turn was in-flight BEFORE the
          // resets below clear it (idle-suppression keys off jobInFlight). Then
          // feed the raw error to the quota-wall controller — a genuine 402
          // quota_exhausted surfaces <QuotaExhaustedWall/>; anything else is a
          // no-op so the existing error message rendering is untouched.
          const jobWasInFlight = runningRef.current || aiProcessingRef.current;
          const quotaSignal = reportInferenceError(message.data, { jobInFlight: jobWasInFlight });
          // M-quotawall-suppress (Codex): a recognized quota/daily-cap signal shows a
          // full warm wall (QuotaExhaustedWall / DailyCapWall) — but ONLY when a turn
          // was in-flight (both walls idle-suppress on jobInFlight). In that exact
          // case the cold error bubble is redundant and contradicts the v1.6 warm-wall
          // fix (Alois saw the warm wall AND the raw error bubble), so skip it.
          // Otherwise (no signal, or not in-flight ⇒ no wall surfaces) fall through to
          // the cold bubble so an error is NEVER silently swallowed.
          const suppressColdError = quotaSignal && jobWasInFlight;

          // Stop all loading states when error occurs
          turnFinishedRef.current = true;
          setRunning(false);
          runningRef.current = false;
          setAiProcessing(false);
          aiProcessingRef.current = false;
          activeToolCallsRef.current.clear();
          activeThinkingRef.current = null;
          if (!suppressColdError) commitMessage(transformedMessage);
          // Log request error
          const failedTrace = requestTraceRef.current;
          if (failedTrace) {
            const duration = Date.now() - failedTrace.startTime;
            setRuntimeActivity((prev) => ({
              ...prev,
              phase: 'error',
              backend: failedTrace.backend,
              modelId: failedTrace.model_id,
              startedAt: failedTrace.startTime,
              updatedAt: Date.now(),
              elapsedMs: duration,
              detail: typeof message.data === 'string' ? message.data : undefined,
            }));
            console.log(
              `%c[RequestTrace]%c ERROR | ${failedTrace.backend} → ${failedTrace.model_id} | ${duration}ms | ${new Date().toISOString()}`,
              'color: #ff4d4f; font-weight: bold',
              'color: inherit',
              message.data
            );
            requestTraceRef.current = null;
          }
          break;
        }
        default:
          // Auto-recover running state only if turn hasn't finished
          if (!runningRef.current && !turnFinishedRef.current) {
            setRunning(true);
            runningRef.current = true;
          }
          commitMessage(transformedMessage);
          break;
      }
    },
    [
      conversation_id,
      commitMessage,
      completeActiveThinking,
      enqueueThinkingMessage,
      throttledSetThought,
      setThought,
      setRunning,
      setAiProcessing,
      setAcpStatus,
      applyContextUsage,
      reportInferenceError,
    ]
  );

  const handleResponseMessageRef = useRef(handleResponseMessage);

  useLayoutEffect(() => {
    handleResponseMessageRef.current = handleResponseMessage;
  }, [handleResponseMessage]);

  useEffect(() => {
    // Keep one listener for the lifetime of the mounted chat. Re-subscribing on
    // every stream-driven render creates a cleanup/setup gap in which fast text
    // or finish frames can be lost while the global activity listener still sees
    // them. The stable wrapper always dispatches to the latest handler instead.
    return ipcBridge.acpConversation.responseStream.on((message) => {
      handleResponseMessageRef.current(message);
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const pendingBufferedEvents = thinkingMessageThrottleRef.current.pending ? 1 : 0;
      const isActive = runningRef.current || aiProcessingRef.current || pendingBufferedEvents > 0;
      if (!isActive) return;
      const activeToolName = getFirstActiveToolName(activeToolCallsRef.current);

      const status = classifyAcpStreamWatchdog({
        now,
        lastBackendEventAt: lastBackendEventAtRef.current,
        lastRendererCommitAt: lastRendererCommitAtRef.current,
        pendingBufferedSinceAt: lastPendingBufferedAtRef.current,
        pendingBufferedEvents,
        activeToolName,
        runStopped: turnFinishedRef.current && !runningRef.current && !aiProcessingRef.current,
      });

      if (status === 'ui_backlog') {
        flushPendingThinkingMessage();
      }
      if (status !== 'ui_backlog' && status !== 'heartbeat_only' && status !== 'tool_wait' && status !== 'streaming') {
        return;
      }

      setRuntimeActivity((prev) => {
        if (prev.phase === 'done' || prev.phase === 'error') return prev;
        const nextDetail = status === 'tool_wait' ? activeToolName : undefined;
        const shouldRecoverFromWatchdogState =
          status === 'streaming' &&
          (prev.phase === 'heartbeat_only' || prev.phase === 'ui_backlog' || prev.phase === 'tool_wait');
        if (status === 'streaming' && !shouldRecoverFromWatchdogState) return prev;
        if (prev.phase === status && prev.detail === nextDetail) return prev;
        return {
          ...prev,
          phase: status,
          startedAt: prev.startedAt ?? requestTraceRef.current?.startTime ?? now,
          updatedAt: now,
          detail: nextDetail,
        };
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [flushPendingThinkingMessage]);

  // Drop stale authority before child passive hydration can publish the new
  // conversation's acknowledged grant.
  useLayoutEffect(() => {
    permissionModeRef.current = undefined;
    permissionBackendRef.current = undefined;
    hasLocalPermissionAuthorityRef.current = false;
    autoApprovedCallIdsRef.current = new Set();
    recoveredExternalWriteCallIdsRef.current = new Set();
  }, [conversation_id]);

  // Keep local permission authority current for the auto-approve path. Restrictive
  // selector events publish before the backend call, so revocation takes effect in
  // this renderer immediately even when setMode fails. Expansions publish only after
  // acknowledgement and successful grant persistence.
  // Register during layout so a child selector's passive hydration effect cannot
  // publish a persisted grant before this conversation listener exists.
  useLayoutEffect(() => {
    return addEventListener('acp.permission.mode', (evt) => {
      if (evt.conversation_id === conversation_id) {
        hasLocalPermissionAuthorityRef.current = true;
        permissionModeRef.current = evt.mode;
      }
    });
  }, [conversation_id]);

  // Reset state when conversation changes and restore actual running status
  useEffect(() => {
    let cancelled = false;

    setThought({ subject: '', description: '' });
    setAcpStatus(null);
    setTokenUsage(null);
    setContextLimit(0);
    setSlashCommands([]);
    setRuntimeActivity({ phase: 'idle', updatedAt: Date.now() });
    hasContentInTurnRef.current = false;
    turnFinishedRef.current = false;
    hasThinkingMessageRef.current = false;
    activeThinkingRef.current = null;
    lastBackendEventAtRef.current = undefined;
    lastRendererCommitAtRef.current = undefined;
    lastPendingBufferedAtRef.current = undefined;
    activeToolCallsRef.current.clear();
    clearThinkingMessageThrottle();
    setHasThinkingMessage(false);
    setHasHydratedRunningState(false);
    // Clear running/processing immediately for the new conversation. Hydration only
    // turns these back on when the backend reports status === 'running'. Otherwise
    // conversation.get's idle branch raced with useAcpInitialMessage's
    // setAiProcessing(true) and hid ThoughtDisplay until the first stream event.
    setRunning(false);
    runningRef.current = false;
    setAiProcessing(false);
    aiProcessingRef.current = false;

    void ipcBridge.conversation.get
      .invoke({ id: conversation_id })
      .then((res) => {
        if (cancelled) {
          return;
        }

        if (!res) {
          setRunning(false);
          runningRef.current = false;
          setAiProcessing(false);
          aiProcessingRef.current = false;
          setHasHydratedRunningState(true);
          return;
        }
        const isRunning = res.status === 'running';
        setRunning(isRunning);
        runningRef.current = isRunning;
        if (isRunning) {
          setAiProcessing(true);
          aiProcessingRef.current = true;
          setRuntimeActivity((prev) => ({
            ...prev,
            phase: 'thinking',
            backend: prev.backend,
            modelId: prev.modelId,
            startedAt: Date.now(),
            updatedAt: Date.now(),
          }));
        }
        setHasHydratedRunningState(true);

        // Restore persisted context usage data
        if (res.type === 'acp' && res.extra?.last_token_usage) {
          const { last_token_usage, last_context_limit } = res.extra;
          if (last_token_usage.total_tokens > 0) {
            setTokenUsage(last_token_usage);
          }
          if (last_context_limit && last_context_limit > 0) {
            setContextLimit(last_context_limit);
          }
        }

        // Non-EVE ACP agents retain their session-local persisted mode. EVE does
        // not trust this value because its founder-selected preference is global;
        // AgentModeSelector publishes the live mode only after backend config
        // acknowledgement, and request_trace provides the same backend truth.
        if (res.type === 'acp' && typeof res.extra?.backend === 'string') {
          permissionBackendRef.current = res.extra.backend;
        }
        if (
          res.type === 'acp' &&
          !isCommandEveAcpConversation(res.extra?.backend) &&
          typeof res.extra?.session_mode === 'string'
        ) {
          permissionModeRef.current = res.extra.session_mode;
        }
      })
      .catch((error: unknown) => {
        // A failed conversation lookup (e.g. transient "Failed to fetch") must
        // not leave the hook stuck un-hydrated — complete hydration in the idle
        // state so ThoughtDisplay/running indicators resolve. Unexpected errors
        // still surface.
        if (cancelled) return;
        setRunning(false);
        runningRef.current = false;
        setAiProcessing(false);
        aiProcessingRef.current = false;
        setHasHydratedRunningState(true);

        if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
          console.warn('[useAcpMessage] Failed to hydrate conversation state:', error);
          return;
        }

        throw error;
      });

    return () => {
      cancelled = true;
    };
  }, [conversation_id, clearThinkingMessageThrottle]);

  // Fetch slash commands via HTTP after warmup completes.
  // WebSocket push of available_commands arrives during warmup when no
  // StreamRelay is listening, so the initial load must come from HTTP.
  // Mirrors the aionrs pattern: warmup first, then fetch.
  // In team mode, warmup is deferred to first user input — skip here.
  useEffect(() => {
    if (options?.skipWarmup) return;
    let cancelled = false;
    void warmupConversation(conversation_id)
      .then(async () => {
        if (cancelled) return;
        const [commands, usage] = await Promise.all([
          ipcBridge.conversation.getSlashCommands.invoke({ conversation_id }),
          ipcBridge.conversation.getUsage.invoke({ conversation_id }),
        ]);
        return { commands, usage };
      })
      .then((result) => {
        if (cancelled) return;
        if (!result) return;
        applyContextUsage(result.usage);
        if (Array.isArray(result.commands) && result.commands.length > 0) {
          setSlashCommands(
            result.commands.map((c) => ({
              name: c.command,
              description: c.description,
              kind: 'template' as const,
              source: 'acp' as const,
              selectionBehavior: 'insert' as const,
            }))
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [applyContextUsage, conversation_id, options?.skipWarmup]);

  const resetState = useCallback(() => {
    turnFinishedRef.current = true;
    setRunning(false);
    runningRef.current = false;
    setAiProcessing(false);
    aiProcessingRef.current = false;
    setThought({ subject: '', description: '' });
    setRuntimeActivity((prev) => ({
      ...prev,
      phase: 'idle',
      backend: prev.backend,
      modelId: prev.modelId,
      updatedAt: Date.now(),
    }));
    hasContentInTurnRef.current = false;
    hasThinkingMessageRef.current = false;
    activeThinkingRef.current = null;
    lastBackendEventAtRef.current = undefined;
    lastRendererCommitAtRef.current = undefined;
    lastPendingBufferedAtRef.current = undefined;
    activeToolCallsRef.current.clear();
    clearThinkingMessageThrottle();
    setHasThinkingMessage(false);
  }, [clearThinkingMessageThrottle]);

  useEffect(() => {
    return addEventListener('conversation.runtime.recovered', (event) => {
      if (event.conversation_id !== conversation_id || event.runtime.is_processing) return;
      const runtimeView = getConversationRuntimeViewSnapshot(conversation_id);
      if (
        runtimeView.localSubmitting ||
        (runtimeView.isProcessing &&
          runtimeView.activeTurnId !== null &&
          runtimeView.activeTurnId !== event.recoveredTurnId)
      ) {
        return;
      }
      // Durable runtime truth repairs the UI when the terminal stream frame was
      // missed. This clears both the composer state and the seat-switch guard.
      resetState();
      clearConversationGenerating(conversation_id);
    });
  }, [conversation_id, resetState]);

  const fetchSlashCommands = useCallback(() => {
    void ipcBridge.conversation.getSlashCommands
      .invoke({ conversation_id })
      .then((result) => {
        if (!result || !Array.isArray(result) || result.length === 0) return;
        setSlashCommands(
          result.map((c) => ({
            name: c.command,
            description: c.description,
            kind: 'template' as const,
            source: 'acp' as const,
            selectionBehavior: 'insert' as const,
          }))
        );
      })
      .catch(() => {});
  }, [conversation_id]);

  return {
    thought,
    setThought,
    running,
    hasHydratedRunningState,
    acpStatus,
    aiProcessing,
    setAiProcessing,
    resetState,
    tokenUsage,
    context_limit,
    hasThinkingMessage,
    slashCommands,
    fetchSlashCommands,
    runtimeActivity,
    quotaWall,
  };
};
