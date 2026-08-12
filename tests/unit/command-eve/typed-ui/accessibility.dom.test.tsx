/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICommandEveGateAction, ICommandEveGateDecision } from '@/common/adapter/ipcBridge';
import {
  TYPED_UI_CATALOG_VERSION,
  TYPED_UI_SCHEMA_VERSION,
  type TypedUIActionAuthorizeRequest,
  type TypedUIActionReceipt,
  type TypedUIEnvelope,
} from '@/common/typedUI';
import {
  TypedUIRenderer,
  type TypedUIActionHost,
} from '@/renderer/pages/conversation/Messages/components/TypedGenerativeUI';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TYPED_UI_TEST_RECEIPT_CONTEXT, typedUIAttestationFixture, typedUIFixture } from './fixtures';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const authority = (action: ICommandEveGateAction): ICommandEveGateDecision => ({
  version: 'command-eve-gate-decision/v0',
  decided_at: '2026-08-11T12:00:00.000Z',
  mode: 'observed',
  action,
  allowed: true,
  gate: 'founder_stop',
  reason: 'bounded',
});

let lastAuthorization: TypedUIActionReceipt | undefined;
const authorizeAction = vi.fn(async (request: TypedUIActionAuthorizeRequest): Promise<TypedUIActionReceipt> => {
  const decision = authority('truth_gate');
  lastAuthorization = {
    version: 'command-eve.typed-ui-action-receipt/v2',
    receipt_id: '00000000-0000-4000-8000-000000000001',
    intent_claim_id: `tuic_${'1'.repeat(64)}`,
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
    status: 'authorized',
    decided_at: decision.decided_at,
    authority: decision,
  };
  return lastAuthorization;
});

const actionHost: TypedUIActionHost = {
  attestProvenance: vi.fn(async () => typedUIAttestationFixture()),
  authorizeAction,
  finalizeAction: vi.fn(async (request) => {
    if (!lastAuthorization) throw new Error('missing authorization');
    return {
      ...lastAuthorization,
      receipt_id: '00000000-0000-4000-8000-000000000002',
      intent_receipt_id: request.intent_receipt_id,
      intent_claim_id: request.intent_claim_id,
      status: request.outcome,
    };
  }),
  getActionAvailability: vi.fn(() => ({ available: true })),
  openArtifact: vi.fn(),
  openUrl: vi.fn(),
  replyWithState: vi.fn(),
};

const receiptContext = TYPED_UI_TEST_RECEIPT_CONTEXT;

function formFixture(): TypedUIEnvelope {
  return {
    schema_version: TYPED_UI_SCHEMA_VERSION,
    catalog_version: TYPED_UI_CATALOG_VERSION,
    root: 'root',
    elements: {
      root: {
        type: 'Stack',
        props: { direction: 'vertical', gap: 10 },
        children: ['name', 'choice', 'agree', 'submit'],
      },
      name: {
        type: 'Input',
        props: { label: 'Name', statePath: '/name', required: true, maxLength: 60 },
        children: [],
      },
      choice: {
        type: 'Select',
        props: {
          label: 'Choice',
          statePath: '/choice',
          options: [
            { id: 'alpha', label: 'Alpha' },
            { id: 'beta', label: 'Beta' },
          ],
        },
        children: [],
      },
      agree: { type: 'Checkbox', props: { label: 'I agree', statePath: '/agree' }, children: [] },
      submit: {
        type: 'Button',
        props: { label: 'Continue', variant: 'primary' },
        children: [],
        on: { press: 'reply' },
      },
    },
    state: { name: '', choice: null, agree: false },
    actions: { reply: { type: 'reply_with_state', params: { state_paths: ['/name', '/choice', '/agree'] } } },
    provenance: {
      provider: 'fixture',
      model: 'fixture',
      request_id: 'a11y-1',
      generated_at: '2026-08-11T12:00:00.000Z',
      source_message_id: TYPED_UI_TEST_RECEIPT_CONTEXT.sourceMessageId,
    },
  };
}

afterEach(cleanup);

describe('Typed UI keyboard and screen-reader contract', () => {
  it('gives the region, controls and live receipt accessible names', async () => {
    const user = userEvent.setup();
    render(<TypedUIRenderer content={formFixture()} mode='full' host={actionHost} receiptContext={receiptContext} />);
    await screen.findByLabelText('Name');
    expect(screen.getByRole('region', { name: 'messages.typedUI.regionLabel' })).toBeVisible();
    expect(screen.getByLabelText('Name')).toBeRequired();
    expect(screen.getByText('Choice')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'I agree' })).toBeVisible();
    expect(screen.getByTestId('typed-ui-action-status')).toHaveAttribute('aria-live', 'polite');

    await user.tab();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('activates authority-routed buttons from the keyboard', async () => {
    const user = userEvent.setup();
    render(<TypedUIRenderer content={formFixture()} mode='full' host={actionHost} receiptContext={receiptContext} />);
    const button = await screen.findByRole('button', { name: 'Continue' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(authorizeAction).toHaveBeenCalledWith(expect.objectContaining({ action_type: 'reply_with_state' }));
  });

  it('keeps disabled lifecycle controls focusable with a screen-reader reason', async () => {
    const unavailableHost: TypedUIActionHost = {
      ...actionHost,
      getActionAvailability: (action) => ({
        available: action !== 'goal_control' && action !== 'worker_control',
        ...(action === 'goal_control' || action === 'worker_control'
          ? { reason: 'durable_transport_unavailable' }
          : {}),
      }),
    };
    render(
      <TypedUIRenderer
        content={typedUIFixture()}
        mode='compact'
        host={unavailableHost}
        receiptContext={receiptContext}
      />
    );
    const pause = await screen.findByRole('button', { name: 'messages.typedUI.lifecycle.pause' });
    expect(pause).toHaveAttribute('aria-disabled', 'true');
    const descriptionId = pause.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(String(descriptionId))).toHaveTextContent(
      'messages.typedUI.lifecycle.transportUnavailable'
    );
    pause.focus();
    expect(pause).toHaveFocus();
  });
});
