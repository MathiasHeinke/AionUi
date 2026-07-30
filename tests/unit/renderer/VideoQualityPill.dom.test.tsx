/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The inline video-quality selector.
 *
 * These tests pin two separate properties, and the second matters more than the
 * first: that HD is REACHABLE (the defect that removing the cost wall introduced),
 * and that reaching it is NOT a gate (the defect that the cost wall itself was).
 * A future change that turns this picker back into a confirm step should fail
 * here, loudly, rather than pass because "the tier is still selectable".
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, o?: Record<string, unknown>) => {
      let s = (o?.defaultValue as string) ?? _k;
      if (o) {
        for (const [key, val] of Object.entries(o)) {
          if (key === 'defaultValue') continue;
          s = s.replace(new RegExp(`{{${key}}}`, 'g'), String(val));
        }
      }
      return s;
    },
  }),
}));

import VideoQualityPill from '@/renderer/components/billing/VideoQualityPill';
import { DEFAULT_VIDEO_TIER_ID } from '@/common/config/videoCostCore';

afterEach(cleanup);

describe('VideoQualityPill', () => {
  it('renders nothing when the draft does not route to the video lane', () => {
    render(<VideoQualityPill visible={false} value='fast' onChange={vi.fn()} />);
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
  });

  it('offers both tiers and starts on the cheaper default', () => {
    render(<VideoQualityPill visible value={DEFAULT_VIDEO_TIER_ID} onChange={vi.fn()} />);

    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-selected-tier', 'fast');
    expect(screen.getByTestId('video-quality-option-fast')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('video-quality-option-hd')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('video-quality-option-hd')).toHaveTextContent('1080p');
  });

  it('reports an HD selection to the caller — the tier is reachable again', async () => {
    const onChange = vi.fn();
    render(<VideoQualityPill visible value='fast' onChange={onChange} />);

    await userEvent.click(screen.getByTestId('video-quality-option-hd'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('hd');
  });

  it('never upgrades on its own — no click, no change', () => {
    const onChange = vi.fn();
    render(<VideoQualityPill visible value='fast' onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('prices the SELECTED tier, so the number tracks the choice', () => {
    const { rerender } = render(<VideoQualityPill visible value='fast' onChange={vi.fn()} durationSeconds={5} />);
    // 5s x 24 credits/s
    expect(screen.getByTestId('video-quality-pill-estimate')).toHaveTextContent('120');

    rerender(<VideoQualityPill visible value='hd' onChange={vi.fn()} durationSeconds={5} />);
    // 5s x 68 credits/s — visibly dearer, stated before the send, blocking nothing.
    expect(screen.getByTestId('video-quality-pill-estimate')).toHaveTextContent('340');
  });

  it('is a picker, not a gate: it has no confirm, no cancel and no dialog', () => {
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} />);

    // The tier options are radios, so the control exposes exactly TWO radios and
    // ZERO buttons. A "fortfahren"/"abbrechen" pair would arrive as buttons —
    // this asserts the consent dialog cannot come back wearing a pill.
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('video-cost-wall-confirm')).toBeNull();
    expect(screen.queryByTestId('video-cost-wall-cancel')).toBeNull();
  });
});
