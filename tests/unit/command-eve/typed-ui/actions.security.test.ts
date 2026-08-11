/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICommandEveGateAction, ICommandEveGateDecision } from '@/common/adapter/ipcBridge';
import {
  createTypedUIActionHandlers,
  TYPED_UI_INTERNAL_ACTION_ID,
  type TypedUIActionHost,
} from '@/renderer/pages/conversation/Messages/components/TypedGenerativeUI';
import { createStateStore } from '@json-render/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { typedUIFixture } from './fixtures';

const authority = (action: ICommandEveGateAction, allowed = true): ICommandEveGateDecision => ({
  version: 'command-eve-gate-decision/v0',
  decided_at: '2026-08-11T12:00:00.000Z',
  mode: 'observed',
  action,
  allowed,
  gate: allowed ? 'founder_stop' : 'hg_4',
  reason: allowed ? 'bounded' : 'blocked',
});

describe('Typed UI action authority and receipts', () => {
  const evaluateAuthority = vi.fn<(action: ICommandEveGateAction) => Promise<ICommandEveGateDecision>>();
  const recordReceipt = vi.fn(async () => ({ receipt_id: '00000000-0000-4000-8000-000000000001' }));
  const openArtifact = vi.fn();
  const openUrl = vi.fn();
  const replyWithState = vi.fn();
  const onReceipt = vi.fn();
  const receiptContext = { requestId: 'host-artifact-17' };
  const host: TypedUIActionHost = { evaluateAuthority, recordReceipt, openArtifact, openUrl, replyWithState };

  beforeEach(() => {
    vi.clearAllMocks();
    evaluateAuthority.mockImplementation(async (action) => authority(action));
  });

  const setup = () => {
    const envelope = typedUIFixture();
    const store = createStateStore(envelope.state);
    return {
      envelope,
      store,
      handlers: createTypedUIActionHandlers({ envelope, receiptContext, store, host, onReceipt }),
    };
  };

  it('routes local actions through the EVE-MAIN truth gate and emits a receipt', async () => {
    const { handlers } = setup();
    await handlers.open_artifact({ [TYPED_UI_INTERNAL_ACTION_ID]: 'openRun', artifact_id: 'artifact-current' });
    expect(evaluateAuthority).toHaveBeenCalledWith('truth_gate');
    expect(openArtifact).toHaveBeenCalledWith('artifact-current');
    expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ action_id: 'openRun', status: 'completed' }));
  });

  it('blocks side effects when authority denies them', async () => {
    evaluateAuthority.mockResolvedValue(authority('truth_gate', false));
    const { handlers } = setup();
    await handlers
      .open_url({
        [TYPED_UI_INTERNAL_ACTION_ID]: 'replyState',
        url: 'https://example.com',
      })
      .catch(() => undefined);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('rechecks HTTP(S)-only navigation at execution time', async () => {
    const { envelope, store } = setup();
    envelope.actions.replyState = { type: 'open_url', params: { url: 'https://example.com' } };
    const handlers = createTypedUIActionHandlers({ envelope, receiptContext, store, host, onReceipt });
    await handlers.open_url({ [TYPED_UI_INTERNAL_ACTION_ID]: 'replyState', url: 'file:///etc/passwd' });
    expect(openUrl).not.toHaveBeenCalled();
    expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('updates only local state for select_option', async () => {
    const { handlers, store } = setup();
    await handlers.select_option({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'selectDecision',
      state_path: '/decision',
      value: 'yes',
    });
    expect(store.get('/decision')).toBe('yes');
    expect(evaluateAuthority).toHaveBeenCalledWith('truth_gate');
  });

  it('does not mutate selection state when authority denies it', async () => {
    evaluateAuthority.mockResolvedValue(authority('truth_gate', false));
    const { handlers, store } = setup();
    await handlers.select_option({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'selectDecision',
      state_path: '/decision',
      value: 'yes',
    });
    expect(store.get('/decision')).toBeNull();
  });

  it('copies selected state into the existing composer without sending', async () => {
    const { handlers } = setup();
    await handlers.reply_with_state({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'replyState',
      state_paths: ['/note'],
      message: 'Current selection',
    });
    expect(replyWithState).toHaveBeenCalledWith(expect.stringContaining('"/note": "Ready"'));
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('records request_approval against its declared HumanGate action without performing it', async () => {
    const { handlers } = setup();
    await handlers.request_approval({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'requestApproval',
      gate_action: 'prepare_pr',
      summary: 'Prepare bounded PR',
    });
    expect(evaluateAuthority).toHaveBeenCalledWith('prepare_pr');
    expect(openArtifact).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ status: 'approval_recorded' }));
  });

  it('rejects action-type substitution even with a valid action id', async () => {
    const { handlers } = setup();
    await handlers.open_url({ [TYPED_UI_INTERNAL_ACTION_ID]: 'openRun', url: 'https://example.com' });
    expect(evaluateAuthority).not.toHaveBeenCalled();
  });
});
