/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandEveTerminalDataEvent,
  CommandEveTerminalExitEvent,
} from '@/common/config/commandEveTerminalChannels';

export type CommandEveTerminalStartupEvent =
  | { kind: 'data'; event: CommandEveTerminalDataEvent }
  | { kind: 'exit'; event: CommandEveTerminalExitEvent };

/**
 * `node-pty` can emit a prompt between spawn() and the IPC start reply. The
 * renderer does not know its server-generated terminal id until that reply, so
 * keep the short startup stream losslessly and bind it only after the id is
 * known. Events belonging to already-running sibling terminals are discarded
 * on drain rather than leaking into this viewport.
 */
export function createTerminalStartupEventBuffer(): {
  pushData: (event: CommandEveTerminalDataEvent) => void;
  pushExit: (event: CommandEveTerminalExitEvent) => void;
  drain: (terminalId: string) => CommandEveTerminalStartupEvent[];
  clear: () => void;
} {
  let accepting = true;
  let events: CommandEveTerminalStartupEvent[] = [];

  return {
    pushData(event) {
      if (accepting) events.push({ kind: 'data', event });
    },
    pushExit(event) {
      if (accepting) events.push({ kind: 'exit', event });
    },
    drain(terminalId) {
      accepting = false;
      const matched = events.filter((entry) => entry.event.terminalId === terminalId);
      events = [];
      return matched;
    },
    clear() {
      accepting = false;
      events = [];
    },
  };
}
