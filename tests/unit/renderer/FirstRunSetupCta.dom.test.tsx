/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FirstRunSetupCta, {
  type FirstRunSetupCtaProps,
  shouldShowFirstRunSetupCta,
} from '@/renderer/pages/guid/components/FirstRunSetupCta';

afterEach(() => cleanup());

const model = (firstValueReady: boolean, identityState: 'ok' | 'blocked' | 'skipped') =>
  ({
    first_value_ready: firstValueReady,
    items: [{ id: 'identity', state: identityState }],
  }) as FirstRunSetupCtaProps['onboardingModel'];

const baseProps = (): FirstRunSetupCtaProps => ({
  shellEnabled: true,
  profileLoaded: true,
  onboardingLoading: false,
  onboardingModel: model(false, 'blocked'),
  label: 'Mit EVE einrichten',
  onOpen: vi.fn(),
});

describe('FirstRunSetupCta', () => {
  it('uses only canonical onboarding truth for visibility', () => {
    expect(shouldShowFirstRunSetupCta(baseProps())).toBe(true);
    expect(shouldShowFirstRunSetupCta({ ...baseProps(), onboardingModel: model(true, 'ok') })).toBe(false);
    expect(shouldShowFirstRunSetupCta({ ...baseProps(), onboardingModel: model(true, 'blocked') })).toBe(true);
    expect(shouldShowFirstRunSetupCta({ ...baseProps(), onboardingModel: null })).toBe(false);
    expect(shouldShowFirstRunSetupCta({ ...baseProps(), onboardingLoading: true })).toBe(false);
  });

  it('offers one user-triggered setup action and performs no automatic work', () => {
    const onOpen = vi.fn();
    render(<FirstRunSetupCta {...baseProps()} onOpen={onOpen} />);

    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('guid-first-run-setup-cta'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
