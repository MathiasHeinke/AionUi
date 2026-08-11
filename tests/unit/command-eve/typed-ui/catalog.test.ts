/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  TYPED_UI_BASE_COMPONENTS,
  TYPED_UI_CATALOG,
  TYPED_UI_COMPONENTS,
  TYPED_UI_EVE_COMPONENTS,
} from '@/common/typedUI';
import { describe, expect, it } from 'vitest';

describe('Command EVE Typed UI catalog v1', () => {
  it('contains exactly 42 safe base components plus three EVE-native components', () => {
    expect(TYPED_UI_BASE_COMPONENTS).toHaveLength(42);
    expect(TYPED_UI_EVE_COMPONENTS).toEqual(['Goal', 'WorkerRun', 'DecisionCard']);
    expect(TYPED_UI_COMPONENTS).toHaveLength(45);
    expect(new Set(TYPED_UI_COMPONENTS).size).toBe(45);
    expect(Object.keys(TYPED_UI_CATALOG).toSorted()).toEqual([...TYPED_UI_COMPONENTS].toSorted());
  });

  it('keeps the catalog identity stable as a structural snapshot', () => {
    expect({
      base: TYPED_UI_BASE_COMPONENTS,
      eve: TYPED_UI_EVE_COMPONENTS,
      actionEvents: Object.fromEntries(
        Object.entries(TYPED_UI_CATALOG)
          .filter(([, definition]) => definition.events.length > 0)
          .map(([name, definition]) => [name, definition.events])
      ),
    }).toMatchInlineSnapshot(`
      {
        "actionEvents": {
          "Button": [
            "press",
          ],
          "DecisionCard": [
            "select:*",
            "approve",
          ],
          "DropdownMenu": [
            "select:*",
          ],
          "Goal": [
            "press",
          ],
          "Image": [
            "press",
          ],
          "Link": [
            "press",
          ],
          "Radio": [
            "select:*",
          ],
          "Select": [
            "select:*",
          ],
          "Tabs": [
            "select:*",
          ],
          "ToggleGroup": [
            "select:*",
          ],
          "WorkerRun": [
            "press",
          ],
        },
        "base": [
          "Card",
          "Stack",
          "Grid",
          "Separator",
          "Tabs",
          "Accordion",
          "Collapsible",
          "Dialog",
          "Drawer",
          "Carousel",
          "Table",
          "Heading",
          "Text",
          "Image",
          "Avatar",
          "Badge",
          "Alert",
          "Progress",
          "Skeleton",
          "Spinner",
          "Tooltip",
          "Popover",
          "Input",
          "Textarea",
          "Select",
          "Checkbox",
          "Radio",
          "Switch",
          "Slider",
          "Button",
          "Link",
          "DropdownMenu",
          "Toggle",
          "ToggleGroup",
          "ButtonGroup",
          "Pagination",
          "Metric",
          "KeyValue",
          "Code",
          "Markdown",
          "List",
          "Timeline",
        ],
        "eve": [
          "Goal",
          "WorkerRun",
          "DecisionCard",
        ],
      }
    `);
  });
});
