/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 1.7.2 — the "Erste Schritte" hub. Smoke test: the 9 Day-0 step cards render,
 * the cloud-lane chip reflects real readiness, an in-app step navigates, and the
 * seat-add step opens the web account (not an in-app route).
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';

const { navigateSpy, openAccountWebSpy, statusState } = vi.hoisted(() => ({
  navigateSpy: vi.fn(),
  openAccountWebSpy: vi.fn(),
  statusState: {
    current: {
      loading: false,
      model: { first_value_ready: true, items: [{ id: 'identity', state: 'ok' }] },
      greeting: { ready: true, headline: 'Hi', subline: 'x', gaps: [] },
      error: false,
      refresh: vi.fn(),
    } as unknown,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateSpy }));
vi.mock('@renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  openAccountWeb: (path: string) => openAccountWebSpy(path),
}));
vi.mock('@renderer/hooks/useOnboardingStatus', () => ({
  useOnboardingStatus: () => statusState.current,
}));
vi.mock('@renderer/pages/conversation/components/OnboardingReadinessGreeting', () => ({
  targetToRoute: () => null,
}));

import ErsteSchritteModalContent from '@renderer/components/settings/SettingsModal/contents/ErsteSchritteModalContent';

describe('ErsteSchritteModalContent — the 1.7.2 Day-0 hub', () => {
  beforeEach(() => {
    cleanup();
    navigateSpy.mockClear();
    openAccountWebSpy.mockClear();
  });
  afterEach(() => cleanup());

  it('renders all 9 step cards', () => {
    const { container } = render(<ErsteSchritteModalContent />);
    const cards = container.querySelectorAll('[data-testid^="erste-schritte-step-"]');
    expect(cards.length).toBe(9);
  });

  it("shows the cloud lane as 'done' when first value is ready", () => {
    const { container } = render(<ErsteSchritteModalContent />);
    const kiSpur = container.querySelector('[data-testid="erste-schritte-step-ki-spur"]');
    expect(kiSpur?.getAttribute('data-status')).toBe('done');
  });

  it('navigates in-app for a settings step', () => {
    const { container } = render(<ErsteSchritteModalContent />);
    fireEvent.click(container.querySelector('[data-testid="erste-schritte-step-connectors"]')!);
    expect(navigateSpy).toHaveBeenCalledWith('/settings/connectors');
    expect(openAccountWebSpy).not.toHaveBeenCalled();
  });

  it('opens the web account for the seat-add step (not an in-app route)', () => {
    const { container } = render(<ErsteSchritteModalContent />);
    fireEvent.click(container.querySelector('[data-testid="erste-schritte-step-kunde"]')!);
    expect(openAccountWebSpy).toHaveBeenCalledWith('/account?intent=add_seat');
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it("keeps a null-model read honest: no 'done' chip anywhere", () => {
    statusState.current = {
      loading: false,
      model: null,
      greeting: null,
      error: true,
      refresh: vi.fn(),
    } as unknown as typeof statusState.current;
    const { container } = render(<ErsteSchritteModalContent />);
    expect(container.querySelectorAll('[data-status="done"]').length).toBe(0);
    // The hub still renders (directory works even when status is unknown).
    expect(container.querySelectorAll('[data-testid^="erste-schritte-step-"]').length).toBe(9);
  });
});
