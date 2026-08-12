/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandEveBrowserContextDescriptor } from './browserWorkbenchStateCore';

export const BROWSER_CONTROL_EPOCH_RE = /^[a-f0-9]{32}$/;
export const BROWSER_CONTROL_LEASE_RE = /^[a-f0-9]{32}$/;

/**
 * Narrow wire contract for the controllable, visible browser. The persisted
 * workbench-state descriptor deliberately remains free of runtime control
 * metadata; MAIN adds a fresh epoch whenever it activates an account+seed
 * context.
 */
export type CommandEveBrowserControlContext = CommandEveBrowserContextDescriptor & {
  control_epoch: string;
};

export type BrowserControlIdentity = {
  contextId: string;
  controlEpoch: string;
};

export type BrowserControlAnnouncement = BrowserControlIdentity & {
  webContentsId: number;
};

export type BrowserControlLease = BrowserControlAnnouncement & {
  leaseId: string;
};

export type BrowserControlAnnouncementDecision =
  | { kind: 'attach' }
  | { kind: 'idempotent'; leaseId: string }
  | { kind: 'reject'; reason: string };

export const decideBrowserControlAnnouncement = (
  active: BrowserControlIdentity | null,
  attached: BrowserControlLease | null,
  announcement: BrowserControlAnnouncement
): BrowserControlAnnouncementDecision => {
  if (!active || announcement.contextId !== active.contextId || announcement.controlEpoch !== active.controlEpoch) {
    return { kind: 'reject', reason: 'Refusing stale or foreign browser control epoch.' };
  }
  if (!attached) return { kind: 'attach' };
  if (
    attached.contextId === announcement.contextId &&
    attached.controlEpoch === announcement.controlEpoch &&
    attached.webContentsId === announcement.webContentsId
  ) {
    return { kind: 'idempotent', leaseId: attached.leaseId };
  }
  return { kind: 'reject', reason: 'Another visible browser target still holds the control lease.' };
};

export const isExactBrowserControlLease = (
  current: BrowserControlLease | null,
  candidate: BrowserControlLease
): boolean =>
  Boolean(
    current &&
    current.contextId === candidate.contextId &&
    current.controlEpoch === candidate.controlEpoch &&
    current.webContentsId === candidate.webContentsId &&
    current.leaseId === candidate.leaseId
  );

/**
 * Renderer-side epoch gate. Once an epoch is superseded in this renderer
 * process it can never become current again, so a delayed A1 response cannot
 * overwrite B or A2.
 */
export const createBrowserControlEpochGate = () => {
  let current: string | null = null;
  const retiredSet = new Set<string>();

  return {
    accept(controlEpoch: string): boolean {
      if (!BROWSER_CONTROL_EPOCH_RE.test(controlEpoch) || retiredSet.has(controlEpoch)) return false;
      if (current && current !== controlEpoch) {
        retiredSet.add(current);
      }
      current = controlEpoch;
      return true;
    },
    current: (): string | null => current,
  };
};
