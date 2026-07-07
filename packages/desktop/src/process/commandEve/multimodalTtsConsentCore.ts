/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Command EVE multimodal TTS consent store.
 *
 * This is the MAIN-owned privacy gate for future cloud voice output. It is
 * separate from renderer config and from the release-level egress flag: a user
 * can opt in here, but no cloud call can happen while the desktop egress gate is
 * still closed.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  COMMAND_EVE_MULTIMODAL_TTS_CONSENT_VERSION,
  type CommandEveMultimodalTtsConsentBridgeResult,
  type CommandEveMultimodalTtsConsentSetRequest,
  type CommandEveMultimodalTtsConsentState,
  type CommandEvePrivacyLane,
} from '@/common/config/eveMultimodalGatewayCore';

const FILE_NAME = 'command-eve-multimodal-tts-consent.json';
const SUPPORTED_TTS_CONSENT_PRIVACY_LANES: readonly CommandEvePrivacyLane[] = ['local_only', 'cloud_auto', 'cloud_us'];

export const DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT: CommandEveMultimodalTtsConsentState = {
  consent: false,
  privacyLane: 'cloud_auto',
};

type ReadFileSync = (filePath: string) => string;
type WriteFileSync = (filePath: string, data: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSupportedTtsConsentPrivacyLane(value: unknown): value is CommandEvePrivacyLane {
  return typeof value === 'string' && SUPPORTED_TTS_CONSENT_PRIVACY_LANES.includes(value as CommandEvePrivacyLane);
}

function updatedAtField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function parseCommandEveMultimodalTtsConsent(
  raw: string | undefined | null
): CommandEveMultimodalTtsConsentState {
  if (typeof raw !== 'string' || raw.length === 0) return DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT;
    const consent = parsed.consent === true;
    const privacyLane = isSupportedTtsConsentPrivacyLane(parsed.privacyLane)
      ? parsed.privacyLane
      : DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT.privacyLane;
    const updatedAt = updatedAtField(parsed.updatedAt);
    return updatedAt ? { consent, privacyLane, updatedAt } : { consent, privacyLane };
  } catch {
    return DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT;
  }
}

export function evaluateCommandEveMultimodalTtsConsentAllowed(
  state: CommandEveMultimodalTtsConsentState | undefined | null
): boolean {
  return state?.consent === true;
}

export function normalizeCommandEveMultimodalTtsConsentInput(
  input: CommandEveMultimodalTtsConsentSetRequest | undefined | null,
  previous: CommandEveMultimodalTtsConsentState = DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT
): CommandEveMultimodalTtsConsentState {
  const consent = input?.consent === true;
  const previousPrivacyLane = isSupportedTtsConsentPrivacyLane(previous.privacyLane)
    ? previous.privacyLane
    : DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT.privacyLane;
  const privacyLane = isSupportedTtsConsentPrivacyLane(input?.privacyLane) ? input.privacyLane : previousPrivacyLane;
  return {
    consent,
    privacyLane,
    updatedAt: new Date().toISOString(),
  };
}

export function readCommandEveMultimodalTtsConsentFromFile(
  filePath: string,
  readFileSync: ReadFileSync
): CommandEveMultimodalTtsConsentState {
  try {
    return parseCommandEveMultimodalTtsConsent(readFileSync(filePath));
  } catch {
    return DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT;
  }
}

export function writeCommandEveMultimodalTtsConsentToFile(
  filePath: string,
  input: CommandEveMultimodalTtsConsentSetRequest | undefined | null,
  writeFileSync: WriteFileSync,
  previous: CommandEveMultimodalTtsConsentState = DEFAULT_COMMAND_EVE_MULTIMODAL_TTS_CONSENT
): CommandEveMultimodalTtsConsentState {
  const state = normalizeCommandEveMultimodalTtsConsentInput(input, previous);
  writeFileSync(filePath, JSON.stringify(state));
  return state;
}

export function commandEveMultimodalTtsConsentPath(dataPath: string): string {
  return path.join(dataPath, FILE_NAME);
}

export function readCommandEveMultimodalTtsConsent(dataPath: string): CommandEveMultimodalTtsConsentState {
  return readCommandEveMultimodalTtsConsentFromFile(commandEveMultimodalTtsConsentPath(dataPath), (p) =>
    fs.readFileSync(p, 'utf8')
  );
}

export function toCommandEveMultimodalTtsConsentBridgeResult(
  state: CommandEveMultimodalTtsConsentState,
  persisted: boolean
): CommandEveMultimodalTtsConsentBridgeResult {
  return {
    version: COMMAND_EVE_MULTIMODAL_TTS_CONSENT_VERSION,
    consent: state.consent === true,
    privacyLane: state.privacyLane,
    ...(state.updatedAt ? { updatedAt: state.updatedAt } : {}),
    persisted,
  };
}

export function setCommandEveMultimodalTtsConsent(
  dataPath: string,
  input: CommandEveMultimodalTtsConsentSetRequest | undefined | null
): CommandEveMultimodalTtsConsentBridgeResult {
  const filePath = commandEveMultimodalTtsConsentPath(dataPath);
  const previous = readCommandEveMultimodalTtsConsent(dataPath);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const state = writeCommandEveMultimodalTtsConsentToFile(
      filePath,
      input,
      (p, data) => fs.writeFileSync(p, data, { mode: 0o600 }),
      previous
    );
    return toCommandEveMultimodalTtsConsentBridgeResult(state, true);
  } catch {
    return toCommandEveMultimodalTtsConsentBridgeResult(
      {
        consent: false,
        privacyLane: previous.privacyLane,
        updatedAt: new Date().toISOString(),
      },
      false
    );
  }
}
