import { ipcBridge } from '@/common';

export type WarmupConversationPhase = 'idle' | 'preparing' | 'ready' | 'error';

export type WarmupConversationStatus = {
  phase: WarmupConversationPhase;
  attempt: number;
  errorMessage?: string;
};

const IDLE_STATUS: WarmupConversationStatus = {
  phase: 'idle',
  attempt: 0,
};

export const MAX_CONCURRENT_CONVERSATION_WARMUPS = 1;
export const MAX_ACTIVE_CONVERSATION_RUNTIMES = 5;
export const MAX_CONVERSATION_WARMUP_FAILURES = 3;
export const CONVERSATION_WARMUP_RETRY_COOLDOWN_MS = 30_000;

type WarmupFailureBudget = {
  failures: number;
  blockedUntil: number;
};

export class ConversationWarmupBlockedError extends Error {
  constructor(
    readonly code: 'WARMUP_ACTIVE_RUNTIME_CAP' | 'WARMUP_RETRY_COOLDOWN',
    message: string
  ) {
    super(message);
    this.name = 'ConversationWarmupBlockedError';
  }
}

const warmupByConversation = new Map<string, Promise<void>>();
const statusByConversation = new Map<string, WarmupConversationStatus>();
const listenersByConversation = new Map<string, Set<() => void>>();
const failureBudgetByConversation = new Map<string, WarmupFailureBudget>();
let warmupQueueTail: Promise<void> = Promise.resolve();

function emitWarmupStatus(conversation_id: string): void {
  listenersByConversation.get(conversation_id)?.forEach((listener) => listener());
}

function setWarmupStatus(conversation_id: string, status: WarmupConversationStatus): void {
  statusByConversation.set(conversation_id, status);
  emitWarmupStatus(conversation_id);
}

export function getWarmupConversationStatus(conversation_id?: string): WarmupConversationStatus {
  if (!conversation_id) {
    return IDLE_STATUS;
  }
  return statusByConversation.get(conversation_id) ?? IDLE_STATUS;
}

export function subscribeWarmupConversation(conversation_id: string, listener: () => void): () => void {
  const listeners = listenersByConversation.get(conversation_id) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByConversation.set(conversation_id, listeners);

  return () => {
    const current = listenersByConversation.get(conversation_id);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      listenersByConversation.delete(conversation_id);
    }
  };
}

function retryCooldownError(conversation_id: string, now: number): ConversationWarmupBlockedError | null {
  const budget = failureBudgetByConversation.get(conversation_id);
  if (!budget) return null;
  if (budget.blockedUntil === 0) return null;
  if (budget.blockedUntil <= now) {
    failureBudgetByConversation.delete(conversation_id);
    return null;
  }
  return new ConversationWarmupBlockedError(
    'WARMUP_RETRY_COOLDOWN',
    `Conversation warmup is paused after ${budget.failures} failed attempts. Retry after the cooldown.`
  );
}

async function runWarmupWithBackpressure(conversation_id: string, allowAtCapacity = false): Promise<void> {
  const active = await ipcBridge.conversation.activeCount.invoke();
  if (!active || !Number.isFinite(active.count) || active.count < 0) {
    throw new ConversationWarmupBlockedError(
      'WARMUP_ACTIVE_RUNTIME_CAP',
      'Conversation runtime capacity could not be verified.'
    );
  }
  if (active.count >= MAX_ACTIVE_CONVERSATION_RUNTIMES && !allowAtCapacity) {
    throw new ConversationWarmupBlockedError(
      'WARMUP_ACTIVE_RUNTIME_CAP',
      `Conversation runtime capacity reached (${active.count}/${MAX_ACTIVE_CONVERSATION_RUNTIMES}).`
    );
  }
  await ipcBridge.conversation.warmup.invoke({ conversation_id });
}

export function warmupConversation(conversation_id: string, options: { revalidate?: boolean } = {}): Promise<void> {
  const existing = warmupByConversation.get(conversation_id);
  if (existing) {
    return existing;
  }

  const previous = getWarmupConversationStatus(conversation_id);
  if (previous.phase === 'ready' && !options.revalidate) {
    return Promise.resolve();
  }

  const cooldownError = retryCooldownError(conversation_id, Date.now());
  if (cooldownError) {
    setWarmupStatus(conversation_id, {
      phase: 'error',
      attempt: previous.attempt,
      errorMessage: cooldownError.message,
    });
    return Promise.reject(cooldownError);
  }

  const nextAttempt = previous.attempt + 1;
  setWarmupStatus(conversation_id, {
    phase: 'preparing',
    attempt: nextAttempt,
  });

  // One global queue is intentional: warmup can materialize a complete ACP
  // process and MCP fleet. Serializing different conversations prevents rapid
  // navigation or remounts from spawning an unbounded burst.
  const revalidatingReadyRuntime = previous.phase === 'ready' && options.revalidate === true;
  const queuedWarmup = warmupQueueTail
    .catch(() => {})
    .then(() => runWarmupWithBackpressure(conversation_id, revalidatingReadyRuntime));
  warmupQueueTail = queuedWarmup.catch(() => {});

  const promise = queuedWarmup
    .then(() => {
      failureBudgetByConversation.delete(conversation_id);
      setWarmupStatus(conversation_id, {
        phase: 'ready',
        attempt: nextAttempt,
      });
    })
    .catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const priorFailures = failureBudgetByConversation.get(conversation_id)?.failures ?? 0;
      const failures = priorFailures + 1;
      failureBudgetByConversation.set(conversation_id, {
        failures,
        blockedUntil:
          failures >= MAX_CONVERSATION_WARMUP_FAILURES ? Date.now() + CONVERSATION_WARMUP_RETRY_COOLDOWN_MS : 0,
      });
      setWarmupStatus(conversation_id, {
        phase: 'error',
        attempt: nextAttempt,
        errorMessage,
      });
      throw error;
    })
    .finally(() => {
      warmupByConversation.delete(conversation_id);
    });

  warmupByConversation.set(conversation_id, promise);
  return promise;
}

export function resetWarmupConversationStateForTests(): void {
  warmupByConversation.clear();
  statusByConversation.clear();
  listenersByConversation.clear();
  failureBudgetByConversation.clear();
  warmupQueueTail = Promise.resolve();
}
