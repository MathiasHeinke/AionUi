import { Message } from '@arco-design/web-react';
import { ipcBridge } from '@/common';

const GATE_TIMEOUT_MS = 250;

/**
 * S81/R3 chat intent gate: bounded, fail-open pre-send project binding.
 * Never blocks or delays the send beyond the timeout budget; any failure
 * (no bridge, error, timeout) resolves to a plain pass-through send.
 */
export async function runProjectChatIntentGate(input: { conversation_id: string; message: string }): Promise<void> {
  const message = input.message.trim();
  if (!message || typeof window === 'undefined' || !window.electronAPI) return;
  try {
    const result = await Promise.race([
      ipcBridge.projectWorkspace.chatIntent.invoke({
        conversation_id: input.conversation_id,
        input: message,
        seat_context_revision: 0,
        idempotency_key: crypto.randomUUID(),
        deadline_ms: Date.now() + GATE_TIMEOUT_MS,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), GATE_TIMEOUT_MS)),
    ]);
    if (result && result.decision === 'needs_clarification') {
      Message.info(result.question);
    }
  } catch {
    // fail-open: intent gate never blocks sending
  }
}
