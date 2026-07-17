import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import AcpRuntimeStatus from '@/renderer/pages/conversation/platforms/acp/AcpRuntimeStatus';

vi.mock('@/renderer/hooks/config/useConfig', () => ({ useConfig: () => [true] }));
vi.mock('@/renderer/hooks/useIsDevMode', () => ({ useIsDevMode: () => false }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; tool?: string }) =>
      key === 'conversation.runtimeStatus.toolDetail'
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
});
