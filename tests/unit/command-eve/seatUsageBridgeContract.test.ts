/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ICommandEveSeatUsageResult } from '@/common/adapter/ipcBridge';
import {
  buildSeatUsageIpcResult,
  emptySeatUsage,
  parseSeatUsageResponse,
  partitionSeatUsageForViewer,
  type AgentUsageLedgerEnvelope,
  type SeatUsageResponse,
} from '@/common/config/seatUsageCore';

const envelope: AgentUsageLedgerEnvelope = {
  version: 'command-eve-agent-usage/v1',
  immutable: true,
  complete: true,
  period: '2026-07',
  as_of: '2026-07-20T11:55:00.000Z',
  rows: [
    {
      ledger_event_id: 'ledger-event-1',
      routing_receipt_id: 'routing-receipt-1',
      agent_id: 'content-writer',
      period: '2026-07',
      route: 'subscription',
      recorded_at: '2026-07-20T10:00:00.000Z',
      immutable: true,
      calls: 3,
    },
  ],
};

const parsedOwnerResponse = (): SeatUsageResponse => ({
  ok: true,
  month: '2026-07',
  seats: [
    {
      seat_id: 'seat-1',
      calls: 3,
      ok_calls: 3,
      prompt_tokens: 120,
      completion_tokens: 40,
      retail_eur_cents: 100,
      raw_eur_cents: 40,
      credits: 1000,
    },
  ],
  total: {
    calls: 3,
    ok_calls: 3,
    prompt_tokens: 120,
    completion_tokens: 40,
    retail_eur_cents: 100,
    raw_eur_cents: 40,
    credits: 1000,
  },
  agent_usage: envelope,
});

describe('seat-usage Main → IPC contract', () => {
  it('forwards the verified envelope unchanged on the authorized owner path', () => {
    const scoped = partitionSeatUsageForViewer(parsedOwnerResponse(), null);
    const data: ICommandEveSeatUsageResult = buildSeatUsageIpcResult(scoped);

    expect(data.version).toBe('command-eve-seat-usage/v0');
    expect(data.agent_usage).toBe(envelope);
    expect(data.agent_usage?.rows[0]).toMatchObject({
      agent_id: 'content-writer',
      period: '2026-07',
      route: 'subscription',
      routing_receipt_id: 'routing-receipt-1',
    });
  });

  it('drops the envelope for a delegate-seat partition before IPC', () => {
    const scoped = partitionSeatUsageForViewer(parsedOwnerResponse(), 'uuid-client');
    const data: ICommandEveSeatUsageResult = buildSeatUsageIpcResult(scoped);
    expect(data.agent_usage).toBeNull();
  });

  it('keeps quiet and malformed agent-ledger paths null', () => {
    const quiet: ICommandEveSeatUsageResult = buildSeatUsageIpcResult(emptySeatUsage('2026-07'));
    expect(quiet.ok).toBe(false);
    expect(quiet.agent_usage).toBeNull();

    const malformed = parseSeatUsageResponse(
      {
        ok: true,
        month: '2026-07',
        seats: [],
        total: {},
        agent_usage: { ...envelope, immutable: false },
      },
      '2026-07'
    );
    const malformedData: ICommandEveSeatUsageResult = buildSeatUsageIpcResult(malformed);
    expect(malformedData.agent_usage).toBeNull();
  });

  it('whitelists the IPC shape so raw provider/body/secret fields cannot leak', () => {
    const parsed = parseSeatUsageResponse(
      {
        ok: true,
        month: '2026-07',
        seats: [],
        total: {},
        agent_usage: envelope,
        provider: 'raw-provider-name',
        body: { api_key: 'SECRET_DO_NOT_FORWARD' },
        authorization: 'Bearer SECRET_DO_NOT_FORWARD',
      },
      '2026-07'
    );
    const serialized = JSON.stringify(buildSeatUsageIpcResult(partitionSeatUsageForViewer(parsed, null)));
    expect(serialized).not.toContain('raw-provider-name');
    expect(serialized).not.toContain('SECRET_DO_NOT_FORWARD');
    expect(serialized).not.toContain('authorization');
  });
});
