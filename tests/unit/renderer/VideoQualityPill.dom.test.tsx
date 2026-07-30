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
    render(<VideoQualityPill visible={false} value='fast' onChange={vi.fn()} inputMode='text' />);
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
  });

  it('offers both tiers and starts on the cheaper default', () => {
    render(<VideoQualityPill visible value={DEFAULT_VIDEO_TIER_ID} onChange={vi.fn()} inputMode='text' />);

    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-selected-tier', 'fast');
    expect(screen.getByTestId('video-quality-option-fast')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('video-quality-option-sd')).toHaveTextContent('480p');
    expect(screen.getByTestId('video-quality-option-fast')).toHaveTextContent('720p');
    // The correction: no 1080p for a text prompt, because no model can make it.
    expect(screen.queryByTestId('video-quality-option-hd')).toBeNull();
  });

  it('reports an HD selection to the caller — reachable only with an image', async () => {
    const onChange = vi.fn();
    render(<VideoQualityPill visible value='fast' onChange={onChange} inputMode='image' hd15Available />);

    await userEvent.click(screen.getByTestId('video-quality-option-hd'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('hd');
  });

  it('never upgrades on its own — no click, no change', () => {
    const onChange = vi.fn();
    render(<VideoQualityPill visible value='fast' onChange={onChange} inputMode='text' />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('prices the SELECTED tier, so the number tracks the choice', () => {
    const { rerender } = render(
      <VideoQualityPill visible value='fast' onChange={vi.fn()} durationSeconds={5} inputMode='text' />
    );
    // 5s x 140 credits/s (720p on grok-imagine-video, $0.07/s)
    expect(screen.getByTestId('video-quality-pill-estimate')).toHaveTextContent('700');

    rerender(
      <VideoQualityPill visible value='hd' onChange={vi.fn()} durationSeconds={5} inputMode='image' hd15Available />
    );
    // 5s x 500 credits/s (1080p on grok-imagine-video-1.5, $0.25/s).
    expect(screen.getByTestId('video-quality-pill-estimate')).toHaveTextContent('2500');
  });

  it('is a picker, not a gate: it has no confirm, no cancel and no dialog', () => {
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} inputMode='text' />);

    // The tier options are radios, so the control exposes exactly TWO radios and
    // ZERO buttons. A "fortfahren"/"abbrechen" pair would arrive as buttons —
    // this asserts the consent dialog cannot come back wearing a pill.
    expect(screen.getAllByRole('radio')).toHaveLength(2); // text prompt => 480p + 720p
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('video-cost-wall-confirm')).toBeNull();
    expect(screen.queryByTestId('video-cost-wall-cancel')).toBeNull();
  });
  it('never offers 1080p without an image, whatever the entitlement says', () => {
    // The negative matrix, at the surface the user actually touches.
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} inputMode='text' hd15Available />);
    expect(screen.queryByTestId('video-quality-option-hd')).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('never offers 1080p when 1.5 is unproven, even with an image', () => {
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} inputMode='image' />);
    expect(screen.queryByTestId('video-quality-option-hd')).toBeNull();
  });

  it('offers 1080p only when an image AND 1.5 are both present', () => {
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} inputMode='image' hd15Available />);
    expect(screen.getByTestId('video-quality-option-hd')).toHaveTextContent('1080p');
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });
});
