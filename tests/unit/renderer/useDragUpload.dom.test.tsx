/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  processDroppedFiles: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => `${key}:${options?.count ?? ''}`,
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Message: { error: vi.fn(), warning: mocks.warning },
}));

vi.mock('@renderer/services/FileService', () => ({
  isSupportedFile: (name: string) => name.endsWith('.png'),
  FileService: { processDroppedFiles: mocks.processDroppedFiles },
}));

import { useDragUpload } from '@/renderer/hooks/file/useDragUpload';

const dragEvent = (files: File[] = [], types: string[] = ['Files']) => ({
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
  dataTransfer: {
    files: Object.assign(files, {
      item: (index: number) => files[index] ?? null,
    }) as unknown as FileList,
    types,
  } as unknown as DataTransfer,
});

describe('useDragUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.processDroppedFiles.mockResolvedValue([]);
  });

  it('does not let repeated dragover events inflate the enter/leave counter', () => {
    const { result } = renderHook(() => useDragUpload({ onFilesAdded: vi.fn() }));
    const event = dragEvent();

    act(() => result.current.dragHandlers.onDragEnter(event));
    act(() => result.current.dragHandlers.onDragOver(event));
    act(() => result.current.dragHandlers.onDragOver(event));
    expect(result.current.isFileDragging).toBe(true);

    act(() => result.current.dragHandlers.onDragLeave(event));
    expect(result.current.isFileDragging).toBe(false);
  });

  it('reports unsupported files and only processes the supported subset', async () => {
    const onFilesAdded = vi.fn();
    const { result } = renderHook(() => useDragUpload({ supportedExts: ['.png'], onFilesAdded }));
    const good = new File(['ok'], 'good.png', { type: 'image/png' });
    const bad = new File(['no'], 'bad.exe', { type: 'application/octet-stream' });

    await act(async () => {
      await result.current.dragHandlers.onDrop(dragEvent([good, bad]));
    });

    expect(mocks.warning).toHaveBeenCalledWith('common.fileAttach.unsupported:1');
    await waitFor(() => expect(mocks.processDroppedFiles).toHaveBeenCalledTimes(1));
    const processed = mocks.processDroppedFiles.mock.calls[0]?.[0] as FileList;
    expect(Array.from(processed).map((file) => file.name)).toEqual(['good.png']);
    expect(onFilesAdded).not.toHaveBeenCalled();
  });
});
