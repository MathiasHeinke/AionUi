/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Node-environment tests for feedbackBridge's IPC handlers.
 * Covers the new feedback:capture-screenshot handler (main-process side).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { collectFeedbackLogAttachment } from '@/process/feedback/logs';

// Table of handlers registered via ipcMain.handle during module import.
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

type FakeWebContents = {
  capturePage?: () => Promise<{ toPNG: () => Buffer }>;
};

type FakeWindow = {
  isDestroyed: () => boolean;
  webContents: FakeWebContents;
};

let currentWindow: FakeWindow | null = null;
const adapterTrustMock = vi.hoisted(() => ({ trusted: true }));

vi.mock('@/common/adapter/main', () => ({
  isTrustedAdapterIpcSender: () => adapterTrustMock.trusted,
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
  app: {
    getPath: vi.fn(() => '/tmp/aionui-test-logs-nonexistent'),
    getVersion: vi.fn(() => '0.0.0'),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => currentWindow),
  },
}));

beforeEach(async () => {
  handlers.clear();
  currentWindow = null;
  adapterTrustMock.trusted = true;
  vi.resetModules();
  // Importing registers the ipcMain.handle callbacks into our map.
  await import('@/process/bridge/feedbackBridge');
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('feedbackBridge — capture-screenshot', () => {
  it('registers the feedback:capture-screenshot channel on import', () => {
    expect(handlers.has('feedback:capture-screenshot')).toBe(true);
  });

  it('blocks screenshot capture from an untrusted renderer', async () => {
    adapterTrustMock.trusted = false;
    currentWindow = {
      isDestroyed: () => false,
      webContents: { capturePage: vi.fn() },
    };

    const result = await handlers.get('feedback:capture-screenshot')!({ sender: {} });

    expect(result).toBeNull();
    expect(currentWindow.webContents.capturePage).not.toHaveBeenCalled();
  });

  it('returns png bytes and a timestamped filename on success', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
    currentWindow = {
      isDestroyed: () => false,
      webContents: {
        capturePage: vi.fn(async () => ({ toPNG: () => pngBytes })),
      },
    };

    const handler = handlers.get('feedback:capture-screenshot')!;
    const result = (await handler({ sender: {} })) as { filename: string; data: number[] } | null;

    expect(result).not.toBeNull();
    expect(result!.filename).toMatch(/^screenshot-.*\.png$/);
    expect(result!.data).toEqual(Array.from(pngBytes));
  });

  it('returns null when no owning BrowserWindow is resolved', async () => {
    currentWindow = null;
    const handler = handlers.get('feedback:capture-screenshot')!;
    const result = await handler({ sender: {} });
    expect(result).toBeNull();
  });

  it('returns null when the owning BrowserWindow is destroyed', async () => {
    currentWindow = {
      isDestroyed: () => true,
      webContents: {
        capturePage: vi.fn(),
      },
    };
    const handler = handlers.get('feedback:capture-screenshot')!;
    const result = await handler({ sender: {} });
    expect(result).toBeNull();
    expect(currentWindow.webContents.capturePage).not.toHaveBeenCalled();
  });

  it('returns null when capturePage yields an empty buffer', async () => {
    currentWindow = {
      isDestroyed: () => false,
      webContents: {
        capturePage: vi.fn(async () => ({ toPNG: () => Buffer.alloc(0) })),
      },
    };

    const handler = handlers.get('feedback:capture-screenshot')!;
    const result = await handler({ sender: {} });
    expect(result).toBeNull();
  });

  it('returns null and does not throw when capturePage rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    currentWindow = {
      isDestroyed: () => false,
      webContents: {
        capturePage: vi.fn(async () => {
          throw new Error('capture refused');
        }),
      },
    };

    const handler = handlers.get('feedback:capture-screenshot')!;
    const result = await handler({ sender: {} });
    expect(result).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe('feedback logs', () => {
  it('collects bounded metadata for the recent three log days without raw content or private paths', () => {
    const logsDir = mkdtempSync(path.join(tmpdir(), 'aionui-feedback-logs-'));
    try {
      writeFileSync(
        path.join(logsDir, '2026-05-25.log'),
        'ERROR user prompt: draft the confidential acquisition plan for alice@example.com\n'
      );
      writeFileSync(
        path.join(logsDir, '2026-05-25.aioncore.log'),
        'backend failed at C:\\Users\\operator\\private-workspace with sk-test-123456789012345678901234\n'
      );
      writeFileSync(path.join(logsDir, '2026-05-24.aionrs.log'), 'yesterday rust\n');
      writeFileSync(path.join(logsDir, '2026-05-23.log'), 'third day frontend\n');
      writeFileSync(path.join(logsDir, '2026-05-22.log'), 'too old frontend\n');
      writeFileSync(path.join(logsDir, '2026-05-25.txt'), 'not a log\n');

      const attachment = collectFeedbackLogAttachment(logsDir);

      expect(attachment).not.toBeNull();
      expect(attachment!.filename).toBe('command-eve-support-diagnostics.json.gz');
      expect(attachment!.contentType).toBe('application/gzip');
      const content = gunzipSync(attachment!.data).toString('utf8');
      const summary = JSON.parse(content) as {
        schema_version: string;
        privacy: Record<string, boolean | string>;
        sources: Array<{ source: string; date: string }>;
        totals: { source_count: number };
        completion_sentinel: string;
      };
      expect(summary.schema_version).toBe('command-eve-support-bundle/v1');
      expect(summary.privacy).toMatchObject({
        raw_log_content_included: false,
        filenames_included: false,
        local_paths_included: false,
        user_content_included: false,
        sensitive_scan: 'PASS',
      });
      expect(summary.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: 'frontend', date: '2026-05-25' }),
          expect.objectContaining({ source: 'backend', date: '2026-05-25' }),
          expect.objectContaining({ source: 'rust', date: '2026-05-24' }),
        ])
      );
      expect(summary.totals.source_count).toBe(4);
      expect(summary.completion_sentinel).toBe('COMMAND_EVE_SUPPORT_BUNDLE_COMPLETE');
      expect(content).not.toContain('confidential acquisition');
      expect(content).not.toContain('alice@example.com');
      expect(content).not.toContain('sk-test-');
      expect(content).not.toContain('Users');
      expect(content).not.toContain('too old frontend');
      expect(content).not.toContain('not a log');
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it('ignores directory entries that only look like dated log files', () => {
    const logsDir = mkdtempSync(path.join(tmpdir(), 'aionui-feedback-logs-'));
    try {
      mkdirSync(path.join(logsDir, '2026-05-25.log'));
      expect(collectFeedbackLogAttachment(logsDir)).toBeNull();
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('never follows a dated log symlink', () => {
    const logsDir = mkdtempSync(path.join(tmpdir(), 'aionui-feedback-logs-'));
    const privateDir = mkdtempSync(path.join(tmpdir(), 'aionui-private-log-'));
    try {
      const privateLog = path.join(privateDir, 'private.log');
      writeFileSync(privateLog, 'ERROR private token sk-test-123456789012345678901234\n');
      symlinkSync(privateLog, path.join(logsDir, '2026-05-25.log'));
      expect(collectFeedbackLogAttachment(logsDir)).toBeNull();
    } finally {
      rmSync(logsDir, { recursive: true, force: true });
      rmSync(privateDir, { recursive: true, force: true });
    }
  });
});
