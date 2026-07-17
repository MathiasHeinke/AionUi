/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@arco-design/web-react', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <span data-testid='context-popover'>{children}</span>,
}));

vi.mock('@/renderer/components/agent/ContextCreditsPopover', () => ({
  default: () => <span>details</span>,
}));

import ContextUsageIndicator from '@/renderer/components/agent/ContextUsageIndicator';

describe('ContextUsageIndicator', () => {
  it('renders a bare ring when its parent already owns the details control', () => {
    const { container } = render(<ContextUsageIndicator tokenUsage={null} showDetails={false} />);
    expect(container.querySelector('.context-usage-indicator')).not.toBeNull();
    expect(screen.queryByTestId('context-popover')).toBeNull();
  });

  it('keeps standalone context rings interactive by default', () => {
    render(<ContextUsageIndicator tokenUsage={null} />);
    expect(screen.getByTestId('context-popover')).toBeInTheDocument();
  });
});
