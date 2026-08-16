export const ACP_PERFORMANCE_MARK_EVENT = 'command-eve:acp-performance-mark';

export type AcpPerformanceStage =
  | 'submit_started'
  | 'runtime_activity_visible'
  | 'warmup_started'
  | 'warmup_joined'
  | 'warmup_skipped'
  | 'runtime_resident'
  | 'warmup_ready'
  | 'warmup_failed'
  | 'warmup_timeout'
  | 'request_accepted'
  | 'turn_admitted'
  | 'acp_session_ready'
  | 'model_request_started'
  | 'first_output_state'
  | 'acp_first_text'
  | 'response_finished'
  | 'response_error'
  | 'turn_cancel_acknowledged'
  | 'turn_cancel_failed'
  | 'turn_cancel_requested'
  | 'tts_playback_started';

export type AcpPerformanceMark = {
  version: 'command-eve-acp-performance-mark/v1';
  stage: AcpPerformanceStage;
  conversationId: string;
  turnId?: string;
  messageId?: string;
  attemptId?: number;
  seatGeneration?: number;
  outputKind?: 'text' | 'thought' | 'tool';
  outcome?: 'ready' | 'failed' | 'timeout';
  atEpochMs: number;
  atMonotonicMs: number | null;
};

/**
 * Renderer-local, content-free performance mark. The benchmark listens for the
 * DOM event; production emits no prompt, response, provider key or model name.
 */
export function emitAcpPerformanceMark(input: {
  stage: AcpPerformanceStage;
  conversationId: string;
  turnId?: string;
  messageId?: string;
  attemptId?: number;
  seatGeneration?: number;
  outputKind?: 'text' | 'thought' | 'tool';
  outcome?: 'ready' | 'failed' | 'timeout';
}): AcpPerformanceMark {
  const mark: AcpPerformanceMark = {
    version: 'command-eve-acp-performance-mark/v1',
    stage: input.stage,
    conversationId: input.conversationId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(Number.isSafeInteger(input.attemptId) ? { attemptId: input.attemptId } : {}),
    ...(Number.isSafeInteger(input.seatGeneration) ? { seatGeneration: input.seatGeneration } : {}),
    ...(input.outputKind ? { outputKind: input.outputKind } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    atEpochMs: Date.now(),
    atMonotonicMs: typeof performance === 'undefined' ? null : performance.now(),
  };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AcpPerformanceMark>(ACP_PERFORMANCE_MARK_EVENT, { detail: mark }));
  }
  return mark;
}
