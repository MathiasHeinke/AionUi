import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import AcpRuntimeStatus from '@/renderer/pages/conversation/platforms/acp/AcpRuntimeStatus';

const { useIsDevModeMock, eveSelectionMock } = vi.hoisted(() => ({
  useIsDevModeMock: vi.fn(() => false),
  eveSelectionMock: vi.fn(() => ({
    selection: 'command-eve-inference:eve-high',
    selectedItem: { group: 'eve', label: 'Hoch' },
    cloudBearerAvailable: undefined,
  })),
}));

vi.mock('@/renderer/hooks/config/useConfig', () => ({ useConfig: () => [true] }));
vi.mock('@/renderer/hooks/useIsDevMode', () => ({ useIsDevMode: useIsDevModeMock }));
vi.mock('@/renderer/hooks/agent/useEveInferenceSelection', () => ({
  // Bearer presence loads asynchronously. The selected cloud lane must still
  // render its 256k policy while this value is temporarily unknown.
  useEveInferenceSelection: eveSelectionMock,
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
    expect(document.querySelector('.acp-runtime-status__spinner--active')).toBeNull();
  });

  it('stays absent for an idle production conversation', () => {
    render(
      <AcpRuntimeStatus activity={{ phase: 'idle', updatedAt: Date.now() }} running={false} aiProcessing={false} />
    );
    expect(screen.queryByTestId('acp-runtime-status')).toBeNull();
  });

  it('does not report ready while an accepted turn is already active', () => {
    render(<AcpRuntimeStatus activity={{ phase: 'idle', updatedAt: Date.now() }} running aiProcessing={false} />);

    expect(screen.getByTestId('acp-runtime-status')).toHaveTextContent('thinking');
    expect(screen.getByTestId('acp-runtime-status')).not.toHaveTextContent('idle');
  });

  it('moves a real redaction receipt into the compact footer instead of a wide banner', () => {
    render(
      <AcpRuntimeStatus
        activity={{ phase: 'idle', updatedAt: Date.now() }}
        running={false}
        aiProcessing={false}
        egressBoundary={{ decision: 'redact', finding_count: 1, observed_at: '2026-07-18T12:34:00Z' }}
      />
    );

    const receipt = screen.getByTestId('acp-runtime-egress-receipt');
    expect(receipt).toHaveTextContent('Sensible Daten bereinigt');
    expect(receipt).toHaveTextContent('1');
    expect(screen.queryByText(/EVE hat sensible Daten vor dem Modell bereinigt/)).toBeNull();
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

    expect(screen.getByTestId('acp-runtime-status')).toHaveTextContent('Kontext 67.7k/256k');
  });

  it('shows the selected lane while Hermes has not reported a raw model id yet', () => {
    useIsDevModeMock.mockReturnValueOnce(true);
    eveSelectionMock.mockReturnValueOnce({
      selection: 'command-eve-local:fast',
      selectedItem: { group: 'local', label: 'Standard' },
      cloudBearerAvailable: undefined,
    });

    render(
      <AcpRuntimeStatus backend='hermes' activity={{ phase: 'thinking', updatedAt: Date.now() }} running aiProcessing />
    );

    expect(screen.getByTestId('acp-runtime-status')).toHaveTextContent('EVE · lokal');
    expect(screen.getByTestId('acp-runtime-status')).not.toHaveTextContent('Modell unbekannt');
  });
});
