import { describe, expect, it, vi } from 'vitest';
import { createComposerSpotlightTracker, type ComposerSpotlightRect } from '@/renderer/utils/ui/composerSpotlightCore';

const makeHarness = (rect: ComposerSpotlightRect = { left: 100, top: 40, width: 300, height: 120 }) => {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  const setProperty = vi.fn();
  const getBoundingClientRect = vi.fn(() => rect);
  const target = { style: { setProperty }, getBoundingClientRect };
  const cancelFrame = vi.fn((id: number) => callbacks.delete(id));
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    callbacks.set(id, callback);
    return id;
  });
  const flush = () => {
    const queued = [...callbacks.entries()];
    callbacks.clear();
    queued.forEach(([, callback]) => callback(0));
  };

  return { callbacks, cancelFrame, flush, getBoundingClientRect, requestFrame, setProperty, target };
};

describe('createComposerSpotlightTracker', () => {
  it('coalesces pointer movement into one style write per animation frame', () => {
    const harness = makeHarness();
    const tracker = createComposerSpotlightTracker({
      requestFrame: harness.requestFrame,
      cancelFrame: harness.cancelFrame,
      shouldTrack: () => true,
    });

    tracker.enter(harness.target, { clientX: 120, clientY: 60, pointerType: 'mouse' });
    tracker.move(harness.target, { clientX: 250, clientY: 100, pointerType: 'mouse' });
    tracker.move(harness.target, { clientX: 390, clientY: 150, pointerType: 'mouse' });

    expect(harness.requestFrame).toHaveBeenCalledTimes(1);
    expect(harness.setProperty).not.toHaveBeenCalled();
    harness.flush();
    expect(harness.setProperty).toHaveBeenCalledTimes(1);
    expect(harness.setProperty).toHaveBeenCalledWith('--eve-spotlight-position', '290px 110px');
  });

  it('clamps the hotspot to the composer boundary', () => {
    const harness = makeHarness();
    const tracker = createComposerSpotlightTracker({
      requestFrame: harness.requestFrame,
      cancelFrame: harness.cancelFrame,
      shouldTrack: () => true,
    });

    tracker.enter(harness.target, { clientX: -500, clientY: 900, pointerType: 'mouse' });
    harness.flush();
    expect(harness.setProperty).toHaveBeenCalledWith('--eve-spotlight-position', '0px 120px');
  });

  it('caches geometry until an explicit resize refresh', () => {
    const harness = makeHarness();
    const tracker = createComposerSpotlightTracker({
      requestFrame: harness.requestFrame,
      cancelFrame: harness.cancelFrame,
      shouldTrack: () => true,
    });

    tracker.enter(harness.target, { clientX: 120, clientY: 60, pointerType: 'mouse' });
    tracker.move(harness.target, { clientX: 130, clientY: 70, pointerType: 'mouse' });
    expect(harness.getBoundingClientRect).toHaveBeenCalledTimes(1);
    tracker.resize();
    expect(harness.getBoundingClientRect).toHaveBeenCalledTimes(2);
  });

  it('does not schedule tracking for touch or reduced-motion pointers', () => {
    const harness = makeHarness();
    const tracker = createComposerSpotlightTracker({
      requestFrame: harness.requestFrame,
      cancelFrame: harness.cancelFrame,
      shouldTrack: () => false,
    });

    tracker.enter(harness.target, { clientX: 120, clientY: 60, pointerType: 'touch' });
    expect(harness.requestFrame).not.toHaveBeenCalled();
  });

  it('cancels a queued frame on teardown', () => {
    const harness = makeHarness();
    const tracker = createComposerSpotlightTracker({
      requestFrame: harness.requestFrame,
      cancelFrame: harness.cancelFrame,
      shouldTrack: () => true,
    });

    tracker.enter(harness.target, { clientX: 120, clientY: 60, pointerType: 'mouse' });
    tracker.destroy();
    expect(harness.cancelFrame).toHaveBeenCalledWith(1);
  });
});
