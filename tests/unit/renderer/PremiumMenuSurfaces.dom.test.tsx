import MobileActionSheet from '@/renderer/components/chat/MobileActionSheet/MobileActionSheet';
import WorkspaceFolderSelect from '@/renderer/components/workspace/WorkspaceFolderSelect';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showOpen: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    dialog: {
      showOpen: { invoke: mocks.showOpen },
    },
  },
}));

vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

describe('premium custom menu surfaces', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.showOpen.mockReset();
  });

  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('keeps the mobile action sheet keyboard-contained and lets Escape unwind a submenu before closing', async () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();

    render(
      <MobileActionSheet
        open
        onClose={onClose}
        title='Tools'
        entries={[
          {
            key: 'model',
            label: 'Model',
            submenu: {
              title: 'Choose model',
              options: [{ key: 'max', label: 'MAX', active: true }],
              onSelect,
            },
          },
        ]}
      />
    );

    const sheet = await screen.findByRole('dialog', { name: 'Tools' });
    await waitFor(() => expect(sheet.className).toMatch(/visible/));

    fireEvent.click(screen.getByTestId('mobile-action-sheet-model'));
    expect(await screen.findByRole('listbox', { name: 'Choose model' })).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens the workspace chooser as the shared premium menu and restores trigger focus on Escape', async () => {
    const storageKey = 'test:recent-workspaces';
    localStorage.setItem(storageKey, JSON.stringify(['/projects/Alpha', '/projects/Beta']));

    render(
      <WorkspaceFolderSelect
        value='/projects/Alpha'
        onChange={vi.fn()}
        placeholder='Choose project'
        recentLabel='Recent'
        chooseDifferentLabel='Choose another'
        recentStorageKey={storageKey}
        triggerTestId='workspace-trigger'
        menuTestId='workspace-menu'
      />
    );

    const trigger = screen.getByTestId('workspace-trigger');
    fireEvent.click(trigger);
    const menu = await screen.findByTestId('workspace-menu');

    expect(menu.className).toContain('eve-menu-surface');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(trigger);
  });
});
