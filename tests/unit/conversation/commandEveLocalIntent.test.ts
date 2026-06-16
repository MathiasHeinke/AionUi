/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createCommandEveLocalIntentClientToken,
  parseCommandEveLocalMarketingIntent,
} from '@/renderer/pages/conversation/platforms/aionrs/commandEveLocalIntent';

describe('parseCommandEveLocalMarketingIntent', () => {
  it('ignores normal chat text', () => {
    expect(parseCommandEveLocalMarketingIntent('moin eve, plane bitte den tag')).toBeNull();
  });

  it('parses explicit marketing card commands into the research lane', () => {
    expect(parseCommandEveLocalMarketingIntent('/marketing KI-Rendite Offer')).toEqual({
      kind: 'marketing-card',
      title: 'KI-Rendite Offer',
      laneKey: 'research',
      shouldPlanDispatch: true,
    });
  });

  it('parses a title and description split by ::', () => {
    expect(parseCommandEveLocalMarketingIntent('/eve marketing Launch Post :: Zielgruppe: Agenturen')).toEqual({
      kind: 'marketing-card',
      title: 'Launch Post',
      description: 'Zielgruppe: Agenturen',
      laneKey: 'research',
      shouldPlanDispatch: true,
    });
  });

  it('parses marketing-loop commands without changing the safety ceiling', () => {
    expect(parseCommandEveLocalMarketingIntent('/marketing-loop Daily LinkedIn Sprint')).toEqual({
      kind: 'marketing-card',
      title: 'Daily LinkedIn Sprint',
      laneKey: 'research',
      shouldPlanDispatch: true,
    });
  });

  it('returns null for empty local commands', () => {
    expect(parseCommandEveLocalMarketingIntent('/marketing')).toBeNull();
  });

  it('creates a Command EVE scoped idempotency token', () => {
    expect(createCommandEveLocalIntentClientToken()).toMatch(/^cmd-eve-chat-marketing-/);
  });
});
