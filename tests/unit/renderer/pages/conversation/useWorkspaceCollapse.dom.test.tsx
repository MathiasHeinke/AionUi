/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkspaceCollapse } from '@/renderer/pages/conversation/hooks/useWorkspaceCollapse';
import { WORKSPACE_OPEN_EVENT } from '@/renderer/utils/workspace/workspaceEvents';

describe('useWorkspaceCollapse open semantics', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('opens an enabled rail idempotently and persists the expanded preference', () => {
    const { result } = renderHook(() =>
      useWorkspaceCollapse({
        workspaceEnabled: true,
        isMobile: false,
        conversation_id: 'conv-1',
        preferenceKey: 'conv-1',
      })
    );

    act(() => window.dispatchEvent(new CustomEvent(WORKSPACE_OPEN_EVENT)));
    expect(result.current.rightSiderCollapsed).toBe(false);
    expect(localStorage.getItem('workspace-preference-conv-1')).toBe('expanded');

    act(() => window.dispatchEvent(new CustomEvent(WORKSPACE_OPEN_EVENT)));
    expect(result.current.rightSiderCollapsed).toBe(false);
  });

  it('ignores open requests when the workspace rail is unavailable', () => {
    const { result } = renderHook(() =>
      useWorkspaceCollapse({
        workspaceEnabled: false,
        isMobile: false,
        conversation_id: 'conv-1',
        preferenceKey: 'conv-1',
      })
    );

    act(() => window.dispatchEvent(new CustomEvent(WORKSPACE_OPEN_EVENT)));
    expect(result.current.rightSiderCollapsed).toBe(true);
    expect(localStorage.getItem('workspace-preference-conv-1')).toBeNull();
  });
});
