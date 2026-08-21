/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { setAuthority, setLocal } = vi.hoisted(() => ({
  setAuthority: vi.fn(() => Promise.resolve()),
  setLocal: vi.fn(),
}));
const storedAuthority = { ladder: 1, capabilities: {}, updatedBy: 'user' } as const;
vi.mock('@/common/config/configService', () => ({
  configService: {
    whenReady: () => Promise.resolve(),
    get: () => setAuthority.mock.calls.at(-1)?.[0],
    setLocal,
  },
}));
vi.mock('@/renderer/hooks/config/useConfig', () => ({
  useConfig: (key: string) => (key === 'commandEve.authority' ? [storedAuthority, setAuthority] : [undefined, vi.fn()]),
}));
vi.mock('@/renderer/components/agent/ContextCreditsPopover', () => ({ default: () => <div>context details</div> }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'conversation.composerDeck.authorityShort.ask') return 'Fragen';
      if (key === 'conversation.composerDeck.context') return 'Kontext';
      if (key === 'conversation.composerDeck.contextPercent') return `${options?.percent}% Kontext`;
      return key;
    },
  }),
}));

import ComposerContextDeck from '@/renderer/components/chat/ComposerContextDeck';
import { Message } from '@arco-design/web-react';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ComposerContextDeck', () => {
  it('shows project, real seat authority, MAX and one compact context segment', async () => {
    render(
      <ComposerContextDeck
        projectSlot={<button type='button'>Malte</button>}
        maxSlot={<button type='button'>MAX</button>}
        tokenUsage={{ total_tokens: 680 } as never}
        contextLimit={1000}
      />
    );

    expect(screen.getByText('Malte')).toBeVisible();
    expect(await screen.findByText('Fragen')).toBeVisible();
    expect(screen.getByText('MAX')).toBeVisible();
    expect(screen.getByTestId('composer-context-meter')).toHaveTextContent('68% Kontext');
    expect(screen.getByTestId('composer-context-meter')).toHaveStyle({ '--eve-context-progress': '68%' });
  });

  it('keeps the context value itself clickable for the existing detail surface', async () => {
    render(<ComposerContextDeck projectSlot={<span>Temp</span>} tokenUsage={null} />);
    await screen.findByText('Fragen');
    fireEvent.click(screen.getByTestId('composer-context-meter'));
    expect(screen.getByText('context details')).toBeVisible();
  });

  it('implements the approved nearly-equal MAX/context ratio without a nested progress pill', () => {
    const css = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/renderer/components/chat/ComposerContextDeck.module.css'),
      'utf8'
    );
    expect(css).toContain('min-width: 64px');
    expect(css).toContain('width: 94px');
    expect(css).toContain(
      ".deck .rightCompound .maxSlot :global(.eve-max-toggle-anchor [data-testid='eve-max-toggle'])"
    );
    expect(css).toContain('border-radius: 0 999px 999px 0 !important');
    expect(css).toContain('width: var(--eve-context-progress)');
    expect(css).toContain('var(--eve-accent)');
    expect(css).toContain('var(--eve-brand-logo)');
  });

  it("uses the available viewport and scrolls all six authority rungs instead of clipping at Arco's 200px default", () => {
    const css = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/renderer/components/chat/ComposerContextDeck.module.css'),
      'utf8'
    );
    expect(css).toContain('max-height: min(430px, calc(100dvh - 88px)) !important');
    expect(css).toContain('overflow-y: auto !important');
    expect(css).toContain('overscroll-behavior: contain');
    expect(css).toContain('scrollbar-width: thin');
  });

  it('rolls the optimistic authority display back when the durable PUT fails', async () => {
    setAuthority.mockRejectedValueOnce(new Error('settings PUT failed'));
    const errorSpy = vi.spyOn(Message, 'error').mockImplementation(() => undefined as never);
    render(<ComposerContextDeck projectSlot={<span>Temp</span>} tokenUsage={null} />);
    await screen.findByText('Fragen');

    fireEvent.click(screen.getByTestId('composer-authority-control'));
    fireEvent.click(await screen.findByText('commandEve.authority.rung.full.title'));

    await waitFor(() =>
      expect(setLocal).toHaveBeenCalledWith('commandEve.authority', {
        ladder: 1,
        capabilities: {},
        updatedBy: 'user',
      })
    );
    expect(errorSpy).toHaveBeenCalledWith('agentMode.eve.expansionPersistFailed');
  });
});
