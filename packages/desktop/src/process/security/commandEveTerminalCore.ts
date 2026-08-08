/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

import type { CommandEveTerminalStartRequest } from '@/common/config/commandEveTerminalChannels';

export const COMMAND_EVE_TERMINAL_MAX_SESSIONS_PER_RENDERER = 8;
export const COMMAND_EVE_TERMINAL_MAX_WRITE_BYTES = 64 * 1024;
export const COMMAND_EVE_TERMINAL_MAX_OUTPUT_BYTES = 64 * 1024;

const ENVIRONMENT_KEYS = new Set([
  'HOME',
  'LANG',
  'LOGNAME',
  'PATH',
  'SHELL',
  'SSH_AUTH_SOCK',
  'TMPDIR',
  'USER',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'ComSpec',
  'SystemDrive',
  'SystemRoot',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'windir',
]);

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

export function parseCommandEveTerminalStartRequest(value: unknown): Required<CommandEveTerminalStartRequest> {
  const candidate = value && typeof value === 'object' ? (value as CommandEveTerminalStartRequest) : {};
  const cwd = typeof candidate.cwd === 'string' && candidate.cwd.length <= 4096 ? candidate.cwd.trim() : '';
  return {
    cwd,
    cols: clampInteger(candidate.cols, 100, 20, 400),
    rows: clampInteger(candidate.rows, 30, 5, 200),
  };
}

export function parseCommandEveTerminalId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{16,80}$/i.test(value)) {
    throw new Error('Invalid terminal identity.');
  }
  return value;
}

export function parseCommandEveTerminalWrite(value: unknown): { terminalId: string; data: string } {
  if (!value || typeof value !== 'object') throw new Error('Invalid terminal write request.');
  const candidate = value as { terminalId?: unknown; data?: unknown };
  const terminalId = parseCommandEveTerminalId(candidate.terminalId);
  if (typeof candidate.data !== 'string') throw new Error('Invalid terminal input.');
  if (Buffer.byteLength(candidate.data, 'utf8') > COMMAND_EVE_TERMINAL_MAX_WRITE_BYTES) {
    throw new Error('Terminal input exceeds the per-write limit.');
  }
  return { terminalId, data: candidate.data };
}

/** Split PTY output without dropping bytes or cutting a Unicode code point. */
export function chunkCommandEveTerminalOutput(
  data: string,
  maxBytes = COMMAND_EVE_TERMINAL_MAX_OUTPUT_BYTES
): string[] {
  if (!data) return [];
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid terminal output chunk limit.');
  if (Buffer.byteLength(data, 'utf8') <= maxBytes) return [data];

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const codePoint of data) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');
    if (current && currentBytes + codePointBytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += codePointBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function parseCommandEveTerminalResize(value: unknown): { terminalId: string; cols: number; rows: number } {
  if (!value || typeof value !== 'object') throw new Error('Invalid terminal resize request.');
  const candidate = value as { terminalId?: unknown; cols?: unknown; rows?: unknown };
  return {
    terminalId: parseCommandEveTerminalId(candidate.terminalId),
    cols: clampInteger(candidate.cols, 100, 20, 400),
    rows: clampInteger(candidate.rows, 30, 5, 200),
  };
}

export function createCommandEveTerminalEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(source)) {
    if (typeof rawValue !== 'string') continue;
    if (!ENVIRONMENT_KEYS.has(key) && !key.startsWith('LC_')) continue;
    environment[key] = rawValue;
  }

  environment.TERM = 'xterm-256color';
  environment.COLORTERM = 'truecolor';
  environment.TERM_PROGRAM = 'CommandEVE';
  environment.TERM_PROGRAM_VERSION = '1';
  if (platform !== 'win32' && !environment.PATH) {
    environment.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  }
  return environment;
}

export function resolveCommandEveTerminalCwd(
  requestedCwd: string,
  fallbackCwd: string,
  isDirectory: (candidate: string) => boolean
): string {
  const candidates = [requestedCwd, fallbackCwd].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (path.isAbsolute(resolved) && isDirectory(resolved)) return resolved;
  }
  throw new Error('No usable terminal working directory is available.');
}
