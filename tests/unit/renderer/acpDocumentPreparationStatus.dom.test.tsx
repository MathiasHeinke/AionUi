import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import AcpDocumentPreparationStatus from '@/renderer/pages/conversation/platforms/acp/AcpDocumentPreparationStatus';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; defaultValue?: string }) =>
      ({
        'conversation.pdf.phase.reading_local': `Reading ${options?.count} PDF locally`,
        'conversation.pdf.phase.awaiting_cloud_ocr': 'Waiting for OCR approval',
        'conversation.pdf.phase.error': 'PDF processing failed',
      })[key] ??
      options?.defaultValue ??
      key,
  }),
}));

describe('AcpDocumentPreparationStatus', () => {
  it('announces local PDF preparation immediately', () => {
    render(<AcpDocumentPreparationStatus state={{ phase: 'reading_local', fileCount: 1, startedAt: Date.now() }} />);

    expect(screen.getByRole('status')).toHaveTextContent('Reading 1 PDF locally');
    expect(screen.getByTestId('acp-document-preparation').querySelector('.animate-spin')).toBeTruthy();
  });

  it('uses an assertive alert for a terminal preparation error', () => {
    render(<AcpDocumentPreparationStatus state={{ phase: 'error', fileCount: 1, startedAt: Date.now() }} />);

    expect(screen.getByRole('alert')).toHaveTextContent('PDF processing failed');
    expect(screen.getByTestId('acp-document-preparation').querySelector('.animate-spin')).toBeNull();
  });

  it('renders nothing without an active or terminal PDF phase', () => {
    const { container } = render(<AcpDocumentPreparationStatus state={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
