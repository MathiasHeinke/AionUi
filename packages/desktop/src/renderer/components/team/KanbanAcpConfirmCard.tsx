/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * COMPA-626 — the Kanban-ACP confirm card (Design-B mirror of TeamManageConfirmCard).
 *
 * EVE PROPOSES a kanban card change, code applies. This card is the visible, button-only
 * gate between a proposal and the actual kanban.db write. It POLLS main for a pending
 * intent (so it re-appears after a renderer restart) and, when one exists, surfaces a
 * floating card with the German summary + EVE's reason + the honesty text. By default only
 * a button click applies: the tool-permission "Nicht fragen" / YOLO never bypasses this
 * card. The ONE exception is the explicit operator opt-in `commandEve.kanbanAutoApprove`
 * (default false) — when the operator grants EVE direct clearance, proposals auto-apply
 * through the SAME governed write path (see KANBAN_ACP_AUTO_APPROVE_KEY in kanbanAcpMain),
 * scoped to create/move/action, never dispatch/spawn/delete. Apply carries the
 * mutation_hash so main can prove the confirmed change is the proposed one.
 */

import { ipcBridge } from '@/common';
import { Button, Card, Message, Typography } from '@arco-design/web-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

const { Text, Paragraph } = Typography;

interface PendingKanbanIntent {
  intent_id: string;
  op: string;
  action: string;
  summary: string;
  reason: string;
  mutation_hash: string;
  expires_ms: number;
}

const POLL_MS = 4000;

// The mandatory honesty text: the card never promises more than the gate enforces.
const HONESTY_TEXT =
  'EVE schlägt diese Änderung nur vor — sie wird erst geschrieben, wenn du auf „Übernehmen" klickst. EVE verschiebt oder erstellt nie selbst Karten.';

const KanbanAcpConfirmCard: React.FC = () => {
  const [pending, setPending] = useState<PendingKanbanIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const poll = useCallback(async () => {
    try {
      const res = await ipcBridge.commandEve.kanbanAcpPeek.invoke();
      const next = (res?.data?.pending ?? null) as PendingKanbanIntent | null;
      if (mounted.current) setPending((prev) => (prev && next && prev.intent_id === next.intent_id ? prev : next));
    } catch {
      /* best-effort poll */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void poll();
    // Perf (8GB audit): gate the IPC heartbeat on window visibility so a hidden window
    // stops keeping main awake; catch up with one poll when it returns to the foreground.
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void poll();
    };
    const id = setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void poll();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    return () => {
      mounted.current = false;
      clearInterval(id);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  const onConfirm = useCallback(async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const res = await ipcBridge.commandEve.kanbanAcpApply.invoke({
        intent_id: pending.intent_id,
        mutation_hash: pending.mutation_hash,
      });
      if (res?.data?.ok) {
        Message.success('Karten-Änderung übernommen.');
      } else {
        Message.info('Die Änderung konnte nicht angewendet werden (evtl. abgelaufen oder bereits geändert).');
      }
    } catch {
      Message.error('Karten-Änderung fehlgeschlagen.');
    } finally {
      if (mounted.current) {
        setPending(null);
        setBusy(false);
      }
    }
  }, [pending, busy]);

  const onDismiss = useCallback(async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      await ipcBridge.commandEve.kanbanAcpReject.invoke({ intent_id: pending.intent_id });
    } catch {
      /* dismiss is best-effort */
    } finally {
      if (mounted.current) {
        setPending(null);
        setBusy(false);
      }
    }
  }, [pending, busy]);

  if (!pending) return null;

  return (
    <div
      style={{ position: 'fixed', right: 20, bottom: 20, width: 380, zIndex: 1200, maxWidth: 'calc(100vw - 40px)' }}
      data-testid='kanban-acp-confirm-card'
    >
      <Card
        bordered
        style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}
        title={
          <span>
            <span role='img' aria-label='kanban' style={{ marginRight: 6 }}>
              🗂️
            </span>
            EVE schlägt eine Karten-Änderung vor
          </span>
        }
      >
        <Paragraph style={{ marginBottom: 6 }}>
          <Text bold>{pending.summary || `${pending.op}`}</Text>
        </Paragraph>
        {pending.reason ? (
          <Paragraph type='secondary' style={{ marginBottom: 10 }}>
            „{pending.reason}"
          </Paragraph>
        ) : null}
        <Paragraph type='secondary' style={{ fontSize: 12, marginBottom: 14 }}>
          {HONESTY_TEXT}
        </Paragraph>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button size='small' onClick={() => void onDismiss()} disabled={busy} data-testid='kanban-acp-dismiss'>
            Verwerfen
          </Button>
          <Button
            size='small'
            type='primary'
            loading={busy}
            onClick={() => void onConfirm()}
            data-testid='kanban-acp-confirm'
          >
            Übernehmen
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default KanbanAcpConfirmCard;
