/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { beginVerticalSplitDrag } from '@/renderer/pages/conversation/components/ChatLayout/verticalSplitDrag';

const pointerLikeEvent = (type: string, clientY: number, buttons: number) => {
  const event = new MouseEvent(type, { bubbles: true, clientY, buttons });
  return event;
};

describe('beginVerticalSplitDrag', () => {
  beforeEach(() => {
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'text';
  });

  afterEach(() => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    vi.restoreAllMocks();
  });

  const start = () => {
    const handle = document.createElement('div');
    let captured = false;
    handle.setPointerCapture = vi.fn(() => {
      captured = true;
    });
    handle.hasPointerCapture = vi.fn(() => captured);
    handle.releasePointerCapture = vi.fn(() => {
      captured = false;
    });
    document.body.append(handle);
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const cleanup = beginVerticalSplitDrag({
      dragHandle: handle,
      pointerId: 7,
      startY: 300,
      startRatio: 60,
      containerHeight: 500,
      minRatio: 36,
      maxRatio: 72,
      onChange,
      onCommit,
    });
    return { handle, onChange, onCommit, cleanup };
  };

  it('updates while moving, commits on blur and restores body interaction styles', () => {
    const { handle, onChange, onCommit } = start();
    expect(document.body.style.cursor).toBe('row-resize');
    expect(document.body.style.userSelect).toBe('none');

    window.dispatchEvent(pointerLikeEvent('pointermove', 250, 1));
    expect(onChange).toHaveBeenLastCalledWith(70);

    window.dispatchEvent(new Event('blur'));
    expect(onCommit).toHaveBeenCalledWith(70);
    expect(document.body.style.cursor).toBe('default');
    expect(document.body.style.userSelect).toBe('text');
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7);
    handle.remove();
  });

  it('commits the latest ratio when pointer capture is lost', () => {
    const { handle, onCommit } = start();
    window.dispatchEvent(pointerLikeEvent('pointermove', 420, 1));
    handle.dispatchEvent(new Event('lostpointercapture'));

    expect(onCommit).toHaveBeenCalledWith(36);
    expect(document.body.style.cursor).toBe('default');
    handle.remove();
  });

  it('unmount cleanup restores styles without committing a partial drag', () => {
    const { handle, onCommit, cleanup } = start();
    window.dispatchEvent(pointerLikeEvent('pointermove', 280, 1));
    cleanup();

    expect(onCommit).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe('default');
    expect(document.body.style.userSelect).toBe('text');
    handle.remove();
  });
});
