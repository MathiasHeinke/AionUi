/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * S11 (1.7.1 move) — the persistent "Datenschutz aus" control-waiver badge.
 *
 * A DSGVO control-waiver must NEVER be invisible. Founder 2026-07-05 relocated the
 * waiver indicator from the EgressBoundaryNotice footnote to the top-right chat-window
 * toggle pill (EgressRedactionTogglePill). This test guards the invariant at its new
 * home: while the per-seat egress mode is 'off', the pill shows a prominent, CLICKABLE
 * "Datenschutz aus" affordance — and it must show regardless of the data-boundary
 * display toggle (`egressStatusVisible`), because a display preference may not conceal
 * a control-waiver. When the mode is on (or absent ⇒ on) the pill is the muted
 * "Datenschutz an" affordance, never the off-badge.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { configValues } = vi.hoisted(() => ({
  configValues: new Map<string, unknown>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k }),
}));

vi.mock('@/renderer/hooks/config/useConfig', () => ({
  useConfig: (key: string) => [configValues.get(key), vi.fn()],
}));

import EgressRedactionTogglePill from '@/renderer/pages/conversation/platforms/acp/EgressRedactionTogglePill';

describe('EgressRedactionTogglePill — persistent "Datenschutz aus" waiver badge (S11)', () => {
  beforeEach(() => {
    cleanup();
    configValues.clear();
  });
  afterEach(() => cleanup());

  it('renders a prominent, clickable "Datenschutz aus" affordance while mode is off', () => {
    configValues.set('commandEve.egressStatusVisible', true);
    configValues.set('commandEve.egressRedactionMode', 'off');
    render(<EgressRedactionTogglePill />);
    const badge = screen.getByText('Datenschutz aus');
    expect(badge).toBeInTheDocument();
    // It is a real control (click turns protection back on), not inert text.
    expect(badge.closest('button')).not.toBeNull();
  });

  it('shows the off-badge EVEN when the data-boundary display signal is hidden (waiver can not be concealed)', () => {
    configValues.set('commandEve.egressStatusVisible', false); // display strip hidden
    configValues.set('commandEve.egressRedactionMode', 'off');
    render(<EgressRedactionTogglePill />);
    // The pill does not gate on egressStatusVisible — the waiver survives the display toggle.
    expect(screen.getByText('Datenschutz aus')).toBeInTheDocument();
  });

  it('shows the muted "Datenschutz an" affordance and NOT the off-badge when mode is on (absent ⇒ on)', () => {
    configValues.set('commandEve.egressStatusVisible', true);
    // egressRedactionMode absent ⇒ on (fail-safe).
    render(<EgressRedactionTogglePill />);
    expect(screen.getByText('Datenschutz an')).toBeInTheDocument();
    expect(screen.queryByText('Datenschutz aus')).toBeNull();
  });

  it('dismisses the disable-confirm popover on an outside click (1.7.1 polish)', () => {
    configValues.set('commandEve.egressRedactionMode', 'on');
    render(<EgressRedactionTogglePill />);
    fireEvent.click(screen.getByText('Datenschutz an')); // open the confirm popover
    expect(screen.getByText(/PII-Schutz für diesen Seat ausschalten/)).toBeInTheDocument();
    fireEvent.mouseDown(document.body); // click outside
    expect(screen.queryByText(/PII-Schutz für diesen Seat ausschalten/)).toBeNull();
  });

  it('dismisses the disable-confirm popover on Escape (1.7.1 polish)', () => {
    configValues.set('commandEve.egressRedactionMode', 'on');
    render(<EgressRedactionTogglePill />);
    fireEvent.click(screen.getByText('Datenschutz an'));
    expect(screen.getByText(/PII-Schutz für diesen Seat ausschalten/)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(/PII-Schutz für diesen Seat ausschalten/)).toBeNull();
  });
});
