// @vitest-environment jsdom

import { useComposerSpotlight } from '@/renderer/hooks/ui/useComposerSpotlight';
import { act, fireEvent, render, screen } from '@testing-library/react';
import React, { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const Harness = () => {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const handlers = useComposerSpotlight(surfaceRef);

  return (
    <div ref={surfaceRef} data-testid='surface' {...handlers}>
      <textarea data-testid='input' />
    </div>
  );
};

describe('useComposerSpotlight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    );
  });

  afterEach(() => {
    delete document.documentElement.dataset.eveReducedEffects;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pulses on text input and clears the pulse after the animation window', () => {
    render(<Harness />);
    const surface = screen.getByTestId('surface');
    const input = screen.getByTestId('input');

    fireEvent.input(input, { target: { value: 'a' } });
    expect(surface.dataset.typingPulse).toBe('a');

    fireEvent.input(input, { target: { value: 'ab' } });
    expect(surface.dataset.typingPulse).toBe('b');

    act(() => vi.advanceTimersByTime(420));
    expect(surface).not.toHaveAttribute('data-typing-pulse');
  });

  it('does not animate typing when reduced effects are enabled', () => {
    document.documentElement.dataset.eveReducedEffects = 'true';
    render(<Harness />);

    fireEvent.input(screen.getByTestId('input'), { target: { value: 'a' } });
    expect(screen.getByTestId('surface')).not.toHaveAttribute('data-typing-pulse');
  });
});
