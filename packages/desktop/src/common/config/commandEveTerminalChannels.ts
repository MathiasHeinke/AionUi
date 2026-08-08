/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

export const COMMAND_EVE_TERMINAL_CHANNELS = {
  start: 'command-eve:terminal:start',
  write: 'command-eve:terminal:write',
  resize: 'command-eve:terminal:resize',
  close: 'command-eve:terminal:close',
  data: 'command-eve:terminal:data',
  exit: 'command-eve:terminal:exit',
} as const;

export type CommandEveTerminalStartRequest = {
  cwd?: string;
  cols?: number;
  rows?: number;
};

export type CommandEveTerminalStartResult = {
  terminalId: string;
  cwd: string;
  shell: string;
};

export type CommandEveTerminalDataEvent = {
  terminalId: string;
  data: string;
};

export type CommandEveTerminalExitEvent = {
  terminalId: string;
  exitCode: number;
  signal?: number;
};
