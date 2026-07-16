/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHmac, randomBytes } from 'node:crypto';

import { detectCommandEveSensitiveEgress } from '../../common/api/egressBoundaryCore';

export const SUPPORT_BUNDLE_SCHEMA_VERSION = 'command-eve-support-bundle/v1' as const;
const MAX_EVENT_GROUPS_PER_SOURCE = 25;

export type SupportBundleLogSource = {
  source: 'frontend' | 'backend' | 'rust';
  date: string;
  size_bytes: number;
  sampled_bytes: number;
  truncated: boolean;
  content: string;
};

export type SupportBundleSummary = {
  schema_version: typeof SUPPORT_BUNDLE_SCHEMA_VERSION;
  generated_at: string;
  privacy: {
    raw_log_content_included: false;
    filenames_included: false;
    local_paths_included: false;
    user_content_included: false;
    sensitive_scan: 'PASS';
  };
  sources: Array<{
    source: SupportBundleLogSource['source'];
    date: string;
    size_bytes: number;
    sampled_bytes: number;
    sampled_line_count: number;
    truncated: boolean;
    severity_counts: {
      error: number;
      warning: number;
      info: number;
      other: number;
    };
    category_counts: {
      timeout: number;
      permission: number;
      network: number;
      update: number;
      backend_startup: number;
      filesystem: number;
      unknown: number;
    };
    event_groups: Array<{
      fingerprint: string;
      count: number;
      severity: 'error' | 'warning' | 'info' | 'other';
      category: 'timeout' | 'permission' | 'network' | 'update' | 'backend_startup' | 'filesystem' | 'unknown';
    }>;
  }>;
  totals: {
    source_count: number;
    sampled_line_count: number;
    error_count: number;
    warning_count: number;
  };
  completion_sentinel: 'COMMAND_EVE_SUPPORT_BUNDLE_COMPLETE';
};

type SupportSeverity = SupportBundleSummary['sources'][number]['event_groups'][number]['severity'];
type SupportCategory = SupportBundleSummary['sources'][number]['event_groups'][number]['category'];

function classifySeverity(line: string): SupportSeverity {
  if (/\b(?:error|fatal|exception|panic|failed|failure)\b/iu.test(line)) return 'error';
  if (/\b(?:warn|warning|degraded)\b/iu.test(line)) return 'warning';
  if (/\b(?:info|ready|started|completed|success)\b/iu.test(line)) return 'info';
  return 'other';
}

function classifyCategory(line: string): SupportCategory {
  if (/\b(?:timeout|timed out|deadline exceeded)\b/iu.test(line)) return 'timeout';
  if (/\b(?:eacces|eperm|permission|access denied|not permitted)\b/iu.test(line)) return 'permission';
  if (/\b(?:network|fetch|socket|dns|econn|tls|http)\b/iu.test(line)) return 'network';
  if (/\b(?:update|updater|installer|nsis)\b/iu.test(line)) return 'update';
  if (/\b(?:aioncore|backend|bootstrap|sidecar)\b/iu.test(line)) return 'backend_startup';
  if (/\b(?:filesystem|file|path|enoent|enotdir|directory)\b/iu.test(line)) return 'filesystem';
  return 'unknown';
}

function zeroSeverityCounts(): SupportBundleSummary['sources'][number]['severity_counts'] {
  return { error: 0, warning: 0, info: 0, other: 0 };
}

function zeroCategoryCounts(): SupportBundleSummary['sources'][number]['category_counts'] {
  return { timeout: 0, permission: 0, network: 0, update: 0, backend_startup: 0, filesystem: 0, unknown: 0 };
}

export function buildSupportBundleSummary(
  inputs: readonly SupportBundleLogSource[],
  options: { now?: Date; fingerprintKey?: Buffer } = {}
): SupportBundleSummary {
  const fingerprintKey = options.fingerprintKey ?? randomBytes(32);
  if (fingerprintKey.length < 16) throw new Error('support-bundle fingerprint key must contain at least 16 bytes');

  const sources = inputs.map((input) => {
    const severityCounts = zeroSeverityCounts();
    const categoryCounts = zeroCategoryCounts();
    const groups = new Map<string, { count: number; severity: SupportSeverity; category: SupportCategory }>();
    const lines = input.content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const severity = classifySeverity(line);
      const category = classifyCategory(line);
      severityCounts[severity] += 1;
      categoryCounts[category] += 1;
      const fingerprint = createHmac('sha256', fingerprintKey).update(line).digest('hex').slice(0, 16);
      const group = groups.get(fingerprint);
      if (group) group.count += 1;
      else groups.set(fingerprint, { count: 1, severity, category });
    }
    const eventGroups = [...groups.entries()]
      .map(([fingerprint, group]) => ({
        fingerprint,
        count: group.count,
        severity: group.severity,
        category: group.category,
      }))
      .toSorted((left, right) => right.count - left.count || left.fingerprint.localeCompare(right.fingerprint))
      .slice(0, MAX_EVENT_GROUPS_PER_SOURCE);
    return {
      source: input.source,
      date: input.date,
      size_bytes: input.size_bytes,
      sampled_bytes: input.sampled_bytes,
      sampled_line_count: lines.length,
      truncated: input.truncated,
      severity_counts: severityCounts,
      category_counts: categoryCounts,
      event_groups: eventGroups,
    };
  });

  const summary: SupportBundleSummary = {
    schema_version: SUPPORT_BUNDLE_SCHEMA_VERSION,
    generated_at: (options.now ?? new Date()).toISOString(),
    privacy: {
      raw_log_content_included: false,
      filenames_included: false,
      local_paths_included: false,
      user_content_included: false,
      sensitive_scan: 'PASS',
    },
    sources,
    totals: {
      source_count: sources.length,
      sampled_line_count: sources.reduce((sum, source) => sum + source.sampled_line_count, 0),
      error_count: sources.reduce((sum, source) => sum + source.severity_counts.error, 0),
      warning_count: sources.reduce((sum, source) => sum + source.severity_counts.warning, 0),
    },
    completion_sentinel: 'COMMAND_EVE_SUPPORT_BUNDLE_COMPLETE',
  };

  const serialized = JSON.stringify(summary);
  if (detectCommandEveSensitiveEgress(serialized).length > 0) {
    throw new Error('support bundle failed the sensitive-data scan');
  }
  return summary;
}
