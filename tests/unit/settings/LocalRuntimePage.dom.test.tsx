/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { localRuntimeInvokeMock, kanbanInvokeMock, buildProviderMock } = vi.hoisted(() => {
  const localRuntimeInvoke = vi.fn();
  const kanbanInvoke = vi.fn();
  const buildProvider = vi.fn((channel: string) => ({
    invoke: channel === 'command-eve.local-runtime-status' ? localRuntimeInvoke : kanbanInvoke,
  }));
  return {
    localRuntimeInvokeMock: localRuntimeInvoke,
    kanbanInvokeMock: kanbanInvoke,
    buildProviderMock: buildProvider,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'de' },
  }),
}));

vi.mock('@office-ai/platform', () => ({
  bridge: { buildProvider: buildProviderMock },
}));

vi.mock('@renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@renderer/hooks/useCommandEveFounderBuild', () => ({
  useCommandEveFounderBuild: () => ({ loading: false, founderBuild: false }),
}));

vi.mock('@renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
}));

vi.mock('@arco-design/web-react', () => ({
  Alert: ({ title, content }: { title?: React.ReactNode; content?: React.ReactNode }) => (
    <div>
      {title}
      {content}
    </div>
  ),
  Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button type='button' onClick={onClick}>
      {children}
    </button>
  ),
  Empty: ({ description }: { description?: React.ReactNode }) => <div>{description}</div>,
  Spin: () => <div data-testid='spin' />,
  Tag: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

import LocalRuntimePage from '@/renderer/pages/localRuntime';

const runtimeResult = {
  version: 'command-eve-local-runtime-status/v0' as const,
  ok: true,
  status: 'ready' as const,
  source: { generated_by: 'command-eve-local-runtime-status-core' as const },
  model: {
    schema_version: 'command-eve-local-runtime-status/v0' as const,
    generated_at: '2026-07-10T12:00:00.000Z',
    read_only: true as const,
    release: 'command-eve-1.8.0',
    hermes: { package: 'INTERNAL-HERMES-PACKAGE', version: '9.9.9' },
    provider: {
      type: 'ollama' as const,
      base_url: 'http://127.0.0.1:11434/private',
      egress_proxy_url: 'http://127.0.0.1:25811/private',
    },
    selected_tier_id: 'standard',
    selected_model_ref: 'internal/model:secret',
    receipt: {
      path: '/private/runtime-receipt.json',
      status: 'ready' as const,
      default_model: 'internal/model:secret',
      base_model: 'internal/base:secret',
      next_action: 'run-internal-command',
      completed_at: '2026-07-10T12:00:00.000Z',
    },
    model_warmup: {
      path: '/private/warmup.json',
      status: 'ready' as const,
      model: 'internal/model:secret',
      base_url: 'http://127.0.0.1:11434/private',
      started_at: '2026-07-10T11:59:00.000Z',
      completed_at: '2026-07-10T12:00:00.000Z',
      elapsed_ms: 60_000,
    },
    tiers: [
      {
        id: 'standard',
        label: 'INTERNAL TIER LABEL',
        model_ref: 'internal/model:secret',
        runtime_model_ref: 'internal/runtime:secret',
        context_length: 32_768,
        max_tokens: 8_192,
        min_unified_memory_gb: 16,
        min_free_disk_gb: 20,
        status: 'selected' as const,
      },
    ],
    warnings: [],
  },
};

beforeEach(() => {
  localRuntimeInvokeMock.mockResolvedValue({ success: true, data: runtimeResult });
  kanbanInvokeMock.mockResolvedValue({
    success: true,
    data: {
      version: 'command-eve-kanban-preflight/v0',
      ok: true,
      status: 'ready',
      source: { generated_by: 'command-eve-kanban-preflight-core' },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LocalRuntimePage public shell', () => {
  it('renders public runtime truth without founder-only implementation details', async () => {
    render(
      <React.StrictMode>
        <LocalRuntimePage />
      </React.StrictMode>
    );

    await screen.findByText('command-eve-1.8.0');
    expect(screen.getByText('localRuntime.values.managedByEve')).toBeTruthy();

    await waitFor(() => expect(localRuntimeInvokeMock).toHaveBeenCalled());
    const rendered = document.body.textContent || '';
    expect(rendered).not.toContain('INTERNAL-HERMES-PACKAGE');
    expect(rendered).not.toContain('INTERNAL TIER LABEL');
    expect(rendered).not.toContain('internal/model:secret');
    expect(rendered).not.toContain('internal/runtime:secret');
    expect(rendered).not.toContain('http://127.0.0.1:11434/private');
    expect(rendered).not.toContain('http://127.0.0.1:25811/private');
    expect(rendered).not.toContain('/private/runtime-receipt.json');
    expect(rendered).not.toContain('/private/warmup.json');
    expect(rendered).not.toContain('run-internal-command');
  });
});
