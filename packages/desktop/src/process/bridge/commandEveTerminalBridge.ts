/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

import { app, ipcMain, type WebContents } from 'electron';
import type { IPty } from 'node-pty';

import {
  COMMAND_EVE_TERMINAL_CHANNELS,
  type CommandEveTerminalDataEvent,
  type CommandEveTerminalExitEvent,
  type CommandEveTerminalStartResult,
} from '@/common/config/commandEveTerminalChannels';
import { isTrustedAdapterIpcSender } from '@/common/adapter/main';
import {
  COMMAND_EVE_TERMINAL_MAX_SESSIONS_PER_RENDERER,
  chunkCommandEveTerminalOutput,
  createCommandEveTerminalEnvironment,
  parseCommandEveTerminalId,
  parseCommandEveTerminalResize,
  parseCommandEveTerminalStartRequest,
  parseCommandEveTerminalWrite,
  resolveCommandEveTerminalCwd,
} from '@/process/security/commandEveTerminalCore';

type TerminalSession = {
  ownerId: number;
  process: IPty;
};

const sessions = new Map<string, TerminalSession>();
const observedRenderers = new Set<number>();

const isDirectory = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

const shellForPlatform = (): { executable: string; args: string[] } => {
  if (process.platform === 'win32') {
    return { executable: process.env.ComSpec || 'powershell.exe', args: [] };
  }
  const preferred = process.env.SHELL;
  const executable = preferred && preferred.startsWith('/') && fs.existsSync(preferred) ? preferred : '/bin/zsh';
  return { executable, args: ['-l'] };
};

const countSessionsForOwner = (ownerId: number): number => {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.ownerId === ownerId) count += 1;
  }
  return count;
};

const ownedSession = (ownerId: number, terminalId: string): TerminalSession => {
  const session = sessions.get(terminalId);
  if (!session || session.ownerId !== ownerId) throw new Error('Terminal session is not available.');
  return session;
};

const disposeSession = (terminalId: string): boolean => {
  const session = sessions.get(terminalId);
  if (!session) return false;
  sessions.delete(terminalId);
  try {
    session.process.kill();
  } catch {
    // The PTY may already have exited.
  }
  return true;
};

const disposeOwnerSessions = (ownerId: number): void => {
  for (const [terminalId, session] of sessions) {
    if (session.ownerId === ownerId) disposeSession(terminalId);
  }
  observedRenderers.delete(ownerId);
};

const sendIfAlive = <T>(sender: WebContents, channel: string, payload: T): void => {
  if (!sender.isDestroyed()) sender.send(channel, payload);
};

export function initCommandEveTerminalBridge(): void {
  ipcMain.handle(COMMAND_EVE_TERMINAL_CHANNELS.start, async (event, value: unknown): Promise<CommandEveTerminalStartResult> => {
    if (!isTrustedAdapterIpcSender(event)) throw new Error('Blocked untrusted terminal sender.');
    const ownerId = event.sender.id;
    if (countSessionsForOwner(ownerId) >= COMMAND_EVE_TERMINAL_MAX_SESSIONS_PER_RENDERER) {
      throw new Error('Terminal session limit reached.');
    }

    const request = parseCommandEveTerminalStartRequest(value);
    const cwd = resolveCommandEveTerminalCwd(request.cwd, os.homedir(), isDirectory);
    const shell = shellForPlatform();
    const terminalId = randomUUID();
    // Keep the native addon off the main startup path. A missing or mismatched
    // PTY must disable only this workbench tab, never make the whole app dark.
    const pty = await import('node-pty');
    const terminalProcess = pty.spawn(shell.executable, shell.args, {
      name: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      cwd,
      env: createCommandEveTerminalEnvironment(process.env),
    });
    sessions.set(terminalId, { ownerId, process: terminalProcess });

    if (!observedRenderers.has(ownerId)) {
      observedRenderers.add(ownerId);
      event.sender.once('destroyed', () => disposeOwnerSessions(ownerId));
    }

    terminalProcess.onData((data) => {
      for (const chunk of chunkCommandEveTerminalOutput(data)) {
        const payload: CommandEveTerminalDataEvent = { terminalId, data: chunk };
        sendIfAlive(event.sender, COMMAND_EVE_TERMINAL_CHANNELS.data, payload);
      }
    });
    terminalProcess.onExit(({ exitCode, signal }) => {
      sessions.delete(terminalId);
      const payload: CommandEveTerminalExitEvent = { terminalId, exitCode, signal };
      sendIfAlive(event.sender, COMMAND_EVE_TERMINAL_CHANNELS.exit, payload);
    });

    return { terminalId, cwd, shell: shell.executable };
  });

  ipcMain.handle(COMMAND_EVE_TERMINAL_CHANNELS.write, (event, value: unknown): boolean => {
    if (!isTrustedAdapterIpcSender(event)) throw new Error('Blocked untrusted terminal sender.');
    const request = parseCommandEveTerminalWrite(value);
    ownedSession(event.sender.id, request.terminalId).process.write(request.data);
    return true;
  });

  ipcMain.handle(COMMAND_EVE_TERMINAL_CHANNELS.resize, (event, value: unknown): boolean => {
    if (!isTrustedAdapterIpcSender(event)) throw new Error('Blocked untrusted terminal sender.');
    const request = parseCommandEveTerminalResize(value);
    ownedSession(event.sender.id, request.terminalId).process.resize(request.cols, request.rows);
    return true;
  });

  ipcMain.handle(COMMAND_EVE_TERMINAL_CHANNELS.close, (event, value: unknown): boolean => {
    if (!isTrustedAdapterIpcSender(event)) throw new Error('Blocked untrusted terminal sender.');
    const terminalId = parseCommandEveTerminalId(value);
    ownedSession(event.sender.id, terminalId);
    return disposeSession(terminalId);
  });

  app.once('before-quit', () => {
    for (const terminalId of sessions.keys()) disposeSession(terminalId);
  });
}
