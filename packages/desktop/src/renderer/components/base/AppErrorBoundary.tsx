/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Command } from '@renderer/components/icons';

interface AppErrorBoundaryState {
  error: Error | null;
}

/**
 * Global render-error boundary.
 *
 * Before this existed, ANY unhandled throw in a component's render unmounted the
 * whole React tree → a blank white window the user had to force-restart (this is
 * what the missing settings-nav key did: one TypeError white-screened everything).
 * Now a localized render error degrades to a recoverable card with the chrome gone
 * but the app re-enterable.
 *
 * DSGVO-safe: the fallback shows only `error.message`, never a PII / state dump.
 * Self-contained inline styles so it renders even if theme/CSS context is the thing
 * that failed.
 */
export class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Message + component stack only — never serialize props/state (may hold PII).
    // eslint-disable-next-line no-console
    console.error('[AppErrorBoundary] render error:', error?.message, info?.componentStack);
  }

  private handleBackToEve = (): void => {
    try {
      window.location.hash = '#/guid';
    } catch {
      /* noop */
    }
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b1220',
          color: '#e6edf6',
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: 24,
        }}
      >
        <div
          style={{
            width: 'min(100%, 440px)',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 18,
            background: 'rgba(13,21,38,0.7)',
            padding: '28px 26px',
            boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>
            <Command
              size={20}
              aria-hidden='true'
              style={{ color: '#f97316', marginRight: 7, verticalAlign: '-0.12em' }}
            />
            Etwas ist schiefgelaufen
          </div>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: '#9fb0c4', margin: '0 0 18px' }}>
            EVE konnte diese Ansicht nicht laden. Deine Daten sind sicher — geh zurück oder lade neu.
          </p>
          <pre
            style={{
              fontSize: 12,
              color: '#fda4a4',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 10,
              padding: '10px 12px',
              overflow: 'auto',
              maxHeight: 120,
              margin: '0 0 18px',
              whiteSpace: 'pre-wrap',
            }}
          >
            {String(error.message || error)}
          </pre>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              type='button'
              onClick={this.handleBackToEve}
              style={{
                flex: 1,
                padding: '10px 14px',
                borderRadius: 999,
                border: 'none',
                background: 'linear-gradient(180deg,#fb923c,#f97316)',
                color: '#fff',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Zurück zu EVE
            </button>
            <button
              type='button'
              onClick={this.handleReload}
              style={{
                flex: 1,
                padding: '10px 14px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.18)',
                background: 'rgba(255,255,255,0.06)',
                color: '#e6edf6',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              Neu laden
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default AppErrorBoundary;
