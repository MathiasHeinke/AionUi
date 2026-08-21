/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  readSelectedPdfArtifactSourcePath,
  resolveManagedArtifactInput,
} from '@/renderer/pages/conversation/platforms/acp/resolveManagedArtifactInput';

describe('resolveManagedArtifactInput', () => {
  const request = {
    conversationId: 'conversation-1',
    artifactId: 'artifact-1',
    isCurrent: () => true,
  };

  it('returns the private agent attachment only for a ready response', async () => {
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      data: { status: 'ready', agentFilePath: '/private/command-eve/image.png' },
    });

    await expect(resolveManagedArtifactInput({ ...request, invoke })).resolves.toEqual({
      status: 'ready',
      agentFilePath: '/private/command-eve/image.png',
    });
    expect(invoke).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      artifactId: 'artifact-1',
    });
  });

  it.each([
    ['a refused response', { success: true, data: { status: 'refused', reasonCode: 'artifact-unavailable' } }],
    ['an invalid path', { success: true, data: { status: 'ready', agentFilePath: 'relative/image.png' } }],
  ])('returns unavailable for %s', async (_label, response) => {
    const invoke = vi.fn().mockResolvedValue(response);

    await expect(resolveManagedArtifactInput({ ...request, invoke })).resolves.toEqual({ status: 'unavailable' });
  });

  it('returns stale when the seat changes while resolving', async () => {
    let current = true;
    const invoke = vi.fn().mockImplementation(async () => {
      current = false;
      return { success: true, data: { status: 'ready', agentFilePath: '/private/command-eve/image.png' } };
    });

    await expect(
      resolveManagedArtifactInput({
        ...request,
        isCurrent: () => current,
        invoke,
      })
    ).resolves.toEqual({ status: 'stale' });
  });

  it('forwards a selected exact PDF source path only through the IPC request', async () => {
    const invoke = vi.fn().mockResolvedValue({
      success: true,
      data: { status: 'ready', agentFilePath: '/private/command-eve/palmen-report.pdf' },
    });
    const sourcePath = readSelectedPdfArtifactSourcePath({
      conversationId: 'conversation-1',
      artifactId: 'artifact-1',
      artifact: {
        id: 'artifact-1',
        conversation_id: 'conversation-1',
        status: 'active',
        payload: { path: 'dokumente/palmen-report.pdf', mime_type: 'application/pdf' },
      },
    });

    await expect(resolveManagedArtifactInput({ ...request, sourcePath, invoke })).resolves.toEqual({
      status: 'ready',
      agentFilePath: '/private/command-eve/palmen-report.pdf',
    });
    expect(invoke).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      artifactId: 'artifact-1',
      sourcePath: 'dokumente/palmen-report.pdf',
    });
  });

  it.each([
    [
      'a different conversation',
      {
        id: 'artifact-1',
        conversation_id: 'conversation-2',
        status: 'active',
        payload: { path: 'dokumente/palmen-report.pdf' },
      },
    ],
    [
      'a non-PDF source',
      {
        id: 'artifact-1',
        conversation_id: 'conversation-1',
        status: 'active',
        payload: { path: 'dokumente/palmen-report.docx' },
      },
    ],
    [
      'an escaping relative path',
      {
        id: 'artifact-1',
        conversation_id: 'conversation-1',
        status: 'active',
        payload: { path: '../palmen-report.pdf' },
      },
    ],
  ])('does not extract a PDF path from %s', (_label, artifact) => {
    expect(
      readSelectedPdfArtifactSourcePath({
        artifact,
        conversationId: 'conversation-1',
        artifactId: 'artifact-1',
      })
    ).toBeUndefined();
  });
});
