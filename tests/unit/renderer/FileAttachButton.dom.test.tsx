import FileAttachButton from '@/renderer/components/media/FileAttachButton';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAvailableSkills: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      listAvailableSkills: { invoke: mocks.listAvailableSkills },
    },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => undefined,
}));
vi.mock('@/renderer/hooks/useActiveSeatId', () => ({ useActiveSeatId: () => 'legacy' }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/renderer/services/FileService', () => ({
  FileService: { processDroppedFiles: vi.fn() },
}));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: mocks.emit } }));
vi.mock('@/common/config/commandEveShell', () => ({ COMMAND_EVE_SHELL_ENABLED: true }));

describe('FileAttachButton skill capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAvailableSkills.mockResolvedValue([
      {
        name: 'runtime-active',
        description: 'Active in this conversation',
        location: '/skills/runtime-active',
        is_custom: true,
        source: 'custom',
      },
      {
        name: 'runtime-inactive',
        description: 'Installed after this conversation started',
        location: '/skills/runtime-inactive',
        is_custom: true,
        source: 'custom',
      },
    ]);
  });

  it('shows the existing-chat runtime snapshot with the shared count and invokes only an active skill', async () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter>
          <FileAttachButton openFileSelector={vi.fn()} loadedSkills={['runtime-active']} loadedMcpStatuses={[]} />
        </MemoryRouter>
      </SWRConfig>
    );

    await waitFor(() => expect(mocks.listAvailableSkills).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('aionrs-attach-folder-btn'));
    const count = await screen.findByTestId('skill-capability-count');
    expect(count.textContent).toBe('common.skills (1/2)');

    fireEvent.mouseEnter(count);
    const activeSkill = await screen.findByText('runtime-active');
    expect(screen.queryByText('runtime-inactive')).toBeNull();
    fireEvent.click(activeSkill);
    expect(mocks.emit).toHaveBeenCalledWith('sendbox.fill', '/runtime-active ');
  });
});
