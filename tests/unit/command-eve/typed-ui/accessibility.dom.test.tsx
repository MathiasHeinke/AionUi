/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICommandEveGateAction, ICommandEveGateDecision } from '@/common/adapter/ipcBridge';
import { TYPED_UI_CATALOG_VERSION, TYPED_UI_SCHEMA_VERSION, type TypedUIEnvelope } from '@/common/typedUI';
import {
  TypedUIRenderer,
  type TypedUIActionHost,
} from '@/renderer/pages/conversation/Messages/components/TypedGenerativeUI';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const actionHost: TypedUIActionHost = {
  evaluateAuthority: vi.fn(async (action) => authority(action)),
  recordReceipt: vi.fn(async () => ({ receipt_id: '00000000-0000-4000-8000-000000000001' })),
  openArtifact: vi.fn(),
  openUrl: vi.fn(),
  replyWithState: vi.fn(),
};

const receiptContext = { requestId: 'host-artifact-accessibility' };

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
    },
  };
}

afterEach(cleanup);

describe('Typed UI keyboard and screen-reader contract', () => {
  it('gives the region, controls and live receipt accessible names', async () => {
    const user = userEvent.setup();
    render(<TypedUIRenderer content={formFixture()} mode='full' host={actionHost} receiptContext={receiptContext} />);
    expect(screen.getByRole('region', { name: 'messages.typedUI.regionLabel' })).toBeVisible();
    expect(screen.getByLabelText('Name')).toBeRequired();
    expect(screen.getByText('Choice')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'I agree' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');

    await user.tab();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.type(screen.getByLabelText('Name'), 'Ada');
    await user.tab();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('activates authority-routed buttons from the keyboard', async () => {
    const user = userEvent.setup();
    render(<TypedUIRenderer content={formFixture()} mode='full' host={actionHost} receiptContext={receiptContext} />);
    const button = screen.getByRole('button', { name: 'Continue' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(actionHost.evaluateAuthority).toHaveBeenCalledWith('truth_gate');
  });
});
