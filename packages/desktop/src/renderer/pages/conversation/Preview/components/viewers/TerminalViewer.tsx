/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  CommandEveTerminalDataEvent,
  CommandEveTerminalExitEvent,
  CommandEveTerminalStartRequest,
  CommandEveTerminalStartResult,
} from '@/common/config/commandEveTerminalChannels';
import { useThemeDetection } from '../../hooks';
import { readXtermBuffer, registerConversationTerminalReader } from '../../services/terminalReader';
import { createTerminalStartupEventBuffer } from '../../services/terminalStartupEvents';
import styles from './TerminalViewer.module.css';
import { resolveTerminalTheme } from './terminalTheme';

type CommandEveTerminalRendererBridge = {
  start: (request: CommandEveTerminalStartRequest) => Promise<CommandEveTerminalStartResult>;
  write: (terminalId: string, data: string) => Promise<boolean>;
  resize: (terminalId: string, cols: number, rows: number) => Promise<boolean>;
  close: (terminalId: string) => Promise<boolean>;
  onData: (callback: (event: CommandEveTerminalDataEvent) => void) => () => void;
  onExit: (callback: (event: CommandEveTerminalExitEvent) => void) => () => void;
};

const resolveTerminalBridge = (): CommandEveTerminalRendererBridge | null => {
  if (typeof window === 'undefined') return null;
  const host = window as unknown as { electronAPI?: { terminal?: CommandEveTerminalRendererBridge } };
  return host.electronAPI?.terminal ?? null;
};

type TerminalViewerProps = {
  tabId: string;
  conversationId: string;
  cwd?: string;
  active: boolean;
};

const TerminalViewer: React.FC<TerminalViewerProps> = ({ tabId, conversationId, cwd, active }) => {
  const { t } = useTranslation();
  const currentTheme = useThemeDetection();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const activeRef = useRef(active);
  const tRef = useRef(t);
  const [resolvedCwd, setResolvedCwd] = useState(cwd || '');
  const [status, setStatus] = useState<'starting' | 'ready' | 'closed' | 'error'>('starting');

  useEffect(() => {
    activeRef.current = active;
    if (!active) return;
    window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    });
  }, [active]);

  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = resolveTerminalTheme(currentTheme);
  }, [currentTheme]);

  useEffect(() => {
    const bridge = resolveTerminalBridge();
    const container = containerRef.current;
    if (!bridge || !container) {
      setStatus('error');
      return undefined;
    }

    let disposed = false;
    const fitAddon = new FitAddon();
    const terminal = new XtermTerminal({
      allowProposedApi: false,
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      fontWeight: 450,
      fontWeightBold: 650,
      letterSpacing: 0.1,
      lineHeight: 1.35,
      screenReaderMode: true,
      scrollback: 5000,
      theme: resolveTerminalTheme(currentTheme),
    });
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    const unregisterReader = registerConversationTerminalReader(conversationId, tabId, (options) =>
      readXtermBuffer(terminal, options)
    );
    const startupEvents = createTerminalStartupEventBuffer();

    const showExit = (event: CommandEveTerminalExitEvent): void => {
      terminal.writeln(
        `\r\n\x1b[90m[${tRef.current('conversation.workbench.terminalClosed')} ${event.exitCode}]\x1b[0m`
      );
      setStatus('closed');
      terminalIdRef.current = null;
    };

    const offData = bridge.onData((event) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) {
        startupEvents.pushData(event);
        return;
      }
      if (event.terminalId === terminalId) terminal.write(event.data);
    });
    const offExit = bridge.onExit((event) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) {
        startupEvents.pushExit(event);
        return;
      }
      if (event.terminalId === terminalId) showExit(event);
    });
    const inputDisposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (terminalId) void bridge.write(terminalId, data).catch(() => setStatus('error'));
    });
    const resizeObserver = new ResizeObserver(() => {
      if (!activeRef.current) return;
      window.requestAnimationFrame(() => {
        if (disposed) return;
        fitAddon.fit();
        const terminalId = terminalIdRef.current;
        if (terminalId) void bridge.resize(terminalId, terminal.cols, terminal.rows).catch(() => setStatus('error'));
      });
    });
    resizeObserver.observe(container);

    window.requestAnimationFrame(() => {
      if (disposed) return;
      fitAddon.fit();
      void bridge
        .start({ cwd, cols: terminal.cols, rows: terminal.rows })
        .then((result) => {
          if (disposed) {
            void bridge.close(result.terminalId).catch((): void => undefined);
            return;
          }
          terminalIdRef.current = result.terminalId;
          for (const startupEvent of startupEvents.drain(result.terminalId)) {
            if (startupEvent.kind === 'data') terminal.write(startupEvent.event.data);
            else showExit(startupEvent.event);
          }
          setResolvedCwd(result.cwd);
          if (terminalIdRef.current) setStatus('ready');
          if (activeRef.current) terminal.focus();
        })
        .catch((error: unknown) => {
          startupEvents.clear();
          terminal.writeln(`\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`);
          setStatus('error');
        });
    });

    return () => {
      disposed = true;
      startupEvents.clear();
      resizeObserver.disconnect();
      inputDisposable.dispose();
      unregisterReader();
      offData();
      offExit();
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      if (terminalId) void bridge.close(terminalId).catch((): void => undefined);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [conversationId, cwd, tabId]);

  const statusLabel = t(`conversation.workbench.terminalStatus.${status}`);

  return (
    <section
      className={styles.root}
      aria-label={t('conversation.workbench.terminal')}
      data-terminal-status={status}
      data-terminal-theme={currentTheme}
    >
      <div className={styles.meta}>
        <span className={styles.statusDot} aria-hidden='true' />
        <span className={styles.statusLabel} aria-live='polite'>
          {statusLabel}
        </span>
        <span className={styles.cwd} title={resolvedCwd}>
          {resolvedCwd}
        </span>
      </div>
      <div
        ref={containerRef}
        className={styles.viewport}
        data-testid={`eve-terminal-${tabId}`}
        aria-label={t('conversation.workbench.terminalViewport')}
      />
    </section>
  );
};

export default TerminalViewer;
