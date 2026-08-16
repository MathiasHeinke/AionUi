/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveComposerAttachmentPresentation } from '@/renderer/components/chat/composerAttachmentPresentation';

describe('resolveComposerAttachmentPresentation', () => {
  const files = ['/tmp/brief.pdf', '/tmp/reference.png', '/tmp/notes.docx', '/tmp/second.webp'];

  it('keeps ordinary chat attachments visible at the top-left attachment strip', () => {
    expect(resolveComposerAttachmentPresentation('chat', files)).toEqual({ visibleFiles: files });
  });

  it('promotes exactly the first image into the image-mode reference slot', () => {
    expect(resolveComposerAttachmentPresentation('image', files)).toEqual({
      referenceImagePath: '/tmp/reference.png',
      visibleFiles: ['/tmp/brief.pdf', '/tmp/notes.docx', '/tmp/second.webp'],
    });
  });

  it('does not compete with an explicitly selected artifact reference', () => {
    expect(resolveComposerAttachmentPresentation('image', files, true)).toEqual({ visibleFiles: files });
  });

  it('does not invent a reference when no image is attached', () => {
    const documents = ['/tmp/brief.pdf', '/tmp/notes.docx'];
    expect(resolveComposerAttachmentPresentation('image', documents)).toEqual({ visibleFiles: documents });
  });

  it('mounts the ordinary attachment strip before the start-screen text input', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../../packages/desktop/src/renderer/pages/guid/components/GuidInputCard.tsx'),
      'utf8'
    );
    expect(source.indexOf("data-testid='guid-attachment-strip'")).toBeGreaterThan(0);
    expect(source.indexOf("data-testid='guid-attachment-strip'")).toBeLessThan(source.indexOf('<Input.TextArea'));
  });
});
