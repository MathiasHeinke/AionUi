/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/renderer/hooks/agent/useEveInferenceSelection', () => ({
  useEveInferenceSelection: () => ({ selectedItem: { group: 'local' }, cloudBearerAvailable: true }),
}));

vi.mock('@/renderer/components/agent/ContextUsageIndicator', () => ({
  default: ({ showDetails, size }: { showDetails?: boolean; size?: number }) => (
    <span data-testid='context-ring' data-show-details={String(showDetails)} data-size={size} />
  ),
}));

import UnifiedSendBar from '@/renderer/components/chat/UnifiedSendBar';

const readSource = (relativePath: string): string => readFileSync(resolve(process.cwd(), relativePath), 'utf8');
const unifiedSendBarCss = readSource('packages/desktop/src/renderer/components/chat/UnifiedSendBar.css');
const busyModeCss = readSource(
  'packages/desktop/src/renderer/pages/conversation/platforms/ConversationBusyModeControl.css'
);
const sendBoxCss = readSource('packages/desktop/src/renderer/components/chat/SendBox/sendbox.css');

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
    expect(screen.queryByTestId('context-ring')).toBeNull();
  });

  it('adds the compact context ring only when real usage exists', () => {
    render(
      <MemoryRouter>
        <UnifiedSendBar
          eveControl={{ tokenUsage: { total_tokens: 1_024, prompt_tokens: 768, completion_tokens: 256 } }}
        />
      </MemoryRouter>
    );

    expect(screen.getByTestId('context-ring')).toHaveAttribute('data-show-details', 'false');
    expect(screen.getByTestId('context-ring')).toHaveAttribute('data-size', '30');
  });

  it('preserves fixed control order and mounted geometry when usage and busy state change', () => {
    const { rerender } = render(
      <MemoryRouter>
        <UnifiedSendBar
          busyModeSlot={<span data-testid='busy-control' data-state='idle' />}
          eveControl={{ tokenUsage: null }}
          micSlot={<span data-testid='mic-control' />}
          sendSlot={<span data-testid='send-control' />}
        />
      </MemoryRouter>
    );

    const busySlot = screen.getByTestId('busy-control').parentElement;
    const commandTrigger = screen.getByTestId('eve-composer-control-trigger');
    const commandGlyph = screen.getByTestId('command-eve-glyph');
    const micControl = screen.getByTestId('mic-control');
    const sendControl = screen.getByTestId('send-control');

    expect(busySlot).toHaveClass('unified-send-bar__busy-slot');
    expect(busySlot?.compareDocumentPosition(commandTrigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(commandTrigger.compareDocumentPosition(micControl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(micControl.compareDocumentPosition(sendControl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    rerender(
      <MemoryRouter>
        <UnifiedSendBar
          busyModeSlot={<span data-testid='busy-control' data-state='busy' />}
          eveControl={{ tokenUsage: { total_tokens: 512, prompt_tokens: 512, completion_tokens: 0 } }}
          micSlot={<span data-testid='mic-control' />}
          sendSlot={<span data-testid='send-control' />}
        />
      </MemoryRouter>
    );

    expect(screen.getByTestId('busy-control').parentElement).toBe(busySlot);
    expect(screen.getByTestId('busy-control')).toHaveAttribute('data-state', 'busy');
    expect(screen.getByTestId('eve-composer-control-trigger')).toBe(commandTrigger);
    expect(screen.getByTestId('command-eve-glyph')).toBe(commandGlyph);
    expect(screen.getByTestId('context-ring')).toHaveAttribute('data-size', '30');
  });

  it('pins busy and command controls to the shared 32px composer geometry', () => {
    expect(unifiedSendBarCss).toContain('--eve-composer-control-size: var(--eve-control-height, 32px);');
    expect(unifiedSendBarCss).toMatch(
      /\.unified-send-bar__busy-slot\s*\{[\s\S]*?width:\s*var\(--eve-composer-control-size\);[\s\S]*?height:\s*var\(--eve-composer-control-size\);[\s\S]*?flex:\s*0 0 var\(--eve-composer-control-size\);/
    );
    expect(busyModeCss).toMatch(
      /\.conversation-busy-mode-control\s*\{[\s\S]*?width:\s*var\(--eve-composer-control-size,[\s\S]*?height:\s*var\(--eve-composer-control-size,[\s\S]*?flex:\s*0 0 var\(--eve-composer-control-size,/
    );
    expect(busyModeCss).not.toMatch(/\.conversation-busy-mode-control\.is-(?:hidden|visible)\s*\{[^}]*transform:/);
  });

  it('centers the stop square and rotates only its work ring with a reduced-motion fallback', () => {
    expect(sendBoxCss).toMatch(
      /\.sendbox-stop-button \.arco-btn-icon\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/
    );
    expect(sendBoxCss).toMatch(
      /\.sendbox-stop-button\.bg-animate::before,[\s\S]*?animation:\s*sendbox-stop-work-ring 900ms linear infinite;/
    );
    expect(sendBoxCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sendbox-stop-button\.bg-animate::before,[\s\S]*?animation:\s*none;/
    );
  });
});
