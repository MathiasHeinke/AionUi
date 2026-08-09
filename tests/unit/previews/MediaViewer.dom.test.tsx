/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import MediaPreview from '@/renderer/pages/conversation/Preview/components/viewers/MediaViewer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('MediaPreview', () => {
  it('renders video in the workbench without autoplay', () => {
    render(<MediaPreview type='video' source='https://cdn.example/demo.mp4' title='Demo' />);
    const video = screen.getByTestId('workbench-video-preview');
    expect(video).toHaveAttribute('src', 'https://cdn.example/demo.mp4');
    expect(video).toHaveAttribute('controls');
    expect(video).not.toHaveAttribute('autoplay');
  });

  it('renders an audio player and a truthful empty state', () => {
    const { rerender } = render(
      <MediaPreview type='audio' source='data:audio/mpeg;base64,SUQz' title='Briefing' />
    );
    expect(screen.getByTestId('workbench-audio-preview')).toHaveAttribute('controls');
    expect(screen.getByText('Briefing')).toBeInTheDocument();

    rerender(<MediaPreview type='audio' />);
    expect(screen.getByText('messages.artifact.previewUnavailable')).toBeInTheDocument();
  });
});
