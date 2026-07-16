/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import { buildSupportBundleSummary, type SupportBundleLogSource } from './supportBundleCore';

const LOG_SUFFIXES = ['.log', '.aioncore.log', '.aionrs.log'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;
const DEFAULT_LOG_DAYS = 3;
const MAX_SAMPLED_BYTES_PER_LOG = 1024 * 1024;

export type FeedbackLogAttachment = {
  filename: string;
  data: Buffer;
  contentType: 'application/gzip';
};

function sourceForLogPath(filePath: string): SupportBundleLogSource['source'] {
  if (filePath.endsWith('.aioncore.log')) return 'backend';
  if (filePath.endsWith('.aionrs.log')) return 'rust';
  return 'frontend';
}

function readBoundedLogTail(
  filePath: string
): Pick<SupportBundleLogSource, 'content' | 'sampled_bytes' | 'size_bytes' | 'truncated'> {
  const pathStat = fs.lstatSync(filePath);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error('feedback log must be a non-symlink regular file');
  }
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error('feedback log identity changed before sampling');
    }
    const sampledBytes = Math.min(stat.size, MAX_SAMPLED_BYTES_PER_LOG);
    const buffer = Buffer.alloc(sampledBytes);
    fs.readSync(descriptor, buffer, 0, sampledBytes, stat.size - sampledBytes);
    let content = buffer.toString('utf8');
    if (stat.size > sampledBytes) {
      const firstLineBreak = content.indexOf('\n');
      content = firstLineBreak >= 0 ? content.slice(firstLineBreak + 1) : '';
    }
    return { content, sampled_bytes: sampledBytes, size_bytes: stat.size, truncated: stat.size > sampledBytes };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function getRecentFeedbackLogPaths(logsDir: string, days = DEFAULT_LOG_DAYS): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(logsDir);
  } catch {
    return [];
  }

  const dates = new Set<string>();
  for (const file of files) {
    const match = DATE_PATTERN.exec(file);
    if (match && LOG_SUFFIXES.some((suffix) => file.endsWith(suffix))) {
      dates.add(match[0]);
    }
  }

  const recentDates = [...dates].toSorted().toReversed().slice(0, days);
  const paths: string[] = [];
  for (const dateStr of recentDates) {
    for (const suffix of LOG_SUFFIXES) {
      const filePath = path.join(logsDir, `${dateStr}${suffix}`);
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        paths.push(filePath);
      } catch {
        continue;
      }
    }
  }

  return paths;
}

export function collectFeedbackLogAttachment(logsDir: string): FeedbackLogAttachment | null {
  const logPaths = getRecentFeedbackLogPaths(logsDir);
  if (logPaths.length === 0) {
    return null;
  }

  const sources = logPaths.map((logPath): SupportBundleLogSource => {
    const basename = path.basename(logPath);
    const tail = readBoundedLogTail(logPath);
    return {
      source: sourceForLogPath(logPath),
      date: basename.slice(0, 10),
      content: tail.content,
      sampled_bytes: tail.sampled_bytes,
      size_bytes: tail.size_bytes,
      truncated: tail.truncated,
    };
  });
  const summary = buildSupportBundleSummary(sources);

  return {
    filename: 'command-eve-support-diagnostics.json.gz',
    data: zlib.gzipSync(Buffer.from(`${JSON.stringify(summary, null, 2)}\n`, 'utf8')),
    contentType: 'application/gzip',
  };
}
