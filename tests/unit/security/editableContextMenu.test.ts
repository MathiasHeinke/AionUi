import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';

const electronMocks = vi.hoisted(() => ({
  popup: vi.fn(),
  buildFromTemplate: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: { update: { open: { emit: vi.fn() } } },
}));

vi.mock('electron', () => ({
  app: { name: 'Command EVE' },
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  Menu: {
    buildFromTemplate: electronMocks.buildFromTemplate,
    setApplicationMenu: vi.fn(),
  },
}));

import { buildEditableContextMenuTemplate, setupEditableContextMenu } from '@/process/utils/appMenu';

const flags = {
  canUndo: false,
  canRedo: true,
  canCut: false,
  canCopy: true,
  canPaste: true,
  canDelete: false,
  canSelectAll: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  electronMocks.buildFromTemplate.mockReturnValue({ popup: electronMocks.popup });
  electronMocks.fromWebContents.mockReturnValue({ id: 7 });
});

describe('native editable context menu', () => {
  it('maps Chromium edit capabilities to standard Electron roles', () => {
    const template = buildEditableContextMenuTemplate(flags, true);
    const actionable = template.filter((item) => item.type !== 'separator');

    expect(actionable.map((item) => item.role)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll',
    ]);
    expect(actionable.find((item) => item.role === 'paste')?.enabled).toBe(true);
    expect(actionable.find((item) => item.role === 'cut')?.enabled).toBe(false);
  });

  it('binds once, ignores non-editable targets, and opens for an editable field', () => {
    type ContextParams = { isEditable: boolean; editFlags: typeof flags };
    let contextMenuHandler: ((_event: unknown, params: ContextParams) => void) | undefined;
    const webContents = {
      on: vi.fn((event: string, handler: (_event: unknown, params: ContextParams) => void) => {
        if (event === 'context-menu') contextMenuHandler = handler;
      }),
      isDestroyed: vi.fn(() => false),
    };

    setupEditableContextMenu(webContents as unknown as WebContents);
    setupEditableContextMenu(webContents as unknown as WebContents);
    expect(webContents.on).toHaveBeenCalledTimes(1);

    contextMenuHandler?.({}, { isEditable: false, editFlags: flags });
    expect(electronMocks.buildFromTemplate).not.toHaveBeenCalled();

    contextMenuHandler?.({}, { isEditable: true, editFlags: flags });
    expect(electronMocks.buildFromTemplate).toHaveBeenCalledTimes(1);
    expect(electronMocks.popup).toHaveBeenCalledWith({ window: { id: 7 } });
  });
});
