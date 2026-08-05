/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1773 P3 — start-chat/conversation parity: the guid surface renders the
 * SAME video pill on a video-create intent, and the selection the user makes
 * there is the selection the send carries.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  videoCapabilitiesInvoke: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    commandEve: {
      videoCapabilities: { invoke: harness.videoCapabilitiesInvoke },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> & { defaultValue?: string }) => {
      const template = typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(opts?.[name] ?? ''));
    },
  }),
}));

import GuidVideoPill from '@/renderer/pages/guid/components/GuidVideoPill';
import {
  useVideoComposerSelection,
  type VideoDraftSelection,
} from '@/renderer/components/billing/useVideoComposerSelection';

const VIDEO_INTENT = 'Erstelle ein Video: eine lila Aubergine dreht sich langsam.';

/** Renders the pill over the REAL shared hook and exposes the carried selection. */
const Harness: React.FC<{ input: string; files?: string[] }> = ({ input, files = [] }) => {
  const selection = useVideoComposerSelection();
  const carried: VideoDraftSelection = selection.currentSelection();
  return (
    <>
      <span data-testid='carried-selection'>{JSON.stringify(carried)}</span>
      <GuidVideoPill input={input} files={files} selection={selection} />
    </>
  );
};

describe('GuidVideoPill (MAT-1773 P3 parity)', () => {
  beforeEach(() => {
    harness.videoCapabilitiesInvoke.mockResolvedValue({
      success: true,
      data: { hd15Available: true, presetVoicesAvailable: false },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the full pill on a video-create intent, with the estimate', async () => {
    render(<Harness input={VIDEO_INTENT} />);

    // The capabilities answer arrives async; hd15 flips the default to 1.5.
    await waitFor(() =>
      expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-model', 'grok-imagine-video-1.5')
    );
    const pill = screen.getByTestId('video-quality-pill');
    expect(pill).toHaveAttribute('data-model', 'grok-imagine-video-1.5');
    expect(screen.getByTestId('video-model-dropdown-trigger')).toBeTruthy();
    expect(screen.getByTestId('video-resolution-dropdown-trigger')).toBeTruthy();
    expect(screen.getByTestId('video-duration-dropdown-trigger')).toBeTruthy();
    expect(screen.getByTestId('video-quality-pill-estimate').textContent).toBe('ca. 1400 Credits / 5s');
  });

  it('renders nothing for an ordinary chat draft', () => {
    render(<Harness input='Fass die Zahlen von gestern zusammen.' />);
    expect(screen.queryByTestId('video-quality-pill')).toBeNull();
  });

  it('a model pick on guid becomes the selection the send carries', () => {
    render(<Harness input={VIDEO_INTENT} />);

    fireEvent.click(screen.getByTestId('video-model-dropdown-trigger'));
    fireEvent.click(screen.getByTestId('video-model-show-more'));
    fireEvent.click(screen.getByTestId('video-model-entry-minimax/hailuo-3'));

    const carried = JSON.parse(screen.getByTestId('carried-selection').textContent ?? '{}');
    expect(carried).toMatchObject({ modelId: 'minimax/hailuo-3', durationSeconds: 5 });
    // The pill estimate follows the same pick — one selection, one price.
    expect(screen.getByTestId('video-quality-pill-estimate').textContent).toBe('ca. 1300 Credits / 5s');
  });

  it('a resolution pick on guid is carried with its exact catalog resolution', async () => {
    render(<Harness input={VIDEO_INTENT} />);

    await waitFor(() => expect(screen.getByTestId('video-resolution-dropdown-trigger')).toBeTruthy());
    fireEvent.click(screen.getByTestId('video-resolution-dropdown-trigger'));
    fireEvent.click(screen.getByTestId('video-resolution-option-1080p'));

    const carried = JSON.parse(screen.getByTestId('carried-selection').textContent ?? '{}');
    expect(carried).toMatchObject({ resolution: '1080p' });
    expect(screen.getByTestId('video-quality-pill')).toHaveAttribute('data-resolution', '1080p');
  });
});
