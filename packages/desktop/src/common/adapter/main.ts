/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserWindow } from 'electron';
import { ipcMain } from 'electron';

import { bridge } from '@office-ai/platform';
import { ADAPTER_BRIDGE_EVENT_KEY } from './constant';
import { registerWebSocketBroadcaster, getBridgeEmitter, setBridgeEmitter, broadcastToAll } from './registry';

/**
 * Bridge event data structure for IPC communication
 * IPC 通信的桥接事件数据结构
 */
interface BridgeEventData {
  name: string;
  data: unknown;
}

type AdapterIpcEvent = {
  sender: Electron.WebContents;
  senderFrame?: Electron.WebFrameMain | null;
};

const adapterWindowList: Array<BrowserWindow> = [];

export { registerWebSocketBroadcaster, getBridgeEmitter };

let petNotifyHook: ((name: string, data: unknown) => void) | null = null;

export const setPetNotifyHook = (hook: ((name: string, data: unknown) => void) | null): void => {
  petNotifyHook = hook;
};

/**
 * @description 建立与每一个browserWindow的通信桥梁
 * */
/** Maximum IPC payload size (50 MB). Messages exceeding this are dropped with an error notification. */
const MAX_IPC_PAYLOAD_SIZE = 50 * 1024 * 1024;
const MAX_BRIDGE_EVENT_NAME_LENGTH = 256;

export function isTrustedAdapterIpcSender(event: AdapterIpcEvent): boolean {
  const sender = event.sender;
  if (!sender || sender.isDestroyed()) return false;
  if (event.senderFrame && event.senderFrame !== sender.mainFrame) return false;
  return adapterWindowList.some(
    (win) => !win.isDestroyed() && !win.webContents.isDestroyed() && win.webContents === sender
  );
}

function parseBridgeEvent(info: unknown): BridgeEventData {
  if (typeof info !== 'string') throw new Error('Invalid adapter bridge payload type.');
  if (Buffer.byteLength(info, 'utf8') > MAX_IPC_PAYLOAD_SIZE) {
    throw new Error('Adapter bridge payload exceeds the allowed size.');
  }
  const parsed = JSON.parse(info) as Partial<BridgeEventData> | null;
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.name !== 'string' ||
    parsed.name.length === 0 ||
    parsed.name.length > MAX_BRIDGE_EVENT_NAME_LENGTH
  ) {
    throw new Error('Invalid adapter bridge event shape.');
  }
  return { name: parsed.name, data: parsed.data };
}

bridge.adapter({
  emit(name, data) {
    // Notify pet (if hook is set)
    if (petNotifyHook) {
      try {
        petNotifyHook(name, data);
      } catch {
        /* never crash */
      }
    }

    // 1. Send to all Electron BrowserWindows (skip destroyed ones)
    let serialized: string;
    try {
      serialized = JSON.stringify({ name, data });
    } catch (error) {
      // RangeError: Invalid string length — data too large to serialize
      console.error('[adapter] Failed to serialize bridge event:', name, error);
      return;
    }

    // Guard: reject oversized payloads to prevent main-process blocking
    if (serialized.length > MAX_IPC_PAYLOAD_SIZE) {
      console.error(
        `[adapter] Bridge event "${name}" too large (${(serialized.length / 1024 / 1024).toFixed(1)}MB), skipped`
      );
      const errorPayload = JSON.stringify({
        name: 'bridge:error',
        data: { originalEvent: name, reason: 'payload_too_large', size: serialized.length },
      });
      for (let i = adapterWindowList.length - 1; i >= 0; i--) {
        const win = adapterWindowList[i];
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(ADAPTER_BRIDGE_EVENT_KEY, errorPayload);
        }
      }
      return;
    }

    for (let i = adapterWindowList.length - 1; i >= 0; i--) {
      const win = adapterWindowList[i];
      if (win.isDestroyed() || win.webContents.isDestroyed()) {
        adapterWindowList.splice(i, 1);
        continue;
      }
      win.webContents.send(ADAPTER_BRIDGE_EVENT_KEY, serialized);
    }
    // 2. Also broadcast to all WebSocket clients
    broadcastToAll(name, data);
  },
  on(emitter) {
    // 保存 emitter 引用供 WebSocket 处理使用 / Save emitter reference for WebSocket handling
    setBridgeEmitter(emitter);

    ipcMain.handle(ADAPTER_BRIDGE_EVENT_KEY, (event, info) => {
      if (!isTrustedAdapterIpcSender(event)) throw new Error('Blocked untrusted adapter bridge sender.');
      const { name, data } = parseBridgeEvent(info);
      return Promise.resolve(emitter.emit(name, data));
    });
  },
});

export const initMainAdapterWithWindow = (win: BrowserWindow) => {
  adapterWindowList.push(win);
  const off = () => {
    const index = adapterWindowList.indexOf(win);
    if (index > -1) adapterWindowList.splice(index, 1);
  };
  win.on('closed', off);
  return off;
};
