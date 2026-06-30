/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  isAutoApproveMode,
  pickAllowOptionId,
  resolveAcpAutoApprove,
} from '@/renderer/pages/conversation/platforms/acp/acpAutoApprove';
import type { AcpPermissionRequest } from '@/common/types/platform/acpTypes';

/**
 * A realistic ACP request_permission payload — exactly the shape Hermes emits for
 * a write_text_file/edit tool call (the "Approve edit: …html" the founder saw).
 */
function makeEditPermissionRequest(): AcpPermissionRequest {
  return {
    session_id: 'sess-1',
    options: [
      { option_id: 'opt-allow-once', name: 'Allow', kind: 'allow_once' },
      { option_id: 'opt-allow-always', name: 'Allow for session', kind: 'allow_always' },
      { option_id: 'opt-reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    tool_call: {
      tool_call_id: 'call-42',
      kind: 'edit',
      title: 'Approve edit: /Users/x/hermes-temp-1/stille-steuer-v2.html',
      raw_input: { description: 'write file' },
    },
  };
}

describe('acpAutoApprove — isAutoApproveMode (SECURITY: only YOLO auto-approves)', () => {
  it('auto-approves ONLY the YOLO / "Nicht fragen" mode + its cross-backend synonyms', () => {
    // EVE/Hermes YOLO id, and the synonyms a conversation may have persisted.
    expect(isAutoApproveMode('dont_ask')).toBe(true); // hermes "Nicht fragen"
    expect(isAutoApproveMode('yolo')).toBe(true); // persisted synonym (verified live: extra.session_mode='yolo')
    expect(isAutoApproveMode('bypassPermissions')).toBe(true); // claude synonym
  });

  it('does NOT auto-approve the gating modes — they must keep asking', () => {
    expect(isAutoApproveMode('default')).toBe(false); // Standard
    expect(isAutoApproveMode('accept_edits')).toBe(false); // Änderungen übernehmen
    expect(isAutoApproveMode('auto_edit')).toBe(false); // accept-edits synonym
    expect(isAutoApproveMode('acceptEdits')).toBe(false);
    expect(isAutoApproveMode('plan')).toBe(false);
    expect(isAutoApproveMode(undefined)).toBe(false);
    expect(isAutoApproveMode(null)).toBe(false);
    expect(isAutoApproveMode('')).toBe(false);
  });
});

describe('acpAutoApprove — pickAllowOptionId', () => {
  it('prefers allow_once over allow_always (minimum grant, no silent escalation)', () => {
    expect(pickAllowOptionId(makeEditPermissionRequest().options)).toBe('opt-allow-once');
  });

  it('falls back to allow_always when no allow_once is offered', () => {
    expect(
      pickAllowOptionId([
        { option_id: 'a', name: 'Allow always', kind: 'allow_always' },
        { option_id: 'r', name: 'Reject', kind: 'reject_once' },
      ])
    ).toBe('a');
  });

  it('returns null when the request offers NO allow option (never fabricate an approval)', () => {
    expect(
      pickAllowOptionId([
        { option_id: 'r1', name: 'Reject', kind: 'reject_once' },
        { option_id: 'r2', name: 'Reject always', kind: 'reject_always' },
      ])
    ).toBeNull();
    expect(pickAllowOptionId([])).toBeNull();
    expect(pickAllowOptionId(undefined)).toBeNull();
  });
});

describe('acpAutoApprove — resolveAcpAutoApprove', () => {
  it('YOLO + a request with an allow option → auto-approve with the allow_once id', () => {
    expect(resolveAcpAutoApprove('dont_ask', makeEditPermissionRequest())).toEqual({
      autoApprove: true,
      optionId: 'opt-allow-once',
    });
    expect(resolveAcpAutoApprove('yolo', makeEditPermissionRequest())).toEqual({
      autoApprove: true,
      optionId: 'opt-allow-once',
    });
  });

  it('gating modes → never auto-approve, regardless of options', () => {
    expect(resolveAcpAutoApprove('default', makeEditPermissionRequest())).toEqual({
      autoApprove: false,
      optionId: null,
    });
    expect(resolveAcpAutoApprove('accept_edits', makeEditPermissionRequest())).toEqual({
      autoApprove: false,
      optionId: null,
    });
  });

  it('YOLO but the request has no allow option → do NOT auto-approve (fall back to dialog)', () => {
    const rejectOnly: AcpPermissionRequest = {
      ...makeEditPermissionRequest(),
      options: [{ option_id: 'r', name: 'Reject', kind: 'reject_once' }],
    };
    expect(resolveAcpAutoApprove('dont_ask', rejectOnly)).toEqual({ autoApprove: false, optionId: null });
  });
});

/**
 * FULL-CHAIN: reproduce the exact branch the ACP message handler (useAcpMessage's
 * `acp_permission` case) runs, against a real request_permission payload, and prove
 * the end-to-end behavior:
 *   - mode = "Nicht fragen" (dont_ask / yolo) → desktop AUTO-answers allow via
 *     confirmMessage AND renders NO "Approve edit:" dialog.
 *   - mode = "Standard" (default) → desktop renders the dialog AND does NOT answer.
 *
 * This mirrors the handler 1:1: resolve the decision from the live mode, and when it
 * auto-approves, POST the allow option (confirmMessage) keyed on the tool_call_id
 * instead of adding the permission message to the conversation.
 */
describe('acpAutoApprove — FULL CHAIN: request_permission → auto-allow vs gate', () => {
  // Faithful re-creation of the handler's auto-approve branch. `confirmMessage` and
  // `renderDialog` are the two mutually-exclusive sinks; exactly one fires.
  function handleAcpPermission(args: {
    mode: string | undefined;
    request: AcpPermissionRequest;
    msg_id: string;
    conversation_id: string;
    confirmMessage: (p: { confirm_key: string; msg_id: string; conversation_id: string; call_id: string }) => void;
    renderDialog: (request: AcpPermissionRequest) => void;
    answeredCallIds: Set<string>;
  }) {
    const { mode, request, msg_id, conversation_id, confirmMessage, renderDialog, answeredCallIds } = args;
    const callId = request.tool_call?.tool_call_id || msg_id;
    const decision = resolveAcpAutoApprove(mode, request);
    if (decision.autoApprove && decision.optionId) {
      // Already auto-answered this call (replay/reconnect): silently no-op — do
      // not re-POST and do not pop the dialog for a request we already allowed.
      if (answeredCallIds.has(callId)) return;
      answeredCallIds.add(callId);
      confirmMessage({ confirm_key: decision.optionId, msg_id, conversation_id, call_id: callId });
      return; // do NOT render the gating dialog
    }
    renderDialog(request);
  }

  it('mode "Nicht fragen" (dont_ask): auto-allows the edit, shows NO dialog', () => {
    const confirmMessage = vi.fn();
    const renderDialog = vi.fn();
    handleAcpPermission({
      mode: 'dont_ask',
      request: makeEditPermissionRequest(),
      msg_id: 'm1',
      conversation_id: 'c8c96df2',
      confirmMessage,
      renderDialog,
      answeredCallIds: new Set(),
    });

    expect(confirmMessage).toHaveBeenCalledTimes(1);
    expect(confirmMessage).toHaveBeenCalledWith({
      confirm_key: 'opt-allow-once',
      msg_id: 'm1',
      conversation_id: 'c8c96df2',
      call_id: 'call-42',
    });
    expect(renderDialog).not.toHaveBeenCalled();
  });

  it('mode "yolo" (persisted synonym): auto-allows the edit, shows NO dialog', () => {
    const confirmMessage = vi.fn();
    const renderDialog = vi.fn();
    handleAcpPermission({
      mode: 'yolo',
      request: makeEditPermissionRequest(),
      msg_id: 'm1',
      conversation_id: 'c1',
      confirmMessage,
      renderDialog,
      answeredCallIds: new Set(),
    });
    expect(confirmMessage).toHaveBeenCalledTimes(1);
    expect(renderDialog).not.toHaveBeenCalled();
  });

  it('mode "Standard" (default): shows the dialog, does NOT auto-answer (still gates)', () => {
    const confirmMessage = vi.fn();
    const renderDialog = vi.fn();
    handleAcpPermission({
      mode: 'default',
      request: makeEditPermissionRequest(),
      msg_id: 'm1',
      conversation_id: 'c1',
      confirmMessage,
      renderDialog,
      answeredCallIds: new Set(),
    });

    expect(renderDialog).toHaveBeenCalledTimes(1);
    expect(confirmMessage).not.toHaveBeenCalled();
  });

  it('mode "Änderungen übernehmen" (accept_edits): still gates (shows dialog)', () => {
    const confirmMessage = vi.fn();
    const renderDialog = vi.fn();
    handleAcpPermission({
      mode: 'accept_edits',
      request: makeEditPermissionRequest(),
      msg_id: 'm1',
      conversation_id: 'c1',
      confirmMessage,
      renderDialog,
      answeredCallIds: new Set(),
    });
    expect(renderDialog).toHaveBeenCalledTimes(1);
    expect(confirmMessage).not.toHaveBeenCalled();
  });

  it('YOLO: a re-delivered request for the same call_id is auto-answered only ONCE', () => {
    const confirmMessage = vi.fn();
    const renderDialog = vi.fn();
    const answeredCallIds = new Set<string>();
    const common = {
      mode: 'dont_ask',
      request: makeEditPermissionRequest(),
      msg_id: 'm1',
      conversation_id: 'c1',
      confirmMessage,
      renderDialog,
      answeredCallIds,
    };
    handleAcpPermission(common);
    handleAcpPermission(common); // replay / reconnect
    expect(confirmMessage).toHaveBeenCalledTimes(1);
    expect(renderDialog).not.toHaveBeenCalled();
  });

  it('YOLO but reject-only request: gates (cannot fabricate an allow)', () => {
    const confirmMessage = vi.fn();
    const renderDialog = vi.fn();
    handleAcpPermission({
      mode: 'dont_ask',
      request: { ...makeEditPermissionRequest(), options: [{ option_id: 'r', name: 'Reject', kind: 'reject_once' }] },
      msg_id: 'm1',
      conversation_id: 'c1',
      confirmMessage,
      renderDialog,
      answeredCallIds: new Set(),
    });
    expect(confirmMessage).not.toHaveBeenCalled();
    expect(renderDialog).toHaveBeenCalledTimes(1);
  });
});
