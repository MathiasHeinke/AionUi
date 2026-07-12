/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/renderer/hooks/agent/useEveInferenceSelection', () => ({
  useEveInferenceSelection: () => ({ selectedItem: { group: 'local' }, cloudBearerAvailable: true }),
}));

vi.mock('@/renderer/components/agent/ContextUsageIndicator', () => ({
  default: () => <span data-testid='context-ring' />,
}));

import UnifiedSendBar from '@/renderer/components/chat/UnifiedSendBar';

describe('UnifiedSendBar', () => {
  it('renders every provided slot inside the one shared control row', () => {
    render(
      <UnifiedSendBar
        leftSlot={<button type='button'>plus</button>}
        modelSlot={<span>model</span>}
        permissionSlot={<span>permission</span>}
        contextSlot={<span>context</span>}
        micSlot={<button type='button'>mic</button>}
        sendSlot={<button type='button'>send</button>}
      />
    );

    const bar = screen.getByTestId('unified-send-bar');
    expect(bar).toBeTruthy();
    for (const label of ['plus', 'model', 'permission', 'context', 'mic', 'send']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('places the left slot before the right cluster and the send button last', () => {
    render(
      <UnifiedSendBar
        leftSlot={<span>plus</span>}
        modelSlot={<span>model</span>}
        micSlot={<span>mic</span>}
        sendSlot={<span>send</span>}
      />
    );

    const order = ['plus', 'model', 'mic', 'send'].map((label) =>
      // documentPosition: ascending index ⇒ left-to-right DOM order
      screen.getByText(label)
    );

    // plus (left cluster) comes before model (right cluster)
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // model comes before mic
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // mic comes before send (send is rendered last in the right cluster)
    expect(order[2].compareDocumentPosition(order[3]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('omits empty slots without breaking the row', () => {
    render(<UnifiedSendBar leftSlot={<span>plus</span>} sendSlot={<span>send</span>} />);
    expect(screen.getByTestId('unified-send-bar')).toBeTruthy();
    expect(screen.getByText('plus')).toBeTruthy();
    expect(screen.getByText('send')).toBeTruthy();
    expect(screen.queryByText('mic')).toBeNull();
  });

  it('keeps EVE model and permission controls behind one progressive-disclosure control', async () => {
    render(
      <MemoryRouter>
        <UnifiedSendBar
          leftSlot={<span>project</span>}
          modelSlot={<span>model</span>}
          permissionSlot={<span>permission</span>}
          contextSlot={<span>legacy-context</span>}
          eveControl={{ tokenUsage: null }}
          micSlot={<span>mic</span>}
          sendSlot={<span>send</span>}
        />
      </MemoryRouter>
    );

    expect(screen.queryByText('model')).toBeNull();
    expect(screen.queryByText('permission')).toBeNull();
    expect(screen.queryByText('legacy-context')).toBeNull();

    const trigger = screen.getByTestId('eve-composer-control-trigger');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);

    expect(await screen.findByTestId('eve-composer-control-menu')).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('model')).toBeTruthy();
    expect(screen.getByText('permission')).toBeTruthy();
    expect(screen.getByTestId('context-ring')).toBeTruthy();
  });
});
