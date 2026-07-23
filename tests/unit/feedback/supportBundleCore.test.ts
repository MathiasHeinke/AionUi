/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { buildSupportBundleSummary } from '@/process/feedback/supportBundleCore';
import { collectFeedbackLogAttachment } from '@/process/feedback/logs';

describe('supportBundleCore', () => {
  it('keeps only allowlisted diagnostic aggregates and ephemeral fingerprints', () => {
    const summary = buildSupportBundleSummary(
      [
        {
          source: 'backend',
          date: '2026-07-15',
          size_bytes: 512,
          sampled_bytes: 512,
          truncated: false,
          content: [
            'ERROR backend timeout for alice@example.com at C:\\Users\\alice\\secret.txt',
            'ERROR backend timeout for alice@example.com at C:\\Users\\alice\\secret.txt',
            'WARN updater degraded with token sk-test-123456789012345678901234',
          ].join('\n'),
        },
      ],
      { now: new Date('2026-07-15T18:00:00.000Z'), fingerprintKey: Buffer.alloc(32, 7) }
    );

    expect(summary.sources[0]).toMatchObject({
      source: 'backend',
      date: '2026-07-15',
      sampled_line_count: 3,
      severity_counts: { error: 2, warning: 1, info: 0, other: 0 },
      category_counts: {
        timeout: 2,
        permission: 0,
        network: 0,
        update: 1,
        backend_startup: 0,
        filesystem: 0,
        unknown: 0,
      },
    });
    expect(summary.sources[0].event_groups).toHaveLength(2);
    expect(summary.sources[0].event_groups[0].count).toBe(2);
    expect(summary.sources[0].event_groups.every((event) => /^[0-9a-f]{16}$/u.test(event.fingerprint))).toBe(true);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('secret.txt');
    expect(serialized).not.toContain('sk-test-');
  });

  it('rejects an undersized fingerprint key instead of weakening pseudonymization', () => {
    expect(() => buildSupportBundleSummary([], { fingerprintKey: Buffer.alloc(8) })).toThrow(
      'fingerprint key must contain at least 16 bytes'
    );
  });

  it('serializes only privacy-filtered aggregates in the user-submitted feedback attachment', () => {
    const logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'command-eve-feedback-privacy-'));
    const fakeCapability = 'f19a'.repeat(16);
    const privateEmail = 'feedback.reasoning@example.com';
    const rawLine = `ERROR reasoning for ${privateEmail} with x-aionui-local-capability: ${fakeCapability}`;
    fs.writeFileSync(path.join(logsRoot, '2026-07-23.log'), rawLine, 'utf8');

    try {
      const attachment = collectFeedbackLogAttachment(logsRoot);
      expect(attachment).not.toBeNull();
      const serialized = gunzipSync(attachment!.data).toString('utf8');
      const summary = JSON.parse(serialized) as {
        privacy: {
          raw_log_content_included: boolean;
          filenames_included: boolean;
          local_paths_included: boolean;
          user_content_included: boolean;
          sensitive_scan: string;
        };
        completion_sentinel: string;
      };

      expect(attachment!.filename).toBe('command-eve-support-diagnostics.json.gz');
      expect(summary.privacy).toEqual({
        raw_log_content_included: false,
        filenames_included: false,
        local_paths_included: false,
        user_content_included: false,
        sensitive_scan: 'PASS',
      });
      expect(summary.completion_sentinel).toBe('COMMAND_EVE_SUPPORT_BUNDLE_COMPLETE');
      expect(serialized).not.toContain(rawLine);
      expect(serialized).not.toContain(privateEmail);
      expect(serialized).not.toContain('x-aionui-local-capability');
      expect(serialized).not.toContain(fakeCapability);
      expect(serialized).not.toContain(logsRoot);
      expect(serialized).not.toContain('2026-07-23.log');
    } finally {
      fs.rmSync(logsRoot, { recursive: true, force: true });
    }
  });
});
