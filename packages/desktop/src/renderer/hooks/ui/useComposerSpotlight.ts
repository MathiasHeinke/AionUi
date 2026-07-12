import {
  useCallback,
  useEffect,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type FormEvent as ReactFormEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import {
  createComposerSpotlightTracker,
  type ComposerSpotlightTarget,
} from '@/renderer/utils/ui/composerSpotlightCore';

const canTrackPointer = (pointerType?: string): boolean => {
  if (pointerType === 'touch') return false;
  if (document.documentElement.dataset.eveReducedEffects === 'true') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

export const useComposerSpotlight = <T extends HTMLElement>(elementRef: RefObject<T | null>) => {
  const trackerRef = useRef<ReturnType<typeof createComposerSpotlightTracker> | null>(null);
  const keyboardModalityRef = useRef(false);
  const typingPulsePhaseRef = useRef(false);
  const typingPulseTimerRef = useRef<number | null>(null);

  const getTracker = useCallback(() => {
    trackerRef.current ??= createComposerSpotlightTracker({
      requestFrame: window.requestAnimationFrame.bind(window),
      cancelFrame: window.cancelAnimationFrame.bind(window),
      shouldTrack: canTrackPointer,
    });
    return trackerRef.current;
  }, []);

  useEffect(() => {
    const tracker = getTracker();
    const updateBounds = () => tracker.resize();
    const markKeyboardModality = (event: KeyboardEvent) => {
      if (event.key === 'Tab') keyboardModalityRef.current = true;
    };
    const markPointerModality = () => {
      keyboardModalityRef.current = false;
      elementRef.current?.removeAttribute('data-keyboard-focus');
    };
    window.addEventListener('resize', updateBounds, { passive: true });
    window.addEventListener('keydown', markKeyboardModality, true);
    window.addEventListener('pointerdown', markPointerModality, true);

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => tracker.resize());
    if (elementRef.current) resizeObserver?.observe(elementRef.current);

    return () => {
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('keydown', markKeyboardModality, true);
      window.removeEventListener('pointerdown', markPointerModality, true);
      resizeObserver?.disconnect();
      if (typingPulseTimerRef.current !== null) window.clearTimeout(typingPulseTimerRef.current);
      tracker.destroy();
      trackerRef.current = null;
    };
  }, [elementRef, getTracker]);

  const onPointerEnter = useCallback(
    (event: ReactPointerEvent<T>) => {
      getTracker().enter(event.currentTarget as ComposerSpotlightTarget, event);
    },
    [getTracker]
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<T>) => {
      getTracker().move(event.currentTarget as ComposerSpotlightTarget, event);
    },
    [getTracker]
  );

  const onFocusCapture = useCallback((event: ReactFocusEvent<T>) => {
    if (keyboardModalityRef.current) event.currentTarget.dataset.keyboardFocus = 'true';
  }, []);

  const onBlurCapture = useCallback((event: ReactFocusEvent<T>) => {
    const nextTarget = event.relatedTarget;
    if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
      event.currentTarget.removeAttribute('data-keyboard-focus');
    }
  }, []);

  const onInputCapture = useCallback(
    (event: ReactFormEvent<T>) => {
      if (!canTrackPointer()) return;
      if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) return;

      const target = event.currentTarget;
      typingPulsePhaseRef.current = !typingPulsePhaseRef.current;
      target.dataset.typingPulse = typingPulsePhaseRef.current ? 'a' : 'b';

      if (typingPulseTimerRef.current !== null) window.clearTimeout(typingPulseTimerRef.current);
      typingPulseTimerRef.current = window.setTimeout(() => {
        elementRef.current?.removeAttribute('data-typing-pulse');
        typingPulseTimerRef.current = null;
      }, 420);
    },
    [elementRef]
  );

  return { onPointerEnter, onPointerMove, onFocusCapture, onBlurCapture, onInputCapture };
};
