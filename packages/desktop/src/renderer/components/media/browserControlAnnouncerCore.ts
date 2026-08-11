/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserControlLease } from '@/common/config/browserWorkbenchControlCore';

type ReportResult = { ok: true; leaseId: string } | { ok: false; reason?: string };

export type BrowserControlAnnouncerOptions = {
  contextId: string;
  controlEpoch: string;
  getWebContentsId: () => number;
  report: (webContentsId: number) => Promise<ReportResult>;
  release: (lease: BrowserControlLease) => Promise<void>;
  retryDelaysMs?: readonly number[];
  onUnavailable?: (reason: string) => void;
};

export type BrowserControlAnnouncer = {
  start: () => void;
  signalReady: () => void;
  signalLost: () => void;
  dispose: () => void;
};

const DEFAULT_RETRY_DELAYS_MS = [75, 150, 300, 600, 1_200, 2_400, 4_000] as const;
const RELEASE_RETRY_DELAYS_MS = [50, 150] as const;

/**
 * One in-flight announcement per local generation. Lifecycle loss and dispose
 * advance the generation, so a delayed successful ACK is immediately released
 * instead of reviving a hidden or stale target.
 */
export const createBrowserControlAnnouncer = (options: BrowserControlAnnouncerOptions): BrowserControlAnnouncer => {
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let generation = 0;
  let disposed = false;
  let inFlight = false;
  let retryRequested = false;
  let retryIndex = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lease: BrowserControlLease | null = null;

  const clearRetry = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const releaseLease = (candidate: BrowserControlLease | null) => {
    if (!candidate) return;
    const attemptRelease = async (attempt: number): Promise<void> => {
      try {
        await options.release(candidate);
      } catch {
        const delay = RELEASE_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) setTimeout(() => void attemptRelease(attempt + 1), delay);
        // MAIN also owns exact guest destroyed/render-process-gone cleanup.
      }
    };
    void attemptRelease(0);
  };

  const scheduleRetry = (expectedGeneration: number, attempt: () => void, reason: string) => {
    if (disposed || generation !== expectedGeneration || timer) return;
    const delay = retryDelays[retryIndex++];
    if (delay === undefined) {
      options.onUnavailable?.(reason);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      attempt();
    }, delay);
  };

  const attempt = async () => {
    if (disposed) return;
    if (inFlight) {
      retryRequested = true;
      return;
    }
    clearRetry();
    const attemptGeneration = generation;
    let webContentsId: number;
    try {
      webContentsId = options.getWebContentsId();
    } catch {
      scheduleRetry(attemptGeneration, () => void attempt(), 'guest-not-ready');
      return;
    }

    if (lease?.webContentsId === webContentsId) return;
    if (lease) {
      const previous = lease;
      lease = null;
      try {
        await options.release(previous);
      } catch {
        // The following report remains fail-closed while MAIN still owns it.
      }
      if (disposed || generation !== attemptGeneration) return;
    }

    inFlight = true;
    let result: ReportResult;
    try {
      result = await options.report(webContentsId);
    } catch {
      result = { ok: false, reason: 'main-ack-unavailable' };
    } finally {
      inFlight = false;
    }

    if (result.ok) {
      const acknowledged: BrowserControlLease = {
        contextId: options.contextId,
        controlEpoch: options.controlEpoch,
        webContentsId,
        leaseId: result.leaseId,
      };
      if (disposed || generation !== attemptGeneration) {
        releaseLease(acknowledged);
      } else {
        lease = acknowledged;
        retryIndex = 0;
      }
    } else if (result.ok === false && !disposed && generation === attemptGeneration) {
      scheduleRetry(attemptGeneration, () => void attempt(), result.reason ?? 'main-ack-refused');
    }

    if (retryRequested && !disposed) {
      retryRequested = false;
      void attempt();
    }
  };

  const signalReady = () => {
    if (disposed) return;
    retryIndex = 0;
    clearRetry();
    void attempt();
  };

  const signalLost = () => {
    if (disposed) return;
    generation += 1;
    retryRequested = false;
    retryIndex = 0;
    clearRetry();
    const previous = lease;
    lease = null;
    releaseLease(previous);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    retryRequested = false;
    clearRetry();
    const previous = lease;
    lease = null;
    releaseLease(previous);
  };

  return { start: signalReady, signalReady, signalLost, dispose };
};
