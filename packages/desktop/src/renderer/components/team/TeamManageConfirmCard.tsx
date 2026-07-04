/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SG-1 Design B — the team_manage confirm card.
 *
 * EVE PROPOSES, code applies. This card is the visible, button-only gate between
 * a proposal and the actual team-status write. It POLLS main for a pending intent
 * (so it re-appears after a renderer restart — B4) and, when one exists, surfaces a
 * floating card with the German diff + EVE's reason + the honesty text (B6). Only a
 * button click applies (B3 — there is NO auto-approve path; this is a governance
 * gate above tool-permission "Nicht fragen", so YOLO never touches it).
 */

import { ipcBridge } from '@/common';
import { Button, Card, Message, Typography } from '@arco-design/web-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

const { Text, Paragraph } = Typography;

interface PendingIntent {
  intent_id: string;
  role_agent_id: string;
  action: string;
  summary: string;
  reason: string;
  expires_ms: number;
}

const POLL_MS = 4000;

// B6 — the mandatory honesty text: the card must never promise more than Design A
// actually enforces. Pausing stops NEW delegate dispatches of the role; EVE's own
// in-session work stays on the shared account until the 1.8 wheel train.
const HONESTY_TEXT =
  'Pausieren stoppt neue Einsätze dieser Rolle als eigener Worker. Arbeit, die EVE selbst übernimmt, läuft auf dem gemeinsamen Konto bis zu einem späteren Update weiter.';

const TeamManageConfirmCard: React.FC = () => {
  const [pending, setPending] = useState<PendingIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const poll = useCallback(async () => {
    try {
      const res = await ipcBridge.commandEve.teamManagePeek.invoke();
      const next = (res?.data?.pending ?? null) as PendingIntent | null;
      if (mounted.current) setPending((prev) => (prev && next && prev.intent_id === next.intent_id ? prev : next));
    } catch {
      /* best-effort poll */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(id);
    };
  }, [poll]);

  const onConfirm = useCallback(async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const res = await ipcBridge.commandEve.teamManageApply.invoke({ intent_id: pending.intent_id });
      if (res?.data?.ok) {
        Message.success('Team-Änderung übernommen.');
      } else {
        Message.info('Die Änderung konnte nicht angewendet werden (evtl. abgelaufen oder bereits geändert).');
      }
    } catch {
      Message.error('Team-Änderung fehlgeschlagen.');
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
      await ipcBridge.commandEve.teamManageReject.invoke({ intent_id: pending.intent_id });
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
      data-testid='team-manage-confirm-card'
    >
      <Card
        bordered
        style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}
        title={
          <span>
            <span role='img' aria-label='team' style={{ marginRight: 6 }}>
              🧑‍💼
            </span>
            EVE schlägt eine Team-Änderung vor
          </span>
        }
      >
        <Paragraph style={{ marginBottom: 6 }}>
          <Text bold>{pending.summary || `${pending.role_agent_id}: ${pending.action}`}</Text>
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
          <Button size='small' onClick={() => void onDismiss()} disabled={busy} data-testid='team-manage-dismiss'>
            Verwerfen
          </Button>
          <Button size='small' type='primary' loading={busy} onClick={() => void onConfirm()} data-testid='team-manage-confirm'>
            Übernehmen
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default TeamManageConfirmCard;
