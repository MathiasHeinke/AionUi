/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

import ImageAspectRatioPill from '@/renderer/components/billing/ImageAspectRatioPill';

afterEach(cleanup);

describe('ImageAspectRatioPill', () => {
  it('renders only in explicit image-create state', () => {
    const { rerender } = render(<ImageAspectRatioPill visible={false} value='16:9' onChange={vi.fn()} />);
    expect(screen.queryByTestId('image-aspect-ratio-dropdown-trigger')).toBeNull();

    rerender(<ImageAspectRatioPill visible value='16:9' onChange={vi.fn()} />);
    expect(screen.getByTestId('image-aspect-ratio-dropdown-trigger')).toHaveTextContent('16:9');
  });

  it('offers only managed-lane formats and reports the exact click', () => {
    const onChange = vi.fn();
    render(<ImageAspectRatioPill visible value='16:9' onChange={onChange} />);

    fireEvent.click(screen.getByTestId('image-aspect-ratio-dropdown-trigger'));
    expect(screen.getByTestId('image-aspect-ratio-dropdown').querySelectorAll('[role="option"]')).toHaveLength(10);
    fireEvent.click(screen.getByTestId('image-aspect-ratio-option-1-1'));

    expect(onChange).toHaveBeenCalledWith('1:1');
  });
});
