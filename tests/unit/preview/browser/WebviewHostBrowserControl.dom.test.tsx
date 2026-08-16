/** @vitest-environment jsdom */

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  report: vi.fn(),
  release: vi.fn(),
  registerReader: vi.fn(() => vi.fn()),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: {
      reportBrowserWebContentsId: { invoke: mocks.report },
      releaseBrowserWebContentsLease: { invoke: mocks.release },
    },
  },
}));

vi.mock('@/renderer/pages/conversation/Preview/services/previewReader', () => ({
  registerPreviewPageReader: mocks.registerReader,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/components/icons', () => ({
  Left: () => null,
  Right: () => null,
  Refresh: () => null,
  Loading: () => null,
}));

import WebviewHost from '@/renderer/components/media/WebviewHost';

const controlEpoch = '1'.repeat(32);
const leaseId = (attempt: number) => (attempt % 10).toString().repeat(32);
let currentWebContentsId = 201;
let reportAttempt = 0;

beforeEach(() => {
  reportAttempt = 0;
  currentWebContentsId = 201;
  mocks.report.mockReset().mockImplementation(async () => {
    reportAttempt += 1;
    if (reportAttempt === 1) return { success: false, msg: 'guest not registered yet' };
    return { success: true, data: { leaseId: leaseId(reportAttempt) } };
  });
  mocks.release.mockReset().mockResolvedValue({ success: true });
  mocks.registerReader.mockClear();

  Object.defineProperties(HTMLElement.prototype, {
    getWebContentsId: { configurable: true, value: () => currentWebContentsId },
    getTitle: { configurable: true, value: () => 'Browser fixture' },
    getURL: { configurable: true, value: () => 'https://example.com/' },
    executeJavaScript: { configurable: true, value: async () => '' },
    setZoomFactor: { configurable: true, value: () => undefined },
    reload: { configurable: true, value: () => undefined },
  });
});

afterEach(() => cleanup());

describe('WebviewHost browser control lifecycle', () => {
  it('announces on did-attach/dom-ready and exact-releases on hide, loss, destroy, and unmount', async () => {
    const props = {
      url: 'https://example.com/',
      previewReaderId: 'browser-tab-1',
      browserContextId: 'a'.repeat(32),
      browserControlEpoch: controlEpoch,
      partition: `persist:command-eve-browser-${'a'.repeat(32)}`,
    };
    const view = render(<WebviewHost {...props} active />);
    const webview = view.container.querySelector('webview');
    expect(webview).not.toBeNull();

    await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(1));
    act(() => webview!.dispatchEvent(new Event('did-attach')));
    await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(2));
    expect(mocks.report).toHaveBeenLastCalledWith({
      webContentsId: 201,
      contextId: 'a'.repeat(32),
      controlEpoch,
    });

    view.rerender(<WebviewHost {...props} active={false} />);
    await waitFor(() =>
      expect(mocks.release).toHaveBeenCalledWith({
        contextId: 'a'.repeat(32),
        controlEpoch,
        webContentsId: 201,
        leaseId: leaseId(2),
      })
    );

    view.rerender(<WebviewHost {...props} active />);
    await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(3));
    act(() => webview!.dispatchEvent(new Event('render-process-gone')));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ leaseId: leaseId(3) })));

    currentWebContentsId = 202;
    act(() => webview!.dispatchEvent(new Event('did-attach')));
    await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(4));
    act(() => webview!.dispatchEvent(new Event('destroyed')));
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ leaseId: leaseId(4) })));

    currentWebContentsId = 203;
    act(() => webview!.dispatchEvent(new Event('dom-ready')));
    await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(5));
    view.unmount();
    await waitFor(() => expect(mocks.release).toHaveBeenCalledWith(expect.objectContaining({ leaseId: leaseId(5) })));
  });
});
