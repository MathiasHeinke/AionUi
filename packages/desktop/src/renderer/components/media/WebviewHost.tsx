/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Left, Right, Refresh, Loading } from '@renderer/components/icons';
import { useTranslation } from 'react-i18next';
import { COMMAND_EVE_SHELL_ENABLED } from '@/common/config/commandEveShell';
import { ipcBridge } from '@/common';
import { registerPreviewPageReader } from '@/renderer/pages/conversation/Preview/services/previewReader';
import type { CommandEveBrowserHistoryState } from '@/common/config/browserWorkbenchStateCore';
import { createBrowserControlAnnouncer } from './browserControlAnnouncerCore';

export interface WebviewHostProps {
  /** URL to display */
  url: string;
  /** Unique key for session persistence */
  id?: string;
  /** Whether to show the navigation bar (back/forward/refresh/URL) */
  showNavBar?: boolean;
  /** Webview partition for cache/session isolation, e.g. "persist:ext-settings-feishu" */
  partition?: string;
  /** Extra class names for root container */
  className?: string;
  /** Extra styles for root container */
  style?: React.CSSProperties;
  /** Called when the page finishes loading */
  onDidFinishLoad?: () => void;
  /** Called when the page fails to load */
  onDidFailLoad?: (errorCode: number, errorDescription: string) => void;
  /** Optional controls rendered at the trailing edge of the navigation bar. */
  toolbarActions?: React.ReactNode;
  /** Workbench tab id used by the bounded Hermes read_preview bridge. */
  previewReaderId?: string;
  /** Whether this is the selected visible browser tab. */
  active?: boolean;
  /** Opaque MAIN-issued account+seed context identity. */
  browserContextId?: string;
  /** Non-secret MAIN epoch rotated on every account+seed context activation. */
  browserControlEpoch?: string;
  initialHistory?: CommandEveBrowserHistoryState;
  onNavigationStateChange?: (url: string, history: CommandEveBrowserHistoryState) => void;
}

const MIN_ZOOM_FACTOR = 0.75;
const MAX_ZOOM_FACTOR = 1.5;
const inputValueForUrl = (value: string) => (value === 'about:blank' ? '' : value);

/**
 * Shared webview host component — extracted from URLViewer.
 *
 * Features:
 * - Link/window.open/form interception → internal navigation
 * - Self-managed history stacks (back / forward)
 * - Loading indicator
 * - Partition support for cache isolation
 * - Optional navigation bar (hidden by default for embedded use)
 */
const WebviewHost: React.FC<WebviewHostProps> = ({
  url,
  id: _id,
  showNavBar = false,
  partition,
  className,
  style,
  onDidFinishLoad,
  onDidFailLoad,
  toolbarActions,
  previewReaderId,
  active = true,
  browserContextId,
  browserControlEpoch,
  initialHistory,
  onNavigationStateChange,
}) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const autoFitPendingRef = useRef(false);

  // Navigation state
  const [currentUrl, setCurrentUrl] = useState(url);
  const [inputUrl, setInputUrl] = useState(inputValueForUrl(url));
  const [isLoading, setIsLoading] = useState(true);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [webviewReady, setWebviewReady] = useState(false);
  const currentUrlRef = useRef(url);

  // Self-managed history stacks
  const historyBackRef = useRef<string[]>([...(initialHistory?.back ?? [])]);
  const historyForwardRef = useRef<string[]>([...(initialHistory?.forward ?? [])]);
  const [canGoBack, setCanGoBack] = useState(historyBackRef.current.length > 0);
  const [canGoForward, setCanGoForward] = useState(historyForwardRef.current.length > 0);

  const publishNavigationState = useCallback(
    (nextUrl: string) => {
      onNavigationStateChange?.(nextUrl, {
        back: [...historyBackRef.current],
        forward: [...historyForwardRef.current],
      });
    },
    [onNavigationStateChange]
  );

  const isStarOfficeUrl = useCallback((targetUrl: string): boolean => {
    try {
      const parsed = new URL(targetUrl);
      const host = parsed.hostname.toLowerCase();
      const localHost = host === '127.0.0.1' || host === 'localhost';
      const knownPort = ['18791', '18888', '19000'].includes(parsed.port);
      return localHost && knownPort;
    } catch {
      return false;
    }
  }, []);

  const isStarOffice = isStarOfficeUrl(currentUrl);

  // Reset when props.url changes
  useEffect(() => {
    if (url === currentUrlRef.current) return;
    historyBackRef.current = [...(initialHistory?.back ?? [])];
    historyForwardRef.current = [...(initialHistory?.forward ?? [])];
    setCanGoBack(historyBackRef.current.length > 0);
    setCanGoForward(historyForwardRef.current.length > 0);
    currentUrlRef.current = url;
    setCurrentUrl(url);
    setInputUrl(inputValueForUrl(url));
    setIsLoading(true);
    setZoomFactor(1);
    setWebviewReady(false);
    autoFitPendingRef.current = isStarOfficeUrl(url);
  }, [browserContextId, browserControlEpoch, initialHistory?.back, initialHistory?.forward, isStarOfficeUrl, url]);

  useEffect(() => {
    const webviewEl = webviewRef.current as any;
    if (!webviewReady || !webviewEl?.setZoomFactor) return;
    try {
      webviewEl.setZoomFactor(isStarOffice ? zoomFactor : 1);
    } catch {
      // Ignore zoom timing errors
    }
  }, [isStarOffice, zoomFactor, webviewReady]);

  useEffect(() => {
    if (!previewReaderId) return undefined;
    return registerPreviewPageReader(previewReaderId, async () => {
      const webview = webviewRef.current;
      if (!webview?.executeJavaScript) throw new Error('preview webview is not ready');
      const text = await webview.executeJavaScript('document.body ? document.body.innerText : ""');
      return {
        text: typeof text === 'string' ? text : '',
        title: webview.getTitle?.() ?? '',
        url: webview.getURL?.() ?? '',
      };
    });
  }, [previewReaderId]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!previewReaderId || !browserContextId || !browserControlEpoch || !active || !webview) return undefined;

    const announcer = createBrowserControlAnnouncer({
      contextId: browserContextId,
      controlEpoch: browserControlEpoch,
      getWebContentsId: () => webview.getWebContentsId(),
      report: async (webContentsId) => {
        const result = await ipcBridge.application.reportBrowserWebContentsId.invoke({
          webContentsId,
          contextId: browserContextId,
          controlEpoch: browserControlEpoch,
        });
        if (!result.success || !result.data?.leaseId) return { ok: false, reason: 'main-ack-refused' };
        return { ok: true, leaseId: result.data.leaseId };
      },
      release: async (lease) => {
        const result = await ipcBridge.application.releaseBrowserWebContentsLease.invoke(lease);
        if (!result.success) throw new Error('MAIN refused the browser control lease release.');
      },
      onUnavailable: () => {
        console.warn('[browser] Hermes control unavailable after bounded attach retries.');
      },
    });
    const signalReady = () => announcer.signalReady();
    const signalLost = () => announcer.signalLost();

    // did-attach covers guest creation; dom-ready covers the registry/debugger
    // readiness window. Loss events release only the ACKed exact lease and wait
    // for a future attach instead of polling a dead guest.
    webview.addEventListener('did-attach', signalReady);
    webview.addEventListener('dom-ready', signalReady);
    webview.addEventListener('destroyed', signalLost);
    webview.addEventListener('render-process-gone', signalLost);
    announcer.start();
    return () => {
      webview.removeEventListener('did-attach', signalReady);
      webview.removeEventListener('dom-ready', signalReady);
      webview.removeEventListener('destroyed', signalLost);
      webview.removeEventListener('render-process-gone', signalLost);
      announcer.dispose();
    };
  }, [active, browserContextId, browserControlEpoch, previewReaderId]);

  // Navigate to new URL (add to history)
  const navigateToWithHistory = useCallback(
    (targetUrl: string) => {
      const webviewEl = webviewRef.current;
      if (!webviewEl || !targetUrl) return;
      if (targetUrl === currentUrl) return;

      if (currentUrl) {
        historyBackRef.current.push(currentUrl);
      }
      historyForwardRef.current = [];

      currentUrlRef.current = targetUrl;
      setCurrentUrl(targetUrl);
      setInputUrl(inputValueForUrl(targetUrl));
      setCanGoBack(historyBackRef.current.length > 0);
      setCanGoForward(false);
      publishNavigationState(targetUrl);

      webviewEl.src = targetUrl;
    },
    [currentUrl, publishNavigationState]
  );

  // Webview event listeners
  useEffect(() => {
    const webviewEl = webviewRef.current;
    if (!webviewEl) return;

    const handleStartLoading = () => setIsLoading(true);
    const handleStopLoading = () => {
      setIsLoading(false);
    };

    // Inject script to intercept links / window.open / form submissions
    const injectClickInterceptor = () => {
      webviewEl
        .executeJavaScript(
          `
        (function() {
          if (window.__webviewHostInjected) return;
          window.__webviewHostInjected = true;

          document.addEventListener('click', function(e) {
            let target = e.target;
            while (target && target.tagName !== 'A') {
              target = target.parentElement;
            }
            if (target && target.tagName === 'A') {
              const href = target.href;
              if (href && /^https?:/i.test(href)) {
                e.preventDefault();
                e.stopPropagation();
                window.postMessage({ type: '__WEBVIEW_HOST_NAVIGATE__', url: href }, '*');
              }
            }
          }, true);

          const originalOpen = window.open;
          window.open = function(url) {
            if (url && /^https?:/i.test(url)) {
              window.postMessage({ type: '__WEBVIEW_HOST_NAVIGATE__', url: url }, '*');
              return null;
            }
            return originalOpen.apply(this, arguments);
          };

          document.addEventListener('submit', function(e) {
            const form = e.target;
            if (form && form.action && /^https?:/i.test(form.action)) {
              e.preventDefault();
              window.postMessage({ type: '__WEBVIEW_HOST_NAVIGATE__', url: form.action }, '*');
            }
          }, true);
        })();
        true;
      `
        )
        .catch(() => {});
    };

    const handleConsoleMessage = (event: Electron.ConsoleMessageEvent) => {
      try {
        if (event.message.includes('__WEBVIEW_HOST_NAVIGATE__')) {
          const match = event.message.match(/"url":"([^"]+)"/);
          if (match && match[1]) {
            navigateToWithHistory(match[1]);
          }
          return;
        }

        if (event.message.includes('__AIONUI_WEBVIEW_ZOOM__')) {
          const match = event.message.match(/"deltaY":(-?\d+(\.\d+)?)/);
          if (match && match[1]) {
            const deltaY = Number(match[1]);
            const step = deltaY < 0 ? 0.08 : -0.08;
            setZoomFactor((prev) => {
              const next = Number((prev + step).toFixed(2));
              return Math.max(MIN_ZOOM_FACTOR, Math.min(MAX_ZOOM_FACTOR, next));
            });
          }
          return;
        }

        if (event.message.includes('__AIONUI_WEBVIEW_ZOOM_RESET__')) {
          setZoomFactor(1);
        }
      } catch {
        // Ignore parse errors
      }
    };

    const handleDidNavigate = (event: Event & { url?: string }) => {
      const newUrl = (event as any).url;
      if (newUrl && newUrl !== currentUrl) {
        currentUrlRef.current = newUrl;
        setCurrentUrl(newUrl);
        setInputUrl(inputValueForUrl(newUrl));
        publishNavigationState(newUrl);
      }
    };

    const handleDomReady = () => {
      setWebviewReady(true);
      injectClickInterceptor();

      // Inject viewport meta for responsive pages
      webviewEl
        .executeJavaScript(
          `
        (function() {
          let viewport = document.querySelector('meta[name="viewport"]');
          if (!viewport) {
            viewport = document.createElement('meta');
            viewport.name = 'viewport';
            viewport.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
            document.head.appendChild(viewport);
          }
        })();
        true;
      `
        )
        .catch(() => {});

      // Set up message listener inside webview
      webviewEl
        .executeJavaScript(
          `
        window.addEventListener('message', function(e) {
          if (e.data && e.data.type === '__WEBVIEW_HOST_NAVIGATE__') {
            console.log('__WEBVIEW_HOST_NAVIGATE__', JSON.stringify(e.data));
          }
        });
        true;
      `
        )
        .catch(() => {});

      if (isStarOfficeUrl(currentUrl)) {
        webviewEl
          .executeJavaScript(
            `
          (function() {
            if (window.__aionuiZoomInjected) return true;
            window.__aionuiZoomInjected = true;
            window.addEventListener('wheel', function(e) {
              if (!(e.ctrlKey || e.metaKey)) return;
              e.preventDefault();
              console.log('__AIONUI_WEBVIEW_ZOOM__', JSON.stringify({ deltaY: e.deltaY }));
            }, { passive: false, capture: true });
            window.addEventListener('keydown', function(e) {
              if (!(e.ctrlKey || e.metaKey)) return;
              if (e.key === '0') {
                e.preventDefault();
                console.log('__AIONUI_WEBVIEW_ZOOM_RESET__');
              }
            }, { capture: true });
            return true;
          })();
          true;
        `
          )
          .catch(() => {});
      }

      if (isStarOfficeUrl(currentUrl) && autoFitPendingRef.current) {
        window.setTimeout(() => {
          const currentWebview = webviewRef.current;
          const currentContent = contentRef.current;
          if (!currentWebview || !currentContent) return;
          void currentWebview
            .executeJavaScript(
              `
            (() => {
              try {
                const stage = document.getElementById('main-stage');
                const body = document.body;
                const doc = document.documentElement;
                const width = Math.max(stage?.scrollWidth || 0, body?.scrollWidth || 0, doc?.scrollWidth || 0, window.innerWidth || 0);
                return { width };
              } catch (e) {
                return { width: window.innerWidth || 0 };
              }
            })();
          `
            )
            .then((result: any) => {
              const stageWidth = Number(result?.width || 0);
              if (!stageWidth) return;
              const next = Number((currentContent.clientWidth / stageWidth).toFixed(2));
              setZoomFactor(Math.max(MIN_ZOOM_FACTOR, Math.min(MAX_ZOOM_FACTOR, next)));
              autoFitPendingRef.current = false;
            })
            .catch(() => {});
        }, 120);
      }
    };

    const handleDidFinishLoad = () => {
      setIsLoading(false);
      onDidFinishLoad?.();
    };

    const handleDidFailLoad = (event: any) => {
      setIsLoading(false);
      onDidFailLoad?.(event.errorCode, event.errorDescription);
    };

    webviewEl.addEventListener('did-start-loading', handleStartLoading);
    webviewEl.addEventListener('did-stop-loading', handleStopLoading);
    webviewEl.addEventListener('dom-ready', handleDomReady);
    webviewEl.addEventListener('did-navigate', handleDidNavigate as EventListener);
    webviewEl.addEventListener('did-navigate-in-page', handleDidNavigate as EventListener);
    webviewEl.addEventListener('console-message', handleConsoleMessage as EventListener);
    webviewEl.addEventListener('did-finish-load', handleDidFinishLoad);
    webviewEl.addEventListener('did-fail-load', handleDidFailLoad as EventListener);

    return () => {
      webviewEl.removeEventListener('did-start-loading', handleStartLoading);
      webviewEl.removeEventListener('did-stop-loading', handleStopLoading);
      webviewEl.removeEventListener('dom-ready', handleDomReady);
      webviewEl.removeEventListener('did-navigate', handleDidNavigate as EventListener);
      webviewEl.removeEventListener('did-navigate-in-page', handleDidNavigate as EventListener);
      webviewEl.removeEventListener('console-message', handleConsoleMessage as EventListener);
      webviewEl.removeEventListener('did-finish-load', handleDidFinishLoad);
      webviewEl.removeEventListener('did-fail-load', handleDidFailLoad as EventListener);
    };
  }, [navigateToWithHistory, currentUrl, onDidFinishLoad, onDidFailLoad, isStarOfficeUrl, publishNavigationState]);

  // Resize observer for content area
  useEffect(() => {
    const contentEl = contentRef.current;
    const webviewEl = webviewRef.current;
    if (!contentEl || !webviewEl) return;

    const resize = () => {
      const contentRect = contentEl.getBoundingClientRect();
      if (contentRect.width > 0 && contentRect.height > 0) {
        webviewEl.style.width = `${contentRect.width}px`;
        webviewEl.style.height = `${contentRect.height}px`;
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(contentEl);

    return () => observer.disconnect();
  }, []);

  const handleZoomReset = useCallback(() => {
    if (!isStarOffice) return;
    setZoomFactor(1);
  }, [isStarOffice]);

  const handleZoomFit = useCallback(() => {
    const currentWebview = webviewRef.current;
    const currentContent = contentRef.current;
    if (!isStarOffice || !currentWebview || !currentContent) return;
    void currentWebview
      .executeJavaScript(
        `
      (() => {
        try {
          const stage = document.getElementById('main-stage');
          const body = document.body;
          const doc = document.documentElement;
          const width = Math.max(stage?.scrollWidth || 0, body?.scrollWidth || 0, doc?.scrollWidth || 0, window.innerWidth || 0);
          return { width };
        } catch (e) {
          return { width: window.innerWidth || 0 };
        }
      })();
    `
      )
      .then((result: any) => {
        const stageWidth = Number(result?.width || 0);
        if (!stageWidth) return;
        const next = Number((currentContent.clientWidth / stageWidth).toFixed(2));
        setZoomFactor(Math.max(MIN_ZOOM_FACTOR, Math.min(MAX_ZOOM_FACTOR, next)));
      })
      .catch(() => {});
  }, [isStarOffice]);

  const handleOuterWheelZoom = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!isStarOffice) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const step = event.deltaY < 0 ? 0.08 : -0.08;
      setZoomFactor((prev) => {
        const next = Number((prev + step).toFixed(2));
        return Math.max(MIN_ZOOM_FACTOR, Math.min(MAX_ZOOM_FACTOR, next));
      });
    },
    [isStarOffice]
  );

  // Back
  const handleGoBack = useCallback(() => {
    if (historyBackRef.current.length === 0) return;
    const prevUrl = historyBackRef.current.pop()!;
    historyForwardRef.current.push(currentUrl);
    setCanGoBack(historyBackRef.current.length > 0);
    setCanGoForward(true);
    currentUrlRef.current = prevUrl;
    setCurrentUrl(prevUrl);
    setInputUrl(inputValueForUrl(prevUrl));
    publishNavigationState(prevUrl);
    if (webviewRef.current) webviewRef.current.src = prevUrl;
  }, [currentUrl, publishNavigationState]);

  // Forward
  const handleGoForward = useCallback(() => {
    if (historyForwardRef.current.length === 0) return;
    const nextUrl = historyForwardRef.current.pop()!;
    historyBackRef.current.push(currentUrl);
    setCanGoBack(true);
    setCanGoForward(historyForwardRef.current.length > 0);
    currentUrlRef.current = nextUrl;
    setCurrentUrl(nextUrl);
    setInputUrl(inputValueForUrl(nextUrl));
    publishNavigationState(nextUrl);
    if (webviewRef.current) webviewRef.current.src = nextUrl;
  }, [currentUrl, publishNavigationState]);

  // Refresh
  const handleRefresh = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  // URL bar submit
  const handleUrlSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      let targetUrl = inputUrl.trim();
      if (!targetUrl) return;
      if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = 'https://' + targetUrl;
      }
      navigateToWithHistory(targetUrl);
    },
    [inputUrl, navigateToWithHistory]
  );

  const handleUrlKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        setInputUrl(inputValueForUrl(currentUrl));
        (e.target as HTMLInputElement).blur();
      }
    },
    [currentUrl]
  );

  // Build webview attributes
  const webviewAttrs: Record<string, string> = {
    webpreferences:
      'contextIsolation=yes, nodeIntegration=no, nodeIntegrationInSubFrames=no, sandbox=yes, webSecurity=yes, nativeWindowOpen=no',
  };
  if (partition) {
    webviewAttrs.partition = partition;
  }

  return (
    <div ref={containerRef} className={`h-full w-full min-w-0 flex flex-col ${className ?? ''}`} style={style}>
      {showNavBar && (
        <style>
          {`
            .aion-url-viewer-toolbar {
              --viewer-border: var(--color-border-2);
              --viewer-border-hover: var(--color-border-3);
              --viewer-bg: var(--color-bg-3);
              --viewer-bg-hover: var(--color-fill-2);
              --viewer-text: var(--color-text-2);
              --viewer-text-muted: var(--color-text-3);
              box-sizing: border-box;
              width: 100%;
              min-width: 0;
              overflow: hidden;
            }
            .aion-url-viewer-toolbar .toolbar-btn {
              -webkit-appearance: none;
              appearance: none;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              height: 30px;
              min-width: 30px;
              padding: 0 10px;
              border-radius: 10px;
              border: 1px solid var(--viewer-border);
              background: var(--viewer-bg);
              color: var(--viewer-text);
              line-height: 1;
              font-size: 12px;
              transition:
                background-color var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-standard, ease),
                border-color var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-standard, ease),
                color var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-standard, ease),
                box-shadow var(--eve-motion-duration-state, 400ms) var(--eve-motion-ease-standard, ease),
                transform var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-standard, ease);
              cursor: pointer;
            }
            .aion-url-viewer-toolbar .toolbar-btn.icon-btn {
              width: 30px;
              min-width: 30px;
              padding: 0;
            }
            .aion-url-viewer-toolbar .toolbar-btn:hover:not(:disabled) {
              background: var(--viewer-bg-hover);
              border-color: var(--viewer-border-hover);
            }
            .aion-url-viewer-toolbar .toolbar-btn:active:not(:disabled) {
              transform: translateY(0.5px);
            }
            .aion-url-viewer-toolbar .toolbar-btn:focus-visible {
              outline: none;
              border-color: rgb(var(--primary-6));
              box-shadow: 0 0 0 2px rgba(var(--primary-6), 0.12);
            }
            .aion-url-viewer-toolbar .toolbar-btn:disabled {
              opacity: 0.55;
              cursor: not-allowed;
              color: var(--viewer-text-muted);
              background: var(--color-bg-2);
            }
            .aion-url-viewer-toolbar .toolbar-chip {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              height: 30px;
              min-width: 48px;
              padding: 0 10px;
              border-radius: 10px;
              border: 1px solid var(--viewer-border);
              background: var(--color-bg-2);
              color: var(--viewer-text-muted);
              font-size: 11px;
              line-height: 1;
            }
            .aion-url-viewer-toolbar .toolbar-input {
              -webkit-appearance: none;
              appearance: none;
              box-sizing: border-box;
              display: block;
              flex: 1 1 auto;
              width: 100%;
              max-width: none;
              min-width: 0;
              height: 30px;
              padding: 0 12px;
              border-radius: 10px;
              border: 1px solid var(--viewer-border);
              background: var(--viewer-bg);
              color: var(--color-text-1);
              font-size: 12px;
              line-height: 30px;
              transition:
                background-color var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-standard, ease),
                border-color var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-standard, ease),
                color var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-standard, ease),
                box-shadow var(--eve-motion-duration-state, 400ms) var(--eve-motion-ease-standard, ease);
            }
            .aion-url-viewer-toolbar .toolbar-input::placeholder {
              color: var(--viewer-text-muted);
              opacity: 0.84;
            }
            .aion-url-viewer-toolbar .toolbar-form {
              display: flex;
              flex: 1 1 auto;
              align-items: center;
              align-self: stretch;
              width: auto;
              max-width: none;
              min-width: 0;
              margin-left: 2px;
            }
            .aion-url-viewer-toolbar .toolbar-input:hover {
              border-color: var(--viewer-border-hover);
            }
            .aion-url-viewer-toolbar .toolbar-input:focus {
              outline: none;
              border-color: rgb(var(--primary-6));
              box-shadow: 0 0 0 2px rgba(var(--primary-6), 0.12);
            }
            .aion-url-viewer-toolbar.aion-url-viewer-toolbar--workbench {
              height: 44px;
              padding: 0 12px;
              gap: 4px;
              border-bottom: 1px solid var(--glass-chrome-border, var(--color-border-2));
              background: var(--glass-chrome-bg, var(--bg-2));
              box-shadow: inset 0 -1px 0 var(--glass-edge-highlight, transparent);
              -webkit-backdrop-filter: var(--glass-chrome-filter, blur(20px) saturate(150%));
              backdrop-filter: var(--glass-chrome-filter, blur(20px) saturate(150%));
            }
            .aion-url-viewer-toolbar--workbench .toolbar-btn {
              width: 32px;
              min-width: 32px;
              height: 32px;
              padding: 0;
              border: 0;
              border-radius: 9px;
              background: transparent;
              transition:
                background-color var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-standard, ease),
                color var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-standard, ease);
            }
            .aion-url-viewer-toolbar--workbench .toolbar-btn:hover:not(:disabled) {
              border-color: transparent;
              background: var(--eve-row-hover-bg, var(--color-fill-2));
            }
            .aion-url-viewer-toolbar--workbench .toolbar-btn:focus-visible {
              border-color: transparent;
              outline: 2px solid var(--eve-focus-ring, var(--color-primary-6));
              outline-offset: -2px;
              box-shadow: none;
            }
            .aion-url-viewer-toolbar--workbench .toolbar-input {
              height: 32px;
              padding: 0 13px;
              border: 0;
              border-radius: 10px;
              background: color-mix(in srgb, var(--glass-panel-bg, var(--bg-2)) 88%, transparent);
              box-shadow: inset 0 0 0 1px var(--glass-panel-border, var(--color-border-2));
              font-size: 13px;
              line-height: 32px;
              transition:
                box-shadow var(--eve-motion-duration-state, 400ms) var(--eve-motion-ease-standard, ease),
                background-color var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-standard, ease);
            }
            .aion-url-viewer-toolbar--workbench .toolbar-input:hover {
              border-color: transparent;
              background: color-mix(in srgb, var(--glass-panel-bg, var(--bg-2)) 96%, transparent);
            }
            .aion-url-viewer-toolbar--workbench .toolbar-input:focus {
              border-color: transparent;
              outline: none;
              box-shadow:
                inset 0 0 0 1px var(--eve-focus-ring, var(--color-primary-6)),
                0 0 0 2px color-mix(in srgb, var(--eve-focus-ring, var(--color-primary-6)) 13%, transparent);
            }
            .aion-url-viewer-toolbar-actions {
              display: inline-flex;
              align-items: center;
              flex: 0 0 auto;
              margin-left: 6px;
            }
            @media (prefers-reduced-motion: reduce) {
              .aion-url-viewer-toolbar--workbench .toolbar-btn,
              .aion-url-viewer-toolbar--workbench .toolbar-input {
                transition: none;
              }
            }
          `}
        </style>
      )}
      {/* Navigation bar (optional) */}
      {showNavBar && (
        <div
          className={`aion-url-viewer-toolbar flex items-center gap-6px h-40px px-10px bg-bg-2 border-b border-border-1 flex-shrink-0 ${COMMAND_EVE_SHELL_ENABLED ? 'aion-url-viewer-toolbar--workbench' : ''}`}
          style={{ display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 }}
        >
          <button
            type='button'
            onClick={handleGoBack}
            disabled={!canGoBack}
            className='toolbar-btn icon-btn'
            title='Back'
            aria-label={t('common.historyBack')}
          >
            <Left size={16} />
          </button>
          <button
            type='button'
            onClick={handleGoForward}
            disabled={!canGoForward}
            className='toolbar-btn icon-btn'
            title='Forward'
            aria-label={t('common.forward')}
          >
            <Right size={16} />
          </button>
          <button
            type='button'
            onClick={handleRefresh}
            className='toolbar-btn icon-btn'
            title='Refresh'
            aria-label={t('common.refresh')}
          >
            {isLoading ? <Loading size={16} className='animate-spin' /> : <Refresh size={16} />}
          </button>
          {isStarOffice && (
            <div className='flex items-center gap-6px ml-2px'>
              <button type='button' onClick={handleZoomReset} className='toolbar-btn' title='Reset zoom'>
                100%
              </button>
              <button type='button' onClick={handleZoomFit} className='toolbar-btn' title='Fit'>
                Fit
              </button>
              <span className='toolbar-chip'>{Math.round(zoomFactor * 100)}%</span>
            </div>
          )}
          <form
            onSubmit={handleUrlSubmit}
            className='toolbar-form'
            style={{ display: 'flex', flex: '1 1 auto', width: 'auto', minWidth: 0, maxWidth: 'none' }}
          >
            <input
              type='text'
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onKeyDown={handleUrlKeyDown}
              onFocus={(e) => e.target.select()}
              className='toolbar-input'
              style={{ display: 'block', flex: '1 1 auto', width: '100%', minWidth: 0, maxWidth: 'none' }}
              aria-label={
                COMMAND_EVE_SHELL_ENABLED ? t('conversation.workbench.addressPlaceholder') : 'Enter URL or search'
              }
              placeholder={COMMAND_EVE_SHELL_ENABLED ? t('conversation.workbench.addressPlaceholder') : 'Enter URL...'}
            />
          </form>
          {toolbarActions && <div className='aion-url-viewer-toolbar-actions'>{toolbarActions}</div>}
        </div>
      )}

      {/* Loading indicator (when no nav bar) */}
      {!showNavBar && isLoading && (
        <div className='absolute inset-0 flex items-center justify-center text-t-secondary text-14px z-10 pointer-events-none'>
          <span className='animate-pulse'>Loading…</span>
        </div>
      )}

      {/* Webview content area */}
      <div
        ref={contentRef}
        className='flex-1 overflow-hidden relative'
        style={{ minHeight: 0 }}
        onWheel={handleOuterWheelZoom}
      >
        <webview
          ref={webviewRef as any}
          src={currentUrl}
          className='border-0 absolute left-0 top-0'
          style={{
            opacity: !showNavBar && isLoading ? 0 : 1,
            transition: 'opacity var(--eve-motion-duration-feedback, 300ms) var(--eve-motion-ease-enter, ease-in)',
            width: '100%',
            height: '100%',
          }}
          {...webviewAttrs}
        />
      </div>
    </div>
  );
};

export default WebviewHost;
