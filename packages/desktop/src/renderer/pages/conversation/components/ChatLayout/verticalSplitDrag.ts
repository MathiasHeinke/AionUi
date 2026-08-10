/**
 * Imperative lifetime for the horizontal divider used by the stacked EVE
 * workbench. Kept separate from React so pointer loss, blur and unmount
 * cleanup can be verified against a real DOM without mounting ChatLayout.
 */
export function beginVerticalSplitDrag(options: {
  dragHandle: HTMLElement;
  pointerId: number;
  startY: number;
  startRatio: number;
  containerHeight: number;
  minRatio: number;
  maxRatio: number;
  onChange: (ratio: number) => void;
  onCommit: (ratio: number) => void;
}): () => void {
  const { dragHandle, pointerId, startY, startRatio, containerHeight, minRatio, maxRatio, onChange, onCommit } =
    options;
  const previousCursor = document.body.style.cursor;
  const previousUserSelect = document.body.style.userSelect;
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';

  let latestRatio = startRatio;
  let isDragging = true;
  const ratioAt = (clientY: number) =>
    Math.max(minRatio, Math.min(maxRatio, startRatio - ((clientY - startY) / containerHeight) * 100));

  function teardown() {
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousUserSelect;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    window.removeEventListener('mouseup', finish);
    window.removeEventListener('blur', finish);
    dragHandle.removeEventListener('lostpointercapture', finish);
    if (dragHandle.releasePointerCapture && dragHandle.hasPointerCapture?.(pointerId)) {
      dragHandle.releasePointerCapture(pointerId);
    }
  }

  function finish(event?: Event) {
    if (!isDragging) return;
    isDragging = false;
    if (event && 'clientY' in event && typeof event.clientY === 'number') {
      latestRatio = ratioAt(event.clientY);
    }
    onChange(latestRatio);
    onCommit(latestRatio);
    teardown();
  }

  function onMove(event: PointerEvent) {
    if (event.buttons === 0) {
      finish(event);
      return;
    }
    latestRatio = ratioAt(event.clientY);
    onChange(latestRatio);
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  window.addEventListener('mouseup', finish);
  window.addEventListener('blur', finish);
  dragHandle.addEventListener('lostpointercapture', finish);
  if (dragHandle.setPointerCapture) {
    try {
      dragHandle.setPointerCapture(pointerId);
    } catch {
      // Window listeners still guarantee cleanup when capture is unavailable.
    }
  }

  return () => {
    if (!isDragging) return;
    isDragging = false;
    teardown();
  };
}
