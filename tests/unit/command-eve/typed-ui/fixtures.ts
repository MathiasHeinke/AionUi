/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  TYPED_UI_CATALOG_VERSION,
  TYPED_UI_SCHEMA_VERSION,
  type TypedUIEnvelope,
  type TypedUIProvenanceAttestation,
} from '@/common/typedUI';

export const TYPED_UI_TEST_RECEIPT_CONTEXT = {
  artifactId: 'artifact-typed-ui-17',
  conversationId: 'conversation-typed-ui-17',
  sourceMessageId: 'message-fixture-1',
} as const;

export function typedUIAttestationFixture(): TypedUIProvenanceAttestation {
  return {
    version: 'command-eve.typed-ui-provenance-attestation/v2',
    attestation_id: `tuia_${'a'.repeat(64)}`,
    artifact_id: TYPED_UI_TEST_RECEIPT_CONTEXT.artifactId,
    conversation_id: TYPED_UI_TEST_RECEIPT_CONTEXT.conversationId,
    source_message_id: TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId,
    content_sha256: 'b'.repeat(64),
    action_set_sha256: 'f'.repeat(64),
    identity_sha256: 'c'.repeat(64),
    request_id_sha256: 'd'.repeat(64),
    receipt_sha256: 'e'.repeat(64),
    seat_context_revision: 1,
    status: 'verified',
    recorded_at: '2026-08-11T12:00:00.000Z',
  };
}

export function typedUIFixture(): TypedUIEnvelope {
  return {
    schema_version: TYPED_UI_SCHEMA_VERSION,
    catalog_version: TYPED_UI_CATALOG_VERSION,
    root: 'root',
    elements: {
      root: {
        type: 'Stack',
        props: { direction: 'vertical', gap: 12, align: 'stretch' },
        children: ['heading', 'goal', 'run', 'decision', 'reply'],
      },
      heading: {
        type: 'Heading',
        props: { text: 'Launch cockpit', level: 2 },
        children: [],
      },
      goal: {
        type: 'Goal',
        props: {
          id: 'goal-17',
          title: 'Ship typed UI',
          status: 'active',
          progress: 62,
          owner: 'CTO',
          summary: 'Validated declarative rendering only.',
        },
        children: [],
        on: { pause: 'pauseGoal' },
      },
      run: {
        type: 'WorkerRun',
        props: {
          id: 'run-41',
          worker: 'AionUI worker',
          status: 'running',
          startedAt: '2026-08-11T12:00:00.000Z',
          summary: 'Security tests are running.',
          receiptRef: 'receipt-41',
        },
        children: [],
        on: { press: 'openRun', cancel: 'cancelRun' },
      },
      decision: {
        type: 'DecisionCard',
        props: {
          id: 'decision-9',
          title: 'Prepare integration PR?',
          status: 'open',
          rationale: 'The release action remains outside this artifact.',
          humanGate: 'HG-2.5',
          statePath: '/decision',
          options: [
            { id: 'yes', label: 'Prepare' },
            { id: 'later', label: 'Later' },
          ],
        },
        children: [],
        on: { 'select:yes': 'selectDecision', approve: 'requestApproval' },
      },
      reply: {
        type: 'Button',
        props: { label: 'Reply with state', variant: 'primary', disabled: false },
        children: [],
        on: { press: 'replyState' },
      },
    },
    state: { decision: null, note: 'Ready' },
    actions: {
      openRun: { type: 'open_artifact', params: { artifact_kind: 'worker', artifact_id: 'run-41' } },
      pauseGoal: {
        type: 'goal_control',
        params: { goal_id: 'goal-17', action: 'pause', expected_revision: 3, expected_sequence: 9 },
      },
      cancelRun: {
        type: 'worker_control',
        params: { worker_id: 'run-41', action: 'cancel', expected_revision: 4, expected_sequence: 12 },
      },
      selectDecision: {
        type: 'select_option',
        params: { state_path: '/decision', value: 'yes', option_id: 'yes' },
      },
      requestApproval: {
        type: 'request_approval',
        params: { gate_action: 'prepare_pr', summary: 'Prepare the bounded integration PR.' },
      },
      replyState: {
        type: 'reply_with_state',
        params: { state_paths: ['/decision', '/note'], message: 'Current selection' },
      },
    },
    provenance: {
      provider: 'fixture-provider',
      model: 'fixture-model',
      request_id: 'req-fixture-1',
      generated_at: '2026-08-11T12:00:00.000Z',
      source_message_id: 'message-fixture-1',
    },
  };
}

export function cloneFixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(typedUIFixture())) as Record<string, unknown>;
}
