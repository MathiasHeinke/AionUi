/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S11 — the persistent "PII-Schutz aus" badge. A DSGVO control-waiver must NEVER
 * be invisible: while the per-seat egress mode is 'off', the egress status strip
 * shows a persistent off-badge — and it must show EVEN when the operator hid the
 * data-boundary signal (`egressStatusVisible` off), because the display toggle may
 * not conceal a control-waiver.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { configValues } = vi.hoisted(() => ({
  configValues: new Map<string, unknown>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k }),
}));

vi.mock('@/renderer/hooks/config/useConfig', () => ({
  useConfig: (key: string) => [configValues.get(key), vi.fn()],
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      runtimeStatus: { invoke: () => Promise.resolve({ success: true, data: { egress_boundary: null } }) },
    },
  },
}));

// The unobtrusive off-footnote opens the privacy settings on click — stub the modal
// hook so this DOM test does not pull in the heavy SettingsModal tree.
vi.mock('@/renderer/components/settings/SettingsModal/useSettingsModal', () => ({
  useSettingsModal: () => ({ openSettings: vi.fn(), closeSettings: vi.fn(), settingsModal: null, visible: false }),
}));

import EgressBoundaryNotice from '@/renderer/pages/conversation/platforms/acp/EgressBoundaryNotice';

describe('EgressBoundaryNotice — unobtrusive "Datenschutz aus" footnote (S11)', () => {
  beforeEach(() => {
    cleanup();
    configValues.clear();
  });
  afterEach(() => cleanup());

  it('renders the unobtrusive off-footnote while mode is off', async () => {
    configValues.set('commandEve.egressStatusVisible', true);
    configValues.set('commandEve.egressRedactionMode', 'off');
    render(<EgressBoundaryNotice active={false} />);
    // Small muted footnote, not a prominent banner — and it is a clickable control.
    const footnote = await screen.findByText('* Datenschutz aus');
    expect(footnote).toBeInTheDocument();
    expect(footnote.closest('button')).not.toBeNull();
  });

  it('shows the off-footnote EVEN when the data-boundary display signal is hidden (waiver can not be concealed)', async () => {
    configValues.set('commandEve.egressStatusVisible', false); // display strip hidden
    configValues.set('commandEve.egressRedactionMode', 'off');
    render(<EgressBoundaryNotice active={false} />);
    expect(await screen.findByText('* Datenschutz aus')).toBeInTheDocument();
  });

  it('does NOT render the off-footnote when mode is on (absent ⇒ on)', () => {
    configValues.set('commandEve.egressStatusVisible', true);
    // egressRedactionMode absent ⇒ on.
    const { container } = render(<EgressBoundaryNotice active={false} />);
    expect(screen.queryByText('* Datenschutz aus')).toBeNull();
    // With no redaction action and mode on, the component renders nothing.
    expect(container).toBeEmptyDOMElement();
  });
});
