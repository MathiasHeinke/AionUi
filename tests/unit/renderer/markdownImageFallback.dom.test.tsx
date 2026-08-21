/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const { getImageBase64InvokeMock } = vi.hoisted(() => ({ getImageBase64InvokeMock: vi.fn() }));

vi.mock('@/common', () => ({
  ipcBridge: { fs: { getImageBase64: { invoke: getImageBase64InvokeMock } } },
}));
import MarkdownImage from '@/renderer/components/Markdown/MarkdownImage';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Markdown image failure states', () => {
  it('replaces an unresolved local markdown image with its accessible label', async () => {
    getImageBase64InvokeMock.mockResolvedValue(null);
    render(<MarkdownImage src='bilder/fehlend.png' alt='Richtung 1' />);

    await waitFor(() => expect(screen.getByTestId('local-image-fallback')).toHaveTextContent('Richtung 1'));
    expect(screen.queryByRole('img', { name: 'Richtung 1' })?.tagName).toBe('SPAN');
  });

  it('keeps the local fallback when the source has malformed percent encoding', async () => {
    getImageBase64InvokeMock.mockResolvedValue(null);
    render(<MarkdownImage src='bilder/kaputt%bild.png' alt='Richtung 1' />);

    await waitFor(() => expect(screen.getByTestId('local-image-fallback')).toHaveTextContent('Richtung 1'));
    expect(getImageBase64InvokeMock).toHaveBeenCalledWith({
      path: 'bilder/kaputt%bild.png',
      workspace: undefined,
    });
  });

  it('does not leave a broken browser image when a remote source fails', () => {
    render(<MarkdownImage src='https://example.invalid/fehlend.png' alt='Richtung 2' />);
    fireEvent.error(screen.getByRole('img', { name: 'Richtung 2' }));

    expect(screen.getByTestId('markdown-image-fallback')).toHaveTextContent('Richtung 2');
    expect(screen.queryByRole('img', { name: 'Richtung 2' })?.tagName).toBe('SPAN');
  });
});
