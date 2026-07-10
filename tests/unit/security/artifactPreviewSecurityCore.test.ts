import { sanitizeArtifactPreviewSource } from '@/renderer/pages/conversation/Messages/components/artifactPreviewSecurityCore';
import { describe, expect, it } from 'vitest';

describe('artifactPreviewSecurityCore', () => {
  it('allows matching media sources and canonicalizes URLs', () => {
    expect(sanitizeArtifactPreviewSource('data:image/png;base64,AA==', 'image')).toBe('data:image/png;base64,AA==');
    expect(sanitizeArtifactPreviewSource('https://cdn.example.com/a b.png', 'image')).toBe(
      'https://cdn.example.com/a%20b.png'
    );
    expect(sanitizeArtifactPreviewSource('file:///tmp/example.mp4', 'video')).toBe('file:///tmp/example.mp4');
  });

  it('rejects executable, credentialed, mismatched, and remote-file sources', () => {
    expect(sanitizeArtifactPreviewSource('javascript:alert(1)', 'html')).toBeUndefined();
    expect(sanitizeArtifactPreviewSource('https://user:secret@example.com/a.png', 'image')).toBeUndefined();
    expect(sanitizeArtifactPreviewSource('data:text/html,<script></script>', 'image')).toBeUndefined();
    expect(sanitizeArtifactPreviewSource('file://server/share/a.png', 'image')).toBeUndefined();
    expect(sanitizeArtifactPreviewSource('/relative/a.png', 'image')).toBeUndefined();
  });
});
