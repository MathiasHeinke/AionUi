/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ELEMENTS_RAIL_SELECT_EVENT, WORKSPACE_OPEN_EVENT } from '@/renderer/utils/workspace/workspaceEvents';

const { addRecentWorkspaceMock, getRecentWorkspacesMock, showOpenMock } = vi.hoisted(() => ({
  addRecentWorkspaceMock: vi.fn(),
  getRecentWorkspacesMock: vi.fn(() => [] as string[]),
  showOpenMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/common', () => ({
  ipcBridge: { dialog: { showOpen: { invoke: showOpenMock } } },
}));

vi.mock('@/renderer/components/workspace/recentWorkspaces', () => ({
  addRecentWorkspace: addRecentWorkspaceMock,
  getRecentWorkspaces: getRecentWorkspacesMock,
}));

vi.mock('@arco-design/web-react', () => {
  type MenuItemProps = {
    children: React.ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
  };
  // oxlint-disable-next-line eslint-plugin-unicorn(consistent-function-scoping)
  const MenuItem = ({ children, disabled, onSelect }: MenuItemProps) => (
    <button type='button' role='menuitem' disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  );
  const Menu = Object.assign(
    ({ children, onClickMenuItem }: { children: React.ReactNode; onClickMenuItem: (key: string) => void }) => (
      <div role='menu'>
        {React.Children.map(children, (child) => {
          if (!React.isValidElement<MenuItemProps>(child) || child.key === null) return child;
          return React.cloneElement(child, { onSelect: () => onClickMenuItem(String(child.key)) });
        })}
      </div>
    ),
    { Item: MenuItem }
  );

  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button type='button' {...props}>
        {children}
      </button>
    ),
    Dropdown: ({ children, droplist }: { children: React.ReactNode; droplist: React.ReactNode }) => (
      <>
        {children}
        {droplist}
      </>
    ),
    Menu,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

import WorkspaceContextControl from '@/renderer/components/workspace/WorkspaceContextControl';

describe('WorkspaceContextControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRecentWorkspacesMock.mockReturnValue([]);
  });

  it('opens the Context rail without changing an active conversation workspace', () => {
    const selectedTabs: string[] = [];
    const openRequests: number[] = [];
    const recordSelectedTab = (event: Event) => {
      selectedTabs.push((event as CustomEvent<string>).detail);
    };
    const recordOpenRequest = () => openRequests.push(1);
    window.addEventListener(ELEMENTS_RAIL_SELECT_EVENT, recordSelectedTab);
    window.addEventListener(WORKSPACE_OPEN_EVENT, recordOpenRequest);

    render(<WorkspaceContextControl workspacePath='/tmp/Produkt-Roadmap' />);
    fireEvent.click(screen.getByTestId('workspace-context-control'));

    expect(selectedTabs).toEqual(['context']);
    expect(openRequests).toHaveLength(1);
    window.removeEventListener(ELEMENTS_RAIL_SELECT_EVENT, recordSelectedTab);
    window.removeEventListener(WORKSPACE_OPEN_EVENT, recordOpenRequest);
  });

  it('selects a newly chosen project before a chat starts', async () => {
    const onSelectWorkspace = vi.fn();
    showOpenMock.mockResolvedValue(['/tmp/Neues-Projekt']);

    render(<WorkspaceContextControl editable onSelectWorkspace={onSelectWorkspace} />);
    fireEvent.click(screen.getByRole('menuitem', { name: /team\.create\.chooseDifferentFolder/ }));

    await waitFor(() => expect(onSelectWorkspace).toHaveBeenCalledWith('/tmp/Neues-Projekt'));
    expect(addRecentWorkspaceMock).toHaveBeenCalledWith('/tmp/Neues-Projekt');
  });

  it('keeps the current project when the directory dialog is cancelled', async () => {
    const onSelectWorkspace = vi.fn();
    showOpenMock.mockResolvedValue(undefined);

    render(<WorkspaceContextControl editable workspacePath='/tmp/Bestand' onSelectWorkspace={onSelectWorkspace} />);
    fireEvent.click(screen.getByRole('menuitem', { name: /team\.create\.chooseDifferentFolder/ }));

    await waitFor(() => expect(showOpenMock).toHaveBeenCalledTimes(1));
    expect(onSelectWorkspace).not.toHaveBeenCalled();
  });

  it('shows the durable project title ahead of a hermes-temp workspace basename (1.820.4 MAT-1772)', () => {
    render(
      <WorkspaceContextControl
        workspacePath='/Users/founder/.command-eve/workspaces/hermes-temp-6969007f'
        projectName='Q3 Planung'
      />
    );

    const control = screen.getByTestId('workspace-context-control');
    expect(control).toHaveTextContent('Q3 Planung');
    expect(control).not.toHaveTextContent('hermes-temp');
    expect(control.getAttribute('aria-label')).toBe('conversation.elementsRail.context: Q3 Planung');
  });

  it('hides an internal temporary workspace slug behind an honest project label', () => {
    render(<WorkspaceContextControl workspacePath='/Users/founder/.command-eve/workspaces/hermes-temp-6969007f' />);

    const control = screen.getByTestId('workspace-context-control');
    expect(control).toHaveTextContent('conversation.workspace.temporarySpace');
    expect(control).not.toHaveTextContent('hermes-temp-6969007f');
    expect(control.getAttribute('aria-label')).toBe(
      'conversation.elementsRail.context: conversation.workspace.temporarySpace'
    );
  });

  it('ignores a blank project name and keeps the basename', () => {
    render(<WorkspaceContextControl workspacePath='/tmp/Produkt-Roadmap' projectName='   ' />);

    const control = screen.getByTestId('workspace-context-control');
    expect(control).toHaveTextContent('Produkt-Roadmap');
  });
});
