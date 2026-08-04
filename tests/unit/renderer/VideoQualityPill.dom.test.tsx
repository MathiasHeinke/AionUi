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

/** A seat with grok-imagine-video-1.5 proven available, and nothing else. */
const HD15 = { hd15Available: true } as const;
/** …and one that is additionally a US trusted partner for preset voices. */
const HD15_VOICES = { hd15Available: true, presetVoicesAvailable: true } as const;
const VOICES = [
  { id: 'voice-a', label: 'A' },
  { id: 'voice-b', label: 'B' },
] as const;

afterEach(cleanup);

describe('VideoQualityPill', () => {
  it('renders nothing when the draft does not route to the video lane', () => {
    render(<VideoQualityPill visible={false} value='fast' onChange={vi.fn()} modeKind='text' />);
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
  });

  it('offers both tiers and starts on the cheaper default', () => {
    render(<VideoQualityPill visible value={DEFAULT_VIDEO_TIER_ID} onChange={vi.fn()} modeKind='text' />);

    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-selected-tier', 'fast');
    expect(screen.getByTestId('video-quality-option-fast')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('video-quality-option-sd')).toHaveTextContent('480p');
    expect(screen.getByTestId('video-quality-option-fast')).toHaveTextContent('720p');
    // No 1080p while 1.5 is unproven — the resolution exists, the entitlement does not.
    expect(screen.queryByTestId('video-quality-option-hd')).toBeNull();
  });

  it('reports an HD selection to the caller', async () => {
    const onChange = vi.fn();
    render(<VideoQualityPill visible value='fast' onChange={onChange} modeKind='text' capabilities={HD15} />);

    await userEvent.click(screen.getByTestId('video-quality-option-hd'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('hd');
  });

  it('contextually exposes model, resolution and duration without a popup', async () => {
    const onModelChange = vi.fn();
    const onDurationChange = vi.fn();
    render(
      <VideoQualityPill
        visible
        value='fast'
        onChange={vi.fn()}
        modelId='grok-imagine-video-1.5'
        onModelChange={onModelChange}
        durationSeconds={10}
        onDurationChange={onDurationChange}
        modeKind='text'
        capabilities={HD15}
      />
    );

    expect(screen.getByTestId('video-model-option-grok-imagine-video-1.5')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('video-duration-option-10')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('video-quality-pill-estimate')).toHaveTextContent('2800');
    expect(screen.queryByRole('dialog')).toBeNull();

    await userEvent.click(screen.getByTestId('video-model-option-grok-imagine-video'));
    await userEvent.click(screen.getByTestId('video-duration-option-15'));
    expect(onModelChange).toHaveBeenCalledWith('grok-imagine-video');
    expect(onDurationChange).toHaveBeenCalledWith(15);
  });

  it('never upgrades on its own — no click, no change', () => {
    const onChange = vi.fn();
    render(<VideoQualityPill visible value='fast' onChange={onChange} modeKind='text' />);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('prices the SELECTED tier, so the number tracks the choice', () => {
    const { rerender } = render(
      <VideoQualityPill visible value='fast' onChange={vi.fn()} durationSeconds={5} modeKind='text' />
    );
    // 5s x 140 credits/s (720p on grok-imagine-video, $0.07/s)
    expect(screen.getByTestId('video-quality-pill-estimate')).toHaveTextContent('700');

    rerender(
      <VideoQualityPill
        visible
        value='hd'
        onChange={vi.fn()}
        durationSeconds={5}
        modeKind='text'
        capabilities={HD15}
      />
    );
    // 5s x 500 credits/s (1080p on grok-imagine-video-1.5, $0.25/s).
    expect(screen.getByTestId('video-quality-pill-estimate')).toHaveTextContent('2500');
  });

  // ITEM E AT THE SURFACE THE USER TOUCHES. Same tier, same resolution, two
  // models — so two prices. A pill that priced by tier would show 700 for both.
  it('prices the MODEL the mode will actually use, not the tier', () => {
    const { rerender } = render(
      <VideoQualityPill visible value='fast' onChange={vi.fn()} durationSeconds={5} modeKind='text' capabilities={HD15} />
    );
    expect(screen.getByTestId('video-quality-pill-estimate')).toHaveTextContent('700');
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-model', 'grok-imagine-video');

    rerender(
      <VideoQualityPill
        visible
        value='fast'
        onChange={vi.fn()}
        durationSeconds={5}
        modeKind='reference'
        capabilities={HD15}
      />
    );
    // 5s x 280 credits/s (720p on grok-imagine-video-1.5, $0.14/s) — double.
    expect(screen.getByTestId('video-quality-pill-estimate')).toHaveTextContent('1400');
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-model', 'grok-imagine-video-1.5');
  });

  it('is a picker, not a gate: it has no confirm, no cancel and no dialog', () => {
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} modeKind='text' />);

    // The tier options are radios, so the control exposes exactly TWO radios and
    // ZERO buttons. A "fortfahren"/"abbrechen" pair would arrive as buttons —
    // this asserts the consent dialog cannot come back wearing a pill.
    expect(screen.getAllByRole('radio')).toHaveLength(2); // no 1.5 => 480p + 720p
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('video-cost-wall-confirm')).toBeNull();
    expect(screen.queryByTestId('video-cost-wall-cancel')).toBeNull();
  });

  // INVERTED, MAT-1753. This block used to be "never offers 1080p without an
  // image, whatever the entitlement says" — the picker half of the false
  // "image-to-video only" belief, and the reason a bare prompt could never buy
  // HD in the product. The negative half that IS true is kept below.
  it('offers 1080p to a bare TEXT prompt once 1.5 is available', () => {
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} modeKind='text' capabilities={HD15} />);
    expect(screen.getByTestId('video-quality-option-hd')).toHaveTextContent('1080p');
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('never offers 1080p when 1.5 is unproven, even with an image', () => {
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} modeKind='image' />);
    expect(screen.queryByTestId('video-quality-option-hd')).toBeNull();
  });

  it('offers 1080p for an image once 1.5 is present', () => {
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} modeKind='image' capabilities={HD15} />);
    expect(screen.getByTestId('video-quality-option-hd')).toHaveTextContent('1080p');
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('never offers 1080p in reference mode — it clamps to 720p', () => {
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} modeKind='reference' capabilities={HD15} />);
    expect(screen.queryByTestId('video-quality-option-hd')).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('renders nothing at all for reference mode when 1.5 is unproven', () => {
    render(<VideoQualityPill visible value='fast' onChange={vi.fn()} modeKind='reference' />);
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
  });

  // ---------------------------------------------------------------------
  // PRESET VOICES — US trusted-partner only, so the control must not RENDER
  // ---------------------------------------------------------------------

  it('does not render the voice control for a seat without the entitlement', () => {
    render(
      <VideoQualityPill
        visible
        value='fast'
        onChange={vi.fn()}
        modeKind='reference'
        capabilities={HD15}
        presetVoices={VOICES}
      />
    );
    // Not disabled, not hidden, not refused after a click — ABSENT.
    expect(screen.queryByTestId('video-preset-voices')).toBeNull();
    expect(screen.queryByTestId('video-preset-voice-voice-a')).toBeNull();
  });

  it('renders the voice control only for an entitled seat, in reference mode', () => {
    const { rerender } = render(
      <VideoQualityPill
        visible
        value='fast'
        onChange={vi.fn()}
        modeKind='reference'
        capabilities={HD15_VOICES}
        presetVoices={VOICES}
      />
    );
    expect(screen.getByTestId('video-preset-voices')).toBeTruthy();

    // The SAME entitled seat in text mode: still no voice control, because the
    // mode cannot carry one.
    rerender(
      <VideoQualityPill
        visible
        value='fast'
        onChange={vi.fn()}
        modeKind='text'
        capabilities={HD15_VOICES}
        presetVoices={VOICES}
      />
    );
    expect(screen.queryByTestId('video-preset-voices')).toBeNull();
  });

  it('stops offering a further voice once three are chosen', () => {
    const many = [
      { id: 'v1', label: '1' },
      { id: 'v2', label: '2' },
      { id: 'v3', label: '3' },
      { id: 'v4', label: '4' },
    ];
    render(
      <VideoQualityPill
        visible
        value='fast'
        onChange={vi.fn()}
        modeKind='reference'
        capabilities={HD15_VOICES}
        presetVoices={many}
        selectedVoiceIds={['v1', 'v2', 'v3']}
        onVoiceToggle={vi.fn()}
      />
    );
    expect(screen.getByTestId('video-preset-voice-v4')).toBeDisabled();
    // An already-chosen one stays clickable, so a choice can be undone.
    expect(screen.getByTestId('video-preset-voice-v1')).not.toBeDisabled();
  });

  it('exposes no custom-audio control of any kind', () => {
    render(
      <VideoQualityPill
        visible
        value='fast'
        onChange={vi.fn()}
        modeKind='reference'
        capabilities={HD15_VOICES}
        presetVoices={VOICES}
      />
    );
    const pill = screen.getByTestId('video-quality-pill');
    // No file input, and nothing whose test id or markup offers an upload.
    expect(pill.querySelectorAll('input[type="file"]')).toHaveLength(0);
    expect(pill.innerHTML).not.toMatch(/upload|custom.?audio/i);
  });
});
