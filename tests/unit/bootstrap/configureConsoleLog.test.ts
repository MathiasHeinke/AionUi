/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

type LogLevel = string | false;

type LogMock = {
  transports: {
    file: {
      fileName: string;
      level: LogLevel;
      maxSize: number;
      resolvePathFn?: () => string;
    };
    console: {
      level: LogLevel;
    };
  };
  hooks: {
    push: ReturnType<typeof vi.fn>;
  };
  initialize: ReturnType<typeof vi.fn>;
  functions: Partial<Console>;
};

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};
const originalBenchmarkLogPath = process.env.COMMAND_EVE_BENCHMARK_LOG_PATH;

const createLogMock = (): LogMock => ({
  transports: {
    file: {
      fileName: '',
      level: false,
      maxSize: 0,
    },
    console: {
      level: 'silly',
    },
  },
  hooks: {
    push: vi.fn(),
  },
  initialize: vi.fn(),
  functions: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
});

const loadConfigureConsoleLog = async (isPackaged: boolean): Promise<LogMock> => {
  vi.resetModules();

  const logMock = createLogMock();

  vi.doMock('electron', () => ({
    app: {
      isPackaged,
    },
  }));

  vi.doMock('electron-log/main', () => ({
    default: logMock,
  }));

  await import('@process/utils/configureConsoleLog');

  return logMock;
};

describe('configureConsoleLog', () => {
  afterEach(() => {
    if (originalBenchmarkLogPath === undefined) delete process.env.COMMAND_EVE_BENCHMARK_LOG_PATH;
    else process.env.COMMAND_EVE_BENCHMARK_LOG_PATH = originalBenchmarkLogPath;
    Object.assign(console, originalConsole);
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('disables stdout console transport in packaged builds', async () => {
    const log = await loadConfigureConsoleLog(true);

    expect(log.transports.console.level).toBe(false);
    expect(log.transports.file.level).toBe('info');
    expect(log.initialize).toHaveBeenCalledOnce();
  });

  it('keeps stdout console transport available during development', async () => {
    const log = await loadConfigureConsoleLog(false);

    expect(log.transports.console.level).toBe('silly');
  });

  it('isolates benchmark logs only when given an absolute path', async () => {
    process.env.COMMAND_EVE_BENCHMARK_LOG_PATH = '/tmp/command-eve-ttft/runtime.log';

    const log = await loadConfigureConsoleLog(true);

    expect(log.transports.file.resolvePathFn?.()).toBe('/tmp/command-eve-ttft/runtime.log');
    expect(log.transports.file.fileName).toBe('');
  });

  it('ignores a relative benchmark log override', async () => {
    process.env.COMMAND_EVE_BENCHMARK_LOG_PATH = 'relative/runtime.log';

    const log = await loadConfigureConsoleLog(true);

    expect(log.transports.file.resolvePathFn).toBeUndefined();
    expect(log.transports.file.fileName).toMatch(/^\d{4}-\d{2}-\d{2}\.log$/);
  });
});
