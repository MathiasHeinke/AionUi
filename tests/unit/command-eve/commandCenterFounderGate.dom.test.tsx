import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { commandEve } from '@/common/adapter/ipcBridge';
import { FounderOnlyCommandCenterRoute } from '@/renderer/components/layout/Router';

vi.mock('@/common/adapter/ipcBridge', () => ({
  commandEve: {
    shellFlags: { invoke: vi.fn() },
  },
}));

vi.mock('@renderer/components/layout/AppLoader', () => ({
  default: () => <div data-testid='app-loader'>loading</div>,
}));

vi.mock('@renderer/pages/commandCenter', () => ({
  default: () => <div data-testid='command-center-page'>internal command center</div>,
}));

const renderCommandCenterRoute = () =>
  render(
    <MemoryRouter initialEntries={['/command-center']}>
      <Routes>
        <Route path='/command-center' element={<FounderOnlyCommandCenterRoute />} />
        <Route path='/guid' element={<div data-testid='guid-page'>guid</div>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.mocked(commandEve.shellFlags.invoke).mockResolvedValue({
    success: true,
    data: { ok: true, founder_build: false },
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Command Center founder gate', () => {
  it('redirects public builds away from the internal Command Center deep link', async () => {
    renderCommandCenterRoute();

    await waitFor(() => expect(commandEve.shellFlags.invoke).toHaveBeenCalled());
    expect(await screen.findByTestId('guid-page')).toBeInTheDocument();
    expect(screen.queryByTestId('command-center-page')).toBeNull();
  });

  it('fails closed when shell flags cannot be read', async () => {
    vi.mocked(commandEve.shellFlags.invoke).mockRejectedValue(new Error('bridge unavailable') as never);

    renderCommandCenterRoute();

    expect(await screen.findByTestId('guid-page')).toBeInTheDocument();
    expect(screen.queryByTestId('command-center-page')).toBeNull();
  });

  it('renders the internal Command Center only for founder builds', async () => {
    vi.mocked(commandEve.shellFlags.invoke).mockResolvedValue({
      success: true,
      data: { ok: true, founder_build: true },
    } as never);

    renderCommandCenterRoute();

    expect(await screen.findByTestId('command-center-page')).toBeInTheDocument();
    expect(screen.queryByTestId('guid-page')).toBeNull();
  });
});
