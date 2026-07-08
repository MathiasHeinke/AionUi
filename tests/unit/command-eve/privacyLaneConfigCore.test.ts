/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildDefaultPrivacyLaneConfig,
  decidePrivacyRoute,
  routeAllowed,
  type PrivacyLaneConfig,
} from '@/process/commandEve/privacyLaneConfigCore';

describe('Command EVE privacy lane config core', () => {
  it('projects local-only into hard cloud-lane blocks', () => {
    const config = buildDefaultPrivacyLaneConfig('local_only');

    for (const lane of ['text_cloud', 'vision_cloud', 'tts_cloud', 'image_cloud', 'video_cloud'] as const) {
      expect(decidePrivacyRoute(config, lane, 'S1-internal-low')).toMatchObject({
        ok: false,
        reasonCode: 'privacy.local-only-cloud-block',
        humanGate: 'HG-2',
      });
    }
    expect(routeAllowed(config, 'text_local', 'S2-confidential')).toBe(true);
  });

  it('makes privacy-first cloud lanes ask instead of silently routing', () => {
    const config = buildDefaultPrivacyLaneConfig('privacy_first');

    expect(decidePrivacyRoute(config, 'text_cloud', 'S1-internal-low')).toEqual({
      ok: false,
      lane: 'text_cloud',
      laneState: 'ask',
      reasonCode: 'privacy.ask',
      humanGate: 'HG-2',
    });
  });

  it('keeps S3 out of cloud lanes even if a lane is configured allow', () => {
    const config: PrivacyLaneConfig = {
      mode: 'cloud_balanced',
      lanes: { text_cloud: 'allow' },
    };

    expect(decidePrivacyRoute(config, 'text_cloud', 'S3-restricted')).toMatchObject({
      ok: false,
      reasonCode: 'privacy.s3-cloud-block',
      humanGate: 'HG-3',
    });
  });

  it('requires explicit allow for S3 on non-cloud lanes and blocks ask states', () => {
    const config: PrivacyLaneConfig = {
      mode: 'cloud_balanced',
      lanes: { memory_honcho: 'ask', text_local: 'allow' },
    };

    expect(decidePrivacyRoute(config, 'memory_honcho', 'S3-restricted')).toMatchObject({
      ok: false,
      reasonCode: 'privacy.s3-not-explicitly-allowed',
      humanGate: 'HG-3',
    });
    expect(routeAllowed(config, 'text_local', 'S3-restricted')).toBe(true);
  });

  it('treats ask and block as non-auto-routing states', () => {
    const config: PrivacyLaneConfig = {
      mode: 'cloud_balanced',
      lanes: {
        browser: 'ask',
        computer_use: 'block',
      },
    };

    expect(decidePrivacyRoute(config, 'browser', 'S0-public')).toMatchObject({
      ok: false,
      reasonCode: 'privacy.ask',
      humanGate: 'HG-2',
    });
    expect(decidePrivacyRoute(config, 'computer_use', 'S0-public')).toMatchObject({
      ok: false,
      reasonCode: 'privacy.blocked',
      humanGate: 'HG-2',
    });
  });

  it('cloud-balanced defaults keep text cloud allowed but high-impact lanes ask', () => {
    const config = buildDefaultPrivacyLaneConfig('cloud_balanced');

    expect(routeAllowed(config, 'text_cloud', 'S0-public')).toBe(true);
    expect(decidePrivacyRoute(config, 'image_cloud', 'S0-public')).toMatchObject({
      ok: false,
      reasonCode: 'privacy.ask',
    });
    expect(decidePrivacyRoute(config, 'send_spend_publish', 'S0-public')).toMatchObject({
      ok: false,
      reasonCode: 'privacy.ask',
    });
  });
});
