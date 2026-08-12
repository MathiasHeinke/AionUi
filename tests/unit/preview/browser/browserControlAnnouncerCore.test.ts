import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBrowserControlAnnouncer } from '@/renderer/components/media/browserControlAnnouncerCore';

const epoch = (digit: string) => digit.repeat(32);
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('browser control renderer announcer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a bounded number of times until MAIN ACKs, then stays idempotent', async () => {
    let calls = 0;
    const report = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? ({ ok: false, reason: 'not-ready' } as const) : ({ ok: true, leaseId: epoch('a') } as const);
    });
    const release = vi.fn(async () => undefined);
    const unavailable = vi.fn();
    const announcer = createBrowserControlAnnouncer({
      contextId: 'account-a',
      controlEpoch: epoch('1'),
      getWebContentsId: () => 101,
      report,
      release,
      retryDelaysMs: [10, 20],
      onUnavailable: unavailable,
    });

    announcer.start();
    await flush();
    expect(report).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(report).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(report).toHaveBeenCalledTimes(3);
    announcer.signalReady();
    await flush();
    expect(report).toHaveBeenCalledTimes(3);
    expect(unavailable).not.toHaveBeenCalled();

    announcer.dispose();
    await flush();
    expect(release).toHaveBeenCalledWith({
      contextId: 'account-a',
      controlEpoch: epoch('1'),
      webContentsId: 101,
      leaseId: epoch('a'),
    });
  });

  it('stops after the retry budget instead of blind polling', async () => {
    const report = vi.fn(async () => ({ ok: false, reason: 'not-ready' }) as const);
    const unavailable = vi.fn();
    const announcer = createBrowserControlAnnouncer({
      contextId: 'account-a',
      controlEpoch: epoch('2'),
      getWebContentsId: () => 102,
      report,
      release: async () => undefined,
      retryDelaysMs: [5, 10],
      onUnavailable: unavailable,
    });

    announcer.start();
    await flush();
    await vi.advanceTimersByTimeAsync(15);
    await vi.runAllTimersAsync();
    expect(report).toHaveBeenCalledTimes(3);
    expect(unavailable).toHaveBeenCalledOnce();
    announcer.dispose();
  });

  it('releases a delayed stale ACK after epoch teardown instead of reviving A1', async () => {
    let resolveA!: (value: { ok: true; leaseId: string }) => void;
    const reportA = vi.fn(() => new Promise<{ ok: true; leaseId: string }>((resolve) => (resolveA = resolve)));
    const releaseA = vi.fn(async () => undefined);
    const announcerA = createBrowserControlAnnouncer({
      contextId: 'account-a',
      controlEpoch: epoch('3'),
      getWebContentsId: () => 103,
      report: reportA,
      release: releaseA,
    });
    const releaseB = vi.fn(async () => undefined);
    const announcerB = createBrowserControlAnnouncer({
      contextId: 'account-b',
      controlEpoch: epoch('4'),
      getWebContentsId: () => 104,
      report: async () => ({ ok: true, leaseId: epoch('b') }),
      release: releaseB,
    });

    announcerA.start();
    await flush();
    announcerA.dispose();
    announcerB.start();
    await flush();
    resolveA({ ok: true, leaseId: epoch('a') });
    await flush();

    expect(releaseA).toHaveBeenCalledWith({
      contextId: 'account-a',
      controlEpoch: epoch('3'),
      webContentsId: 103,
      leaseId: epoch('a'),
    });
    expect(releaseB).not.toHaveBeenCalled();
    announcerB.dispose();
  });

  it('re-announces the recovered guest when ready arrives before an old report resolves', async () => {
    let resolveOld!: (value: { ok: true; leaseId: string }) => void;
    let webContentsId = 108;
    const report = vi
      .fn()
      .mockImplementationOnce(() => new Promise<{ ok: true; leaseId: string }>((resolve) => (resolveOld = resolve)))
      .mockResolvedValueOnce({ ok: true, leaseId: epoch('f') });
    const release = vi.fn(async () => undefined);
    const announcer = createBrowserControlAnnouncer({
      contextId: 'account-a',
      controlEpoch: epoch('7'),
      getWebContentsId: () => webContentsId,
      report,
      release,
    });

    announcer.start();
    await flush();
    announcer.signalLost();
    webContentsId = 109;
    announcer.signalReady();
    resolveOld({ ok: true, leaseId: epoch('e') });
    await flush();

    expect(report).toHaveBeenNthCalledWith(1, 108);
    expect(report).toHaveBeenNthCalledWith(2, 109);
    expect(release).toHaveBeenCalledWith({
      contextId: 'account-a',
      controlEpoch: epoch('7'),
      webContentsId: 108,
      leaseId: epoch('e'),
    });
    announcer.dispose();
  });

  it('releases on guest process loss and re-announces only after a new ready event', async () => {
    let webContentsId = 105;
    let leaseId = epoch('c');
    const report = vi.fn(async () => ({ ok: true, leaseId }) as const);
    const release = vi.fn(async () => undefined);
    const announcer = createBrowserControlAnnouncer({
      contextId: 'account-a',
      controlEpoch: epoch('5'),
      getWebContentsId: () => webContentsId,
      report,
      release,
    });

    announcer.start();
    await flush();
    announcer.signalLost();
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    expect(report).toHaveBeenCalledTimes(1);

    webContentsId = 106;
    leaseId = epoch('d');
    announcer.signalReady();
    await flush();
    expect(report).toHaveBeenCalledTimes(2);
    announcer.dispose();
  });

  it('retries exact cleanup briefly after inactive or unmount release failure', async () => {
    let releaseCalls = 0;
    const release = vi.fn(async () => {
      releaseCalls += 1;
      if (releaseCalls < 3) throw new Error('transient ipc loss');
    });
    const announcer = createBrowserControlAnnouncer({
      contextId: 'account-a',
      controlEpoch: epoch('6'),
      getWebContentsId: () => 107,
      report: async () => ({ ok: true, leaseId: epoch('e') }),
      release,
    });

    announcer.start();
    await flush();
    announcer.dispose();
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    expect(release).toHaveBeenCalledTimes(3);
  });
});
