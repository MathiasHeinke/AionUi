import { Message } from '@arco-design/web-react';
import i18n from 'i18next';
import { ipcBridge } from '@/common';
import { resolveProjectWorkspaceI18n } from '@/renderer/pages/projects/i18nRef';

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
      // Localize the main-process clarification via its i18n ref when present
      // (1.818 CAO-P2); the raw question is the English fallback.
      Message.info(
        result.question_i18n
          ? resolveProjectWorkspaceI18n(result.question_i18n, i18n.t.bind(i18n), result.question)
          : result.question
      );
    }
  } catch {
    // fail-open: intent gate never blocks sending
  }
}
