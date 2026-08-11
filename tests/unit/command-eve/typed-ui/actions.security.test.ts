/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICommandEveGateAction, ICommandEveGateDecision } from '@/common/adapter/ipcBridge';
import type {
  TypedUIActionAuthorizeRequest,
  TypedUIActionFinalizeRequest,
  TypedUIActionReceipt,
  TypedUIProvenanceAttestation,
} from '@/common/typedUI';
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
  const authorizeAction = vi.fn<(request: TypedUIActionAuthorizeRequest) => Promise<TypedUIActionReceipt>>();
  const finalizeAction = vi.fn<(request: TypedUIActionFinalizeRequest) => Promise<TypedUIActionReceipt>>();
  const openArtifact = vi.fn();
  const openUrl = vi.fn();
  const replyWithState = vi.fn();
  const onReceipt = vi.fn();
  const receiptContext = {
    artifactId: 'artifact-17',
    conversationId: 'conversation-17',
    sourceMessageId: 'message-fixture-1',
  };
  const attestation: TypedUIProvenanceAttestation = {
    version: 'command-eve.typed-ui-provenance-attestation/v2',
    attestation_id: `tuia_${'a'.repeat(64)}`,
    artifact_id: receiptContext.artifactId,
    conversation_id: receiptContext.conversationId,
    source_message_id: receiptContext.sourceMessageId,
    content_sha256: 'b'.repeat(64),
    action_set_sha256: 'f'.repeat(64),
    identity_sha256: 'c'.repeat(64),
    request_id_sha256: 'd'.repeat(64),
    receipt_sha256: 'e'.repeat(64),
    seat_context_revision: 1,
    status: 'verified',
    recorded_at: '2026-08-11T12:00:00.000Z',
  };
  let lastAuthorization: TypedUIActionReceipt | undefined;

  function authorizeResult(request: TypedUIActionAuthorizeRequest, allowed = true): TypedUIActionReceipt {
    const gateAction =
      request.action_type === 'request_approval' ? (request.params.gate_action as ICommandEveGateAction) : 'truth_gate';
    const decision = authority(gateAction, allowed);
    const status =
      request.action_type === 'request_approval' && allowed ? 'approval_recorded' : allowed ? 'authorized' : 'blocked';
    const result: TypedUIActionReceipt = {
      version: 'command-eve.typed-ui-action-receipt/v2',
      receipt_id: '00000000-0000-4000-8000-000000000001',
      ...(status === 'authorized' ? { intent_claim_id: `tuic_${'1'.repeat(64)}` } : {}),
      request_id: request.request_id,
      artifact_id: request.artifact_id,
      conversation_id: request.conversation_id,
      attestation_id: request.attestation_id,
      content_sha256: request.content_sha256,
      source_message_id: request.source_message_id,
      action_id: request.action_id,
      action_type: request.action_type,
      action_params_sha256: '2'.repeat(64),
      action_binding_sha256: '3'.repeat(64),
      status,
      decided_at: decision.decided_at,
      authority: decision,
      ...(status === 'blocked' || status === 'approval_recorded' ? { reason: decision.reason } : {}),
    };
    lastAuthorization = result;
    return result;
  }

  const host: TypedUIActionHost = {
    attestProvenance: vi.fn(async () => attestation),
    authorizeAction,
    finalizeAction,
    getActionAvailability: vi.fn((action) => ({
      available: action !== 'goal_control' && action !== 'worker_control',
      ...(action === 'goal_control' || action === 'worker_control' ? { reason: 'durable_transport_unavailable' } : {}),
    })),
    openArtifact,
    openUrl,
    replyWithState,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    lastAuthorization = undefined;
    authorizeAction.mockImplementation(async (request) => authorizeResult(request));
    finalizeAction.mockImplementation(async (request) => {
      if (!lastAuthorization) throw new Error('missing authorization');
      return {
        ...lastAuthorization,
        receipt_id: '00000000-0000-4000-8000-000000000002',
        intent_receipt_id: request.intent_receipt_id,
        intent_claim_id: request.intent_claim_id,
        status: request.outcome,
        ...(request.reason ? { reason: request.reason } : {}),
      };
    });
  });

  const setup = () => {
    const envelope = typedUIFixture();
    const store = createStateStore(envelope.state);
    return {
      envelope,
      store,
      handlers: createTypedUIActionHandlers({ envelope, attestation, receiptContext, store, host, onReceipt }),
    };
  };

  it('obtains a Main-owned intent before opening an artifact and finalizes it', async () => {
    const { handlers } = setup();
    await handlers.open_artifact({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'openRun',
      artifact_kind: 'worker',
      artifact_id: 'run-41',
    });
    expect(authorizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'authorize',
        action_id: 'openRun',
        action_type: 'open_artifact',
        params: { artifact_kind: 'worker', artifact_id: 'run-41' },
      })
    );
    expect(openArtifact).toHaveBeenCalledWith('worker', 'run-41');
    expect(finalizeAction).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed' }));
    expect(authorizeAction.mock.invocationCallOrder[0]).toBeLessThan(openArtifact.mock.invocationCallOrder[0]);
    expect(openArtifact.mock.invocationCallOrder[0]).toBeLessThan(finalizeAction.mock.invocationCallOrder[0]);
    expect(onReceipt).toHaveBeenLastCalledWith(expect.objectContaining({ action_id: 'openRun', status: 'completed' }));
  });

  it('blocks side effects when Main denies authorization', async () => {
    authorizeAction.mockImplementation(async (request) => authorizeResult(request, false));
    const { handlers } = setup();
    await handlers.open_artifact({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'openRun',
      artifact_kind: 'worker',
      artifact_id: 'run-41',
    });
    expect(openArtifact).not.toHaveBeenCalled();
    expect(finalizeAction).not.toHaveBeenCalled();
  });

  it('never rewrites a successful host effect as failed when completed persistence fails', async () => {
    finalizeAction.mockRejectedValueOnce(new Error('receipt persistence unavailable'));
    const { handlers } = setup();
    await handlers.open_artifact({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'openRun',
      artifact_kind: 'worker',
      artifact_id: 'run-41',
    });
    expect(openArtifact).toHaveBeenCalledOnce();
    expect(finalizeAction).toHaveBeenCalledTimes(2);
    expect(finalizeAction).toHaveBeenNthCalledWith(1, expect.objectContaining({ outcome: 'completed' }));
    expect(finalizeAction).toHaveBeenNthCalledWith(2, expect.objectContaining({ outcome: 'completed' }));

    authorizeAction.mockRejectedValueOnce(new Error('receipt.intent_outstanding'));
    await handlers.open_artifact({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'openRun',
      artifact_kind: 'worker',
      artifact_id: 'run-41',
    });
    expect(openArtifact).toHaveBeenCalledOnce();
  });

  it('rechecks HTTP(S)-only navigation at execution time', async () => {
    const { envelope, store } = setup();
    envelope.actions.replyState = { type: 'open_url', params: { url: 'file:///etc/passwd' } };
    const handlers = createTypedUIActionHandlers({ envelope, attestation, receiptContext, store, host, onReceipt });
    await handlers.open_url({ [TYPED_UI_INTERNAL_ACTION_ID]: 'replyState', url: 'file:///etc/passwd' });
    expect(openUrl).not.toHaveBeenCalled();
    expect(finalizeAction).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });

  it('updates local state only after Main returns an authorized intent', async () => {
    const { handlers, store } = setup();
    await handlers.select_option({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'selectDecision',
      state_path: '/decision',
      value: 'yes',
      option_id: 'yes',
    });
    expect(store.get('/decision')).toBe('yes');
    expect(authorizeAction).toHaveBeenCalledBefore(finalizeAction);
  });

  it('does not mutate selection state when authorization fails or is outstanding', async () => {
    authorizeAction.mockRejectedValue(new Error('receipt.intent_outstanding'));
    const { handlers, store } = setup();
    await handlers.select_option({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'selectDecision',
      state_path: '/decision',
      value: 'yes',
      option_id: 'yes',
    });
    expect(store.get('/decision')).toBeNull();
    expect(finalizeAction).not.toHaveBeenCalled();
  });

  it('copies selected state into the existing composer without sending', async () => {
    const { handlers } = setup();
    await handlers.reply_with_state({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'replyState',
      state_paths: ['/decision', '/note'],
      message: 'Current selection',
    });
    expect(replyWithState).toHaveBeenCalledWith(expect.stringContaining('"/note": "Ready"'));
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('records request_approval in Main without performing or finalizing an action', async () => {
    const { handlers } = setup();
    await handlers.request_approval({
      [TYPED_UI_INTERNAL_ACTION_ID]: 'requestApproval',
      gate_action: 'prepare_pr',
      summary: 'Prepare the bounded integration PR.',
    });
    expect(authorizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'request_approval',
        params: expect.objectContaining({ gate_action: 'prepare_pr' }),
      })
    );
    expect(openArtifact).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(finalizeAction).not.toHaveBeenCalled();
    expect(onReceipt).toHaveBeenCalledWith(expect.objectContaining({ status: 'approval_recorded' }));
  });

  it('rejects action-type substitution before Main authority', async () => {
    const { handlers } = setup();
    await handlers.open_url({ [TYPED_UI_INTERNAL_ACTION_ID]: 'openRun', url: 'https://example.com' });
    expect(authorizeAction).not.toHaveBeenCalled();
  });

  it.each([
    ['goal_control', 'pauseGoal', { goal_id: 'goal-17', action: 'pause', expected_revision: 3, expected_sequence: 9 }],
    [
      'worker_control',
      'cancelRun',
      { worker_id: 'run-41', action: 'cancel', expected_revision: 4, expected_sequence: 12 },
    ],
  ] as const)('never reaches Main authorization for disabled %s', async (type, actionId, params) => {
    const { handlers } = setup();
    await handlers[type]({ [TYPED_UI_INTERNAL_ACTION_ID]: actionId, ...params });
    expect(authorizeAction).not.toHaveBeenCalled();
    expect(finalizeAction).not.toHaveBeenCalled();
  });
});
