import type { CSSProperties } from 'react';

/**
 * Shared motion contract for menus that belong to the start and in-session
 * composers. Opening is deliberately calmer than closing: the menu settles
 * into place without making dismissal feel sticky.
 */
export const COMPOSER_MENU_MOTION_CLASS = 'eveComposerMenuMotion';

export const COMPOSER_MENU_MOTION_DURATION = Object.freeze({
  appear: 480,
  enter: 480,
  exit: 380,
});

type ComposerMenuMotionStyle = CSSProperties & Record<`--${string}`, string>;

export const COMPOSER_MENU_MOTION_STYLE: ComposerMenuMotionStyle = Object.freeze({
  '--eve-composer-menu-enter-duration': `${COMPOSER_MENU_MOTION_DURATION.enter}ms`,
  '--eve-composer-menu-exit-duration': `${COMPOSER_MENU_MOTION_DURATION.exit}ms`,
  '--eve-composer-menu-hover-duration': '300ms',
  '--eve-composer-menu-selection-duration': '400ms',
});

export const COMPOSER_MENU_TRIGGER_PROPS = Object.freeze({
  classNames: COMPOSER_MENU_MOTION_CLASS,
  duration: COMPOSER_MENU_MOTION_DURATION,
  style: COMPOSER_MENU_MOTION_STYLE,
});

export function composerMenuExitDuration(prefersReducedMotion: boolean): number {
  return prefersReducedMotion ? 0 : COMPOSER_MENU_MOTION_DURATION.exit;
}
