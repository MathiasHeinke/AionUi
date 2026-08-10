import { describe, expect, it } from 'vitest';

import {
  MIN_HORIZONTAL_WORKBENCH_PX,
  calcLayoutMetrics,
  resolveAdaptiveWorkbenchLayout,
} from '@/renderer/pages/conversation/utils/layoutCalc';

describe('Command EVE adaptive workbench layout', () => {
  it('stacks two 340px panes before a horizontal split becomes geometrically impossible', () => {
    expect(MIN_HORIZONTAL_WORKBENCH_PX).toBe(680);
    expect(resolveAdaptiveWorkbenchLayout('split-left', 679)).toBe('split-bottom');
    expect(resolveAdaptiveWorkbenchLayout('split-right', 679)).toBe('split-bottom');
    expect(resolveAdaptiveWorkbenchLayout('split-left', 680)).toBe('split-left');
    expect(resolveAdaptiveWorkbenchLayout('split-right', 900)).toBe('split-right');
  });

  it('does not change focus, an explicit bottom layout, or an unmeasured initial container', () => {
    expect(resolveAdaptiveWorkbenchLayout('focus', 420)).toBe('focus');
    expect(resolveAdaptiveWorkbenchLayout('split-bottom', 420)).toBe('split-bottom');
    expect(resolveAdaptiveWorkbenchLayout('split-right', 0)).toBe('split-right');
  });

  it('keeps the pixel-minimum ratio constraint scoped to layouts that own a workspace split', () => {
    const base = {
      containerWidth: 1000,
      workspaceWidthPx: 260,
      chatSplitRatio: 50,
      isDesktop: true,
      isPreviewOpen: true,
      rightSiderCollapsed: false,
      isMobile: false,
    };
    const generic = calcLayoutMetrics({ ...base, workspaceEnabled: false });
    const constrained = calcLayoutMetrics({ ...base, workspaceEnabled: true });

    expect(generic.dynamicChatMinRatio).toBe(25);
    expect(generic.dynamicChatMaxRatio).toBe(80);
    expect(constrained.dynamicChatMinRatio).toBeGreaterThan(25);
    expect(constrained.dynamicChatMaxRatio).toBeLessThan(80);
  });
});
