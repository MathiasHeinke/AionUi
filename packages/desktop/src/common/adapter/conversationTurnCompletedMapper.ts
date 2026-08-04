import type { IConversationTurnCompletedEvent } from './ipcBridge';

/**
 * Map the backend turn-completion wire payload without inventing success.
 * Older AionCore builds omitted `state` and output proof; those events remain
 * `unknown`/false so a lifecycle `status=finished` can never provision work.
 */
export const mapConversationTurnCompletedEvent = (raw: unknown): IConversationTurnCompletedEvent => {
  const r = raw as Record<string, unknown>;
  const rawStatus = r.status;
  const status: IConversationTurnCompletedEvent['status'] =
    rawStatus === 'pending' || rawStatus === 'running' || rawStatus === 'finished' ? rawStatus : 'pending';
  const rawState = r.state;
  const state: IConversationTurnCompletedEvent['state'] =
    rawState === 'ai_generating' ||
    rawState === 'ai_waiting_input' ||
    rawState === 'ai_waiting_confirmation' ||
    rawState === 'initializing' ||
    rawState === 'stopped' ||
    rawState === 'error'
      ? rawState
      : 'unknown';
  const rawLast = (r.last_message ?? r.lastMessage) as Record<string, unknown> | undefined;
  const last_message: IConversationTurnCompletedEvent['last_message'] = rawLast
    ? {
        id: rawLast.id as string | undefined,
        type: rawLast.type as string | undefined,
        content: rawLast.content ?? null,
        status: rawLast.status as string | null | undefined,
        created_at: (rawLast.created_at ?? rawLast.createdAt ?? Date.now()) as number,
      }
    : {
        content: null,
        created_at: Date.now(),
      };
  const rawRuntime = (r.runtime ?? {}) as Record<string, unknown>;
  const runtime: IConversationTurnCompletedEvent['runtime'] = {
    state: (rawRuntime.state ?? 'idle') as IConversationTurnCompletedEvent['runtime']['state'],
    can_send_message: (rawRuntime.can_send_message ?? rawRuntime.canSendMessage ?? true) as boolean,
    has_task: (rawRuntime.has_task ?? rawRuntime.hasTask ?? false) as boolean,
    task_status: (rawRuntime.task_status ??
      rawRuntime.taskStatus) as IConversationTurnCompletedEvent['runtime']['task_status'],
    is_processing: (rawRuntime.is_processing ?? rawRuntime.isProcessing ?? false) as boolean,
    pending_confirmations: (rawRuntime.pending_confirmations ?? rawRuntime.pendingConfirmations ?? 0) as number,
    turn_id: (rawRuntime.turn_id ?? rawRuntime.turnId ?? null) as string | null,
  };
  const rawModel = (r.model ?? {}) as Record<string, unknown>;
  const model: IConversationTurnCompletedEvent['model'] = {
    platform: (rawModel.platform ?? '') as string,
    name: (rawModel.name ?? '') as string,
    use_model: (rawModel.use_model ?? rawModel.useModel ?? '') as string,
  };

  return {
    session_id: (r.session_id ?? r.sessionId ?? r.conversation_id ?? '') as string,
    turn_id: (r.turn_id ?? r.turnId ?? runtime.turn_id ?? '') as string,
    status,
    state,
    detail: (r.detail ?? '') as string,
    can_send_message: r.can_send_message === true || r.canSendMessage === true,
    has_substantive_output: r.has_substantive_output === true || r.hasSubstantiveOutput === true,
    runtime,
    workspace: (r.workspace ?? '') as string,
    model,
    last_message,
  };
};
