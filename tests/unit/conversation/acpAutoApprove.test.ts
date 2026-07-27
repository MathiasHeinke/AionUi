/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AcpPermissionRequest } from '@/common/types/platform/acpTypes';
import {
  isAutoApproveMode,
  pickAllowOptionId,
  resolveAcpAutoApprove,
} from '@/renderer/pages/conversation/platforms/acp/acpAutoApprove';
import { COMMAND_EVE_HG4_DELEGATED_MODE } from '@/renderer/utils/model/agentModes';
import { describe, expect, it, vi } from 'vitest';

function makeEditPermissionRequest(): AcpPermissionRequest {
  return {
    session_id: 'sess-1',
    options: [
      { option_id: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { option_id: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
      { option_id: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
    tool_call: {
      tool_call_id: 'call-42',
      kind: 'edit',
      title: 'Approve edit: /workspace/example.html',
      raw_input: { description: 'write file' },
    },
  };
}

describe('acpAutoApprove — mode containment', () => {
  it('keeps legacy EVE modes out while retaining native auto modes for other backends', () => {
    expect(isAutoApproveMode('dont_ask')).toBe(false);
    expect(isAutoApproveMode(COMMAND_EVE_HG4_DELEGATED_MODE)).toBe(false);
    expect(isAutoApproveMode('yolo')).toBe(true);
    expect(isAutoApproveMode('bypassPermissions')).toBe(true);
  });

  it('does not auto-approve gating modes or missing values', () => {
    for (const mode of ['default', 'accept_edits', 'auto_edit', 'acceptEdits', 'plan', undefined, null, '']) {
      expect(isAutoApproveMode(mode)).toBe(false);
    }
  });
});

describe('acpAutoApprove — minimum native grant', () => {
  it('prefers allow_once over a broader option', () => {
    expect(pickAllowOptionId(makeEditPermissionRequest().options)).toBe('allow_once');
  });

  it('preserves the existing non-EVE fallback when only allow_always is offered', () => {
    expect(
      pickAllowOptionId([
        { option_id: 'a', name: 'Allow always', kind: 'allow_always' },
        { option_id: 'r', name: 'Reject', kind: 'reject_once' },
      ])
    ).toBe('a');
  });

  it('returns null when no allow option exists', () => {
    expect(pickAllowOptionId([{ option_id: 'r', name: 'Reject', kind: 'reject_once' }])).toBeNull();
    expect(pickAllowOptionId([])).toBeNull();
    expect(pickAllowOptionId(undefined)).toBeNull();
  });
});

describe('acpAutoApprove — Command EVE renderer authority', () => {
  it('never auto-approves an EVE request, including stale HG3.5 and native-looking yolo values', () => {
    for (const mode of ['dont_ask', COMMAND_EVE_HG4_DELEGATED_MODE, 'yolo', 'bypassPermissions']) {
      expect(resolveAcpAutoApprove(mode, makeEditPermissionRequest(), 'hermes')).toEqual({
        autoApprove: false,
        optionId: null,
      });
    }
  });

  it('retains native auto-approve behavior for a non-EVE backend', () => {
    expect(resolveAcpAutoApprove('yolo', makeEditPermissionRequest(), 'qwen')).toEqual({
      autoApprove: true,
      optionId: 'allow_once',
    });
  });

  it('does not fabricate an approval when the backend offers only reject', () => {
    const rejectOnly = {
      ...makeEditPermissionRequest(),
      options: [{ option_id: 'r', name: 'Reject', kind: 'reject_once' as const }],
    };
    expect(resolveAcpAutoApprove('yolo', rejectOnly, 'qwen')).toEqual({ autoApprove: false, optionId: null });
  });
});

describe('acpAutoApprove — request_permission integration branch', () => {
  function handleAcpPermission(args: {
    mode: string | undefined;
    backend: string;
    request: AcpPermissionRequest;
    confirmMessage: (optionId: string) => void;
    renderDialog: (request: AcpPermissionRequest) => void;
  }) {
    const decision = resolveAcpAutoApprove(args.mode, args.request, args.backend);
    if (decision.autoApprove && decision.optionId) {
      args.confirmMessage(decision.optionId);
      return;
    }
    args.renderDialog(args.request);
  }

  it('renders a manual dialog for a stale EVE HG3.5 value', () => {
    const confirmMessage = vi.fn();
    const renderDialog = vi.fn();
    handleAcpPermission({
      mode: COMMAND_EVE_HG4_DELEGATED_MODE,
      backend: 'hermes',
      request: makeEditPermissionRequest(),
      confirmMessage,
      renderDialog,
    });

    expect(confirmMessage).not.toHaveBeenCalled();
    expect(renderDialog).toHaveBeenCalledTimes(1);
  });

  it('keeps the native non-EVE yolo branch intact', () => {
    const confirmMessage = vi.fn();
    const renderDialog = vi.fn();
    handleAcpPermission({
      mode: 'yolo',
      backend: 'qwen',
      request: makeEditPermissionRequest(),
      confirmMessage,
      renderDialog,
    });

    expect(confirmMessage).toHaveBeenCalledWith('allow_once');
    expect(renderDialog).not.toHaveBeenCalled();
  });
});
