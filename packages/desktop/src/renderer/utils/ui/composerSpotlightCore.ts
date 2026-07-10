export type ComposerSpotlightRect = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>;

export type ComposerSpotlightTarget = {
  style: Pick<CSSStyleDeclaration, 'setProperty'>;
  getBoundingClientRect: () => ComposerSpotlightRect;
};

export type ComposerSpotlightPoint = {
  clientX: number;
  clientY: number;
  pointerType?: string;
};

type ComposerSpotlightTrackerOptions = {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
  shouldTrack: (pointerType?: string) => boolean;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const createComposerSpotlightTracker = ({
  requestFrame,
  cancelFrame,
  shouldTrack,
}: ComposerSpotlightTrackerOptions) => {
  let target: ComposerSpotlightTarget | null = null;
  let rect: ComposerSpotlightRect | null = null;
  let pendingPoint: ComposerSpotlightPoint | null = null;
  let frameId: number | null = null;

  const writePendingPoint = () => {
    frameId = null;
    if (!target || !rect || !pendingPoint) return;

    const x = clamp(pendingPoint.clientX - rect.left, 0, rect.width);
    const y = clamp(pendingPoint.clientY - rect.top, 0, rect.height);
    target.style.setProperty('--eve-spotlight-position', `${x}px ${y}px`);
  };

  const queuePoint = (nextTarget: ComposerSpotlightTarget, point: ComposerSpotlightPoint) => {
    if (!shouldTrack(point.pointerType)) return;
    target = nextTarget;
    pendingPoint = point;
    if (frameId === null) frameId = requestFrame(writePendingPoint);
  };

  return {
    enter(nextTarget: ComposerSpotlightTarget, point: ComposerSpotlightPoint) {
      target = nextTarget;
      rect = nextTarget.getBoundingClientRect();
      queuePoint(nextTarget, point);
    },
    move(nextTarget: ComposerSpotlightTarget, point: ComposerSpotlightPoint) {
      if (target !== nextTarget || !rect) {
        target = nextTarget;
        rect = nextTarget.getBoundingClientRect();
      }
      queuePoint(nextTarget, point);
    },
    resize() {
      if (target) rect = target.getBoundingClientRect();
    },
    destroy() {
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
      pendingPoint = null;
      rect = null;
      target = null;
    },
  };
};
