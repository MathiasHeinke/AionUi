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

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import { DEFAULT_VIDEO_TIER_ID, type VideoModelSelection, type VideoQualityTier } from '@/common/config/videoCostCore';
import { VIDEO_CATALOG_SNAPSHOT, type VideoCatalogEntry } from '@/common/config/videoCatalogCore';

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
      <VideoQualityPill visible value='hd' onChange={vi.fn()} durationSeconds={5} modeKind='text' capabilities={HD15} />
    );
    // 5s x 500 credits/s (1080p on grok-imagine-video-1.5, $0.25/s).
    expect(screen.getByTestId('video-quality-pill-estimate')).toHaveTextContent('2500');
  });

  // ITEM E AT THE SURFACE THE USER TOUCHES. Same tier, same resolution, two
  // models — so two prices. A pill that priced by tier would show 700 for both.
  it('prices the MODEL the mode will actually use, not the tier', () => {
    const { rerender } = render(
      <VideoQualityPill
        visible
        value='fast'
        onChange={vi.fn()}
        durationSeconds={5}
        modeKind='text'
        capabilities={HD15}
      />
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

// ---------------------------------------------------------------------------
// MAT-1773 (F8) — the catalog-fed model dropdown
// ---------------------------------------------------------------------------

/** Four curated models (Seedance is unpriceable upstream) plus three extras. */
const F8_CATALOG: VideoCatalogEntry[] = VIDEO_CATALOG_SNAPSHOT.filter((entry) =>
  [
    'x-ai/grok-imagine-video-1.5',
    'google/veo-3.1',
    'openai/sora-2-pro',
    'black-forest-labs/flux-3-video',
    'minimax/hailuo-3',
    'alibaba/wan-2.6',
    'kwaivgi/kling-v3.0-pro',
  ].includes(entry.id)
);

const renderCatalogPill = (
  overrides: Partial<React.ComponentProps<typeof VideoQualityPill>> & {
    modelId?: VideoModelSelection;
    onModelChange?: (modelId: VideoModelSelection) => void;
  } = {}
) => {
  const props: React.ComponentProps<typeof VideoQualityPill> = {
    visible: true,
    value: 'fast' as VideoQualityTier,
    onChange: vi.fn(),
    modeKind: 'text',
    durationSeconds: 5,
    capabilities: HD15,
    catalogEntries: F8_CATALOG,
    onModelChange: vi.fn(),
    onResolutionChange: vi.fn(),
    onDurationChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<VideoQualityPill {...props} />), props };
};

const openModelDropdown = () => {
  fireEvent.click(screen.getByTestId('video-model-dropdown-trigger'));
  return screen.getByTestId('video-model-dropdown');
};

describe('VideoQualityPill model dropdown (MAT-1773 F8)', () => {
  it('renders the curated shortlist in order behind a native trigger, plus Weitere anzeigen', () => {
    renderCatalogPill();

    // The resting default is Grok Imagine Video 1.5, shown on the trigger.
    expect(screen.getByTestId('video-model-dropdown-trigger').textContent).toContain('Grok Imagine Video 1.5');

    const list = openModelDropdown();
    const entries = list.querySelectorAll('[role="option"]');
    // Seedance 2.0 is token-priced upstream: four shown, never an invented price.
    expect(entries).toHaveLength(4);
    expect([...entries].map((el) => el.getAttribute('data-testid'))).toEqual([
      'video-model-entry-x-ai/grok-imagine-video-1.5',
      'video-model-entry-google/veo-3.1',
      'video-model-entry-openai/sora-2-pro',
      'video-model-entry-black-forest-labs/flux-3-video',
    ]);

    // Everything past the shortlist stays hidden behind the final entry.
    expect(screen.getByTestId('video-model-show-more').textContent).toBe('Weitere anzeigen');
    expect(screen.queryByTestId('video-model-entry-minimax/hailuo-3')).toBeNull();
  });

  it('expands the full catalog IN-PLACE, sorted by USD/second ascending (cheapest first)', () => {
    renderCatalogPill();
    const list = openModelDropdown();

    fireEvent.click(screen.getByTestId('video-model-show-more'));

    // No page jump, no modal: the same listbox now carries every catalog entry.
    const entries = screen.getByTestId('video-model-dropdown').querySelectorAll('[role="option"]');
    expect(entries).toHaveLength(F8_CATALOG.length);
    expect(list.isConnected).toBe(true);

    // The expansion beyond the shortlist is base-price ascending.
    const beyondTestIds = [...entries].slice(4).map((el) => el.getAttribute('data-testid'));
    expect(beyondTestIds).toEqual([
      'video-model-entry-alibaba/wan-2.6',
      'video-model-entry-kwaivgi/kling-v3.0-pro',
      'video-model-entry-minimax/hailuo-3',
    ]);
    expect(entries[4].textContent).toContain('0,08 $/s');
    expect(screen.queryByTestId('video-model-show-more')).toBeNull();
  });

  it('updates the credit estimate from the catalog price when a model is selected', () => {
    const onModelChange = vi.fn();
    const { rerender, props } = renderCatalogPill({ onModelChange });

    // Default: Grok Imagine Video 1.5 at 720p = $0.14/s -> 280 credits/s -> 5s.
    expect(screen.getByTestId('video-quality-pill-estimate').textContent).toBe('ca. 1400 Credits / 5s');
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-model', 'grok-imagine-video-1.5');

    openModelDropdown();
    fireEvent.click(screen.getByTestId('video-model-show-more'));
    // Each row carries name + price/s + the derived estimate for its own
    // nearest supported combination at the current request (H3: 2K/5s).
    const hailuoRow = screen.getByTestId('video-model-entry-minimax/hailuo-3');
    expect(hailuoRow.textContent).toContain('MiniMax H3');
    expect(hailuoRow.textContent).toContain('0,13 $/s');
    expect(hailuoRow.textContent).toContain('≈ 1300 Credits');

    fireEvent.click(hailuoRow);
    expect(onModelChange).toHaveBeenCalledWith('minimax/hailuo-3');

    // The parent re-renders with the pick (controlled prop), and the estimate
    // the user reads is the catalog price of the model the send will carry.
    rerender(<VideoQualityPill {...props} modelId='minimax/hailuo-3' />);
    expect(screen.getByTestId('video-quality-pill-estimate').textContent).toBe('ca. 1300 Credits / 5s');
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-model', 'minimax/hailuo-3');
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-resolution', '2K');
    expect(screen.getByTestId('video-model-dropdown-trigger').textContent).toContain('MiniMax H3');
  });

  it('falls back to the bundled snapshot with prices marked approximate', () => {
    renderCatalogPill({ catalogEntries: VIDEO_CATALOG_SNAPSHOT, catalogApproximate: true });

    openModelDropdown();
    expect(screen.getByTestId('video-model-approximate-note').textContent).toBe('Richtpreise aus dem Offline-Katalog');

    fireEvent.click(screen.getByTestId('video-model-show-more'));
    const entries = screen.getByTestId('video-model-dropdown').querySelectorAll('[role="option"]');
    // The full 18-model snapshot: curated four first, the Grok base model
    // ($0.05/s) heading the price-ascending rest.
    expect(entries).toHaveLength(18);
    expect(entries[4].getAttribute('data-testid')).toBe('video-model-entry-x-ai/grok-imagine-video');
  });

  it('keeps the legacy two-model radio when no catalog is provided', () => {
    renderCatalogPill({ catalogEntries: undefined, modelId: undefined });

    expect(screen.getByTestId('video-model-option-grok-imagine-video')).toBeTruthy();
    expect(screen.getByTestId('video-model-option-grok-imagine-video-1.5')).toBeTruthy();
    expect(screen.queryByTestId('video-model-dropdown-trigger')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MAT-1773 (F8b) — resolution + duration dropdowns filtered by the model
// ---------------------------------------------------------------------------

describe('VideoQualityPill resolution/duration dropdowns (MAT-1773 F8b)', () => {
  it('filters the resolution options to the SELECTED model (Grok: 480p/720p/1080p)', () => {
    renderCatalogPill();

    fireEvent.click(screen.getByTestId('video-resolution-dropdown-trigger'));
    const options = screen.getByTestId('video-resolution-dropdown').querySelectorAll('[role="option"]');
    expect([...options].map((el) => el.getAttribute('data-testid'))).toEqual([
      'video-resolution-option-480p',
      'video-resolution-option-720p',
      'video-resolution-option-1080p',
    ]);
  });

  it('filters resolution AND duration to a FLUX.3 pick (720p/1080p, 5..20s)', () => {
    renderCatalogPill({ modelId: 'black-forest-labs/flux-3-video' });

    fireEvent.click(screen.getByTestId('video-resolution-dropdown-trigger'));
    const resolutions = screen.getByTestId('video-resolution-dropdown').querySelectorAll('[role="option"]');
    expect([...resolutions].map((el) => el.getAttribute('data-testid'))).toEqual([
      'video-resolution-option-720p',
      'video-resolution-option-1080p',
    ]);
    // 480p is UNSELECTABLE — filtered out, not a late error.
    expect(screen.queryByTestId('video-resolution-option-480p')).toBeNull();
    fireEvent.click(screen.getByTestId('video-resolution-dropdown-trigger'));

    fireEvent.click(screen.getByTestId('video-duration-dropdown-trigger'));
    const durations = screen.getByTestId('video-duration-dropdown').querySelectorAll('[role="option"]');
    expect(durations).toHaveLength(16); // 5..20s
    expect(durations[0].getAttribute('data-testid')).toBe('video-duration-option-5');
    expect(durations[15].getAttribute('data-testid')).toBe('video-duration-option-20');
  });

  it('reports resolution + duration picks and prices the exact combination', () => {
    const onResolutionChange = vi.fn();
    const onChange = vi.fn();
    const onDurationChange = vi.fn();
    const { rerender, props } = renderCatalogPill({
      modelId: 'black-forest-labs/flux-3-video',
      onResolutionChange,
      onChange,
      onDurationChange,
    });

    fireEvent.click(screen.getByTestId('video-resolution-dropdown-trigger'));
    fireEvent.click(screen.getByTestId('video-resolution-option-1080p'));
    expect(onResolutionChange).toHaveBeenCalledWith('1080p');
    expect(onChange).toHaveBeenCalledWith('hd');

    rerender(<VideoQualityPill {...props} resolution='1080p' durationSeconds={20} />);
    // FLUX 1080p 20s: 580 credits/s -> 11600 — the exact SKU combination.
    expect(screen.getByTestId('video-quality-pill-estimate').textContent).toBe('ca. 11600 Credits / 20s');
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-resolution', '1080p');

    fireEvent.click(screen.getByTestId('video-duration-dropdown-trigger'));
    fireEvent.click(screen.getByTestId('video-duration-option-20'));
    expect(onDurationChange).toHaveBeenCalledWith(20);
  });

  it('auto-picks the nearest supported resolution/duration on a model switch and shows the change', () => {
    const onResolutionChange = vi.fn();
    const onDurationChange = vi.fn();
    const { rerender, props } = renderCatalogPill({
      modelId: 'x-ai/grok-imagine-video-1.5',
      resolution: '480p',
      durationSeconds: 5,
      onResolutionChange,
      onDurationChange,
    });

    // Switch to FLUX.3: 480p does not exist there — the effect reports the
    // nearest supported resolution upward (720p), so the change is real state.
    rerender(
      <VideoQualityPill
        {...props}
        modelId='black-forest-labs/flux-3-video'
        resolution='480p'
        durationSeconds={5}
        onResolutionChange={onResolutionChange}
        onDurationChange={onDurationChange}
      />
    );
    expect(onResolutionChange).toHaveBeenCalledWith('720p');

    // Switch to Veo (durations 4/6/8): a 5s request auto-picks the nearest
    // supported duration and reports it.
    rerender(
      <VideoQualityPill
        {...props}
        modelId='google/veo-3.1'
        resolution='720p'
        durationSeconds={5}
        onResolutionChange={onResolutionChange}
        onDurationChange={onDurationChange}
      />
    );
    expect(onDurationChange).toHaveBeenCalledWith(4);
  });

  it('hides the resolution dropdown for a resolution-flat model and prices the default key', () => {
    renderCatalogPill({ modelId: 'runway/aleph-2', catalogEntries: VIDEO_CATALOG_SNAPSHOT });

    expect(screen.queryByTestId('video-resolution-dropdown-trigger')).toBeNull();
    // Aleph 2: 560 credits/s -> 5s = 2800, from the resolution-flat default key.
    expect(screen.getByTestId('video-quality-pill-estimate').textContent).toBe('ca. 2800 Credits / 5s');
  });
});
