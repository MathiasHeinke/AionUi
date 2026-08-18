import { describe, expect, it } from 'vitest';
import {
  fileUrlToPath,
  isDirectoryMetadata,
  pathToFileUrl,
  resolveArtifactDownloadFileName,
} from '@/renderer/pages/conversation/Messages/components/MessageGeneratedArtifact';

describe('generated artifact local path handling', () => {
  it('converts Windows absolute paths to file URLs instead of treating the drive as a URI scheme', () => {
    const fileUrl = pathToFileUrl('C:\\Users\\Mathias\\report 1.pdf');

    expect(fileUrl).toBe('file:///C:/Users/Mathias/report%201.pdf');
    expect(fileUrlToPath(fileUrl)).toBe('C:/Users/Mathias/report 1.pdf');
  });

  it('recognizes both metadata directory field conventions', () => {
    const baseMetadata = {
      name: 'reports',
      path: '/tmp/reports',
      size: 0,
      type: 'directory',
      lastModified: 1,
    };

    expect(isDirectoryMetadata({ ...baseMetadata, isDirectory: true })).toBe(true);
    expect(isDirectoryMetadata({ ...baseMetadata, is_directory: true })).toBe(true);
    expect(isDirectoryMetadata(baseMetadata)).toBe(false);
  });

  it('keeps the visible filename and adds a trustworthy MIME extension when needed', () => {
    expect(
      resolveArtifactDownloadFileName({
        title: 'Linienmotiv',
        path: 'bilder/linienmotiv.png',
        mimeType: 'image/png',
      })
    ).toBe('linienmotiv.png');
    expect(resolveArtifactDownloadFileName({ title: 'Linienmotiv', mimeType: 'image/png' })).toBe('Linienmotiv.png');
  });
});
