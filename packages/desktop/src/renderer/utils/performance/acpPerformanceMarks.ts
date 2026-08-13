export const ACP_PERFORMANCE_MARK_EVENT = 'command-eve:acp-performance-mark';

export type AcpPerformanceStage =
  | 'request_accepted'
  | 'acp_session_ready'
  | 'model_request_started'
  | 'acp_first_text'
  | 'response_finished'
  | 'turn_cancel_acknowledged'
  | 'turn_cancel_failed'
  | 'turn_cancel_requested'
  | 'tts_playback_started';

export type AcpPerformanceMark = {
  version: 'command-eve-acp-performance-mark/v1';
  stage: AcpPerformanceStage;
  conversationId: string;
  turnId?: string;
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
}): AcpPerformanceMark {
  const mark: AcpPerformanceMark = {
    version: 'command-eve-acp-performance-mark/v1',
    stage: input.stage,
    conversationId: input.conversationId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    atEpochMs: Date.now(),
    atMonotonicMs: typeof performance === 'undefined' ? null : performance.now(),
  };
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<AcpPerformanceMark>(ACP_PERFORMANCE_MARK_EVENT, { detail: mark }));
  }
  return mark;
}
