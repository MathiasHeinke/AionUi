import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EveExternalActionPolicyView } from '@/common/config/eveExternalActionPolicyCore';

const TOKEN_A = `policy-context:v1:${'a'.repeat(64)}`;
const TOKEN_B = `policy-context:v1:${'b'.repeat(64)}`;

const bridgeMocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  kill: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    externalActionPolicyGet: { invoke: bridgeMocks.get },
    externalActionPolicySet: { invoke: bridgeMocks.set },
    externalActionPolicyKill: { invoke: bridgeMocks.kill },
    externalActionPolicyRevoke: { invoke: bridgeMocks.revoke },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      `${key}${options?.revision !== undefined ? `:${String(options.revision)}` : ''}`,
  }),
}));

vi.mock('@/renderer/components/settings/SettingsSection', () => ({
  default: ({ children, testId }: { children: React.ReactNode; testId?: string }) => (
    <section data-testid={testId}>{children}</section>
  ),
}));

vi.mock('@/renderer/components/settings/PreferenceRow', () => ({
  default: ({ children, label }: { children: React.ReactNode; label: React.ReactNode }) => (
    <label>
      {label}
      {children}
    </label>
  ),
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button disabled={disabled} onClick={onClick} data-testid={rest['data-testid']}>
      {children}
    </button>
  ),
  Switch: ({
    checked,
    onChange,
    disabled,
    'data-testid': testId,
  }: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    'data-testid'?: string;
  }) => (
    <button
      disabled={disabled}
      data-testid={testId}
      data-checked={String(checked)}
      onClick={() => onChange(!checked)}
    />
  ),
  InputNumber: ({
    value,
    onChange,
    'data-testid': testId,
  }: {
    value?: number;
    onChange: (value: number) => void;
    'data-testid'?: string;
  }) => <input data-testid={testId} value={value ?? ''} onChange={(event) => onChange(Number(event.target.value))} />,
}));

function policy(revision: number, origin: string): EveExternalActionPolicyView {
  return {
    version: 'command-eve-external-action-policy/v0',
    configured: true,
    revision,
    sessionEpoch: revision,
    currency: 'EUR',
    perActionLimitMinor: 100,
    dailyLimitMinor: 200,
    monthlyLimitMinor: 300,
    allowedOrigins: [origin],
    allowedActionKinds: ['purchase'],
    expiresAt: '2026-08-18T12:00:00.000Z',
    killSwitch: false,
    revoked: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface PolicyResponse {
  success: boolean;
  data: { ok: boolean; policy: EveExternalActionPolicyView; context_token: string };
}

beforeEach(() => {
  for (const mock of Object.values(bridgeMocks)) mock.mockReset();
});

afterEach(cleanup);

describe('ExternalActionPolicySection seat-scoped UI', () => {
  it('drops a stale Seat-A read after switching to Seat B', async () => {
    const seatA = deferred<PolicyResponse>();
    const seatB = deferred<PolicyResponse>();
    bridgeMocks.get.mockReturnValueOnce(seatA.promise).mockReturnValueOnce(seatB.promise);
    const Component = (
      await import('@/renderer/components/settings/SettingsModal/contents/ExternalActionPolicySection')
    ).default;
    const grant = { ladder: 4 as const, capabilities: {}, updatedBy: 'user' as const };
    const rendered = render(<Component activeSeatId='seat-a' authorityGrant={grant} />);
    await waitFor(() => expect(bridgeMocks.get).toHaveBeenCalledTimes(1));
    rendered.rerender(<Component activeSeatId='seat-b' authorityGrant={grant} />);
    await waitFor(() => expect(bridgeMocks.get).toHaveBeenCalledTimes(2));

    await act(async () => {
      seatB.resolve({
        success: true,
        data: { ok: true, policy: policy(2, 'https://b.example'), context_token: TOKEN_B },
      });
    });
    await waitFor(() =>
      expect((screen.getByTestId('external-policy-origins') as HTMLTextAreaElement).value).toBe('https://b.example')
    );

    await act(async () => {
      seatA.resolve({
        success: true,
        data: { ok: true, policy: policy(1, 'https://a.example'), context_token: TOKEN_A },
      });
    });
    expect((screen.getByTestId('external-policy-origins') as HTMLTextAreaElement).value).toBe('https://b.example');
    expect(screen.getByTestId('external-policy-status').textContent).toContain(':2');
  });

  it('sends only renderer-editable scope and budget fields, never account/Seed authority', async () => {
    bridgeMocks.get.mockResolvedValue({
      success: true,
      data: { ok: true, policy: policy(3, 'https://shop.example'), context_token: TOKEN_A },
    });
    bridgeMocks.set.mockResolvedValue({
      success: true,
      data: { ok: true, policy: policy(4, 'https://shop.example'), context_token: TOKEN_B },
    });
    const Component = (
      await import('@/renderer/components/settings/SettingsModal/contents/ExternalActionPolicySection')
    ).default;
    render(
      <Component activeSeatId='seat-private' authorityGrant={{ ladder: 4, capabilities: {}, updatedBy: 'user' }} />
    );
    await waitFor(() => expect(bridgeMocks.get).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByTestId('external-policy-save'));
    await waitFor(() => expect(bridgeMocks.set).toHaveBeenCalledTimes(1));
    const payload = bridgeMocks.set.mock.calls[0][0];
    expect(payload).toMatchObject({
      context_token: TOKEN_A,
      mutation: {
        currency: 'EUR',
        allowedOrigins: ['https://shop.example'],
        allowedActionKinds: ['purchase'],
      },
    });
    expect(JSON.stringify(payload)).not.toContain('seat-private');
    expect(payload.mutation).not.toHaveProperty('accountId');
    expect(payload.mutation).not.toHaveProperty('seedId');
    expect(payload.mutation).not.toHaveProperty('binding');
    expect(payload.mutation).not.toHaveProperty('revision');
    expect(payload.mutation).not.toHaveProperty('sessionEpoch');
  });
});
