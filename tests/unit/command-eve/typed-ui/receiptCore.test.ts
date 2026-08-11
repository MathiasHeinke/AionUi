/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TypedUIActionReceipt } from '@/common/typedUI';
import {
  appendTypedUIActionReceipt,
  validateTypedUIActionReceipt,
} from '@/process/commandEve/typedUIActionReceiptCore';
import { evaluateCommandEveGateDecision } from '@/process/commandEve/executionModeCore';
import {
  createTypedUIActionHandlers,
  TYPED_UI_INTERNAL_ACTION_ID,
  type TypedUIActionHost,
} from '@/renderer/pages/conversation/Messages/components/TypedGenerativeUI';
import { createStateStore } from '@json-render/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedUIFixture } from './fixtures';

const temporaryDirectories: string[] = [];

function receipt(status: TypedUIActionReceipt['status'] = 'authorized'): TypedUIActionReceipt {
  return {
    version: 'command-eve.typed-ui-action-receipt/v1',
    request_id: 'request-17',
    source_message_id: 'message-17',
    action_id: 'openArtifact',
    action_type: 'open_artifact',
    status,
    decided_at: '2026-08-11T12:00:01.000Z',
    authority: evaluateCommandEveGateDecision({
      mode: 'observed',
      action: 'truth_gate',
      now: () => new Date('2026-08-11T12:00:00.000Z'),
    }),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Main-owned Typed UI action receipts', () => {
  it('persists a private intent before a correlated terminal outcome', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-ui-receipt-'));
    temporaryDirectories.push(directory);
    const auditPath = path.join(directory, 'audit', 'typed-ui-actions.jsonl');
    const intent = appendTypedUIActionReceipt(auditPath, receipt(), {
      now: () => new Date('2026-08-11T12:00:02.000Z'),
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
    });
    const completed = appendTypedUIActionReceipt(
      auditPath,
      { ...receipt('completed'), intent_receipt_id: intent.receipt_id },
      {
        now: () => new Date('2026-08-11T12:00:03.000Z'),
        randomUUID: () => '00000000-0000-4000-8000-000000000002',
      }
    );
    expect(completed.intent_receipt_id).toBe(intent.receipt_id);
    const records = fs
      .readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.status)).toEqual(['authorized', 'completed']);
    expect(fs.statSync(auditPath).mode & 0o777).toBe(0o600);
  });

  it('rejects forged authority fields, unknown actions and terminal records without intent', () => {
    const extraAuthority = receipt();
    (extraAuthority.authority as typeof extraAuthority.authority & { forged?: boolean }).forged = true;
    expect(validateTypedUIActionReceipt(extraAuthority)).toEqual({ ok: false, reason: 'receipt.authority_shape' });

    const unknownAction = receipt();
    (unknownAction.authority as { action: string }).action = 'arbitrary';
    expect(validateTypedUIActionReceipt(unknownAction)).toEqual({ ok: false, reason: 'receipt.authority_shape' });

    expect(validateTypedUIActionReceipt(receipt('completed'))).toEqual({ ok: false, reason: 'receipt.missing_intent' });
  });

  it('rejects missing, mismatched and replayed durable intent references', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-ui-receipt-correlation-'));
    temporaryDirectories.push(directory);
    const auditPath = path.join(directory, 'audit', 'typed-ui-actions.jsonl');
    const forgedTerminal = {
      ...receipt('completed'),
      intent_receipt_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    };
    expect(() => appendTypedUIActionReceipt(auditPath, forgedTerminal)).toThrow('receipt.intent_not_found');

    const intent = appendTypedUIActionReceipt(auditPath, receipt(), {
      randomUUID: () => '00000000-0000-4000-8000-000000000010',
    });
    expect(() =>
      appendTypedUIActionReceipt(auditPath, {
        ...receipt('completed'),
        action_id: 'differentAction',
        intent_receipt_id: intent.receipt_id,
      })
    ).toThrow('receipt.intent_mismatch');

    appendTypedUIActionReceipt(
      auditPath,
      { ...receipt('completed'), intent_receipt_id: intent.receipt_id },
      { randomUUID: () => '00000000-0000-4000-8000-000000000011' }
    );
    expect(() =>
      appendTypedUIActionReceipt(
        auditPath,
        { ...receipt('failed'), intent_receipt_id: intent.receipt_id },
        { randomUUID: () => '00000000-0000-4000-8000-000000000012' }
      )
    ).toThrow('receipt.intent_already_terminal');
  });

  it('persists one renderer intent and terminal outcome with the same authority timestamp', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-ui-receipt-renderer-main-'));
    temporaryDirectories.push(directory);
    const auditPath = path.join(directory, 'audit', 'typed-ui-actions.jsonl');
    const envelope = typedUIFixture();
    const store = createStateStore(envelope.state);
    const openArtifact = vi.fn();
    let sequence = 20;
    const host: TypedUIActionHost = {
      evaluateAuthority: async (action) =>
        evaluateCommandEveGateDecision({
          mode: 'observed',
          action,
          now: () => new Date('2026-08-11T12:00:00.000Z'),
        }),
      recordReceipt: async (value) => {
        const persisted = appendTypedUIActionReceipt(auditPath, value, {
          randomUUID: () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`,
        });
        return { receipt_id: persisted.receipt_id };
      },
      openArtifact,
      openUrl: vi.fn(),
      replyWithState: vi.fn(),
    };
    const handlers = createTypedUIActionHandlers({
      envelope,
      receiptContext: { requestId: 'host-artifact-renderer-main' },
      store,
      host,
      onReceipt: vi.fn(),
    });

    await handlers.open_artifact({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'openRun',
      artifact_id: 'artifact-current',
    });

    expect(openArtifact).toHaveBeenCalledWith('artifact-current');
    const records = fs
      .readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TypedUIActionReceipt);
    expect(records.map((record) => record.status)).toEqual(['authorized', 'completed']);
    expect(records[0].decided_at).toBe(records[1].decided_at);
  });
});
