/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import {
  canOpenArtifactFromTypedAction,
  resolverKindOf,
} from '@/renderer/components/layout/Titlebar/ShellElementsRail';
import {
  canResolveWorkbenchArtifact,
  openWorkbenchArtifact,
  registerWorkbenchArtifactResolver,
  resetWorkbenchArtifactResolversForTest,
  type WorkbenchArtifactReference,
} from '@/renderer/pages/conversation/Preview/services/workbenchArtifactResolver';
import { afterEach, describe, expect, it, vi } from 'vitest';

const reference: WorkbenchArtifactReference = {
  kind: 'file',
  artifactId: 'artifact-17',
  conversationId: 'conversation-17',
};

function artifact(payload: Record<string, unknown>): IConversationArtifact {
  return {
    id: reference.artifactId,
    conversation_id: reference.conversationId,
    kind: 'file',
    status: 'active',
    payload,
    created_at: 1,
    updated_at: 1,
  } as IConversationArtifact;
}

afterEach(resetWorkbenchArtifactResolversForTest);

describe('pane-wide Typed UI artifact resolver', () => {
  it('opens only the exact artifact and conversation identity', async () => {
    const open = vi.fn();
    registerWorkbenchArtifactResolver({
      id: 'resolver-exact',
      canResolve: (candidate) => JSON.stringify(candidate) === JSON.stringify(reference),
      open,
    });
    expect(canResolveWorkbenchArtifact(reference)).toBe(true);
    expect(canResolveWorkbenchArtifact({ ...reference, conversationId: 'conversation-other' })).toBe(false);
    await openWorkbenchArtifact(reference);
    expect(open).toHaveBeenCalledWith(reference);
    await expect(openWorkbenchArtifact({ ...reference, artifactId: 'missing' })).rejects.toThrow(
      'artifact_not_resolved'
    );
  });

  it('uses one highest-priority resolver and rejects duplicate resolver identities', async () => {
    const low = vi.fn();
    const high = vi.fn();
    registerWorkbenchArtifactResolver({ id: 'resolver-low', priority: 1, canResolve: () => true, open: low });
    registerWorkbenchArtifactResolver({ id: 'resolver-high', priority: 10, canResolve: () => true, open: high });
    expect(() =>
      registerWorkbenchArtifactResolver({ id: 'resolver-high', canResolve: () => true, open: vi.fn() })
    ).toThrow('artifact_resolver_identity_invalid');
    await openWorkbenchArtifact(reference);
    expect(high).toHaveBeenCalledOnce();
    expect(low).not.toHaveBeenCalled();
  });

  it('fails closed for unknown kinds and resolver exceptions', async () => {
    registerWorkbenchArtifactResolver({
      id: 'resolver-throws',
      canResolve: () => {
        throw new Error('boom');
      },
      open: vi.fn(),
    });
    const unknown = { ...reference, kind: 'iframe' } as unknown as WorkbenchArtifactReference;
    expect(canResolveWorkbenchArtifact(unknown)).toBe(false);
    await expect(openWorkbenchArtifact(unknown)).rejects.toThrow('artifact_reference_kind_invalid');
    await expect(openWorkbenchArtifact(reference)).rejects.toThrow('artifact_not_resolved');
  });

  it('accepts credential-free browser URLs but rejects credentialed URLs', () => {
    const safe = artifact({ url: 'https://example.com/report' });
    const credentialed = artifact({ url: 'https://user:pass@example.com/private' });
    expect(resolverKindOf(safe)).toBe('browser');
    expect(canOpenArtifactFromTypedAction(safe, '/workspace')).toBe(true);
    expect(canOpenArtifactFromTypedAction(credentialed, '/workspace')).toBe(false);
  });

  it.each(['/etc/passwd', '../outside.md', 'nested/../../outside.md', 'file:///etc/passwd', 'C:\\Windows\\x'])(
    'rejects raw or escaping file path %s',
    (path) => {
      expect(canOpenArtifactFromTypedAction(artifact({ path }), '/workspace')).toBe(false);
    }
  );

  it('allows workspace-relative and path-free inline files but rejects inline content paired with an absolute path', () => {
    expect(canOpenArtifactFromTypedAction(artifact({ path: 'reports/result.md' }), '/workspace')).toBe(true);
    expect(canOpenArtifactFromTypedAction(artifact({ content: '# Result' }), '/workspace')).toBe(true);
    expect(canOpenArtifactFromTypedAction(artifact({ content: '# Forged', path: '/etc/passwd' }), '/workspace')).toBe(
      false
    );
  });
});
