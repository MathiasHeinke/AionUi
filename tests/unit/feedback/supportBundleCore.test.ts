/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { buildSupportBundleSummary } from '@/process/feedback/supportBundleCore';

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
});
