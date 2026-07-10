/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppLoader from '@/renderer/components/layout/AppLoader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe('AppLoader', () => {
  it('uses the EVE route-fallback surface and branded glyph', () => {
    render(<AppLoader />);

    const loader = screen.getByRole('status', { name: 'common.loading' });
    expect(loader.classList.contains('eve-app-loader')).toBe(true);
    expect(screen.getByTestId('command-eve-glyph')).toBeInTheDocument();
  });
});
