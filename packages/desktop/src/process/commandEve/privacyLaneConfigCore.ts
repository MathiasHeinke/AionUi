/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE Datenschutz Hub skeleton (1.7.6 SG-05).
 *
 * One projection for privacy mode + lane settings. Runtime routing consumes the
 * decision object; UI can render the same reason/human gate without re-deciding.
 */

import type { RuntimeGateHumanGate, RuntimeGatePrivacyMode, SensitivityClass } from './runtimeGateCore';

export type PrivacyLaneState = 'allow' | 'ask' | 'block';
export type PrivacyResidency = 'cloud_auto' | 'cloud_us' | 'cloud_eu' | 'cloud_de' | 'local_only';

export type PrivacyLaneId =
  | 'text_cloud'
  | 'text_local'
  | 'stt_cloud'
  | 'stt_local'
  | 'tts_cloud'
  | 'tts_local'
  | 'vision_cloud'
  | 'vision_local'
  | 'image_cloud'
  | 'video_cloud'
  | 'browser'
  | 'computer_use'
  | 'memory_honcho'
  | 'connectors'
  | 'send_spend_publish';

export type PrivacyLaneConfig = {
  mode: RuntimeGatePrivacyMode;
  lanes: Partial<Record<PrivacyLaneId, PrivacyLaneState>>;
  residency?: PrivacyResidency;
};

export type PrivacyRouteReasonCode =
  | 'privacy.pass'
  | 'privacy.ask'
  | 'privacy.blocked'
  | 'privacy.local-only-cloud-block'
  | 'privacy.s3-cloud-block'
  | 'privacy.s3-not-explicitly-allowed'
  | 'privacy.unknown-lane';

export type PrivacyRouteDecision = {
  ok: boolean;
  lane: PrivacyLaneId;
  laneState: PrivacyLaneState;
  reasonCode: PrivacyRouteReasonCode;
  humanGate: RuntimeGateHumanGate;
};

export const CLOUD_PRIVACY_LANES: readonly PrivacyLaneId[] = [
  'text_cloud',
  'stt_cloud',
  'tts_cloud',
  'vision_cloud',
  'image_cloud',
  'video_cloud',
];

const ALL_LANES: readonly PrivacyLaneId[] = [
  'text_cloud',
  'text_local',
  'stt_cloud',
  'stt_local',
  'tts_cloud',
  'tts_local',
  'vision_cloud',
  'vision_local',
  'image_cloud',
  'video_cloud',
  'browser',
  'computer_use',
  'memory_honcho',
  'connectors',
  'send_spend_publish',
];

function isKnownLane(lane: PrivacyLaneId): boolean {
  return ALL_LANES.includes(lane);
}

function isCloudLane(lane: PrivacyLaneId): boolean {
  return CLOUD_PRIVACY_LANES.includes(lane);
}

function defaultLaneState(mode: RuntimeGatePrivacyMode, lane: PrivacyLaneId): PrivacyLaneState {
  if (mode === 'local_only') {
    if (isCloudLane(lane)) return 'block';
    if (lane === 'browser' || lane === 'computer_use' || lane === 'connectors' || lane === 'send_spend_publish') {
      return 'ask';
    }
    return 'allow';
  }

  if (mode === 'privacy_first') {
    if (isCloudLane(lane)) return 'ask';
    if (lane === 'browser' || lane === 'computer_use' || lane === 'connectors' || lane === 'send_spend_publish') {
      return 'ask';
    }
    return 'allow';
  }

  if (lane === 'send_spend_publish') return 'ask';
  if (lane === 'vision_cloud' || lane === 'image_cloud' || lane === 'video_cloud' || lane === 'tts_cloud') return 'ask';
  return 'allow';
}

export function buildDefaultPrivacyLaneConfig(mode: RuntimeGatePrivacyMode): PrivacyLaneConfig {
  const lanes: Partial<Record<PrivacyLaneId, PrivacyLaneState>> = {};
  for (const lane of ALL_LANES) {
    lanes[lane] = defaultLaneState(mode, lane);
  }
  return { mode, lanes, residency: mode === 'local_only' ? 'local_only' : 'cloud_auto' };
}

export function privacyLaneState(config: PrivacyLaneConfig, lane: PrivacyLaneId): PrivacyLaneState {
  return config.lanes[lane] || defaultLaneState(config.mode, lane);
}

export function decidePrivacyRoute(
  config: PrivacyLaneConfig,
  lane: PrivacyLaneId,
  sensitivity: SensitivityClass
): PrivacyRouteDecision {
  if (!isKnownLane(lane)) {
    return { ok: false, lane, laneState: 'block', reasonCode: 'privacy.unknown-lane', humanGate: 'HG-2' };
  }

  const laneState = privacyLaneState(config, lane);

  if (config.mode === 'local_only' && isCloudLane(lane)) {
    return { ok: false, lane, laneState: 'block', reasonCode: 'privacy.local-only-cloud-block', humanGate: 'HG-2' };
  }

  if (sensitivity === 'S3-restricted' && isCloudLane(lane)) {
    return { ok: false, lane, laneState, reasonCode: 'privacy.s3-cloud-block', humanGate: 'HG-3' };
  }

  if (sensitivity === 'S3-restricted' && laneState !== 'allow') {
    return { ok: false, lane, laneState, reasonCode: 'privacy.s3-not-explicitly-allowed', humanGate: 'HG-3' };
  }

  if (laneState === 'block') {
    return { ok: false, lane, laneState, reasonCode: 'privacy.blocked', humanGate: 'HG-2' };
  }

  if (laneState === 'ask') {
    return { ok: false, lane, laneState, reasonCode: 'privacy.ask', humanGate: 'HG-2' };
  }

  return { ok: true, lane, laneState, reasonCode: 'privacy.pass', humanGate: 'HG-0' };
}

export function routeAllowed(config: PrivacyLaneConfig, lane: PrivacyLaneId, sensitivity: SensitivityClass): boolean {
  return decidePrivacyRoute(config, lane, sensitivity).ok;
}
