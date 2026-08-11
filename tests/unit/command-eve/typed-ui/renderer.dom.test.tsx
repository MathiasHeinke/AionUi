/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICommandEveGateAction, ICommandEveGateDecision } from '@/common/adapter/ipcBridge';
import {
  TypedUIRenderer,
  typedUIRegistry,
  type TypedUIActionHost,
} from '@/renderer/pages/conversation/Messages/components/TypedGenerativeUI';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { typedUIFixture } from './fixtures';

const receiptContext = { requestId: 'host-artifact-renderer' };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      `${key}${options?.action ? `:${String(options.action)}` : ''}`,
  }),
}));

const decision = (action: ICommandEveGateAction): ICommandEveGateDecision => ({
  version: 'command-eve-gate-decision/v0',
  decided_at: '2026-08-11T12:00:00.000Z',
  mode: 'observed',
  action,
  allowed: true,
  gate: 'founder_stop',
  reason: 'bounded',
});

function host(): TypedUIActionHost {
  return {
    evaluateAuthority: vi.fn(async (action) => decision(action)),
    recordReceipt: vi.fn(async () => ({ receipt_id: '00000000-0000-4000-8000-000000000001' })),
    openArtifact: vi.fn(),
    openUrl: vi.fn(),
    replyWithState: vi.fn(),
  };
}

afterEach(cleanup);

describe('Typed UI renderer', () => {
  it('registers every one of the 45 catalog components', () => {
    expect(Object.keys(typedUIRegistry)).toHaveLength(45);
  });

  it('renders the compact artifact inline and opens the existing Workbench through authority', async () => {
    const actionHost = host();
    const onOpenWorkbench = vi.fn();
    const user = userEvent.setup();
    render(
      <TypedUIRenderer
        content={JSON.stringify(typedUIFixture())}
        mode='compact'
        host={actionHost}
        receiptContext={receiptContext}
        onOpenWorkbench={onOpenWorkbench}
      />
    );
    expect(screen.getByTestId('typed-ui-compact')).toHaveTextContent('Launch cockpit');
    expect(screen.getByText('Ship typed UI')).toBeVisible();
    expect(screen.getByText('AionUI worker')).toBeVisible();
    expect(screen.getByText('Prepare integration PR?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'messages.typedUI.openWorkbench' }));
    expect(actionHost.evaluateAuthority).toHaveBeenCalledWith('truth_gate');
    expect(onOpenWorkbench).toHaveBeenCalledOnce();
  });

  it('renders the full representation without creating a second chat or another open button', () => {
    render(<TypedUIRenderer content={typedUIFixture()} mode='full' host={host()} receiptContext={receiptContext} />);
    expect(screen.getByTestId('typed-ui-full')).toHaveTextContent('Launch cockpit');
    expect(screen.queryByRole('button', { name: 'messages.typedUI.openWorkbench' })).toBeNull();
  });

  it('fails safe for invalid AST and never renders its payload component', () => {
    const invalid = typedUIFixture();
    invalid.elements.heading.type = 'Text';
    invalid.elements.heading.props = { text: 'MUST NOT RENDER', href: 'javascript:alert(1)' };
    render(<TypedUIRenderer content={invalid} mode='compact' host={host()} receiptContext={receiptContext} />);
    expect(screen.getByTestId('typed-ui-invalid')).toBeVisible();
    expect(screen.queryByText('MUST NOT RENDER')).toBeNull();
  });

  it('shows an inert status for partial streaming JSON', () => {
    render(
      <TypedUIRenderer
        content='{"schema_version":'
        mode='compact'
        host={host()}
        receiptContext={receiptContext}
        streaming
      />
    );
    expect(screen.getByTestId('typed-ui-streaming')).toHaveAttribute('role', 'status');
    expect(screen.queryByTestId('typed-ui-compact')).toBeNull();
  });

  it('announces action receipts and leaves state in the existing UI tree', async () => {
    const actionHost = host();
    render(
      <TypedUIRenderer content={typedUIFixture()} mode='compact' host={actionHost} receiptContext={receiptContext} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reply with state' }));
    await waitFor(() => expect(actionHost.replyWithState).toHaveBeenCalled());
    expect(screen.getByTestId('typed-ui-action-status')).toHaveTextContent('messages.typedUI.actionCompleted');
  });

  it('does not materialize model HTML, links or images from Markdown', () => {
    const value = typedUIFixture();
    value.elements = {
      root: {
        type: 'Markdown',
        props: {
          content: '<script>alert(1)</script>\n\n[outside](https://example.com) ![track](https://example.com/x.png)',
        },
        children: [],
      },
    };
    value.actions = {};
    render(<TypedUIRenderer content={value} mode='full' host={host()} receiptContext={receiptContext} />);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('outside')).toBeVisible();
  });

  it('omits open_artifact affordances when the full-pane host cannot resolve artifacts', () => {
    const actionHost = host();
    actionHost.supportsAction = (action) => action !== 'open_artifact';
    render(
      <TypedUIRenderer content={typedUIFixture()} mode='full' host={actionHost} receiptContext={receiptContext} />
    );
    expect(screen.queryByRole('button', { name: 'receipt-41' })).toBeNull();
    expect(screen.getByText('AionUI worker')).toBeVisible();
  });
});
