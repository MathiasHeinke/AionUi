/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MAT-1747 — the three USER-FACING ARTEFACTS a capability token must not end up in.
 *
 * FIRST, THE THING THIS FILE IS NOT ABOUT. `edit_handle` and the ephemeral spend
 * permit are INTENTIONALLY MODEL-VISIBLE. The model is meant to receive them and
 * quote them back — that is how a follow-up names a clip and how one turn buys
 * one edit. Nothing here tries to hide them from the model, and a test that did
 * would be testing against the design.
 *
 * What this file pins is narrower and real: those same tokens must not be
 * written into artefacts that OUTLIVE the turn and travel to other people. A
 * fifteen-minute permit or a fourteen-day handle inside a file the user then
 * emails to support is a credential loose in someone's inbox, long after the
 * conversation that bounded it is gone.
 *
 * The handle and the permit ride inside the prepared-context block, which the
 * renderer strips before display. That covers the normal path. This file covers
 * the three surfaces where "it is stripped at display" is not by itself an
 * answer, because each one reads message content through a DIFFERENT door:
 *
 *   1. the visible transcript      -> `stripCommandEvePreparedContext`
 *   2. the conversation EXPORT     -> `readMessageContent`, which has a
 *                                     structured fallback that never went
 *                                     through the strip at all
 *   3. the SUPPORT BUNDLE          -> log lines, which no strip ever touches
 *
 * A credential written to a file the user then emails to support outlives the
 * conversation it belonged to. For the permit that is a fifteen-minute exposure;
 * for the long-lived handle it is fourteen days.
 */

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildCommandEveAgentTurnInput,
  buildEveArtifactContextEnvelope,
} from '@/common/config/eveArtifactContextEnvelopeCore';
import { stripCommandEvePreparedContext } from '@/common/config/evePreparedContextCore';
import { readMessageContent } from '@/renderer/utils/chat/conversationExport';
import { buildSupportBundleSummary } from '@/process/feedback/supportBundleCore';

const HANDLE = `evecap_${'a'.repeat(64)}`;
const PERMIT = `evespend_${'d'.repeat(64)}`;

function turnWithCredentials(): string {
  return buildCommandEveAgentTurnInput({
    userInput: 'gib der Aubergine ein Gesicht',
    artifactEnvelope: buildEveArtifactContextEnvelope({
      entries: [
        {
          artifactId: 'video-aubergine',
          kind: 'video',
          mimeType: 'video/mp4',
          durationSeconds: 5,
          editable: true,
          editHandle: HANDLE,
        },
      ],
      allowedCapabilities: ['eve_video_edit'],
      spendPermit: PERMIT,
    }),
  });
}

describe('1. the visible transcript', () => {
  it('shows what the person typed and neither credential', () => {
    const agentInput = turnWithCredentials();
    // POSITIVE CONTROL: both credentials really are in what the MODEL receives,
    // so the assertions below are about the strip and not about an empty turn.
    expect(agentInput).toContain(HANDLE);
    expect(agentInput).toContain(PERMIT);

    const displayed = stripCommandEvePreparedContext(agentInput);
    expect(displayed).toBe('gib der Aubergine ein Gesicht');
    expect(displayed).not.toContain(HANDLE);
    expect(displayed).not.toContain(PERMIT);
  });
});

describe('2. the conversation export', () => {
  it('redacts a credential out of plain string content', () => {
    const exported = readMessageContent({ content: turnWithCredentials() } as never);
    expect(exported).not.toContain(HANDLE);
    expect(exported).not.toContain(PERMIT);
    expect(exported).toBe('gib der Aubergine ein Gesicht');
  });

  it('redacts a credential out of the STRUCTURED fallback, which never met the strip', () => {
    // The gap this test exists for: `readMessageContent` JSON-stringifies
    // anything that is not a string, and that branch bypassed the strip — and
    // therefore its redaction — entirely.
    const exported = readMessageContent({
      content: { parts: [{ text: `edit_handle=${HANDLE} spend_permit=${PERMIT}` }] },
    } as never);
    expect(exported).toContain('evecap_[redacted]');
    expect(exported).toContain('evespend_[redacted]');
    expect(exported).not.toContain('a'.repeat(64));
    expect(exported).not.toContain('d'.repeat(64));
    // POSITIVE CONTROL: the branch really was the structured one, so this is not
    // silently testing the string path again.
    expect(exported).toContain('parts');
  });
});

describe('3. the support bundle', () => {
  it('carries no credential even when one appears verbatim in a log line', () => {
    const summary = buildSupportBundleSummary(
      [
        {
          source: 'backend',
          date: '2026-08-01',
          size_bytes: 128,
          sampled_bytes: 128,
          truncated: false,
          content: [
            `INFO minted edit_handle=${HANDLE}`,
            `INFO minted spend_permit=${PERMIT}`,
            'ERROR something ordinary failed',
          ].join('\n'),
        },
      ],
      { fingerprintKey: randomBytes(32) }
    );
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(HANDLE);
    expect(serialized).not.toContain(PERMIT);
    expect(serialized).not.toContain('a'.repeat(64));
    expect(serialized).not.toContain('d'.repeat(64));
    // POSITIVE CONTROL: the bundle DID see those lines — it counted three of
    // them — so the absence above is redaction by design (HMAC fingerprints
    // only, `raw_log_content_included: false`) and not an empty summary.
    expect(summary.sources[0].sampled_line_count).toBe(3);
    expect(summary.privacy.raw_log_content_included).toBe(false);
  });
});
