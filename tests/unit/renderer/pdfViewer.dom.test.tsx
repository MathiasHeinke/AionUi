import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PDFPreview from '@/renderer/pages/conversation/Preview/components/viewers/PDFViewer';

vi.mock('@/common', () => ({
  ipcBridge: {
    shell: {
      openFile: { invoke: vi.fn() },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewToolbarExtrasContext', () => ({
  usePreviewToolbarExtras: () => null,
}));

describe('PDFPreview', () => {
  it('renders PDF content in an iframe instead of Electron webview', () => {
    render(<PDFPreview content='data:application/pdf;base64,JVBERi0xLjc=' hideToolbar />);

    const frame = screen.getByTitle('preview.pdf.title');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', 'data:application/pdf;base64,JVBERi0xLjc=');
    expect(document.querySelector('webview')).toBeNull();
  });
});
