import {
  COMPOSER_MENU_MOTION_CLASS,
  COMPOSER_MENU_MOTION_DURATION,
  COMPOSER_MENU_TRIGGER_PROPS,
  composerMenuExitDuration,
} from '@/renderer/utils/ui/composerMenuMotion';
import { describe, expect, it } from 'vitest';

describe('composer menu motion', () => {
  it('uses one calm open/close contract for every composer menu', () => {
    expect(COMPOSER_MENU_MOTION_DURATION).toEqual({ appear: 480, enter: 480, exit: 380 });
    expect(COMPOSER_MENU_TRIGGER_PROPS.classNames).toBe(COMPOSER_MENU_MOTION_CLASS);
    expect(COMPOSER_MENU_TRIGGER_PROPS.duration).toBe(COMPOSER_MENU_MOTION_DURATION);
    expect(COMPOSER_MENU_MOTION_DURATION.exit).toBeLessThan(COMPOSER_MENU_MOTION_DURATION.enter);
    expect(COMPOSER_MENU_TRIGGER_PROPS.style).toMatchObject({
      '--eve-composer-menu-hover-duration': '300ms',
      '--eve-composer-menu-selection-duration': '400ms',
    });
  });

  it('removes the close hold when reduced motion is requested', () => {
    expect(composerMenuExitDuration(false)).toBe(380);
    expect(composerMenuExitDuration(true)).toBe(0);
  });
});
