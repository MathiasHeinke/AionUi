import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import AcpRuntimeStatus from '@/renderer/pages/conversation/platforms/acp/AcpRuntimeStatus';

vi.mock('@/renderer/hooks/config/useConfig', () => ({ useConfig: () => [true] }));
vi.mock('@/renderer/hooks/useIsDevMode', () => ({ useIsDevMode: () => false }));
vi.mock('@/renderer/hooks/agent/useEveInferenceSelection', () => ({
  useEveInferenceSelection: () => ({
    selection: 'command-eve-inference:eve-high',
    selectedItem: { group: 'eve', label: 'Hoch' },
    // Bearer presence loads asynchronously. The selected cloud lane must still
    // render its 256k policy while this value is temporarily unknown.
    cloudBearerAvailable: undefined,
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; tool?: string; used?: string; size?: string }) =>
      key === 'conversation.runtimeStatus.context'
        ? `Kontext ${options?.used}/${options?.size}`
        : key === 'conversation.runtimeStatus.toolDetail'
          ? `Tool: ${options?.tool}`
          : (options?.defaultValue ?? key.split('.').at(-1) ?? key),
  }),
}));

describe('AcpRuntimeStatus operator visibility', () => {
  it('shows a redacted production phase while a model turn is active', () => {
    render(
      <AcpRuntimeStatus
        activity={{ phase: 'thinking', backend: 'hermes', modelId: 'secret-model-id', updatedAt: Date.now() }}
        running
        aiProcessing
      />
    );

    expect(screen.getByTestId('acp-runtime-status')).toHaveTextContent('thinking');
    expect(screen.queryByText(/secret-model-id|hermes/)).toBeNull();
    expect(screen.queryByText('Logs')).toBeNull();
  });

  it('surfaces the active tool title without exposing backend diagnostics', () => {
    render(
      <AcpRuntimeStatus
        activity={{ phase: 'tool_wait', detail: 'PDF lesen', updatedAt: Date.now() }}
        running
        aiProcessing={false}
      />
    );
    expect(screen.getByTestId('acp-runtime-status')).toHaveTextContent('Tool: PDF lesen');
  });

  it('stays absent for an idle production conversation', () => {
    render(
      <AcpRuntimeStatus activity={{ phase: 'idle', updatedAt: Date.now() }} running={false} aiProcessing={false} />
    );
    expect(screen.queryByTestId('acp-runtime-status')).toBeNull();
  });

  it('shows the 256k EVE cloud policy instead of Hermes local 64k telemetry', () => {
    render(
      <AcpRuntimeStatus
        backend='hermes'
        activity={{
          phase: 'streaming',
          modelId: 'custom:command-eve-gemma4-e4b-64k:latest',
          contextUsed: 69_300,
          contextSize: 65_536,
          updatedAt: Date.now(),
        }}
        running
        aiProcessing
      />
    );

    expect(screen.getByTestId('acp-runtime-status')).toHaveTextContent('Kontext 69.3k/256k');
  });
});
